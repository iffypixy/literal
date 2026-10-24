/** Keeps this device's notes in sync with the account, over one WebSocket, for as long as it's signed in. */

import { createMutable } from "solid-js/store";
import * as Y from "yjs";
import { decode, encode, MaxBytes, MaxLength, MaxNotes, SignedOut, type Message } from "../../../protocol/protocol.ts";
import * as notes from "../notes/notes.ts";
import { quoted } from "../notes/search.ts";
import { toast } from "../ui/toast.tsx";

/** What the corner says, if anything: nothing while all is well. */
export type Status = "" | "Offline" | "Not synced" | "Sign in to sync";

export const sync = createMutable<{ status: Status }>({ status: "" });

/** How long the connection may be down before the corner says so. */
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

let socket: WebSocket | null = null;
let running = false;
let signedOut = false;
let seq = 0;
/**
 * Updates sent and not yet acked: which note, how far its changes went, and whether the update alone left the
 * server lacking none of it.
 */
const unacked = new Map<number, { id: string; upTo: number; at: number; whole: boolean }>();
/** Changes made here and not sent yet, by note: a burst of typing goes to the server as one update. */
const outbox = new Map<string, { updates: Uint8Array[]; since: number; timer?: ReturnType<typeof setTimeout> }>();
/**
 * Notes the server may lack changes of that their next update alone wouldn't carry: an update was refused, or lost
 * with a connection, or the note was too long to send. Each by the last `seq` that went without them: until a whole
 * note sent after that is acked, the note goes whole, and no other ack marks it synced.
 */
const behind = new Map<string, number>();
let retry = RetryMin;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** When the connection went down; null while it's up. Down from the start, until the first one opens. */
let downSince: number | null = Date.now();
/** When the current connection was started. */
let tried = 0;
let lastHeard = 0;
let pingSent = 0;
/** Messages are handled one at a time, in order: each may wait on disk. */
let queue = Promise.resolve();
/** Refusals already explained: each is said once, not once for every change the server turns away. */
const told = new Set<string>();

/** Starts syncing; called again after signing in anew, it tries again at once. */
export function start() {
  signedOut = false;
  if (running) {
    reconnect();
    update();
    return;
  }
  running = true;
  notes.onLocal(post);
  // A connection from before the network dropped is usually dead even if it looks open: start over.
  addEventListener("online", () => {
    drop();
    reconnect();
  });
  addEventListener("offline", drop);
  // Leaving the app sends what's waiting at once; coming back reconnects.
  document.addEventListener("visibilitychange", () => (document.hidden ? sendAll() : reconnect()));
  addEventListener("pagehide", sendAll);
  setInterval(tick, 1000);
  connect();
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
    if (!(event.data instanceof ArrayBuffer)) return; // a pong
    const data = new Uint8Array(event.data);
    run(ws, () => handle(ws, decode(data)));
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    if (event.code === SignedOut) {
      socket = null;
      abandon();
      signedOut = true;
      update();
      void notes.unsync();
      return;
    }
    drop();
  };
}

/** Runs `work` after everything before it on this connection, which goes down if anything fails. */
function run(ws: WebSocket, work: () => Promise<void>) {
  queue = queue.then(work).catch((error: unknown) => {
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
  // Without a network, the `online` event is the time to try again.
  if (navigator.onLine) {
    retryTimer = setTimeout(connect, retry * (0.75 + Math.random() / 2));
    retry = Math.min(retry * 2, RetryMax);
  }
  update();
}

/** Updates on a lost connection may never have arrived: their notes are behind until they go whole. */
function abandon() {
  for (const sent of unacked.values()) fallBehind(sent.id, seq);
  unacked.clear();
}

/** Tries again right away: the network came back, or the app came back to the front. */
function reconnect() {
  if (!running || signedOut || socket) return;
  retry = RetryMin;
  connect();
}

async function handle(ws: WebSocket, message: Message) {
  switch (message.type) {
    case "catch-up":
      for (const note of message.notes) {
        if (note.update) await notes.receive(note.id, note.update);
        if (note.vector && !tooLong(note.id)) {
          const update = await notes.missing(note.id, note.vector);
          if (update) send(note.id, update, true, ws);
        }
      }
      if (!message.done) break;
      await notes.caughtUp(message.now);
      // The connection has proved itself: if it drops now, trying again soon is right.
      retry = RetryMin;
      break;
    case "update":
      await notes.receive(message.id, message.update);
      break;
    case "ack": {
      const sent = unacked.get(message.seq);
      unacked.delete(message.seq);
      if (!sent) break;
      const since = behind.get(sent.id);
      if (since !== undefined) {
        if (!sent.whole || message.seq <= since) break;
        behind.delete(sent.id);
      }
      await notes.acked(sent.id, sent.upTo);
      break;
    }
    case "refused": {
      const sent = unacked.get(message.seq);
      unacked.delete(message.seq);
      if (sent) fallBehind(sent.id, message.seq);
      // The note's own limit is said for each note; the account's, once.
      const about = message.reason === "too-large" ? (sent?.id ?? message.reason) : message.reason;
      if (told.has(about)) break;
      told.add(about);
      const name = sent ? quoted(notes.find(sent.id)?.text ?? "") : "";
      if (message.reason === "too-many")
        toast(`Sync stops at ${MaxNotes.toLocaleString()} notes, so delete some to make room`);
      else if (message.reason === "too-full")
        toast(`Sync stops at ${MaxBytes / 1_000_000} MB, so delete some notes to make room`);
      else
        toast(name ? `Split "${name}" into shorter notes to sync it` : "Split this note into shorter notes to sync it");
      break;
    }
    case "purge":
      for (const id of message.ids) await notes.forgotten(id);
      break;
    case "hello":
      throw new Error("sync: the server said hello");
  }
}

/** Sends every change still waiting, then gives the server a moment to take them all: before signing out. */
export async function drain() {
  await notes.flush();
  await Promise.all([...outbox.keys()].map((id) => flush(id)));
  const until = Date.now() + DrainFor;
  while (unacked.size && socket?.readyState === WebSocket.OPEN && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // An ack is on disk once it's been handled.
  await queue;
}

/** Holds a change made here until typing pauses, or has gone on for a while. */
function post(id: string, update: Uint8Array) {
  const now = Date.now();
  const waiting = outbox.get(id) ?? { updates: [], since: now };
  clearTimeout(waiting.timer);
  waiting.updates.push(update);
  waiting.timer = setTimeout(() => void flush(id), Math.min(SendDelay, waiting.since + SendAtMost - now));
  outbox.set(id, waiting);
}

function sendAll() {
  for (const id of [...outbox.keys()]) void flush(id);
}

/** Sends the note's waiting changes, as one update; or all of the note, if the server is behind on it. */
async function flush(id: string) {
  const waiting = outbox.get(id);
  if (!waiting) return;
  clearTimeout(waiting.timer);
  outbox.delete(id);
  if (tooLong(id)) return;
  if (!behind.has(id)) {
    send(id, Y.mergeUpdates(waiting.updates), false);
    return;
  }
  const whole = await notes.missing(id);
  if (whole) send(id, whole, true);
}

/** Sends a change now if connected; otherwise the note stays dirty, and goes with the next hello. */
function send(id: string, update: Uint8Array, whole: boolean, ws = socket) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  unacked.set(++seq, { id, upTo: notes.generation(id), at: Date.now(), whole });
  ws.send(encode({ type: "update", seq, id, update }));
}

/** A note too long to sync stays on this device, dirty, until it's short enough again. Checked before encoding it. */
function tooLong(id: string): boolean {
  if (notes.length(id) <= MaxLength) return false;
  fallBehind(id, seq);
  return true;
}

function fallBehind(id: string, since: number) {
  behind.set(id, Math.max(since, behind.get(id) ?? 0));
}

/** Once a second: checks the connection is alive, and updates the status. */
function tick() {
  const now = Date.now();
  if (socket?.readyState === WebSocket.CONNECTING && now - tried > DeadAfter) drop();
  else if (socket?.readyState === WebSocket.OPEN) {
    // Hearing anything counts: acks queue behind the messages before them. And an upload still under way isn't late.
    const late =
      socket.bufferedAmount === 0 &&
      [...unacked.values()].some((sent) => now - Math.max(sent.at, lastHeard) > DeadAfter);
    if (late || (pingSent && now - pingSent > DeadAfter)) drop();
    else if (!pingSent && now - lastHeard > PingEvery) {
      pingSent = now;
      socket.send("ping");
    }
  }
  update();
}

function update() {
  if (signedOut) sync.status = "Sign in to sync";
  else if (downSince === null || Date.now() - downSince < DownAfter) sync.status = "";
  // Down with a network means the server can't be reached; without one, the device is offline.
  else sync.status = navigator.onLine ? "Not synced" : "Offline";
}
