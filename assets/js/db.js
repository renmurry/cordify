/*
 * Cordify — storage on this device (IndexedDB)
 * Holds history records and the sheet. Unlike the old localStorage it has no
 * 5 MB limit, so thousands of points fit. Nothing is sent anywhere.
 *
 * window.CordifyDB:
 *   ready            a promise: true when IndexedDB can be used, false otherwise
 *   all(store)       every value in a store
 *   put(store, v)    add or replace (history records are keyed by their id)
 *   putMany(store, values)
 *   del(store, key)
 *   clear(store)
 *   get(key) / set(key, value)   small named values (the "kv" store)
 */
(function () {
  "use strict";
  // Tests set window.CORDIFY_DB_NAME first so they never touch real data.
  const NAME = window.CORDIFY_DB_NAME || "cordify";
  let db = null;

  const ready = new Promise(resolve => {
    try {
      if (!window.indexedDB) return resolve(false);
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("history")) d.createObjectStore("history", { keyPath: "id" });
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      };
      req.onsuccess = () => {
        db = req.result;
        db.onversionchange = () => db.close();
        resolve(true);
      };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    } catch (e) {
      resolve(false);
    }
  });

  // Runs fn(store) in one transaction; resolves with its request's result when the transaction is done.
  function tx(store, mode, fn) {
    return ready.then(ok => new Promise((resolve, reject) => {
      if (!ok) return reject(new Error("IndexedDB is not available"));
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = t.onabort = () => reject(t.error || new Error("storage failed"));
    }));
  }

  window.CordifyDB = {
    ready,
    all: store => tx(store, "readonly", s => s.getAll()),
    put: (store, value) => tx(store, "readwrite", s => s.put(value)),
    putMany: (store, values) => tx(store, "readwrite", s => {
      values.forEach(v => s.put(v));
    }),
    del: (store, key) => tx(store, "readwrite", s => s.delete(key)),
    clear: store => tx(store, "readwrite", s => s.clear()),
    get: key => tx("kv", "readonly", s => s.get(key)),
    set: (key, value) => tx("kv", "readwrite", s => s.put(value, key))
  };
})();
