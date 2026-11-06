/** Leaving the account on this device, by signing out or deleting it, and what's said once the page has reloaded. */

import { forgetAccount, unreachable, type Outcome } from "#/web/account.ts";
import { request } from "#/web/lib/request.ts";
import * as storage from "#/web/lib/storage.ts";
import * as notes from "#/web/notes.ts";

const FarewellKey = "farewell";

/** Said once, after the reload that signing out or deleting the account ends with. */
export function farewell(): string | undefined {
  const said = storage.read(FarewellKey);
  storage.remove(FarewellKey);
  return said;
}

/**
 * Erases every note on this device (they stay in the account), but only once the server has signed it out. Erased
 * while the server still knew the device, it would sign right back in.
 */
export async function signOut(): Promise<Outcome> {
  const response = await request("POST", "/api/auth/sign-out", {});
  if (!response) return unreachable();
  if (!response.ok) return { ok: false, reason: "Couldn't sign out. Try again." };

  await forget("Signed out. Your notes are still in your account.");
  return { ok: true };
}

export async function deleteAccount(): Promise<Outcome> {
  const response = await request("DELETE", "/api/account");
  if (!response) return unreachable();
  if (response.status === 401) return { ok: false, reason: "Sign in again to delete your account" };
  if (!response.ok) return { ok: false, reason: "Couldn't delete your account. Try again." };

  await forget("Account deleted.");
  return { ok: true };
}

// Erases every trace of the account on this device and starts over. The server has let the device go already, so notes
// that can't be erased stay, signed out, with any words a closing page kept.
async function forget(message: string) {
  let said = message;
  try {
    await notes.wipe();
    storage.clear();
  } catch (error) {
    console.error(error);
    forgetAccount();
    said = `${message} This device couldn't erase its notes.`;
  }
  // Without storage it goes unsaid; the page still shows what happened.
  storage.write(FarewellKey, said);
  location.replace("/");
}
