import type { Note } from "./notes.svelte.ts";

/** A piece of displayed text, and whether it matches the search. */
export type Segment = { text: string; hit: boolean };

const folds = new WeakMap<Note, string>();

/** The words of a query, folded. */
export function parse(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/**
 * The notes holding every one of `words`, in any order, ignoring case and accents.
 * Notes whose title matches come first; otherwise the order stays (last edited first).
 */
export function search(notes: Note[], words: string[]): Note[] {
  if (!words.length) return notes;
  const matches = notes.filter((note) => words.every((word) => folded(note).includes(word)));
  const inTitle = (note: Note) => {
    const title = fold(split(note.text).first);
    return words.some((word) => title.includes(word));
  };
  return [...matches.filter(inTitle), ...matches.filter((note) => !inTitle(note))];
}

/**
 * The note's title, split into hits and misses; and when searching, the text around a match the title doesn't show,
 * so every row says why it's there.
 */
export function describe(note: Note, words: string[]): { title: Segment[]; snippet: Segment[] } {
  const { first, restAt } = split(note.text);
  const inTitle = fold(first);
  // Folding keeps positions for nearly all text, so a match found in the folded copy marks the same place.
  const hits = words
    .filter((word) => !inTitle.includes(word))
    .map((word) => folded(note).indexOf(word, restAt))
    .filter((at) => at >= 0);
  const snippet = hits.length ? around(note.text, Math.min(...hits), restAt) : "";
  return { title: mark(first, words), snippet: mark(snippet, words) };
}

/** The first line with anything on it. */
export function title(text: string): string {
  return split(text).first;
}

/** A title cut to `length`: at the end of a word if one ends near enough, then "…". */
export function shorten(name: string, length: number): string {
  const chars = [...name];
  if (chars.length <= length) return name;
  const cut = chars.slice(0, length - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${space > length / 2 ? cut.slice(0, space) : cut}…`;
}

/** The first non-blank line, and where the text after it starts. */
function split(text: string): { first: string; restAt: number } {
  const start = text.search(/\S/);
  if (start < 0) return { first: "", restAt: text.length };
  const end = text.indexOf("\n", start);
  if (end < 0) return { first: text.slice(start).trim(), restAt: text.length };
  return { first: text.slice(start, end).trim(), restAt: end + 1 };
}

/** One line of text around `at`: a little before it, more after, cut at spaces. */
function around(text: string, at: number, from: number): string {
  let start = Math.max(from, at - 20);
  let end = Math.min(text.length, at + 60);
  if (start > from) start = text.lastIndexOf(" ", start) + 1 || start;
  if (end < text.length) end = Math.max(text.lastIndexOf(" ", end), at + 1);
  const line = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > from ? "…" : ""}${line}${end < text.length ? "…" : ""}`;
}

/** Lowercase, without accents: "Café" and "cafe" fold the same. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function folded(note: Note): string {
  let text = folds.get(note);
  if (text === undefined) {
    text = fold(note.text);
    folds.set(note, text);
  }
  return text;
}

/** Splits `text` into the runs that match one of `words` and the runs that don't. */
function mark(text: string, words: string[]): Segment[] {
  if (!words.length || !text) return [{ text, hit: false }];
  const { folded, origin } = foldWithOrigin(text);
  const hit = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + 1)) {
      hit.fill(true, origin[at] ?? 0, origin[at + word.length] ?? text.length);
    }
  }
  const segments: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = segments.at(-1);
    if (last && last.hit === hit[i]) last.text += text[i];
    else segments.push({ text: text[i] ?? "", hit: hit[i] ?? false });
  }
  return segments;
}

/** The folded text, and for each of its characters the index it came from (plus one past the end). */
function foldWithOrigin(text: string): { folded: string; origin: number[] } {
  let folded = "";
  const origin: number[] = [];
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i) ?? 0);
    const part = fold(char);
    for (let j = 0; j < part.length; j++) origin.push(i);
    folded += part;
    i += char.length;
  }
  origin.push(text.length);
  return { folded, origin };
}
