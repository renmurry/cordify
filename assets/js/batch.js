/*
 * Cordify — Batch convert (Convert tab)
 * Reads every sheet (or one), finds the coordinate column(s), reads DD / DMS /
 * DDM values that are typed correctly, and writes DD, DMS, DDM and/or grid columns.
 * It never guesses: values that look mistyped are reported, with a pointer to
 * the Repair tool (Advanced mode).
 *
 * The converting runs in a background worker (batch-worker.js) so the page keeps
 * responding, shows progress and can be cancelled. Results are held as plain
 * number arrays, and the preview only ever draws the rows on screen, so the
 * number of rows is limited by the device, not by the page.
 *
 * KML, KMZ, GeoJSON and GPX files are read into a table of points first (geo-io.js)
 * and then treated like a spreadsheet. Results can also be saved as GeoJSON, KML,
 * GPX or GeoPackage for GIS software.
 *
 * Two ways in:
 *   - Excel files and CSV up to 5 MB are read whole (as before); the worker
 *     converts their coordinate cells.
 *   - Larger CSV files are never loaded whole: the worker reads them from disk a
 *     piece at a time, and writes the converted CSV the same way.
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const BC = () => window.CordifyBatchCore;
  const VISIBLE = 12;                  // rows drawn in the preview at any time
  const BIG_BYTES = 5 * 1024 * 1024;   // CSV above this is streamed
  const MAP_POINTS = 50000;            // most points drawn on the map at once
  const GEO_FILE = /\.(kml|kmz|geojson|json|gpx)$/i;
  // GeoPackage files are SQLite databases; sql.js (in assets/vendor) writes them. Loaded only
  // when asked for. A full address, because the worker resolves paths from its own folder.
  const SQL_JS = new URL("./assets/vendor/", document.baseURI).href;

  const state = { workbook: null, fileName: "", sheets: {}, results: null, big: null };
  let view = new Int32Array(0), busy = false;

  /* ---------- background worker ---------- */

  let worker = null, jobSeq = 0;
  const waiting = new Map();

  function getWorker() {
    if (worker || typeof Worker === "undefined") return worker;
    try {
      worker = new Worker("./assets/js/batch-worker.js?v=3");
    } catch (e) {
      return null;
    }
    worker.onmessage = e => {
      const m = e.data, w = waiting.get(m.job);
      if (!w) return;
      if (m.type === "progress") {
        if (w.onProgress) w.onProgress(m);
        return;
      }
      waiting.delete(m.job);
      if (m.type === "error") w.reject(new Error(m.message));
      else w.resolve(m);
    };
    worker.onerror = () => stopWorker(new Error("The background worker stopped unexpectedly."));
    return worker;
  }

  function ask(msg, onProgress) {
    return new Promise((resolve, reject) => {
      const w = getWorker();
      if (!w) return reject(new Error("no-worker"));
      const job = ++jobSeq;
      waiting.set(job, { resolve, reject, onProgress });
      w.postMessage({ ...msg, job });
    });
  }

  function stopWorker(err) {
    if (worker) worker.terminate();
    worker = null;
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  }

  // Coordinate cells -> numbers. In the worker when there is one, else here.
  async function convertColumns(mode, a, b, onProgress) {
    try {
      return await ask({ type: "columns", mode, a, b }, onProgress);
    } catch (e) {
      if (e.message !== "no-worker") throw e;
    }
    const B = BC(), n = a.length;
    const lat = new Float64Array(n), lon = new Float64Array(n), st = new Uint8Array(n), errors = [];
    const cfg = { mode, one: 0, lat: 0, lon: 1 };
    for (let i = 0; i < n; i++) {
      const res = B.readRow([ a[i], b ? b[i] : null ], cfg);
      st[i] = B.statusOf(res);
      lat[i] = res.lat !== undefined ? res.lat : NaN;
      lon[i] = res.lat !== undefined ? res.lon : NaN;
      if (res.lat === undefined && !res.empty) errors.push([ i, res.error ]);
    }
    return { lat, lon, status: st, errors };
  }

  /* ---------- progress ---------- */

  const count = n => Number(n).toLocaleString("en-US");
  function setBusy(on, text) {
    busy = on;
    $("batch-progress-wrap").hidden = !on;
    $("batch-run").disabled = on;
    $("batch-file").disabled = on;
    if (on) progress(0, text);
  }
  function progress(share, text) {
    $("batch-progress").value = Math.max(0, Math.min(1, share || 0));
    $("batch-progress-text").textContent = text || "";
  }

  /* ---------- file ---------- */

  function decodeText(buf) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch (err) {
      return new TextDecoder("windows-1252").decode(buf);
    }
  }
  const megabytes = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    reset();
    if (!file) return;
    try {
      const names = GEO_FILE.test(file.name) ? await openGeo(file) : /\.csv$/i.test(file.name) && file.size > BIG_BYTES && typeof Worker !== "undefined" && file.stream ? await openBigCsv(file) : await openWorkbook(file);
      if (!names) return;
      const sel = $("batch-sheet");
      const usable = names.filter(n => state.sheets[n].found);
      sel.innerHTML = (names.length > 1 ? `<option value="__all">All sheets (${usable.length} with coordinates)</option>` : "") +
        names.map(n => `<option value="${esc(n)}">${esc(n)} (${rowsText(state.sheets[n])})</option>`).join("");
      sel.value = names.length > 1 && usable.length > 1 ? "__all" : (usable[0] || names[0]);
      $("batch-sheet-wrap").hidden = names.length < 2;
      renderCols();
      [ "batch-mapping", "batch-out", "batch-actions", "batch-gis" ].forEach(id => { $(id).hidden = false; });
      if (state.big) {
        status(`Large file (${megabytes(file.size)}): it is read from disk a piece at a time, so the page stays responsive. Check the columns, then convert.` + (usable.length ? "" : " No coordinate column was found — choose one below."));
      } else {
        const total = names.reduce((a, n) => a + state.sheets[n].rows, 0);
        status(`Read ${count(total)} rows from ${names.length} sheet${names.length > 1 ? "s" : ""}` + (usable.length < names.length ? ` — no coordinate column found in ${names.length - usable.length} (choose one below, or untick it)` : ""));
      }
    } catch (err) {
      status("Could not read this file. Use Excel (.xlsx, .xls), CSV, KML, KMZ, GeoJSON or GPX.", "bad");
    }
  }

  // Excel, and CSV small enough to hold in memory.
  async function openWorkbook(file) {
    if (typeof XLSX === "undefined") {
      status("The spreadsheet library did not load. Check your internet connection and reload the page.", "bad");
      return null;
    }
    const buf = await file.arrayBuffer();
    const wb = /\.csv$/i.test(file.name) ? XLSX.read(decodeText(buf).replace(/^﻿/, ""), { type: "string" }) : XLSX.read(buf, { type: "array" });
    state.workbook = wb;
    state.fileName = file.name.replace(/\.[^.]+$/, "");
    for (const name of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true, blankrows: true });
      const h = aoa.findIndex(r => r.some(c => String(c).trim() !== ""));
      if (h < 0) continue;
      const head = aoa[h].map((c, j) => String(c).replace(/\s+/g, " ").trim() || `Column ${j + 1}`);
      const rows = aoa.slice(h + 1).filter(r => r.some(c => String(c).trim() !== "")).length;
      if (!rows) continue;
      state.sheets[name] = { aoa, head, h, rows, ...BC().detect(head, aoa.slice(h + 1, h + 60)) };
    }
    const names = Object.keys(state.sheets);
    if (!names.length) {
      status("No rows found in this file.", "bad");
      return null;
    }
    return names;
  }

  // KML, KMZ, GeoJSON, GPX: every point becomes a row with Name, Latitude, Longitude and
  // the file's own attributes. Lines and polygons come in as their corner points.
  async function openGeo(file) {
    const G = window.CordifyGeoIO;
    let t;
    if (/\.kmz$/i.test(file.name)) {
      if (typeof JSZip === "undefined") {
        status("The zip library did not load, so KMZ files can't be opened. Check your internet connection and reload, or use the KML inside it.", "bad");
        return null;
      }
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entry = Object.values(zip.files).find(f => /\.kml$/i.test(f.name));
      if (!entry) throw new Error("no kml");
      t = G.parseKml(await entry.async("string"));
    } else {
      const text = decodeText(await file.arrayBuffer()).replace(/^\uFEFF/, "");
      t = /\.kml$/i.test(file.name) ? G.parseKml(text) : /\.gpx$/i.test(file.name) ? G.parseGpx(text) : G.parseGeoJSON(text);
    }
    if (!t.rows.length) {
      status("No points found in this file.", "bad");
      return null;
    }
    const name = "Points";
    state.workbook = { SheetNames: [ name ], Sheets: {} };
    state.fileName = file.name.replace(/\.[^.]+$/, "");
    state.sheets[name] = { aoa: [ t.head ].concat(t.rows), head: t.head.slice(), h: 0, rows: t.rows.length, mode: "two", lat: 1, lon: 2, one: 1, found: true };
    return [ name ];
  }

  // A large CSV: only its first lines are read here, to find the columns.
  async function openBigCsv(file) {
    const B = BC();
    const text = decodeText(await file.slice(0, 262144).arrayBuffer()).replace(/^﻿/, "");
    const delim = B.sniffDelimiter(text);
    const records = B.splitCsvRecords(text);
    records.pop();   // the last one is probably cut off mid-line
    const lines = records.filter(l => l.trim());
    if (lines.length < 2) {
      status("No rows found in this file.", "bad");
      return null;
    }
    const head = B.parseCsvRecord(lines[0], delim).map((c, j) => c.replace(/\s+/g, " ").trim() || `Column ${j + 1}`);
    const sample = lines.slice(1, 61).map(l => B.parseCsvRecord(l, delim));
    state.big = { file, delim };
    state.fileName = file.name.replace(/\.[^.]+$/, "");
    state.sheets = { [file.name]: { big: true, bytes: file.size, head, rows: null, ...B.detect(head, sample) } };
    return [ file.name ];
  }

  const rowsText = s => s.big ? megabytes(s.bytes) : `${count(s.rows)} rows`;

  const selected = () => {
    const v = $("batch-sheet").value;
    return v === "__all" ? Object.keys(state.sheets).filter(n => state.sheets[n].use !== false) : [ v ];
  };

  function renderCols() {
    const v = $("batch-sheet").value;
    const names = v === "__all" ? Object.keys(state.sheets) : [ v ];
    const opts = (head, sel) => head.map((x, j) => `<option value="${j}"${j === sel ? " selected" : ""}>${esc(x)}</option>`).join("");
    $("batch-cols").innerHTML = names.map(n => {
      const s = state.sheets[n];
      if (s.use === undefined) s.use = s.found;
      return `<tr data-sheet="${esc(n)}"${s.found ? "" : ' class="batch-nocols"'}>
        <td><label class="inline">${v === "__all" ? `<input type="checkbox" data-k="use"${s.use ? " checked" : ""}>` : ""} ${esc(n)}</label></td>
        <td>${s.big ? megabytes(s.bytes) : count(s.rows)}</td>
        <td><select data-k="mode" aria-label="How the coordinates are stored"><option value="one"${s.mode === "one" ? " selected" : ""}>Lat + Lon in one column</option><option value="two"${s.mode === "two" ? " selected" : ""}>Separate Lat and Lon columns</option></select>
          <span class="col-one"${s.mode === "two" ? " hidden" : ""}><select data-k="one" aria-label="Coordinate column">${opts(s.head, s.one)}</select></span>
          <span class="col-two"${s.mode === "one" ? " hidden" : ""}><select data-k="lat" aria-label="Latitude column">${opts(s.head, s.lat)}</select> <select data-k="lon" aria-label="Longitude column">${opts(s.head, s.lon)}</select></span>
          ${s.found ? "" : `<span class="hint">no coordinate column found — choose one</span>`}</td>
      </tr>`;
    }).join("");
  }

  function onColsChange(e) {
    const tr = e.target.closest("tr[data-sheet]");
    if (!tr) return;
    const s = state.sheets[tr.dataset.sheet], k = e.target.dataset.k;
    if (k === "use") s.use = e.target.checked;
    else if (k === "mode") {
      s.mode = e.target.value;
      tr.querySelector(".col-one").hidden = s.mode === "two";
      tr.querySelector(".col-two").hidden = s.mode === "one";
    } else if (k) s[k] = +e.target.value;
    if (k && k !== "use") {
      s.found = true;
      tr.classList.remove("batch-nocols");
    }
    clearResults();
  }

  /* ---------- convert ---------- */

  const gridOn = () => !!(window.CordifyGrid && window.CordifyGrid.active());
  // The Easting/Northing tick box follows the system chosen at the top of the Convert tab.
  function syncGrid() {
    const on = gridOn();
    $("batch-fmt-grid").disabled = !on;
    $("batch-grid-label").textContent = on ? "in " + window.CordifyGrid.label() : "(choose a system at the top of this tab first)";
  }

  function formats() {
    const f = {
      dd: $("batch-fmt-dd").checked, dms: $("batch-fmt-dms").checked, ddm: $("batch-fmt-ddm").checked,
      ddDigits: +$("batch-prec-dd").value, secDigits: +$("batch-prec-dms").value, minDigits: +$("batch-prec-ddm").value
    };
    f.grid = $("batch-fmt-grid").checked && gridOn();
    if (!f.dd && !f.dms && !f.ddm && !f.grid) {
      f.dd = true;
      $("batch-fmt-dd").checked = true;
    }
    return f;
  }

  const outCols = (res, f) => BC().outCols(res, f, f.grid ? window.CordifyGrid.cells : null);

  // One row's result, rebuilt from the number arrays.
  function resOf(set, i) {
    const st = set.status[i];
    if (st === BC().EMPTY) return { empty: true };
    if (st === BC().OK) return { lat: set.lat[i], lon: set.lon[i] };
    return { error: set.errors ? set.errors.get(i) || "" : "" };
  }

  async function run() {
    if (busy || (!state.workbook && !state.big)) return;
    const f = formats();
    const names = selected();
    if (!names.length) {
      status("Tick at least one sheet.", "bad");
      return;
    }
    clearResults();
    setBusy(true, "Starting…");
    const B = BC();
    const out = { f, sets: {}, names, ok: 0, failed: 0, empty: 0, mistyped: 0 };
    try {
      for (const n of names) {
        const s = state.sheets[n];
        if (s.big) {
          const m = await ask({ type: "csv", file: state.big.file, delim: state.big.delim, cfg: { mode: s.mode, one: s.one, lat: s.lat, lon: s.lon } },
            p => progress(p.done / p.total, `${count(p.rows)} rows read`));
          out.sets[n] = { big: true, n: m.n, lat: m.lat, lon: m.lon, status: m.status, recNo: m.recNo };
          out.ok += m.counts.ok;
          out.failed += m.counts.failed;
          out.empty += m.counts.empty;
          out.mistyped += m.counts.mistyped;
          continue;
        }
        const idx = [], a = [], b = s.mode === "two" ? [] : null;
        for (let i = s.h + 1; i < s.aoa.length; i++) {
          const r = s.aoa[i];
          if (!r || !r.some(c => String(c).trim() !== "")) continue;
          idx.push(i);
          if (b) {
            a.push(r[s.lat] ?? "");
            b.push(r[s.lon] ?? "");
          } else a.push(r[s.one] ?? "");
        }
        const label = names.length > 1 ? `${n}: ` : "";
        const m = await convertColumns(s.mode, a, b, p => progress(p.done / p.total, `${label}${count(p.done)} of ${count(p.total)} rows`));
        out.sets[n] = { n: idx.length, lat: m.lat, lon: m.lon, status: m.status, rowIndex: Int32Array.from(idx), errors: new Map(m.errors) };
        for (let i = 0; i < m.status.length; i++) {
          const st = m.status[i];
          if (st === B.EMPTY) out.empty++;
          else if (st === B.OK) out.ok++;
          else {
            out.failed++;
            if (st === B.MISTYPED) out.mistyped++;
          }
        }
      }
    } catch (err) {
      setBusy(false);
      status(err.message === "cancelled" ? "Cancelled. Nothing was converted." : "Something went wrong while converting. Try again; if it keeps happening, try a smaller file.", err.message === "cancelled" ? "" : "bad");
      return;
    }
    setBusy(false);
    state.results = out;
    const total = out.ok + out.failed;
    const msg = `Converted ${count(out.ok)} of ${count(total)} row${total === 1 ? "" : "s"}` +
      (out.failed ? ` — ${count(out.failed)} couldn't be read${out.mistyped ? ` (${count(out.mistyped)} look mistyped)` : ""}` : "") +
      (out.empty ? `, ${count(out.empty)} empty` : "") + ".";
    status(msg, out.failed ? (out.ok ? "warn" : "bad") : "good", out.failed > 0);
    const any = out.ok + out.failed > 0;
    $("batch-download-xlsx").disabled = !any || !!state.big;
    $("batch-download-xlsx").setAttribute("data-tip", state.big ? "A file this large does not fit in an Excel workbook. Download CSV instead; Excel and QGIS both open it." : XLSX_TIP);
    $("batch-download-csv").disabled = !any;
    gisButtons(!out.ok);
    $("batch-map").disabled = !out.ok;
    $("batch-only-problems").checked = out.failed > 0 && out.ok === 0 ? false : $("batch-only-problems").checked;
    renderPreview();
  }

  /* ---------- preview: only the rows on screen are ever drawn ---------- */

  // Row ids run through all converted sheets in order; `view` lists the ones to show.
  function buildView() {
    const out = state.results, only = $("batch-only-problems").checked, B = BC();
    let base = 0, n = 0;
    const keep = st => only ? st >= B.FAILED : st !== B.EMPTY;
    for (const name of out.names) {
      const set = out.sets[name];
      set.base = base;
      for (let i = 0; i < set.n; i++) if (keep(set.status[i])) n++;
      base += set.n;
    }
    view = new Int32Array(n);
    let k = 0;
    for (const name of out.names) {
      const set = out.sets[name];
      for (let i = 0; i < set.n; i++) if (keep(set.status[i])) view[k++] = set.base + i;
    }
  }

  function locate(id) {
    const out = state.results;
    for (let k = out.names.length - 1; k >= 0; k--) {
      const set = out.sets[out.names[k]];
      if (id >= set.base) return { name: out.names[k], set, i: id - set.base };
    }
    return null;
  }

  // Table rows (as HTML) for a stretch of the view.
  async function fetchRows(start, n) {
    const out = state.results, multi = out.names.length > 1;
    const items = Array.from(view.subarray(start, start + n), locate);
    const bigIds = items.filter(x => x.set.big).map(x => x.i);
    const fromFile = new Map();
    if (bigIds.length) {
      const m = await ask({ type: "window", ids: bigIds });
      m.rows.forEach(r => fromFile.set(r.i, r));
    }
    return items.map(({ name, set, i }) => {
      let res = resOf(set, i), raw, rowNo;
      if (set.big) {
        const r = fromFile.get(i) || { raw: "", error: "" };
        raw = r.raw;
        rowNo = set.recNo[i];
        if (res.error !== undefined) res = { error: r.error };
      } else {
        const s = state.sheets[name];
        raw = BC().rawOf(s.aoa[set.rowIndex[i]], s);
        rowNo = set.rowIndex[i] + 1;
      }
      const cols = outCols(res, out.f);
      const ok = res.lat !== undefined;
      return `<tr class="${ok ? "" : "batch-fail"}"><td class="hint">${multi ? esc(name) + " · " : ""}${rowNo}</td><td><pre class="raw">${esc(raw)}</pre></td>` +
        cols.slice(0, -1).map(c => `<td class="num">${esc(c[1])}</td>`).join("") +
        `<td>${ok ? '<span class="badge st-ok">OK</span>' : `<span class="badge st-bad">Not converted</span><br><span class="hint">${esc(res.error)}</span>`}</td></tr>`;
    });
  }

  let spacer = 0, drawToken = 0, frame = 0;

  function renderPreview() {
    const out = state.results;
    if (!out) return;
    out.f = formats();
    buildView();
    const multi = out.names.length > 1;
    const names = outCols({ empty: true }, out.f).map(c => c[0]).filter(n => n !== "Convert_Status");
    $("batch-head").innerHTML = `<th>${multi ? "Sheet · row" : "Row"}</th><th>Original</th>` + names.map(n => `<th>${esc(n.replace("_", " "))}</th>`).join("") + "<th>Result</th>";
    const small = view.length <= VISIBLE;
    // Browsers cap how tall an element can be, so a very long list scrolls proportionally.
    spacer = small ? 0 : Math.min(view.length * 36, 6e6);
    $("batch-vt").classList.toggle("vt-small", small);
    $("batch-vt-spacer").style.height = spacer + "px";
    $("batch-vt").scrollTop = 0;
    $("batch-preview-wrap").hidden = false;
    draw();
  }

  async function draw() {
    const out = state.results;
    if (!out) return;
    const total = view.length, only = $("batch-only-problems").checked;
    const cols = outCols({ empty: true }, out.f).length + 2;
    if (!total) {
      $("batch-body").innerHTML = `<tr><td colspan="${cols}" class="empty">No rows in this view.</td></tr>`;
      $("batch-preview-label").textContent = "";
      return;
    }
    const shown = Math.min(VISIBLE, total);
    let first = spacer ? Math.round($("batch-vt").scrollTop / spacer * (total - shown)) : 0;
    first = Math.max(0, Math.min(total - shown, first));
    const token = ++drawToken;
    let rows;
    try {
      rows = await fetchRows(first, shown);
    } catch (e) {
      return;
    }
    if (token !== drawToken) return;   // the user has scrolled on since
    $("batch-body").innerHTML = rows.join("");
    $("batch-vt-view").classList.toggle("vt-end", total > shown && first + shown >= total);
    $("batch-preview-label").textContent = (total > shown ? `Rows ${count(first + 1)}–${count(first + shown)} of ${count(total)}` : `${count(total)} row${total === 1 ? "" : "s"}`) +
      (only ? " that couldn't be read" : "") + (total > shown ? " — scroll the table for more" : "");
  }

  /* ---------- download ---------- */

  const XLSX_TIP = "The same workbook with the new columns added to each converted sheet. Other sheets are kept as they are.";
  const noCR = v => typeof v === "string" ? v.replace(/\r\n?/g, "\n") : v;
  function cleanSheet(ws) {
    const copy = {};
    for (const k of Object.keys(ws)) {
      const c = ws[k];
      copy[k] = k[0] === "!" || !c || typeof c !== "object" ? c : { ...c, v: noCR(c.v), w: noCR(c.w), h: undefined, r: undefined };
    }
    return copy;
  }

  // The sheet's rows with the new columns added after the last used column.
  function convertedAoa(name) {
    const s = state.sheets[name], out = state.results, set = out.sets[name];
    const aoa = s.aoa.map(r => r.map(noCR));
    let col = 0;
    for (const r of aoa) if (r.length > col) col = r.length;
    outCols({ empty: true }, out.f).forEach((c, j) => { aoa[s.h][col + j] = c[0]; });
    for (let i = 0; i < set.n; i++) {
      const row = aoa[set.rowIndex[i]], cols = outCols(resOf(set, i), out.f);
      for (let j = 0; j < cols.length; j++) row[col + j] = cols[j][1];
    }
    return aoa;
  }

  function downloadXlsx() {
    if (!state.results || state.big) return;
    state.results.f = formats();
    const wb = XLSX.utils.book_new();
    for (const name of state.workbook.SheetNames) {
      const ws = state.results.sets[name] ? XLSX.utils.aoa_to_sheet(convertedAoa(name)) : cleanSheet(state.workbook.Sheets[name]);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    XLSX.writeFile(wb, `${state.fileName || "cordify"}_converted.xlsx`);
  }

  // CSV with a byte-order mark so Excel shows ° and other symbols correctly.
  const toCsv = aoa => "﻿" + XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(aoa));

  async function downloadCsv() {
    if (!state.results || busy) return;
    state.results.f = formats();
    if (state.big) {
      setBusy(true, "Writing the CSV…");
      try {
        const m = await ask({ type: "export", f: state.results.f, gridSpec: gridOn() ? window.CordifyGrid.spec() : "off" },
          p => progress(p.done / p.total, `${count(p.rows)} rows written`));
        setBusy(false);
        if (m.blob) download(`${state.fileName || "cordify"}_converted.csv`, m.blob);
      } catch (err) {
        setBusy(false);
        if (err.message === "cancelled") {
          clearResults();
          status("Cancelled. Convert again to download.");
        } else status("The CSV could not be written. Try again.", "bad");
      }
      return;
    }
    const names = state.results.names;
    if (names.length === 1) {
      download(`${state.fileName || "cordify"}_converted.csv`, new Blob([ toCsv(convertedAoa(names[0])) ], { type: "text/csv;charset=utf-8" }));
      return;
    }
    if (typeof JSZip === "undefined") {
      status("The zip library did not load, so several CSV files can't be bundled. Download XLSX instead, or pick one sheet.", "bad");
      return;
    }
    const zip = new JSZip();
    const safe = n => n.replace(/[\\/:*?"<>|]+/g, "_");
    names.forEach(n => zip.file(`${safe(n)}.csv`, toCsv(convertedAoa(n))));
    download(`${state.fileName || "cordify"}_converted_csv.zip`, await zip.generateAsync({ type: "blob", compression: "DEFLATE" }));
  }

  /* ---------- download for GIS software ---------- */

  const gisButtons = off => document.querySelectorAll("#batch-gis button").forEach(b => { b.disabled = off; });

  let sqlPromise = null;
  function loadSql() {
    if (sqlPromise) return sqlPromise;
    sqlPromise = new Promise((resolve, reject) => {
      const start = () => window.initSqlJs({ locateFile: f => SQL_JS + f }).then(resolve, reject);
      if (window.initSqlJs) return start();
      const s = document.createElement("script");
      s.src = SQL_JS + "sql-wasm.js";
      s.onload = start;
      s.onerror = () => reject(new Error("library"));
      document.head.appendChild(s);
    });
    sqlPromise.catch(() => { sqlPromise = null; });
    return sqlPromise;
  }
  const GPKG_FAILED = "The GeoPackage could not be written. Very large files may not fit in this device's memory. GeoJSON does not have that limit, and QGIS opens it too.";

  // Only rows that converted become points; each keeps its original columns and the new ones.
  async function downloadGeo(format) {
    const out = state.results;
    if (!out || busy) return;
    out.f = formats();
    const base = `${state.fileName || "cordify"}_converted`;
    if (state.big) {
      setBusy(true, "Writing the file…");
      try {
        const m = await ask({ type: "exportGeo", format, f: out.f, title: state.fileName, sqlJs: SQL_JS, gridSpec: gridOn() ? window.CordifyGrid.spec() : "off" },
          p => progress(p.done / p.total, `${count(p.rows)} points written`));
        setBusy(false);
        if (m.blob) download(`${base}.${m.ext}`, m.blob);
      } catch (err) {
        setBusy(false);
        if (err.message === "cancelled") {
          clearResults();
          status("Cancelled. Convert again to download.");
        } else status(format === "gpkg" ? GPKG_FAILED : "The file could not be written. Try again.", "bad");
      }
      return;
    }
    const G = window.CordifyGeoIO, OK = BC().OK, multi = out.names.length > 1;
    const added = outCols({ empty: true }, out.f).slice(0, -1).map(c => c[0]);
    // fn(sheet, set, original row, its number, the new cells) for every converted row
    const eachPoint = (name, fn) => {
      const s = state.sheets[name], set = out.sets[name];
      for (let i = 0; i < set.n; i++) {
        if (set.status[i] !== OK) continue;
        const res = { lat: set.lat[i], lon: set.lon[i] };
        fn(s, s.aoa[set.rowIndex[i]], set.rowIndex[i] + 1, res, outCols(res, out.f).slice(0, -1));
      }
    };
    try {
      if (format === "gpkg") {
        setBusy(true, "Preparing GeoPackage…");
        const pkg = G.gpkg(await loadSql());
        for (const name of out.names) {
          const s = state.sheets[name];
          const tb = pkg.table(multi ? name : state.fileName || name, s.head.map(h => ({ name: h, type: "TEXT" })).concat(added.map(n => ({ name: n, type: G.NUMERIC.test(n) ? "DOUBLE" : "TEXT" }))));
          eachPoint(name, (_, row, no, res, cols) => tb.point(res.lat, res.lon, s.head.map((h, j) => row[j]).concat(cols.map(c => c[1]))));
        }
        const bytes = pkg.finish();
        setBusy(false);
        download(`${base}.gpkg`, new Blob([ bytes ], { type: "application/geopackage+sqlite3" }));
        return;
      }
      const w = G.textWriter(format, state.fileName || "Cordify");
      const parts = [ w.head ];
      for (const name of out.names) {
        const nameCol = state.sheets[name].head.findIndex(h => G.NAME_KEY.test(h));
        eachPoint(name, (s, row, no, res, cols) => {
          const props = s.head.map((h, j) => [ h, row[j] ]).concat(multi ? [ [ "Sheet", name ] ] : [], cols);
          parts.push(w.point(nameCol >= 0 && String(row[nameCol] ?? "").trim() ? String(row[nameCol]) : `Row ${no}`, res.lat, res.lon, props));
        });
      }
      parts.push(w.tail);
      download(`${base}.${w.ext}`, new Blob(parts, { type: w.mime }));
    } catch (err) {
      setBusy(false);
      status(format === "gpkg" ? GPKG_FAILED : "The file could not be written. Try again.", "bad");
    }
  }

  /* ---------- map ---------- */

  // Converted points on the map. Very large sets are thinned evenly so the map stays usable.
  function showOnMap() {
    const out = state.results;
    if (!out || !window.CordifyMap) return;
    const step = Math.max(1, Math.ceil(out.ok / MAP_POINTS));
    const lat = [], lon = [], label = [];
    let seen = 0;
    for (const name of out.names) {
      const set = out.sets[name];
      for (let i = 0; i < set.n; i++) {
        if (set.status[i] !== BC().OK || seen++ % step) continue;
        lat.push(set.lat[i]);
        lon.push(set.lon[i]);
        label.push(`${out.names.length > 1 ? name + " · " : ""}row ${set.big ? set.recNo[i] : set.rowIndex[i] + 1}`);
      }
    }
    window.CordifyMap.plotPoints(lat, lon, label, step > 1 ? `Showing ${count(lat.length)} of ${count(out.ok)} points (every ${step}${step === 2 ? "nd" : step === 3 ? "rd" : "th"} one)` : `Plotted ${count(lat.length)} points`);
  }

  /* ---------- helpers ---------- */

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 300);
  }

  function status(text, kind, offerRepair) {
    const el = $("batch-status");
    el.className = "hint batch-status" + (kind ? " " + kind : "");
    el.textContent = text;
    if (offerRepair && $("advanced-mode")) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-quiet batch-repair";
      b.textContent = "Fix them with Repair (Advanced)";
      b.setAttribute("data-tip", "Opens the Repair tab, which can rebuild badly typed coordinates using a boundary. Load the same file there.");
      b.addEventListener("click", openRepair);
      el.append(" ", b);
    }
  }

  function openRepair() {
    const box = $("advanced-mode");
    if (box && !box.checked) {
      box.checked = true;
      box.dispatchEvent(new Event("change"));
    }
    $("tab-repair")?.click();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function clearResults() {
    state.results = null;
    view = new Int32Array(0);
    drawToken++;
    $("batch-preview-wrap").hidden = true;
    $("batch-download-xlsx").disabled = true;
    $("batch-download-csv").disabled = true;
    gisButtons(true);
    $("batch-map").disabled = true;
  }

  function reset() {
    if (busy) stopWorker(new Error("cancelled"));
    state.workbook = null;
    state.big = null;
    state.sheets = {};
    clearResults();
    [ "batch-sheet-wrap", "batch-mapping", "batch-out", "batch-actions", "batch-gis" ].forEach(id => { $(id).hidden = true; });
    status("");
  }

  function init() {
    if (!$("batch-file")) return;
    $("batch-file").addEventListener("change", onFile);
    $("batch-sheet").addEventListener("change", () => {
      renderCols();
      clearResults();
    });
    $("batch-cols").addEventListener("change", onColsChange);
    $("batch-run").addEventListener("click", run);
    $("batch-cancel").addEventListener("click", () => stopWorker(new Error("cancelled")));
    $("batch-download-xlsx").addEventListener("click", downloadXlsx);
    $("batch-download-csv").addEventListener("click", downloadCsv);
    $("batch-map").addEventListener("click", showOnMap);
    $("batch-gis").addEventListener("click", e => {
      const b = e.target.closest("button[data-fmt]");
      if (b && !b.disabled) downloadGeo(b.dataset.fmt);
    });
    $("batch-only-problems").addEventListener("change", renderPreview);
    $("batch-vt").addEventListener("scroll", () => {
      if (!frame) {
        // A short timer, not requestAnimationFrame, which stops while the tab is in the background.
        frame = setTimeout(() => {
          frame = 0;
          draw();
        }, 30);
      }
    });
    syncGrid();
    // Formats only change how the numbers are written, so nothing is converted again.
    window.addEventListener("cordify:grid-change", () => {
      syncGrid();
      renderPreview();
    });
    [ "batch-fmt-grid", "batch-fmt-dd", "batch-fmt-dms", "batch-fmt-ddm", "batch-prec-dd", "batch-prec-dms", "batch-prec-ddm" ].forEach(id => $(id).addEventListener("change", renderPreview));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // For the sheet (sheet.js) and tests
  const B = BC();
  window.CordifyBatch = { readPair: B.readPair, readOne: B.readOne, readRow: B.readRow, detect: B.detect, loadSql };
})();
