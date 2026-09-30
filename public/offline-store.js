// Durable local copy for offline reading: the last Shop context and a snapshot per account and Shop.
// Every method swallows storage failures and resolves null, so a blocked or unavailable IndexedDB never affects the online app.
const DB_NAME = 'medicine-offline';
const VERSION = 2;

export function openOfflineStore({ indexedDB = globalThis.indexedDB, now = () => new Date().toISOString() } = {}) {
  let dbPromise = null;
  const open = () => dbPromise ||= new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('IndexedDB is unavailable'));
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['meta', 'snapshots', 'queues']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (store, mode, action) => {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = action(tx.objectStore(store));
        tx.oncomplete = () => resolve(request?.result ?? null);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } catch { dbPromise = null; return null; }
  };

  const loadContext = () => run('meta', 'readonly', store => store.get('context'));
  async function saveContext(context) {
    const previous = await loadContext();
    if (previous?.context?.accountContextKey && previous.context.accountContextKey !== context?.accountContextKey) await run('snapshots', 'readwrite', store => store.clear());
    return run('meta', 'readwrite', store => store.put({ context, savedAt: now() }, 'context'));
  }
  const saveSnapshot = (key, data) => run('snapshots', 'readwrite', store => store.put({ ...data, savedAt: now() }, key));
  const loadSnapshot = key => run('snapshots', 'readonly', store => store.get(key));
  const loadQueue = key => run('queues', 'readonly', store => store.get(key));
  const saveQueue = (key, entries) => run('queues', 'readwrite', store => store.put(entries, key));
  return { saveContext, loadContext, saveSnapshot, loadSnapshot, loadQueue, saveQueue };
}
