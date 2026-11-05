/** Keeps this device's notes in sync with the account, over one WebSocket, for as long as it's signed in. */

import { createMutable } from "solid-js/store";
import * as Y from "yjs";
import { decode, encode, MaxBytes, MaxLength, MaxNotes, SignedOut, type Message } from "#protocol.ts";
import { number } from "#web/format.ts";
import * as notes from "#web/notes/notes.ts";
import { quoted } from "#web/notes/search.ts";
import { toast } from "#web/ui/toast.tsx";

/** What keeps notes from syncing: null while nothing does. `unreachable`: online, but the server can't be reached. */
export type Problem = "offline" | "unreachable" | "signed-out";

export const sync = createMutable<{ problem: Problem | null }>({ problem: null });

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
/** Updates sent and not yet acked: which note, its generation then, and whether the update was the whole note. */
const unacked = new Map<number, { id: string; upTo: number; at: number; whole: boolean }>();
/** Changes made here and not sent yet, by note: a burst of typing goes to the server as one update. */
const outbox = new Map<string, { updates: Uint8Array[]; since: number; timer?: ReturnType<typeof setTimeout> }>();
/**
 * Notes the server may be missing changes for: one was refused, lost with a connection or never sent, or made in
 * another tab. Each keeps the last `seq` sent before then. Until a whole copy sent after it is acked, the note goes
 * whole, and no other ack marks it synced.
 */
const behind = new Map<string, number>();
let retry = RetryMin;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** Null while the connection is up. Down from the start, until the first one opens. */
let downSince: number | null = Date.now();
let tried = 0;
let lastHeard = 0;
let pingSent = 0;
/** Messages are handled one at a time, in order: each may wait on disk. */
let chain = Promise.resolve();
/** Each refusal is explained once, not once for every change the server turns away. */
const told = new Set<string>();

/** Called again after signing in anew, it tries again at once. */
export function start() {
  signedOut = false;
  if (running) {
    reconnect();
    report();
    return;
  }
  running = true;
  notes.onChange((id, update) => (update ? hold(id, update) : fallBehind(id, seq)));
  // A connection from before the network dropped is usually dead even if it looks open: start over.
  addEventListener("online", () => {
    drop();
    reconnect();
  });
  addEventListener("offline", drop);
  // Leaving the app sends what's waiting at once; coming back reconnects.
  document.addEventListener("visibilitychange", () => (document.hidden ? releaseAll() : reconnect()));
  addEventListener("pagehide", releaseAll);
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
      report();
      void notes.unsync();
      return;
    }
    drop();
  };
}

/** After everything before it; anything failing takes the connection down. */
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
  // Without a network, the `online` event is the time to try again.
  if (navigator.onLine) {
    retryTimer = setTimeout(connect, retry * (0.75 + Math.random() / 2));
    retry = Math.min(retry * 2, RetryMax);
  }
  report();
}

/** Updates on a lost connection may never have arrived: their notes are behind until they go whole. */
function abandon() {
  for (const sent of unacked.values()) fallBehind(sent.id, seq);
  unacked.clear();
}

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
        if (!note.vector) continue;
        if (isTooLong(note.id)) {
          fallBehind(note.id, seq);
          continue;
        }
        const update = await notes.missing(note.id, note.vector);
        if (update) send(note.id, update, true, ws);
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
      if (message.reason === "too-many") toast(`Sync stops at ${number(MaxNotes)} notes, so delete some to make room`);
      else if (message.reason === "too-full")
        toast(`Sync stops at ${number(MaxBytes / 1_000_000)} MB, so delete some notes to make room`);
      else toast(tooLong(name));
      break;
    }
    case "purge":
      for (const id of message.ids) await notes.forgotten(id);
      break;
    case "hello":
      throw new Error("sync: the server said hello");
  }
}

/** Before signing out: sends every change still waiting, then gives the server a moment to take them all. */
export async function drain() {
  await notes.flush();
  await Promise.all([...outbox.keys()].map((id) => release(id)));
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

function releaseAll() {
  for (const id of outbox.keys()) void release(id);
}

/** Sends the note's held changes as one update; or all of the note, if the server is behind on it. */
async function release(id: string) {
  const waiting = outbox.get(id);
  if (!waiting) return;
  clearTimeout(waiting.timer);
  outbox.delete(id);
  if (isTooLong(id)) {
    fallBehind(id, seq);
    return;
  }
  if (!behind.has(id)) {
    send(id, Y.mergeUpdates(waiting.updates), false);
    return;
  }
  const whole = await notes.missing(id);
  if (whole) send(id, whole, true);
}

/** If not connected, the note stays dirty, and goes with the next hello. */
function send(id: string, update: Uint8Array, whole: boolean, ws = socket) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    fallBehind(id, seq);
    return;
  }
  unacked.set(++seq, { id, upTo: notes.generation(id), at: Date.now(), whole });
  ws.send(encode({ type: "update", seq, id, update }));
}

/** Why a note doesn't sync: the one named, or the one open. */
export function tooLong(name = ""): string {
  return `Notes sync up to ${number(MaxLength)} characters, so split ${name ? `"${name}"` : "this one"} into shorter notes`;
}

/** It stays on this device, dirty and behind, until it's short enough again. */
function isTooLong(id: string): boolean {
  return notes.length(id) > MaxLength;
}

function fallBehind(id: string, since: number) {
  behind.set(id, Math.max(since, behind.get(id) ?? 0));
}

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
  report();
}

function report() {
  if (signedOut) sync.problem = "signed-out";
  else if (downSince === null || Date.now() - downSince < DownAfter) sync.problem = null;
  else sync.problem = navigator.onLine ? "unreachable" : "offline";
}
