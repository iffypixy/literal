type Store = "notes" | "docs" | "meta";

const Name = "literal";
const Version = 1;

/** `onVersionChange` runs when another tab deletes or upgrades the database, once this connection has let it go. */
export function openDb(onVersionChange: (event: IDBVersionChangeEvent) => void): Promise<IDBDatabase> {
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

/** Every open connection must be closed first. */
export function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(Name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error(`delete database: ${request.error?.message}`));
  });
}

/** Every row of `notes`, `size` at a time, leaving the page free in between. */
export async function* readNotes<T extends { id: string }>(
  db: IDBDatabase,
  parse: (value: unknown) => T,
  size: number,
): AsyncGenerator<T[]> {
  let after: string | undefined;
  for (;;) {
    const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
    const rows = (await done(db.transaction("notes").objectStore("notes").getAll(range, size))).map(parse);
    if (rows.length) yield rows;
    if (rows.length < size) return;
    after = rows.at(-1)?.id;
  }
}

export function get(db: IDBDatabase, store: Store, key: string): Promise<unknown> {
  return done(db.transaction(store).objectStore(store).get(key));
}

/** Over every store, and strict, so a note that counts as saved survives a power cut right after. */
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
