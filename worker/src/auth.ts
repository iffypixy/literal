import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import type { Env } from "./index.ts";

const YEAR = 60 * 60 * 24 * 365;

/** Accounts exist only for sync: no passwords, just a code by email, or Google or Apple. */
export function createAuth(env: Env) {
  return betterAuth({
    appName: "Blank",
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
            },
          }
        : {}),
      ...(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET
        ? { apple: { clientId: env.APPLE_CLIENT_ID, clientSecret: env.APPLE_CLIENT_SECRET } }
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
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
  });
}

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
      subject: `${code} is your Blank sign-in code`,
      text: `${code}\n\nEnter this code in Blank to sign in. It works for 10 minutes.\n\nDidn't ask for it? You can ignore this email.\n`,
    }),
  });
  if (!response.ok) throw new Error(`send code: Resend answered ${response.status}: ${await response.text()}`);
}
