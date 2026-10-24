/** The account, as far as this device knows: just the email it's signed in with, remembered across visits. */

import { wipe } from "../notes/notes.svelte.ts";

const KEY = "literal:account";
/** Where signing out or deleting the account leaves its word, which App says after the reload. */
export const FAREWELL = "literal:farewell";
/** How long a request may take before it counts as failed: a dead network would leave it waiting forever. */
const TIMEOUT = 15_000;

export const account = $state<{ email: string | null }>({ email: remembered() });

/** Asks the server who's signed in. Null when nobody is; throws when the server can't be reached. */
export async function session(): Promise<string | null> {
  const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`get session: ${response.status}`);
  const body = (await response.json()) as { user?: { email?: string } } | null;
  return body?.user?.email ?? null;
}

export function signedIn(email: string) {
  account.email = email;
  remember(email);
}

/** What to say when a request didn't reach the server, or never came back. */
export function unreachable(): string {
  return navigator.onLine ? "Couldn't connect, please try again" : "Connect to the internet and try again";
}

/** Emails a sign-in code. Resolves to a message for the person when it didn't work. */
export async function sendCode(email: string): Promise<string | null> {
  const response = await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  if (response.ok) return null;
  if (response.status === 429) return "Wait a few minutes, then try again";
  if (response.status === 400) return "That doesn't look like an email address";
  return "Couldn't send the code, please try again";
}

/** Signs in with the emailed code. Resolves to a message for the person when it didn't work. */
export async function verify(email: string, code: string): Promise<string | null> {
  const response = await post("/api/auth/sign-in/email-otp", { email, otp: code });
  if (response.ok) {
    signedIn(email);
    return null;
  }
  if (response.status === 429) return "Wait a few minutes, then try again";
  // After 5 wrong tries the code is locked: even the right one won't work now.
  if (response.status === 403) return "Send a new code to try again";
  if (response.status === 400 || response.status === 401) return "That code didn't work";
  return "Couldn't sign in, please try again";
}

/** Signs out and erases every note on this device: they stay in the account. */
export async function signOut() {
  // Signed out even if the server can't hear it: the session is useless without the device's notes anyway.
  await post("/api/auth/sign-out", {}).catch((error: unknown) => console.error(error));
  await forget("Signed out, and your notes stay in your account");
}

/** Deletes the account and everything in it. Resolves to a message for the person when it didn't work. */
export async function deleteAccount(): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch("/api/account", {
      method: "DELETE",
      credentials: "same-origin",
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch {
    return unreachable();
  }
  if (response.status === 401) return "Sign in again to delete your account";
  if (!response.ok) return "Couldn't delete your account, please try again";
  await forget("Account deleted");
  return null;
}

/** Erases this device's notes and starts over, saying `farewell` once the page is back. */
async function forget(farewell: string) {
  remember(null);
  try {
    localStorage.setItem(FAREWELL, farewell);
  } catch {
    // Without storage it goes unsaid; the empty page still shows what happened.
  }
  await wipe();
  location.replace("/");
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

// Remembered so the app knows it's signed in before the server answers, or when it can't.
function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(email: string | null) {
  try {
    if (email) localStorage.setItem(KEY, email);
    else localStorage.removeItem(KEY);
  } catch {
    // Without storage the app just won't know it's signed in until the server says so.
  }
}
