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
      worker = new Worker("./assets/js/batch-worker.js?v=16");
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
  async function convertColumns(mode, a, b, onProgress, how = {}) {
    const system = how.system || null, datum = how.datum || null;
    try {
      return await ask({ type: "columns", mode, a, b, system, datum }, onProgress);
    } catch (e) {
      if (e.message !== "no-worker") throw e;
    }
    const B = BC(), n = a.length;
    const lat = new Float64Array(n), lon = new Float64Array(n), st = new Uint8Array(n), precision = new Float32Array(n), errors = [];
    const cfg = { mode, one: 0, lat: 0, lon: 1, system, datum };
    for (let i = 0; i < n; i++) {
      const res = B.readRow([ a[i], b ? b[i] : null ], cfg);
      st[i] = B.statusOf(res);
      lat[i] = res.lat !== undefined ? res.lat : NaN;
      lon[i] = res.lat !== undefined ? res.lon : NaN;
      precision[i] = res.lat !== undefined ? res.precision : NaN;
      if (res.lat === undefined && !res.empty) errors.push([ i, res.error ]);
    }
    return { lat, lon, status: st, precision, errors };
  }

  /* ---------- progress ---------- */

  const count = n => Number(n).toLocaleString("en-US");
  function setBusy(on, text) {
    busy = on;
    $("batch-progress-wrap").hidden = !on;
    $("batch-run").disabled = on;
    if ($("batch-scan")) $("batch-scan").disabled = on;
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

  // "Kiphire is typed to about 100 m throughout." — one note per sheet instead of a mark on every row.
  const coarseText = list => list.map(([ n, m ]) => `${list.length > 1 || state.results?.names?.length > 1 || Object.keys(state.sheets).length > 1 ? `“${n}” is` : "Values are"} typed to only about ${BC().nice(m)} throughout.`).join(" ");

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

  // One row's result, rebuilt from the number arrays (and the repair of a row that did not convert).
  function resOf(set, i) {
    const st = set.status[i];
    if (st === BC().EMPTY) return { empty: true };
    if (st === BC().OK) return { lat: set.lat[i], lon: set.lon[i], check: set.checks ? set.checks.get(i) : undefined };
    const fixed = set.repaired && set.repaired.get(i);
    if (fixed) return { ...fixed };
    const note = set.repairNotes && set.repairNotes.get(i);
    return { error: (set.errors ? set.errors.get(i) || "" : "") + (note ? `; Repair: ${note}` : "") };
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
    const out = { f, sets: {}, names, ok: 0, failed: 0, empty: 0, mistyped: 0, check: 0, coarse: [] };
    const datum = datumOf();
    try {
      for (const n of names) {
        const s = state.sheets[n];
        if (s.big) {
          const m = await ask({ type: "csv", file: state.big.file, delim: state.big.delim, cfg: { mode: s.mode, one: s.one, lat: s.lat, lon: s.lon, system: s.system || null, datum } },
            p => progress(p.done / p.total, `${count(p.rows)} rows read`));
          out.sets[n] = { big: true, n: m.n, lat: m.lat, lon: m.lon, status: m.status, recNo: m.recNo, checks: new Map(m.checks) };
          out.check += m.counts.check;
          if (m.counts.coarse) out.coarse.push([ n, m.counts.coarse ]);
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
        const m = await convertColumns(s.mode, a, b, p => progress(p.done / p.total, `${label}${count(p.done)} of ${count(p.total)} rows`), { system: s.system, datum });
        // Converted rows worth a second look: far from the rest, duplicated, or typed too roughly.
        const checks = B.qualityChecks(m.lat, m.lon, m.status, m.precision, idx.map(i => i + 1));
        out.check += checks.size;
        if (checks.coarse) out.coarse.push([ n, checks.coarse ]);
        out.sets[n] = { n: idx.length, lat: m.lat, lon: m.lon, status: m.status, rowIndex: Int32Array.from(idx), errors: new Map(m.errors), checks };
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
    // Optional: rows with two possible readings, read the way the rest of the sheet was typed.
    let habits = null;
    if (out.failed && $("batch-habits").checked && window.CordifyHabits) {
      try {
        progress(1, "Reading the typing habits…");
        habits = await applyHabits(out);
      } catch (err) {
        habits = null;
      }
    }
    showHabits(habits);
    // Another coordinate system (UTM, MGRS, radians, swapped…): found per sheet, always asked first.
    let systems = [];
    try {
      progress(1, "Checking the coordinate system…");
      systems = await findSystems(out);
    } catch (err) {
      systems = [];
    }
    setBusy(false);
    state.results = out;
    showSystems(systems);
    const total = out.ok + out.failed;
    const settled = habits ? habits.n : 0;
    const msg = `Converted ${count(out.ok)} of ${count(total)} row${total === 1 ? "" : "s"}` +
      (out.failed ? ` — ${count(out.failed)} couldn't be read${out.mistyped ? ` (${count(out.mistyped)} look mistyped)` : ""}` : "") +
      (out.empty ? `, ${count(out.empty)} empty` : "") + "." +
      (settled ? ` Typing habits settled ${count(settled)} of them that had two possible readings (orange, worth checking).` : "") +
      (out.check ? ` ${count(out.check)} converted row${out.check === 1 ? " is" : "s are"} worth checking (far from the rest, a duplicate, or typed roughly).` : "") +
      (out.coarse.length ? ` ${coarseText(out.coarse)}` : "");
    out.repaired = settled ? { fixed: 0, check: settled, left: out.failed - settled, habit: settled } : undefined;
    status(msg, out.failed || out.check ? (out.ok ? "warn" : "bad") : "good", out.failed > 0 ? "both" : null);
    const any = out.ok + out.failed > 0;
    $("batch-download-xlsx").disabled = !any || !!state.big;
    $("batch-download-xlsx").setAttribute("data-tip", state.big ? "A file this large does not fit in an Excel workbook. Download CSV instead; Excel and QGIS both open it." : XLSX_TIP);
    $("batch-download-csv").disabled = !any;
    gisButtons(!out.ok);
    $("batch-map").disabled = !out.ok;
    $("batch-view").querySelector('[value="check"]').textContent = `Converted, worth checking (${count(out.check)})`;
    $("batch-view").querySelector('[value="failed"]').textContent = `Not converted (${count(out.failed - settled)})`;
    $("batch-view").querySelector('[value="repaired"]').hidden = !settled;
    $("batch-view").querySelector('[value="repaired"]').textContent = `Repaired (${count(settled)})`;
    if (settled) gisButtons(false);
    renderPreview();
  }

  /* ---------- scan first: a short report before converting ---------- */

  const SCAN_ROWS = 20000;              // most rows of a sheet read for the report
  const SCAN_BYTES = 4 * 1024 * 1024;   // of a large CSV, only this much is read for it

  // Every row of each ticked sheet, or an even sample of a long one; a large CSV from its start.
  async function scanSheets(names) {
    const B = BC(), out = [];
    for (const n of names) {
      const s = state.sheets[n];
      const base = { name: n, head: s.head, mode: s.mode, one: s.one, lat: s.lat, lon: s.lon, found: s.found, system: s.system || null };
      if (s.big) {
        const text = decodeText(await state.big.file.slice(0, SCAN_BYTES).arrayBuffer()).replace(/^\uFEFF/, "");
        const records = B.splitCsvRecords(text);
        if (state.big.file.size > SCAN_BYTES) records.pop();   // probably cut off mid-line
        const lines = records.filter(l => l.trim()).slice(1).map(l => B.parseCsvRecord(l, state.big.delim));
        out.push({ ...base, rows: lines, sample: state.big.file.size > SCAN_BYTES });
        continue;
      }
      const rows = [];
      for (let i = s.h + 1; i < s.aoa.length; i++) {
        const r = s.aoa[i];
        if (r && r.some(c => String(c).trim() !== "")) rows.push(r);
      }
      const step = Math.max(1, Math.ceil(rows.length / SCAN_ROWS));
      out.push({ ...base, rows: step > 1 ? rows.filter((_, k) => k % step === 0) : rows, total: rows.length });
    }
    return out;
  }

  async function scanFirst() {
    const Rep = window.CordifyReport;
    if (busy || !Rep || (!state.workbook && !state.big)) return;
    const names = selected();
    if (!names.length) {
      status("Tick at least one sheet.", "bad");
      return;
    }
    setBusy(true, "Scanning…");
    progress(0.5, "Reading the rows…");
    try {
      const sheets = await scanSheets(names);
      const ref = await refArea();
      const result = Rep.scan(sheets, { ref, datum: datumOf(), habitsOn: $("batch-habits").checked });
      Rep.render($("batch-report"), result, { onAct: onReportAction });
    } catch (err) {
      status("Something went wrong while scanning. Try again; if it keeps happening, try a smaller file.", "bad");
    }
    setBusy(false);
  }

  function onReportAction(act) {
    if (act.type === "system") {
      const s = state.sheets[act.sheet];
      if (s) {
        s.system = act.system;
        clearResults();
      }
      scanFirst();
    } else if (act.type === "habits") {
      $("batch-habits").checked = true;
      $("batch-habits").dispatchEvent(new Event("change"));
      scanFirst();
    } else if (act.type === "repair") openRepair();
  }

  /* ---------- other coordinate systems ---------- */

  const DATUM_KEY = "cordify_datum_v1";
  const SYS_SAMPLE = 400;   // rows per sheet looked at to find the system
  const datumOf = () => ($("batch-datum") && $("batch-datum").value) || "wgs84";

  // Where the points must be: the boundary and village locations saved in Repair, if any.
  async function refArea() {
    const Ref = window.CordifyReference, R = window.CordifyRepair;
    if (!Ref || !R) return null;
    try {
      const b = await Ref.loadBoundary(), p = await Ref.loadPlaces();
      const features = b && Array.isArray(b.src) && b.src.length ? b.src.map((f, j) => R.buildFeature({ rings: f.rings, props: f.props }, j)) : null;
      const list = p && Array.isArray(p.list) ? p.list.filter(q => Number.isFinite(q.lat) && Number.isFinite(q.lon)) : [];
      if (!features && !list.length) return null;
      const ref = {};
      if (features) ref.inside = (lat, lon) => !!R.featureAt(features, lon, lat);
      if (list.length) {
        // About 20 km cells; a point is near when a village is in its cell or the next ones.
        const key = (a, b) => `${Math.floor(a * 5)}|${Math.floor(b * 5)}`, cells = new Set(list.map(q => key(q.lat, q.lon)));
        ref.near = (lat, lon) => {
          for (const da of [ -0.2, 0, 0.2 ]) for (const db of [ -0.2, 0, 0.2 ]) if (cells.has(key(lat + da, lon + db))) return true;
          return false;
        };
      }
      return ref;
    } catch (e) {
      return null;
    }
  }

  // Per sheet: the system already chosen, or a suggestion from a sample of its rows.
  async function findSystems(out) {
    const S = window.CordifySystems, B = BC();
    if (!S) return [];
    let ref;
    const list = [];
    for (const name of out.names) {
      const set = out.sets[name], s = state.sheets[name];
      if (s.system) {
        list.push({ name, using: s.system });
        continue;
      }
      if (s.systemNo || !set.n) continue;
      const step = Math.max(1, Math.ceil(set.n / SYS_SAMPLE)), ids = [];
      for (let i = 0; i < set.n; i += step) if (set.status[i] !== B.EMPTY) ids.push(i);
      if (!ids.length) continue;
      // A sheet whose rows nearly all read as degrees needs no question.
      const okShare = ids.filter(i => set.status[i] === B.OK).length / ids.length;
      if (okShare > 0.9 && !ids.some(i => set.status[i] === B.OK && Math.abs(set.lat[i]) < 1.6 && Math.abs(set.lon[i]) < 3.2)) continue;
      let cellsOf;
      if (set.big) {
        const m = await ask({ type: "window", ids });
        const cells = new Map(m.rows.map(r => [ r.i, r.cells ]));
        cellsOf = i => cells.get(i) || [];
      } else {
        cellsOf = i => {
          const r = s.aoa[set.rowIndex[i]];
          return s.mode === "one" ? [ r[s.one] ] : [ r[s.lat], r[s.lon] ];
        };
      }
      const rows = ids.map(i => ({ cells: cellsOf(i).map(c => c ?? "") }));
      const swapped = set.errors ? ids.filter(i => /swap/i.test(set.errors.get(i) || "")).length / ids.length : 0;
      const head = (s.mode === "one" ? [ s.head[s.one] ] : [ s.head[s.lat], s.head[s.lon] ]).map(h => String(h ?? ""));
      if (ref === undefined) ref = await refArea();
      const d = S.detect(rows, ref, { swapped, head });
      if (d) list.push({ name, d });
    }
    return list;
  }

  // The systems a person can pick: zone in each cell, Web Mercator, UTM 1N…60S, radians, swapped.
  function systemOptions(chosen) {
    const S = window.CordifySystems, sel = chosen ? S.keyOf(chosen) : "";
    return `<option value="">Choose…</option>` + S.choices().map(sys => `<option value="${S.keyOf(sys)}"${S.keyOf(sys) === sel ? " selected" : ""}>${esc(S.labelOf(sys))}</option>`).join("");
  }
  const systemFromKey = k => window.CordifySystems.fromKey(k);

  function showSystems(list) {
    const box = $("batch-systems"), S = window.CordifySystems;
    state.systemList = list;
    if (!box) return;
    if (!list.length || !S) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    const many = state.results && state.results.names.length > 1;
    box.innerHTML = list.map(x => {
      const lab = many ? `“${esc(x.name)}”: ` : "";
      if (x.using) {
        return `<div class="sys-row" data-sheet="${esc(x.name)}"><span>${lab}read as <strong>${esc(S.labelOf(x.using))}</strong>.</span>` +
          `<button type="button" data-act="undo">Undo</button></div>`;
      }
      const d = x.d;
      const q = d.system ? `${lab}these look like <strong>${esc(d.label)}</strong> (${esc(d.why)}). Read them this way?`
        : `${lab}these look like <strong>${esc(d.label)}</strong>: ${esc(d.why)}.`;
      return `<div class="sys-row" data-sheet="${esc(x.name)}"><span>${q}</span>` +
        (d.system ? `<button type="button" class="btn-primary" data-act="yes">Yes</button>` : "") +
        `<label>${d.system ? "Pick another" : "System"} <select data-act="pick">${systemOptions(null)}</select></label>` +
        `<button type="button" class="btn-quiet" data-act="no">No, leave as is</button></div>`;
    }).join("");
    box.hidden = false;
  }

  function onSystemAction(e) {
    const row = e.target.closest(".sys-row"), act = e.target.dataset.act;
    if (!row || !act || busy) return;
    if ((act === "pick") !== (e.type === "change")) return;
    const name = row.dataset.sheet, s = state.sheets[name], x = (state.systemList || []).find(y => y.name === name);
    if (!s) return;
    if (act === "yes" && x && x.d && x.d.system) s.system = x.d.system;
    else if (act === "pick") {
      const sys = systemFromKey(e.target.value);
      if (!sys) return;
      s.system = sys;
    } else if (act === "no") {
      s.systemNo = true;
      showSystems((state.systemList || []).filter(y => y.name !== name));
      return;
    } else if (act === "undo") {
      s.system = null;   // back to as typed; the question shows again
    } else return;
    run();
  }

  /* ---------- typing habits (optional) ---------- */

  const HABITS_KEY = "cordify_habits_v1";
  const HABIT_SAMPLE = 5000;   // rows of a large file read back to learn from

  // Rows that could not be read but have two possible readings: the reading that matches
  // the other value in the cell, or a habit of the sheet. Marked as best guesses to check.
  async function applyHabits(out) {
    const H = window.CordifyHabits, R = window.CordifyRepair, B = BC();
    const found = [];
    let n = 0;
    for (const name of out.names) {
      const set = out.sets[name], s = state.sheets[name];
      const ok = [], failed = [];
      for (let i = 0; i < set.n; i++) {
        if (set.status[i] === B.OK) ok.push(i);
        else if (set.status[i] >= B.FAILED) failed.push(i);
      }
      if (!failed.length) continue;
      const step = Math.max(1, Math.ceil(ok.length / HABIT_SAMPLE));
      const learnIds = set.big ? ok.filter((_, k) => k % step === 0) : ok;
      let cellsOf;
      if (set.big) {
        const m = await ask({ type: "window", ids: learnIds.concat(failed).sort((a, b) => a - b) });
        const cells = new Map(m.rows.map(r => [ r.i, r.cells ]));
        cellsOf = i => cells.get(i) || [];
      } else {
        cellsOf = i => {
          const r = s.aoa[set.rowIndex[i]];
          return s.mode === "one" ? [ r[s.one] ] : [ r[s.lat], r[s.lon] ];
        };
      }
      const rowOf = i => {
        const c = cellsOf(i);
        return s.mode === "one" ? { text: String(c[0] ?? "") } : { lat: String(c[0] ?? ""), lon: String(c[1] ?? "") };
      };
      const habits = H.learn(learnIds.concat(failed).map(rowOf));
      found.push({ name, lines: H.summary(habits) });
      const far = farCheck(set, learnIds, R);
      for (const i of failed) {
        const d = H.decide(rowOf(i), habits);
        if (!d) continue;
        set.repaired = set.repaired || new Map();
        set.repaired.set(i, { lat: d.lat, lon: d.lon, repaired: "check", habit: true, check: "typing habit: " + d.why + far(d.lat, d.lon) });
        n++;
      }
      // A large CSV is written by the worker, which needs these rows too.
      if (set.big && set.repaired) await ask({ type: "repaired", entries: [ ...set.repaired ], notes: [ ...(set.repairNotes || []) ] });
    }
    return { n, found };
  }

  // Far from the sheet's converted points: often a wrong degree digit, which no habit fixes.
  function farCheck(set, ids, R) {
    if (ids.length < 5) return () => "";
    const med = a => { const v = Float64Array.from(a).sort(); return v[v.length >> 1]; };
    const lat0 = med(ids.map(i => set.lat[i])), lon0 = med(ids.map(i => set.lon[i]));
    const d = Float64Array.from(ids.map(i => R.km(set.lat[i], set.lon[i], lat0, lon0))).sort();
    const limit = Math.max(25, 3 * d[Math.floor(d.length * 0.9)]);
    return (lat, lon) => {
      const k = R.km(lat, lon, lat0, lon0);
      return k > limit ? `; but ${Math.round(k)} km from the sheet's other points — check the degrees` : "";
    };
  }

  function showHabits(h) {
    const box = $("batch-habits-found");
    if (!h || !h.found.length) {
      box.hidden = true;
      return;
    }
    $("batch-habits-list").innerHTML = h.found.map(f => `<p><strong>${esc(f.name)}</strong></p><ul>` +
      (f.lines.length ? f.lines.map(l => `<li>${esc(l)}</li>`).join("") : "<li>No habit is shared by enough rows to learn from.</li>") + "</ul>").join("");
    box.hidden = false;
  }

  /* ---------- preview: only the rows on screen are ever drawn ---------- */

  // Row ids run through all converted sheets in order; `view` lists the ones to show.
  function buildView() {
    const out = state.results, show = $("batch-view").value, B = BC();
    let base = 0, n = 0;
    let set = null;
    const fixed = i => !!(set.repaired && set.repaired.has(i));
    const keep = (st, i) => show === "failed" ? st >= B.FAILED && !fixed(i) : show === "repaired" ? fixed(i) :
      show === "check" ? st === B.OK && set.checks && set.checks.has(i) : st !== B.EMPTY;
    for (const name of out.names) {
      set = out.sets[name];
      set.base = base;
      for (let i = 0; i < set.n; i++) if (keep(set.status[i], i)) n++;
      base += set.n;
    }
    view = new Int32Array(n);
    let k = 0;
    for (const name of out.names) {
      set = out.sets[name];
      for (let i = 0; i < set.n; i++) if (keep(set.status[i], i)) view[k++] = set.base + i;
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
        const note = set.repairNotes && set.repairNotes.get(i);
        if (res.error !== undefined) res = { error: r.error + (note ? `; Repair: ${note}` : "") };
      } else {
        const s = state.sheets[name];
        raw = BC().rawOf(s.aoa[set.rowIndex[i]], s);
        rowNo = set.rowIndex[i] + 1;
      }
      const cols = outCols(res, out.f).filter(c => !BC().STATUS_COLS.has(c[0]));
      const ok = res.lat !== undefined;
      const result = !ok ? `<span class="badge st-bad">Not converted</span><br><span class="hint">${esc(res.error)}</span>` :
        res.repaired === "fixed" ? `<span class="badge st-fixed">Repaired</span><br><span class="hint">${esc(res.check)}</span>` :
        res.repaired ? `<span class="badge st-choose">Best guess</span><br><span class="hint">${esc(res.check)}</span>` :
        res.check ? `<span class="badge st-choose">Check</span><br><span class="hint">${esc(res.check)}</span>` : '<span class="badge st-ok">OK</span>';
      return `<tr class="${!ok ? "batch-fail" : res.repaired === "fixed" ? "batch-fixed" : res.repaired || res.check ? "batch-check" : ""}"><td class="hint">${multi ? esc(name) + " · " : ""}${rowNo}</td><td><pre class="raw">${!ok || res.repaired ? pinMarkup(raw) : esc(raw)}</pre></td>` +
        cols.map(c => `<td class="num">${esc(c[1])}</td>`).join("") + `<td>${result}</td></tr>`;
    });
  }

  let spacer = 0, drawToken = 0, frame = 0;

  function renderPreview() {
    const out = state.results;
    if (!out) return;
    out.f = formats();
    buildView();
    const multi = out.names.length > 1;
    const names = outCols({ empty: true }, out.f).map(c => c[0]).filter(n => !BC().STATUS_COLS.has(n));
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
    const total = view.length, show = $("batch-view").value;
    const cols = outCols({ empty: true }, out.f).length + 1;
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
      (show === "failed" ? " not converted" : show === "check" ? " worth checking" : show === "repaired" ? " repaired" : "") + (total > shown ? " — scroll the table for more" : "");
  }

  /* ---------- download ---------- */

  const XLSX_TIP = "The same workbook with the new columns added to each converted sheet, and rows coloured by result (a Legend sheet explains the colours). Other sheets are kept as they are.";
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

  // Rows are coloured by result: green converted, orange converted but worth checking,
  // red not converted. A Legend sheet explains the colours.
  async function downloadXlsx() {
    if (!state.results || state.big) return;
    const out = state.results;
    out.f = formats();
    const wb = XLSX.utils.book_new(), plan = [];
    for (const name of state.workbook.SheetNames) {
      const set = out.sets[name];
      XLSX.utils.book_append_sheet(wb, set ? XLSX.utils.aoa_to_sheet(convertedAoa(name)) : cleanSheet(state.workbook.Sheets[name]), name);
      if (!set) continue;
      const rows = new Map();
      for (let i = 0; i < set.n; i++) {
        const kind = BC().kindOf(resOf(set, i));
        if (kind) rows.set(set.rowIndex[i] + 1, kind);
      }
      plan.push({ sheet: wb.SheetNames.length, header: state.sheets[name].h + 1, rows });
    }
    const name = `${state.fileName || "cordify"}_converted.xlsx`;
    const C = window.CordifyXlsxColor;
    if (!C || typeof JSZip === "undefined") return XLSX.writeFile(wb, name);
    plan.push(C.addLegend(XLSX, wb, [
      [ "ok", "Green", "Converted (Convert_Status: OK)" ],
      [ "fixed", "Yellow", "Repaired: the value was mistyped and has one clear reading. Check it; what was changed is in Convert_Check." ],
      [ "check", "Orange", "Worth checking: converted but far from the other points, the same position as another row, or typed roughly; or a repaired best guess where several readings fit. The reason is in Convert_Check." ],
      [ "bad", "Red", "Not converted: the reason is in Convert_Status. Badly typed values can often be fixed in Repair (Advanced mode)." ]
    ], (out.coarse.length ? coarseText(out.coarse) + " " : "") + "Rows with no colour have no coordinate. Made by Cordify."));
    try {
      const bytes = await C.colour(XLSX.write(wb, { type: "array", bookType: "xlsx" }), plan, JSZip);
      download(name, new Blob([ bytes ], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    } catch (e) {
      XLSX.writeFile(wb, name);   // the same file, without colours
    }
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

  /* ---------- export for GIS (the shared dialog in gis-export.js) ---------- */

  const gisButtons = off => document.querySelectorAll("#batch-gis button").forEach(b => { b.disabled = off; });

  // GeoPackage files are SQLite databases, written with sql.js (assets/vendor), loaded only when needed.
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

  const BATCH_LEGEND = [
    [ "ok", "Green", "Converted." ],
    [ "fixed", "Yellow", "Repaired: the value was mistyped and has one clear reading. Check it." ],
    [ "check", "Orange", "Worth checking: far from the other points, a duplicate, typed roughly, or a repaired best guess." ],
    [ "bad", "Red", "Not converted." ]
  ];

  // Every converted sheet as rows: its own columns, then the new ones; rows without a coordinate kept too.
  function gisDatasets() {
    const out = state.results;
    out.f = formats();
    const added = outCols({ empty: true }, out.f).map(c => c[0]);
    return out.names.map(name => {
      const s = state.sheets[name], set = out.sets[name], rows = [];
      for (let i = 0; i < set.n; i++) {
        const res = resOf(set, i);
        if (res.empty) continue;
        const r = s.aoa[set.rowIndex[i]];
        rows.push({
          lat: res.lat ?? null, lon: res.lon ?? null, rowNo: set.rowIndex[i] + 1, kind: BC().kindOf(res), reason: res.lat === undefined ? res.error : "",
          values: s.head.map((h, j) => r[j]).concat(outCols(res, out.f).map(c => c[1]))
        });
      }
      return { name, head: s.head.concat(added), rows };
    });
  }

  function openGisExport() {
    const out = state.results;
    if (!out || busy || !window.CordifyGisExport) return;
    if (!state.big) {
      window.CordifyGisExport.open({ fileName: state.fileName || "cordify", datasets: gisDatasets(), legend: BATCH_LEGEND });
      return;
    }
    // A large CSV: the worker writes each format straight from the file on disk.
    out.f = formats();
    const name = Object.keys(out.sets)[0], s = state.sheets[name];
    const added = outCols({ empty: true }, out.f).map(c => c[0]);
    window.CordifyGisExport.open({
      fileName: state.fileName || "cordify",
      big: {
        name: state.fileName || "cordify", head: s.head.concat(added), points: out.ok + (out.repaired ? out.repaired.fixed + out.repaired.check : 0),
        formats: [ "gpkg", "geojson", "kml", "kmz", "gpx" ],
        run: async (format, keep, colour) => {
          const m = await ask({ type: "exportGeo", format, keep, colour, f: out.f, title: state.fileName, sqlJs: SQL_JS, gridSpec: gridOn() ? window.CordifyGrid.spec() : "off" });
          if (!m.blob) throw new Error("nothing written");
          return m.blob;
        }
      }
    });
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
        const fixed = set.repaired && set.repaired.get(i);
        if ((set.status[i] !== BC().OK && !fixed) || seen++ % step) continue;
        lat.push(fixed ? fixed.lat : set.lat[i]);
        lon.push(fixed ? fixed.lon : set.lon[i]);
        label.push(`${out.names.length > 1 ? name + " · " : ""}row ${set.big ? set.recNo[i] : set.rowIndex[i] + 1}`);
      }
    }
    window.CordifyMap.plotPoints(lat, lon, label, step > 1 ? `Showing ${count(lat.length)} of ${count(out.ok)} points (every ${step}${step === 2 ? "nd" : step === 3 ? "rd" : "th"} one)` : `Plotted ${count(lat.length)} points`);
  }

  /* ---------- helpers ---------- */

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // The typed text with the wrong characters marked.
  const pinMarkup = raw => window.CordifyPinpoint ? window.CordifyPinpoint.markup(raw, esc) : esc(raw);

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

  // offer: "both" (repair here, or open the Repair tab), "tab" (only the Repair tab), or nothing
  function status(text, kind, offer) {
    const el = $("batch-status");
    el.className = "hint batch-status" + (kind ? " " + kind : "");
    el.textContent = text;
    if (offer === "both" && window.CordifyRepair) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "batch-repair-here";
      b.textContent = "Repair them here";
      b.setAttribute("data-tip", "Tries every sensible reading of each badly typed value, as the Repair tab does, using your saved boundary and village locations if you have them (otherwise the area is estimated from the rows that converted). Repaired rows are marked so you can check them.");
      b.addEventListener("click", repairFailed);
      el.append(" ", b);
    }
    if (offer && $("advanced-mode")) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-quiet batch-repair";
      b.textContent = offer === "tab" ? "Review them in the Repair tab" : "Fix them in the Repair tab (Advanced)";
      b.setAttribute("data-tip", "Opens the Repair tab, which can rebuild badly typed coordinates using a boundary. Load the same file there.");
      b.addEventListener("click", openRepair);
      el.append(" ", b);
    }
  }

  /* ---------- repair the rows that did not convert ---------- */

  const VILLAGE = /village|vill\b|locality|place|site/i;
  const ANCHORS = 20000;   // converted rows given to Repair to show where the area and villages are

  async function repairFailed() {
    const out = state.results, R = window.CordifyRepair, Ref = window.CordifyReference, B = BC();
    if (!out || busy || !R) return;
    setBusy(true, "Repairing the rows that couldn't be read…");
    try {
      const rows = [], back = [];
      for (const name of out.names) {
        const set = out.sets[name], s = state.sheets[name];
        const failed = [];
        // Rows a typing habit already settled are left as they are.
        for (let i = 0; i < set.n; i++) if (set.status[i] >= B.FAILED && !(set.repaired && set.repaired.has(i) && set.repaired.get(i).habit)) failed.push(i);
        let cellsOf;
        if (set.big) {
          const m = failed.length ? await ask({ type: "window", ids: failed }) : { rows: [] };
          const cells = new Map(m.rows.map(r => [ r.i, r.cells ]));
          cellsOf = i => cells.get(i) || [];
        } else {
          cellsOf = i => {
            const r = s.aoa[set.rowIndex[i]];
            return s.mode === "one" ? [ r[s.one] ] : [ r[s.lat], r[s.lon] ];
          };
        }
        const vi = set.big ? -1 : s.head.findIndex(x => VILLAGE.test(x));
        const villageOf = i => vi >= 0 ? String(s.aoa[set.rowIndex[i]][vi] ?? "").trim() : "";
        for (const i of failed) {
          const c = cellsOf(i);
          const row = s.mode === "one" ? { text: String(c[0] ?? "") } : { latText: String(c[0] ?? ""), lonText: String(c[1] ?? "") };
          back.push({ set, i, k: rows.length });
          rows.push(Object.assign(row, { id: rows.length, group: name, village: villageOf(i) }));
        }
        const ok = [];
        for (let i = 0; i < set.n; i++) if (set.status[i] === B.OK) ok.push(i);
        const step = Math.max(1, Math.ceil(ok.length / ANCHORS));
        for (let k = 0; k < ok.length; k += step) {
          const i = ok[k];
          rows.push({ id: rows.length, text: `${set.lat[i]}, ${set.lon[i]}`, group: name, village: villageOf(i) });
        }
      }
      if (!back.length) {
        setBusy(false);
        return;
      }
      await new Promise(r => setTimeout(r, 30));   // let the progress line show
      const savedB = Ref ? await Ref.loadBoundary() : null, savedP = Ref ? await Ref.loadPlaces() : null;
      let features, groupFeatures, estimated = false, how;
      if (savedB && Array.isArray(savedB.src) && savedB.src.length) {
        features = savedB.src.map((f, j) => R.buildFeature({ rings: f.rings, props: f.props }, j));
        groupFeatures = Ref.groupFeatures(rows, features, savedB.src).groupFeatures;
        how = `your saved boundary “${savedB.name}”`;
      } else {
        const est = R.estimateAreas(rows);
        if (!est.features.length) {
          setBusy(false);
          status("Too few rows converted to estimate the area. Load a boundary in the Repair tab (Advanced mode) and try again.", "bad", "tab");
          return;
        }
        features = est.features;
        groupFeatures = est.groupFeatures;
        estimated = true;
        how = "an area estimated from the rows that converted (a boundary saved in the Repair tab makes this more reliable)";
      }
      const places = savedP && Array.isArray(savedP.list) && savedP.list.length ? R.buildPlaces(savedP.list) : null;
      const res = R.repairRows(rows, { features, groupFeatures, digitFix: true, estimated, places });
      const tally = { fixed: 0, check: 0, left: 0 };
      for (const b of back) {
        const r = res[b.k];
        b.set.repaired = b.set.repaired || new Map();
        b.set.repairNotes = b.set.repairNotes || new Map();
        const note = r.notes.filter(n => !/^read as /.test(n)).slice(0, 3).join("; ");
        if ((r.status === "fixed" || r.status === "choose") && r.lat != null) {
          const kind = r.status === "fixed" ? "fixed" : "check";
          b.set.repaired.set(b.i, { lat: r.lat, lon: r.lon, repaired: kind, check: (kind === "fixed" ? "repaired: " : "best guess, several readings fit: ") + note });
          tally[kind]++;
        } else {
          b.set.repairNotes.set(b.i, note || "no reading fits the area");
          tally.left++;
        }
      }
      // A large CSV is written by the worker, which needs the repairs too.
      for (const name of out.names) {
        const set = out.sets[name];
        if (set.big && set.repaired) await ask({ type: "repaired", entries: [ ...set.repaired ], notes: [ ...set.repairNotes ] });
      }
      const byHabit = out.repaired && out.repaired.habit || 0;   // settled earlier by typing habits
      out.repaired = { ...tally, check: tally.check + byHabit, habit: byHabit };
      setBusy(false);
      gisButtons(false);
      $("batch-map").disabled = false;
      const n = tally.fixed + tally.check;
      $("batch-view").querySelector('[value="repaired"]').hidden = !(n + byHabit);
      $("batch-view").querySelector('[value="repaired"]').textContent = `Repaired (${count(n + byHabit)})`;
      $("batch-view").querySelector('[value="failed"]').textContent = `Not converted (${count(tally.left)})`;
      status(`Repaired ${count(n)} of the ${count(back.length)} rows that couldn't be read, using ${how}${places ? " and your saved village locations" : ""}: ` +
        `${count(tally.fixed)} with one clear reading (yellow), ${count(tally.check)} best guesses where several readings fit (orange).` +
        (tally.left ? ` ${count(tally.left)} still couldn't be read (red).` : "") + " Check them before using them.", tally.left ? "warn" : "good", "tab");
      renderPreview();
    } catch (err) {
      setBusy(false);
      status(err.message === "cancelled" ? "Cancelled." : "The repair could not be finished. Try again, or use the Repair tab (Advanced mode).", err.message === "cancelled" ? "" : "bad", "tab");
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
    $("batch-habits-found").hidden = true;
    if ($("batch-systems")) $("batch-systems").hidden = true;
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
    if ($("batch-report")) $("batch-report").hidden = true;
    [ "batch-sheet-wrap", "batch-mapping", "batch-out", "batch-actions", "batch-gis" ].forEach(id => { $(id).hidden = true; });
    status("");
  }

  function init() {
    if (!$("batch-file")) return;
    $("batch-file").addEventListener("change", onFile);
    $("batch-sheet").addEventListener("change", () => {
      renderCols();
      clearResults();
      if ($("batch-report")) $("batch-report").hidden = true;
    });
    if ($("batch-scan")) $("batch-scan").addEventListener("click", scanFirst);
    $("batch-cols").addEventListener("change", onColsChange);
    $("batch-run").addEventListener("click", run);
    // The typing-habits choice is remembered on this device.
    try {
      $("batch-habits").checked = localStorage.getItem(HABITS_KEY) === "1";
    } catch (e) {}
    $("batch-habits").addEventListener("change", e => {
      try {
        localStorage.setItem(HABITS_KEY, e.target.checked ? "1" : "0");
      } catch (err) {}
    });
    // The source datum is remembered on this device; changing it converts again.
    const dsel = $("batch-datum"), S = window.CordifySystems;
    if (dsel && S) {
      dsel.innerHTML = Object.keys(S.DATUMS).map(k => `<option value="${k}">${esc(S.DATUMS[k].label)}</option>`).join("");
      try {
        const saved = localStorage.getItem(DATUM_KEY);
        if (saved && S.DATUMS[saved]) dsel.value = saved;
      } catch (e) {}
      dsel.addEventListener("change", () => {
        try {
          localStorage.setItem(DATUM_KEY, dsel.value);
        } catch (e) {}
        if (state.results) run();
      });
    }
    if ($("batch-systems")) {
      $("batch-systems").addEventListener("click", onSystemAction);
      $("batch-systems").addEventListener("change", onSystemAction);
    }
    $("batch-cancel").addEventListener("click", () => stopWorker(new Error("cancelled")));
    $("batch-download-xlsx").addEventListener("click", downloadXlsx);
    $("batch-download-csv").addEventListener("click", downloadCsv);
    $("batch-map").addEventListener("click", showOnMap);
    $("batch-gis-open").addEventListener("click", openGisExport);
    $("batch-view").addEventListener("change", renderPreview);
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
