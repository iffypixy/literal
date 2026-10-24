import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import type { Env } from "./index.ts";

const YEAR = 60 * 60 * 24 * 365;

/**
 * Answers the auth library's requests. A code that couldn't be emailed fails its request: the library would
 * only log it, and the person would wait for an email that never comes.
 */
export async function handleAuth(request: Request, env: Env): Promise<Response> {
  let unsent = false;
  const response = await createAuth(env, () => (unsent = true)).handler(request);
  return unsent ? new Response("Couldn't send the code", { status: 502 }) : response;
}

/** Accounts exist only for sync: no passwords, just a code by email. */
export function createAuth(env: Env, onUnsent?: () => void) {
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
            onUnsent?.();
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
  await env.EMAIL.send({
    from: { name: "Literal", email: env.EMAIL_FROM },
    to: email,
    subject: `${code} is your Literal sign-in code`,
    text: `${code}\n\nEnter this code in Literal to sign in. It works for 10 minutes.\n\nDidn't ask for it? You can ignore this email.\n`,
  });
}

/** The local dev server is plain http; the real one never is. */
function isLocal(env: Env): boolean {
  return !env.APP_URL.startsWith("https://");
}
