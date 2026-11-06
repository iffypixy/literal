import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import * as Y from "yjs";
import { decode, encode, isDocDeleted, lastEdited, markEdited, type Message } from "#/protocol.ts";

// Plain objects, as decode makes them, since fast-check's may have no prototype.
const record = <T>(model: { [K in keyof T]: fc.Arbitrary<T[K]> }) => fc.record(model, { noNullPrototype: true });
const id = fc.stringMatching(/^[0-9a-hjkmnp-tv-z]{10}$/);
const bytes = fc.option(fc.uint8Array({ minLength: 1 }), { nil: null });
const message: fc.Arbitrary<Message> = fc.oneof(
  record({
    kind: fc.constant("hello"),
    since: fc.nat(),
    notes: fc.array(record({ id, vector: fc.uint8Array(), dirty: fc.boolean() })),
  }),
  record({
    kind: fc.constant("catchUp"),
    done: fc.boolean(),
    now: fc.nat(),
    notes: fc.array(record({ id, update: bytes, vector: bytes })),
  }),
  record({ kind: fc.constant("update"), seq: fc.nat(), id, update: fc.uint8Array() }),
  record({ kind: fc.constant("ack"), seq: fc.nat() }),
  record({ kind: fc.constant("refused"), seq: fc.nat(), reason: fc.constantFrom("tooLarge", "tooMany", "tooFull") }),
  record({ kind: fc.constant("purge"), ids: fc.array(id) }),
);

test("every message decodes to what was encoded", () => {
  fc.assert(fc.property(message, (sent) => assert.deepEqual(decode(encode(sent)), sent)));
});

test("a message with bytes past its end is refused", () => {
  const ack = encode({ kind: "ack", seq: 1 });

  assert.throws(() => decode(new Uint8Array([...ack, 0])), /trailing bytes/);
});

test("a message of an unknown kind is refused", () => {
  assert.throws(() => decode(new Uint8Array([99])), /unknown message kind/);
});

test("an update for an id no note could have is refused", () => {
  const update = encode({ kind: "update", seq: 1, id: "not-an-id!", update: new Uint8Array([1]) });

  assert.throws(() => decode(update), /bad note id/);
});

test("a list longer than the bytes left is refused before it's read", () => {
  // A purge claiming 65,535 ids.
  const purge = new Uint8Array([5, 0xff, 0xff, 0x03]);

  assert.throws(() => decode(purge), /count past the end/);
});

test("an edit made after a delete brings the note back, whichever device Yjs favors", () => {
  const clientIds = fc.tuple(fc.nat(), fc.nat()).filter(([a, b]) => a !== b);

  fc.assert(
    fc.property(clientIds, ([idA, idB]) => {
      const a = new Y.Doc();
      const b = new Y.Doc();
      a.clientID = idA;
      b.clientID = idB;

      // Both offline. A edits, then deletes, and B edits later.
      markEdited(a, 1);
      a.getMap<number>("meta").set("deletedAt", 2);
      markEdited(b, 3);
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

      assert.equal(lastEdited(a), 3);
      assert.equal(lastEdited(b), 3);
      assert.equal(isDocDeleted(a), false);
      assert.equal(isDocDeleted(b), false);
    }),
  );
});
