/**
 * The sync protocol: binary messages over one WebSocket between a device and the user's Durable Object.
 *
 * 1. The device says `hello`: when it last caught up (`since`, in server time), and for every note it has, its
 *    Yjs state vector and whether it has changes the server hasn't acked (`dirty`).
 * 2. The server answers `catch-up`, in one or more batches: for every note changed since `since`, what the
 *    device is missing; for every dirty note, the server's state vector, so the device can send what the
 *    server is missing as an `update`. State vectors don't capture deletions, hence the dirty flag.
 * 3. From then on, both sides send `update`s: the server as they arrive, the device once typing pauses. The server
 *    stores each one, then `ack`s it.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export type Message =
  | { type: "hello"; since: number; notes: { id: string; vector: Uint8Array; dirty: boolean }[] }
  /** `now`: the server time the device has caught up to once the `done` batch arrives. */
  | {
      type: "catch-up";
      done: boolean;
      now: number;
      notes: { id: string; update: Uint8Array | null; vector: Uint8Array | null }[];
    }
  /** `seq` numbers a device's updates so the server can ack them; the server's own updates carry 0. */
  | { type: "update"; seq: number; id: string; update: Uint8Array }
  | { type: "ack"; seq: number }
  | { type: "refused"; seq: number; reason: Refusal }
  /** Notes deleted over 30 days ago, erased for good: devices erase them too. */
  | { type: "purge"; ids: string[] };

/** The longest note that syncs, in UTF-16 code units, as Yjs counts. The device holds a longer one back. */
export const MaxLength = 100_000;
/** Deleted notes don't count toward these. */
export const MaxNotes = 10_000;
export const MaxBytes = 100_000_000;

/** The close code that tells a device to stop reconnecting and ask to sign in. */
export const SignedOut = 4001;

/** Digits in an emailed sign-in code. */
export const CodeLength = 6;

/** The order of Types and Refusals is the wire format: only ever append. */
const Types = ["hello", "catch-up", "update", "ack", "refused", "purge"] as const;
const Refusals = ["too-large", "too-many", "too-full"] as const;

export type Refusal = (typeof Refusals)[number];

export function encode(message: Message): Uint8Array<ArrayBuffer> {
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, Types.indexOf(message.type));
  switch (message.type) {
    case "hello":
      encoding.writeVarUint(out, message.since);
      encoding.writeVarUint(out, message.notes.length);
      for (const note of message.notes) {
        encoding.writeVarString(out, note.id);
        encoding.writeVarUint8Array(out, note.vector);
        encoding.writeUint8(out, note.dirty ? 1 : 0);
      }
      break;
    case "catch-up":
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
  const bytes = encoding.toUint8Array(out);
  // lib0 builds it in a fresh, plain ArrayBuffer; its types just don't say so, and WebSocket.send wants to know.
  if (!isPlain(bytes)) throw new Error("encode: not a plain ArrayBuffer");
  return bytes;
}

function isPlain(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer;
}

/** Throws on anything malformed, so a bad peer gets disconnected rather than half-understood. */
export function decode(data: Uint8Array): Message {
  const input = decoding.createDecoder(data);
  const message = readMessage(input);
  if (decoding.hasContent(input)) throw new Error("decode: trailing bytes");
  return message;
}

function readMessage(input: decoding.Decoder): Message {
  const type = Types[decoding.readVarUint(input)];
  switch (type) {
    case "hello":
      return {
        type,
        since: decoding.readVarUint(input),
        notes: readList(input, () => ({
          id: readId(input),
          vector: decoding.readVarUint8Array(input),
          dirty: readBoolean(input),
        })),
      };
    case "catch-up":
      return {
        type,
        done: readBoolean(input),
        now: decoding.readVarUint(input),
        notes: readList(input, () => {
          const id = readId(input);
          const update = decoding.readVarUint8Array(input);
          const vector = decoding.readVarUint8Array(input);
          return { id, update: update.length ? update : null, vector: vector.length ? vector : null };
        }),
      };
    case "update":
      return { type, seq: decoding.readVarUint(input), id: readId(input), update: decoding.readVarUint8Array(input) };
    case "ack":
      return { type, seq: decoding.readVarUint(input) };
    case "refused": {
      const seq = decoding.readVarUint(input);
      const reason = Refusals[decoding.readVarUint(input)];
      if (!reason) throw new Error("decode: unknown refusal");
      return { type, seq, reason };
    }
    case "purge":
      return { type, ids: readList(input, () => readId(input)) };
    default:
      throw new Error("decode: unknown message type");
  }
}

/** Every item takes a byte at least: a count past the bytes left would make the reader allocate for nothing. */
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

/**
 * 10 characters of lowercase Crockford base32, or, for a note made before those, 12 of base64url: nothing else ever
 * becomes a key in storage.
 */
export function isNoteId(id: string): boolean {
  return /^[0-9a-hjkmnp-tv-z]{10}$/.test(id) || /^[\w-]{12}$/.test(id);
}
