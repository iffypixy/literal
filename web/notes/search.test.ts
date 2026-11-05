import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note } from "./notes.ts";
import { describe, parse, search } from "./search.ts";

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

test("a match the title doesn't show gets a snippet, with the hit marked, accents and all", () => {
  // Decomposed, so each accent is a character of its own, which folding takes out and the mark has to put back.
  const text = "Trip\nPack the crème brûlée".normalize("NFD");
  const { title, snippet } = describe(note("a", text), parse("brulee"));
  assert.deepEqual(title, [{ text: "Trip", hit: false }]);
  assert.deepEqual(
    snippet.filter((part) => part.hit),
    [{ text: "brûlée".normalize("NFD"), hit: true }],
  );
});

test("a snippet keeps its hit whole, far into a note and inside a long link", () => {
  const hit = (text: string, query: string) =>
    describe(note("a", text), parse(query))
      .snippet.filter((part) => part.hit)
      .map((part) => part.text);
  const accents = "Trip\n" + "résumé ".normalize("NFD").repeat(200) + "target";
  assert.deepEqual(hit(accents, "target"), ["target"]);
  const link = `Links\nsee https://example.com/${"a".repeat(80)}`;
  assert.deepEqual(hit(link, "example"), ["example"]);
});
