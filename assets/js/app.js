// scripts for cordify
console.log('app.js loaded');

// Register Service Worker (handles GitHub Pages subpath)
(() => {
  if ('serviceWorker' in navigator) {
    const swUrl = 'service-worker.js';
    const scope = './';
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(swUrl, { scope }).catch(() => {/* no-op */});
    });
  }
})();

// --- Cordify App: Converter, History (read-only), and UI Tabs ---
(function() {
  // --- Constants ---
  const DEFAULT_META = { crs: 'EPSG:4326', precision: 6 };

  // --- Tab Navigation ---
  document.addEventListener('DOMContentLoaded', () => {
    const convertTab = document.getElementById('convert-tab');
    const historyTab = document.getElementById('history-tab');
    const btnConvert = document.getElementById('tab-convert');
    const btnHistory = document.getElementById('tab-history');
    if (btnConvert && btnHistory && convertTab && historyTab) {
      btnConvert.onclick = () => { convertTab.style.display = ''; historyTab.style.display = 'none'; };
      btnHistory.onclick = () => { convertTab.style.display = 'none'; historyTab.style.display = ''; renderHistoryPanel(); };
    }
    // Initial tab
    if (convertTab) convertTab.style.display = '';
    if (historyTab) historyTab.style.display = 'none';
  });

  // --- UI: Render History Panel (read-only) ---
  function renderHistoryPanel() {
    const table = document.getElementById('history-table');
    const tbody = table ? table.querySelector('tbody') : null;
    const emptyMsg = document.getElementById('history-empty');
    const filterSel = document.getElementById('history-filter');
    if (!tbody) return;
    tbody.innerHTML = '';
    const type = filterSel?.value || 'all';
    const arr = (window.historyStore?.filterByType(type)) || [];
    if (!arr.length) {
      if (emptyMsg) emptyMsg.style.display = '';
      table.style.display = 'none';
      return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';
    table.style.display = '';
    arr.forEach((item) => {
      const tr = document.createElement('tr');
      const time = new Date(item.ts || item.date || Date.now()).toLocaleString();
      tr.innerHTML = `
        <td>${escapeHtml(time)}</td>
        <td>${item.type || ''}</td>
        <td><pre style="white-space:pre-wrap;margin:0">${escapeHtml(item.input)}</pre></td>
        <td><pre style="white-space:pre-wrap;margin:0">${escapeHtml(item.output || item.result || '')}</pre></td>
        <td>
          <button type="button" class="h-copy-in" data-id="${item.id}">Copy In</button>
          <button type="button" class="h-copy-out" data-id="${item.id}">Copy Out</button>
          <button type="button" class="h-rerun" data-id="${item.id}">Re-run</button>
          <button type="button" class="h-del" data-id="${item.id}">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // --- Escape HTML for safe rendering ---
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
  }

  // --- Clear History Button ---
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('clear-history-btn');
    if (btn) {
      btn.onclick = () => {
        if (confirm('Clear all conversion history?')) {
          clearHistory();
          renderHistoryTable();
        }
      };
    }
    // Copy buttons
    const copyDd = document.getElementById('copy-dd-btn');
    const copyDms = document.getElementById('copy-dms-btn');
    copyDd && (copyDd.onclick = async () => {
      const txt = document.getElementById('dd_result')?.value || '';
      if (!txt) return;
      try { await navigator.clipboard.writeText(txt); copyDd.textContent = 'Copied'; setTimeout(()=>copyDd.textContent='Copy',1000); } catch {}
    });
    copyDms && (copyDms.onclick = async () => {
      const txt = document.getElementById('dms_result')?.value || '';
      if (!txt) return;
      try { await navigator.clipboard.writeText(txt); copyDms.textContent = 'Copied'; setTimeout(()=>copyDms.textContent='Copy',1000); } catch {}
    });
  });

  // --- History actions and filter ---
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('history-filter')?.addEventListener('change', () => renderHistoryPanel());
    document.getElementById('history-table')?.addEventListener('click', async (e) => {
      const id = e.target.dataset?.id;
      if (!id) return;
      if (e.target.classList.contains('h-copy-in')) {
        const rec = window.historyStore?.getById(id); if (!rec) return;
        await navigator.clipboard.writeText(rec.input || '');
      } else if (e.target.classList.contains('h-copy-out')) {
        const rec = window.historyStore?.getById(id); if (!rec) return;
        await navigator.clipboard.writeText(rec.output || rec.result || '');
      } else if (e.target.classList.contains('h-rerun')) {
        const rec = window.historyStore?.getById(id); if (!rec) return;
        hydrateConverterFromHistory(rec);
        // switch to converter tab
        document.getElementById('tab-convert')?.click();
      } else if (e.target.classList.contains('h-del')) {
        window.historyStore?.remove(id);
        renderHistoryPanel();
      }
    });
  });

  // (Export functionality removed per new read-only History requirements)

  // --- Hook into conversions to store history ---
  // expose render to refresh panel
  window._cordify_renderHistory = renderHistoryPanel;
})();

// ...existing code...

// ---- Robust DMS string parser ----
// Supports: symbols/spaces, , as decimal, signed degrees, leading/trailing NSEW,
// and partial forms: D°, D M, D M S (with or without ° ' ").
function parseDmsString(dmsStr) {
  if (!dmsStr) return null;

  // Normalize
  dmsStr = dmsStr.trim()
    .replace(/[′’‘`´]/g, "'")        // variants -> '
    .replace(/[″“”]/g, '"')          // variants -> "
    .replace(/\u00B0/g, '°')         // ensure standard degree symbol
    .replace(/,/g, '.')              // allow comma decimals
    .toUpperCase()
    .replace(/\s+/g, ' ');

  // Grab leading/trailing direction
  let leadDir = (dmsStr.match(/^[NSWE]/) || [null])[0];
  let tailDir = (dmsStr.match(/[NSWE]$/) || [null])[0];

  if (leadDir && tailDir && leadDir !== tailDir) return null; // conflicting
  let dir = tailDir || leadDir || null;

  // Strip direction chars for numeric parsing
  if (leadDir) dmsStr = dmsStr.slice(1).trim();
  if (tailDir) dmsStr = dmsStr.slice(0, -1).trim();

  // Match deg [min] [sec] using either symbols or spaces
  // Examples: 25 34 47.035 | 25°34'47.035" | -23° 30' | +10 12.5 | 10° | 10 12
  const regex = /^([+-]?\d+(?:\.\d+)?)(?:[°\s]+(\d+(?:\.\d+)?))?(?:['\s]+(\d+(?:\.\d+)?))?(?:"?)$/;
  const m = dmsStr.match(regex);
  if (!m) return null;

  let deg = parseFloat(m[1]);
  let min = m[2] !== undefined ? parseFloat(m[2]) : 0;
  let sec = m[3] !== undefined ? parseFloat(m[3]) : 0;

  if ([deg, min, sec].some(Number.isNaN)) return null;
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;

  let dd = Math.abs(deg) + (min / 60) + (sec / 3600);
  if (deg < 0) dd = -dd; // signed degree overrides
  if (dir === 'S' || dir === 'W') dd = -Math.abs(dd); // NSEW applies sign

  return dd;
}

function dmsToDd(deg, min, sec, dir) {
  if ([deg, min, sec].some(v => Number.isNaN(v))) return null;
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;
  let dd = Math.abs(deg) + min / 60 + sec / 3600;
  if (dir === "S" || dir === "W") dd *= -1;
  if (deg < 0) dd *= -1; // if user typed negative deg, respect it
  return dd;
}

function ddToDms(dd, latlon) {
  if (Number.isNaN(dd)) return null;
  const dir = latlon === "lat" ? (dd < 0 ? "S" : "N") : (dd < 0 ? "W" : "E");
  dd = Math.abs(dd);
  const deg = Math.floor(dd);
  const minFloat = (dd - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = ((minFloat - min) * 60);
  const secStr = sec.toFixed(3).replace(/\.?0+$/,''); // trim trailing zeros
  return `${deg}° ${min}' ${secStr}" ${dir}`;
}

function inLatRange(v) { return v >= -90 && v <= 90; }
function inLonRange(v) { return v >= -180 && v <= 180; }

// Hydrate converter form based on saved history record
function hydrateConverterFromHistory(rec) {
  if (!rec || !rec.type) return;
  if (rec.type === 'DD→DMS') {
    // parse input like: "Lat: 12.34\nLon: 56.78"
    const mLat = /Lat:\s*([-+]?\d+(?:\.\d+)?)/.exec(rec.input || '');
    const mLon = /Lon:\s*([-+]?\d+(?:\.\d+)?)/.exec(rec.input || '');
    if (mLat) document.getElementById('dd_lat').value = mLat[1];
    if (mLon) document.getElementById('dd_lon').value = mLon[1];
  } else if (rec.type === 'DMS→DD') {
    // Attempt to repopulate the single-string inputs for convenience if present
    const lines = (rec.input || '').split(/\n/);
    const latLine = lines.find(l=>/^Lat:/i.test(l)) || '';
    const lonLine = lines.find(l=>/^Lon:/i.test(l)) || '';
    const latStr = latLine.replace(/^Lat:\s*/, '');
    const lonStr = lonLine.replace(/^Lon:\s*/, '');
    const latEl = document.getElementById('dms_lat_string');
    const lonEl = document.getElementById('dms_lon_string');
    if (latEl) latEl.value = latStr;
    if (lonEl) lonEl.value = lonStr;
  }
}

function convertDmsToDd() {
  const latStr = (document.getElementById('dms_lat_string')?.value || '').trim();
  const lonStr = (document.getElementById('dms_lon_string')?.value || '').trim();

  const latDeg = parseFloat(document.getElementById('dms_lat_deg')?.value);
  const latMin = parseFloat(document.getElementById('dms_lat_min')?.value);
  const latSec = parseFloat(document.getElementById('dms_lat_sec')?.value);
  const latDir = document.getElementById('dms_lat_dir')?.value;

  const lonDeg = parseFloat(document.getElementById('dms_lon_deg')?.value);
  const lonMin = parseFloat(document.getElementById('dms_lon_min')?.value);
  const lonSec = parseFloat(document.getElementById('dms_lon_sec')?.value);
  const lonDir = document.getElementById('dms_lon_dir')?.value;

  // remove invalid styles first
  ['dms_lat_deg','dms_lat_min','dms_lat_sec','dms_lon_deg','dms_lon_min','dms_lon_sec'].forEach(id=>{
    const el = document.getElementById(id); el && el.classList.remove('invalid');
  });
  let dd_lat = latStr ? parseDmsString(latStr) : dmsToDd(latDeg || 0, latMin || 0, latSec || 0, latDir || 'N');
  if (dd_lat === null || !inLatRange(dd_lat)) {
    if (!latStr) ['dms_lat_deg','dms_lat_min','dms_lat_sec'].forEach(id=>document.getElementById(id)?.classList.add('invalid'));
    alert('Invalid Latitude.'); return;
  }
  let dd_lon = lonStr ? parseDmsString(lonStr) : dmsToDd(lonDeg || 0, lonMin || 0, lonSec || 0, lonDir || 'E');
  if (dd_lon === null || !inLonRange(dd_lon)) {
    if (!lonStr) ['dms_lon_deg','dms_lon_min','dms_lon_sec'].forEach(id=>document.getElementById(id)?.classList.add('invalid'));
    alert('Invalid Longitude.'); return;
  }

  const precision = DEFAULT_META.precision;
  const ddText = `Latitude (Y): ${dd_lat.toFixed(precision)}\nLongitude (X): ${dd_lon.toFixed(precision)}`;
  document.getElementById('dd_result').value = ddText;

  const inputSummary = latStr
    ? `Lat: ${latStr}\n`
    : `Lat: ${document.getElementById('dms_lat_deg')?.value}° ${document.getElementById('dms_lat_min')?.value}' ${document.getElementById('dms_lat_sec')?.value}" ${latDir}` + '\n';
  const inputSummary2 = lonStr
    ? `Lon: ${lonStr}`
    : `Lon: ${document.getElementById('dms_lon_deg')?.value}° ${document.getElementById('dms_lon_min')?.value}' ${document.getElementById('dms_lon_sec')?.value}" ${lonDir}`;

  const resultSummary = `Lat: ${dd_lat.toFixed(precision)}\nLon: ${dd_lon.toFixed(precision)}`;
  window.historyStore?.add({ type: 'DMS→DD', input: inputSummary + inputSummary2, output: resultSummary, meta: { ...DEFAULT_META } });
  if (document.getElementById('history-tab')?.style.display !== 'none') window._cordify_renderHistory && window._cordify_renderHistory();
}

function convertDdToDms() {
  let dd_lat = parseFloat(document.getElementById('dd_lat').value);
  let dd_lon = parseFloat(document.getElementById('dd_lon').value);
  let inputSummary = '', resultSummary = '';

  if (Number.isNaN(dd_lat) || !inLatRange(dd_lat)) { alert('Enter a valid latitude in DD (−90..90).'); return; }
  if (Number.isNaN(dd_lon) || !inLonRange(dd_lon)) { alert('Enter a valid longitude in DD (−180..180).'); return; }

  let dms_lat = ddToDms(dd_lat, "lat");
  let dms_lon = ddToDms(dd_lon, "lon");

  inputSummary = `Lat: ${dd_lat}\nLon: ${dd_lon}`;
  resultSummary = `Lat: ${dms_lat}\nLon: ${dms_lon}`;
  document.getElementById('dms_result').value = `Latitude (Y): ${dms_lat}\nLongitude (X): ${dms_lon}`;

  // Store in history
  window.historyStore?.add({ type: 'DD→DMS', input: inputSummary, output: resultSummary, meta: { ...DEFAULT_META } });
  if (document.getElementById('history-tab')?.style.display !== 'none') window._cordify_renderHistory && window._cordify_renderHistory();
}
