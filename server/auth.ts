import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { CodeLength } from "#protocol.ts";
import type { Env } from "./index.ts";

// In seconds, as the library takes them.
const Minute = 60;
const Day = 24 * 60 * Minute;
/** How long a code works, and how long an IP address's attempts count toward its limits. */
const CodeLife = 10 * Minute;
const AttemptWindow = 10 * Minute;
/**
 * Codes emailed a day, across everyone. Cloudflare bills each email past the plan's 3,000 a month and caps
 * nothing itself, so this keeps a flood of sign-ins to a few dollars a month.
 */
const CodesADay = 500;
/** Codes emailed a day to one address. Plenty to sign in, too few to flood an inbox and hurt the domain's name. */
const CodesAnAddress = 5;

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
 * sessions, past days' counts, and attempts that no longer count. The library keeps dates as ISO text.
 */
export async function forgetSignIns(db: D1Database) {
  await db.batch([
    db.prepare(`delete from "verification" where "expiresAt" < ?`).bind(new Date().toISOString()),
    db.prepare(`delete from "session" where "expiresAt" < ?`).bind(new Date().toISOString()),
    db.prepare(`delete from "codesSent" where "day" < ?`).bind(today()),
    db.prepare(`delete from "rateLimit" where "lastRequest" < ?`).bind(Date.now() - AttemptWindow * 1000),
  ]);
}

export function createAuth(env: Env, onUnsent?: () => void) {
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    // Signed in until you sign out, or for a year without using it.
    session: { expiresIn: 365 * Day, updateAge: Day },
    plugins: [
      emailOTP({
        otpLength: CodeLength,
        expiresIn: CodeLife,
        allowedAttempts: 5,
        storeOTP: "hashed",
        sendVerificationOTP: ({ email, otp }) =>
          sendCode(env, email, otp).catch((error: unknown) => {
            onUnsent?.();
            throw error;
          }),
      }),
    ],
    // The library makes a code before it asks for it to be sent, and a code it made can be guessed whether or not it
    // went out. So a code is refused here, before it exists.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/email-otp/send-verification-otp") await allowCode(env, ctx.body ?? {});
      }),
    },
    rateLimit: {
      enabled: !isLocal(env),
      storage: "database",
      // Only signing in is limited, so nothing else records an IP address.
      customRules: {
        "/email-otp/send-verification-otp": { window: AttemptWindow, max: 3 },
        "/sign-in/email-otp": { window: AttemptWindow, max: 10 },
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

/** Only sign-in codes, and only so many a day. The local dev server counts none. */
async function allowCode(env: Env, body: { email?: unknown; type?: unknown }) {
  if (body.type !== "sign-in") throw APIError.fromStatus("BAD_REQUEST", { message: "sign-in codes only" });
  if (isLocal(env) || typeof body.email !== "string") return;
  await countCode(env, body.email.toLowerCase());
}

/** Emails the code. The local dev server prints it instead. */
async function sendCode(env: Env, email: string, code: string) {
  if (isLocal(env)) {
    console.log(`sign-in code for ${email}: ${code}`);
    return;
  }
  await env.EMAIL.send({
    from: { name: "Literal", email: env.EMAIL_FROM },
    to: email,
    subject: `${code} is your Literal sign-in code`,
    text: `${code}\n\nEnter this code in Literal to sign in. It works for ${CodeLife / Minute} minutes.\n\nDidn't ask for it? You can ignore this email.\n`,
  });
}

async function countCode(env: Env, email: string) {
  const add = async (key: string) => {
    const count = await env.DB.prepare(
      `insert into "codesSent" ("day", "key", "count") values (?, ?, 1)
         on conflict ("day", "key") do update set "count" = "count" + 1 returning "count"`,
    )
      .bind(today(), key)
      .first<number>("count");
    if (count === null) throw new Error("count code: no count returned");
    return count;
  };
  const full = APIError.fromStatus("SERVICE_UNAVAILABLE", { message: "no more codes today" });
  const address = await keyed(env.BETTER_AUTH_SECRET, email);
  if ((await add(address)) > CodesAnAddress) throw full;
  if ((await add("all")) > CodesADay) throw full;
}

/** Hex HMAC-SHA-256 under the app's secret, so addresses are counted without being kept, nor guessed from it. */
async function keyed(secret: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** As a UTC date, the way "codesSent" keys its counts. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isLocal(env: Env): boolean {
  return !env.APP_URL.startsWith("https://");
}
