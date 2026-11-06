/**
 * Where a note's unsaved changes go as the page closes, since localStorage writes at once and IndexedDB may not
 * finish. Each copy stays until a save that holds it lands.
 */

import { attempt } from "#/web/lib/attempt.ts";
import * as storage from "#/web/lib/storage.ts";

const Prefix = "unsaved:";
// Spreading a large array into one call overflows the stack.
const SliceBytes = 0x8000;

/** The notes with a copy kept. */
export function ids(): string[] {
  return storage.keys(Prefix);
}

/** False without storage. */
export function keep(id: string, update: Uint8Array): boolean {
  return storage.write(Prefix + id, toBase64(update));
}

/** A copy that can't be read is let go. */
export function read(id: string): Uint8Array | undefined {
  const text = storage.read(Prefix + id);
  if (!text) return undefined;

  const bytes = attempt(() => fromBase64(text), undefined);
  if (!bytes) drop(id);
  return bytes;
}

export function drop(id: string) {
  storage.remove(Prefix + id);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += SliceBytes) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SliceBytes));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
