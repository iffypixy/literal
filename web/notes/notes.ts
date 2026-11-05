import { createSignal } from "solid-js";
import { createMutable } from "solid-js/store";
import * as Y from "yjs";
import { isDocDeleted, isDeleted, lastEdited, markEdited, newId, type Of } from "#protocol.ts";
import { attempt, isRecord } from "#web/safe.ts";
import * as storage from "#web/storage.ts";
import { account } from "#web/sync/account.ts";
import { openDb } from "./db.ts";

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
 * A note's Yjs state, stamped `writer:rev` by the tab that last wrote it. A tab that finds its own stamp knows nobody
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
  /** Set while a save is waiting: its timer, and when the first change came. */
  pending?: { timer: ReturnType<typeof setTimeout>; since: number };
  /** Saves still on their way to disk. Until they land, a closing page has to rescue the note too. */
  saving: number;
  /** When typing last moved `editedAt`. */
  touched: number;
  /** Changed here since its last save. */
  unsaved: boolean;
  /** Counts changes made here. An ack marks the note clean only if no change came after the ones it covers. */
  generation: number;
};

/** `stamp`: the stored state (`writer:rev`) the save left on disk. */
type TabMessage = { type: "note"; note: Note; stamp: string } | { type: "purge"; id: string };

/** Origins of changes that arrive from outside this tab: another tab's, read from disk, and the server's. */
const Disk = "disk";
const Remote = "remote";

/** Where unsaved changes go as the page closes, since localStorage writes at once and IndexedDB may not finish. */
const Rescued = "unsaved:";

/** A pause in typing this long saves; so does typing this long without one. */
const SaveDelay = 250;
const SaveAtMost = 1000;
/** How often typing moves a note's `editedAt`. Often enough to sort by, rarely enough not to bloat the doc. */
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
let listener: (id: string, update: Uint8Array | null) => void = () => {};

/** Everything here is being erased, so nothing may be saved or rescued from now on. */
let wiped = false;
let started: Promise<void> | undefined;

const db = openDb((event) => {
  // Another tab is erasing everything (signing out, deleting the account) or needs a newer database, so this one
  // starts over too. After an erase nothing unsaved may be rescued. After an upgrade, the new version saves it.
  wiped ||= event.newVersion === null;
  location.replace("/");
});
const channel = new BroadcastChannel("literal");

channel.onmessage = ({ data }: MessageEvent<unknown>) => {
  const message = parseMessage(data);
  if (message.type === "note") {
    keep(message.note);
    changed();
    const entry = entries.get(message.note.id);
    if (entry?.doc && entry.seen !== message.stamp) void catchUp(message.note.id, entry.doc).catch(failed);
    return;
  }
  // Erased in another tab. A change here that isn't on disk for good stays, and saving it again brings the note back.
  const entry = entries.get(message.id);
  if (!entry) return;
  if (!isWriting(entry)) return forget(message.id);
  entry.unsaved = true;
  schedule(entry, message.id);
};

/**
 * Reads every note's summary once, putting back what a closing page left unsaved. Signed out, it also clears out
 * deleted and empty notes.
 */
export function start(): Promise<void> {
  return (started ??= readEverything());
}

/** Live notes, last edited first. It's the same array until a note changes, so don't modify it. */
export function list(): Note[] {
  changes();
  // Until a note is on disk for good, it's newer in memory than in the list, or not there yet at all.
  for (const [id, entry] of entries) {
    if (!entry.doc || !isWriting(entry)) continue;
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
  if (!doc || isDocDeleted(doc)) return null;
  return doc.getText("text");
}

export async function remove(id: string) {
  const doc = await load(id).catch(failed);
  if (!doc) return;
  // Never before its last edit, which a device with its clock ahead may have put in the future.
  doc.getMap<number>("meta").set("deletedAt", Math.max(Date.now(), lastEdited(doc)));
  refresh(id, doc);
}

export async function restore(id: string) {
  const doc = await load(id).catch(failed);
  if (!doc) return;
  doc.getMap<number>("meta").delete("deletedAt");
  refresh(id, doc);
}

/** Once a delete's Undo has passed. Signed out, the note is erased. Signed in, its tombstone stays, to sync. */
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

/** Saves every change still waiting, then waits for saves under way: writes run in order, so an empty one does. */
export async function flush() {
  await Promise.all([...entries].filter(([, entry]) => entry.pending).map(([id]) => save(id)));
  await store(() => {});
}

/** As the page goes away, keeps every unsaved change somewhere that's written at once, until the next start. */
export function rescue() {
  if (wiped) return;
  for (const [id, entry] of entries) {
    if (!entry.doc || !isWriting(entry)) continue;
    // Without storage, the IndexedDB save started alongside is all there is.
    if (!storage.write(Rescued + id, toBase64(Y.encodeStateAsUpdate(entry.doc))))
      console.error(`rescue ${id}: no storage`);
  }
}

/** Erases every note on this device. Deleting the database sends every other tab back to the start. */
export async function wipe() {
  wiped = true;
  await db.erase();
  for (const id of storage.keys(Rescued)) storage.remove(Rescued + id);
}

// For sync.ts.

/** `update`: a change made here, to send. Null: a change another tab made, which that tab sends. */
export function onChange(listen: typeof listener) {
  listener = listen;
}

export async function hello(): Promise<Omit<Of<"hello">, "type">> {
  await start();
  await flush();
  const since = (await readSince()) ?? 0;
  const notes: Of<"hello">["notes"] = [];
  for await (const rows of db.notes(parseRow)) {
    for (const { id, vector, dirty } of rows) notes.push({ id, vector, dirty });
  }
  return { since, notes };
}

/**
 * Applies a change from the server, creating the note if it's new here. Words arriving for a note deleted
 * here were written by someone who hadn't seen the delete, so the note comes back with them.
 */
export async function receive(id: string, update: Uint8Array) {
  const doc = (await load(id)) ?? adopt(id, new Y.Doc());
  const wasDeleted = isDocDeleted(doc);
  let wrote = false;
  const text = doc.getText("text");
  const watch = () => (wrote = true);
  text.observe(watch);
  Y.applyUpdate(doc, update, Remote);
  text.unobserve(watch);
  if (wasDeleted && wrote && isDocDeleted(doc)) await restore(id);
}

/**
 * The server has erased the note, deleted long ago. Words written here that never reached it live on as a new note,
 * made by one tab only so that it's made once.
 */
export async function purged(id: string) {
  await navigator.locks.request(`purge ${id}`, async () => {
    const doc = await load(id);
    const row = await db.get("notes", id);
    const unsent = entries.get(id)?.unsaved || (row !== undefined && parseRow(row).dirty);
    if (doc && unsent && !isDocDeleted(doc)) add(doc.getText("text").toString(), lastEdited(doc));
    await purge(id);
  });
}

/** What this device has that the server, at `vector`, doesn't, with every deletion. Without a vector, all of it. */
export async function missing(id: string, vector?: Uint8Array): Promise<Uint8Array | null> {
  const doc = await load(id);
  return doc ? Y.encodeStateAsUpdate(doc, vector) : null;
}

/** In characters as Yjs counts them, which decides whether it syncs. */
export function length(id: string): number {
  changes();
  const entry = entries.get(id);
  return entry?.doc?.getText("text").length ?? entry?.note?.text.length ?? 0;
}

/** Marks this device caught up to `now`, once everything that came with it is on disk. */
export async function caughtUp(now: number) {
  await flush();
  // A change that failed to save lives only in memory. Claiming to have caught up would stop the server resending it.
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

/** The server stored the note's changes up to generation `upTo`. If nothing was typed since, it's clean. */
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

/** Notes with changes the server hasn't acked. Read from disk, since another tab may have sent or saved them. */
export async function unsynced(): Promise<number> {
  await flush();
  // Changes whose save failed live only in memory.
  const ids = new Set([...entries].filter(([, entry]) => entry.unsaved).map(([id]) => id));
  for await (const rows of db.notes(parseRow)) {
    for (const row of rows) if (row.dirty) ids.add(row.id);
  }
  return ids.size;
}

async function readEverything() {
  try {
    const rescues = new Set(storage.keys(Rescued));
    for await (const rows of db.notes(parseRow)) {
      for (const row of rows) {
        // Words a closing page left unsaved may bring a deleted or empty note back, so it waits for them.
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

/** Signed in, deleted notes stay as tombstones so other devices learn of the delete. Signed out, they're erased. */
function isSignedIn(): boolean {
  return account.email !== null;
}

function isLive(note: Note): boolean {
  return !isDeleted(note.deletedAt, note.editedAt) && isWritten(note.text);
}

function isWritten(text: string): boolean {
  return /\S/.test(text);
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
  // A read that failed is let go, so the next look tries again.
  return (entry.loading ??= read(id).catch((error: unknown) => {
    entry.loading = undefined;
    throw error;
  }));
}

/** Loads the note from disk, with any changes a closing page left unsaved. */
async function read(id: string): Promise<Y.Doc | null> {
  const [value, known] = await Promise.all([db.get("docs", id), db.get("notes", id)]);
  const stored = value === undefined ? undefined : parseStored(value);
  const entry = entries.get(id);
  // Another call may have made the note meanwhile.
  if (entry?.doc) return entry.doc;
  const unsaved = rescued(id);
  if (!stored && !unsaved) {
    // Not on disk, so the next look reads again.
    if (entry?.note) entry.loading = undefined;
    else entries.delete(id);
    return null;
  }
  const doc = new Y.Doc();
  if (stored) Y.applyUpdate(doc, stored.state, Disk);
  adopt(id, doc);
  if (stored) entryFor(id).seen = `${stored.writer}:${stored.rev}`;
  // A dirty note may hold words another tab couldn't send, so the next send from this tab has to be the whole note.
  if (known !== undefined && parseRow(known).dirty) listener(id, null);
  if (unsaved) {
    // With no origin, the copy counts as a change made here, so it gets saved and sent.
    Y.applyUpdate(doc, unsaved);
    // If nothing changed, the save had finished after all. Only a save clears the copy, and saves run on changes.
    if (!entries.get(id)?.pending) storage.remove(Rescued + id);
  }
  return doc;
}

function adopt(id: string, doc: Y.Doc): Y.Doc {
  const entry = entryFor(id);
  entry.doc = doc;
  entry.loading = Promise.resolve(doc);
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === Disk) return listener(id, null);
    if (origin !== Remote) {
      entry.unsaved = true;
      entry.generation++;
      listener(id, update);
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

/** Merges in what another tab saved since this one last looked. */
async function catchUp(id: string, doc: Y.Doc) {
  const value = await db.get("docs", id);
  if (value === undefined || entries.get(id)?.doc !== doc) return;
  const stored = parseStored(value);
  Y.applyUpdate(doc, stored.state, Disk);
  entryFor(id).seen = `${stored.writer}:${stored.rev}`;
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
  let stamp: string | undefined;
  entry.saving++;
  const saved = await store((tx) => {
    const docs = tx.objectStore("docs");
    const rows = tx.objectStore("notes");
    const before = docs.get(id);
    const known = rows.get(id);
    // Requests in a transaction finish in order, so by now both have.
    known.onsuccess = () => {
      const stored = before.result === undefined ? undefined : parseStored(before.result);
      if (stored && entry.seen !== `${stored.writer}:${stored.rev}`) Y.applyUpdate(doc, stored.state, Disk);
      const rev = (stored?.rev ?? 0) + 1;
      docs.put({ state: Y.encodeStateAsUpdate(doc), writer: TabId, rev } satisfies Stored, id);
      stamp = entry.seen = `${TabId}:${rev}`;
      const dirty = local || (known.result !== undefined && parseRow(known.result).dirty);
      rows.put({ ...summarize(id, doc), vector: Y.encodeStateVector(doc), dirty } satisfies Row);
    };
  });
  entry.saving--;
  if (!saved && local) entry.unsaved = true;
  if (!stamp || !saved || entries.get(id) !== entry) return;
  // A rescued copy may be newer than what this save wrote, so only the note's last save clears it.
  if (!isWriting(entry)) storage.remove(Rescued + id);
  // The note may have changed while the write was on its way (a sync, an undo), so describe it as it is now.
  post({ type: "note", note: refresh(id, doc), stamp });
}

async function purge(id: string) {
  forget(id);
  storage.remove(Rescued + id);
  post({ type: "purge", id });
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
    await db.write(work);
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
  const since = await db.get("meta", "since");
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
  // In slices, since spreading a large array into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** Holds changes that aren't on disk for good: a save waits, is on its way, or failed. */
function isWriting(entry: Entry): boolean {
  return entry.unsaved || Boolean(entry.pending) || entry.saving > 0;
}

function post(message: TabMessage) {
  channel.postMessage(message);
}

function keep({ id, text, createdAt, editedAt, deletedAt }: Note) {
  entryFor(id).note = { id, text, createdAt, editedAt, deletedAt };
  sorted = null;
}

function refresh(id: string, doc: Y.Doc): Note {
  const note = summarize(id, doc);
  entryFor(id).note = note;
  sorted = null;
  changed();
  return note;
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

function parseNote(value: unknown): Note {
  if (!isRecord(value)) throw new Error("read note: not a record");
  const { id, text, createdAt, editedAt, deletedAt } = value;
  if (
    typeof id !== "string" ||
    typeof text !== "string" ||
    typeof createdAt !== "number" ||
    typeof editedAt !== "number" ||
    (deletedAt !== null && typeof deletedAt !== "number")
  )
    throw new Error("read note: unexpected fields");
  return { id, text, createdAt, editedAt, deletedAt };
}

function parseRow(value: unknown): Row {
  const note = parseNote(value);
  if (!isRecord(value) || !(value.vector instanceof Uint8Array) || typeof value.dirty !== "boolean")
    throw new Error("read note: unexpected fields");
  return { ...note, vector: value.vector, dirty: value.dirty };
}

function parseStored(value: unknown): Stored {
  if (!isRecord(value)) throw new Error("read note state: not a record");
  const { state, writer, rev } = value;
  if (!(state instanceof Uint8Array) || typeof writer !== "string" || typeof rev !== "number")
    throw new Error("read note state: unexpected fields");
  return { state, writer, rev };
}

function parseMessage(data: unknown): TabMessage {
  if (isRecord(data)) {
    const { type, id, note, stamp } = data;
    if (type === "note" && typeof stamp === "string") return { type, note: parseNote(note), stamp };
    if (type === "purge" && typeof id === "string") return { type, id };
  }
  throw new Error("tab message: unexpected shape");
}
