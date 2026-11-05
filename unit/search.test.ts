import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note } from "#web/notes/notes.ts";
import { describe, markStarts, parse, search, shorten, startsWords, title } from "#web/notes/search.ts";

function note(id: string, text: string): Note {
  return { id, text, createdAt: 0, editedAt: 0, deletedAt: null };
}

test("search ignores case and accents, needs every word, and puts title matches first", () => {
  const notes = [note("a", "Groceries\ncafé au lait"), note("b", "Café list\nbeans"), note("c", "Café")];
  assert.deepEqual(
    search(notes, parse("CAFE")).map((found) => found.id),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    search(notes, parse("cafe beans")).map((found) => found.id),
    ["b"],
  );
});

test("a match the title doesn't show gets a snippet, with the hit marked", () => {
  const { title: shown, snippet } = describe(note("a", "Trip\nPack the passport and tickets"), parse("passport"));
  assert.deepEqual(shown, [{ text: "Trip", hit: false }]);
  assert.deepEqual(
    snippet.filter((part) => part.hit),
    [{ text: "passport", hit: true }],
  );
});

test("commands match by the starts of their words", () => {
  assert.ok(startsWords("Export all notes", parse("all exp")));
  assert.ok(!startsWords("Export all notes", parse("port")));
  assert.deepEqual(
    markStarts("New note", parse("no")).filter((part) => part.hit),
    [{ text: "no", hit: true }],
  );
});

test("a title is the first line with words, cut at a word with what shows as one character counted once", () => {
  assert.equal(title("\n\n  Hello  \nworld"), "Hello");
  assert.equal(shorten("one two three four", 12), "one two…");
  assert.equal(shorten("👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧", 3), "👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧");
});
