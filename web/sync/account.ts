/**
 * The account, as far as this device knows: the email it's signed in with. Signing in and out, and deleting the
 * account, resolve to a message for the person when they didn't work, and to null when they did.
 */

import { createMutable } from "solid-js/store";
import { wipe } from "#web/notes/notes.ts";
import * as storage from "#web/storage.ts";

/** Remembered, so the app knows it's signed in before the server answers, or when it can't. */
const AccountKey = "account";
/** What signing out or deleting the account says once the page has reloaded. */
const FarewellKey = "farewell";
/** A dead network would leave a request waiting forever. */
const RequestTimeout = 15_000;

export const WrongCode = "That code didn't work";

export const account = createMutable<{ email: string | null }>({ email: storage.read(AccountKey) });

/** Null when nobody is signed in; throws when the server can't be reached. */
export async function session(): Promise<string | null> {
  const response = await fetch("/api/auth/get-session", {
    credentials: "same-origin",
    signal: AbortSignal.timeout(RequestTimeout),
  });
  if (!response.ok) throw new Error(`get session: ${response.status}`);
  const body: unknown = await response.json();
  if (body === null) return null;
  if (
    typeof body === "object" &&
    "user" in body &&
    typeof body.user === "object" &&
    body.user !== null &&
    "email" in body.user &&
    typeof body.user.email === "string"
  )
    return body.user.email;
  throw new Error("get session: unexpected answer");
}

export function signedIn(email: string) {
  account.email = email;
  storage.write(AccountKey, email);
}

/** Calls `listener` when another tab signs in, after taking on its account. */
export function onSignInElsewhere(listener: () => void) {
  storage.onChange(AccountKey, (email) => {
    if (!email || email === account.email) return;
    signedIn(email);
    listener();
  });
}

/** Said once, after the reload that signing out or deleting the account ends with. */
export function farewell(): string | null {
  const said = storage.read(FarewellKey);
  storage.remove(FarewellKey);
  return said;
}

export async function sendCode(email: string): Promise<string | null> {
  const response = await request("POST", "/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  if (!response) return unreachable();
  if (response.ok) return null;
  if (response.status === 429) return "Wait a few minutes, then try again";
  if (response.status === 400) return "That doesn't look like an email address";
  if (response.status === 503) return "Can't send more codes today, please try again tomorrow";
  return "Couldn't send the code, please try again";
}

export async function verify(email: string, code: string): Promise<string | null> {
  const response = await request("POST", "/api/auth/sign-in/email-otp", { email, otp: code });
  if (!response) return unreachable();
  if (response.ok) {
    signedIn(email);
    return null;
  }
  if (response.status === 429) return "Wait a few minutes, then try again";
  // After 5 wrong tries the code is locked: even the right one won't work now.
  if (response.status === 403) return "Send a new code to try again";
  if (response.status === 400 || response.status === 401) return WrongCode;
  return "Couldn't sign in, please try again";
}

/**
 * Erases every note on this device (they stay in the account), but only once the server has signed it out: erased
 * while the server still knew the device, it would sign right back in.
 */
export async function signOut(): Promise<string | null> {
  const response = await request("POST", "/api/auth/sign-out", {});
  if (!response) return unreachable();
  if (!response.ok) return "Couldn't sign out, please try again";
  await forget("Signed out. Your notes are still in your account.");
  return null;
}

export async function deleteAccount(): Promise<string | null> {
  const response = await request("DELETE", "/api/account");
  if (!response) return unreachable();
  if (response.status === 401) return "Sign in again to delete your account";
  if (!response.ok) return "Couldn't delete your account, please try again";
  await forget("Account deleted");
  return null;
}

/** Erases every trace of the account on this device and starts over. */
async function forget(farewell: string) {
  await wipe();
  storage.clear();
  // Without storage it goes unsaid; the empty page still shows what happened.
  storage.write(FarewellKey, farewell);
  location.replace("/");
}

/** Null when the request didn't reach the server, or never came back. */
async function request(method: string, path: string, body?: unknown): Promise<Response | null> {
  try {
    return await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(RequestTimeout),
    });
  } catch {
    return null;
  }
}

function unreachable(): string {
  return navigator.onLine ? "Couldn't connect, please try again" : "Connect to the internet and try again";
}
