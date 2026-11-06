/*
 * Cordify — Batch convert (Convert tab)
 * Reads every sheet (or one), finds the coordinate column(s), reads DD / DMS /
 * DDM values that are typed correctly, and writes DD, DMS and/or DDM columns.
 * It never guesses: values that look mistyped are reported, with a pointer to
 * the Repair tool (Advanced mode).
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const R = () => window.CordifyRepair;
  const C = () => window.CordifyConvert;
  const PREVIEW = 50;

  const state = { workbook: null, fileName: "", sheets: {}, results: null };

  /* ---------- reading a value ---------- */

  const BLANK = v => {
    const t = String(v ?? "").trim();
    return !t || /^[-–—_.\s]*$/.test(t) || /^(nil|na|n\.a\.?|none|null)$/i.test(t);
  };
  // Why a value looks mistyped, in words about the typing (not about how Repair would fix it).
  const PLAIN = {
    "mark before a decimal point ignored": "a ' or \" mark is typed before the decimal point",
    "space after decimal point removed": "there is a space after the decimal point",
    "° read as 0 inside a number": "a ° is typed inside a number (probably meant 0)",
    "letters read as digits (O→0, l→1…)": "letters are typed where digits should be (O, l, I…)",
    "extra values ignored": "the cell has more than two values"
  };
  const changesValue = notes => notes.filter(n => n.cost > 0).map(n => PLAIN[n.text] || n.text);
  const NOT_VALID = which => `${which} isn't a valid coordinate — check the decimal point, the ° ' " marks, and that minutes and seconds are under 60`;

  // One value (latitude or longitude) from its own cell.
  function readOne(text, role) {
    const c = R().cleanText(text);
    const bad = changesValue(c.notes);
    if (bad.length) return { error: `looks mistyped (${bad.join(", ")})`, mistyped: true };
    const v = C().parseCoord(c.text, role);
    if (v !== null) return { value: v };
    const which = role === "lat" ? "latitude" : "longitude";
    return /\d/.test(c.text) ? { error: NOT_VALID(which), mistyped: true } : { error: `${which} has no numbers` };
  }

  // A whole pair from one cell: "26.92, 95.03", "26°55'7" N, 95°4'43.6" E, 120m", "N 26 34 56 E 77 35 12"...
  function readPair(text) {
    const s = R().splitCell(text);
    if (s.empty) return { empty: true };
    const bad = changesValue(s.notes);
    if (bad.length) return { error: `looks mistyped (${bad.join(", ")})`, mistyped: true };
    if (s.problem || s.parts.length !== 2) return { error: s.problem || "could not find two values (latitude and longitude)" };
    let [ a, b ] = s.parts;
    const role = p => p.hemi === "N" || p.hemi === "S" ? "lat" : p.hemi === "E" || p.hemi === "W" ? "lon" : null;
    if (role(a) === "lon" && role(b) === "lat") [ a, b ] = [ b, a ];   // "E 94.8, N 26.2": letters decide
    const str = p => p.hemi ? `${p.text} ${p.hemi}` : p.text;
    const lat = C().parseCoord(str(a), "lat"), lon = C().parseCoord(str(b), "lon");
    if (lat !== null && lon !== null) return { lat, lon };
    if (!role(a) && !role(b) && C().parseCoord(str(b), "lat") !== null && C().parseCoord(str(a), "lon") !== null) {
      return { error: "latitude and longitude look swapped (longitude first)", mistyped: true };
    }
    return { error: NOT_VALID(lat === null ? "latitude" : "longitude"), mistyped: true };
  }

  function readRow(r, cfg) {
    if (cfg.mode === "one") {
      if (BLANK(r[cfg.one])) return { empty: true };
      return readPair(String(r[cfg.one]));
    }
    const a = r[cfg.lat], b = r[cfg.lon];
    if (BLANK(a) && BLANK(b)) return { empty: true };
    if (BLANK(a) || BLANK(b)) return { error: BLANK(a) ? "latitude is missing" : "longitude is missing" };
    const la = readOne(String(a), "lat"), lo = readOne(String(b), "lon");
    if (la.value !== undefined && lo.value !== undefined) return { lat: la.value, lon: lo.value };
    // Swapped columns?
    const sa = readOne(String(b), "lat"), so = readOne(String(a), "lon");
    if (sa.value !== undefined && so.value !== undefined) return { error: "latitude and longitude look swapped (columns the wrong way round?)", mistyped: true };
    return { error: la.error || lo.error, mistyped: la.mistyped || lo.mistyped };
  }

  /* ---------- finding the coordinate column(s) ---------- */

  const COORD_ONE = /co-?ord|coordinate|geo|gps|location|lat.?\/?.?long|latlon|position/i;
  const LATW = /\b(lat|latitude)\b|^y$/i, LONW = /\b(lon|lng|long|longitude)\b|^x$/i;
  const looksPair = v => {
    const t = String(v ?? "");
    const nums = (t.match(/\d+(?:\.\d+)?/g) || []).filter(n => n.replace(".", "").length >= 2);
    return nums.length >= 2 && nums.length <= 10 && /[°ᵒº˚'’′"”″.,]|[NSEW]\b/i.test(t);
  };

  function detect(head, data) {
    const share = (j, test) => {
      const vals = data.map(r => r[j]).filter(v => !BLANK(v));
      return vals.length ? vals.filter(test).length / vals.length : 0;
    };
    const lat = head.findIndex(x => LATW.test(x) && !LONW.test(x));
    if (lat >= 0) {
      const key = head[lat].replace(LATW, "").replace(/[\s_.()-]+/g, "").toLowerCase();
      let lon = head.findIndex((y, i) => i !== lat && LONW.test(y) && !LATW.test(y) && y.replace(LONW, "").replace(/[\s_.()-]+/g, "").toLowerCase() === key);
      if (lon < 0) lon = head.findIndex((y, i) => i !== lat && LONW.test(y) && !LATW.test(y));
      if (lon >= 0) return { mode: "two", lat, lon, one: lat, found: true };
    }
    let one = head.findIndex((x, j) => COORD_ONE.test(x) && !LATW.test(x) && !LONW.test(x) && share(j, looksPair) > 0);
    if (one < 0) {
      let best = -1, bestS = 0;
      head.forEach((_, j) => {
        const s = share(j, looksPair);
        if (s > bestS) { best = j; bestS = s; }
      });
      if (bestS >= 0.3) one = best;
    }
    if (one >= 0) return { mode: "one", one, lat: one, lon: Math.min(one + 1, head.length - 1), found: true };
    return { mode: "two", lat: 0, lon: Math.min(1, head.length - 1), one: 0, found: false };
  }

  /* ---------- file ---------- */

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    reset();
    if (!file) return;
    if (typeof XLSX === "undefined") {
      status("The spreadsheet library did not load. Check your internet connection and reload the page.", "bad");
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      let wb;
      if (/\.csv$/i.test(file.name)) {
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        } catch (err) {
          text = new TextDecoder("windows-1252").decode(buf);
        }
        wb = XLSX.read(text.replace(/^﻿/, ""), { type: "string" });
      } else {
        wb = XLSX.read(buf, { type: "array" });
      }
      state.workbook = wb;
      state.fileName = file.name.replace(/\.[^.]+$/, "");
      for (const name of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true, blankrows: true });
        const h = aoa.findIndex(r => r.some(c => String(c).trim() !== ""));
        if (h < 0) continue;
        const head = aoa[h].map((c, j) => String(c).replace(/\s+/g, " ").trim() || `Column ${j + 1}`);
        const rows = aoa.slice(h + 1).filter(r => r.some(c => String(c).trim() !== "")).length;
        if (!rows) continue;
        state.sheets[name] = { aoa, head, h, rows, ...detect(head, aoa.slice(h + 1, h + 60)) };
      }
      const names = Object.keys(state.sheets);
      if (!names.length) {
        status("No rows found in this file.", "bad");
        return;
      }
      const sel = $("batch-sheet");
      const usable = names.filter(n => state.sheets[n].found);
      sel.innerHTML = (names.length > 1 ? `<option value="__all">All sheets (${usable.length} with coordinates)</option>` : "") +
        names.map(n => `<option value="${esc(n)}">${esc(n)} (${state.sheets[n].rows} rows)</option>`).join("");
      sel.value = names.length > 1 && usable.length > 1 ? "__all" : (usable[0] || names[0]);
      $("batch-sheet-wrap").hidden = names.length < 2;
      renderCols();
      [ "batch-mapping", "batch-out", "batch-actions" ].forEach(id => { $(id).hidden = false; });
      const total = names.reduce((a, n) => a + state.sheets[n].rows, 0);
      status(`Read ${total} rows from ${names.length} sheet${names.length > 1 ? "s" : ""}` + (usable.length < names.length ? ` — no coordinate column found in ${names.length - usable.length} (choose one below, or untick it)` : ""));
    } catch (err) {
      status("Could not read this file. Use .xlsx, .xls or .csv.", "bad");
    }
  }

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
        <td>${s.rows}</td>
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

  function formats() {
    const f = {
      dd: $("batch-fmt-dd").checked, dms: $("batch-fmt-dms").checked, ddm: $("batch-fmt-ddm").checked,
      ddDigits: +$("batch-prec-dd").value, secDigits: +$("batch-prec-dms").value, minDigits: +$("batch-prec-ddm").value
    };
    if (!f.dd && !f.dms && !f.ddm) {
      f.dd = true;
      $("batch-fmt-dd").checked = true;
    }
    return f;
  }

  function outCols(res, f) {
    const ok = res.lat !== undefined;
    const cols = [];
    if (f.dd) cols.push([ "Lat_DD", ok ? R().formatDD(res.lat, f.ddDigits) : "" ], [ "Lon_DD", ok ? R().formatDD(res.lon, f.ddDigits) : "" ]);
    if (f.dms) cols.push([ "Lat_DMS", ok ? R().formatDMS(res.lat, "lat", f.secDigits) : "" ], [ "Lon_DMS", ok ? R().formatDMS(res.lon, "lon", f.secDigits) : "" ]);
    if (f.ddm) cols.push([ "Lat_DDM", ok ? R().formatDDM(res.lat, "lat", f.minDigits) : "" ], [ "Lon_DDM", ok ? R().formatDDM(res.lon, "lon", f.minDigits) : "" ]);
    cols.push([ "Convert_Status", res.empty ? "Empty" : ok ? "OK" : "Not converted: " + res.error ]);
    return cols;
  }

  function run() {
    if (!state.workbook) return;
    const f = formats();
    const names = selected();
    if (!names.length) {
      status("Tick at least one sheet.", "bad");
      return;
    }
    const out = { f, sheets: {}, ok: 0, failed: 0, empty: 0, mistyped: 0, rows: [] };
    for (const n of names) {
      const s = state.sheets[n];
      const list = [];
      for (let i = s.h + 1; i < s.aoa.length; i++) {
        const r = s.aoa[i];
        if (!r || !r.some(c => String(c).trim() !== "")) continue;
        const res = readRow(r, s);
        const raw = s.mode === "one" ? String(r[s.one] ?? "") : `${r[s.lat] ?? ""}  |  ${r[s.lon] ?? ""}`;
        const item = { sheet: n, rowIndex: i, raw, res };
        list.push(item);
        out.rows.push(item);
        if (res.empty) out.empty++;
        else if (res.lat !== undefined) out.ok++;
        else {
          out.failed++;
          if (res.mistyped) out.mistyped++;
        }
      }
      out.sheets[n] = list;
    }
    state.results = out;
    const total = out.ok + out.failed;
    const msg = `Converted ${out.ok} of ${total} row${total === 1 ? "" : "s"}` +
      (out.failed ? ` — ${out.failed} couldn't be read${out.mistyped ? ` (${out.mistyped} look mistyped)` : ""}` : "") +
      (out.empty ? `, ${out.empty} empty` : "") + ".";
    status(msg, out.failed ? (out.ok ? "warn" : "bad") : "good", out.failed > 0);
    $("batch-download-xlsx").disabled = !out.ok && !out.failed;
    $("batch-download-csv").disabled = !out.ok && !out.failed;
    $("batch-only-problems").checked = out.failed > 0 && out.ok === 0 ? false : $("batch-only-problems").checked;
    renderPreview();
  }

  function renderPreview() {
    const out = state.results;
    if (!out) return;
    const only = $("batch-only-problems").checked;
    const list = out.rows.filter(x => only ? (!x.res.empty && x.res.lat === undefined) : !x.res.empty);
    const multi = Object.keys(out.sheets).length > 1;
    const names = outCols({ empty: true }, out.f).map(c => c[0]).filter(n => n !== "Convert_Status");
    $("batch-head").innerHTML = `<th>${multi ? "Sheet · row" : "Row"}</th><th>Original</th>` + names.map(n => `<th>${esc(n.replace("_", " "))}</th>`).join("") + "<th>Result</th>";
    $("batch-body").innerHTML = list.slice(0, PREVIEW).map(x => {
      const cols = outCols(x.res, out.f);
      const ok = x.res.lat !== undefined;
      return `<tr class="${ok ? "" : "batch-fail"}"><td class="hint">${multi ? esc(x.sheet) + " · " : ""}${x.rowIndex + 1}</td><td><pre class="raw">${esc(x.raw)}</pre></td>` +
        cols.slice(0, -1).map(c => `<td class="num">${esc(c[1])}</td>`).join("") +
        `<td>${ok ? '<span class="badge st-ok">OK</span>' : `<span class="badge st-bad">Not converted</span><br><span class="hint">${esc(x.res.error)}</span>`}</td></tr>`;
    }).join("") || `<tr><td colspan="${names.length + 3}" class="empty">No rows in this view.</td></tr>`;
    $("batch-preview-label").textContent = `Showing ${Math.min(PREVIEW, list.length)} of ${list.length} rows` + (only ? " that couldn't be read" : "");
    $("batch-preview-wrap").hidden = false;
  }

  /* ---------- download ---------- */

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
    const s = state.sheets[name], out = state.results;
    const aoa = s.aoa.map(r => r.map(noCR));
    const col = Math.max(...aoa.map(r => r.length));
    const names = outCols({ empty: true }, out.f).map(c => c[0]);
    names.forEach((h, j) => { aoa[s.h][col + j] = h; });
    for (const x of out.sheets[name]) {
      outCols(x.res, out.f).forEach((c, j) => { aoa[x.rowIndex][col + j] = c[1]; });
    }
    return aoa;
  }

  function downloadXlsx() {
    if (!state.results) return;
    const wb = XLSX.utils.book_new();
    for (const name of state.workbook.SheetNames) {
      const ws = state.results.sheets[name] ? XLSX.utils.aoa_to_sheet(convertedAoa(name)) : cleanSheet(state.workbook.Sheets[name]);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    XLSX.writeFile(wb, `${state.fileName || "cordify"}_converted.xlsx`);
  }

  // CSV with a byte-order mark so Excel shows ° and other symbols correctly.
  const toCsv = aoa => "﻿" + XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(aoa));

  async function downloadCsv() {
    if (!state.results) return;
    const names = Object.keys(state.results.sheets);
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
    $("batch-preview-wrap").hidden = true;
    $("batch-download-xlsx").disabled = true;
    $("batch-download-csv").disabled = true;
  }

  function reset() {
    state.workbook = null;
    state.sheets = {};
    clearResults();
    [ "batch-sheet-wrap", "batch-mapping", "batch-out", "batch-actions" ].forEach(id => { $(id).hidden = true; });
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
    $("batch-download-xlsx").addEventListener("click", downloadXlsx);
    $("batch-download-csv").addEventListener("click", downloadCsv);
    $("batch-only-problems").addEventListener("change", renderPreview);
    [ "batch-fmt-dd", "batch-fmt-dms", "batch-fmt-ddm", "batch-prec-dd", "batch-prec-dms", "batch-prec-ddm" ].forEach(id => $(id).addEventListener("change", () => {
      if (state.results) run();
    }));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // For tests
  window.CordifyBatch = { readPair, readOne, readRow, detect };
})();
