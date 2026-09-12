// The only place the desktop link touches `chrome` directly. Everything else takes these
// two adapters as dependencies, which is what lets the queue and the retry policy run under
// `node --test` instead of only inside a browser.

/**
 * Wrap chrome.runtime.sendNativeMessage so a closed port comes back as data.
 *
 * `chrome.runtime.lastError` is only readable inside the callback; reading it afterwards
 * yields undefined and the failure looks like an empty reply. Turning it into an exception
 * would push the retry decision into a catch block far from the classification table.
 */
export function nativeSender(api) {
  return (hostName, message) => new Promise(resolve => {
    api.runtime.sendNativeMessage(hostName, message, response => {
      const lastError = api.runtime.lastError;
      if (lastError) {
        resolve({ lastError: lastError.message ?? String(lastError) });
        return;
      }
      resolve({ response });
    });
  });
}

export function storageAdapter(api) {
  return {
    get: keys => api.storage.local.get(keys),
    set: values => api.storage.local.set(values)
  };
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const STAGING_DB = 'resume-pro-desktop';
export const STAGING_STORE = 'snapshots';

/**
 * One IndexedDB object store as the `{ get, put, delete, list }` shape link/staging.mjs takes.
 *
 * Only the service worker and extension pages may use this. A content script's IndexedDB
 * belongs to the page it is injected into, not to the extension (D01 §8.5), so a snapshot
 * written there would be readable by the job site and gone when the user clears that site.
 *
 * Writes ask for strict durability: "staged" tells the user the snapshot survives a browser
 * restart, and relaxed durability lets the transaction complete before the data is on disk.
 */
export function idbStore({ indexedDB = globalThis.indexedDB, dbName = STAGING_DB, storeName = STAGING_STORE } = {}) {
  let opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another context upgrading the database must not be blocked by this handle.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('indexeddb_blocked'));
    }).catch(error => {
      // A failed open is not cached: the next attempt (after a restart, or once another
      // context lets go) should get to try again.
      opening = null;
      throw error;
    });
    return opening;
  }

  async function run(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = mode === 'readwrite'
        ? db.transaction(storeName, mode, { durability: 'strict' })
        : db.transaction(storeName, mode);
      const request = work(tx.objectStore(storeName));
      let result;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('AbortError'));
    });
  }

  return {
    get: key => run('readonly', store => store.get(key)),
    put: async (key, value) => { await run('readwrite', store => store.put(value, key)); },
    delete: async key => { await run('readwrite', store => store.delete(key)); },
    list: () => run('readonly', store => store.getAll())
  };
}
