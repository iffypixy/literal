/** Keeps this device's notes in sync with the account, over one WebSocket, for as long as it's signed in. */

import * as Y from "yjs";
import { decode, encode, SIGNED_OUT, type Message } from "../../../protocol/protocol.ts";
import * as notes from "../notes/notes.svelte.ts";
import { shorten, title } from "../notes/search.ts";
import { toast } from "../ui/toast.svelte.ts";

/** What the corner says, if anything: nothing while all is well. */
export type Status = "" | "Offline" | "Not synced" | "Sign in to sync";

export const sync = $state<{ status: Status }>({ status: "" });

/** How long the connection may be down before the corner says so. */
const DOWN_AFTER = 5000;
/**
 * A lost network often leaves a WebSocket open and silent. So the device pings when idle, and treats the
 * connection as dead when a pong or an ack is this late.
 */
const PING_EVERY = 25_000;
const DEAD_AFTER = 10_000;
const RETRY_MIN = 1000;
const RETRY_MAX = 30_000;
/** A pause in typing this long sends what was typed; so does typing this long without one. */
const SEND_DELAY = 1000;
const SEND_AT_MOST = 5000;
/** How long signing out waits for the server to take the last changes. */
const DRAIN_FOR = 3000;

let socket: WebSocket | null = null;
let running = false;
let signedOut = false;
let seq = 0;
/** Updates sent and not yet acked: which note, how far its changes went, and whether it carried all of the note. */
const unacked = new Map<number, { id: string; upTo: number; at: number; whole: boolean }>();
/** Changes made here and not sent yet, by note: a burst of typing goes to the server as one update. */
const outbox = new Map<string, { updates: Uint8Array[]; since: number; timer?: ReturnType<typeof setTimeout> }>();
/**
 * Notes the server may lack changes of that their next update alone wouldn't carry: an update was refused, or lost
 * with a connection. Each by the last `seq` that went without them: until a whole note sent after that is acked,
 * the note goes whole, and no other ack marks it synced.
 */
const behind = new Map<string, number>();
let retry = RETRY_MIN;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let downSince = Date.now();
let lastHeard = Date.now();
let pingSent = 0;
/** Messages are handled one at a time, in order: each may wait on disk. */
let queue = Promise.resolve();
/** Refusals already explained: each is said once, not once for every change the server turns away. */
const told = new Set<string>();

/** Starts syncing; called again after signing in anew, it tries again at once. */
export function start() {
  if (running) {
    signedOut = false;
    reconnect();
    update();
    return;
  }
  running = true;
  signedOut = false;
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
  ws.onopen = async () => {
    retry = RETRY_MIN;
    lastHeard = Date.now();
    const hello = await notes.hello();
    if (ws.readyState === WebSocket.OPEN) ws.send(encode({ type: "hello", ...hello }));
  };
  ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
    lastHeard = Date.now();
    pingSent = 0;
    if (typeof event.data === "string") return; // a pong
    const message = decode(new Uint8Array(event.data));
    queue = queue
      .then(() => handle(ws, message))
      .catch((error: unknown) => {
        console.error(error);
        ws.close();
      });
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    if (event.code === SIGNED_OUT) {
      socket = null;
      abandon();
      signedOut = true;
      update();
      return;
    }
    drop();
  };
}

/** Gives up on the connection, without waiting for a close that a dead network never delivers, and retries later. */
function drop() {
  const ws = socket;
  if (!ws) return;
  socket = null;
  abandon();
  downSince = Date.now();
  ws.close();
  clearTimeout(retryTimer);
  // Without a network, the `online` event is the time to try again.
  if (navigator.onLine) {
    retryTimer = setTimeout(connect, retry * (0.75 + Math.random() / 2));
    retry = Math.min(retry * 2, RETRY_MAX);
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
  retry = RETRY_MIN;
  connect();
}

async function handle(ws: WebSocket, message: Message) {
  switch (message.type) {
    case "catch-up":
      for (const note of message.notes) {
        if (note.update) await notes.receive(note.id, note.update);
        if (note.vector) {
          const update = await notes.missing(note.id, note.vector);
          if (update) send(note.id, update, true, ws);
        }
      }
      if (message.done) await notes.caughtUp(message.now);
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
      const about = message.reason === "too-many" ? message.reason : (sent?.id ?? message.reason);
      if (told.has(about)) break;
      told.add(about);
      const name = sent ? shorten(title(notes.find(sent.id)?.text ?? ""), 30) : "";
      if (message.reason === "too-many") toast("Sync stops at 10,000 notes, so delete some to make room");
      else
        toast(name ? `Split "${name}" into shorter notes to sync it` : "Split this note into shorter notes to sync it");
      break;
    }
    case "purge":
      for (const id of message.ids) await notes.purge(id);
      break;
    case "hello":
      throw new Error("sync: the server said hello");
  }
}

/** Sends every change still waiting, then gives the server a moment to take them all: before signing out. */
export async function drain() {
  await notes.flush();
  await Promise.all([...outbox.keys()].map((id) => flush(id)));
  const until = Date.now() + DRAIN_FOR;
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
  waiting.timer = setTimeout(() => void flush(id), Math.min(SEND_DELAY, waiting.since + SEND_AT_MOST - now));
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
  if (!behind.has(id)) {
    send(id, Y.mergeUpdates(waiting.updates), false);
    return;
  }
  const whole = await notes.missing(id);
  if (whole) send(id, whole, true);
}

/** Sends a change now if connected; otherwise the note stays dirty and goes with the next hello. */
function send(id: string, update: Uint8Array, whole: boolean, ws = socket) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  unacked.set(++seq, { id, upTo: notes.generation(id), at: Date.now(), whole });
  ws.send(encode({ type: "update", seq, id, update }));
}

function fallBehind(id: string, since: number) {
  behind.set(id, Math.max(since, behind.get(id) ?? 0));
}

/** Once a second: checks the connection is alive, and updates the status. */
function tick() {
  const now = Date.now();
  if (socket?.readyState === WebSocket.OPEN) {
    const late = [...unacked.values()].some((sent) => now - sent.at > DEAD_AFTER);
    if (late || (pingSent && now - pingSent > DEAD_AFTER)) drop();
    else if (!pingSent && now - lastHeard > PING_EVERY) {
      pingSent = now;
      socket.send("ping");
    }
  }
  update();
}

function update() {
  const down = !socket || socket.readyState !== WebSocket.OPEN;
  if (signedOut) sync.status = "Sign in to sync";
  else if (!down || Date.now() - downSince < DOWN_AFTER) sync.status = "";
  // Down with a network means the server can't be reached; without one, the device is offline.
  else sync.status = navigator.onLine ? "Not synced" : "Offline";
}
