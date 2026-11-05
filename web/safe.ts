/** What `run` returns, or `fallback` if it throws. */
export function attempt<T, F>(run: () => T, fallback: F): T | F {
  try {
    return run();
  } catch {
    return fallback;
  }
}

/** For checking what comes back from disk, another tab or the server, field by field. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
