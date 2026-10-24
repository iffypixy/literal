import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import { decode, encode, isNoteId, MAX_BYTES, MAX_NOTES, SIGNED_OUT, type Message } from "../../protocol/protocol.ts";
import type { Env } from "./index.ts";

/**
 * A note's Yjs state can't outgrow a SQLite row (2 MB here). A note of MAX_LENGTH characters stays under this
 * however it was written: typed a letter at a time, each in a new spot, in Chinese, its state comes to 1.8 MB.
 */
const MAX_STATE = 1_900_000;
/**
 * Deleted notes don't count toward the limits, yet keep their text for 30 days. So that nobody can fill an account
 * with deleted notes, everything stored has a ceiling too: twice the limits, which using the app never reaches.
 */
const CEILING_NOTES = 2 * MAX_NOTES;
const CEILING_BYTES = 2 * MAX_BYTES;
/** Merged updates keep deleted text around; every so often the state is rebuilt without it. */
const COMPACT_EVERY = 200;
/** How long a deleted note's text is kept, in case a device that hasn't heard of the delete edits it again. */
const KEEP_DELETED = 30 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
/** The largest catch-up message, in bytes of updates; a new device gets several. */
const BATCH = 2 * 1024 * 1024;
/** An empty state vector (no clients), spelled out: Workers allow no random ids, like a new Y.Doc's, at load. */
const NOTHING = new Uint8Array([0]);

type Row = { id: string; state: ArrayBuffer; vector: ArrayBuffer; updated_at: number };

/** One per user: holds every note they have, and relays changes live between their devices. */
export class UserNotes extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Updates merged into each note since it was last compacted. Kept in memory: losing it only delays a compaction. */
  private merges = new Map<string, number>();
  /** The last `updated_at` given out: each write gets a later one, so `since` never misses a write. */
  private last = 0;
  /** Bytes of every note's state, deleted ones too: while that's within MAX_BYTES, no write needs a closer look. */
  private stored = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Answered without waking the object: devices ping to learn their connection is still alive.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // `deleted` and `checked_at`: whether the note was deleted as of when that was last read from its state.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, state BLOB NOT NULL, vector BLOB NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL DEFAULT 0)",
    );
    const columns = this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('notes')").toArray();
    if (!columns.some((column) => column.name === "deleted")) {
      this.sql.exec("ALTER TABLE notes ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
      this.sql.exec("ALTER TABLE notes ADD COLUMN checked_at INTEGER NOT NULL DEFAULT 0");
    }
    this.sql.exec("CREATE TABLE IF NOT EXISTS purged (id TEXT PRIMARY KEY)");
    const totals = this.sql
      .exec<{ last: number | null; stored: number }>(
        "SELECT MAX(updated_at) AS last, COALESCE(SUM(LENGTH(state)), 0) AS stored FROM notes",
      )
      .one();
    this.last = totals.last ?? 0;
    this.stored = totals.stored;
  }

  override async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, data: ArrayBuffer | string) {
    if (typeof data === "string") {
      socket.close(1003, "binary messages only");
      return;
    }
    let message: Message;
    try {
      message = decode(new Uint8Array(data));
      if (message.type === "hello") this.hello(socket, message.since, message.notes);
      else if (message.type === "update") this.update(socket, message.seq, message.id, message.update);
      else socket.close(1008, `unexpected ${message.type}`);
    } catch (error) {
      console.error("sync: bad message", error);
      socket.close(1007, "malformed message");
    }
  }

  override async webSocketClose(socket: WebSocket, code: number) {
    // Completes the closing handshake. 1005 and 1006 only describe a close, and can't be sent back.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed: newer runtimes answer the close themselves.
    }
  }

  /** Once a day: erases deleted notes whose 30 days are up, here and on every device. */
  override async alarm() {
    const now = Date.now();
    const ids: string[] = [];
    for (const row of this.sql.exec<{ id: string; state: ArrayBuffer }>("SELECT id, state FROM notes")) {
      const deletedAt = deletedSince(new Uint8Array(row.state));
      if (deletedAt === null || now - deletedAt <= KEEP_DELETED) continue;
      ids.push(row.id);
      this.stored -= row.state.byteLength;
    }
    for (const id of ids) {
      this.sql.exec("DELETE FROM notes WHERE id = ?", id);
      this.sql.exec("INSERT OR IGNORE INTO purged (id) VALUES (?)", id);
    }
    if (ids.length) this.broadcast(encode({ type: "purge", ids }));
    await this.ctx.storage.setAlarm(now + DAY);
  }

  /** Erases everything: the account is being deleted. */
  async wipe() {
    for (const socket of this.ctx.getWebSockets()) socket.close(SIGNED_OUT, "account deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private hello(socket: WebSocket, since: number, notes: { id: string; vector: Uint8Array; dirty: boolean }[]) {
    const theirs = new Map(notes.filter((note) => isNoteId(note.id)).map((note) => [note.id, note]));
    const purged = new Set(
      this.sql
        .exec<{ id: string }>("SELECT id FROM purged")
        .toArray()
        .map((row) => row.id),
    );
    const gone = [...theirs.keys()].filter((id) => purged.has(id));
    if (gone.length) socket.send(encode({ type: "purge", ids: gone }));

    // Everything written up to now goes out below; anything later reaches the device live.
    const now = this.last;
    let batch: { id: string; update: Uint8Array | null; vector: Uint8Array | null }[] = [];
    let size = 0;
    for (const row of this.sql.exec<Row>("SELECT id, state, vector, updated_at FROM notes")) {
      const their = theirs.get(row.id);
      theirs.delete(row.id);
      const changed = row.updated_at > since;
      if (!changed && !their?.dirty) continue;
      const state = new Uint8Array(row.state);
      // A diff always carries every deletion, since a state vector can't say which deletions the device has seen.
      const update = changed ? (their ? Y.diffUpdate(state, their.vector) : state) : null;
      batch.push({ id: row.id, update, vector: their?.dirty ? new Uint8Array(row.vector) : null });
      size += update?.byteLength ?? 0;
      if (size > BATCH) {
        socket.send(encode({ type: "catch-up", done: false, now, notes: batch }));
        batch = [];
        size = 0;
      }
    }
    // Dirty notes the server has never seen: an empty state vector asks the device for all of each.
    for (const note of theirs.values()) {
      if (note.dirty && !purged.has(note.id)) batch.push({ id: note.id, update: null, vector: NOTHING });
    }
    socket.send(encode({ type: "catch-up", done: true, now, notes: batch }));
  }

  private update(socket: WebSocket, seq: number, id: string, update: Uint8Array) {
    if (!isNoteId(id)) throw new Error(`update: bad note id ${JSON.stringify(id)}`);
    if (this.sql.exec("SELECT 1 FROM purged WHERE id = ?", id).toArray().length) {
      socket.send(encode({ type: "ack", seq }));
      return;
    }
    const row = this.sql.exec<{ state: ArrayBuffer }>("SELECT state FROM notes WHERE id = ?", id).toArray()[0];
    const before = row?.state.byteLength ?? 0;
    let state = row ? Y.mergeUpdates([new Uint8Array(row.state), update]) : update;
    let merges = (this.merges.get(id) ?? 0) + 1;
    // Near a limit, the note is measured by what it holds, not by the deleted text that merging keeps around.
    if (
      merges >= COMPACT_EVERY ||
      state.byteLength > MAX_STATE ||
      this.stored - before + state.byteLength > MAX_BYTES
    ) {
      state = compact(state);
      merges = 0;
    }
    if (!row && this.tooMany(state)) {
      socket.send(encode({ type: "refused", seq, reason: "too-many" }));
      return;
    }
    if (state.byteLength > MAX_STATE) {
      socket.send(encode({ type: "refused", seq, reason: "too-large" }));
      return;
    }
    if (this.tooFull(id, before, state)) {
      socket.send(encode({ type: "refused", seq, reason: "too-full" }));
      return;
    }
    this.merges.set(id, merges);
    this.last = Math.max(Date.now(), this.last + 1);
    this.sql.exec(
      "INSERT INTO notes (id, state, vector, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, vector = excluded.vector, updated_at = excluded.updated_at",
      id,
      buffer(state),
      buffer(Y.encodeStateVectorFromUpdate(state)),
      this.last,
    );
    this.stored += state.byteLength - before;
    socket.send(encode({ type: "ack", seq }));
    this.broadcast(encode({ type: "update", seq: 0, id, update }), socket);
  }

  /**
   * Whether a new note, `state`, is one more than the account may hold. Only notes it still has count: a deleted
   * one, kept 30 days so other devices hear of it, doesn't.
   */
  private tooMany(state: Uint8Array): boolean {
    const count = (query: string) => this.sql.exec<{ count: number }>(query).one().count;
    const all = count("SELECT COUNT(*) AS count FROM notes");
    if (all < MAX_NOTES) return false;
    if (all >= CEILING_NOTES) return true;
    if (deletedSince(state) !== null) return false;
    this.checkDeleted();
    return count("SELECT COUNT(*) AS count FROM notes WHERE deleted = 0") >= MAX_NOTES;
  }

  /**
   * Whether the note, grown from `before` bytes to `state`, takes the account past MAX_BYTES. Only notes it still
   * has count: deleting one makes room, and goes through itself, as does any change that doesn't grow a note.
   */
  private tooFull(id: string, before: number, state: Uint8Array): boolean {
    const growth = state.byteLength - before;
    if (growth <= 0 || this.stored + growth <= MAX_BYTES) return false;
    if (this.stored + growth > CEILING_BYTES) return true;
    if (deletedSince(state) !== null) return false;
    this.checkDeleted();
    const others = this.sql
      .exec<{ bytes: number }>(
        "SELECT COALESCE(SUM(LENGTH(state)), 0) AS bytes FROM notes WHERE deleted = 0 AND id != ?",
        id,
      )
      .one().bytes;
    return others + state.byteLength > MAX_BYTES;
  }

  /**
   * Brings every note's `deleted` up to date. Reading a note's state to know is slow, so it's done only near a
   * limit, and only for notes changed since they were last read.
   */
  private checkDeleted() {
    for (;;) {
      const stale = this.sql
        .exec<{ id: string; state: ArrayBuffer }>("SELECT id, state FROM notes WHERE checked_at < updated_at LIMIT 100")
        .toArray();
      if (!stale.length) break;
      for (const note of stale) {
        const deleted = deletedSince(new Uint8Array(note.state)) === null ? 0 : 1;
        this.sql.exec("UPDATE notes SET deleted = ?, checked_at = updated_at WHERE id = ?", deleted, note.id);
      }
    }
  }

  private broadcast(message: Uint8Array, except?: WebSocket) {
    for (const socket of this.ctx.getWebSockets()) if (socket !== except) socket.send(message);
  }
}

/** When the note in `state` was deleted, or null if it wasn't (or was edited again since). */
function deletedSince(state: Uint8Array): number | null {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const meta = doc.getMap<number>("meta");
  const deletedAt = meta.get("deletedAt");
  const editedAt = meta.get("editedAt") ?? 0;
  doc.destroy();
  return deletedAt !== undefined && deletedAt >= editedAt ? deletedAt : null;
}

/** The same state, rebuilt without the text that was deleted from it. */
function compact(state: Uint8Array): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const out = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return out;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
