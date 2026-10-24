/** The one IndexedDB database on the device, `literal`, with a store for each kind of record. */

export type Store = "notes" | "docs" | "meta";

const Name = "literal";
const Version = 1;

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(Name, Version);
    request.onupgradeneeded = () => {
      // `notes` holds what the list, search and sync read; `docs` holds the Yjs state behind each note;
      // `meta` holds the rest, like when sync last caught up.
      request.result.createObjectStore("notes", { keyPath: "id" });
      request.result.createObjectStore("docs");
      request.result.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`open database: ${request.error?.message}`));
    request.onblocked = () => reject(new Error("open database: blocked by another tab"));
  });
}

/** Deletes the database with everything in it. Every open connection must be closed first. */
export function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(Name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error(`delete database: ${request.error?.message}`));
  });
}

/** Every record in `store`, `size` at a time: between batches the page stays free to take keystrokes. */
export async function* readAll<T>(db: IDBDatabase, store: Store, size: number): AsyncGenerator<T[]> {
  let after: IDBValidKey | undefined;
  for (;;) {
    const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
    const records = db.transaction(store).objectStore(store);
    const [values, keys] = await Promise.all([
      done(records.getAll(range, size)),
      done(records.getAllKeys(range, size)),
    ]);
    if (values.length) yield values as T[];
    if (values.length < size) return;
    after = keys.at(-1);
  }
}

export function get<T>(db: IDBDatabase, store: Store, key: string): Promise<T | undefined> {
  return done(db.transaction(store).objectStore(store).get(key));
}

/** Runs `work` in one read-write transaction over every store, and resolves once it's on disk. */
export function write(db: IDBDatabase, work: (tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["notes", "docs", "meta"], "readwrite", { durability: "strict" });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`write: ${tx.error?.message}`));
    tx.onabort = () => reject(new Error(`write: ${tx.error?.message ?? "aborted"}`));
    work(tx);
  });
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`read: ${request.error?.message}`));
  });
}
