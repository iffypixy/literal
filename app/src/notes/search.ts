import type { Note } from "./notes.ts";

/** A piece of displayed text, and whether it matches the search. */
export type Segment = { text: string; hit: boolean };

/** Each note's text and title, folded for searching; a note that changes is a new object, so it's folded again. */
const folds = new WeakMap<Note, { text: string; title: string }>();

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
  const inTitle: Note[] = [];
  const inText: Note[] = [];
  for (const note of notes) {
    const { text, title } = folded(note);
    if (!words.every((word) => text.includes(word))) continue;
    (words.some((word) => title.includes(word)) ? inTitle : inText).push(note);
  }
  return [...inTitle, ...inText];
}

/** Folds every note ahead of time, in moments the page is idle, so the first search is as quick as the rest. */
export function prepare(notes: Note[]) {
  let next = 0;
  const work = (deadline?: IdleDeadline) => {
    do {
      const note = notes[next++];
      if (note) folded(note);
    } while (next < notes.length && (deadline ? deadline.timeRemaining() > 1 : next % 100 !== 0));
    if (next < notes.length) later(work);
  };
  if (notes.length) later(work);
}

/** Whether every one of `words` starts a word of `label`: "exp" and "all exp" both find "Export all notes". */
export function startsWords(label: string, words: string[]): boolean {
  const starts = fold(label).split(/\s+/);
  return words.every((word) => starts.some((start) => start.startsWith(word)));
}

/**
 * The note's title, split into hits and misses; and when searching, the text around a match the title doesn't show,
 * so every row says why it's there.
 */
export function describe(note: Note, words: string[]): { title: Segment[]; snippet: Segment[] } {
  const { first, restAt } = split(note.text);
  const { text, title } = folded(note);
  // Folding keeps positions for nearly all text, so a match found in the folded copy marks the same place.
  const hits = words
    .filter((word) => !title.includes(word))
    .map((word) => text.indexOf(word, restAt))
    .filter((at) => at >= 0);
  const snippet = hits.length ? around(note.text, Math.min(...hits), restAt) : "";
  return { title: mark(first, words), snippet: mark(snippet, words) };
}

/** The first line with anything on it. */
export function title(text: string): string {
  return split(text).first;
}

/** A note's title as a toast quotes it: short enough to fit on a phone. */
export function quoted(text: string): string {
  return shorten(title(text), 30);
}

/** A title cut to `length`: at the end of a word if one ends near enough, then "…". */
export function shorten(name: string, length: number): string {
  const chars = [...name];
  if (chars.length <= length) return name;
  const cut = chars.slice(0, length - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${space > length / 2 ? cut.slice(0, space) : cut}…`;
}

/** Splits `text` into the runs that hold one of `words` and the runs that don't. */
export function mark(text: string, words: string[]): Segment[] {
  return marked(text, words, () => true);
}

/** Like `mark`, but only where a word of `text` starts with one of `words`: the way commands match. */
export function markStarts(text: string, words: string[]): Segment[] {
  return marked(text, words, (folded, at) => at === 0 || /\s/.test(folded[at - 1] ?? ""));
}

/** The first non-blank line, and where the text after it starts. */
function split(text: string): { first: string; restAt: number } {
  const start = text.search(/\S/);
  if (start < 0) return { first: "", restAt: text.length };
  const end = text.indexOf("\n", start);
  if (end < 0) return { first: text.slice(start).trim(), restAt: text.length };
  return { first: text.slice(start, end).trim(), restAt: end + 1 };
}

/** How far back a snippet looks for a space to start at; past that, a long word or link is cut through instead. */
const SnippetReach = 20;

/** One line of text around `at`: a little before it, more after, cut at spaces near enough to keep the hit in view. */
function around(text: string, at: number, from: number): string {
  let start = Math.max(from, at - SnippetReach);
  let end = Math.min(text.length, at + 60);
  if (start > from) {
    const space = text.lastIndexOf(" ", start);
    if (space >= Math.max(from, start - SnippetReach)) start = space + 1;
  }
  if (end < text.length) end = Math.max(text.lastIndexOf(" ", end), at + 1);
  const line = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > from ? "…" : ""}${line}${end < text.length ? "…" : ""}`;
}

/** Lowercase, without accents: "Café" and "cafe" fold the same. */
function fold(text: string): string {
  // Plain ASCII has nothing to fold but case, and most notes are plain ASCII: the quick way, then.
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase();
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function folded(note: Note): { text: string; title: string } {
  let known = folds.get(note);
  if (!known) {
    known = { text: fold(note.text), title: fold(split(note.text).first) };
    folds.set(note, known);
  }
  return known;
}

function marked(text: string, words: string[], counts: (folded: string, at: number) => boolean): Segment[] {
  if (!words.length || !text) return [{ text, hit: false }];
  const { folded, origin } = foldWithOrigin(text);
  const hit = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + 1)) {
      if (counts(folded, at)) hit.fill(true, origin[at] ?? 0, origin[at + word.length] ?? text.length);
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

function later(work: (deadline?: IdleDeadline) => void) {
  if ("requestIdleCallback" in window) requestIdleCallback(work);
  else setTimeout(work, 50);
}
