/** The one IndexedDB database on the device, `blank`, with a store for each kind of record. */

export type Store = "notes" | "docs" | "meta";

const NAME = "blank";
const VERSION = 1;

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
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

export function getAll<T>(db: IDBDatabase, store: Store): Promise<T[]> {
  return done(db.transaction(store).objectStore(store).getAll());
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
