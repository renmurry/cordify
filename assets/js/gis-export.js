/*
 * Cordify — Export for GIS
 * One export for Batch convert, Repair and the sheet: choose the formats and the columns,
 * and get one zip (or a folder you pick) with a folder per sheet and one per format.
 *
 *   window.CordifyGisExport.open({ fileName, datasets, legend, big })
 *     datasets  [ { name, head: [column names], rows: [ { lat, lon, values, kind, reason, rowNo } ], extras: [ { path, data } ] } ]
 *               rows in their original order; a row with lat == null has no coordinate (reason says why);
 *               kind ("ok", "fixed", "check", "bad", "confirmed") colours Google Earth pins and Excel rows
 *     legend    [ [ kind, colour name, meaning ] ] for the Excel legend sheet
 *     big       for a file too big to hold in memory (Batch's large CSV):
 *               { name, head, formats: [ids], points, run(format, keepNames, colour) -> Promise<Blob> }
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const FORMATS = [
    { id: "gpkg", label: "GeoPackage", hint: "QGIS, ArcGIS: one file, coordinate system built in", folder: "geopackage" },
    { id: "shp", label: "Shapefile", hint: "older GIS software; column names cut to 10 characters", folder: "shapefile" },
    { id: "geojson", label: "GeoJSON", hint: "QGIS, web maps", folder: "geojson" },
    { id: "kml", label: "KML", hint: "Google Earth", folder: "kml" },
    { id: "kmz", label: "KMZ", hint: "Google Earth, zipped", folder: "kmz" },
    { id: "gpx", label: "GPX", hint: "GPS units and field apps", folder: "gpx" },
    { id: "csv", label: "CSV", hint: "the table, with coordinates", folder: "csv" },
    { id: "xlsx", label: "Excel", hint: "the table, rows coloured by result", folder: "excel" }
  ];
  const PREFS_KEY = "cordify_gis_export_v1";
  const DEFAULT = { formats: [ "gpkg", "geojson", "kml" ], colour: true, missing: true };
  let current = null;

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safe = n => String(n).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "sheet";
  const stamp = d => {
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  // A value as text for files that only hold text: dates as 2026-11-13 08:30.
  const plain = v => v instanceof Date ? (isNaN(v) ? "" : `${stamp(v)} ${String(v.getHours()).padStart(2, "0")}:${String(v.getMinutes()).padStart(2, "0")}`) : v == null ? "" : v;
  const count = n => Number(n).toLocaleString("en-US");

  function prefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
      if (p && Array.isArray(p.formats)) return { ...DEFAULT, ...p };
    } catch (e) {}
    return { ...DEFAULT };
  }
  function savePrefs(p) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch (e) {}
  }

  /* ---------- the files ---------- */

  let sqlPromise = null;
  function loadSql() {
    if (window.CordifyBatch && window.CordifyBatch.loadSql) return window.CordifyBatch.loadSql();
    if (sqlPromise) return sqlPromise;
    const base = new URL("./assets/vendor/", document.baseURI).href;
    sqlPromise = new Promise((resolve, reject) => {
      const start = () => window.initSqlJs({ locateFile: f => base + f }).then(resolve, reject);
      if (window.initSqlJs) return start();
      const s = document.createElement("script");
      s.src = base + "sql-wasm.js";
      s.onload = start;
      s.onerror = () => reject(new Error("library"));
      document.head.appendChild(s);
    });
    sqlPromise.catch(() => { sqlPromise = null; });
    return sqlPromise;
  }

  const csvCell = v => {
    const t = String(plain(v));
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const toCsv = rows => "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

  // Builds every file: [ { path, data } ]. choice: { formats: Set, columns: Set, colour, missing }
  async function build(o, choice, say) {
    const G = window.CordifyGeoIO, files = [], skipped = new Set(), used = new Set(), summary = [];
    const want = id => choice.formats.has(id);
    for (const ds of o.datasets) {
      const keep = ds.head.map((h, j) => j).filter(j => choice.columns.has(ds.head[j]));
      const head = keep.map(j => ds.head[j]);
      const types = head.map(h => G.NUMERIC.test(h) ? "DOUBLE" : "TEXT");
      const pick = r => keep.map(j => plain(r.values[j]));
      const has = r => r.lat != null && r.lon != null && Number.isFinite(+r.lat) && Number.isFinite(+r.lon);
      const pts = ds.rows.filter(has), lost = ds.rows.filter(r => !has(r));
      if (!pts.length && !lost.length) continue;
      let dir = safe(ds.name), k = 2;
      while (used.has(dir.toLowerCase())) dir = `${safe(ds.name)} ${k++}`;
      used.add(dir.toLowerCase());
      const file = dir;
      const li = G.labelColumn(ds.head);
      const label = (r, n) => (li >= 0 && String(plain(r.values[li])).trim()) || `Row ${r.rowNo ?? n + 1}`;
      const props = r => {
        const v = pick(r);
        return head.map((h, i) => [ h, v[i] ]);
      };
      say(`${ds.name}: writing…`);
      for (const fmt of [ "geojson", "kml", "gpx" ]) {
        if (!want(fmt) && !(fmt === "kml" && want("kmz"))) continue;
        const w = G.textWriter(fmt, ds.name);
        const text = w.head + pts.map((r, n) => w.point(label(r, n), +r.lat, +r.lon, props(r), choice.colour ? r.kind : undefined)).join("") + w.tail;
        if (want(fmt)) files.push({ path: `${dir}/${fmt}/${file}.${w.ext}`, data: text });
        if (fmt === "kml" && want("kmz")) {
          const z = new JSZip();
          z.file("doc.kml", text);
          files.push({ path: `${dir}/kmz/${file}.kmz`, data: await z.generateAsync({ type: "uint8array", compression: "DEFLATE" }) });
        }
      }
      if (want("gpkg")) {
        try {
          const pkg = G.gpkg(await loadSql());
          const tb = pkg.table(ds.name, head.map((h, i) => ({ name: h, type: types[i] })));
          pts.forEach(r => tb.point(+r.lat, +r.lon, pick(r)));
          files.push({ path: `${dir}/geopackage/${file}.gpkg`, data: pkg.finish() });
        } catch (e) {
          skipped.add("GeoPackage");
        }
      }
      if (want("shp")) {
        const s = G.shapefile(pts.map(r => ({ lat: +r.lat, lon: +r.lon, values: pick(r) })), head.map((h, i) => ({ name: h, type: types[i] })));
        for (const ext of [ "shp", "shx", "dbf", "prj", "cpg" ]) files.push({ path: `${dir}/shapefile/${file}.${ext}`, data: s[ext] });
        files.push({ path: `${dir}/shapefile/${file} - column names.csv`, data: toCsv([ [ "Short name in the Shapefile", "Full column name" ] ].concat(s.names.map((n, i) => [ n, head[i] ]))) });
      }
      // Tables keep every row, so they need the coordinates as columns too, unless one is kept already.
      const coordKept = head.some(h => /^(lat|latitude|lat_dd)$/i.test(h));
      const tHead = coordKept ? head : head.concat([ "Latitude (WGS 84)", "Longitude (WGS 84)" ]);
      const tRow = r => coordKept ? pick(r) : pick(r).concat(has(r) ? [ +(+r.lat).toFixed(9), +(+r.lon).toFixed(9) ] : [ "", "" ]);
      if (want("csv")) files.push({ path: `${dir}/csv/${file}.csv`, data: toCsv([ tHead ].concat(ds.rows.map(tRow))) });
      if (want("xlsx")) {
        if (typeof XLSX === "undefined") skipped.add("Excel");
        else {
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ tHead ].concat(ds.rows.map(r => coordKept ? keep.map(j => r.values[j]) : keep.map(j => r.values[j]).concat(tRow(r).slice(-2))))), "Points");
          let bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });
          const C = window.CordifyXlsxColor;
          if (C && choice.colour && ds.rows.some(r => r.kind)) {
            const rows = new Map();
            ds.rows.forEach((r, n) => { if (r.kind) rows.set(n + 2, r.kind); });
            const plan = [ { sheet: 1, header: 1, rows } ];
            if (o.legend) plan.push(C.addLegend(XLSX, wb, o.legend, "Rows with no colour have no coordinate. Made by Cordify."));
            bytes = await C.colour(XLSX.write(wb, { type: "array", bookType: "xlsx" }), plan, JSZip).catch(() => bytes);
          }
          files.push({ path: `${dir}/excel/${file}.xlsx`, data: new Uint8Array(bytes) });
        }
      }
      if (choice.missing && lost.length) {
        files.push({ path: `${dir}/${file} - rows without a coordinate.csv`, data: toCsv([ head.concat("Why") ].concat(lost.map(r => pick(r).concat(r.reason || "no coordinate")))) });
      }
      (ds.extras || []).forEach(e => files.push({ path: `${dir}/${e.path}`, data: e.data }));
      summary.push([ ds.name, pts.length, lost.length ]);
    }
    files.push({ path: "README.txt", data: readme(o, choice, summary, skipped) });
    return { files, skipped, summary };
  }

  // A large CSV: the background worker writes each format from the file on disk.
  async function buildBig(o, choice, say) {
    const b = o.big, files = [], skipped = new Set(), dir = safe(b.name), keepNames = b.head.filter(h => choice.columns.has(h));
    for (const f of FORMATS) {
      if (!choice.formats.has(f.id) || !b.formats.includes(f.id)) continue;
      say(`Writing ${f.label}…`);
      try {
        const blob = await b.run(f.id === "kmz" ? "kml" : f.id, keepNames, choice.colour);
        if (f.id === "kmz") {
          const z = new JSZip();
          z.file("doc.kml", blob);
          files.push({ path: `${dir}/kmz/${dir}.kmz`, data: await z.generateAsync({ type: "blob", compression: "DEFLATE" }) });
        } else {
          files.push({ path: `${dir}/${f.folder}/${dir}.${f.id}`, data: blob });
        }
      } catch (e) {
        if (e.message === "cancelled") throw e;
        skipped.add(f.label);
      }
    }
    const summary = [ [ b.name, b.points, 0 ] ];
    files.push({ path: "README.txt", data: readme(o, choice, summary, skipped) });
    return { files, skipped, summary };
  }

  function readme(o, choice, summary, skipped) {
    const names = FORMATS.filter(f => choice.formats.has(f.id) && !skipped.has(f.label));
    return [
      `Cordify export for GIS: ${o.fileName}`,
      `Made ${stamp(new Date())}. All coordinates are WGS 84 latitude/longitude (EPSG:4326).`,
      "",
      ...summary.map(([ n, p, m ]) => `${n}: ${count(p)} point${p === 1 ? "" : "s"}` + (m ? `, ${count(m)} row${m === 1 ? "" : "s"} without a coordinate` + (choice.missing ? " (listed in its own file)" : "") : "")),
      "",
      "Each sheet has a folder, and each format a folder inside it:",
      ...names.map(f => `  ${f.folder.padEnd(11)} ${f.label}: ${f.hint}`),
      choice.formats.has("shp") ? "\nShapefile column names can only be 10 characters long; each shapefile folder has a list of the short names and the full ones." : "",
      choice.colour ? "\nPins in KML / KMZ are coloured by result: green converted or unchanged, yellow repaired with one clear reading, orange worth checking, blue checked by you, red not fixed." : "",
      skipped.size ? `\nLeft out because a library did not load: ${[ ...skipped ].join(", ")}.` : ""
    ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\r\n") + "\r\n";
  }

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

  async function save(files, root, toFolder) {
    if (toFolder) {
      const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      const top = await dirHandle.getDirectoryHandle(root, { create: true });
      for (const f of files) {
        const parts = f.path.split("/");
        let d = top;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
        await w.write(f.data);
        await w.close();
      }
      return `into the folder “${root}”`;
    }
    const zip = new JSZip();
    files.forEach(f => zip.file(`${root}/${f.path}`, f.data));
    download(`${root}.zip`, await zip.generateAsync({ type: "blob", compression: "DEFLATE" }));
    return `as “${root}.zip”`;
  }

  /* ---------- the dialog ---------- */

  function ensureDialog() {
    if ($("gis-dialog")) return;
    const d = document.createElement("dialog");
    d.id = "gis-dialog";
    d.className = "gis-dialog";
    d.setAttribute("aria-labelledby", "gis-title");
    d.innerHTML = `<form method="dialog" class="gis-form">
      <h2 id="gis-title">Export for GIS</h2>
      <p class="hint" id="gis-summary"></p>
      <fieldset><legend>Formats</legend><div class="gis-formats" id="gis-formats"></div></fieldset>
      <fieldset><legend>Columns to include <span class="gis-col-actions"><button type="button" class="btn-quiet" id="gis-all">All</button><button type="button" class="btn-quiet" id="gis-none">None</button></span></legend>
        <div class="gis-cols" id="gis-cols"></div>
        <p class="hint">The location is always included: as the point itself, and as columns in CSV and Excel.</p></fieldset>
      <label class="inline"><input type="checkbox" id="gis-colour"> Colour pins and Excel rows by result</label>
      <label class="inline" id="gis-missing-wrap"><input type="checkbox" id="gis-missing"> Add a list of rows without a coordinate, so none go missing</label>
      <p class="hint batch-status" id="gis-status" role="status"></p>
      <div class="actions">
        <button type="button" class="btn-primary" id="gis-zip">Export as zip</button>
        <button type="button" id="gis-folder" hidden>Save to a folder…</button>
        <button type="button" class="btn-quiet" id="gis-cancel">Close</button>
      </div>
    </form>`;
    document.body.appendChild(d);
    $("gis-all").addEventListener("click", () => $("gis-cols").querySelectorAll("input").forEach(i => { i.checked = true; }));
    $("gis-none").addEventListener("click", () => $("gis-cols").querySelectorAll("input").forEach(i => { i.checked = false; }));
    $("gis-cancel").addEventListener("click", () => d.close());
    $("gis-zip").addEventListener("click", () => go(false));
    $("gis-folder").addEventListener("click", () => go(true));
    $("gis-formats").addEventListener("change", checkReady);
  }

  function checkReady() {
    const any = $("gis-formats").querySelectorAll("input:checked:not(:disabled)").length > 0;
    $("gis-zip").disabled = !any;
    $("gis-folder").disabled = !any;
  }

  function open(o) {
    ensureDialog();
    current = o;
    const p = prefs();
    const big = !!o.big;
    // If none of the formats chosen last time can be used here, start from the usual ones.
    const usable = id => !big || o.big.formats.includes(id);
    if (!p.formats.some(usable)) p.formats = DEFAULT.formats.filter(usable);
    $("gis-formats").innerHTML = FORMATS.map(f => {
      const off = big && !o.big.formats.includes(f.id);
      return `<label class="gis-format${off ? " is-off" : ""}"><input type="checkbox" value="${f.id}"${p.formats.includes(f.id) && !off ? " checked" : ""}${off ? " disabled" : ""}>` +
        `<span><b>${f.label}</b><small>${off ? "not for files this large" : esc(f.hint)}</small></span></label>`;
    }).join("");
    const names = [];
    (big ? [ { head: o.big.head } ] : o.datasets).forEach(ds => ds.head.forEach(h => { if (!names.includes(h)) names.push(h); }));
    $("gis-cols").innerHTML = names.map((h, i) => `<label class="inline"><input type="checkbox" id="gis-col-${i}" value="${esc(h)}" checked> ${esc(h)}</label>`).join("");
    $("gis-colour").checked = p.colour;
    $("gis-missing").checked = p.missing;
    $("gis-missing-wrap").hidden = big;
    $("gis-folder").hidden = typeof window.showDirectoryPicker !== "function";
    const pts = big ? o.big.points : o.datasets.reduce((a, ds) => a + ds.rows.filter(r => r.lat != null).length, 0);
    const lost = big ? 0 : o.datasets.reduce((a, ds) => a + ds.rows.filter(r => r.lat == null).length, 0);
    const sheets = big ? 1 : o.datasets.filter(ds => ds.rows.length).length;
    $("gis-summary").textContent = `${count(pts)} point${pts === 1 ? "" : "s"} in ${sheets} sheet${sheets === 1 ? "" : "s"}` + (lost ? `, and ${count(lost)} row${lost === 1 ? "" : "s"} without a coordinate.` : ".") +
      " One folder per sheet, and one per format inside it.";
    $("gis-status").textContent = "";
    $("gis-status").className = "hint batch-status";
    checkReady();
    $("gis-dialog").showModal();
  }

  async function go(toFolder) {
    const o = current;
    if (!o) return;
    const choice = {
      formats: new Set([ ...$("gis-formats").querySelectorAll("input:checked:not(:disabled)") ].map(i => i.value)),
      columns: new Set([ ...$("gis-cols").querySelectorAll("input:checked") ].map(i => i.value)),
      colour: $("gis-colour").checked,
      missing: $("gis-missing").checked
    };
    savePrefs({ formats: [ ...choice.formats ], colour: choice.colour, missing: choice.missing });
    const status = (text, kind) => {
      $("gis-status").textContent = text;
      $("gis-status").className = "hint batch-status" + (kind ? " " + kind : "");
    };
    $("gis-zip").disabled = $("gis-folder").disabled = true;
    try {
      if (typeof JSZip === "undefined" && !toFolder) throw new Error("The zip library did not load. Reload the page and try again.");
      const built = o.big ? await buildBig(o, choice, status) : await build(o, choice, status);
      status("Saving…");
      const where = await save(built.files, `${safe(o.fileName)} for GIS ${stamp(new Date())}`, toFolder);
      const pts = built.summary.reduce((a, s) => a + s[1], 0);
      status(`Exported ${count(pts)} point${pts === 1 ? "" : "s"} in ${choice.formats.size - built.skipped.size} format${choice.formats.size - built.skipped.size === 1 ? "" : "s"} ${where}.` +
        (built.skipped.size ? ` Left out: ${[ ...built.skipped ].join(", ")} (its library did not load).` : ""), built.skipped.size ? "warn" : "good");
    } catch (e) {
      if (e && e.name === "AbortError") status("");
      else status(e && e.message && !/^[a-z]+$/.test(e.message) ? e.message : "The export could not be written. Try again.", "bad");
    } finally {
      checkReady();
    }
  }

  window.CordifyGisExport = { open, build, FORMATS };
})();
