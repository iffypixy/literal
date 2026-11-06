import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { CodeDigits } from "#/protocol.ts";
import type { Env } from "#/server/index.ts";

// The library takes its times in seconds.
const MinuteSeconds = 60;
const DaySeconds = 24 * 60 * MinuteSeconds;
// How long a code works, and how long an IP address's attempts count toward its limits.
const CodeLifeSeconds = 10 * MinuteSeconds;
const AttemptWindowSeconds = 10 * MinuteSeconds;
// Codes emailed a day to addresses with no account yet, across everyone. Cloudflare bills each email past the plan's
// 3,000 a month and caps nothing itself, so this keeps a flood of made-up sign-ups to a few dollars a month, while
// anyone with an account can still sign in.
const MaxCodesADay = 500;
// Codes emailed a day to one address. Plenty to sign in, too few to flood an inbox and hurt the domain's name.
const MaxCodesAnAddress = 5;
// Looser than the library's own check, so every address it takes is counted.
const EmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Answers the auth library's requests. A code that isn't emailed fails its request, since the library would only log
 * it, and the person would wait for an email that never comes.
 */
export async function handleAuth(request: Request, env: Env): Promise<Response> {
  let unsent = false;
  const response = await createAuth(env, () => (unsent = true)).handler(request);
  return unsent ? new Response("couldn't send the code", { status: 502 }) : response;
}

/**
 * Erases what signing in no longer needs, so none of it outlasts what the privacy page says: expired codes and
 * sessions, past days' counts, and attempts that no longer count.
 */
export async function forgetSignIns(db: D1Database) {
  // The library keeps dates as ISO text.
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`delete from "verification" where "expiresAt" < ?`).bind(now),
    db.prepare(`delete from "session" where "expiresAt" < ?`).bind(now),
    db.prepare(`delete from "codesSent" where "day" < ?`).bind(today()),
    db.prepare(`delete from "rateLimit" where "lastRequest" < ?`).bind(Date.now() - AttemptWindowSeconds * 1000),
  ]);
}

export function createAuth(env: Env, onUnsent = () => {}) {
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    // Signed in until you sign out, or for a year without using it.
    session: { expiresIn: 365 * DaySeconds, updateAge: DaySeconds },
    plugins: [
      emailOTP({
        otpLength: CodeDigits,
        expiresIn: CodeLifeSeconds,
        allowedAttempts: 5,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp }) => {
          try {
            await sendCode(env, email, otp);
          } catch (error) {
            onUnsent();
            throw error;
          }
        },
      }),
    ],
    // The library makes a code before it asks for it to be sent, and a code it made can be guessed whether or not it
    // went out. So a code is refused here, before it exists.
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === "/email-otp/send-verification-otp") await allowCode(env, context.body ?? {});
      }),
    },
    rateLimit: {
      enabled: !isLocal(env),
      storage: "database",
      // Only signing in is limited, so nothing else records an IP address.
      customRules: {
        "/email-otp/send-verification-otp": { window: AttemptWindowSeconds, max: 3 },
        "/sign-in/email-otp": { window: AttemptWindowSeconds, max: 10 },
        "/get-session": false,
        "/sign-out": false,
      },
    },
    // The IP address limits sign-in attempts for a few minutes; it isn't kept with the session afterwards.
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    databaseHooks: {
      session: {
        create: { before: async (session) => ({ data: { ...session, ipAddress: null, userAgent: null } }) },
      },
    },
    telemetry: { enabled: false },
  });
}

// Only sign-in codes, and only so many a day. The local dev server counts none.
async function allowCode(env: Env, body: { email?: unknown; type?: unknown }) {
  if (body.type !== "sign-in") throw APIError.fromStatus("BAD_REQUEST", { message: "sign-in codes only" });

  const email = body.email;
  const counted = !isLocal(env) && typeof email === "string" && EmailPattern.test(email);
  if (!counted) return;

  await countCode(env, email.toLowerCase());
}

// Emails the code. The local dev server prints it instead.
async function sendCode(env: Env, email: string, code: string) {
  if (isLocal(env)) {
    console.log(`sign-in code for ${email}: ${code}`);
    return;
  }

  await env.EMAIL.send({
    from: { name: "Literal", email: env.EMAIL_FROM },
    to: email,
    subject: `${code} is your Literal sign-in code`,
    text: `${code}\n\nEnter this code in Literal to sign in. It works for ${CodeLifeSeconds / MinuteSeconds} minutes.\n\nDidn't ask for it? You can ignore this email.\n`,
  });
}

// Throws once the address, or everyone without an account, has had today's codes.
async function countCode(env: Env, email: string) {
  const full = APIError.fromStatus("SERVICE_UNAVAILABLE", { message: "no more codes today" });

  const address = await keyed(env.BETTER_AUTH_SECRET, email);
  if ((await addCode(env.DB, address)) > MaxCodesAnAddress) throw full;
  if (await hasAccount(env.DB, email)) return;
  if ((await addCode(env.DB, "all")) > MaxCodesADay) throw full;
}

// Today's count under `key`, this code included.
async function addCode(db: D1Database, key: string): Promise<number> {
  const count = await db
    .prepare(
      `insert into "codesSent" ("day", "key", "count") values (?, ?, 1)
         on conflict ("day", "key") do update set "count" = "count" + 1 returning "count"`,
    )
    .bind(today(), key)
    .first<number>("count");
  if (count === null) throw new Error("add code: no count returned");
  return count;
}

// The library keeps addresses lowercase.
async function hasAccount(db: D1Database, email: string): Promise<boolean> {
  return (await db.prepare(`select 1 from "user" where "email" = ?`).bind(email).first()) !== null;
}

// Hex HMAC-SHA-256 under the app's secret, so addresses are counted without being kept, nor guessed from it.
async function keyed(secret: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// As a UTC date, the way "codesSent" keys its counts.
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isLocal(env: Env): boolean {
  return !env.APP_URL.startsWith("https://");
}
