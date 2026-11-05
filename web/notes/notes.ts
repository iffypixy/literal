import { createSignal } from "solid-js";
import { createMutable } from "solid-js/store";
import * as Y from "yjs";
import { isDeleted, lastEdited, markEdited } from "#protocol.ts";
import { attempt, isRecord } from "#web/safe.ts";
import * as storage from "#web/storage.ts";
import { account } from "#web/sync/account.ts";
import { deleteDb, get, openDb, readNotes, write } from "./db.ts";

/** What the list and search know about a note. The note itself is a Yjs doc of its `text`, `meta` and `edits` times. */
export type Note = {
  id: string;
  text: string;
  createdAt: number;
  editedAt: number;
  /** When it was deleted. An edit made after that brings the note back, so no device ever loses words. */
  deletedAt: number | null;
};

/**
 * A note's Yjs state, stamped `writer:rev` by the tab that last wrote it: a tab that finds its own stamp knows nobody
 * has written since.
 */
type Stored = { state: Uint8Array; writer: string; rev: number };

/** A note as stored for the list and sync. `dirty`: it has changes the server hasn't acked. */
type Row = Note & { vector: Uint8Array; dirty: boolean };

/** Everything this tab knows about one note. */
type Entry = {
  /** As the list shows it. */
  note?: Note;
  doc?: Y.Doc;
  /** The doc on its way from disk, or already here. */
  loading?: Promise<Y.Doc | null>;
  /** The stored state (`writer:rev`) the doc already holds. */
  seen?: string;
  /** Waiting to be saved: the timer that saves it, and when its first change came. */
  pending?: { timer: ReturnType<typeof setTimeout>; since: number };
  /** Saves on their way to disk: until they land, a closing page must rescue the note too. */
  saving: number;
  /** When typing last moved `editedAt`. */
  touched: number;
  /** Changed here since its last save. */
  unsaved: boolean;
  /** How many changes it had here: an ack only cleans the note if none came after what it covers. */
  generation: number;
};

type Message =
  | { type: "update"; id: string; update: Uint8Array }
  | { type: "note"; row: Row }
  | { type: "purge"; id: string };

/** Origins of changes that arrive from outside this tab. Any other change was made here. */
const Disk = "disk";
const Tab = "tab";
const Remote = "remote";

/** Where unsaved changes wait out a page closing: localStorage writes at once, IndexedDB may not finish. */
const Rescued = "unsaved:";

/** A pause in typing this long saves; so does typing this long without one. */
const SaveDelay = 250;
const SaveAtMost = 1000;
const ReadBatch = 500;
/** How often typing moves a note's `editedAt`: often enough to sort by, rarely enough to stay out of the doc. */
const TouchEvery = 1000;
const TabId = crypto.randomUUID();

/**
 * `ready`: every note has been read from disk. `failed`: a save failed, so changes may live only in memory.
 * `synced`: this device has caught up with its account at least once, so its list is the whole list.
 */
export const library = createMutable({ ready: false, failed: false, synced: false });

/** Reading anything below tracks `changes`; every change to a note calls `changed`. */
const [changes, changed] = createSignal(undefined, { equals: false });

const entries = new Map<string, Entry>();
let sorted: Note[] | null = null;
const listeners = new Set<(id: string, update: Uint8Array | null) => void>();

/** Everything here is being erased: nothing may be saved or rescued from now on. */
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
    void entries.get(message.id)?.loading?.then((doc) => {
      if (doc) Y.applyUpdate(doc, message.update, Tab);
    });
  } else if (message.type === "note") {
    keep(message.row);
    changed();
  } else {
    // Erased in another tab. A change made here and not saved yet stays, and its save brings the note back.
    const entry = entries.get(message.id);
    if (entry && !entry.pending && !entry.saving) forget(message.id);
  }
};

/**
 * Reads every note's summary once, putting back what a closing page left unsaved. Signed out, it also clears out
 * deleted and empty notes.
 */
export function start(): Promise<void> {
  return (started ??= readEverything());
}

/** Live notes, last edited first. The same array until a note changes: don't modify it. */
export function list(): Note[] {
  changes();
  // Notes still waiting to be saved are newer in memory than in the list.
  for (const [id, entry] of entries) {
    if (!entry.pending || !entry.doc) continue;
    const note = summarize(id, entry.doc);
    const known = entry.note;
    if (known?.text === note.text && known.editedAt === note.editedAt && known.deletedAt === note.deletedAt) continue;
    entry.note = note;
    sorted = null;
  }
  sorted ??= [...entries.values()]
    .flatMap(({ note }) => (note && isLive(note) ? [note] : []))
    .sort((a, b) => b.editedAt - a.editedAt);
  return sorted;
}

export function find(id: string): Note | undefined {
  changes();
  return entries.get(id)?.note;
}

/** Listed, opened, or just made. */
export function exists(id: string): boolean {
  changes();
  const entry = entries.get(id);
  return Boolean(entry?.note || entry?.doc);
}

/** In memory until its first save. */
export function create(at = Date.now()): { id: string; text: Y.Text } {
  const id = newId();
  const doc = adopt(id, new Y.Doc());
  doc.transact(() => {
    doc.getMap<number>("meta").set("createdAt", at);
    markEdited(doc, at);
  });
  // Counts as the first touch, so an import keeps the file's own time.
  entryFor(id).touched = Date.now();
  return { id, text: doc.getText("text") };
}

export function add(text: string, at: number) {
  const note = create(at);
  note.text.insert(0, text);
  void save(note.id);
}

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

/** Once a delete's Undo has passed: signed out, the note is erased; signed in, its tombstone stays to sync. */
export function settle(id: string) {
  const note = entries.get(id)?.note;
  if (!isSignedIn() && note && isDeleted(note.deletedAt, note.editedAt)) void purge(id);
}

export function discardIfEmpty(id: string) {
  const doc = entries.get(id)?.doc;
  if (!doc || isWritten(doc.getText("text").toString())) return;
  if (isSignedIn()) void remove(id);
  else void purge(id);
}

/** Saves every change still waiting, then waits out the saves already under way: a write runs after those before it. */
export async function flush() {
  await Promise.all([...entries].filter(([, entry]) => entry.pending).map(([id]) => save(id)));
  await store(() => {});
}

/** As the page goes away: keeps every unsaved change somewhere written at once, until the next start. */
export function rescue() {
  if (wiped) return;
  for (const [id, entry] of entries) {
    if (!entry.doc || (!entry.pending && !entry.saving)) continue;
    // Without storage, the IndexedDB save started alongside is all there is.
    if (!storage.write(Rescued + id, toBase64(Y.encodeStateAsUpdate(entry.doc))))
      console.error(`rescue ${id}: no storage`);
  }
}

/** Erases every note on this device. Deleting the database sends every other tab back to the start. */
export async function wipe() {
  wiped = true;
  (await db).close();
  await deleteDb();
  for (const id of storage.keys(Rescued)) storage.remove(Rescued + id);
}

// For sync.ts.

/** `update`: a change made here, to send. Null: a change from another tab, which this tab never sends. */
export function onChange(listener: (id: string, update: Uint8Array | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function hello(): Promise<{ since: number; notes: { id: string; vector: Uint8Array; dirty: boolean }[] }> {
  await start();
  await flush();
  const since = (await readSince()) ?? 0;
  const notes: { id: string; vector: Uint8Array; dirty: boolean }[] = [];
  for await (const rows of readNotes(await db, parseRow, ReadBatch)) {
    for (const { id, vector, dirty } of rows) notes.push({ id, vector, dirty });
  }
  return { since, notes };
}

/**
 * Applies a change from the server, creating the note if it's new here. Words arriving for a note deleted
 * here were written by someone who hadn't seen the delete: the note comes back, with them.
 */
export async function receive(id: string, update: Uint8Array) {
  const doc = (await load(id)) ?? entries.get(id)?.doc ?? adopt(id, new Y.Doc());
  const wasDeleted = Boolean(entries.get(id)?.note) && deleted(doc);
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
 * of their own: made by one tab only, so they live on once.
 */
export async function forgotten(id: string) {
  await navigator.locks.request(`forget ${id}`, async () => {
    const doc = await load(id);
    const row = await get(await db, "notes", id);
    const unsent = entries.get(id)?.unsaved || (row !== undefined && parseRow(row).dirty);
    if (doc && unsent && !deleted(doc)) add(doc.getText("text").toString(), lastEdited(doc));
    await purge(id);
  });
}

/** What this device has that the server, at `vector`, doesn't, with every deletion; all of it, without one. */
export async function missing(id: string, vector?: Uint8Array): Promise<Uint8Array | null> {
  const doc = await load(id);
  return doc ? Y.encodeStateAsUpdate(doc, vector) : null;
}

/** In characters as Yjs counts them: what decides whether it syncs. */
export function length(id: string): number {
  changes();
  const entry = entries.get(id);
  return entry?.doc?.getText("text").length ?? entry?.note?.text.length ?? 0;
}

/** Marks this device caught up to `now`, once everything that came with it is on disk. */
export async function caughtUp(now: number) {
  await flush();
  // A change that failed to save lives only in memory: claiming it caught up would keep the server from resending it.
  if (library.failed) return;
  if (await store((tx) => tx.objectStore("meta").put(now, "since"))) library.synced = true;
}

/**
 * The account this device synced with is gone, deleted or signed out elsewhere. Whichever one it signs in to
 * next must hear about every note here, and get everything it has.
 */
export async function unsync() {
  await start();
  const done = await store((tx) => {
    tx.objectStore("meta").delete("since");
    const cursor = tx.objectStore("notes").openCursor();
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      const row = parseRow(cursor.result.value);
      if (!row.dirty) cursor.result.update({ ...row, dirty: true });
      cursor.result.continue();
    };
  });
  if (done) library.synced = false;
}

export function generation(id: string): number {
  return entries.get(id)?.generation ?? 0;
}

/** The server stored the note's changes up to generation `upTo`: if nothing was typed since, it's clean. */
export async function acked(id: string, upTo: number) {
  const entry = entries.get(id);
  if (!entry || entry.generation !== upTo || entry.unsaved) return;
  await store((tx) => {
    const rows = tx.objectStore("notes");
    const request = rows.get(id);
    request.onsuccess = () => {
      if (request.result !== undefined) rows.put({ ...parseRow(request.result), dirty: false });
    };
  });
}

/** Notes with changes the server hasn't acked, read from disk: another tab may have sent or saved them. */
export async function unsynced(): Promise<number> {
  await flush();
  // Changes whose save failed live only in memory.
  const ids = new Set([...entries].filter(([, entry]) => entry.unsaved).map(([id]) => id));
  for await (const rows of readNotes(await db, parseRow, ReadBatch)) {
    for (const row of rows) if (row.dirty) ids.add(row.id);
  }
  return ids.size;
}

async function readEverything() {
  try {
    const rescues = new Set(storage.keys(Rescued));
    for await (const rows of readNotes(await db, parseRow, ReadBatch)) {
      for (const row of rows) {
        // Words a closing page left unsaved may bring a deleted or empty note back: it waits for them.
        if (!isSignedIn() && !rescues.has(row.id) && !isLive(row)) void purge(row.id);
        // A save that landed while this read was under way knows better.
        else if (!entries.get(row.id)?.note) keep(row);
      }
    }
    for (const id of rescues) await load(id);
    library.synced = (await readSince()) !== undefined;
  } catch (error) {
    failed(error);
  }
  library.ready = true;
  changed();
}

/** Signed in, deleted notes stay as tombstones so other devices learn of the delete; signed out, they're erased. */
function isSignedIn(): boolean {
  return account.email !== null;
}

function isLive(note: Note): boolean {
  return !isDeleted(note.deletedAt, note.editedAt) && isWritten(note.text);
}

function isWritten(text: string): boolean {
  return /\S/.test(text);
}

/** From its times alone: summarizing it would copy out all of its text. */
function deleted(doc: Y.Doc): boolean {
  return isDeleted(doc.getMap<number>("meta").get("deletedAt"), lastEdited(doc));
}

function entryFor(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = { saving: 0, touched: 0, unsaved: false, generation: 0 };
    entries.set(id, entry);
  }
  return entry;
}

function load(id: string): Promise<Y.Doc | null> {
  const entry = entryFor(id);
  return (entry.loading ??= read(id));
}

/** Loads the note from disk, with any changes a closing page left unsaved. */
async function read(id: string): Promise<Y.Doc | null> {
  const [value, known] = await Promise.all([get(await db, "docs", id), get(await db, "notes", id)]);
  const stored = value === undefined ? undefined : parseStored(value);
  const unsaved = rescued(id);
  const entry = entries.get(id);
  if (!stored && !unsaved) {
    // Not here: the next look reads again.
    if (entry && !entry.note && !entry.doc) entries.delete(id);
    else if (entry) entry.loading = undefined;
    return null;
  }
  // Another call may have made the note meanwhile.
  if (entry?.doc) return entry.doc;
  const doc = new Y.Doc();
  if (stored) Y.applyUpdate(doc, stored.state, Disk);
  adopt(id, doc);
  if (stored) entryFor(id).seen = `${stored.writer}:${stored.rev}`;
  // A dirty note may hold words another tab couldn't send, so the next send from this tab has to be the whole note.
  if (known !== undefined && parseRow(known).dirty) for (const listener of listeners) listener(id, null);
  if (unsaved) {
    // With no origin, the copy counts as a change made here: it gets saved, and sent.
    Y.applyUpdate(doc, unsaved);
    // Nothing new means the save had finished after all; only a save clears the copy, and it runs on changes.
    if (!entries.get(id)?.pending) storage.remove(Rescued + id);
  }
  return doc;
}

function adopt(id: string, doc: Y.Doc): Y.Doc {
  const entry = entryFor(id);
  entry.doc = doc;
  entry.loading = Promise.resolve(doc);
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === Disk || origin === Tab) {
      for (const listener of listeners) listener(id, null);
      return;
    }
    channel.postMessage({ type: "update", id, update } satisfies Message);
    if (origin !== Remote) {
      entry.unsaved = true;
      entry.generation++;
      for (const listener of listeners) listener(id, update);
    }
    schedule(entry, id);
  });
  doc.getText("text").observe((_, transaction) => {
    if (!transaction.local) return;
    touch(entry, doc);
    // Words written into a note deleted elsewhere bring it back, whatever either device's clock says.
    if (doc.getMap("meta").has("deletedAt")) queueMicrotask(() => void restore(id));
  });
  return doc;
}

function schedule(entry: Entry, id: string) {
  const now = Date.now();
  const since = entry.pending?.since ?? now;
  clearTimeout(entry.pending?.timer);
  entry.pending = { since, timer: setTimeout(() => void save(id), Math.min(SaveDelay, since + SaveAtMost - now)) };
}

function touch(entry: Entry, doc: Y.Doc) {
  const now = Date.now();
  if (now - entry.touched < TouchEvery) return;
  entry.touched = now;
  // Yjs runs observers inside the transaction; a change made from one belongs in its own.
  queueMicrotask(() => markEdited(doc, now));
}

/** Writes the note to disk, first merging in whatever another tab wrote there since this one last looked. */
async function save(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  clearTimeout(entry.pending?.timer);
  entry.pending = undefined;
  const doc = entry.doc;
  if (!doc || wiped) return;
  const local = entry.unsaved;
  entry.unsaved = false;
  let row: Row | undefined;
  entry.saving++;
  const saved = await store((tx) => {
    const docs = tx.objectStore("docs");
    const rows = tx.objectStore("notes");
    const before = docs.get(id);
    const known = rows.get(id);
    // Requests in a transaction finish in order: by now, both have.
    known.onsuccess = () => {
      const stored = before.result === undefined ? undefined : parseStored(before.result);
      if (stored && entry.seen !== `${stored.writer}:${stored.rev}`) Y.applyUpdate(doc, stored.state, Disk);
      const rev = (stored?.rev ?? 0) + 1;
      docs.put({ state: Y.encodeStateAsUpdate(doc), writer: TabId, rev } satisfies Stored, id);
      entry.seen = `${TabId}:${rev}`;
      const dirty = local || (known.result !== undefined && parseRow(known.result).dirty);
      row = { ...summarize(id, doc), vector: Y.encodeStateVector(doc), dirty };
      rows.put(row);
    };
  });
  entry.saving--;
  if (!saved && local) entry.unsaved = true;
  if (!row || !saved || entries.get(id) !== entry) return;
  // A rescued copy may be newer than what this save wrote: only the last save of the note clears it.
  if (!entry.pending && !entry.saving) storage.remove(Rescued + id);
  // The note may have changed while the write was on its way (a sync, an undo): describe it as it is now.
  const fresh: Row = { ...row, ...summarize(id, doc) };
  keep(fresh);
  changed();
  channel.postMessage({ type: "note", row: fresh } satisfies Message);
}

async function purge(id: string) {
  forget(id);
  storage.remove(Rescued + id);
  channel.postMessage({ type: "purge", id } satisfies Message);
  await store((tx) => {
    tx.objectStore("docs").delete(id);
    tx.objectStore("notes").delete(id);
  });
}

/** Lets go of the note in this tab alone, as if it had never been here. */
function forget(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  clearTimeout(entry.pending?.timer);
  entry.doc?.destroy();
  entries.delete(id);
  sorted = null;
  changed();
}

/** A failure shows in the corner, since every later write would fail too. */
async function store(work: (tx: IDBTransaction) => void): Promise<boolean> {
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
  library.failed = true;
  console.error(error);
  return null;
}

async function readSince(): Promise<number | undefined> {
  const since = await get(await db, "meta", "since");
  if (since === undefined || typeof since === "number") return since;
  throw new Error("read since: not a number");
}

function rescued(id: string): Uint8Array | null {
  const text = storage.read(Rescued + id);
  if (!text) return null;
  const bytes = attempt(() => fromBase64(text), null);
  if (!bytes) storage.remove(Rescued + id);
  return bytes;
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

function keep({ id, text, createdAt, editedAt, deletedAt }: Row) {
  entryFor(id).note = { id, text, createdAt, editedAt, deletedAt };
  sorted = null;
}

function refresh(id: string, doc: Y.Doc) {
  entryFor(id).note = summarize(id, doc);
  sorted = null;
  changed();
}

function summarize(id: string, doc: Y.Doc): Note {
  const meta = doc.getMap<number>("meta");
  return {
    id,
    text: doc.getText("text").toString(),
    createdAt: meta.get("createdAt") ?? 0,
    editedAt: lastEdited(doc),
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
  const { state, writer, rev } = value;
  if (!(state instanceof Uint8Array) || typeof writer !== "string" || typeof rev !== "number")
    throw new Error("read note state: unexpected fields");
  return { state, writer, rev };
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

/**
 * 10 random characters of Crockford's base32, in lowercase: no letter that passes for a digit, 50 bits, and no bias,
 * since 32 divides 256.
 */
function newId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => alphabet[byte & 31]).join("");
}
