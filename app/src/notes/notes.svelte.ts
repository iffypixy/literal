import * as Y from "yjs";
import { deleteDb, get, openDb, readAll, write } from "./db.ts";

/** What the list and search know about a note. The note itself is a Yjs doc: its `text`, and its `meta` (the times). */
export type Note = {
  id: string;
  text: string;
  createdAt: number;
  editedAt: number;
  /** When it was deleted. An edit made after that brings the note back, so no device ever loses words. */
  deletedAt: number | null;
};

/**
 * A note's Yjs state as stored. `writer:rev` says which tab wrote it last, so that tab can tell nobody wrote since.
 * `dirty` says it has changes the server hasn't acked.
 */
type Stored = { state: Uint8Array; writer: string; rev: number; dirty: boolean };

/** A note's row in the list store: the note, plus what sync needs to say hello without loading every doc. */
type Row = Note & { vector: Uint8Array; dirty: boolean };

type Message =
  | { type: "update"; id: string; update: Uint8Array }
  | { type: "note"; row: Row }
  | { type: "purge"; id: string }
  | { type: "wipe" };

/** Origins of changes that arrive from outside this tab. Anything else is typed here. */
const DISK = "disk";
const TAB = "tab";
const REMOTE = "remote";

/** Where unsaved changes wait out a page closing, by note id: localStorage writes at once, IndexedDB may not finish. */
const RESCUE = "literal:unsaved:";

const SAVE_DELAY = 250;
/** However fast you keep typing, a change is on disk within this long. */
const SAVE_AT_MOST = 1000;
/** Notes read from disk at a time when the app starts. */
const READ_BATCH = 500;
/** How often typing moves a note's `editedAt`: often enough to sort, rarely enough to stay out of the doc. */
const TOUCH_EVERY = 1000;
const TAB_ID = crypto.randomUUID();

/** `synced`: this device has caught up with its account at least once, so its list is the whole list. */
export const notes = $state({ version: 0, ready: false, failed: false, synced: false });

/** Every note on this device by id. Not reactive: `notes.version` ticks when it changes. */
const all = new Map<string, Note>();
/** For each note, its state vector and dirty flag as last saved. */
const marks = new Map<string, { vector: Uint8Array; dirty: boolean }>();
const loading = new Map<string, Promise<Y.Doc | null>>();
const loaded = new Map<string, Y.Doc>();
/** For each loaded note, the stored state it already holds (`writer:rev`). */
const seen = new Map<string, string>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** When each pending note first changed since its last save. */
const waitingSince = new Map<string, number>();
/** Notes whose save is on its way to disk: until it lands, a closing page must rescue them too. */
const saving = new Set<string>();
/** The live notes, last edited first, until a note changes. */
let sorted: Note[] | null = null;
const touched = new Map<string, number>();
/** Notes changed here since their last save. */
const changed = new Set<string>();
/** For each note, how many changes were made here: an ack only cleans the note if none came after what it covers. */
const edits = new Map<string, number>();
const listeners = new Set<(id: string, update: Uint8Array) => void>();

/** Signed in, deleted notes stay as tombstones so other devices learn of the delete; signed out, they're erased. */
let signedIn = false;

const db = openDb();
const channel = new BroadcastChannel("literal");

channel.onmessage = ({ data }: MessageEvent<Message>) => {
  if (data.type === "update") {
    const doc = loaded.get(data.id);
    if (doc) Y.applyUpdate(doc, data.update, TAB);
  } else if (data.type === "note") {
    keep(data.row);
    notes.version++;
  } else if (data.type === "purge") {
    all.delete(data.id);
    marks.delete(data.id);
    sorted = null;
    notes.version++;
  } else {
    void db.then((database) => database.close());
    location.replace("/");
  }
};

export function setSignedIn(value: boolean) {
  signedIn = value;
}

/** Reads every note's summary, and puts back changes a closing page left unsaved. Signed out, it also clears out deleted and empty notes. */
export async function start() {
  try {
    for await (const rows of readAll<Row>(await db, "notes", READ_BATCH)) {
      for (const row of rows) {
        if (!signedIn && (isDeleted(row) || !isWritten(row))) void purge(row.id);
        else keep(row);
      }
    }
    for (const id of rescuedIds()) await load(id);
    notes.synced = Boolean(await get<number>(await db, "meta", "since"));
  } catch (error) {
    notes.failed = true;
    console.error(error);
  }
  notes.ready = true;
  notes.version++;
}

/** Live notes, last edited first. The same array until a note changes: don't modify it. */
export function list(): Note[] {
  // Notes still waiting to be saved are newer in memory than in the list.
  for (const id of pending.keys()) {
    const doc = loaded.get(id);
    if (!doc) continue;
    const note = summarize(id, doc);
    const known = all.get(id);
    if (known?.text === note.text && known.editedAt === note.editedAt && known.deletedAt === note.deletedAt) continue;
    all.set(id, note);
    sorted = null;
  }
  sorted ??= [...all.values()].filter(isLive).sort((a, b) => b.editedAt - a.editedAt);
  return sorted;
}

/** How many live notes there are: what `list().length` says, without sorting them all. */
export function count(): number {
  let live = 0;
  for (const note of all.values()) if (isLive(note)) live++;
  return live;
}

export function find(id: string): Note | undefined {
  return all.get(id);
}

export function isDeleted(note: Note): boolean {
  return note.deletedAt !== null && note.deletedAt >= note.editedAt;
}

function isLive(note: Note): boolean {
  return !isDeleted(note) && isWritten(note);
}

/** Whether there's anything in it but whitespace. Stops at the first character that isn't. */
function isWritten(note: Note): boolean {
  return /\S/.test(note.text);
}

/** A new, empty note, in memory until its first save. */
export function create(at = Date.now()): { id: string; text: Y.Text } {
  const id = newId();
  const doc = adopt(id, new Y.Doc());
  doc.transact(() => {
    const meta = doc.getMap<number>("meta");
    meta.set("createdAt", at);
    meta.set("editedAt", at);
  });
  // Counts as the first touch, so an import keeps the file's own time.
  touched.set(id, Date.now());
  return { id, text: doc.getText("text") };
}

/** Adds a whole note at once, as an import does. */
export function add(text: string, at: number) {
  const note = create(at);
  note.text.insert(0, text);
  void save(note.id);
}

/** The note's text, loading it from disk if needed; null if there's no such note here. */
export async function open(id: string): Promise<Y.Text | null> {
  const doc = await load(id);
  if (!doc || isDeleted(summarize(id, doc))) return null;
  return doc.getText("text");
}

export async function remove(id: string) {
  const doc = await load(id);
  if (!doc) return;
  doc.getMap<number>("meta").set("deletedAt", Date.now());
  refresh(id, doc);
}

export function restore(id: string) {
  const doc = loaded.get(id);
  if (!doc) return;
  doc.getMap<number>("meta").delete("deletedAt");
  refresh(id, doc);
}

/** After a delete's Undo has passed: signed out, the note is erased; signed in, its tombstone stays. */
export function settle(id: string) {
  const note = all.get(id);
  if (!signedIn && note && isDeleted(note)) void purge(id);
}

/** Leaving a note that holds nothing but whitespace deletes it. */
export function discardIfEmpty(id: string) {
  const doc = loaded.get(id);
  if (!doc || doc.getText("text").toString().trim()) return;
  if (signedIn) void remove(id);
  else void purge(id);
}

/** Erases a note from this device for good. */
export async function purge(id: string) {
  clearTimeout(pending.get(id));
  pending.delete(id);
  waitingSince.delete(id);
  all.delete(id);
  sorted = null;
  marks.delete(id);
  loaded.get(id)?.destroy();
  loaded.delete(id);
  loading.delete(id);
  seen.delete(id);
  touched.delete(id);
  changed.delete(id);
  edits.delete(id);
  notes.version++;
  channel.postMessage({ type: "purge", id } satisfies Message);
  await write(await db, (tx) => {
    tx.objectStore("docs").delete(id);
    tx.objectStore("notes").delete(id);
  });
}

/** Saves every change still waiting, as the page goes away or before a sync checkpoint. */
export async function flush() {
  await Promise.all([...pending.keys()].map((id) => save(id)));
}

/** As the page goes away: keeps every unsaved change somewhere that's written at once, until the next start. */
export function rescue() {
  for (const id of new Set([...pending.keys(), ...saving])) {
    const doc = loaded.get(id);
    if (!doc) continue;
    try {
      localStorage.setItem(RESCUE + id, toBase64(Y.encodeStateAsUpdate(doc)));
    } catch (error) {
      // Full or blocked storage: the IndexedDB save started alongside is all there is.
      console.error(error);
    }
  }
}

/** Erases every note on this device, in every tab, and starts over: after signing out or deleting the account. */
export async function wipe() {
  channel.postMessage({ type: "wipe" } satisfies Message);
  (await db).close();
  await deleteDb();
}

// Sync. These are what sync.svelte.ts uses; nothing else should.

/** Calls `listener` with every change made on this device, as a Yjs update. */
export function onLocal(listener: (id: string, update: Uint8Array) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the sync hello needs: when this device last caught up, and every note's state vector and dirty flag. */
export async function hello(): Promise<{ since: number; notes: { id: string; vector: Uint8Array; dirty: boolean }[] }> {
  await flush();
  const since = (await get<number>(await db, "meta", "since")) ?? 0;
  return { since, notes: [...marks].map(([id, mark]) => ({ id, ...mark })) };
}

/**
 * Applies a change from the server, creating the note if it's new here. Words arriving for a note deleted
 * here were written by someone who hadn't seen the delete: the note comes back, with them.
 */
export async function receive(id: string, update: Uint8Array) {
  const doc = (await load(id)) ?? loaded.get(id) ?? adopt(id, new Y.Doc());
  const wasDeleted = all.has(id) && isDeleted(summarize(id, doc));
  let wrote = false;
  const text = doc.getText("text");
  const watch = () => (wrote = true);
  text.observe(watch);
  Y.applyUpdate(doc, update, REMOTE);
  text.unobserve(watch);
  if (wasDeleted && wrote && isDeleted(summarize(id, doc))) restore(id);
}

/** What this device has that the server, at `vector`, doesn't, with every deletion; all of it, without one. */
export async function missing(id: string, vector?: Uint8Array): Promise<Uint8Array | null> {
  const doc = await load(id);
  return doc ? Y.encodeStateAsUpdate(doc, vector) : null;
}

/** Marks this device caught up to `now`, once everything that came with it is on disk. */
export async function caughtUp(now: number) {
  await flush();
  await write(await db, (tx) => tx.objectStore("meta").put(now, "since"));
  notes.synced = true;
}

/** How many changes this device has made to the note so far. */
export function generation(id: string): number {
  return edits.get(id) ?? 0;
}

/** The server stored the note's changes up to `upTo`: if nothing was typed since, it's clean. */
export async function acked(id: string, upTo: number) {
  if (generation(id) !== upTo || changed.has(id)) return;
  await write(await db, (tx) => {
    const docs = tx.objectStore("docs");
    const rows = tx.objectStore("notes");
    const stored = docs.get(id);
    stored.onsuccess = () => {
      if (stored.result) docs.put({ ...(stored.result as Stored), dirty: false }, id);
    };
    const row = rows.get(id);
    row.onsuccess = () => {
      if (row.result) rows.put({ ...(row.result as Row), dirty: false });
    };
  });
  const mark = marks.get(id);
  if (mark) mark.dirty = false;
}

/** How many notes have changes the server hasn't acked. */
export function unsynced(): number {
  return (
    [...marks.values()].filter((mark) => mark.dirty).length + [...changed].filter((id) => !marks.get(id)?.dirty).length
  );
}

function load(id: string): Promise<Y.Doc | null> {
  let doc = loading.get(id);
  if (!doc) {
    doc = read(id);
    loading.set(id, doc);
  }
  return doc;
}

/** Loads the note from disk, with any changes a closing page left unsaved. */
async function read(id: string): Promise<Y.Doc | null> {
  const stored = await get<Stored>(await db, "docs", id);
  const unsaved = rescued(id);
  if (!stored && !unsaved) {
    loading.delete(id);
    return null;
  }
  // Another call may have made the note meanwhile.
  const existing = loaded.get(id);
  if (existing) return existing;
  const doc = new Y.Doc();
  if (stored) {
    Y.applyUpdate(doc, stored.state, DISK);
    seen.set(id, `${stored.writer}:${stored.rev}`);
  }
  adopt(id, doc);
  if (unsaved) {
    // As typed here: saved, and synced.
    Y.applyUpdate(doc, unsaved);
    // Nothing new means the save had finished after all; only a save clears the copy, and it runs on changes.
    if (!pending.has(id)) unrescue(id);
  }
  return doc;
}

function adopt(id: string, doc: Y.Doc): Y.Doc {
  loaded.set(id, doc);
  loading.set(id, Promise.resolve(doc));
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === DISK || origin === TAB) return;
    channel.postMessage({ type: "update", id, update } satisfies Message);
    if (origin !== REMOTE) {
      changed.add(id);
      edits.set(id, generation(id) + 1);
      for (const listener of listeners) listener(id, update);
    }
    // A pause in typing saves; so does a second of typing without one.
    const now = Date.now();
    const since = waitingSince.get(id) ?? now;
    waitingSince.set(id, since);
    clearTimeout(pending.get(id));
    pending.set(
      id,
      setTimeout(() => void save(id), Math.min(SAVE_DELAY, since + SAVE_AT_MOST - now)),
    );
  });
  doc.getText("text").observe((_, transaction) => {
    if (transaction.local) touch(id, doc);
  });
  return doc;
}

function touch(id: string, doc: Y.Doc) {
  const now = Date.now();
  if (now - (touched.get(id) ?? 0) < TOUCH_EVERY) return;
  touched.set(id, now);
  // Yjs runs observers inside the transaction; a change made from one belongs in its own.
  queueMicrotask(() => doc.getMap<number>("meta").set("editedAt", now));
}

/** Writes the note to disk, first merging in whatever another tab wrote there since this one last looked. */
async function save(id: string) {
  clearTimeout(pending.get(id));
  pending.delete(id);
  waitingSince.delete(id);
  const doc = loaded.get(id);
  if (!doc) return;
  const local = changed.has(id);
  changed.delete(id);
  let row: Row | undefined;
  saving.add(id);
  try {
    await write(await db, (tx) => {
      const docs = tx.objectStore("docs");
      const request = docs.get(id);
      request.onsuccess = () => {
        const stored = request.result as Stored | undefined;
        if (stored && seen.get(id) !== `${stored.writer}:${stored.rev}`) Y.applyUpdate(doc, stored.state, DISK);
        const rev = (stored?.rev ?? 0) + 1;
        const dirty = local || (stored?.dirty ?? false);
        docs.put({ state: Y.encodeStateAsUpdate(doc), writer: TAB_ID, rev, dirty } satisfies Stored, id);
        seen.set(id, `${TAB_ID}:${rev}`);
        row = { ...summarize(id, doc), vector: Y.encodeStateVector(doc), dirty };
        tx.objectStore("notes").put(row);
      };
    });
  } catch (error) {
    if (local) changed.add(id);
    notes.failed = true;
    console.error(error);
    return;
  } finally {
    saving.delete(id);
  }
  if (!row || !loaded.has(id)) return;
  unrescue(id);
  // The note may have changed while the write was on its way (a sync, an undo): describe it as it is now.
  const fresh: Row = { ...summarize(id, doc), vector: row.vector, dirty: row.dirty };
  keep(fresh);
  notes.version++;
  channel.postMessage({ type: "note", row: fresh } satisfies Message);
}

/** Notes with changes left by a page that closed before saving them. */
function rescuedIds(): string[] {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(RESCUE))
      .map((key) => key.slice(RESCUE.length));
  } catch {
    return [];
  }
}

function rescued(id: string): Uint8Array | null {
  try {
    const text = localStorage.getItem(RESCUE + id);
    return text ? fromBase64(text) : null;
  } catch {
    return null;
  }
}

function unrescue(id: string) {
  try {
    localStorage.removeItem(RESCUE + id);
  } catch {
    // Nothing was rescued where there's no storage.
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // In slices: spreading a whole large array into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function keep({ vector, dirty, ...note }: Row) {
  all.set(note.id, note);
  marks.set(note.id, { vector, dirty });
  sorted = null;
}

function refresh(id: string, doc: Y.Doc) {
  all.set(id, summarize(id, doc));
  sorted = null;
  notes.version++;
}

function summarize(id: string, doc: Y.Doc): Note {
  const meta = doc.getMap<number>("meta");
  return {
    id,
    text: doc.getText("text").toString(),
    createdAt: meta.get("createdAt") ?? 0,
    editedAt: meta.get("editedAt") ?? 0,
    deletedAt: meta.get("deletedAt") ?? null,
  };
}

/** 12 random URL-safe characters: 72 bits, and no bias, since 64 divides 256. */
function newId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => alphabet[byte & 63]).join("");
}
