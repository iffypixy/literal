import { SignedOut } from "../protocol.ts";
import { createAuth, forgetSignIns, handleAuth } from "./auth.ts";
import { SessionHeader, type UserNotes } from "./notes.ts";

export { UserNotes } from "./notes.ts";

export interface Env {
  DB: D1Database;
  NOTES: DurableObjectNamespace<UserNotes>;
  EMAIL: SendEmail;
  /** Where the app is served, e.g. https://literal.ink: sign-in and origin checks use it. */
  APP_URL: string;
  /** The only address EMAIL may send from, e.g. code@literal.ink. */
  EMAIL_FROM: string;
  BETTER_AUTH_SECRET: string;
}

/** The auth routes the app calls, besides signing out: the library's others stay out of reach. */
const AuthRoutes = new Set([
  "/api/auth/get-session",
  "/api/auth/email-otp/send-verification-otp",
  "/api/auth/sign-in/email-otp",
]);

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/sync") return connect(request, env);
    if (pathname === "/api/account" && request.method === "DELETE") return deleteAccount(request, env);
    if (pathname === "/api/auth/sign-out") return signOut(request, env);
    if (AuthRoutes.has(pathname)) return handleAuth(request, env);
    return new Response("not found", { status: 404 });
  },
  async scheduled(_controller, env) {
    await forgetSignIns(env.DB);
  },
} satisfies ExportedHandler<Env>;

async function connect(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  if (!session) return signedOut();
  const headers = new Headers(request.headers);
  headers.set(SessionHeader, session.session.id);
  return notesOf(env, session.user.id).fetch(request, { headers });
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

/** Also closes the session's sockets: they check their session only as they open. */
async function signOut(request: Request, env: Env): Promise<Response> {
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  const response = await handleAuth(request, env);
  if (session && response.ok) await notesOf(env, session.user.id).signOut(session.session.id);
  return response;
}

async function deleteAccount(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, env)) return new Response("forbidden", { status: 403 });
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response("signed out", { status: 401 });
  await notesOf(env, session.user.id).wipe();
  await (await auth.$context).internalAdapter.deleteUser(session.user.id);
  return new Response(null, { status: 204 });
}

function notesOf(env: Env, userId: string) {
  return env.NOTES.get(env.NOTES.idFromName(userId));
}

function sameOrigin(request: Request, env: Env): boolean {
  return request.headers.get("Origin") === new URL(env.APP_URL).origin;
}
