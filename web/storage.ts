/**
 * localStorage under Literal's own prefix. A browser may refuse storage (a private window, blocked site data, a
 * full disk): reads then find nothing, and writes say they failed.
 */

const Prefix = "literal:";

export function read(key: string): string | null {
  try {
    return localStorage.getItem(Prefix + key);
  } catch {
    return null;
  }
}

export function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(Prefix + key, value);
    return true;
  } catch {
    return false;
  }
}

export function remove(key: string) {
  try {
    localStorage.removeItem(Prefix + key);
  } catch {
    // Without storage, there's nothing to remove.
  }
}

/** The keys that start with `start`, without it. */
export function keys(start = ""): string[] {
  let all: string[];
  try {
    all = Object.keys(localStorage);
  } catch {
    return [];
  }
  return all.filter((key) => key.startsWith(Prefix + start)).map((key) => key.slice(Prefix.length + start.length));
}

/** Another tab wrote or removed `key`: the browser tells every tab but the one that did. */
export function onChange(key: string, listener: (value: string | null) => void) {
  addEventListener("storage", (event) => {
    if (event.key === Prefix + key) listener(event.newValue);
  });
}

/** Everything Literal keeps here. */
export function clear() {
  for (const key of keys()) remove(key);
}
