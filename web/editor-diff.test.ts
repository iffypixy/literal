import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { diff, end, landingOf, type Change } from "#/web/editor-diff.ts";

function apply(text: string, change: Change | null): string {
  if (!change) return text;
  return text.slice(0, change.at) + change.inserted + text.slice(change.at + change.removed);
}

test("a change turns the text before into the text after, wherever the caret is", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), fc.nat(), (before, after, caret) => {
      assert.equal(apply(before, diff(before, after, caret)), after);
    }),
  );
});

test("a change never splits an emoji in half", () => {
  const text = fc.string({ unit: "grapheme" });

  fc.assert(
    fc.property(text, text, fc.nat(), (before, after, caret) => {
      fc.pre(before !== after);

      const change = diff(before, after, caret);

      assert.ok(change);
      // With the u flag, \p{Cs} matches only a surrogate left without its other half.
      assert.doesNotMatch(change.inserted, /\p{Cs}/u);
      assert.doesNotMatch(before.slice(change.at, change.at + change.removed), /\p{Cs}/u);
    }),
  );
});

test("typing is found as the smallest change", () => {
  assert.deepEqual(diff("hello", "hello!", 6), { at: 5, removed: 0, inserted: "!" });
  assert.deepEqual(diff("hello", "help", 4), { at: 3, removed: 2, inserted: "p" });
});

test("the same text has no change", () => {
  assert.equal(diff("same", "same", 2), null);
});

test("among repeated characters, what's typed goes where the caret says", () => {
  // Enter on the empty line of "a", "", "b".
  assert.deepEqual(diff("a\n\nb", "a\n\n\nb", 3), { at: 2, removed: 0, inserted: "\n" });
});

test("among repeated characters, a forward delete takes the one at the caret", () => {
  assert.deepEqual(diff("a\n\n\nb", "a\n\nb", 1), { at: 1, removed: 1, inserted: "" });
});

test("an emoji changed for another that shares half of it is replaced whole", () => {
  // 😀 and 😃 share their first UTF-16 unit; 🙂 and 😃 share their second.
  assert.deepEqual(diff("a😀b", "a😃b", 3), { at: 1, removed: 2, inserted: "😃" });
  assert.deepEqual(diff("a🙂b", "a😃b", 3), { at: 1, removed: 2, inserted: "😃" });
});

test("a position moves with text inserted before it", () => {
  // "abc" became "aXbc".
  assert.equal(landingOf(2, [[{ retain: 1 }, { insert: "X" }]]), 3);
});

test("a position stays put for text inserted right at it", () => {
  assert.equal(landingOf(1, [[{ retain: 1 }, { insert: "X" }]]), 1);
});

test("a position inside deleted text lands where the deletion was", () => {
  // "abcd" became "ad".
  assert.equal(landingOf(2, [[{ retain: 1 }, { delete: 2 }]]), 1);
});

test("a position after deleted text moves back by it", () => {
  assert.equal(landingOf(4, [[{ retain: 1 }, { delete: 2 }]]), 2);
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
