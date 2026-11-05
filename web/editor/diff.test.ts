import assert from "node:assert/strict";
import { test } from "node:test";
import { diff, shift } from "./diff.ts";

test("typing is found as the smallest change, wherever the caret says it is", () => {
  assert.deepEqual(diff("hello", "hello!", 6), { at: 5, removed: 0, inserted: "!" });
  assert.deepEqual(diff("hello", "help", 4), { at: 3, removed: 2, inserted: "p" });
  // A wrong caret only makes the search longer, never the answer wrong.
  assert.deepEqual(diff("aaaa", "aaaaa", 0), { at: 4, removed: 0, inserted: "a" });
  assert.equal(diff("same", "same", 2), null);
});

test("an emoji is never split in half", () => {
  // 😀 and 😃 share their first UTF-16 unit; 🙂 and 😃 share their second.
  assert.deepEqual(diff("a😀b", "a😃b", 3), { at: 1, removed: 2, inserted: "😃" });
  assert.deepEqual(diff("a🙂b", "a😃b", 3), { at: 1, removed: 2, inserted: "😃" });
  assert.deepEqual(diff("😀", "😀😀", 4), { at: 2, removed: 0, inserted: "😀" });
});

test("a position moves with text inserted or deleted before it, not after", () => {
  // "abc" becomes "aXbc": an insert before position 2 pushes it along.
  assert.equal(shift(2, [{ retain: 1 }, { insert: "X" }]), 3);
  // An insert right at a position goes after it.
  assert.equal(shift(1, [{ retain: 1 }, { insert: "X" }]), 1);
  // "abcd" becomes "ad": a position inside the deletion lands where it was.
  assert.equal(shift(2, [{ retain: 1 }, { delete: 2 }]), 1);
  assert.equal(shift(4, [{ retain: 1 }, { delete: 2 }]), 2);
});
