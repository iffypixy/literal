import { createMutable } from "solid-js/store";
import * as z from "zod/mini";
import { request } from "#/web/lib/request.ts";
import * as storage from "#/web/lib/storage.ts";

/** `reason` is what to tell the person. */
export type Outcome = { ok: true } | { ok: false; reason: string };

const SessionSchema = z.nullable(z.object({ user: z.object({ email: z.string() }) }));

// Remembered, so the app knows it's signed in before the server answers, or when it can't.
const AccountKey = "account";

export const WrongCode = "That code didn't work";

// What a failed request says, by its status.
const SendProblems: Partial<Record<number, string>> = {
  400: "That doesn't look like an email address",
  429: "Wait a few minutes, then try again",
  503: "Can't send more codes today. Try again tomorrow.",
};
const VerifyProblems: Partial<Record<number, string>> = {
  400: WrongCode,
  401: WrongCode,
  // After 5 wrong tries the code is locked, and even the right one won't work.
  403: "Send a new code to try again",
  429: "Wait a few minutes, then try again",
};

/** As far as this device knows: the email it's signed in with. */
export const account = createMutable<{ email: string | null }>({ email: storage.read(AccountKey) ?? null });

// Tells the other tabs about each sign-in, even to the same account, so a tab the server signed out syncs again.
const signIns = new BroadcastChannel("literal:sign-in");

/** Null when nobody is signed in; throws when the server can't be reached. */
export async function session(): Promise<string | null> {
  const response = await request("GET", "/api/auth/get-session");
  if (!response?.ok) throw new Error(`get session: ${response?.status ?? "unreachable"}`);
  return SessionSchema.parse(await response.json())?.user.email ?? null;
}

export function signedIn(email: string) {
  account.email = email;
  storage.write(AccountKey, email);
  signIns.postMessage(email);
}

/** Calls `listener` when another tab signs in, after taking on its account. */
export function onSignInElsewhere(listener: () => void) {
  signIns.onmessage = ({ data }: MessageEvent<unknown>) => {
    account.email = z.string().parse(data);
    listener();
  };
}

/** The next time the page loads, it starts signed out. */
export function forgetAccount() {
  storage.remove(AccountKey);
}

export async function sendCode(email: string): Promise<Outcome> {
  const response = await request("POST", "/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  if (!response) return unreachable();
  if (!response.ok) return { ok: false, reason: SendProblems[response.status] ?? "Couldn't send the code. Try again." };
  return { ok: true };
}

export async function verify(email: string, code: string): Promise<Outcome> {
  const response = await request("POST", "/api/auth/sign-in/email-otp", { email, otp: code });
  if (!response) return unreachable();
  if (!response.ok) return { ok: false, reason: VerifyProblems[response.status] ?? "Couldn't sign in. Try again." };

  // As the server keeps it, so the session it hands back later names the same account.
  signedIn(email.toLowerCase());
  return { ok: true };
}

export function unreachable(): Outcome {
  const reason = navigator.onLine ? "Couldn't connect. Try again." : "Connect to the internet and try again";
  return { ok: false, reason };
}
