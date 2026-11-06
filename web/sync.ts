/** Keeps this device's notes in sync with the account, over one WebSocket, for as long as it's signed in. */

import { createMutable } from "solid-js/store";
import * as Y from "yjs";
import {
  decode,
  encode,
  MaxBytes,
  MaxLength,
  MaxNotes,
  Ping,
  SignedOut,
  type Message,
  type Refusal,
} from "#/protocol.ts";
import { account, onSignInElsewhere, session, signedIn } from "#/web/account.ts";
import { number } from "#/web/lib/format.ts";
import * as notes from "#/web/notes.ts";
import { quoted } from "#/web/search.ts";
import { toast } from "#/web/ui/toast.tsx";

/** What keeps notes from syncing. `unreachable` is online, with the server out of reach. */
export type Problem = "offline" | "unreachable" | "signedOut";

type Covers = "whole" | "changes";

// How long the connection can be down before the corner says so.
const DownAfterMs = 5000;
// A lost network often leaves a WebSocket open and silent. So the device pings when idle, and treats the connection
// as dead when a pong or an ack is this late.
const PingEveryMs = 25_000;
const DeadAfterMs = 10_000;
const RetryMinMs = 1000;
const RetryMaxMs = 30_000;
// A pause in typing this long sends what was typed; so does typing this long without one.
const SendDelayMs = 1000;
const SendAtMostMs = 5000;
// How long signing out waits for the server to take the last changes, and how often it looks.
const DrainForMs = 3000;
const DrainCheckMs = 50;
// How often the connection is checked on, and the corner told.
const TickMs = 1000;

// What each refusal says, naming the note it's about.
const Refused: Record<Refusal, (name: string | null) => string> = {
  tooMany: () => `Sync stops at ${number(MaxNotes)} notes, so delete some to make room`,
  tooFull: () => `Sync stops at ${number(MaxBytes / 1_000_000)} MB, so delete some notes to make room`,
  // Under the length limit, but so much has been typed and erased in it that its history is too large.
  tooLarge: (name) => `${name ?? "This note"} is too large to sync, so copy its text into a new note`,
};

export const sync = createMutable<{ problem: Problem | null }>({ problem: null });

// Set by the first sync, and kept as long as the page.
let listening = false;
// By the server, so the device waits for a sign-in before it connects again.
let signedOut = false;

let connection: WebSocket | null = null;
let triedAt = 0;
let lastHeardAt = 0;
// Pinged while idle.
let pingSentAt: number | null = null;
// Null while the connection is up.
let downSince: number | null = null;
let retryMs = RetryMinMs;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
// Messages are handled one at a time, in order, since each may wait on disk.
let queue = Promise.resolve();

let seq = 0;
// Updates sent and not yet acked: which note, and its generation then.
const unacked = new Map<number, { id: string; upTo: number; sentAt: number; covers: Covers }>();
// Changes made here and not sent yet, by note, so a burst of typing goes to the server as one update.
const outbox = new Map<string, { updates: Uint8Array[]; since: number; timer?: ReturnType<typeof setTimeout> }>();
// Notes the server may be missing changes for, because one was refused, lost with a connection, never sent, or made in
// another tab. Each keeps the last `seq` sent before then. Until a whole copy sent after it is acked, the note goes
// whole, and no other ack marks it synced.
const behind = new Map<string, number>();

// Each refusal is explained once, not once for every change the server turns away.
const explained = new Set<string>();
// Notes whose history is too large for the server to keep. Until the page reloads, they aren't sent again.
const tooLarge = new Set<string>();

/** Syncs whenever signed in: from the start, after a sign-in in another tab, and once a forgotten session turns up. */
export function keepInSync() {
  if (account.email) startSync();
  onSignInElsewhere(startSync);
  void recover();
}

/** Called again after a sign-in, it starts over on a new connection, as the old one may belong to another session. */
export function startSync() {
  if (!listening) listen();
  signedOut = false;
  drop();
  downSince = Date.now();
  reconnect();
  report();
}

/** Before signing out, sends every change still waiting, then gives the server a moment to take them all. */
export async function drain() {
  await notes.flush();
  await releaseAll();

  const until = Date.now() + DrainForMs;
  while (unacked.size && connection?.readyState === WebSocket.OPEN && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, DrainCheckMs));
  }

  // An ack is on disk once it's been handled.
  await queue;
}

/** It stays on this device, dirty and behind, until it's short enough again. */
export function isTooLong(id: string): boolean {
  return notes.length(id) > MaxLength;
}

// Picks up a session this device forgot, because its storage was cleared or refused.
async function recover() {
  let email: string | null;
  try {
    email = await session();
  } catch {
    // Out of reach, what this device remembers stands.
    return;
  }
  if (!email || email === account.email) return;

  signedIn(email);
  startSync();
}

function listen() {
  listening = true;
  notes.listen({ onChange: hold, onBehind: (id) => fallBehind(id, seq) });
  // A connection from before the network dropped is usually dead even if it looks open, so start over.
  addEventListener("online", () => {
    drop();
    reconnect();
  });
  addEventListener("offline", drop);
  // Leaving the app sends what's waiting at once; coming back reconnects.
  document.addEventListener("visibilitychange", () => (document.hidden ? void releaseAll() : reconnect()));
  addEventListener("pagehide", () => void releaseAll());
  setInterval(tick, TickMs);
}

function connect() {
  clearTimeout(retryTimer);
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sync`);
  socket.binaryType = "arraybuffer";
  connection = socket;
  triedAt = Date.now();

  socket.onopen = () => {
    downSince = null;
    lastHeardAt = Date.now();
    pingSentAt = null;
    run(socket, async () => {
      const hello = await notes.hello();
      if (socket.readyState === WebSocket.OPEN) socket.send(encode({ kind: "hello", ...hello }));
    });
  };

  socket.onmessage = (event) => {
    lastHeardAt = Date.now();
    pingSentAt = null;
    // The only text is the server's answer to a ping, which, like anything heard, shows the connection is alive.
    if (!(event.data instanceof ArrayBuffer)) return;
    const data = new Uint8Array(event.data);
    run(socket, () => handleMessage(socket, decode(data)));
  };

  socket.onclose = (event) => {
    if (connection !== socket) return;
    if (event.code === SignedOut) {
      signedOut = true;
      // After the messages before it, so a catch-up still queued can't mark this device caught up again.
      run(socket, () => notes.unsync());
    }
    drop();
  };
}

// Runs after everything before it. Anything that fails takes the connection down.
function run(socket: WebSocket, work: () => Promise<void>) {
  queue = runAfter(queue, socket, work);
}

async function runAfter(before: Promise<void>, socket: WebSocket, work: () => Promise<void>) {
  await before;
  try {
    await work();
  } catch (error) {
    console.error(error);
    socket.close();
  }
}

// Gives up on the connection, without waiting for a close that a dead network never delivers, and retries later.
function drop() {
  const socket = connection;
  if (!socket) return;
  connection = null;
  abandon();
  downSince ??= Date.now();
  socket.close();

  clearTimeout(retryTimer);
  // Without a network, the `online` event is the time to try again. Signed out, a sign-in is.
  if (navigator.onLine && !signedOut) {
    retryTimer = setTimeout(connect, retryMs * (0.75 + Math.random() / 2));
    retryMs = Math.min(retryMs * 2, RetryMaxMs);
  }

  report();
}

// Updates on a lost connection may never have arrived, so their notes are behind until they go whole.
function abandon() {
  for (const sent of unacked.values()) fallBehind(sent.id, seq);
  unacked.clear();
}

function reconnect() {
  if (signedOut || connection) return;
  retryMs = RetryMinMs;
  connect();
}

async function handleMessage(socket: WebSocket, message: Message) {
  switch (message.kind) {
    case "catchUp":
      for (const note of message.notes) {
        if (note.update) await notes.receive(note.id, note.update);
        if (!note.vector) continue;
        const update = await notes.missing(note.id, note.vector);
        if (update) send(note.id, update, "whole", socket);
      }
      if (!message.done) break;
      await notes.caughtUp(message.now);
      // The connection has proved itself, so if it drops now, trying again soon is right.
      retryMs = RetryMinMs;
      break;
    case "update":
      await notes.receive(message.id, message.update);
      break;
    case "ack": {
      const sent = answered(message.seq);
      if (!sent || !catchesUp(sent, message.seq)) break;
      behind.delete(sent.id);
      await notes.acked(sent.id, sent.upTo);
      break;
    }
    case "refused": {
      const sent = answered(message.seq);
      // Sent on a connection since dropped, the note is behind anyway, so it's sent again and refused again.
      if (!sent) break;
      fallBehind(sent.id, message.seq);
      if (message.reason === "tooLarge") tooLarge.add(sent.id);
      // A note's own limit is explained for each note, the account's just once.
      const about = message.reason === "tooLarge" ? sent.id : message.reason;
      if (explained.has(about)) break;
      explained.add(about);
      toast(Refused[message.reason](quoted(notes.find(sent.id)?.text ?? "")));
      break;
    }
    case "purge":
      for (const id of message.ids) await notes.purged(id);
      break;
    case "hello":
      throw new Error("sync: the server said hello");
  }
}

// The update `seq` was, now that the server has answered it.
function answered(seq: number) {
  const sent = unacked.get(seq);
  unacked.delete(seq);
  return sent;
}

// Until typing pauses, or has gone on for a while.
function hold(id: string, update: Uint8Array) {
  const now = Date.now();
  const waiting = outbox.get(id) ?? { updates: [], since: now };
  clearTimeout(waiting.timer);
  waiting.updates.push(update);
  waiting.timer = setTimeout(() => void release(id), Math.min(SendDelayMs, waiting.since + SendAtMostMs - now));
  outbox.set(id, waiting);
}

function releaseAll(): Promise<unknown> {
  return Promise.all([...outbox.keys()].map(release));
}

// Sends the note's held changes as one update; or all of the note, if the server is behind on it.
async function release(id: string) {
  const waiting = outbox.get(id);
  if (!waiting) return;
  clearTimeout(waiting.timer);
  outbox.delete(id);

  const covers = behind.has(id) ? "whole" : "changes";
  const update = covers === "whole" ? await notes.missing(id) : Y.mergeUpdates(waiting.updates);
  if (update) send(id, update, covers);
}

// If not connected, or the note can't sync, it stays dirty and behind, and goes with a later hello.
function send(id: string, update: Uint8Array, covers: Covers, socket = connection) {
  const sendable = socket?.readyState === WebSocket.OPEN && !isTooLong(id) && !tooLarge.has(id);
  if (!sendable) {
    fallBehind(id, seq);
    return;
  }

  unacked.set(++seq, { id, upTo: notes.generation(id), sentAt: Date.now(), covers });
  socket.send(encode({ kind: "update", seq, id, update }));
}

function fallBehind(id: string, since: number) {
  behind.set(id, Math.max(since, behind.get(id) ?? 0));
}

// A note that's behind catches up only with a whole copy sent after it fell behind.
function catchesUp(sent: { id: string; covers: Covers }, seq: number): boolean {
  const since = behind.get(sent.id);
  return since === undefined || (sent.covers === "whole" && seq > since);
}

function tick() {
  const now = Date.now();
  const socket = connection;
  const idle = socket?.readyState === WebSocket.OPEN && pingSentAt === null && now - lastHeardAt > PingEveryMs;
  if (isDead(now)) {
    drop();
  } else if (idle) {
    pingSentAt = now;
    socket.send(Ping);
  }
  report();
}

// Still connecting, or open with a pong or an ack too late.
function isDead(now: number): boolean {
  if (connection?.readyState === WebSocket.CONNECTING) return now - triedAt > DeadAfterMs;
  if (connection?.readyState !== WebSocket.OPEN) return false;
  if (pingSentAt !== null && now - pingSentAt > DeadAfterMs) return true;
  // Hearing anything counts, because acks queue behind the messages before them. An upload under way isn't late.
  const uploading = connection.bufferedAmount > 0;
  return !uploading && [...unacked.values()].some((sent) => now - Math.max(sent.sentAt, lastHeardAt) > DeadAfterMs);
}

function report() {
  const down = downSince !== null && Date.now() - downSince >= DownAfterMs;
  if (signedOut) sync.problem = "signedOut";
  else if (!down) sync.problem = null;
  else sync.problem = navigator.onLine ? "unreachable" : "offline";
}
