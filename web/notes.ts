import { createSignal } from "solid-js";
import { createMutable } from "solid-js/store";
import * as Y from "yjs";
import * as z from "zod/mini";
import { isDeleted, isDocDeleted, lastEdited, markEdited, newId, type MessageOf } from "#/protocol.ts";
import { account } from "#/web/account.ts";
import { openDb } from "#/web/notes-db.ts";
import * as rescued from "#/web/notes-rescue.ts";

// What's read back from disk, or from another tab, was written by this app, but maybe by an older version of it. So
// these shapes only ever grow, and `deletedAt` stays null when there's none, as older versions read it.

const BytesSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array);

/** What the list and search know about a note. The note itself is a Yjs doc of its `text`, `meta` and `edits` times. */
export const NoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.number(),
  editedAt: z.number(),
  /** An edit made after it brings the note back, so no device ever loses words. */
  deletedAt: z.nullable(z.number()),
});
export type Note = z.infer<typeof NoteSchema>;

// A note as stored for the list and sync. `dirty`: it has changes the server hasn't acked.
const RowSchema = z.extend(NoteSchema, { vector: BytesSchema, dirty: z.boolean() });
type Row = z.infer<typeof RowSchema>;

// A note's Yjs state, stamped `writer:rev` by the tab that last wrote it, so a tab that finds its own knows nobody has.
const StoredSchema = z.object({ state: BytesSchema, writer: z.string(), rev: z.number() });
type Stored = z.infer<typeof StoredSchema>;

// `stamp`: the stored state the save left on disk.
const TabMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("note"), note: NoteSchema, stamp: z.string() }),
  z.object({ type: z.literal("purge"), id: z.string() }),
]);
type TabMessage = z.infer<typeof TabMessageSchema>;

// Everything this tab knows about one note.
type Entry = {
  /** As the list shows it. */
  note?: Note;
  doc?: Y.Doc;
  /** The doc on its way from disk, or already here. */
  loading: Promise<Y.Doc | undefined> | null;
  /** The stored state's stamp that the doc already holds. */
  seen?: string;
  /** Set while a save is waiting: its timer, and when the first change came. */
  pending: { timer: ReturnType<typeof setTimeout>; since: number } | null;
  /** Saves still on their way to disk. Until they land, a closing page has to rescue the note too. */
  saving: number;
  /** When typing last moved `editedAt`. */
  touchedAt: number;
  /** Changed here since its last save. */
  unsaved: boolean;
  /** Counts changes made here. An ack marks the note clean only if no change came after the ones it covers. */
  generation: number;
};

type Opened = { ok: true; text: Y.Text } | { ok: false; reason: "notFound" | "unreadable" };

// What sync hears: a change made here, or a note whose changes this tab didn't make and may not have been sent.
type Listeners = { onChange: (id: string, update: Uint8Array) => void; onBehind: (id: string) => void };

// Where a change from outside this tab came from: disk, where another tab saved it, or the server.
const Disk = "disk";
const Remote = "remote";

// A pause in typing this long saves; so does typing this long without one.
const SaveDelayMs = 250;
const SaveAtMostMs = 1000;
// Often enough to sort by, rarely enough not to bloat the doc.
const TouchEveryMs = 1000;

const tabId = crypto.randomUUID();

/**
 * `ready`: every note has been read from disk.
 * `failed`: reading or writing the disk failed, so changes may live only in memory.
 * `synced`: this device has caught up with its account at least once, so its list is the whole list.
 */
export const library = createMutable({ ready: false, failed: false, synced: false });

// Reading anything below tracks `changes`; every change to a note calls `changed`.
const [changes, changed] = createSignal(undefined, { equals: false });

const entries = new Map<string, Entry>();
let sorted: Note[] | null = null;
let listeners: Listeners = { onChange: () => {}, onBehind: () => {} };
let started: Promise<void> | undefined;
// Everything here is being erased, so nothing may be saved or rescued from now on.
let wiped = false;

const db = openDb((event) => {
  // Another tab is erasing everything (signing out, deleting the account) or needs a newer database, so this one
  // starts over too. After an erase nothing unsaved may be rescued. After an upgrade, the new version saves it.
  wiped ||= event.newVersion === null;
  location.replace("/");
});
// Tabs of different versions talk over it, which is why its messages keep `type`.
const channel = new BroadcastChannel("literal");

// A phone may close a hidden page without warning, so the notes save now and keep a copy that's written at once.
addEventListener("pagehide", saveNow);
document.addEventListener("visibilitychange", () => document.hidden && saveNow());

channel.onmessage = ({ data }: MessageEvent<unknown>) => {
  const message = TabMessageSchema.parse(data);
  switch (message.type) {
    case "note": {
      keep(message.note);
      changed();
      const entry = entries.get(message.note.id);
      if (entry?.doc && entry.seen !== message.stamp) void catchUp(message.note.id, entry.doc);
      return;
    }
    case "purge": {
      // A change here that isn't on disk for good stays, and saving it again brings the note back.
      const entry = entries.get(message.id);
      if (!entry) return;
      if (!isWriting(entry)) return forget(message.id);
      entry.unsaved = true;
      schedule(entry, message.id);
    }
  }
};

/**
 * Reads every note's summary once, putting back what a closing page left unsaved. Signed out, it clears out deleted
 * and empty notes.
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
    const same = known?.text === note.text && known.editedAt === note.editedAt && known.deletedAt === note.deletedAt;
    if (!same) keep(note);
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
  entryFor(id).touchedAt = Date.now();
  return { id, text: doc.getText("text") };
}

export function add(text: string, at: number) {
  const note = create(at);
  note.text.insert(0, text);
  void save(note.id);
}

/** A deleted note isn't found. */
export async function open(id: string): Promise<Opened> {
  let doc: Y.Doc | undefined;
  try {
    doc = await load(id);
  } catch (error) {
    console.error(error);
    return { ok: false, reason: "unreadable" };
  }
  if (!doc || isDocDeleted(doc)) return { ok: false, reason: "notFound" };
  return { ok: true, text: doc.getText("text") };
}

/** Whether there was a note to delete. One that can't be read stays, and the corner says why. */
export async function remove(id: string): Promise<boolean> {
  const doc = await loadOrFail(id);
  if (!doc) return false;

  // Never before its last edit, which a device with its clock ahead may have put in the future.
  doc.getMap<number>("meta").set("deletedAt", Math.max(Date.now(), lastEdited(doc)));
  refresh(id, doc);
  return true;
}

/** Whether there was a note to bring back. */
export async function restore(id: string): Promise<boolean> {
  const doc = await loadOrFail(id);
  if (!doc) return false;

  doc.getMap<number>("meta").delete("deletedAt");
  refresh(id, doc);
  return true;
}

/** Once a delete's Undo has passed. Signed out, the note is erased. Signed in, its tombstone stays, to sync. */
export function settle(id: string) {
  const note = entries.get(id)?.note;
  if (!isSignedIn() && note && isDeleted(note.deletedAt, note.editedAt)) void purge(id);
}

export function discardIfEmpty(id: string) {
  const doc = entries.get(id)?.doc;
  if (!doc || hasWords(doc.getText("text").toString())) return;

  if (isSignedIn()) void remove(id);
  else void purge(id);
}

/** Saves every change still waiting, then waits for saves under way, since an empty write lands after them all. */
export async function flush() {
  await Promise.all([...entries].filter(([, entry]) => entry.pending).map(([id]) => save(id)));
  await store(() => {});
}

/** Erases every note on this device. Deleting the database sends every other tab back to the start. */
export async function wipe() {
  wiped = true;
  try {
    await db.erase();
  } catch (cause) {
    // Still here, so what's typed next is still kept, or its failure shown.
    wiped = false;
    throw new Error("wipe notes", { cause });
  }
  for (const id of rescued.ids()) rescued.drop(id);
}

/** Notes with changes the server hasn't acked. Read from disk, since another tab may have sent or saved them. */
export async function unsynced(): Promise<number> {
  await flush();
  // Changes whose save failed live only in memory.
  const ids = new Set([...entries].filter(([, entry]) => entry.unsaved).map(([id]) => id));
  for await (const rows of db.notes((value) => RowSchema.parse(value))) {
    for (const row of rows) if (row.dirty) ids.add(row.id);
  }
  return ids.size;
}

export function listen(next: Listeners) {
  listeners = next;
}

export async function hello(): Promise<Omit<MessageOf<"hello">, "kind">> {
  await start();
  await flush();
  const since = (await readSince()) ?? 0;
  const notes: MessageOf<"hello">["notes"] = [];
  for await (const rows of db.notes((value) => RowSchema.parse(value))) {
    for (const { id, vector, dirty } of rows) notes.push({ id, vector, dirty });
  }
  return { since, notes };
}

/**
 * Applies a change from the server, creating the note if it's new here. Words arriving for a note deleted here were
 * written by someone who hadn't seen the delete, so the note comes back with them.
 */
export async function receive(id: string, update: Uint8Array) {
  const doc = (await load(id)) ?? adopt(id, new Y.Doc());
  const wasDeleted = isDocDeleted(doc);

  let wrote = false;
  const text = doc.getText("text");
  const watch = () => (wrote = true);
  text.observe(watch);
  try {
    Y.applyUpdate(doc, update, Remote);
  } finally {
    text.unobserve(watch);
  }

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
    const unsent = entries.get(id)?.unsaved || isDirty(row);
    if (doc && unsent && !isDocDeleted(doc)) add(doc.getText("text").toString(), lastEdited(doc));
    await purge(id);
  });
}

/** What this device has that the server, at `vector`, doesn't, with every deletion. Without a vector, all of it. */
export async function missing(id: string, vector?: Uint8Array): Promise<Uint8Array | undefined> {
  const doc = await load(id);
  return doc && Y.encodeStateAsUpdate(doc, vector);
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
  if (await store((transaction) => transaction.objectStore("meta").put(now, "since"))) library.synced = true;
}

/**
 * The account this device synced with is gone, deleted or signed out elsewhere. Whichever one it signs in to next must
 * hear about every note here, and get everything it has.
 */
export async function unsync() {
  await start();
  const done = await store((transaction) => {
    transaction.objectStore("meta").delete("since");
    const cursor = transaction.objectStore("notes").openCursor();
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      const row = RowSchema.parse(cursor.result.value);
      if (!row.dirty) cursor.result.update({ ...row, dirty: true } satisfies Row);
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

  await store((transaction) => {
    const rows = transaction.objectStore("notes");
    const known = rows.get(id);
    const stored = transaction.objectStore("docs").get(id);
    // Requests in a transaction finish in order, so by now both have.
    stored.onsuccess = () => {
      if (known.result === undefined || stored.result === undefined) return;
      // Another tab saved since this one last looked, and its changes may not have reached the server.
      if (stampOf(StoredSchema.parse(stored.result)) !== entry.seen) return;
      rows.put({ ...RowSchema.parse(known.result), dirty: false } satisfies Row);
    };
  });
}

async function readEverything() {
  try {
    const kept = new Set(rescued.ids());
    for await (const rows of db.notes((value) => RowSchema.parse(value))) {
      for (const row of rows) {
        // A save that landed while this read was under way knows better, such as a delete Undo may yet take back.
        if (entries.get(row.id)?.note) continue;
        // Words a closing page left unsaved may bring a deleted or empty note back, so it waits for them.
        if (!isSignedIn() && !kept.has(row.id) && !isLive(row)) void purge(row.id);
        else keep(row);
      }
    }
    for (const id of kept) await load(id);
    library.synced = (await readSince()) !== undefined;
  } catch (error) {
    failed(error);
  }

  library.ready = true;
  changed();
}

// As the page goes away, keeps every unsaved change somewhere that's written at once, until the next start.
function saveNow() {
  if (!wiped) {
    for (const [id, entry] of entries) {
      if (!entry.doc || !isWriting(entry)) continue;
      // Without storage, the IndexedDB save started alongside is all there is.
      if (!rescued.keep(id, Y.encodeStateAsUpdate(entry.doc))) console.error(`rescue ${id}: no storage`);
    }
  }
  void flush();
}

// Signed in, deleted notes stay as tombstones so other devices learn of the delete. Signed out, they're erased.
function isSignedIn(): boolean {
  return account.email !== null;
}

function isLive(note: Note): boolean {
  return !isDeleted(note.deletedAt, note.editedAt) && hasWords(note.text);
}

function hasWords(text: string): boolean {
  return /\S/.test(text);
}

// Holds changes that aren't on disk for good: a save waits, is on its way, or failed.
function isWriting(entry: Entry): boolean {
  return entry.unsaved || Boolean(entry.pending) || entry.saving > 0;
}

// A missing row has no changes the server hasn't acked.
function isDirty(row: unknown): boolean {
  return row !== undefined && RowSchema.parse(row).dirty;
}

function entryFor(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = { loading: null, pending: null, saving: 0, touchedAt: 0, unsaved: false, generation: 0 };
    entries.set(id, entry);
  }
  return entry;
}

function load(id: string): Promise<Y.Doc | undefined> {
  const entry = entryFor(id);
  return (entry.loading ??= readOrLetGo(id, entry));
}

// A read that failed is let go, so the next look tries again.
async function readOrLetGo(id: string, entry: Entry): Promise<Y.Doc | undefined> {
  try {
    return await read(id);
  } catch (error) {
    entry.loading = null;
    throw error;
  }
}

// The failure shows in the corner.
async function loadOrFail(id: string): Promise<Y.Doc | undefined> {
  try {
    return await load(id);
  } catch (error) {
    failed(error);
    return undefined;
  }
}

// Loads the note from disk, with any changes a closing page left unsaved.
async function read(id: string): Promise<Y.Doc | undefined> {
  const [value, known] = await Promise.all([db.get("docs", id), db.get("notes", id)]);
  const stored = value === undefined ? undefined : StoredSchema.parse(value);
  const entry = entries.get(id);
  // Another call may have made the note meanwhile.
  if (entry?.doc) return entry.doc;

  const unsaved = rescued.read(id);
  if (!stored && !unsaved) {
    // Not on disk, so the next look reads again.
    if (entry?.note) entry.loading = null;
    else entries.delete(id);
    return undefined;
  }

  const doc = new Y.Doc();
  if (stored) Y.applyUpdate(doc, stored.state, Disk);
  adopt(id, doc);
  if (stored) entryFor(id).seen = stampOf(stored);
  // A dirty note may hold words another tab couldn't send.
  if (isDirty(known)) listeners.onBehind(id);

  if (unsaved) {
    // With no origin, the copy counts as a change made here, so it gets saved and sent.
    Y.applyUpdate(doc, unsaved);
    // If nothing changed, the save had finished after all. Only a save clears the copy, and saves run on changes.
    if (!entries.get(id)?.pending) rescued.drop(id);
  }
  return doc;
}

function adopt(id: string, doc: Y.Doc): Y.Doc {
  const entry = entryFor(id);
  entry.doc = doc;
  entry.loading = Promise.resolve(doc);

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === Disk) return listeners.onBehind(id);
    if (origin !== Remote) {
      entry.unsaved = true;
      entry.generation++;
      listeners.onChange(id, update);
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
  const delayMs = Math.min(SaveDelayMs, since + SaveAtMostMs - now);
  entry.pending = { since, timer: setTimeout(() => void save(id), delayMs) };
}

function touch(entry: Entry, doc: Y.Doc) {
  const now = Date.now();
  if (now - entry.touchedAt < TouchEveryMs) return;
  entry.touchedAt = now;
  // Yjs runs observers inside the transaction; a change made from one belongs in its own.
  queueMicrotask(() => markEdited(doc, now));
}

// Merges in what another tab saved since this one last looked.
async function catchUp(id: string, doc: Y.Doc) {
  try {
    const value = await db.get("docs", id);
    if (value === undefined || entries.get(id)?.doc !== doc) return;
    const stored = StoredSchema.parse(value);
    Y.applyUpdate(doc, stored.state, Disk);
    entryFor(id).seen = stampOf(stored);
  } catch (error) {
    failed(error);
  }
}

// Writes the note to disk, first merging in whatever another tab wrote there since this one last looked.
async function save(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  clearTimeout(entry.pending?.timer);
  entry.pending = null;
  const doc = entry.doc;
  if (!doc || wiped) return;

  const local = entry.unsaved;
  entry.unsaved = false;
  let stamp: string | undefined;
  entry.saving++;
  const saved = await store((transaction) => {
    const docs = transaction.objectStore("docs");
    const rows = transaction.objectStore("notes");
    const before = docs.get(id);
    const known = rows.get(id);
    // Requests in a transaction finish in order, so by now both have.
    known.onsuccess = () => {
      const stored = before.result === undefined ? undefined : StoredSchema.parse(before.result);
      if (stored && entry.seen !== stampOf(stored)) Y.applyUpdate(doc, stored.state, Disk);
      const next: Stored = { state: Y.encodeStateAsUpdate(doc), writer: tabId, rev: (stored?.rev ?? 0) + 1 };
      docs.put(next, id);
      stamp = entry.seen = stampOf(next);
      const dirty = local || isDirty(known.result);
      rows.put({ ...summarize(id, doc), vector: Y.encodeStateVector(doc), dirty } satisfies Row);
    };
  });
  entry.saving--;
  if (!saved && local) entry.unsaved = true;
  if (!stamp || !saved || entries.get(id) !== entry) return;

  // A rescued copy may be newer than what this save wrote, so only the note's last save clears it.
  if (!isWriting(entry)) rescued.drop(id);
  // The note may have changed while the write was on its way (a sync, an undo), so describe it as it is now.
  channel.postMessage({ type: "note", note: refresh(id, doc), stamp } satisfies TabMessage);
}

async function purge(id: string) {
  forget(id);
  rescued.drop(id);
  channel.postMessage({ type: "purge", id } satisfies TabMessage);
  await store((transaction) => {
    transaction.objectStore("docs").delete(id);
    transaction.objectStore("notes").delete(id);
  });
}

// Lets go of the note in this tab alone, as if it had never been here.
function forget(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  clearTimeout(entry.pending?.timer);
  entry.doc?.destroy();
  entries.delete(id);
  sorted = null;
  changed();
}

// A failure shows in the corner, since every later write would fail too.
async function store(work: (transaction: IDBTransaction) => void): Promise<boolean> {
  if (wiped) return false;
  try {
    await db.write(work);
    return true;
  } catch (error) {
    failed(error);
    return false;
  }
}

function failed(error: unknown) {
  library.failed = true;
  console.error(error);
}

async function readSince(): Promise<number | undefined> {
  return z.optional(z.number()).parse(await db.get("meta", "since"));
}

function keep({ id, text, createdAt, editedAt, deletedAt }: Note) {
  entryFor(id).note = { id, text, createdAt, editedAt, deletedAt };
  sorted = null;
}

function refresh(id: string, doc: Y.Doc): Note {
  const note = summarize(id, doc);
  keep(note);
  changed();
  return note;
}

function stampOf({ writer, rev }: Stored): string {
  return `${writer}:${rev}`;
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
