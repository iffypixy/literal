import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import type { Env } from "./index.ts";

const Year = 60 * 60 * 24 * 365;
/** How long an IP address's sign-in attempts count toward its limits, in seconds. */
const AttemptWindow = 10 * 60;
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

/** Accounts exist only for sync: no passwords, just a code by email. */
export function createAuth(env: Env, onUnsent?: (error: unknown) => void) {
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    // Signed in until you sign out, or for a year without using it: renewed once a day as it's used.
    session: { expiresIn: Year, updateAge: 60 * 60 * 24 },
    plugins: [
      emailOTP({
        // The app's code field takes six digits, as do its tests.
        otpLength: 6,
        expiresIn: 10 * 60,
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

/** Emails the sign-in code. On the local dev server, which sends no email, prints it instead. */
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
    text: `${code}\n\nEnter this code in Literal to sign in. It works for 10 minutes.\n\nDidn't ask for it? You can ignore this email.\n`,
  });
}

/** A code that's not sent on purpose: the request fails with `status`, and the message as its body. */
class Refused extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Counts a code toward today's, for its address and for everyone, and refuses it past either limit. */
async function countCode(db: D1Database, email: string) {
  const day = new Date().toISOString().slice(0, 10);
  const add = (key: string) =>
    db
      .prepare(
        `insert into "codesSent" ("day", "key", "count") values (?, ?, 1)
         on conflict ("day", "key") do update set "count" = "count" + 1 returning "count"`,
      )
      .bind(day, key);
  // Past days' counts, and sign-in attempts that no longer count, are erased as codes go out.
  const [, , toAddress] = await db.batch<{ count: number }>([
    db.prepare(`delete from "codesSent" where "day" < ?`).bind(day),
    db.prepare(`delete from "rateLimit" where "lastRequest" < ?`).bind(Date.now() - AttemptWindow * 1000),
    add(await sha256(email.toLowerCase())),
  ]);
  if (countIn(toAddress) > CodesAnAddress) throw new Refused(503, "no more codes today");
  if (countIn(await add("all").run<{ count: number }>()) > CodesADay) throw new Refused(503, "no more codes today");
}

function countIn(result: D1Result<{ count: number }> | undefined): number {
  const count = result?.results[0]?.count;
  if (count === undefined) throw new Error("count code: no count returned");
  return count;
}

/** Hex SHA-256: addresses are counted without being kept. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The local dev server is plain http; the real one never is. */
function isLocal(env: Env): boolean {
  return !env.APP_URL.startsWith("https://");
}
