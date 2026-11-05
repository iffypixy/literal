/**
 * Where a note's unsaved changes go as the page closes, since localStorage writes at once and IndexedDB may not
 * finish. Each copy stays until a save that holds it lands.
 */

import { attempt } from "#web/safe.ts";
import * as storage from "#web/storage.ts";

const Prefix = "unsaved:";

/** The notes with a copy kept. */
export function ids(): string[] {
  return storage.keys(Prefix);
}

/** False without storage. */
export function keep(id: string, update: Uint8Array): boolean {
  return storage.write(Prefix + id, toBase64(update));
}

/** The copy kept for the note, if there's one to read. One that can't be read is let go. */
export function read(id: string): Uint8Array | null {
  const text = storage.read(Prefix + id);
  if (!text) return null;
  const bytes = attempt(() => fromBase64(text), null);
  if (!bytes) drop(id);
  return bytes;
}

export function drop(id: string) {
  storage.remove(Prefix + id);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // In slices, since spreading a large array into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
