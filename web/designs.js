// Saved designs: every image the user opens, with its settings and deletions, kept in this
// browser's IndexedDB so work survives switching tabs and closing the page. Nothing leaves the
// computer. If storage is unavailable (private window, blocked site data) every call quietly
// does nothing and the app still works for the session.
const DB = 'drabzin', STORE = 'designs';

let dbp = null;
function open() {
  if (!dbp) {
    dbp = new Promise((res) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
        req.onblocked = () => res(null);
      } catch { res(null); }
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  if (!db) return null;
  return new Promise((res) => {
    try {
      const t = db.transaction(STORE, mode), store = t.objectStore(STORE);
      const req = fn(store);
      t.oncomplete = () => res(req?.result ?? true);
      t.onerror = t.onabort = () => res(null);
    } catch { res(null); }
  });
}

// { id, name, blob, settings, removed, pathCount, opened } - newest first.
export async function listDesigns() {
  const all = (await tx('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => b.opened - a.opened);
}
export const saveDesign = (doc) => tx('readwrite', (s) => s.put(doc));
export const deleteDesign = (id) => tx('readwrite', (s) => s.delete(id));
