import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import type { Env } from "./index.ts";

const YEAR = 60 * 60 * 24 * 365;
/**
 * Codes emailed a day, across everyone. Cloudflare bills each email past the plan's 3,000 a month and caps
 * nothing itself, so this keeps a flood of sign-ins to a few dollars a month.
 */
const CODES_A_DAY = 500;

/**
 * Answers the auth library's requests. A code that couldn't be emailed fails its request: the library would
 * only log it, and the person would wait for an email that never comes.
 */
export async function handleAuth(request: Request, env: Env): Promise<Response> {
  let unsent: Response | undefined;
  const auth = createAuth(env, (error) => {
    unsent =
      error instanceof DailyLimit
        ? new Response("No more codes today", { status: 503 })
        : new Response("Couldn't send the code", { status: 502 });
  });
  const response = await auth.handler(request);
  return unsent ?? response;
}

/** Accounts exist only for sync: no passwords, just a code by email. */
export function createAuth(env: Env, onUnsent?: (error: unknown) => void) {
  return betterAuth({
    appName: "Literal",
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [env.APP_URL],
    // Signed in until you sign out: a year, renewed whenever it's used.
    session: { expiresIn: YEAR, updateAge: 60 * 60 * 24 },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        sendVerificationOTP: ({ email, otp }) =>
          sendCode(env, email, otp).catch((error: unknown) => {
            onUnsent?.(error);
            throw error;
          }),
      }),
    ],
    rateLimit: {
      enabled: !isLocal(env),
      storage: "database",
      customRules: {
        "/email-otp/send-verification-otp": { window: 10 * 60, max: 3 },
        "/sign-in/email-otp": { window: 10 * 60, max: 10 },
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
async function sendCode(env: Env, email: string, code: string) {
  if (isLocal(env)) {
    console.log(`sign-in code for ${email}: ${code}`);
    return;
  }
  await countCode(env.DB);
  await env.EMAIL.send({
    from: { name: "Literal", email: env.EMAIL_FROM },
    to: email,
    subject: `${code} is your Literal sign-in code`,
    text: `${code}\n\nEnter this code in Literal to sign in. It works for 10 minutes.\n\nDidn't ask for it? You can ignore this email.\n`,
  });
}

/** Today's codes are all sent: the next one waits for tomorrow, in UTC. */
class DailyLimit extends Error {}

/** Counts a code toward today's, and refuses it past the daily limit. */
async function countCode(db: D1Database) {
  const day = new Date().toISOString().slice(0, 10);
  const sent = await db
    .prepare(
      `insert into "codesSent" ("day", "count") values (?, 1)
       on conflict ("day") do update set "count" = "count" + 1 returning "count"`,
    )
    .bind(day)
    .first<number>("count");
  if (sent === null) throw new Error("count code: no count returned");
  if (sent > CODES_A_DAY) throw new DailyLimit("daily code limit reached");
}

/** The local dev server is plain http; the real one never is. */
function isLocal(env: Env): boolean {
  return !env.APP_URL.startsWith("https://");
}
