import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import type { Env } from "./index.ts";

const YEAR = 60 * 60 * 24 * 365;

/**
 * What Google and Apple tell us beyond the email: nothing kept. Literal never shows a name or picture, and never
 * calls them on your behalf, so neither those nor their access tokens are stored (see privacy.html).
 */
const nothingMore = { mapProfileToUser: () => ({ name: "", image: undefined }) };

/** Accounts exist only for sync: no passwords, just a code by email, or Google or Apple. */
export function createAuth(env: Env) {
  return betterAuth({
    appName: "Literal",
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [env.APP_URL, "https://appleid.apple.com"],
    // Signed in until you sign out: a year, renewed whenever it's used.
    session: { expiresIn: YEAR, updateAge: 60 * 60 * 24 },
    account: { accountLinking: { enabled: true, trustedProviders: ["google", "apple", "email-otp"] } },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              prompt: "select_account",
              ...nothingMore,
            },
          }
        : {}),
      ...(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET
        ? { apple: { clientId: env.APPLE_CLIENT_ID, clientSecret: env.APPLE_CLIENT_SECRET, ...nothingMore } }
        : {}),
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        sendVerificationOTP: ({ email, otp }) => sendCode(env, email, otp),
      }),
    ],
    rateLimit: {
      // Production only: the local dev server is plain http.
      enabled: env.APP_URL.startsWith("https://"),
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
      account: {
        create: { before: async (account) => ({ data: { ...account, ...noTokens } }) },
        update: { before: async (account) => ({ data: { ...account, ...noTokens } }) },
      },
    },
    telemetry: { enabled: false },
  });
}

const noTokens = { accessToken: null, refreshToken: null, idToken: null };

/** Emails the sign-in code. Without a Resend key (in development), prints it instead. */
async function sendCode(env: Env, email: string, code: string) {
  if (!env.RESEND_API_KEY) {
    console.log(`sign-in code for ${email}: ${code}`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: email,
      subject: `${code} is your Literal sign-in code`,
      text: `${code}\n\nEnter this code in Literal to sign in. It works for 10 minutes.\n\nDidn't ask for it? You can ignore this email.\n`,
    }),
  });
  if (!response.ok) throw new Error(`send code: Resend answered ${response.status}: ${await response.text()}`);
}
