// autosave.ts
// Keeps the latest session inside the browser (IndexedDB), so a closed tab or a crash
// does not lose your loops. Everything here fails quietly: if the browser blocks
// storage, the looper simply works without autosave.

import type { SessionData } from "./session";

const DB_NAME = "gesture-looper";
const STORE = "autosave";
const KEY = "latest";

export interface AutosaveRecord {
  savedAt: number;
  data: SessionData;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function saveAutosave(data: SessionData): Promise<boolean> {
  try {
    const record: AutosaveRecord = { savedAt: Date.now(), data };
    await run("readwrite", (s) => s.put(record, KEY));
    return true;
  } catch {
    return false;
  }
}

export async function loadAutosave(): Promise<AutosaveRecord | null> {
  try {
    const record = await run<AutosaveRecord | undefined>("readonly", (s) => s.get(KEY));
    return record ?? null;
  } catch {
    return null;
  }
}

export async function clearAutosave(): Promise<boolean> {
  try {
    await run("readwrite", (s) => s.delete(KEY));
    return true;
  } catch {
    return false;
  }
}
