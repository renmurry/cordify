// scripts for cordify
console.log("app.js loaded");

/* --------------------------------------------------------------------------
   Cordify: tabs + history-only view + robust storage
   Assumptions (HTML ids):
   - Tabs: #tab-convert, #tab-history (the buttons)
   - Sections/containers: #convert-tab (all conversion UI), #history-tab (history view only)
   - History table container: #history-table (with a <tbody>), empty-state: #history-empty
   - Optional buttons (will be hidden in history-only mode anyway):
       #clear-history-btn, #export-history-xlsx, #export-history-csv
--------------------------------------------------------------------------- */

(function () {
  // --- Constants ---
  const MAX_HISTORY = 1000;                  // localStorage cap
  const LS_KEY = "cordify_history_v1";       // storage key

  // --- Utilities: storage ---
  function getHistory() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function setHistory(arr) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(0, MAX_HISTORY)));
    } catch {}
  }

  function addHistory(rec) {
    const arr = getHistory();
    // newest first
    arr.unshift({
      type: rec.type || "",
      input: String(rec.input ?? ""),
      result: String(rec.result ?? ""),
      date: rec.date || Date.now(),
    });
    setHistory(arr);
  }

  function clearHistory() {
    try { localStorage.removeItem(LS_KEY); } catch {}
  }

  // expose minimal API for converters
  window._cordify_addHistory = addHistory;
  window._cordify_renderHistory = renderHistoryTable;

  // --- Tabs (strict show-one) ---
  document.addEventListener("DOMContentLoaded", () => {
    const convertTab = document.getElementById("convert-tab");
    const historyTab = document.getElementById("history-tab");
    const btnConvert = document.getElementById("tab-convert");
    const btnHistory = document.getElementById("tab-history");

    // helper to hide any stray UI not meant for History-only view
    function enterHistoryOnly() {
      if (convertTab) convertTab.style.display = "none";
      if (historyTab) historyTab.style.display = "";
      // hide optional actions so it's truly "only past conversions"
      hideNodeById("clear-history-btn");
      hideNodeById("export-history-xlsx");
      hideNodeById("export-history-csv");
      renderHistoryTable();
    }
    function enterConversion() {
      if (convertTab) convertTab.style.display = "";
      if (historyTab) historyTab.style.display = "none";
      // show optional actions again if they exist (your call)
      showNodeById("clear-history-btn");
      showNodeById("export-history-xlsx");
      showNodeById("export-history-csv");
    }

    btnConvert && (btnConvert.onclick = enterConversion);
    btnHistory && (btnHistory.onclick = enterHistoryOnly);

    // initial state: Conversion
    enterConversion();

    // Wire "Clear History" if present (kept but hidden in History-only view)
    const btnClear = document.getElementById("clear-history-btn");
    if (btnClear) {
      btnClear.onclick = () => {
        if (confirm("Clear all conversion history?")) {
          clearHistory();
          renderHistoryTable();
        }
      };
    }

    // Optional exports (kept for future; hidden in History-only view)
    const btnXlsx = document.getElementById("export-history-xlsx");
    const btnCsv  = document.getElementById("export-history-csv");
    if (btnXlsx) btnXlsx.onclick = () => exportHistory("xlsx");
    if (btnCsv)  btnCsv.onclick  = () => exportHistory("csv");

    // Row actions (only matter if you add such buttons to rows)
    document.getElementById("history-table")?.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.classList.contains("export-row-xlsx")) exportHistory("xlsx", parseInt(target.dataset.idx));
      if (target.classList.contains("export-row-csv"))  exportHistory("csv",  parseInt(target.dataset.idx));
      if (target.classList.contains("copy-in")) {
        const arr = getHistory(); const idx = parseInt(target.dataset.idx);
        if (arr[idx]) copyText(arr[idx].input);
      }
      if (target.classList.contains("copy-out")) {
        const arr = getHistory(); const idx = parseInt(target.dataset.idx);
        if (arr[idx]) copyText(arr[idx].result);
      }
    });
  });

  // --- History table rendering (read-only list; newest first) ---
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
      `;
      tbody.appendChild(tr);
    });
  }

  // --- Helpers ---
  function hideNodeById(id){ const el=document.getElementById(id); if (el) el.style.display="none"; }
  function showNodeById(id){ const el=document.getElementById(id); if (el) el.style.display=""; }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function copyText(text) {
    const t = String(text ?? "");
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(t).catch(()=>fallback());
    } else {
      fallback();
    }
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
  }

  // --- Export (works only if you add export buttons; hidden in history-only view) ---
  function exportHistory(type, rowIdx) {
    const arr = getHistory();
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
      try {
        const ws = XLSX.utils.json_to_sheet(exportArr);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "History");
        XLSX.writeFile(wb, rowIdx !== undefined ? `cordify_conversion_${rowIdx+1}.xlsx` : "cordify_history.xlsx");
      } catch { alert("Excel export failed."); }
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
  }

  function toCsv(arr) {
    if (!arr.length) return "";
    const keys = Object.keys(arr[0]);
    const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
    return keys.join(",") + "\n" + arr.map(row => keys.map(k => esc(row[k])).join(",")).join("\n");
  }
})();

/* ----------------------------- Converters ----------------------------- */
// Robust DMS string parser (symbols/spaces, comma decimals, signed deg, NSEW)
function parseDmsString(dmsStr) {
  if (!dmsStr) return null;
  dmsStr = dmsStr.trim()
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/\u00B0/g, "°")
    .replace(/,/g, ".")
    .toUpperCase()
    .replace(/\s+/g, " ");

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
  if (deg < 0) dd *= -1; // respect negative degree input
  return dd;
}

function ddToDms(dd, latlon) {
  if (Number.isNaN(dd)) return null;
  const dir = latlon === "lat" ? (dd < 0 ? "S" : "N") : (dd < 0 ? "W" : "E");
  dd = Math.abs(dd);
  const deg = Math.floor(dd);
  const minFloat = (dd - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  const secStr = sec.toFixed(3).replace(/\.?0+$/, "");
  return `${deg}° ${min}' ${secStr}" ${dir}`;
}

function inLatRange(v) { return v >= -90 && v <= 90; }
function inLonRange(v) { return v >= -180 && v <= 180; }

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

  let dd_lat = latStr ? parseDmsString(latStr) : dmsToDd(latDeg || 0, latMin || 0, latSec || 0, latDir || "N");
  if (dd_lat === null || !inLatRange(dd_lat)) {
    if (!latStr) ["dms_lat_deg","dms_lat_min","dms_lat_sec"].forEach(id=>document.getElementById(id)?.classList.add("invalid"));
    alert("Invalid Latitude."); return;
  }

  let dd_lon = lonStr ? parseDmsString(lonStr) : dmsToDd(lonDeg || 0, lonMin || 0, lonSec || 0, lonDir || "E");
  if (dd_lon === null || !inLonRange(dd_lon)) {
    if (!lonStr) ["dms_lon_deg","dms_lon_min","dms_lon_sec"].forEach(id=>document.getElementById(id)?.classList.add("invalid"));
    alert("Invalid Longitude."); return;
  }

  // input summary
  const inputSummary =
    (latStr ? `Lat: ${latStr}\n` : `Lat: ${latDeg || 0}° ${latMin || 0}' ${latSec || 0}" ${latDir || "N"}\n`) +
    (lonStr ? `Lon: ${lonStr}` : `Lon: ${lonDeg || 0}° ${lonMin || 0}' ${lonSec || 0}" ${lonDir || "E"}`);

  const resultSummary = `Lat: ${dd_lat.toFixed(6)}\nLon: ${dd_lon.toFixed(6)}`;
  const ddOut = document.getElementById("dd_result");
  if (ddOut) {
    ddOut.value = `Latitude (Y): ${dd_lat.toFixed(6)}\nLongitude (X): ${dd_lon.toFixed(6)}`;
  }

  window._cordify_addHistory && window._cordify_addHistory({
    type: "DMS→DD",
    input: inputSummary,
    result: resultSummary,
    date: Date.now(),
  });

  if (document.getElementById("history-tab")?.style.display !== "none") {
    window._cordify_renderHistory && window._cordify_renderHistory();
  }
}

function convertDdToDms() {
  const latEl = document.getElementById("dd_lat");
  const lonEl = document.getElementById("dd_lon");
  let dd_lat = parseFloat(latEl?.value);
  let dd_lon = parseFloat(lonEl?.value);

  if (Number.isNaN(dd_lat) || !inLatRange(dd_lat)) { alert("Enter a valid latitude in DD (−90..90)."); return; }
  if (Number.isNaN(dd_lon) || !inLonRange(dd_lon)) { alert("Enter a valid longitude in DD (−180..180)."); return; }

  const dms_lat = ddToDms(dd_lat, "lat");
  const dms_lon = ddToDms(dd_lon, "lon");

  const inputSummary  = `Lat: ${dd_lat}\nLon: ${dd_lon}`;
  const resultSummary = `Lat: ${dms_lat}\nLon: ${dms_lon}`;

  const dmsOut = document.getElementById("dms_result");
  if (dmsOut) {
    dmsOut.value = `Latitude (Y): ${dms_lat}\nLongitude (X): ${dms_lon}`;
  }

  window._cordify_addHistory && window._cordify_addHistory({
    type: "DD→DMS",
    input: inputSummary,
    result: resultSummary,
    date: Date.now(),
  });

  if (document.getElementById("history-tab")?.style.display !== "none") {
    window._cordify_renderHistory && window._cordify_renderHistory();
  }
}
