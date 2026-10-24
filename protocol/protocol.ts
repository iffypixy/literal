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
  /** `done` marks the last batch; `now` is the server time the device has then caught up to. */
  | {
      type: "catch-up";
      done: boolean;
      now: number;
      notes: { id: string; update: Uint8Array | null; vector: Uint8Array | null }[];
    }
  /** `seq` numbers a device's updates so the server can ack them; the server's own updates carry 0. */
  | { type: "update"; seq: number; id: string; update: Uint8Array }
  | { type: "ack"; seq: number }
  /** The update was refused: the note grew past its limit, or the account has too many notes. */
  | { type: "refused"; seq: number; reason: Refusal }
  /** Notes deleted long ago, erased for good: devices erase them too. */
  | { type: "purge"; ids: string[] };

export type Refusal = "too-large" | "too-many";

/** Close codes the server uses, so the device knows not to just reconnect. */
export const SIGNED_OUT = 4001;

const TYPES = ["hello", "catch-up", "update", "ack", "refused", "purge"] as const;
const REFUSALS: Refusal[] = ["too-large", "too-many"];

export function encode(message: Message): Uint8Array<ArrayBuffer> {
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, TYPES.indexOf(message.type));
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
      encoding.writeVarUint(out, REFUSALS.indexOf(message.reason));
      break;
    case "purge":
      encoding.writeVarUint(out, message.ids.length);
      for (const id of message.ids) encoding.writeVarString(out, id);
      break;
  }
  // lib0 builds the result in a fresh, plain ArrayBuffer; its types just don't say so, and WebSocket.send wants to know.
  return encoding.toUint8Array(out) as Uint8Array<ArrayBuffer>;
}

/** Parses a message; throws on anything malformed, so a bad peer gets disconnected rather than half-understood. */
export function decode(data: Uint8Array): Message {
  const input = decoding.createDecoder(data);
  const type = TYPES[decoding.readVarUint(input)];
  switch (type) {
    case "hello":
      return {
        type,
        since: decoding.readVarUint(input),
        notes: Array.from({ length: decoding.readVarUint(input) }, () => ({
          id: decoding.readVarString(input),
          vector: decoding.readVarUint8Array(input),
          dirty: decoding.readUint8(input) === 1,
        })),
      };
    case "catch-up":
      return {
        type,
        done: decoding.readUint8(input) === 1,
        now: decoding.readVarUint(input),
        notes: Array.from({ length: decoding.readVarUint(input) }, () => {
          const id = decoding.readVarString(input);
          const update = decoding.readVarUint8Array(input);
          const vector = decoding.readVarUint8Array(input);
          return { id, update: update.length ? update : null, vector: vector.length ? vector : null };
        }),
      };
    case "update":
      return {
        type,
        seq: decoding.readVarUint(input),
        id: decoding.readVarString(input),
        update: decoding.readVarUint8Array(input),
      };
    case "ack":
      return { type, seq: decoding.readVarUint(input) };
    case "refused": {
      const seq = decoding.readVarUint(input);
      const reason = REFUSALS[decoding.readVarUint(input)];
      if (!reason) throw new Error("decode: unknown refusal");
      return { type, seq, reason };
    }
    case "purge":
      return { type, ids: Array.from({ length: decoding.readVarUint(input) }, () => decoding.readVarString(input)) };
    default:
      throw new Error("decode: unknown message type");
  }
}

/** Whether `id` has the shape of a note id, so nothing else ever becomes a key in storage. */
export function isNoteId(id: string): boolean {
  return /^[\w-]{12}$/.test(id);
}
