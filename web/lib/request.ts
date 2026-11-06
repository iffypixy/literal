// A dead network would leave a request waiting forever.
const TimeoutMs = 15_000;

/** Undefined when the request didn't reach the server, or never came back. */
export async function request(method: string, path: string, body?: object): Promise<Response | undefined> {
  const json = body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  try {
    return await fetch(path, { method, ...json, signal: AbortSignal.timeout(TimeoutMs) });
  } catch {
    return undefined;
  }
}
