// scripts for cordify

/* --------------------------------------------------------------------------
   Cordify: tabs + history-only view + robust storage + batch I/O
--------------------------------------------------------------------------- */

function initializeApp() {
  if (typeof L === 'undefined') {
    setTimeout(initializeApp, 100);
    return;
  }
  initCordifyApp();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

function initCordifyApp() {
(function () {
  const MAX_HISTORY = 1000;
  const OLD_KEY = "cordify_history_v1";

  function _fallback_getHistory() {
    try {
      const raw = localStorage.getItem(OLD_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function _fallback_setHistory(arr) { try { localStorage.setItem(OLD_KEY, JSON.stringify(arr.slice(0, MAX_HISTORY))); } catch {} }
  function _fallback_addHistory(rec) {
    const arr = _fallback_getHistory();
    arr.unshift({ type: rec.type || "", input: String(rec.input ?? ""), result: String(rec.result ?? ""), date: rec.date || Date.now() });
    _fallback_setHistory(arr);
  }
  function _fallback_removeByIndex(idx) {
    try {
      const arr = _fallback_getHistory();
      if (typeof idx !== 'number' || idx < 0 || idx >= arr.length) return false;
      arr.splice(idx, 1);
      _fallback_setHistory(arr);
      return true;
    } catch { return false; }
  }
  function _fallback_clearHistory() { try { localStorage.removeItem(OLD_KEY); } catch {} }

  function getHistory() {
    if (window.historyStore && typeof window.historyStore.getAll === 'function') {
      return window.historyStore.getAll().map(r => ({ id: r.id, ts: r.ts || r.date, type: r.type || '', input: r.input || '', result: r.output || r.result || '', date: r.date || r.ts }));
    }
    return _fallback_getHistory();
  }
  function addHistory(rec) {
    if (window.historyStore && typeof window.historyStore.add === 'function') {
      try { window.historyStore.add({ type: rec.type, input: String(rec.input ?? ''), output: String(rec.result ?? ''), date: rec.date, meta: rec.meta || {} }); return; } catch(e) { }
    }
    _fallback_addHistory(rec);
  }
  function clearHistory() {
    if (window.historyStore && typeof window.historyStore.clear === 'function') { try { window.historyStore.clear(); return; } catch(e) {} }
    _fallback_clearHistory();
  }

  function removeHistoryAt(indexOrId) {
    if (window.historyStore && typeof window.historyStore.remove === 'function' && typeof indexOrId === 'string') {
      try { return window.historyStore.remove(indexOrId); } catch(e) { }
    }
    if (typeof indexOrId === 'number') return _fallback_removeByIndex(indexOrId);
    return false;
  }

  window._cordify_addHistory = addHistory;

  const convertTab = document.getElementById("convert-tab");
  const historyTab = document.getElementById("history-tab");
  const btnConvert = document.getElementById("tab-convert");
  const btnHistory = document.getElementById("tab-history");
  const btnMap = document.getElementById("tab-map");

  function setActive(btnOn, ...btnOffList) {
    btnOn?.classList.add("is-active");
    btnOffList.forEach(b => b?.classList.remove("is-active"));
  }

  function switchTab(tab) {
    if (convertTab) convertTab.style.display = 'none';
    if (historyTab) historyTab.style.display = 'none';
    const mapTabEl = document.getElementById('map-tab');
    if (mapTabEl) mapTabEl.style.display = 'none';

    if (tab === 'convert') {
      if (convertTab) convertTab.style.display = '';
      setActive(btnConvert, btnHistory, btnMap);
    } else if (tab === 'history') {
      if (historyTab) historyTab.style.display = '';
      setActive(btnHistory, btnConvert, btnMap);
      renderHistoryTable();
    } else if (tab === 'map') {
      if (mapTabEl) mapTabEl.style.display = '';
      setActive(btnMap, btnConvert, btnHistory);
      const mapEl = document.getElementById('map');
      if (mapEl) {
        mapEl.style.width = '100%';
        mapEl.style.height = '400px';
      }
      setTimeout(() => {
        if (!_map) initMap();
        if (_map) _map.invalidateSize();
      }, 150);
    }
  }

  if (btnConvert) btnConvert.onclick = () => switchTab('convert');
  if (btnHistory) btnHistory.onclick = () => switchTab('history');
  if (btnMap) btnMap.onclick = () => switchTab('map');

  switchTab('convert');

  document.getElementById("btn-dms2dd")?.addEventListener("click", convertDmsToDd);
  document.getElementById("btn-dd2dms")?.addEventListener("click", convertDdToDms);
  document.getElementById("show-dd-map")?.addEventListener("click", () => showCurrentInMap('dd'));
  document.getElementById("show-dms-map")?.addEventListener("click", () => showCurrentInMap('dms'));

  function renderHistoryTable() {
    const table = document.getElementById("history-table");
    const tbody = table ? table.querySelector("tbody") : null;
    if (!tbody) return;
    tbody.innerHTML = "";
    const arr = getHistory();
    arr.forEach((item, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${i + 1}</td><td>${item.input}</td><td>${item.result}</td><td></td>`;
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  
  window._cordify_renderHistory = renderHistoryTable;

})(); // End IIFE
} // End init

/* --- Converters --- */
function parseDmsString(s) {
  if(!s) return null;
  const m = s.match(/([+-]?\d+(?:\.\d+)?)/g);
  if(!m || m.length < 1) return null;
  let dd = Math.abs(parseFloat(m[0])) + (parseFloat(m[1]||0)/60) + (parseFloat(m[2]||0)/3600);
  if (s.toUpperCase().includes('S') || s.toUpperCase().includes('W') || parseFloat(m[0]) < 0) dd *= -1;
  return dd;
}

function ddToDms(dd, type) {
  const dir = type === 'lat' ? (dd < 0 ? 'S' : 'N') : (dd < 0 ? 'W' : 'E');
  dd = Math.abs(dd);
  const d = Math.floor(dd);
  const m = Math.floor((dd - d) * 60);
  const s = (((dd - d) * 60) - m) * 60;
  return `${d}° ${m}' ${s.toFixed(2)}" ${dir}`;
}

function convertDmsToDd() {
  const latVal = parseDmsString(document.getElementById("dms_lat_string").value);
  const lonVal = parseDmsString(document.getElementById("dms_lon_string").value);
  if (latVal === null || lonVal === null) return alert("Invalid Input");
  document.getElementById("dd_result").value = `Lat: ${latVal.toFixed(6)}\nLon: ${lonVal.toFixed(6)}`;
}

function convertDdToDms() {
  const lat = parseFloat(document.getElementById("dd_lat").value);
  const lon = parseFloat(document.getElementById("dd_lon").value);
  document.getElementById("dms_result").value = `Lat: ${ddToDms(lat, 'lat')}\nLon: ${ddToDms(lon, 'lon')}`;
}

/* --- Map Logic --- */
let _map = null;
function initMap() {
  if (_map || typeof L === 'undefined') return;
  _map = L.map('map').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(_map);
}

function showCurrentInMap(type) {
  const val = document.getElementById(type === 'dd' ? 'dd_result' : 'dms_result').value;
  const m = val.match(/(-?\d+\.\d+)/g);
  if (!m) return alert("Convert first!");
  const lat = parseFloat(m[0]), lon = parseFloat(m[1]);
  document.getElementById("tab-map").click();
  setTimeout(() => {
    initMap();
    _map.setView([lat, lon], 13);
    L.marker([lat, lon]).addTo(_map);
  }, 200);
}