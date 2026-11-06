import assert from "node:assert/strict";
import { test } from "node:test";
import { createFileNamer } from "#/web/lib/file-names.ts";

test("a title loses what a file name can't hold", () => {
  const nameOf = createFileNamer();

  const name = nameOf('To do: a/b\t"c"?');

  assert.equal(name, "To do ab c.txt");
});

test("titles alike but for case are numbered", () => {
  const nameOf = createFileNamer();

  const names = [nameOf("Notes"), nameOf("notes"), nameOf("NOTES")];

  assert.deepEqual(names, ["Notes.txt", "notes (2).txt", "NOTES (3).txt"]);
});

test("titles alike but for how an accent is written are numbered", () => {
  const nameOf = createFileNamer();

  const names = [nameOf("café"), nameOf("café".normalize("NFD"))];

  assert.deepEqual(names, ["café.txt", "café (2).txt"]);
});

test("a name Windows keeps for a device gets an underscore", () => {
  const nameOf = createFileNamer();

  const names = [nameOf("con"), nameOf("NUL.backup")];

  assert.deepEqual(names, ["con_.txt", "NUL_.backup.txt"]);
});

test("a title starting with a dot doesn't hide its file", () => {
  const nameOf = createFileNamer();

  const name = nameOf(".hidden");

  assert.equal(name, "hidden.txt");
});

test("a title with nothing a file name can hold is Untitled", () => {
  const nameOf = createFileNamer();

  const names = [nameOf(""), nameOf("???")];

  assert.deepEqual(names, ["Untitled.txt", "Untitled (2).txt"]);
});
