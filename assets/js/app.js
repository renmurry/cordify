// scripts for cordify
console.log('app.js loaded');

// --- Cordify App: Conversion History, Export, and UI Tabs ---
(function() {
  // --- Constants ---
  const HISTORY_KEY = 'cordify_history';
  const MAX_HISTORY = 1000; // limit for localStorage

  // --- Tab Navigation ---
  document.addEventListener('DOMContentLoaded', () => {
    const convertTab = document.getElementById('convert-tab');
    const historyTab = document.getElementById('history-tab');
    const btnConvert = document.getElementById('tab-convert');
    const btnHistory = document.getElementById('tab-history');
    if (btnConvert && btnHistory && convertTab && historyTab) {
      btnConvert.onclick = () => { convertTab.style.display = ''; historyTab.style.display = 'none'; };
      btnHistory.onclick = () => { convertTab.style.display = 'none'; historyTab.style.display = ''; renderHistoryTable(); };
    }
    // Initial tab
    if (convertTab) convertTab.style.display = '';
    if (historyTab) historyTab.style.display = 'none';
  });

  // --- History Storage ---
  function getHistory() {
    try {
      const arr = JSON.parse(localStorage.getItem(HISTORY_KEY));
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveHistory(arr) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(-MAX_HISTORY)));
    } catch (e) { /* handle quota exceeded */ }
  }
  function addHistory(entry) {
    const arr = getHistory();
    arr.push(entry);
    saveHistory(arr);
  }
  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
  }

  // --- UI: Render History Table ---
  function renderHistoryTable() {
    const table = document.getElementById('history-table');
    const tbody = table ? table.querySelector('tbody') : null;
    const emptyMsg = document.getElementById('history-empty');
    if (!tbody) return;
    tbody.innerHTML = '';
    const arr = getHistory().filter(item => item.type === 'DD→DMS'); // Filter for DD→DMS conversions only
    if (!arr.length) {
      if (emptyMsg) emptyMsg.style.display = '';
      table.style.display = 'none';
      return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';
    table.style.display = '';
    arr.forEach((item, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${item.type || ''}</td>
        <td><pre style="white-space:pre-wrap;margin:0" title="${escapeHtml(item.input)}">${escapeHtml(item.input)}</pre></td>
        <td><pre style="white-space:pre-wrap;margin:0" title="${escapeHtml(item.result)}">${escapeHtml(item.result)}</pre></td>
        <td>${item.date ? new Date(item.date).toLocaleString() : ''}</td>
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
  });

  // --- Export All (Excel/CSV) ---
  document.addEventListener('DOMContentLoaded', () => {
    const btnXlsx = document.getElementById('export-history-xlsx');
    const btnCsv = document.getElementById('export-history-csv');
    if (btnXlsx) btnXlsx.onclick = () => exportHistory('xlsx');
    if (btnCsv) btnCsv.onclick = () => exportHistory('csv');
    // Row export + copy actions
    document.getElementById('history-table')?.addEventListener('click', e => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.classList.contains('export-row-xlsx')) exportHistory('xlsx', parseInt(target.dataset.idx));
      if (target.classList.contains('export-row-csv')) exportHistory('csv', parseInt(target.dataset.idx));
      if (target.classList.contains('copy-in')) {
        const arr = getHistory(); const idx = parseInt(target.dataset.idx);
        if (arr[idx]) copyText(arr[idx].input);
      }
      if (target.classList.contains('copy-out')) {
        const arr = getHistory(); const idx = parseInt(target.dataset.idx);
        if (arr[idx]) copyText(arr[idx].result);
      }
    });
  });

  function copyText(text) {
    const t = String(text ?? '');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(t).then(()=>{},()=>fallback());
    } else {
      fallback();
    }
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
  }

  // --- Export Logic ---
  function exportHistory(type, rowIdx) {
    const arr = getHistory();
    let data = arr;
    if (typeof rowIdx === 'number' && arr[rowIdx]) data = [arr[rowIdx]];
    if (!data.length) return;
    // Format for export
    const exportArr = data.map((item, i) => ({
      '#': rowIdx !== undefined ? (rowIdx+1) : (i+1),
      'Type': item.type || '',
      'Input': item.input,
      'Result': item.result,
      'Date': item.date ? new Date(item.date).toLocaleString() : ''
    }));
    if (type === 'xlsx') {
      try {
        const ws = XLSX.utils.json_to_sheet(exportArr);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'History');
        XLSX.writeFile(wb, rowIdx !== undefined ? `cordify_conversion_${rowIdx+1}.xlsx` : 'cordify_history.xlsx');
      } catch (e) { alert('Excel export failed.'); }
    } else if (type === 'csv') {
      try {
        const csv = toCsv(exportArr);
        const blob = new Blob([csv], {type:'text/csv'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = rowIdx !== undefined ? `cordify_conversion_${rowIdx+1}.csv` : 'cordify_history.csv';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      } catch (e) { alert('CSV export failed.'); }
    }
  }
  // --- CSV helper ---
  function toCsv(arr) {
    if (!arr.length) return '';
    const keys = Object.keys(arr[0]);
    const esc = v => '"'+String(v).replace(/"/g,'""')+'"';
    return keys.join(',') + '\n' + arr.map(row => keys.map(k => esc(row[k])).join(',')).join('\n');
  }

  // --- Hook into conversions to store history ---
  window._cordify_addHistory = addHistory;
  window._cordify_renderHistory = renderHistoryTable;
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

// Store prefill in sessionStorage; renderConvert reads it
function hydrateConverterFromHistory(rec) {
  // Not used in original implementation
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

  // Build input and result summaries, update UI, and store history

  let inputSummary = '', resultSummary = '';

    if (latStr) {
      dd_lat = parseDmsString(latStr);
      if (dd_lat === null || !inLatRange(dd_lat)) { alert('Invalid Latitude DMS.'); return; }
      inputSummary += `Lat: ${latStr}\n`;
    } else {
      dd_lat = dmsToDd(
        parseFloat(document.getElementById('dms_lat_deg').value) || 0,
        parseFloat(document.getElementById('dms_lat_min').value) || 0,
        parseFloat(document.getElementById('dms_lat_sec').value) || 0,
        document.getElementById('dms_lat_dir').value
      );
      if (dd_lat === null || !inLatRange(dd_lat)) { alert('Invalid Latitude D/M/S.'); return; }
      inputSummary += `Lat: ${document.getElementById('dms_lat_deg').value}° ${document.getElementById('dms_lat_min').value}' ${document.getElementById('dms_lat_sec').value}" ${document.getElementById('dms_lat_dir').value}\n`;
    }

    if (lonStr) {
      dd_lon = parseDmsString(lonStr);
      if (dd_lon === null || !inLonRange(dd_lon)) { alert('Invalid Longitude DMS.'); return; }
      inputSummary += `Lon: ${lonStr}`;
    } else {
      dd_lon = dmsToDd(
        parseFloat(document.getElementById('dms_lon_deg').value) || 0,
        parseFloat(document.getElementById('dms_lon_min').value) || 0,
        parseFloat(document.getElementById('dms_lon_sec').value) || 0,
        document.getElementById('dms_lon_dir').value
      );
      if (dd_lon === null || !inLonRange(dd_lon)) { alert('Invalid Longitude D/M/S.'); return; }
      inputSummary += `Lon: ${document.getElementById('dms_lon_deg').value}° ${document.getElementById('dms_lon_min').value}' ${document.getElementById('dms_lon_sec').value}" ${document.getElementById('dms_lon_dir').value}`;
    }

    resultSummary = `Lat: ${dd_lat.toFixed(6)}\nLon: ${dd_lon.toFixed(6)}`;
    document.getElementById('dd_result').value =
      `Latitude (Y): ${dd_lat.toFixed(6)}\nLongitude (X): ${dd_lon.toFixed(6)}`;

    // Store in history
    window._cordify_addHistory && window._cordify_addHistory({
      type: 'DMS→DD',
      input: inputSummary,
      result: resultSummary,
      date: Date.now()
    });
    // Refresh history if visible
    if (document.getElementById('history-tab')?.style.display !== 'none') {
      window._cordify_renderHistory && window._cordify_renderHistory();
    }
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
  // Store in history
  window._cordify_addHistory && window._cordify_addHistory({
    type: 'DD→DMS',
    input: inputSummary,
    result: resultSummary,
    date: Date.now()
  });
  // Refresh history if visible
  if (document.getElementById('history-tab')?.style.display !== 'none') {
    window._cordify_renderHistory && window._cordify_renderHistory();
  }
}
