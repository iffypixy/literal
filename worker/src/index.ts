import { SignedOut } from "../../protocol/protocol.ts";
import { createAuth, handleAuth } from "./auth.ts";
import type { UserNotes } from "./user-notes.ts";

export { UserNotes } from "./user-notes.ts";

export interface Env {
  DB: D1Database;
  NOTES: DurableObjectNamespace<UserNotes>;
  /** Sends the sign-in codes, through Cloudflare's email service. */
  EMAIL: SendEmail;
  /** Where the app is served, e.g. https://literal.ink: sign-in and origin checks use it. */
  APP_URL: string;
  /** The address code emails come from, e.g. code@literal.ink: the only one EMAIL may send from. */
  EMAIL_FROM: string;
  BETTER_AUTH_SECRET: string;
}

/** Everything but the static app: accounts, account deletion, and the sync socket. The app itself is static assets. */
export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/sync") return connect(request, env);
    if (pathname === "/api/account" && request.method === "DELETE") return deleteAccount(request, env);
    if (pathname.startsWith("/api/auth/")) return handleAuth(request, env);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** Hands the socket to the signed-in user's own Durable Object. */
async function connect(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  if (!sameOrigin(request, env)) return new Response("Forbidden", { status: 403 });
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  if (!session) return signedOut();
  return env.NOTES.get(env.NOTES.idFromName(session.user.id)).fetch(request);
}

/**
 * A browser can't read why a WebSocket upgrade failed, so a signed-out device gets a socket that closes
 * at once with a code saying so: it then stops retrying and asks to sign in.
 */
function signedOut(): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(SignedOut, "signed out");
  return new Response(null, { status: 101, webSocket: client });
}

/** Deletes the account and every synced note, at once. */
async function deleteAccount(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("Forbidden", { status: 403 });
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response("Signed out", { status: 401 });
  const userId = session.user.id;
  await env.NOTES.get(env.NOTES.idFromName(userId)).wipe();
  const { internalAdapter } = await auth.$context;
  await internalAdapter.deleteUserSessions(userId);
  await internalAdapter.deleteAccounts(userId);
  await internalAdapter.deleteUser(userId);
  return new Response(null, { status: 204 });
}

function sameOrigin(request: Request, env: Env): boolean {
  return request.headers.get("Origin") === new URL(env.APP_URL).origin;
}
