import assert from "node:assert/strict";
import { test } from "node:test";
import { diff, end, landingOf, shift } from "./diff.ts";

test("typing is found as the smallest change", () => {
  assert.deepEqual(diff("hello", "hello!", 6), { at: 5, removed: 0, inserted: "!" });
  assert.deepEqual(diff("hello", "help", 4), { at: 3, removed: 2, inserted: "p" });
  assert.equal(diff("same", "same", 2), null);
});

test("a caret that's off only makes the search longer, never the answer wrong", () => {
  assert.deepEqual(diff("hello", "help", 0), { at: 3, removed: 2, inserted: "p" });
});

test("among repeated characters, what's typed goes where the caret says", () => {
  // Enter on the empty line of "a", "", "b".
  assert.deepEqual(diff("a\n\nb", "a\n\n\nb", 3), { at: 2, removed: 0, inserted: "\n" });
});

test("among repeated characters, a forward delete takes the one at the caret", () => {
  assert.deepEqual(diff("a\n\n\nb", "a\n\nb", 1), { at: 1, removed: 1, inserted: "" });
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

test("the last change ends where an undo puts the caret", () => {
  assert.equal(end([{ retain: 2 }, { insert: "ab" }]), 4);
  assert.equal(end([{ retain: 1 }, { delete: 2 }]), 1);
  assert.equal(end([{ insert: "x" }, { retain: 3 }, { delete: 1 }]), 4);
});

test("a position past a textarea's own change lands past the changes it hasn't shown yet", () => {
  // "abcdef" became "abcdZef" in the text, and "abcXXYdef" in the textarea.
  const held = [[{ retain: 4 }, { insert: "Z" }]];
  const change = { at: 3, removed: 0, inserted: "XXY" };

  const caret = landingOf(6, held, change);
  const beforeF = landingOf(8, held, change);

  // "abcXXY|dZef" and "abcXXYdZe|f".
  assert.equal(caret, 6);
  assert.equal(beforeF, 9);
});

test("a position inside a textarea's own change keeps its place in it", () => {
  // "abcdef" became "aZbcdef" in the text, and "abcXXYdef" in the textarea.
  const held = [[{ retain: 1 }, { insert: "Z" }]];
  const change = { at: 3, removed: 0, inserted: "XXY" };

  const inside = landingOf(4, held, change);

  // "aZbcX|XYdef".
  assert.equal(inside, 5);
});
