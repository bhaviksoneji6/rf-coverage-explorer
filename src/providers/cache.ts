/**
 * IndexedDB cache for fetched rasters.
 *
 * Terrain and clutter are the only slow things in the pipeline (~0.6s and ~1.6s for a
 * 30km AOI). They depend only on the AOI, so every parameter the user actually drags --
 * frequency, EIRP, heights, model -- recomputes from cached typed arrays and never
 * touches the network.
 */

const DB_NAME = 'rf-coverage-explorer';
const STORE = 'rasters';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    // A blocked or unavailable IndexedDB (private mode, quota) must not break the app --
    // it just means every fetch is a cache miss.
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

export async function cacheGet(key: string): Promise<ArrayBuffer | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
    req.onerror = () => resolve(undefined);
  });
}

export async function cachePut(key: string, value: ArrayBuffer): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

export function cacheKey(
  providerId: string,
  bbox: { minE: number; minN: number; maxE: number; maxN: number },
  size: { width: number; height: number },
  epsg: number,
): string {
  const r = (v: number) => Math.round(v);
  return `${providerId}|${epsg}|${r(bbox.minE)},${r(bbox.minN)},${r(bbox.maxE)},${r(bbox.maxN)}|${size.width}x${size.height}`;
}
