// History store module
// Schema: HistoryItem { id:string, ts:number, type:'DMS→DD'|'DD→DMS', input:string, output:string, meta:{ crs?:string, precision?:number } }
// History store module
// Schema: HistoryItem { id:string, ts:number, type:'DMS→DD'|'DD→DMS', input:string, output:string, meta:{ crs?:string, precision?:number } }
(function(){
  const KEY = 'cordify_history_v2';
  let CAP = 200;

  function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }

  function _emitChange(){
    try { window.dispatchEvent(new CustomEvent('historyStore:change')); } catch(e) { /* ignore */ }
  }

  function load(){
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }
  function save(arr){
    try { localStorage.setItem(KEY, JSON.stringify(arr.slice(-CAP))); _emitChange(); } catch {}
  }

  function getAll(){ return load().slice().reverse(); } // newest first
  function add(item){
    const arr = load();
    const rec = { id: uid(), ts: Date.now(), meta:{}, ...item };
    arr.push(rec);
    save(arr);
    return rec;
  }
  function remove(id){
    const before = load();
    const after = before.filter(r=>r.id!==id);
    if (after.length === before.length) return false;
    save(after);
    return true;
  }
  function clear(){
    try { localStorage.removeItem(KEY); _emitChange(); return true; } catch { return false; }
  }

  function filterByType(type){
    const list = getAll();
    if (!type || type==='all') return list;
    return list.filter(r=>r.type===type);
  }

  // rerun returns the item (consumer can hydrate UI)
  function getById(id){ return load().find(r=>r.id===id) || null; }

  // helpers
  function size(){ return load().length; }
  function exportAll(){ try { return JSON.stringify(load()); } catch { return '[]'; } }
  function importAll(json, { replace=false } = {}){
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) return false;
      const toSave = replace ? arr.slice(-CAP) : load().concat(arr).slice(-CAP);
      localStorage.setItem(KEY, JSON.stringify(toSave));
      _emitChange();
      return true;
    } catch { return false; }
  }
  function setCap(n){ if (Number.isFinite(n) && n>0) { CAP = Math.max(1, Math.floor(n)); const arr = load(); save(arr); } }

  window.historyStore = { add, getAll, filterByType, remove, clear, getById, size, exportAll, importAll, setCap };
})();
