import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, encode, type Message } from "#protocol.ts";

const id = "7k3qx9m2da";
const bytes = new Uint8Array([1, 2, 3]);

test("every message decodes to what was encoded", () => {
  const messages: Message[] = [
    { type: "hello", since: 1234, notes: [{ id, vector: bytes, dirty: true }] },
    { type: "catch-up", done: false, now: 99, notes: [{ id, update: bytes, vector: null }] },
    { type: "update", seq: 7, id, update: bytes },
    { type: "ack", seq: 7 },
    { type: "refused", seq: 8, reason: "too-full" },
    { type: "purge", ids: [id] },
  ];
  for (const message of messages) assert.deepEqual(decode(encode(message)), message);
});

test("a malformed message is refused rather than half read", () => {
  const ack = encode({ type: "ack", seq: 1 });
  assert.throws(() => decode(new Uint8Array([...ack, 0])), /trailing bytes/);
  assert.throws(() => decode(new Uint8Array([99])), /unknown message type/);
  // An update for a note whose id could never be one.
  assert.throws(() => decode(encode({ type: "update", seq: 1, id: "not-an-id!", update: bytes })), /bad note id/);
  // A purge claiming far more ids than there are bytes for.
  assert.throws(() => decode(new Uint8Array([5, 0xff, 0xff, 0x03])), /count past the end/);
});
