import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import {
  decode,
  encode,
  isDocDeleted,
  MaxBytes,
  MaxNotes,
  Ping,
  Pong,
  SignedOut,
  type Message,
  type MessageOf,
  type Refusal,
} from "#/protocol.ts";
import type { Env } from "#/server/index.ts";

// A note's state rebuilt without the text deleted from it, and whether the note is deleted.
type Read = { state: Uint8Array; deleted: boolean };

/** How the Worker tells this object which session opened a socket. */
export const SessionHeader = "Literal-Session";

// Under a SQLite row's 2 MB. A note of MaxLength characters stays below it unless its history is pathological: typed a
// letter at a time, each in a new spot, in Chinese, it reaches 2.0 MB. Such a note stays on its device.
const MaxStateBytes = 1_900_000;
// Room for the few bytes a delete adds, still under the row's 2 MB, so a note's size never stops its delete.
const DeleteRoomBytes = 50_000;
// Deleted notes don't count toward the limits, yet keep their text for 30 days. So nobody can fill an account with
// them, everything stored has a ceiling too, at twice the limits, which using the app never reaches.
const CeilingNotes = 2 * MaxNotes;
const CeilingBytes = 2 * MaxBytes;
const DayMs = 24 * 60 * 60 * 1000;
// In case a device that hasn't heard of the delete edits the note again.
const KeepDeletedMs = 30 * DayMs;
const MaxBatchBytes = 2 * 1024 * 1024;
// Spelled out, since a new Y.Doc would need a random id, which Workers don't allow at load.
const emptyVector = new Uint8Array([0]);

/** One per user. It holds their notes, and relays changes live between their devices. */
export class UserNotes extends DurableObject<Env> {
  private sql: SqlStorage;
  // Each write gets a later `updated_at` than the last, so `since` never misses a write.
  private lastUpdatedAt = 0;
  // Every note's state, deleted ones too. While within MaxBytes, no write needs a closer look.
  private storedBytes = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(Ping, Pong));
    this.setUp();
  }

  private setUp() {
    this.ctx.storage.transactionSync(() => {
      // Reading a note is slow, so it's read (compacted, and checked for deletion) once a day, or near a limit.
      // `checked_at`: the `updated_at` it was last read at. `deleted_at`: set to that same time if the read found it
      // deleted, so its 30 days run from the last write to it.
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, state BLOB NOT NULL, vector BLOB NOT NULL, updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER)",
      );
      // To reach a column after `state`, SQLite steps through all of it, and these spare every scan that.
      this.sql.exec("CREATE INDEX IF NOT EXISTS notes_updated_at ON notes (updated_at)");
      this.sql.exec("CREATE INDEX IF NOT EXISTS notes_deleted_at ON notes (deleted_at)");
      this.sql.exec("CREATE INDEX IF NOT EXISTS notes_unchecked ON notes (id) WHERE checked_at < updated_at");
      this.sql.exec("CREATE TABLE IF NOT EXISTS purged (id TEXT PRIMARY KEY)");
    });
    this.lastUpdatedAt =
      this.sql.exec<{ last: number | null }>("SELECT MAX(updated_at) AS last FROM notes").one().last ?? 0;
    this.storedBytes = this.sql
      .exec<{ bytes: number }>("SELECT COALESCE(SUM(LENGTH(state)), 0) AS bytes FROM notes")
      .one().bytes;
  }

  override async fetch(request: Request): Promise<Response> {
    const session = request.headers.get(SessionHeader);
    if (session === null) throw new Error("connect: no session");
    const { 0: client, 1: server } = new WebSocketPair();
    // Tagged with its session, so signing out closes it.
    this.ctx.acceptWebSocket(server, [session]);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DayMs);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(socket: WebSocket, data: ArrayBuffer | string) {
    if (typeof data === "string") {
      socket.close(1003, "binary messages only");
      return;
    }
    let message: Message;
    try {
      message = decode(new Uint8Array(data));
    } catch {
      socket.close(1007, "malformed message");
      return;
    }
    try {
      switch (message.kind) {
        case "hello":
          return this.hello(socket, message);
        case "update":
          return this.update(socket, message);
        default:
          socket.close(1008, `unexpected ${message.kind}`);
      }
    } catch (error) {
      console.error(`sync: ${message.kind}`, error);
      socket.close(1011, "server error");
    }
  }

  /** Daily, reads the notes written since, and erases deleted ones whose 30 days are up, here and on every device. */
  override async alarm() {
    const now = Date.now();
    this.check();
    const purged = this.sql
      .exec<{ id: string; bytes: number }>(
        "DELETE FROM notes WHERE deleted_at <= ? RETURNING id, LENGTH(state) AS bytes",
        now - KeepDeletedMs,
      )
      .toArray();
    for (const note of purged) {
      this.sql.exec("INSERT OR IGNORE INTO purged (id) VALUES (?)", note.id);
      this.storedBytes -= note.bytes;
    }
    if (purged.length) this.broadcast(encode({ kind: "purge", ids: purged.map((note) => note.id) }));

    // An idle account sleeps. Notes are written only through a socket, and opening one sets the alarm again.
    const deleted = this.sql.exec("SELECT 1 FROM notes WHERE deleted_at IS NOT NULL LIMIT 1").toArray().length > 0;
    if (deleted || this.openSockets().length) await this.ctx.storage.setAlarm(now + DayMs);
  }

  async wipe() {
    for (const socket of this.openSockets()) socket.close(SignedOut, "account deleted");
    // The alarm goes too.
    await this.ctx.storage.deleteAll();
    // The object lives on, and if deleting the account fails after this, it can still be signed in to.
    this.setUp();
  }

  /** Sockets check their session only as they open, so they'd otherwise go on syncing. */
  signOut(session: string) {
    for (const socket of this.openSockets(session)) socket.close(SignedOut, "signed out");
  }

  private hello(socket: WebSocket, { since, notes }: MessageOf<"hello">) {
    const theirs = new Map(notes.map((note) => [note.id, note]));
    const gone = this.sql
      .exec<{ id: string }>(
        "SELECT id FROM purged WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify([...theirs.keys()]),
      )
      .toArray()
      .map((row) => row.id);
    if (gone.length) socket.send(encode({ kind: "purge", ids: gone }));
    for (const id of gone) theirs.delete(id);

    // Everything written up to now goes out below. Anything later reaches the device live.
    const now = this.lastUpdatedAt;
    let batch: MessageOf<"catchUp">["notes"] = [];
    let batchBytes = 0;
    const changed = this.sql.exec<{ id: string; state: ArrayBuffer; vector: ArrayBuffer }>(
      "SELECT id, state, vector FROM notes WHERE updated_at > ?",
      since,
    );
    for (const row of changed) {
      const their = theirs.get(row.id);
      theirs.delete(row.id);
      const state = new Uint8Array(row.state);
      // A diff always carries every deletion, since a state vector can't say which deletions the device has seen.
      const update = their ? Y.diffUpdate(state, their.vector) : state;
      if (batchBytes + update.byteLength > MaxBatchBytes) {
        socket.send(encode({ kind: "catchUp", done: false, now, notes: batch }));
        batch = [];
        batchBytes = 0;
      }
      batch.push({ id: row.id, update, vector: their?.dirty ? new Uint8Array(row.vector) : null });
      batchBytes += update.byteLength;
    }
    // The other dirty notes get the server's state vector, to send what it lacks. For a note it has never seen, an
    // empty one asks for all of it.
    for (const note of theirs.values()) {
      if (!note.dirty) continue;
      const row = this.sql.exec<{ vector: ArrayBuffer }>("SELECT vector FROM notes WHERE id = ?", note.id).toArray()[0];
      batch.push({ id: note.id, update: null, vector: row ? new Uint8Array(row.vector) : emptyVector });
    }
    socket.send(encode({ kind: "catchUp", done: true, now, notes: batch }));
  }

  private update(socket: WebSocket, { seq, id, update }: MessageOf<"update">) {
    // An update can arrive before its device's hello, so the device hears of the purge first, while the note is still
    // dirty there, and keeps any new words as a new note.
    if (this.sql.exec("SELECT 1 FROM purged WHERE id = ?", id).toArray().length) {
      socket.send(encode({ kind: "purge", ids: [id] }));
      socket.send(encode({ kind: "ack", seq }));
      return;
    }

    const row = this.sql
      .exec<{ state: ArrayBuffer; deleted_at: number | null }>("SELECT state, deleted_at FROM notes WHERE id = ?", id)
      .toArray()[0];
    const before = row?.state.byteLength ?? 0;
    const merged = row ? Y.mergeUpdates([new Uint8Array(row.state), update]) : update;

    // Only a new note, or one deleted when it was last read, can add to how many the account holds, so only then are
    // they counted.
    const addsOne = !row || row.deleted_at !== null;
    const notes = addsOne ? this.sql.exec<{ notes: number }>("SELECT COUNT(*) AS notes FROM notes").one().notes : 0;
    // Near a limit, the note is read, to measure it by what it holds rather than the deleted text merging keeps
    // around, and to count it only if it isn't deleted.
    const near =
      merged.byteLength > MaxStateBytes ||
      this.storedBytes - before + merged.byteLength > MaxBytes ||
      notes >= MaxNotes;
    const note = near ? read(merged) : null;
    const refusal = note && this.refusal(id, !row, notes, before, note);
    if (refusal) {
      socket.send(encode({ kind: "refused", seq, reason: refusal }));
      return;
    }

    const state = note?.state ?? merged;
    this.lastUpdatedAt = Math.max(Date.now(), this.lastUpdatedAt + 1);
    this.sql.exec(
      "INSERT INTO notes (id, state, vector, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, vector = excluded.vector, updated_at = excluded.updated_at",
      id,
      buffer(state),
      buffer(Y.encodeStateVectorFromUpdate(state)),
      this.lastUpdatedAt,
    );
    if (note) {
      this.sql.exec(
        "UPDATE notes SET checked_at = updated_at, deleted_at = ? WHERE id = ?",
        note.deleted ? this.lastUpdatedAt : null,
        id,
      );
    }
    this.storedBytes += state.byteLength - before;

    socket.send(encode({ kind: "ack", seq }));
    this.broadcast(encode({ kind: "update", seq: 0, id, update }), socket);
  }

  // Why the account can't take `note`, grown from `before` bytes, when it holds `notes` notes (0 if the note can't add
  // one). A deleted note, kept 30 days so other devices hear of it, counts only toward the ceilings. So a delete goes
  // through and makes room, and so does any change that doesn't grow a note, unless the account is at its ceiling.
  private refusal(id: string, isNew: boolean, notes: number, before: number, note: Read): Refusal | null {
    if (notes >= MaxNotes) {
      if (isNew && notes >= CeilingNotes) return "tooMany";
      if (!note.deleted && this.liveBesides(id).notes >= MaxNotes) return "tooMany";
    }

    if (note.state.byteLength > MaxStateBytes + (note.deleted ? DeleteRoomBytes : 0)) return "tooLarge";

    const growth = note.state.byteLength - before;
    if (growth > 0 && this.storedBytes + growth > MaxBytes) {
      if (this.storedBytes + growth > CeilingBytes) return "tooFull";
      if (!note.deleted && this.liveBesides(id).bytes + note.state.byteLength > MaxBytes) return "tooFull";
    }

    return null;
  }

  private liveBesides(id: string): { notes: number; bytes: number } {
    this.check(id);
    return this.sql
      .exec<{ notes: number; bytes: number }>(
        "SELECT COUNT(*) AS notes, COALESCE(SUM(LENGTH(state)), 0) AS bytes FROM notes WHERE deleted_at IS NULL AND id != ?",
        id,
      )
      .one();
  }

  // Reads every note written since it was last read, but `except`, which is about to be written anyway.
  private check(except?: string) {
    const ids = this.sql.exec<{ id: string }>("SELECT id FROM notes WHERE checked_at < updated_at").toArray();
    for (const { id } of ids) {
      if (id === except) continue;
      const row = this.sql
        .exec<{ state: ArrayBuffer; updated_at: number }>("SELECT state, updated_at FROM notes WHERE id = ?", id)
        .one();
      const note = read(new Uint8Array(row.state));
      this.sql.exec(
        "UPDATE notes SET state = ?, checked_at = updated_at, deleted_at = ? WHERE id = ?",
        buffer(note.state),
        note.deleted ? row.updated_at : null,
        id,
      );
      this.storedBytes += note.state.byteLength - row.state.byteLength;
    }
  }

  private broadcast(message: Uint8Array<ArrayBuffer>, except?: WebSocket) {
    for (const socket of this.openSockets()) if (socket !== except) socket.send(message);
  }

  // The sockets still open. A closing one stays listed until it's gone, and sending to it throws.
  private openSockets(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((socket) => socket.readyState === WebSocket.OPEN);
  }
}

function read(state: Uint8Array): Read {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  // The note's own times say whether it's deleted. The server's clock says only for how long.
  const deleted = isDocDeleted(doc);
  const compacted = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return { state: compacted, deleted };
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
