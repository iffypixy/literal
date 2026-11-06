import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note } from "#/web/notes.ts";
import { describe, markStarts, quoted, search, shorten, startRow, startsWords, wordsOf } from "#/web/search.ts";

// Last edited first, as the palette lists them.
const Recent = [note("a", "Now"), note("b", "Before"), note("c", "Older")];

function note(id: string, text: string): Note {
  return { id, text, createdAt: 0, editedAt: 0, deletedAt: null };
}

function idsOf(notes: Note[]): string[] {
  return notes.map((found) => found.id);
}

function hitsOf(parts: { text: string; hit: boolean }[]): string[] {
  return parts.filter((part) => part.hit).map((part) => part.text);
}

test("search ignores case and accents", () => {
  const notes = [note("a", "Café"), note("b", "Tea")];

  const found = search(notes, wordsOf("CAFE"));

  assert.deepEqual(idsOf(found), ["a"]);
});

test("search finds only notes holding every word", () => {
  const notes = [note("a", "Coffee beans"), note("b", "Coffee cups")];

  const found = search(notes, wordsOf("coffee beans"));

  assert.deepEqual(idsOf(found), ["a"]);
});

test("search puts title matches first, and keeps each group in order", () => {
  const notes = [note("a", "Groceries\ncafé au lait"), note("b", "Café list\nbeans"), note("c", "Café")];

  const found = search(notes, wordsOf("cafe"));

  assert.deepEqual(idsOf(found), ["b", "c", "a"]);
});

test("a match the title doesn't show gets a snippet, with the hit marked, accents and all", () => {
  // Decomposed, so each accent is a character of its own, which folding takes out and the mark has to put back.
  const text = "Trip\nPack the crème brûlée".normalize("NFD");

  const { title, snippet } = describe(note("a", text), wordsOf("brulee"));

  assert.deepEqual(title, [{ text: "Trip", hit: false }]);
  assert.deepEqual(hitsOf(snippet), ["brûlée".normalize("NFD")]);
});

test("a snippet far into a note with accents keeps its hit whole", () => {
  const text = "Trip\n" + "résumé ".normalize("NFD").repeat(200) + "target";

  const { snippet } = describe(note("a", text), wordsOf("target"));

  assert.deepEqual(hitsOf(snippet), ["target"]);
});

test("a snippet inside a long link keeps its hit whole", () => {
  const text = `Links\nsee https://example.com/${"a".repeat(80)}`;

  const { snippet } = describe(note("a", text), wordsOf("example"));

  assert.deepEqual(hitsOf(snippet), ["example"]);
});

test("a hit in Korean written in letters is marked", () => {
  const text = "Trip\n회의 메모".normalize("NFD");

  const { snippet } = describe(note("a", text), wordsOf("회의"));

  assert.deepEqual(hitsOf(snippet), ["회의".normalize("NFD")]);
});

test("a snippet far into Korean written in letters holds its hit", () => {
  const text = `Trip\n${"회의 ".repeat(40)}target`.normalize("NFD");

  const { snippet } = describe(note("a", text), wordsOf("target"));

  assert.deepEqual(hitsOf(snippet), ["target"]);
});

test("a final sigma is found and marked as any other", () => {
  const text = "Trip\nΟΔΥΣΣΕΥΣ came home";

  const { snippet } = describe(note("a", text), wordsOf("Οδυσσευς"));

  assert.deepEqual(hitsOf(snippet), ["ΟΔΥΣΣΕΥΣ"]);
});

test("a snippet cut far into a note starts on a whole emoji", () => {
  const text = `Party\n${"🎉".repeat(30)}xtarget`;

  const { snippet } = describe(note("a", text), wordsOf("target"));

  assert.equal(snippet[0]?.text.slice(0, 3), "…🎉");
});

test("a command is found by the starts of its words, in any order", () => {
  assert.equal(startsWords("Export all notes", wordsOf("all exp")), true);
});

test("a command isn't found by the middle of a word", () => {
  assert.equal(startsWords("Export all notes", wordsOf("port")), false);
});

test("only the starts of a command's words are marked", () => {
  const parts = markStarts("Sign out", wordsOf("si"));

  assert.deepEqual(parts, [
    { text: "Si", hit: true },
    { text: "gn out", hit: false },
  ]);
});

test("a note is named by its first line with words, in quotes", () => {
  assert.equal(quoted("\n  Groceries \neggs"), '"Groceries"');
});

test("a note with no words has no name", () => {
  assert.equal(quoted(" \n\t"), null);
});

test("a name is shortened at a space past its middle, counting emoji as one character each", () => {
  assert.equal(shorten("🎉🎉🎉🎉 abcdef", 8), "🎉🎉🎉🎉 ab…");
});

test("with nothing typed, the palette starts on the note open before this one", () => {
  const row = startRow(Recent, { commands: 0, typed: false, previous: "c", current: "a" });

  assert.equal(row, 2);
});

test("with nothing typed and the note before gone, the palette starts on the latest other note", () => {
  const row = startRow(Recent.slice(0, 2), { commands: 0, typed: false, previous: "c", current: "a" });

  assert.equal(row, 1);
});

test("typing starts the palette on the first note found, past the commands", () => {
  const row = startRow(Recent, { commands: 2, typed: true, previous: "c", current: "a" });

  assert.equal(row, 2);
});

test("typing what no note holds starts the palette on the first command", () => {
  const row = startRow([], { commands: 2, typed: true, previous: "c", current: "a" });

  assert.equal(row, 0);
});
