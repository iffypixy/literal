/**
 * What a device and the server share, above all the sync protocol: binary messages over one WebSocket between a
 * device and the user's Durable Object.
 *
 * 1. The device says `hello`: when it last caught up (`since`, in server time), and for every note it has, its
 *    Yjs state vector and whether it has changes the server hasn't acked (`dirty`).
 * 2. The server answers `catchUp`, in one or more batches: for every note changed since `since`, what the device is
 *    missing; for every dirty note, the server's state vector, so the device can send what the server is missing as
 *    an `update`. State vectors don't capture deletions, hence the dirty flag.
 * 3. From then on, both sides send `update`s: the server as they arrive, the device once typing pauses. The server
 *    stores each one, then `ack`s it.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type * as Y from "yjs";

export type Message =
  | { kind: "hello"; since: number; notes: { id: string; vector: Uint8Array; dirty: boolean }[] }
  /** `now`: the server time the device has caught up to once the `done` batch arrives. */
  | {
      kind: "catchUp";
      done: boolean;
      now: number;
      notes: { id: string; update: Uint8Array | null; vector: Uint8Array | null }[];
    }
  /** `seq` numbers a device's updates so the server can ack them. Those it passes on from other devices carry 0. */
  | { kind: "update"; seq: number; id: string; update: Uint8Array }
  | { kind: "ack"; seq: number }
  /** The update would pass a limit, so it wasn't stored. */
  | { kind: "refused"; seq: number; reason: Refusal }
  /** Notes deleted over 30 days ago and erased for good. Devices erase them too. */
  | { kind: "purge"; ids: string[] };

export type MessageOf<K extends Message["kind"]> = Extract<Message, { kind: K }>;

export type Refusal = (typeof Refusals)[number];

/** The longest note that syncs, in UTF-16 code units as Yjs counts them. A device holds a longer one back. */
export const MaxLength = 100_000;
/** The most notes an account syncs, and bytes of their Yjs state. Deleted notes don't count. */
export const MaxNotes = 10_000;
export const MaxBytes = 100_000_000;

/** Text, not binary: an idle device sends Ping to learn it's still connected, and the server answers without waking. */
export const Ping = "ping";
export const Pong = "pong";

/** The close code that tells a device to stop reconnecting and ask to sign in. */
export const SignedOut = 4001;

export const CodeDigits = 6;

// Their order is the wire format, so only ever append.
const Kinds = ["hello", "catchUp", "update", "ack", "refused", "purge"] as const;
const Refusals = ["tooLarge", "tooMany", "tooFull"] as const;

// Lowercase Crockford base32: no letter passes for a digit, and 32 divides 256, so a random byte picks one fairly.
const IdAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const idPattern = new RegExp(`^[${IdAlphabet}]{10}$`);

export function encode(message: Message): Uint8Array<ArrayBuffer> {
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, Kinds.indexOf(message.kind));
  switch (message.kind) {
    case "hello":
      encoding.writeVarUint(out, message.since);
      encoding.writeVarUint(out, message.notes.length);
      for (const note of message.notes) {
        encoding.writeVarString(out, note.id);
        encoding.writeVarUint8Array(out, note.vector);
        encoding.writeUint8(out, note.dirty ? 1 : 0);
      }
      break;
    case "catchUp":
      encoding.writeUint8(out, message.done ? 1 : 0);
      encoding.writeVarUint(out, message.now);
      encoding.writeVarUint(out, message.notes.length);
      for (const note of message.notes) {
        encoding.writeVarString(out, note.id);
        encoding.writeVarUint8Array(out, note.update ?? new Uint8Array());
        encoding.writeVarUint8Array(out, note.vector ?? new Uint8Array());
      }
      break;
    case "update":
      encoding.writeVarUint(out, message.seq);
      encoding.writeVarString(out, message.id);
      encoding.writeVarUint8Array(out, message.update);
      break;
    case "ack":
      encoding.writeVarUint(out, message.seq);
      break;
    case "refused":
      encoding.writeVarUint(out, message.seq);
      encoding.writeVarUint(out, Refusals.indexOf(message.reason));
      break;
    case "purge":
      encoding.writeVarUint(out, message.ids.length);
      for (const id of message.ids) encoding.writeVarString(out, id);
      break;
  }
  return encoding.toUint8Array(out);
}

/** Throws on anything malformed, so a bad peer gets disconnected rather than half-understood. */
export function decode(data: Uint8Array): Message {
  const input = decoding.createDecoder(data);
  const message = readMessage(input);
  if (decoding.hasContent(input)) throw new Error("decode: trailing bytes");
  return message;
}

/** 50 random bits. */
export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => IdAlphabet[byte & 31]).join("");
}

/** Only ever what `newId` makes, so nothing else becomes a key in storage. */
export function isNoteId(id: string): boolean {
  return idPattern.test(id);
}

/** Decided by a note's own times, the same on every device and the server. An edit after a delete brings it back. */
export function isDeleted(deletedAt: number | null | undefined, editedAt: number): boolean {
  return typeof deletedAt === "number" && deletedAt >= editedAt;
}

/** From the doc's own times alone, since reading its text would copy all of it. */
export function isDocDeleted(doc: Y.Doc): boolean {
  return isDeleted(doc.getMap<number>("meta").get("deletedAt"), lastEdited(doc));
}

/** The latest of each device's own edit time, or `meta.editedAt` in older notes. */
export function lastEdited(doc: Y.Doc): number {
  // With one time for all, two devices editing at once would leave whichever Yjs picks, not the later one.
  const times = [...doc.getMap<number>("edits").values()];
  return times.length ? Math.max(...times) : (doc.getMap<number>("meta").get("editedAt") ?? 0);
}

/** Sets this device's edit time, and drops the earlier ones it has seen from other devices. */
export function markEdited(doc: Y.Doc, at: number) {
  const edits = doc.getMap<number>("edits");
  doc.transact(() => {
    for (const [device, time] of edits) if (time <= at) edits.delete(device);
    edits.set(String(doc.clientID), at);
  });
}

function readMessage(input: decoding.Decoder): Message {
  const kind = Kinds[decoding.readVarUint(input)];
  switch (kind) {
    case "hello":
      return {
        kind,
        since: decoding.readVarUint(input),
        notes: readList(input, () => ({
          id: readId(input),
          vector: decoding.readVarUint8Array(input),
          dirty: readBoolean(input),
        })),
      };
    case "catchUp":
      return {
        kind,
        done: readBoolean(input),
        now: decoding.readVarUint(input),
        notes: readList(input, () => ({
          id: readId(input),
          update: readBytesOrNull(input),
          vector: readBytesOrNull(input),
        })),
      };
    case "update":
      return { kind, seq: decoding.readVarUint(input), id: readId(input), update: decoding.readVarUint8Array(input) };
    case "ack":
      return { kind, seq: decoding.readVarUint(input) };
    case "refused": {
      const seq = decoding.readVarUint(input);
      const reason = Refusals[decoding.readVarUint(input)];
      if (!reason) throw new Error("decode: unknown refusal");
      return { kind, seq, reason };
    }
    case "purge":
      return { kind, ids: readList(input, () => readId(input)) };
    default:
      throw new Error("decode: unknown message kind");
  }
}

// Every item takes at least a byte, so a count past the bytes left would make the reader allocate for nothing.
function readList<T>(input: decoding.Decoder, item: () => T): T[] {
  const count = decoding.readVarUint(input);
  if (count > input.arr.length - input.pos) throw new Error("decode: count past the end");
  return Array.from({ length: count }, item);
}

function readId(input: decoding.Decoder): string {
  const id = decoding.readVarString(input);
  if (!isNoteId(id)) throw new Error("decode: bad note id");
  return id;
}

function readBoolean(input: decoding.Decoder): boolean {
  // Past the end, lib0's readUint8 returns undefined rather than throwing.
  const byte: number | undefined = decoding.readUint8(input);
  if (byte !== 0 && byte !== 1) throw new Error("decode: bad boolean");
  return byte === 1;
}

// Null is empty on the wire.
function readBytesOrNull(input: decoding.Decoder): Uint8Array | null {
  const bytes = decoding.readVarUint8Array(input);
  return bytes.length ? bytes : null;
}
