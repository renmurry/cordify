// scripts for cordify

/* --------------------------------------------------------------------------
   Cordify: tabs + history-only view + robust storage + batch I/O
--------------------------------------------------------------------------- */

// Wait for DOM and external libraries to load
function initializeApp() {
  console.log('DOM ready, checking libraries...');

  // Check if required libraries are loaded
  if (typeof L === 'undefined') {
    console.warn('Leaflet not yet loaded, retrying...');
    setTimeout(initializeApp, 100);
    return;
  }

  console.log('Leaflet loaded, checking other libraries...');

  // Check other libraries
  if (typeof XLSX === 'undefined') {
    console.warn('XLSX not loaded');
  } else {
    console.log('XLSX loaded');
  }

  if (typeof JSZip === 'undefined') {
    console.warn('JSZip not loaded');
  } else {
    console.log('JSZip loaded');
  }

  // Libraries are loaded, now initialize the app
  console.log('Initializing Cordify app...');
  initCordifyApp();
}

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

function initCordifyApp() {
(function () {
  const MAX_HISTORY = 1000;
  const OLD_KEY = "cordify_history_v1";

  // ---------- storage (prefer window.historyStore when available) ----------
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
      // historyStore returns newest-first already
      return window.historyStore.getAll().map(r => ({ id: r.id, ts: r.ts || r.date, type: r.type || '', input: r.input || '', result: r.output || r.result || '', date: r.date || r.ts || r.ts }));
    }
    return _fallback_getHistory();
  }
  function addHistory(rec) {
    if (window.historyStore && typeof window.historyStore.add === 'function') {
      try { window.historyStore.add({ type: rec.type, input: String(rec.input ?? ''), output: String(rec.result ?? ''), date: rec.date, meta: rec.meta || {} }); return; } catch(e) { /* fallthrough */ }
    }
    _fallback_addHistory(rec);
  }
  function clearHistory() {
    if (window.historyStore && typeof window.historyStore.clear === 'function') { try { window.historyStore.clear(); return; } catch(e) {} }
    _fallback_clearHistory();
  }

  function removeHistoryAt(indexOrId) {
    // if id (string) and historyStore available, remove by id
    if (window.historyStore && typeof window.historyStore.remove === 'function' && typeof indexOrId === 'string') {
      try { return window.historyStore.remove(indexOrId); } catch(e) { /* fallthrough */ }
    }
    // if numeric index, try remove from store by index -> map to id
    if (window.historyStore && typeof window.historyStore.getAll === 'function' && typeof indexOrId === 'number') {
      try {
        const arr = window.historyStore.getAll();
        const rec = arr[indexOrId];
        if (rec && rec.id) return window.historyStore.remove(rec.id);
      } catch(e) {}
    }
    // fallback: remove by index from legacy storage
    if (typeof indexOrId === 'number') return _fallback_removeByIndex(indexOrId);
    return false;
  }

  // migrate legacy v1 -> historyStore if present
  async function migrateHistoryToStore(){
    if (!window.historyStore || typeof window.historyStore.add !== 'function') return;
    try{
      const raw = localStorage.getItem(OLD_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return;

      const existing = new Set(window.historyStore.getAll().map(r => `${r.input}||${r.output}||${r.ts||r.date||''}`));
      for (const it of arr){
        const input = it.input || '';
        const output = it.result || it.output || '';
        const ts = it.date || it.ts || Date.now();
        const key = `${input}||${output}||${ts}`;
        if (existing.has(key)) continue;
        window.historyStore.add({ type: it.type || 'unknown', input, output, date: ts, meta: it.meta || {} });
      }
      try { localStorage.removeItem(OLD_KEY); } catch(e){}
    } catch (e) { console.error('history migration failed', e); }
  }

  // attempt immediate migration if historyStore already present
  try { migrateHistoryToStore(); } catch(e) {}

  // expose for converters
  window._cordify_addHistory = addHistory;
  // window._cordify_renderHistory will be assigned after renderHistoryTable is defined

  // ---------- tabs + ui ----------
  document.addEventListener("DOMContentLoaded", () => {
    // ensure legacy history is migrated once UI is ready
    try { migrateHistoryToStore(); } catch(e) {}

    // react to changes from historyStore or other tabs (storage events)
    window.addEventListener('historyStore:change', () => {
      if (document.getElementById("history-tab")?.style.display !== "none") renderHistoryTable();
    });
    window.addEventListener('storage', (e) => {
      if (!e) return;
      if (e.key === 'cordify_history_v2' || e.key === OLD_KEY) {
        if (document.getElementById("history-tab")?.style.display !== "none") renderHistoryTable();
      }
    });
    const convertTab = document.getElementById("convert-tab");
    const historyTab = document.getElementById("history-tab");
    const btnConvert = document.getElementById("tab-convert");
    const btnHistory = document.getElementById("tab-history");

    function setActive(btnOn, ...btnOffList) {
      btnOn?.classList.add("is-active");
      btnOffList.forEach(b => b?.classList.remove("is-active"));
    }

    const btnMap = document.getElementById("tab-map");

    function switchTab(tab) {
      // hide all
      if (convertTab) convertTab.style.display = 'none';
      if (historyTab) historyTab.style.display = 'none';
      const mapTabEl = document.getElementById('map-tab');
      if (mapTabEl) mapTabEl.style.display = 'none';

      // show selected
      if (tab === 'convert') {
        if (convertTab) convertTab.style.display = '';
        setActive(btnConvert, btnHistory, btnMap);
      } else if (tab === 'history') {
        if (historyTab) historyTab.style.display = '';
        setActive(btnHistory, btnConvert, btnMap);
        renderHistoryTable();
      } else if (tab === 'map') {
        console.log('Switching to map tab');
        if (mapTabEl) {
          mapTabEl.style.display = '';
          console.log('Map tab made visible');
        }
        setActive(btnMap, btnConvert, btnHistory);

        // Ensure map container has proper dimensions before initializing
        const mapEl = document.getElementById('map');
        if (mapEl) {
          mapEl.style.width = '100%';
          mapEl.style.height = '400px';
          mapEl.style.minHeight = '400px';
          console.log('Map container dimensions set:', mapEl.offsetWidth, 'x', mapEl.offsetHeight);
        }

        // Initialize map after making the container visible
        setTimeout(() => {
          console.log('Attempting to initialize map...');
          if (!_map) {
            if (!initMap()) {
              console.error('Failed to initialize map');
              // Try to show an error message
              const mapEl = document.getElementById('map');
              if (mapEl) {
                mapEl.innerHTML = '<div style="padding: 20px; text-align: center; color: red;">Failed to load map. Please check your internet connection and try again.</div>';
              }
              return;
            }
          }
          // Always invalidate size when switching to map tab
          if (_map && _map.invalidateSize) {
            _map.invalidateSize(true);
            console.log('Map size invalidated');
          }
        }, 100);
      }
    }

    btnConvert && (btnConvert.onclick = () => switchTab('convert'));
    btnHistory && (btnHistory.onclick = () => switchTab('history'));
    btnMap && (btnMap.onclick = () => switchTab('map'));

    // start on conversion tab
    switchTab('convert');

    // single conversions
    document.getElementById("btn-dms2dd")?.addEventListener("click", convertDmsToDd);
    document.getElementById("btn-dd2dms")?.addEventListener("click", convertDdToDms);
    document.getElementById("btn-clear-dms")?.addEventListener("click", clearDmsInputs);
    document.getElementById("btn-clear-dd")?.addEventListener("click", clearDdInputs);
    document.getElementById("btn-swap")?.addEventListener("click", swapDd);

    // copy buttons
    document.getElementById("copy-dd")?.addEventListener("click", () => copyText(document.getElementById("dd_result")?.value || ""));
    document.getElementById("copy-dms")?.addEventListener("click", () => copyText(document.getElementById("dms_result")?.value || ""));

    // Show in Map buttons
    document.getElementById("show-dd-map")?.addEventListener("click", () => showCurrentInMap('dd'));
    document.getElementById("show-dms-map")?.addEventListener("click", () => showCurrentInMap('dms'));

    // Map controls
    document.getElementById('map-plot-all')?.addEventListener('click', () => {
      const n = plotAllHistory();
      if (n > 0) showFeedback(`Plotted ${n} points on the map`, 'success');
      else showFeedback('No valid points to plot', 'info');
    });

    document.getElementById('map-clear')?.addEventListener('click', () => {
      clearMap();
      showFeedback('Map cleared', 'info');
    });

    // Export buttons
    document.getElementById('export-geojson')?.addEventListener('click', () => exportHistoryAsGeoJSON('cordify_history.geojson'));
    document.getElementById('export-kml')?.addEventListener('click', () => exportHistoryAsKml('cordify_history.kml'));
    document.getElementById('export-kmz')?.addEventListener('click', () => exportHistoryAsKmz('cordify_history.kmz'));

    // Enter key shortcuts
    const dmsInputs = ["dms_lat_string","dms_lon_string","dms_lat_deg","dms_lat_min","dms_lat_sec","dms_lon_deg","dms_lon_min","dms_lon_sec","dms_lat_dir","dms_lon_dir"];
    dmsInputs.forEach(id => document.getElementById(id)?.addEventListener("keydown", e => { if (e.key === "Enter") convertDmsToDd(); }));
    ["dd_lat","dd_lon"].forEach(id => document.getElementById(id)?.addEventListener("keydown", e => { if (e.key === "Enter") convertDdToDms(); }));

    // precision persistence
    try {
      const pdd = localStorage.getItem("cordify_precision_dd");
      if (pdd) document.getElementById("precision-dd").value = pdd;
      const pdms = localStorage.getItem("cordify_precision_dms");
      if (pdms) document.getElementById("precision-dms").value = pdms;
    } catch {}
    document.getElementById("precision-dd")?.addEventListener("change", e => localStorage.setItem("cordify_precision_dd", e.target.value));
    document.getElementById("precision-dms")?.addEventListener("change", e => localStorage.setItem("cordify_precision_dms", e.target.value));

    // remember inputs (session)
    try {
      const last = sessionStorage.getItem("cordify_last_inputs");
      if (last) {
        const v = JSON.parse(last);
        ["dms_lat_string","dms_lon_string","dms_lat_deg","dms_lat_min","dms_lat_sec","dms_lon_deg","dms_lon_min","dms_lon_sec","dd_lat","dd_lon"].forEach(k=>{
          if (v[k] !== undefined && document.getElementById(k)) document.getElementById(k).value = v[k];
        });
      }
    } catch {}
    document.getElementById("convert-tab")?.addEventListener("input", persistInputs);

    // -------- batch wiring --------
    document.getElementById("batch-file")?.addEventListener("change", handleBatchFile);
    document.getElementById("batch-format")?.addEventListener("change", onBatchFormatChange);
    document.getElementById("batch-run")?.addEventListener("click", runBatch);
    document.getElementById("batch-download-xlsx")?.addEventListener("click", () => downloadBatch("xlsx"));
    document.getElementById("batch-download-csv")?.addEventListener("click", () => downloadBatch("csv"));
    // history UI buttons
    document.getElementById('history-export-json')?.addEventListener('click', () => {
      try {
        const json = (window.historyStore && typeof window.historyStore.exportAll === 'function') ? window.historyStore.exportAll() : JSON.stringify(getHistory());
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'cordify_history.json'; document.body.appendChild(a); a.click(); setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 150);
      } catch(e) { alert('Export failed'); }
    });
    document.getElementById('history-clear')?.addEventListener('click', () => {
      if (!confirm('Clear all history?')) return;
      clearHistory(); renderHistoryTable();
    });
    document.getElementById('history-migrate')?.addEventListener('click', () => { migrateHistoryToStore(); alert('Migration started (check console for errors).'); });

  function persistInputs() {
    const keys = ["dms_lat_string","dms_lon_string","dms_lat_deg","dms_lat_min","dms_lat_sec","dms_lon_deg","dms_lon_min","dms_lon_sec","dd_lat","dd_lon"];
    const obj = {};
    keys.forEach(k => { const el = document.getElementById(k); if (el) obj[k] = el.value; });
    try { sessionStorage.setItem("cordify_last_inputs", JSON.stringify(obj)); } catch {}
  }

  // ---------- history table ----------
  function renderHistoryTable() {
    const table = document.getElementById("history-table");
    const tbody = table ? table.querySelector("tbody") : null;
    const emptyMsg = document.getElementById("history-empty");
    if (!table || !tbody) return;

    tbody.innerHTML = "";
    const arr = getHistory();

    if (!arr.length) {
      table.style.display = "none";
      if (emptyMsg) emptyMsg.style.display = "";
      return;
    }

    if (emptyMsg) emptyMsg.style.display = "none";
    table.style.display = "";

    arr.forEach((item, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td><pre style="white-space:pre-wrap;margin:0" title="${escapeHtml(item.input)}">${escapeHtml(item.input)}</pre></td>
        <td><pre style="white-space:pre-wrap;margin:0" title="${escapeHtml(item.result)}">${escapeHtml(item.result)}</pre></td>
        <td>${item.date ? new Date(item.date).toLocaleString() : ""}</td>
        <td></td>
      `;
      // actions
      const actionsTd = tr.querySelector('td:last-child');
      const showBtn = document.createElement('button'); showBtn.type = 'button'; showBtn.textContent = 'Show'; showBtn.className='small';
      showBtn.addEventListener('click', () => {
        try { showHistoryItemOnMap(item.id ?? i); } catch(e) { console.error(e); }
      });
      const exportBtn = document.createElement('button'); exportBtn.type = 'button'; exportBtn.textContent = 'Export'; exportBtn.className='small';
      exportBtn.addEventListener('click', () => {
        try { window._cordify_exportHistory && window._cordify_exportHistory('csv', i); } catch(e) { console.error(e); }
      });
      const delBtn = document.createElement('button'); delBtn.type = 'button'; delBtn.textContent = 'Delete'; delBtn.className='small';
      delBtn.addEventListener('click', () => {
        const ok = confirm('Delete this history item?');
        if (!ok) return;
        const success = removeHistoryAt(item.id ?? i);
        if (success) {
          renderHistoryTable();
        } else {
          alert('Failed to remove history item.');
        }
      });
  actionsTd.appendChild(showBtn);
  actionsTd.appendChild(document.createTextNode(' '));
  actionsTd.appendChild(exportBtn);
  actionsTd.appendChild(document.createTextNode(' '));
  actionsTd.appendChild(delBtn);
      tbody.appendChild(tr);
    });
  }

      // expose render renderer after function is defined
      window._cordify_renderHistory = renderHistoryTable;

  // ---------- helpers ----------
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }
  function copyText(text) {
    const t = String(text ?? "");
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(t).catch(()=>fallback());
    } else { fallback(); }
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
  }

  // Export helpers available if you want to call from console
  window._cordify_exportHistory = function exportHistory(type, rowIdx) {
    const arr = (function(){ try{ return getHistory(); }catch{ return []; }})();
    let data = arr;
    if (typeof rowIdx === "number" && arr[rowIdx]) data = [arr[rowIdx]];
    if (!data.length) return;

    const exportArr = data.map((item, i) => ({
      "#": rowIdx !== undefined ? (rowIdx + 1) : (i + 1),
      "Type": item.type || "",
      "Input": item.input,
      "Result": item.result,
      "Date": item.date ? new Date(item.date).toLocaleString() : ""
    }));

    if (type === "xlsx") {
      if (typeof XLSX === 'undefined') {
        alert('Excel export requires the XLSX library (sheetjs). Please include it in index.html.');
      } else {
        try {
          const ws = XLSX.utils.json_to_sheet(exportArr);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "History");
          XLSX.writeFile(wb, rowIdx !== undefined ? `cordify_conversion_${rowIdx+1}.xlsx` : "cordify_history.xlsx");
        } catch { alert("Excel export failed."); }
      }
    } else if (type === "csv") {
      try {
        const csv = toCsv(exportArr);
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = rowIdx !== undefined ? `cordify_conversion_${rowIdx+1}.csv` : "cordify_history.csv";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      } catch { alert("CSV export failed."); }
    }
    function toCsv(arr) {
      if (!arr.length) return "";
      const keys = Object.keys(arr[0]);
      const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
      return keys.join(",") + "\n" + arr.map(row => keys.map(k => esc(row[k])).join(",")).join("\n");
    }
  };

  // make helpers available to outer scope
  window.clearCordifyHistory = clearHistory;
})();

/* ----------------------------- Converters ----------------------------- */
function parseDmsString(dmsStr) {
  if (!dmsStr) return null;
  dmsStr = dmsStr.trim()
    .replace(/[′’‘`´]/g, "'").replace(/[″“”]/g, '"').replace(/\u00B0/g, "°")
    .replace(/,/g, ".").toUpperCase().replace(/\s+/g, " ");

  const leadDir = (dmsStr.match(/^[NSWE]/) || [null])[0];
  const tailDir = (dmsStr.match(/[NSWE]$/) || [null])[0];
  if (leadDir && tailDir && leadDir !== tailDir) return null;
  let dir = tailDir || leadDir || null;

  if (leadDir) dmsStr = dmsStr.slice(1).trim();
  if (tailDir) dmsStr = dmsStr.slice(0, -1).trim();

  const m = dmsStr.match(/^([+-]?\d+(?:\.\d+)?)(?:[°\s]+(\d+(?:\.\d+)?))?(?:['\s]+(\d+(?:\.\d+)?))?(?:"?)$/);
  if (!m) return null;

  let deg = parseFloat(m[1]);
  let min = m[2] !== undefined ? parseFloat(m[2]) : 0;
  let sec = m[3] !== undefined ? parseFloat(m[3]) : 0;

  if ([deg, min, sec].some(Number.isNaN)) return null;
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;

  let dd = Math.abs(deg) + (min / 60) + (sec / 3600);
  if (deg < 0) dd = -dd;
  if (dir === "S" || dir === "W") dd = -Math.abs(dd);
  return dd;
}
function dmsToDd(deg, min, sec, dir) {
  if ([deg, min, sec].some(v => Number.isNaN(v))) return null;
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;
  let dd = Math.abs(deg) + min / 60 + sec / 3600;
  if (dir === "S" || dir === "W") dd *= -1;
  if (deg < 0) dd *= -1;
  return dd;
}
function ddToDms(dd, latlon, secDigits = 3) {
  if (Number.isNaN(dd)) return null;
  const dir = latlon === "lat" ? (dd < 0 ? "S" : "N") : (dd < 0 ? "W" : "E");
  dd = Math.abs(dd);
  const deg = Math.floor(dd);
  const minFloat = (dd - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  const secStr = sec.toFixed(secDigits).replace(/\.?0+$/, "");
  return `${deg}° ${min}' ${secStr}" ${dir}`;
}
function inLatRange(v) { return v >= -90 && v <= 90; }
function inLonRange(v) { return v >= -180 && v <= 180; }

function showErr(id, on) { const el = document.getElementById(id); if (el) el.style.display = on ? "" : "none"; }

// ---------- DMS -> DD ----------
function convertDmsToDd() {
  const latStr = (document.getElementById("dms_lat_string")?.value || "").trim();
  const lonStr = (document.getElementById("dms_lon_string")?.value || "").trim();

  const latDeg = parseFloat(document.getElementById("dms_lat_deg")?.value);
  const latMin = parseFloat(document.getElementById("dms_lat_min")?.value);
  const latSec = parseFloat(document.getElementById("dms_lat_sec")?.value);
  const latDir = document.getElementById("dms_lat_dir")?.value;

  const lonDeg = parseFloat(document.getElementById("dms_lon_deg")?.value);
  const lonMin = parseFloat(document.getElementById("dms_lon_min")?.value);
  const lonSec = parseFloat(document.getElementById("dms_lon_sec")?.value);
  const lonDir = document.getElementById("dms_lon_dir")?.value;

  ["dms_lat_deg","dms_lat_min","dms_lat_sec","dms_lon_deg","dms_lon_min","dms_lon_sec"].forEach(id=>{
    document.getElementById(id)?.classList.remove("invalid");
  });
  showErr("err-dms", false);

  let dd_lat = latStr ? parseDmsString(latStr) : dmsToDd(latDeg || 0, latMin || 0, latSec || 0, latDir || "N");
  if (dd_lat === null || !inLatRange(dd_lat)) {
    if (!latStr) ["dms_lat_deg","dms_lat_min","dms_lat_sec"].forEach(id=>document.getElementById(id)?.classList.add("invalid"));
    showErr("err-dms", true); return;
  }
  let dd_lon = lonStr ? parseDmsString(lonStr) : dmsToDd(lonDeg || 0, lonMin || 0, lonSec || 0, lonDir || "E");
  if (dd_lon === null || !inLonRange(dd_lon)) {
    if (!lonStr) ["dms_lon_deg","dms_lon_min","dms_lon_sec"].forEach(id=>document.getElementById(id)?.classList.add("invalid"));
    showErr("err-dms", true); return;
  }

  const prec = parseInt(document.getElementById("precision-dd")?.value || "6", 10);
  const inputSummary =
    (latStr ? `Lat: ${latStr}\n` : `Lat: ${latDeg || 0}° ${latMin || 0}' ${latSec || 0}" ${latDir || "N"}\n`) +
    (lonStr ? `Lon: ${lonStr}` : `Lon: ${lonDeg || 0}° ${lonMin || 0}' ${lonSec || 0}" ${lonDir || "E"}`);

  const resultSummary = `Lat: ${dd_lat.toFixed(prec)}\nLon: ${dd_lon.toFixed(prec)}`;
  const ddOut = document.getElementById("dd_result");
  if (ddOut) ddOut.value = `Latitude (Y): ${dd_lat.toFixed(prec)}\nLongitude (X): ${dd_lon.toFixed(prec)}`;

  window._cordify_addHistory && window._cordify_addHistory({
    type: "DMS→DD", input: inputSummary, result: resultSummary, date: Date.now(),
  });
  if (document.getElementById("history-tab")?.style.display !== "none") {
    window._cordify_renderHistory && window._cordify_renderHistory();
  }
}

// ---------- DD -> DMS ----------
function convertDdToDms() {
  const latEl = document.getElementById("dd_lat");
  const lonEl = document.getElementById("dd_lon");
  let dd_lat = parseFloat(latEl?.value);
  let dd_lon = parseFloat(lonEl?.value);

  showErr("err-dd", false);
  if (Number.isNaN(dd_lat) || !inLatRange(dd_lat)) { showErr("err-dd", true); return; }
  if (Number.isNaN(dd_lon) || !inLonRange(dd_lon)) { showErr("err-dd", true); return; }

  const secDigits = parseInt(document.getElementById("precision-dms")?.value || "3", 10);
  const dms_lat = ddToDms(dd_lat, "lat", secDigits);
  const dms_lon = ddToDms(dd_lon, "lon", secDigits);

  const inputSummary  = `Lat: ${dd_lat}\nLon: ${dd_lon}`;
  const resultSummary = `Lat: ${dms_lat}\nLon: ${dms_lon}`;

  const dmsOut = document.getElementById("dms_result");
  if (dmsOut) dmsOut.value = `Latitude (Y): ${dms_lat}\nLongitude (X): ${dms_lon}`;

  window._cordify_addHistory && window._cordify_addHistory({
    type: "DD→DMS", input: inputSummary, result: resultSummary, date: Date.now(),
  });
  if (document.getElementById("history-tab")?.style.display !== "none") {
    window._cordify_renderHistory && window._cordify_renderHistory();
  }
}

// ---------- small helpers ----------
function clearDmsInputs() {
  ["dms_lat_string","dms_lon_string","dms_lat_deg","dms_lat_min","dms_lat_sec","dms_lon_deg","dms_lon_min","dms_lon_sec"].forEach(id=>{
    const el = document.getElementById(id); if (el) el.value = "";
  });
  ["dms_lat_deg","dms_lat_min","dms_lat_sec","dms_lon_deg","dms_lon_min","dms_lon_sec"].forEach(id=>{
    document.getElementById(id)?.classList.remove("invalid");
  });
  document.getElementById("dd_result") && (document.getElementById("dd_result").value = "");
  showErr("err-dms", false);
  persistInputs();
}
function clearDdInputs() {
  ["dd_lat","dd_lon"].forEach(id=>{ const el=document.getElementById(id); if (el) el.value=""; });
  document.getElementById("dms_result") && (document.getElementById("dms_result").value = "");
  showErr("err-dd", false);
  persistInputs();
}
function swapDd() {
  const latEl = document.getElementById("dd_lat");
  const lonEl = document.getElementById("dd_lon");
  if (!latEl || !lonEl) return;
  const tmp = latEl.value; latEl.value = lonEl.value; lonEl.value = tmp;
  persistInputs();
}

/* ======================== BATCH (Excel/CSV) ======================== */
let _batch = { rows: [], headers: [], outRows: [], outHeaders: [] };

function onBatchFormatChange() {
  const fmt = document.getElementById("batch-format")?.value || "dd-columns";
  document.getElementById("map-dd").style.display  = (fmt === "dd-columns") ? "" : "none";
  document.getElementById("map-dms").style.display = (fmt === "dms-strings") ? "" : "none";
}

async function handleBatchFile(e) {
  const file = e.target.files?.[0];
  resetBatchUI();
  if (!file) return;
  try {
    if (typeof XLSX === 'undefined') {
      showFeedback('Batch import requires the XLSX library (sheetjs). Batch features are disabled.', 'error');
      return;
    }
    const data = await file.arrayBuffer();
    // XLSX reads both Excel and CSV
    const wb = XLSX.read(data, { type: "array" });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(ws, { raw: true });
    if (!Array.isArray(json) || !json.length) throw new Error("Empty sheet");

    _batch.rows = json;
    _batch.headers = Object.keys(json[0]);

    populateMapping(_batch.headers);
    document.getElementById("batch-mapping").style.display = "";
    document.getElementById("batch-actions").style.display = "";
    document.getElementById("batch-status").textContent = `Loaded ${json.length} rows from "${sheetName}"`;
  } catch (err) {
    document.getElementById("batch-status").textContent = "Failed to read file.";
  }
}

function populateMapping(headers) {
  const ddLat = document.getElementById("map-dd-lat");
  const ddLon = document.getElementById("map-dd-lon");
  const dmsLat = document.getElementById("map-dms-lat");
  const dmsLon = document.getElementById("map-dms-lon");
  [ddLat, ddLon, dmsLat, dmsLon].forEach(sel => { sel.innerHTML = ""; headers.forEach(h => {
    const o = document.createElement("option"); o.value = o.textContent = h; sel.appendChild(o);
  });});
  onBatchFormatChange();
}

function runBatch() {
  if (!_batch.rows.length) return;

  const dir = document.getElementById("batch-direction").value;         // DD2DMS | DMS2DD
  const fmt = document.getElementById("batch-format").value;            // dd-columns | dms-strings
  let latCol, lonCol;

  if (fmt === "dd-columns") {
    latCol = document.getElementById("map-dd-lat").value;
    lonCol = document.getElementById("map-dd-lon").value;
  } else {
    latCol = document.getElementById("map-dms-lat").value;
    lonCol = document.getElementById("map-dms-lon").value;
  }

  const outRows = [];
  const outHeaders = new Set([..._batch.headers]);

  if (dir === "DD2DMS") {
    outHeaders.add("lat_dms");
    outHeaders.add("lon_dms");
    const secDigits = parseInt(document.getElementById("precision-dms")?.value || "3", 10);

    for (const row of _batch.rows) {
      const lat = parseFloat(row[latCol]);
      const lon = parseFloat(row[lonCol]);
      const latOk = !Number.isNaN(lat) && inLatRange(lat);
      const lonOk = !Number.isNaN(lon) && inLonRange(lon);
      const copy = { ...row };
      if (latOk && lonOk) {
        copy.lat_dms = ddToDms(lat, "lat", secDigits);
        copy.lon_dms = ddToDms(lon, "lon", secDigits);
      } else {
        copy.lat_dms = "";
        copy.lon_dms = "";
      }
      outRows.push(copy);
    }
  } else {
    // DMS2DD
    outHeaders.add("lat_dd");
    outHeaders.add("lon_dd");
    const prec = parseInt(document.getElementById("precision-dd")?.value || "6", 10);

    for (const row of _batch.rows) {
      const copy = { ...row };
      const latStr = String(row[latCol] ?? "").trim();
      const lonStr = String(row[lonCol] ?? "").trim();
      const lat = parseDmsString(latStr);
      const lon = parseDmsString(lonStr);
      if (lat !== null && lon !== null && inLatRange(lat) && inLonRange(lon)) {
        copy.lat_dd = lat.toFixed(prec);
        copy.lon_dd = lon.toFixed(prec);
      } else {
        copy.lat_dd = "";
        copy.lon_dd = "";
      }
      outRows.push(copy);
    }
  }

  _batch.outRows = outRows;
  _batch.outHeaders = Array.from(outHeaders);

  renderBatchPreview(outRows, _batch.outHeaders);
  document.getElementById("batch-preview-wrap").style.display = "";
  document.getElementById("batch-status").textContent = `Converted ${outRows.length} rows.`;
}

function renderBatchPreview(rows, headers) {
  const head = document.getElementById("batch-head");
  const body = document.getElementById("batch-body");
  head.innerHTML = ""; body.innerHTML = "";

  headers.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  });

  rows.slice(0, 20).forEach(r => {
    const tr = document.createElement("tr");
    headers.forEach(h => {
      const td = document.createElement("td");
      td.textContent = r[h] !== undefined ? r[h] : "";
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

function downloadBatch(type) {
  if (!_batch.outRows.length) return;
  if (type === "xlsx") {
    if (typeof XLSX === 'undefined') { alert('Excel export requires the XLSX library (sheetjs).'); return; }
    const ws = XLSX.utils.json_to_sheet(_batch.outRows, { header: _batch.outHeaders });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Converted");
    XLSX.writeFile(wb, "cordify_converted.xlsx");
  } else {
    if (typeof XLSX === 'undefined') { alert('CSV export requires the XLSX utils (sheetjs).'); return; }
    const ws = XLSX.utils.json_to_sheet(_batch.outRows, { header: _batch.outHeaders });
    const csv = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "cordify_converted.csv";
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
}

function resetBatchUI() {
  _batch = { rows: [], headers: [], outRows: [], outHeaders: [] };
  document.getElementById("batch-mapping").style.display = "none";
  document.getElementById("batch-actions").style.display = "none";
  document.getElementById("batch-preview-wrap").style.display = "none";
  document.getElementById("batch-status").textContent = "";
}

// Feedback system
function showFeedback(message, type = 'info') {
  const existing = document.querySelector('.feedback');
  if (existing) existing.remove();

  const feedback = document.createElement('div');
  feedback.className = `feedback feedback-${type}`;
  feedback.textContent = message;

  document.body.appendChild(feedback);
  requestAnimationFrame(() => feedback.classList.add('show'));

  setTimeout(() => {
    feedback.classList.remove('show');
    setTimeout(() => feedback.remove(), 300);
  }, 3000);
}

/* ======================== Map & Export Helpers ======================== */
let _map = null;
let _mapMarkers = {};
let _mapLayerGroup = null;

function initMap(){
  if (_map) return true;
  if (typeof L === 'undefined') {
    console.warn('Leaflet not loaded');
    return false;
  }

  // Check if Leaflet has the required methods
  if (!L.map || !L.tileLayer || !L.layerGroup) {
    console.error('Leaflet library is incomplete');
    return false;
  }

  const el = document.getElementById('map');
  if (!el) {
    console.warn('Map element not found');
    return false;
  }

  // Ensure the map container is visible and has dimensions
  const mapTab = document.getElementById('map-tab');
  if (!mapTab) {
    console.warn('Map tab container not found');
    return false;
  }

  // Make sure the container is visible
  if (mapTab.style.display === 'none') {
    console.warn('Map container is hidden, making it visible for initialization');
    mapTab.style.display = '';
  }

  // Ensure the element has dimensions
  if (el.offsetWidth === 0 || el.offsetHeight === 0) {
    console.warn('Map container has no dimensions, setting temporary size');
    el.style.width = '100%';
    el.style.height = '400px';
    el.style.minHeight = '400px';
  }

  try {
    console.log('Initializing Leaflet map...');
    _map = L.map(el, {
      attributionControl: true,
      preferCanvas: false
    }).setView([0,0], 2);

    _mapLayerGroup = L.layerGroup().addTo(_map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    }).addTo(_map);

    console.log('Map initialized successfully');

    // Force map to calculate size after a short delay
    setTimeout(() => {
      if (_map && _map.invalidateSize) {
        _map.invalidateSize(true);
        console.log('Map size invalidated');
      }
    }, 100);

    return true;
  } catch(e){
    console.error('Leaflet init failed:', e);
    _map = null;
    _mapLayerGroup = null;
    return false;
  }
}

function clearMap(){
  if (!_map) return;
  try { _mapLayerGroup.clearLayers(); _mapMarkers = {}; } catch(e) {}
}

function showOnMap(lat, lon, label) {
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (!initMap()) return null;

  try {
    const key = `${lat}:${lon}`;
    if (_mapMarkers[key]) {
      _mapMarkers[key].openPopup();
      _map.setView([lat, lon], Math.max(13, _map.getZoom()));
      return _mapMarkers[key];
    }

    const m = L.marker([lat, lon]);
    m.bindPopup(label || `${lat}, ${lon}`);
    m.addTo(_mapLayerGroup);
    _mapMarkers[key] = m;

    // Zoom to new marker
    _map.setView([lat, lon], 13);
    m.openPopup();
    return m;
  } catch(e) {
    console.error('showOnMap failed:', e);
    showFeedback('Failed to show point on map', 'error');
    return null;
  }
}

function parseLatLngFromOutput(s){
  if (!s || typeof s !== 'string') return null;
  // try explicit lines like 'Lat: 12.34' or 'Latitude (Y): 12.34' etc
  const latMatch = s.match(/(?:Lat(?:itude)?(?:\s*\(Y\))?\s*[:=]?\s*)(-?\d+(?:\.\d+)?)/i);
  const lonMatch = s.match(/(?:Lon(?:gitude)?(?:\s*\(X\))?\s*[:=]?\s*)(-?\d+(?:\.\d+)?)/i);
  if (latMatch && lonMatch) {
    const lat = parseFloat(latMatch[1]);
    const lon = parseFloat(lonMatch[1]);
    if (isFinite(lat) && isFinite(lon)) return [lat, lon];
  }
  // fallback: find first two float-like numbers
  const all = s.match(/-?\d+(?:\.\d+)?/g);
  if (all && all.length >= 2) {
    const a = parseFloat(all[0]); const b = parseFloat(all[1]);
    // heuristics: lat range narrower
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [a,b];
    if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return [b,a];
  }
  return null;
}

function showCurrentInMap(type) {
  const resultEl = document.getElementById(type === 'dd' ? 'dd_result' : 'dms_result');
  if (!resultEl) {
    console.error('Result element not found');
    showFeedback('Result element not found', 'error');
    return;
  }

  const resultValue = resultEl.value.trim();
  if (!resultValue) {
    showFeedback('No coordinates to display. Please convert some coordinates first.', 'error');
    return;
  }

  const coords = parseLatLngFromOutput(resultValue);
  if (!coords) {
    showFeedback('Could not parse coordinates from result', 'error');
    return;
  }

  // Switch to map tab
  const mapTabBtn = document.getElementById('tab-map');
  if (!mapTabBtn) {
    console.error('Map tab button not found');
    showFeedback('Map tab not available', 'error');
    return;
  }
  
  mapTabBtn.click();

  // Wait for map to render, then plot point
  const [lat, lon] = coords;
  setTimeout(() => {
    if (!initMap()) {
      showFeedback('Failed to initialize map', 'error');
      return;
    }
    // Ensure map size is correct after tab switch
    if (_map && _map.invalidateSize) {
      _map.invalidateSize(true);
    }
    const marker = showOnMap(lat, lon, `Current Result: ${resultValue}`);
    if (marker) {
      showFeedback('Point plotted on map', 'success');
    } else {
      showFeedback('Failed to plot point on map', 'error');
    }
  }, 300);
}

// Expose the function to the global scope for the "Show in Map" button
window.showCurrentInMap = showCurrentInMap;

function showHistoryItemOnMap(idOrIndex) {
  let rec = null;
  if (window.historyStore && typeof window.historyStore.getById === 'function' && typeof idOrIndex === 'string') {
    rec = window.historyStore.getById(idOrIndex);
  }
  if (!rec) {
    const h = getHistory();
    if (typeof idOrIndex === 'number') rec = h[idOrIndex];
    else rec = h.find(r => r.id === idOrIndex) || null;
  }
  if (!rec) {
    showFeedback('History item not found', 'error');
    return;
  }

  // Switch to map tab
  const mapTabBtn = document.getElementById('tab-map');
  if (!mapTabBtn) {
    console.error('Map tab button not found');
    return;
  }
  mapTabBtn.click();

  // Parse and plot
  const s = rec.result || rec.output || '';
  const coords = parseLatLngFromOutput(s);
  if (!coords) {
    showFeedback('Could not parse coordinates from history item', 'error');
    return;
  }

  // Wait for map to render, then plot point
  const [lat, lon] = coords;
  setTimeout(() => {
    if (!initMap()) {
      showFeedback('Failed to initialize map', 'error');
      return;
    }
    // Ensure map size is correct after tab switch
    if (_map && _map.invalidateSize) {
      _map.invalidateSize();
    }
    showOnMap(lat, lon, `${rec.type || ''} — ${rec.input}`);
    showFeedback('Point plotted on map', 'success');
  }, 200);
}

// Expose to global scope for inline onclick handlers
window.showHistoryItemOnMap = showHistoryItemOnMap;

function plotAllHistory(){
  if (!initMap()) {
    alert('Map initialization failed');
    return 0;
  }
  clearMap();
  const items = getHistory();
  let count = 0;
  const bounds = L.latLngBounds();
  let needsFit = false;

  // Batch markers for better performance
  const batch = [];
  for (const it of items){
    const s = it.result || it.output || '';
    const coords = parseLatLngFromOutput(s);
    if (!coords) continue;
    const [lat, lon] = coords;
    if (!isFinite(lat) || !isFinite(lon)) continue;

    batch.push({
      latlng: [lat, lon],
      label: `${it.type || ''} — ${it.input}`
    });
    bounds.extend([lat, lon]);
    needsFit = true;
    count++;

    if (count > 5000) {
      alert('Too many points — plotting stopped at 5000.');
      break;
    }
  }

  // Add markers in batches of 100 for smoother UI
  for (let i = 0; i < batch.length; i += 100) {
    const chunk = batch.slice(i, i + 100);
    setTimeout(() => {
      chunk.forEach(({latlng, label}) => {
        try { showOnMap(latlng[0], latlng[1], label); } catch(e){}
      });
      // Only fit bounds after the last batch
      if (needsFit && i >= batch.length - 100) {
        try { _map.fitBounds(bounds, { padding: [20, 20] }); } catch(e){}
      }
    }, Math.floor(i / 100) * 50); // 50ms delay between batches
  }
  return count;
}

function downloadBlob(filename, blob){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
}

function historyToGeoJSON(items, targetEpsg = 'EPSG:4326'){
  const features = [];
  for (const it of items){
    const s = it.result || it.output || '';
    const coords = parseLatLngFromOutput(s);
    if (!coords) continue;
    let [lat, lon] = coords;
    // if reprojection requested and proj4 available
    if (targetEpsg !== 'EPSG:4326' && typeof proj4 !== 'undefined'){
      try {
        const p = proj4('EPSG:4326', targetEpsg, [lon, lat]); // returns [x,y]
        // for GeoJSON we still put lon,lat if target is 4326. If target projected, use x,y
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[p[0], p[1]] }, properties:{ id: it.id || null, ts: it.ts||it.date||null, input: it.input||'', output: it.output||it.result||'', type: it.type||'' } });
        continue;
      } catch(e){ /* fallthrough to default */ }
    }
    features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[lon, lat] }, properties:{ id: it.id || null, ts: it.ts||it.date||null, input: it.input||'', output: it.output||it.result||'', type: it.type||'' } });
  }
  return { type:'FeatureCollection', features };
}

function historyToKml(items){
  // Helper to escape XML special characters
  function escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  
  // Helper to sanitize CDATA content (cannot contain ]]>)
  function sanitizeCDATA(str) {
    return String(str).replace(/]]>/g, ']] >');
  }
  
  const pls = [];
  for (const it of items){
    const s = it.result || it.output || '';
    const coords = parseLatLngFromOutput(s);
    if (!coords) continue;
    const [lat, lon] = coords;
    const name = escapeXml(it.input || '');
    const desc = sanitizeCDATA(it.output || it.result || '');
    const ts = it.ts || it.date || '';
    pls.push(`<Placemark><name>${name}</name><description><![CDATA[${desc}<br/>${ts}]]></description><Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Cordify Export</name>${pls.join('\n')}</Document></kml>`;
}

async function exportHistoryAsGeoJSON(filename='history.geojson', targetEpsg='EPSG:4326'){
  const items = getHistory();
  const geo = historyToGeoJSON(items, targetEpsg);
  const blob = new Blob([JSON.stringify(geo, null, 2)], { type: 'application/geo+json' });
  downloadBlob(filename, blob);
}

function exportHistoryAsKml(filename='history.kml'){
  const items = getHistory();
  const kml = historyToKml(items);
  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
  downloadBlob(filename, blob);
}

async function exportHistoryAsKmz(filename='history.kmz'){
  const items = getHistory();
  const kml = historyToKml(items);
  if (typeof JSZip === 'undefined') { alert('JSZip not loaded'); return; }
  const zip = new JSZip(); zip.file('doc.kml', kml);
  const content = await zip.generateAsync({ type:'blob', compression:'DEFLATE' });
  downloadBlob(filename, content);
}
/* ====================== END BATCH ====================== */
})(); // End of main IIFE
} // End of initCordifyApp function
