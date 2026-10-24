import { SIGNED_OUT } from "../../protocol/protocol.ts";
import { createAuth } from "./auth.ts";
import type { UserNotes } from "./user-notes.ts";

export { UserNotes } from "./user-notes.ts";

export interface Env {
  DB: D1Database;
  NOTES: DurableObjectNamespace<UserNotes>;
  /** Where the app is served, e.g. https://literal.ink: auth callbacks and origin checks use it. */
  APP_URL: string;
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY?: string;
  /** The sender of code emails, e.g. "Literal <code@literal.ink>". */
  EMAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_CLIENT_SECRET?: string;
}

/** Everything but the static app: accounts, account deletion, and the sync socket. The app itself is static assets. */
export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/sync") return connect(request, env);
    if (pathname === "/api/providers") {
      return Response.json({ google: Boolean(env.GOOGLE_CLIENT_ID), apple: Boolean(env.APPLE_CLIENT_ID) });
    }
    if (pathname === "/api/account" && request.method === "DELETE") return deleteAccount(request, env);
    if (pathname.startsWith("/api/auth/")) return createAuth(env).handler(request);
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
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  server.close(SIGNED_OUT, "signed out");
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
