// History store module
// Schema: HistoryItem { id:string, ts:number, type:'DMS→DD'|'DD→DMS', input:string, output:string, meta:{ crs?:string, precision?:number } }
(function(){
  const KEY = 'cordify_history_v2';
  const CAP = 200;

  function uid(){ return Math.random().toString(36).slice(2)+Date.now().toString(36); }

  function load(){
    try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v)? v: []; } catch { return []; }
  }
  function save(arr){
    try { localStorage.setItem(KEY, JSON.stringify(arr.slice(-CAP))); } catch {}
  }

  function getAll(){ return load().slice().reverse(); } // newest first
  function add(item){
    const arr = load();
    const rec = { id: uid(), ts: Date.now(), meta:{}, ...item };
    arr.push(rec);
    save(arr);
    return rec;
  }
  function remove(id){ const arr = load().filter(r=>r.id!==id); save(arr); }
  function clear(){ localStorage.removeItem(KEY); }

  function filterByType(type){
    const list = getAll();
    if (!type || type==='all') return list;
    return list.filter(r=>r.type===type);
  }

  // rerun returns the item (consumer can hydrate UI)
  function getById(id){ return load().find(r=>r.id===id) || null; }

  window.historyStore = { add, getAll, filterByType, remove, clear, getById };
})();
