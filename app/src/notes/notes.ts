import { createMutable } from "solid-js/store";
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

/** What tabs tell each other, so each one shows what any of them changed. */
type Message =
  | { type: "update"; id: string; update: Uint8Array }
  | { type: "note"; row: Row }
  | { type: "purge"; id: string };

/** Origins of changes that arrive from outside this tab. Any other change was made here. */
const Disk = "disk";
const Tab = "tab";
const Remote = "remote";

/** Where unsaved changes wait out a page closing, by note id: localStorage writes at once, IndexedDB may not finish. */
const RescuePrefix = "literal:unsaved:";

/** A pause in typing this long saves; so does typing this long without one. */
const SaveDelay = 250;
const SaveAtMost = 1000;
/** Notes read from disk at a time when the app starts. */
const ReadBatch = 500;
/** How often typing moves a note's `editedAt`: often enough to sort, rarely enough to stay out of the doc. */
const TouchEvery = 1000;
const TabId = crypto.randomUUID();

/** `synced`: this device has caught up with its account at least once, so its list is the whole list. */
export const notes = createMutable({ version: 0, ready: false, failed: false, synced: false });

/** Every note on this device by id. Not reactive: `notes.version` ticks when it changes. */
const all = new Map<string, Note>();
/** For each note, its state vector and dirty flag as last saved. */
const marks = new Map<string, { vector: Uint8Array; dirty: boolean }>();
const loading = new Map<string, Promise<Y.Doc | null>>();
const loaded = new Map<string, Y.Doc>();
/** For each loaded note, the stored state it already holds (`writer:rev`). */
const seen = new Map<string, string>();
/** Notes with changes waiting to be saved: the timer that saves them, and when the first of them came. */
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>();
/** Saves on their way to disk, counted by note: until they land, a closing page must rescue the note too. */
const saving = new Map<string, number>();
/** The live notes, last edited first, until a note changes. */
let sorted: Note[] | null = null;
/** When each note last moved its `editedAt`. */
const touched = new Map<string, number>();
/** Notes changed here since their last save. */
const changed = new Set<string>();
/** For each note, how many changes were made here: an ack only cleans the note if none came after what it covers. */
const edits = new Map<string, number>();
const listeners = new Set<(id: string, update: Uint8Array) => void>();

/** Signed in, deleted notes stay as tombstones so other devices learn of the delete; signed out, they're erased. */
let signedIn = false;
/** Everything on this device is being erased: nothing may be saved or rescued from now on. */
let wiped = false;
let started: Promise<void> | undefined;

const db = openDb((event) => {
  // Another tab is erasing everything (signing out, deleting the account) or needs a newer database: this one
  // starts over too. Only an erase forbids rescuing what's unsaved; after an upgrade, the new version saves it.
  wiped ||= event.newVersion === null;
  location.replace("/");
});
const channel = new BroadcastChannel("literal");

channel.onmessage = ({ data }: MessageEvent<unknown>) => {
  const message = parseMessage(data);
  if (message.type === "update") {
    void loading.get(message.id)?.then((doc) => {
      if (doc) Y.applyUpdate(doc, message.update, Tab);
    });
  } else if (message.type === "note") {
    keep(message.row);
    notes.version++;
  } else {
    all.delete(message.id);
    marks.delete(message.id);
    sorted = null;
    notes.version++;
  }
};

export function setSignedIn(value: boolean) {
  signedIn = value;
}

/**
 * Reads every note's summary, and puts back changes a closing page left unsaved. Signed out, it also clears out
 * deleted and empty notes. Reads once: sync waits for it before telling the server what this device has.
 */
export function start(): Promise<void> {
  return (started ??= readEverything());
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

/** Whether the note is on this device: listed, opened, or just made. */
export function exists(id: string): boolean {
  return all.has(id) || loaded.has(id);
}

export function isDeleted(note: Pick<Note, "editedAt" | "deletedAt">): boolean {
  return note.deletedAt !== null && note.deletedAt >= note.editedAt;
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
  if (!doc || deleted(doc)) return null;
  return doc.getText("text");
}

export async function remove(id: string) {
  const doc = await load(id).catch(failed);
  if (!doc) return;
  doc.getMap<number>("meta").set("deletedAt", Date.now());
  refresh(id, doc);
}

export async function restore(id: string) {
  const doc = await load(id).catch(failed);
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
  clearTimeout(pending.get(id)?.timer);
  pending.delete(id);
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
  unrescue(id);
  notes.version++;
  channel.postMessage({ type: "purge", id } satisfies Message);
  await store((tx) => {
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
  if (wiped) return;
  for (const id of new Set([...pending.keys(), ...saving.keys()])) {
    const doc = loaded.get(id);
    if (!doc) continue;
    try {
      localStorage.setItem(RescuePrefix + id, toBase64(Y.encodeStateAsUpdate(doc)));
    } catch (error) {
      // Full or blocked storage: the IndexedDB save started alongside is all there is.
      console.error(error);
    }
  }
}

/**
 * Erases every note on this device, in every tab, and starts over: after signing out or deleting the account.
 * Deleting the database sends every other tab back to the start.
 */
export async function wipe() {
  wiped = true;
  (await db).close();
  await deleteDb();
  for (const id of rescuedIds()) unrescue(id);
}

// For sync.ts alone.

/** Calls `listener` with every change made on this device, as a Yjs update. */
export function onLocal(listener: (id: string, update: Uint8Array) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the sync hello needs: when this device last caught up, and every note's state vector and dirty flag. */
export async function hello(): Promise<{ since: number; notes: { id: string; vector: Uint8Array; dirty: boolean }[] }> {
  await start();
  await flush();
  const since = (await readSince()) ?? 0;
  return { since, notes: [...marks].map(([id, mark]) => ({ id, ...mark })) };
}

/**
 * Applies a change from the server, creating the note if it's new here. Words arriving for a note deleted
 * here were written by someone who hadn't seen the delete: the note comes back, with them.
 */
export async function receive(id: string, update: Uint8Array) {
  const doc = (await load(id)) ?? loaded.get(id) ?? adopt(id, new Y.Doc());
  const wasDeleted = all.has(id) && deleted(doc);
  let wrote = false;
  const text = doc.getText("text");
  const watch = () => (wrote = true);
  text.observe(watch);
  Y.applyUpdate(doc, update, Remote);
  text.unobserve(watch);
  if (wasDeleted && wrote && deleted(doc)) await restore(id);
}

/**
 * The server has erased the note, deleted long ago. Words written here that never reached it live on, as a note
 * of their own.
 */
export async function forgotten(id: string) {
  const doc = await load(id);
  const unsent = changed.has(id) || marks.get(id)?.dirty;
  if (doc && unsent && !deleted(doc)) add(doc.getText("text").toString(), summarize(id, doc).editedAt);
  await purge(id);
}

/** What this device has that the server, at `vector`, doesn't, with every deletion; all of it, without one. */
export async function missing(id: string, vector?: Uint8Array): Promise<Uint8Array | null> {
  const doc = await load(id);
  return doc ? Y.encodeStateAsUpdate(doc, vector) : null;
}

/** How long the note is, in characters as Yjs counts them: what decides whether it syncs. */
export function length(id: string): number {
  return loaded.get(id)?.getText("text").length ?? all.get(id)?.text.length ?? 0;
}

/** Marks this device caught up to `now`, once everything that came with it is on disk. */
export async function caughtUp(now: number) {
  await flush();
  // A change that failed to save lives only in memory: claiming it caught up would keep the server from resending it.
  if (notes.failed) return;
  if (await store((tx) => tx.objectStore("meta").put(now, "since"))) notes.synced = true;
}

/**
 * The account this device synced with is gone, deleted or signed out elsewhere. Whichever one it signs in to
 * next must hear about every note here, and tell it everything it has.
 */
export async function unsync() {
  await start();
  // Already so: a device opened signed out hears that its account is gone each time it starts.
  if (!notes.synced && [...marks.values()].every((mark) => mark.dirty)) return;
  const done = await store((tx) => {
    tx.objectStore("meta").delete("since");
    for (const name of ["notes", "docs"]) {
      const records = tx.objectStore(name);
      const cursor = records.openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        const value = name === "notes" ? parseRow(cursor.result.value) : parseStored(cursor.result.value);
        cursor.result.update({ ...value, dirty: true });
        cursor.result.continue();
      };
    }
  });
  if (!done) return;
  for (const mark of marks.values()) mark.dirty = true;
  notes.synced = false;
}

/** How many changes this device has made to the note so far. */
export function generation(id: string): number {
  return edits.get(id) ?? 0;
}

/** The server stored the note's changes up to `upTo`: if nothing was typed since, it's clean. */
export async function acked(id: string, upTo: number) {
  if (generation(id) !== upTo || changed.has(id)) return;
  const done = await store((tx) => {
    const docs = tx.objectStore("docs");
    const rows = tx.objectStore("notes");
    const stored = docs.get(id);
    stored.onsuccess = () => {
      if (stored.result !== undefined) docs.put({ ...parseStored(stored.result), dirty: false }, id);
    };
    const row = rows.get(id);
    row.onsuccess = () => {
      if (row.result !== undefined) rows.put({ ...parseRow(row.result), dirty: false });
    };
  });
  const mark = marks.get(id);
  if (done && mark) mark.dirty = false;
}

/** How many notes have changes the server hasn't acked. */
export function unsynced(): number {
  return (
    [...marks.values()].filter((mark) => mark.dirty).length + [...changed].filter((id) => !marks.get(id)?.dirty).length
  );
}

async function readEverything() {
  try {
    for await (const values of readAll(await db, "notes", ReadBatch)) {
      for (const row of values.map(parseRow)) {
        if (!signedIn && (isDeleted(row) || !isWritten(row))) void purge(row.id);
        // A save that landed while this read was under way knows better.
        else if (!all.has(row.id)) keep(row);
      }
    }
    for (const id of rescuedIds()) await load(id);
    notes.synced = (await readSince()) !== undefined;
  } catch (error) {
    failed(error);
  }
  notes.ready = true;
  notes.version++;
}

function isLive(note: Note): boolean {
  return !isDeleted(note) && isWritten(note);
}

/** Whether there's anything in it but whitespace. */
function isWritten(note: Note): boolean {
  return /\S/.test(note.text);
}

/** Whether the note is deleted, from its times alone: summarizing it would copy out all of its text. */
function deleted(doc: Y.Doc): boolean {
  const meta = doc.getMap<number>("meta");
  return isDeleted({ editedAt: meta.get("editedAt") ?? 0, deletedAt: meta.get("deletedAt") ?? null });
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
  const value = await get(await db, "docs", id);
  const stored = value === undefined ? undefined : parseStored(value);
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
    Y.applyUpdate(doc, stored.state, Disk);
    seen.set(id, `${stored.writer}:${stored.rev}`);
  }
  adopt(id, doc);
  if (unsaved) {
    // With no origin, the copy counts as a change made here: it gets saved, and sent.
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
    if (origin === Disk || origin === Tab) return;
    channel.postMessage({ type: "update", id, update } satisfies Message);
    if (origin !== Remote) {
      changed.add(id);
      edits.set(id, generation(id) + 1);
      for (const listener of listeners) listener(id, update);
    }
    schedule(id);
  });
  doc.getText("text").observe((_, transaction) => {
    if (!transaction.local) return;
    touch(id, doc);
    // Words written into a note deleted elsewhere bring it back, whatever either device's clock says.
    if (doc.getMap("meta").has("deletedAt")) queueMicrotask(() => void restore(id));
  });
  return doc;
}

function schedule(id: string) {
  const now = Date.now();
  const since = pending.get(id)?.since ?? now;
  clearTimeout(pending.get(id)?.timer);
  pending.set(id, { since, timer: setTimeout(() => void save(id), Math.min(SaveDelay, since + SaveAtMost - now)) });
}

function touch(id: string, doc: Y.Doc) {
  const now = Date.now();
  if (now - (touched.get(id) ?? 0) < TouchEvery) return;
  touched.set(id, now);
  // Yjs runs observers inside the transaction; a change made from one belongs in its own.
  queueMicrotask(() => doc.getMap<number>("meta").set("editedAt", now));
}

/** Writes the note to disk, first merging in whatever another tab wrote there since this one last looked. */
async function save(id: string) {
  clearTimeout(pending.get(id)?.timer);
  pending.delete(id);
  const doc = loaded.get(id);
  if (!doc || wiped) return;
  const local = changed.has(id);
  changed.delete(id);
  let row: Row | undefined;
  track(id, 1);
  const saved = await store((tx) => {
    const docs = tx.objectStore("docs");
    const request = docs.get(id);
    request.onsuccess = () => {
      const stored = request.result === undefined ? undefined : parseStored(request.result);
      if (stored && seen.get(id) !== `${stored.writer}:${stored.rev}`) Y.applyUpdate(doc, stored.state, Disk);
      const rev = (stored?.rev ?? 0) + 1;
      const dirty = local || (stored?.dirty ?? false);
      docs.put({ state: Y.encodeStateAsUpdate(doc), writer: TabId, rev, dirty } satisfies Stored, id);
      seen.set(id, `${TabId}:${rev}`);
      row = { ...summarize(id, doc), vector: Y.encodeStateVector(doc), dirty };
      tx.objectStore("notes").put(row);
    };
  });
  track(id, -1);
  if (!saved && local) changed.add(id);
  if (!row || !saved || !loaded.has(id)) return;
  // A rescued copy may be newer than what this save wrote: only the last save of the note clears it.
  if (!pending.has(id) && !saving.has(id)) unrescue(id);
  // The note may have changed while the write was on its way (a sync, an undo): describe it as it is now.
  const fresh: Row = { ...summarize(id, doc), vector: row.vector, dirty: row.dirty };
  keep(fresh);
  notes.version++;
  channel.postMessage({ type: "note", row: fresh } satisfies Message);
}

function track(id: string, by: 1 | -1) {
  const count = (saving.get(id) ?? 0) + by;
  if (count) saving.set(id, count);
  else saving.delete(id);
}

/** Writes to disk; a failure shows in the corner, since every later write would fail too. */
async function store(work: (tx: IDBTransaction) => void): Promise<boolean> {
  // Erased, there's no database left to write to.
  if (wiped) return false;
  try {
    await write(await db, work);
    return true;
  } catch (error) {
    failed(error);
    return false;
  }
}

function failed(error: unknown): null {
  notes.failed = true;
  console.error(error);
  return null;
}

async function readSince(): Promise<number | undefined> {
  const since = await get(await db, "meta", "since");
  if (since === undefined || typeof since === "number") return since;
  throw new Error("read since: not a number");
}

/** Notes with changes left by a page that closed before saving them. */
function rescuedIds(): string[] {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(RescuePrefix))
      .map((key) => key.slice(RescuePrefix.length));
  } catch {
    return []; // no storage, so nothing was rescued
  }
}

function rescued(id: string): Uint8Array | null {
  let text: string | null;
  try {
    text = localStorage.getItem(RescuePrefix + id);
  } catch {
    return null; // no storage, so nothing was rescued
  }
  if (!text) return null;
  try {
    return fromBase64(text);
  } catch (error) {
    console.error(error);
    unrescue(id);
    return null;
  }
}

function unrescue(id: string) {
  try {
    localStorage.removeItem(RescuePrefix + id);
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

// What's read back from disk, or from another tab, was written by this app; but maybe by an older version of it.

function parseRow(value: unknown): Row {
  if (!isRecord(value)) throw new Error("read note: not a record");
  const { id, text, createdAt, editedAt, deletedAt, vector, dirty } = value;
  if (
    typeof id !== "string" ||
    typeof text !== "string" ||
    typeof createdAt !== "number" ||
    typeof editedAt !== "number" ||
    (deletedAt !== null && typeof deletedAt !== "number") ||
    !(vector instanceof Uint8Array) ||
    typeof dirty !== "boolean"
  )
    throw new Error("read note: unexpected fields");
  return { id, text, createdAt, editedAt, deletedAt, vector, dirty };
}

function parseStored(value: unknown): Stored {
  if (!isRecord(value)) throw new Error("read note state: not a record");
  const { state, writer, rev, dirty } = value;
  if (
    !(state instanceof Uint8Array) ||
    typeof writer !== "string" ||
    typeof rev !== "number" ||
    typeof dirty !== "boolean"
  )
    throw new Error("read note state: unexpected fields");
  return { state, writer, rev, dirty };
}

function parseMessage(data: unknown): Message {
  if (isRecord(data)) {
    const { type, id, update, row } = data;
    if (type === "update" && typeof id === "string" && update instanceof Uint8Array) return { type, id, update };
    if (type === "note") return { type, row: parseRow(row) };
    if (type === "purge" && typeof id === "string") return { type, id };
  }
  throw new Error("tab message: unexpected shape");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 10 random characters of Crockford's base32, in lowercase: no letter that passes for a digit, 50 bits, and no bias,
 * since 32 divides 256.
 */
function newId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => alphabet[byte & 31]).join("");
}
