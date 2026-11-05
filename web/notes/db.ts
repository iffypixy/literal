type Store = "notes" | "docs" | "meta";

const Name = "literal";
const Version = 1;
/** Rows read at a time. */
const Batch = 500;

/** The database, held open. Each call waits for it to have opened. */
export type Db = {
  get: (store: Store, key: string) => Promise<unknown>;
  /** Every row of `notes`, a batch at a time, leaving the page free in between. */
  notes: <T extends { id: string }>(parse: (value: unknown) => T) => AsyncGenerator<T[]>;
  /** Over every store, and strict, so a note that counts as saved survives a power cut right after. */
  write: (work: (tx: IDBTransaction) => void) => Promise<void>;
  /** Closes the database and deletes it, which sends every other tab's connection to `onVersionChange`. */
  erase: () => Promise<void>;
};

/** `onVersionChange` runs when another tab deletes or upgrades the database, once this connection has let it go. */
export function openDb(onVersionChange: (event: IDBVersionChangeEvent) => void): Db {
  const db = open(onVersionChange);
  return {
    get: async (store, key) => done((await db).transaction(store).objectStore(store).get(key)),
    notes: async function* (parse) {
      let after: string | undefined;
      for (;;) {
        const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
        const rows = (await done((await db).transaction("notes").objectStore("notes").getAll(range, Batch))).map(parse);
        if (rows.length) yield rows;
        if (rows.length < Batch) return;
        after = rows.at(-1)?.id;
      }
    },
    write: async (work) => write(await db, work),
    erase: async () => {
      (await db).close();
      await erase();
    },
  };
}

function open(onVersionChange: (event: IDBVersionChangeEvent) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(Name, Version);
    request.onupgradeneeded = () => {
      // `notes`: what the list, search and sync read. `docs`: the Yjs state behind each. `meta`: the rest.
      request.result.createObjectStore("notes", { keyPath: "id" });
      request.result.createObjectStore("docs");
      request.result.createObjectStore("meta");
    };
    request.onsuccess = () => {
      const db = request.result;
      // Held open, the database would block the other tab until this one closed.
      db.onversionchange = (event) => {
        db.close();
        onVersionChange(event);
      };
      resolve(db);
    };
    request.onerror = () => reject(new Error(`open database: ${request.error?.message}`));
  });
}

function write(db: IDBDatabase, work: (tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["notes", "docs", "meta"], "readwrite", { durability: "strict" });
    tx.oncomplete = () => resolve();
    // A failed request aborts the whole write, and only by then does the transaction hold the error.
    tx.onabort = () => reject(new Error(`write: ${tx.error?.message ?? "aborted"}`));
    work(tx);
  });
}

/** Every open connection must be closed first. */
function erase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(Name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error(`delete database: ${request.error?.message}`));
  });
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`read: ${request.error?.message}`));
  });
}
