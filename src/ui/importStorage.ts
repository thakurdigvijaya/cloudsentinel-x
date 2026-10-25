// Opt-in durable storage for browser-only demo imports.
// IndexedDB holds the metrics because a 90-VM / 30-day series exceeds localStorage quotas.
// Only the active dataset ID is kept in localStorage. The files never leave the browser.
import { importJsonDataset } from '../engine/importer';
import type { MetricSeries, Resource } from '../engine/types';
import { buildData, type AppData } from './data';

const DB_NAME = 'cloudsentinel-x-imports';
const STORE = 'datasets';
const POINTER = 'cloudsentinel-x/active-import/v1';

interface SavedImport {
  id: string;
  resources: Resource[];
  series: MetricSeries[];
  start: string;
  days: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable in this browser.'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Cannot open dataset storage.'));
  });
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result); // only commit the pointer after the write transaction completes
      request.onerror = () => reject(request.error ?? new Error('Dataset storage failed.'));
      tx.onerror = () => reject(tx.error ?? new Error('Dataset transaction failed.'));
    });
  } finally {
    db.close();
  }
}

export async function rememberImportedData(data: AppData): Promise<void> {
  if (data.source !== 'imported') return;
  const item: SavedImport = {
    id: data.id, resources: data.resources, series: [...data.series.values()], start: data.start, days: data.days,
  };
  await transact('readwrite', (store) => store.put(item));
  // Only change the active pointer AFTER IndexedDB successfully commits.
  localStorage.setItem(POINTER, data.id);
}

export function isImportedDataActive(id: string): boolean {
  try { return localStorage.getItem(POINTER) === id; } catch { return false; }
}

export function setSyntheticActive(): void {
  try { localStorage.removeItem(POINTER); } catch { /* private mode */ }
}

export async function restoreImportedData(): Promise<AppData | null> {
  let id: string | null = null;
  try { id = localStorage.getItem(POINTER); } catch { return null; }
  if (!id) return null;
  try {
    const saved = await transact<SavedImport | undefined>('readonly', (store) => store.get(id));
    if (!saved || saved.id !== id) throw new Error('Previous import was not found.');
    const imported = importJsonDataset(JSON.stringify({ resources: saved.resources, series: saved.series }));
    if (!imported.ok || !imported.start) throw new Error('Stored dataset failed safety validation.');
    return buildData(imported.resources, imported.series, { id, source: 'imported', start: imported.start, days: imported.days });
  } catch (error) {
    // Fail safely to the reproducible synthetic dataset, never attach old approvals to bad data.
    console.warn('CloudSentinel X: previous local import could not be restored.', error);
    setSyntheticActive();
    return null;
  }
}

/** Explicit privacy control: erase imported metric caches and their per-dataset browser decisions. */
export async function forgetAllImportedData(): Promise<void> {
  setSyntheticActive();
  const ids = await transact<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  await transact('readwrite', (store) => store.clear());
  for (const id of ids) {
    try { localStorage.removeItem(`cloudsentinel-x/decisions/v2/${String(id)}`); } catch { /* private mode */ }
  }
}
