import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { CodeLength } from "../protocol.ts";
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
/** Codes emailed a day to one address: plenty to sign in, too few to flood an inbox and hurt the domain's name. */
const CodesAnAddress = 5;

/**
 * Answers the auth library's requests. A code that isn't emailed fails its request: the library would only log
 * it, and the person would wait for an email that never comes.
 */
export async function handleAuth(request: Request, env: Env): Promise<Response> {
  let unsent: Response | undefined;
  const auth = createAuth(env, (error) => {
    unsent =
      error instanceof Refused
        ? new Response(error.message, { status: error.status })
        : new Response("couldn't send the code", { status: 502 });
  });
  const response = await auth.handler(request);
  return unsent ?? response;
}

/**
 * Erases what signing in no longer needs, so none of it outlasts what the privacy page says: expired codes, past
 * days' counts, and attempts that no longer count. The library keeps dates as ISO text.
 */
export async function forgetSignIns(db: D1Database) {
  await db.batch([
    db.prepare(`delete from "verification" where "expiresAt" < ?`).bind(new Date().toISOString()),
    db.prepare(`delete from "codesSent" where "day" < ?`).bind(today()),
    db.prepare(`delete from "rateLimit" where "lastRequest" < ?`).bind(Date.now() - AttemptWindow * 1000),
  ]);
}

export function createAuth(env: Env, onUnsent?: (error: unknown) => void) {
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
        sendVerificationOTP: ({ email, otp, type }) =>
          sendCode(env, email, otp, type).catch((error: unknown) => {
            onUnsent?.(error);
            throw error;
          }),
      }),
    ],
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

/** The local dev server sends no email: it prints the code instead. */
async function sendCode(env: Env, email: string, code: string, type: string) {
  if (type !== "sign-in") throw new Refused(400, "sign-in codes only");
  if (isLocal(env)) {
    console.log(`sign-in code for ${email}: ${code}`);
    return;
  }
  await countCode(env.DB, email);
  await env.EMAIL.send({
    from: { name: "Literal", email: env.EMAIL_FROM },
    to: email,
    subject: `${code} is your Literal sign-in code`,
    text: `${code}\n\nEnter this code in Literal to sign in. It works for ${CodeLife / Minute} minutes.\n\nDidn't ask for it? You can ignore this email.\n`,
  });
}

/** A code not sent on purpose: the request fails with `status`, and the message as its body. */
class Refused extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function countCode(db: D1Database, email: string) {
  const add = async (key: string) => {
    const count = await db
      .prepare(
        `insert into "codesSent" ("day", "key", "count") values (?, ?, 1)
         on conflict ("day", "key") do update set "count" = "count" + 1 returning "count"`,
      )
      .bind(today(), key)
      .first<number>("count");
    if (count === null) throw new Error("count code: no count returned");
    return count;
  };
  if ((await add(await sha256(email.toLowerCase()))) > CodesAnAddress) throw new Refused(503, "no more codes today");
  if ((await add("all")) > CodesADay) throw new Refused(503, "no more codes today");
}

/** Hex SHA-256: addresses are counted without being kept. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** As a UTC date, the way "codesSent" keys its counts. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isLocal(env: Env): boolean {
  return !env.APP_URL.startsWith("https://");
}
