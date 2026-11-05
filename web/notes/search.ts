import type { Note } from "./notes.ts";

export type Segment = { text: string; hit: boolean };

/** Besides the notes found: how many commands come first, whether anything is typed, and the notes open before and now. */
type Start = { commands: number; typed: boolean; previous: string | null; current: string | null };

/** How far back a snippet looks for a space to start at; past that, a long word or link is cut through instead. */
const SnippetReach = 20;
const SnippetLength = 60;
/** Short enough for a toast on a phone. */
const QuoteLength = 30;

const Graphemes = new Intl.Segmenter();

/** A note that changes is a new object, so it's folded again. */
const folds = new WeakMap<Note, { text: string; title: string }>();

export function parse(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** Notes holding every one of `words`, ignoring case and accents. Title matches come first, the rest stay in order. */
export function search(notes: Note[], words: string[]): Note[] {
  if (!words.length) return notes;
  const inTitle: Note[] = [];
  const inText: Note[] = [];
  for (const note of notes) {
    const { text, title } = foldsOf(note);
    if (!words.every((word) => text.includes(word))) continue;
    (words.some((word) => title.includes(word)) ? inTitle : inText).push(note);
  }
  return [...inTitle, ...inText];
}

/** Folds every note while the page is idle, so the first search is as quick as the rest. */
export function prepare(notes: Note[]) {
  let next = 0;
  const work = (deadline?: IdleDeadline) => {
    do {
      const note = notes[next++];
      if (note) foldsOf(note);
      // Without idle callbacks, a hundred at a time.
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

/** Like `startsWords`, the label with what matched marked. */
export function markStarts(text: string, words: string[]): Segment[] {
  return marked(text, words, (folded, at) => at === 0 || /\s/.test(folded[at - 1] ?? ""));
}

/**
 * The row the palette's arrows start on, among `commands` found and then the notes `found`. With nothing typed, the
 * note open before this one (or the latest that isn't this one), so Enter goes back. Typing, the first note, or the
 * first command if no note matches, so Enter after "new" still opens a note about New York, and after "export" exports.
 */
export function startRow(found: Note[], { commands, typed, previous, current }: Start): number {
  if (typed) return found.length ? commands : 0;
  const back = found.findIndex((note) => note.id === previous);
  const latest = found.findIndex((note) => note.id !== current);
  return back >= 0 ? back : Math.max(0, latest);
}

/** The title with matches marked, and a snippet around a match it doesn't show, so every row says why it's there. */
export function describe(note: Note, words: string[]): { title: Segment[]; snippet: Segment[] } {
  const { first, restAt } = split(note.text);
  const { text, title } = foldsOf(note);
  // A word the title doesn't hold can only be found past it.
  const hits = words
    .filter((word) => !title.includes(word))
    .map((word) => text.indexOf(word))
    .filter((at) => at >= 0);
  const snippet = hits.length ? around(note.text, unfolded(note.text, text, Math.min(...hits)), restAt) : "";
  return { title: mark(first, words), snippet: mark(snippet, words) };
}

/** The first line with anything on it. */
export function title(text: string): string {
  return split(text).first;
}

/** The title, short and in quotes, like "Groceries"; or nothing, if the note has no words. */
export function quoted(text: string): string {
  const name = shorten(title(text), QuoteLength);
  return name && `"${name}"`;
}

/** Cut at the end of a word if one ends near enough, then "…". Counts what shows as one character, emoji too. */
export function shorten(name: string, length: number): string {
  const chars = Array.from(Graphemes.segment(name), (part) => part.segment);
  if (chars.length <= length) return name;
  const cut = chars.slice(0, length - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${space > length / 2 ? cut.slice(0, space) : cut}…`;
}

function split(text: string): { first: string; restAt: number } {
  const start = text.search(/\S/);
  if (start < 0) return { first: "", restAt: text.length };
  const end = text.indexOf("\n", start);
  if (end < 0) return { first: text.slice(start).trim(), restAt: text.length };
  return { first: text.slice(start, end).trim(), restAt: end + 1 };
}

/** A little before `at`, more after, cut at spaces near enough to keep the hit in view. */
function around(text: string, at: number, from: number): string {
  let start = Math.max(from, at - SnippetReach);
  let end = Math.min(text.length, at + SnippetLength);
  if (start > from) {
    const space = text.lastIndexOf(" ", start);
    if (space >= Math.max(from, start - SnippetReach)) start = space + 1;
  }
  if (end < text.length) {
    // Only a space past the hit, which holds none, so the hit stays whole.
    const space = text.lastIndexOf(" ", end);
    if (space > at) end = space;
  }
  const line = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > from ? "…" : ""}${line}${end < text.length ? "…" : ""}`;
}

/** "Café" and "cafe" fold the same. */
function fold(text: string): string {
  // Most notes are plain ASCII, with nothing to fold but case.
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase();
  // Composed again after the accents go, because Korean syllables come apart into letters that aren't accents.
  return text.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase();
}

function foldsOf(note: Note): { text: string; title: string } {
  let known = folds.get(note);
  if (!known) {
    known = { text: fold(note.text), title: fold(split(note.text).first) };
    folds.set(note, known);
  }
  return known;
}

function mark(text: string, words: string[]): Segment[] {
  return marked(text, words, () => true);
}

/** Nothing for no text, so an empty snippet shows nothing. */
function marked(text: string, words: string[], counts: (folded: string, at: number) => boolean): Segment[] {
  if (!text) return [];
  if (!words.length) return [{ text, hit: false }];
  const { folded, origin } = foldWithOrigin(text);
  const hit = Array.from({ length: text.length }, () => false);
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

/**
 * Where `at` in the folded copy of `text` is in `text` itself. Folding keeps positions unless an accent was a
 * character of its own, so only then is it worked out.
 */
function unfolded(text: string, folded: string, at: number): number {
  return folded.length === text.length ? at : (foldWithOrigin(text).origin[at] ?? at);
}

/** For each folded character, the index it came from (plus one past the end). */
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
