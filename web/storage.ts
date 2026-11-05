/**
 * localStorage under Literal's own prefix. A browser may refuse storage (a private window, blocked site data, a
 * full disk), and then reads find nothing and writes return false.
 */

import { attempt } from "./safe.ts";

const Prefix = "literal:";

export function read(key: string): string | null {
  return attempt(() => localStorage.getItem(Prefix + key), null);
}

export function write(key: string, value: string): boolean {
  return attempt(() => {
    localStorage.setItem(Prefix + key, value);
    return true;
  }, false);
}

export function remove(key: string) {
  attempt(() => localStorage.removeItem(Prefix + key), undefined);
}

/** The keys that start with `start`, without it. */
export function keys(start = ""): string[] {
  return attempt(() => Object.keys(localStorage), [])
    .filter((key) => key.startsWith(Prefix + start))
    .map((key) => key.slice(Prefix.length + start.length));
}

export function clear() {
  for (const key of keys()) remove(key);
}
