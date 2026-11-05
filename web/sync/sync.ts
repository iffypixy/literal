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
} from "#protocol.ts";
import { number } from "#web/format.ts";
import * as notes from "#web/notes/notes.ts";
import { quoted } from "#web/notes/search.ts";
import { toast } from "#web/ui/toast.tsx";

/** What keeps notes from syncing, or null if nothing does. `unreachable` is online, with the server out of reach. */
export type Problem = "offline" | "unreachable" | "signed-out";

export const sync = createMutable<{ problem: Problem | null }>({ problem: null });

/** How long the connection can be down before the corner says so. */
const DownAfter = 5000;
/**
 * A lost network often leaves a WebSocket open and silent. So the device pings when idle, and treats the
 * connection as dead when a pong or an ack is this late.
 */
const PingEvery = 25_000;
const DeadAfter = 10_000;
const RetryMin = 1000;
const RetryMax = 30_000;
/** A pause in typing this long sends what was typed; so does typing this long without one. */
const SendDelay = 1000;
const SendAtMost = 5000;
/** How long signing out waits for the server to take the last changes. */
const DrainFor = 3000;

/** Set by the first sync, and kept as long as the page. */
let listening = false;
/** By the server, so the device waits for a sign-in before it connects again. */
let signedOut = false;

let socket: WebSocket | null = null;
/** When the connection was last tried, last heard from, and pinged while idle. */
let tried = 0;
let lastHeard = 0;
let pingSent = 0;
/** Null while the connection is up. */
let downSince: number | null = null;
let retry = RetryMin;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** Messages are handled one at a time, in order, since each may wait on disk. */
let chain = Promise.resolve();

let seq = 0;
/** Updates sent and not yet acked: which note, its generation then, and whether the update was the whole note. */
const unacked = new Map<number, { id: string; upTo: number; at: number; whole: boolean }>();
/** Changes made here and not sent yet, by note, so a burst of typing goes to the server as one update. */
const outbox = new Map<string, { updates: Uint8Array[]; since: number; timer?: ReturnType<typeof setTimeout> }>();
/**
 * Notes the server may be missing changes for, because one was refused, lost with a connection, never sent, or made
 * in another tab. Each keeps the last `seq` sent before then. Until a whole copy sent after it is acked, the note goes
 * whole, and no other ack marks it synced.
 */
const behind = new Map<string, number>();

/** Each refusal is explained once, not once for every change the server turns away. */
const explained = new Set<string>();
/** Notes whose history is too large for the server to keep. Until the page reloads, they aren't sent again. */
const tooLarge = new Set<string>();

/** What each refusal says, naming the note it's about. */
const Refused: Record<Refusal, (name: string) => string> = {
  "too-many": () => `Sync stops at ${number(MaxNotes)} notes, so delete some to make room`,
  "too-full": () => `Sync stops at ${number(MaxBytes / 1_000_000)} MB, so delete some notes to make room`,
  // Under the length limit, but so much has been typed and erased in it that its history is too large.
  "too-large": (name) => `${name || "This note"} is too large to sync, so copy its text into a new note`,
};

/** Called again after a sign-in, it starts over on a new connection, as the old one may belong to another session. */
export function startSync() {
  if (!listening) listen();
  signedOut = false;
  drop();
  downSince = Date.now();
  reconnect();
  report();
}

function listen() {
  listening = true;
  notes.onChange((id, update) => (update ? hold(id, update) : fallBehind(id, seq)));
  // A connection from before the network dropped is usually dead even if it looks open, so start over.
  addEventListener("online", () => {
    drop();
    reconnect();
  });
  addEventListener("offline", drop);
  // Leaving the app sends what's waiting at once; coming back reconnects.
  document.addEventListener("visibilitychange", () => (document.hidden ? void releaseAll() : reconnect()));
  addEventListener("pagehide", () => void releaseAll());
  setInterval(tick, 1000);
}

function connect() {
  clearTimeout(retryTimer);
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sync`);
  ws.binaryType = "arraybuffer";
  socket = ws;
  tried = Date.now();
  ws.onopen = () => {
    downSince = null;
    lastHeard = Date.now();
    pingSent = 0;
    run(ws, async () => {
      const hello = await notes.hello();
      if (ws.readyState === WebSocket.OPEN) ws.send(encode({ type: "hello", ...hello }));
    });
  };
  ws.onmessage = (event) => {
    lastHeard = Date.now();
    pingSent = 0;
    // The only text is the server's answer to a ping, which, like anything heard, shows the connection is alive.
    if (!(event.data instanceof ArrayBuffer)) return;
    const data = new Uint8Array(event.data);
    run(ws, () => handle(ws, decode(data)));
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    if (event.code === SignedOut) {
      signedOut = true;
      // After the messages before it, so a catch-up still queued can't mark this device caught up again.
      run(ws, () => notes.unsync());
    }
    drop();
  };
}

/** Runs after everything before it. Anything that fails takes the connection down. */
function run(ws: WebSocket, work: () => Promise<void>) {
  chain = chain.then(work).catch((error: unknown) => {
    console.error(error);
    ws.close();
  });
}

/** Gives up on the connection, without waiting for a close that a dead network never delivers, and retries later. */
function drop() {
  const ws = socket;
  if (!ws) return;
  socket = null;
  abandon();
  downSince ??= Date.now();
  ws.close();
  clearTimeout(retryTimer);
  // Without a network, the `online` event is the time to try again. Signed out, a sign-in is.
  if (navigator.onLine && !signedOut) {
    retryTimer = setTimeout(connect, retry * (0.75 + Math.random() / 2));
    retry = Math.min(retry * 2, RetryMax);
  }
  report();
}

/** Updates on a lost connection may never have arrived, so their notes are behind until they go whole. */
function abandon() {
  for (const sent of unacked.values()) fallBehind(sent.id, seq);
  unacked.clear();
}

function reconnect() {
  if (signedOut || socket) return;
  retry = RetryMin;
  connect();
}

async function handle(ws: WebSocket, message: Message) {
  switch (message.type) {
    case "catch-up":
      for (const note of message.notes) {
        if (note.update) await notes.receive(note.id, note.update);
        const update = note.vector && (await notes.missing(note.id, note.vector));
        if (update) send(note.id, update, true, ws);
      }
      if (!message.done) break;
      await notes.caughtUp(message.now);
      // The connection has proved itself, so if it drops now, trying again soon is right.
      retry = RetryMin;
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
      // Sent on a connection since dropped, the note is behind anyway, and is refused, and explained, again.
      if (!sent) break;
      fallBehind(sent.id, message.seq);
      if (message.reason === "too-large") tooLarge.add(sent.id);
      // A note's own limit is explained for each note, the account's just once.
      const about = message.reason === "too-large" ? sent.id : message.reason;
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

/** The update `seq` was, now that the server has answered it. */
function answered(seq: number) {
  const sent = unacked.get(seq);
  unacked.delete(seq);
  return sent;
}

/** Before signing out, sends every change still waiting, then gives the server a moment to take them all. */
export async function drain() {
  await notes.flush();
  await releaseAll();
  const until = Date.now() + DrainFor;
  while (unacked.size && socket?.readyState === WebSocket.OPEN && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // An ack is on disk once it's been handled.
  await chain;
}

/** Until typing pauses, or has gone on for a while. */
function hold(id: string, update: Uint8Array) {
  const now = Date.now();
  const waiting = outbox.get(id) ?? { updates: [], since: now };
  clearTimeout(waiting.timer);
  waiting.updates.push(update);
  waiting.timer = setTimeout(() => void release(id), Math.min(SendDelay, waiting.since + SendAtMost - now));
  outbox.set(id, waiting);
}

function releaseAll(): Promise<unknown> {
  return Promise.all([...outbox.keys()].map(release));
}

/** Sends the note's held changes as one update; or all of the note, if the server is behind on it. */
async function release(id: string) {
  const waiting = outbox.get(id);
  if (!waiting) return;
  clearTimeout(waiting.timer);
  outbox.delete(id);
  const whole = behind.has(id);
  const update = whole ? await notes.missing(id) : Y.mergeUpdates(waiting.updates);
  if (update) send(id, update, whole);
}

/** If not connected, or the note can't sync, it stays dirty and behind, and goes with a later hello. */
function send(id: string, update: Uint8Array, whole: boolean, ws = socket) {
  if (!ws || ws.readyState !== WebSocket.OPEN || isTooLong(id) || tooLarge.has(id)) {
    fallBehind(id, seq);
    return;
  }
  unacked.set(++seq, { id, upTo: notes.generation(id), at: Date.now(), whole });
  ws.send(encode({ type: "update", seq, id, update }));
}

/** It stays on this device, dirty and behind, until it's short enough again. */
export function isTooLong(id: string): boolean {
  return notes.length(id) > MaxLength;
}

function fallBehind(id: string, since: number) {
  behind.set(id, Math.max(since, behind.get(id) ?? 0));
}

/** A note that's behind catches up only with a whole copy sent after it fell behind. */
function catchesUp(sent: { id: string; whole: boolean }, seq: number): boolean {
  const since = behind.get(sent.id);
  return since === undefined || (sent.whole && seq > since);
}

function tick() {
  const now = Date.now();
  if (isDead(now)) drop();
  else if (socket?.readyState === WebSocket.OPEN && !pingSent && now - lastHeard > PingEvery) {
    pingSent = now;
    socket.send(Ping);
  }
  report();
}

/** Still connecting, or open with a pong or an ack too late. */
function isDead(now: number): boolean {
  if (socket?.readyState === WebSocket.CONNECTING) return now - tried > DeadAfter;
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (pingSent && now - pingSent > DeadAfter) return true;
  // Hearing anything counts, because acks queue behind the messages before them. An upload under way isn't late.
  return (
    socket.bufferedAmount === 0 && [...unacked.values()].some((sent) => now - Math.max(sent.at, lastHeard) > DeadAfter)
  );
}

function report() {
  if (signedOut) sync.problem = "signed-out";
  else if (downSince === null || Date.now() - downSince < DownAfter) sync.problem = null;
  else sync.problem = navigator.onLine ? "unreachable" : "offline";
}
