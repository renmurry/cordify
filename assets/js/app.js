// scripts for cordify
console.log("app.js loaded");

/* --------------------------------------------------------------------------
   Cordify: tabs + history-only view + robust storage + batch I/O
--------------------------------------------------------------------------- */
(function () {
  const MAX_HISTORY = 1000;
  const LS_KEY = "cordify_history_v1";

  // ---------- storage ----------
  function getHistory() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function setHistory(arr) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(0, MAX_HISTORY))); } catch {}
  }
  function addHistory(rec) {
    const arr = getHistory();
    arr.unshift({
      type: rec.type || "",
      input: String(rec.input ?? ""),
      result: String(rec.result ?? ""),
      date: rec.date || Date.now(),
    });
    setHistory(arr);
  }
  function clearHistory() { try { localStorage.removeItem(LS_KEY); } catch {} }

  // expose for converters
  window._cordify_addHistory = addHistory;
  window._cordify_renderHistory = renderHistoryTable;

  // ---------- tabs + ui ----------
  document.addEventListener("DOMContentLoaded", () => {
    const convertTab = document.getElementById("convert-tab");
    const historyTab = document.getElementById("history-tab");
    const btnConvert = document.getElementById("tab-convert");
    const btnHistory = document.getElementById("tab-history");

    function setActive(btnOn, btnOff) {
      btnOn?.classList.add("is-active");
      btnOff?.classList.remove("is-active");
    }
    function enterHistoryOnly() {
      if (convertTab) convertTab.style.display = "none";
      if (historyTab) historyTab.style.display = "";
      setActive(btnHistory, btnConvert);
      renderHistoryTable();
    }
    function enterConversion() {
      if (convertTab) convertTab.style.display = "";
      if (historyTab) historyTab.style.display = "none";
      setActive(btnConvert, btnHistory);
    }
    btnConvert && (btnConvert.onclick = enterConversion);
    btnHistory && (btnHistory.onclick = enterHistoryOnly);
    enterConversion();

    // single conversions
    document.getElementById("btn-dms2dd")?.addEventListener("click", convertDmsToDd);
    document.getElementById("btn-dd2dms")?.addEventListener("click", convertDdToDms);
    document.getElementById("btn-clear-dms")?.addEventListener("click", clearDmsInputs);
    document.getElementById("btn-clear-dd")?.addEventListener("click", clearDdInputs);
    document.getElementById("btn-swap")?.addEventListener("click", swapDd);

    // copy buttons
    document.getElementById("copy-dd")?.addEventListener("click", () => copyText(document.getElementById("dd_result")?.value || ""));
    document.getElementById("copy-dms")?.addEventListener("click", () => copyText(document.getElementById("dms_result")?.value || ""));

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
  });

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
      `;
      tbody.appendChild(tr);
    });
  }

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
    const arr = (function(){ try{ return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }catch{ return []; }})();
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
    document.getElementById("batch-status").textContent = `Loaded ${json.length} rows from “${sheetName}”`;
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
    const ws = XLSX.utils.json_to_sheet(_batch.outRows, { header: _batch.outHeaders });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Converted");
    XLSX.writeFile(wb, "cordify_converted.xlsx");
  } else {
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
/* ====================== END BATCH ====================== */
