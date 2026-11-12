/*
 * Cordify — history of saved conversions
 * Records live in memory (so every call here answers at once) and are written
 * through to IndexedDB (db.js). History saved by older versions in localStorage
 * is moved across the first time. Without IndexedDB (or without db.js, as in the
 * test page) it keeps using localStorage as before.
 */
(function() {
  // Tests set window.CORDIFY_HISTORY_KEY first so they never touch real history.
  const KEY = window.CORDIFY_HISTORY_KEY || "cordify_history_v2";
  let CAP = 100000;
  let items = [];        // oldest first
  let useDb = false;
  const DB = () => window.CordifyDB;
  let channel = null;    // tells other open tabs to reload their copy
  try {
    channel = new BroadcastChannel("cordify_history");
  } catch (e) {}

  function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function _emitChange(tell = true) {
    try {
      window.dispatchEvent(new CustomEvent("historyStore:change"));
    } catch (e) {}
    if (tell && useDb && channel) {
      try {
        channel.postMessage("changed");
      } catch (e) {}
    }
  }
  function loadLocal() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) {
        return [];
      }
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  function saveLocal() {
    if (useDb) {
      return;
    }
    try {
      // localStorage is small: only the newest 1000 are kept there.
      localStorage.setItem(KEY, JSON.stringify(items.slice(-1000)));
    } catch {}
  }
  const quiet = p => p && p.catch(() => {});
  // Keeps the newest CAP records; returns the ones dropped.
  function trim() {
    return items.length > CAP ? items.splice(0, items.length - CAP) : [];
  }
  const byTime = (a, b) => (a.ts || 0) - (b.ts || 0);

  items = loadLocal();

  // Move to IndexedDB when it is there.
  const ready = (async () => {
    if (!DB() || !await DB().ready) {
      return false;
    }
    try {
      const stored = await DB().all("history");
      // Anything saved in localStorage (by an older version, or in the moment before this ran) is carried over once.
      const known = new Set(stored.map(r => r.id));
      const fresh = items.filter(r => r && r.id && !known.has(r.id));
      if (fresh.length) {
        await DB().putMany("history", fresh);
      }
      items = stored.concat(fresh).sort(byTime);
      useDb = true;
      try {
        localStorage.removeItem(KEY);
      } catch {}
      trim().forEach(r => quiet(DB().del("history", r.id)));
      _emitChange(false);
      return true;
    } catch (e) {
      return false;
    }
  })();

  if (channel) {
    channel.onmessage = async () => {
      if (!useDb) {
        return;
      }
      try {
        items = (await DB().all("history")).sort(byTime);
        _emitChange(false);
      } catch (e) {}
    };
  }

  function getAll() {
    return items.slice().reverse();
  }
  function add(item) {
    const rec = {
      id: uid(),
      ts: Date.now(),
      meta: {},
      ...item
    };
    items.push(rec);
    const dropped = trim();
    if (useDb) {
      quiet(DB().put("history", rec));
      dropped.forEach(r => quiet(DB().del("history", r.id)));
    }
    saveLocal();
    _emitChange();
    return rec;
  }
  function remove(id) {
    const i = items.findIndex(r => r.id === id);
    if (i < 0) {
      return false;
    }
    items.splice(i, 1);
    if (useDb) {
      quiet(DB().del("history", id));
    }
    saveLocal();
    _emitChange();
    return true;
  }
  function clear() {
    items = [];
    if (useDb) {
      quiet(DB().clear("history"));
    }
    try {
      localStorage.removeItem(KEY);
    } catch {}
    _emitChange();
    return true;
  }
  function filterByType(type) {
    const list = getAll();
    if (!type || type === "all") {
      return list;
    }
    return list.filter(r => r.type === type);
  }
  function getById(id) {
    return items.find(r => r.id === id) || null;
  }
  function size() {
    return items.length;
  }
  function exportAll() {
    try {
      return JSON.stringify(items);
    } catch {
      return "[]";
    }
  }
  function importAll(json, {replace: replace = false} = {}) {
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) {
        return false;
      }
      const incoming = arr.filter(r => r && typeof r === "object").map(r => r.id ? r : { ...r, id: uid() });
      if (replace) {
        items = [];
        if (useDb) {
          quiet(DB().clear("history"));
        }
      }
      items = items.concat(incoming);
      trim();
      if (useDb) {
        quiet(DB().putMany("history", items));
      }
      saveLocal();
      _emitChange();
      return true;
    } catch {
      return false;
    }
  }
  function setCap(n) {
    if (Number.isFinite(n) && n > 0) {
      CAP = Math.max(1, Math.floor(n));
      const dropped = trim();
      if (useDb) {
        dropped.forEach(r => quiet(DB().del("history", r.id)));
      }
      saveLocal();
      _emitChange();
    }
  }
  window.historyStore = {
    ready: ready,
    add: add,
    getAll: getAll,
    filterByType: filterByType,
    remove: remove,
    clear: clear,
    getById: getById,
    size: size,
    exportAll: exportAll,
    importAll: importAll,
    setCap: setCap
  };
})();
