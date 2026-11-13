/*
 * Cordify — Batch convert, background worker
 * Does the heavy reading and converting off the page, so the page keeps responding
 * and can show progress. Nothing leaves the device: the worker reads the file the
 * user picked and answers the page.
 *
 * Messages in (each has a `job` number, echoed back):
 *   columns  convert coordinate cells the page already holds (Excel files, small CSV)
 *   csv      read a CSV of any size straight from disk, a piece at a time
 *   window   the original text of some rows of that CSV, for the preview
 *   export   write that CSV again with the new columns added
 *   exportGeo  write its converted rows as GeoJSON, KML, GPX or GeoPackage
 *   repaired   rows the page rebuilt with Repair, so the exports include them
 * To cancel, the page simply ends the worker and starts a new one.
 */
importScripts("core.js?v=2", "repair-engine.js?v=7", "batch-core.js?v=4", "geo-io.js?v=1");

const B = self.CordifyBatchCore;
const PROJ4 = "../vendor/proj4.js";   // the same copy index.html loads
let big = null;   // the one large CSV being worked on

// Only grid systems other than UTM need the projection library.
function needProj(spec) {
  if (!spec || spec === "off" || spec === "utm" || typeof self.proj4 !== "undefined") return;
  if (/^epsg:32[67]\d\d$/i.test(spec)) return;
  try {
    importScripts(PROJ4);
  } catch (e) {}
}

// A typed array that grows as rows arrive.
function grow(Type, size = 65536) {
  let a = new Type(size), n = 0;
  return {
    push(v) {
      if (n === a.length) {
        const b = new Type(a.length * 2);
        b.set(a);
        a = b;
      }
      a[n++] = v;
    },
    get length() { return n; },
    done: () => a.slice(0, n)
  };
}

const utf8 = new TextDecoder("utf-8", { fatal: true }), latin = new TextDecoder("windows-1252");
function decode(bytes) {
  try {
    return utf8.decode(bytes);
  } catch (e) {
    return latin.decode(bytes);
  }
}
// A record's bytes without its line break.
function trimEol(bytes) {
  let end = bytes.length;
  if (end && bytes[end - 1] === 10) end--;
  if (end && bytes[end - 1] === 13) end--;
  return end === bytes.length ? bytes : bytes.subarray(0, end);
}

/*
 * Reads the file a piece at a time and calls onRecord(text, startByte, endByte) for
 * every record. Memory use stays flat whatever the file size.
 */
async function eachRecord(file, onRecord, onProgress) {
  const reader = file.stream().getReader();
  const state = { quoted: false };
  let carry = new Uint8Array(0), base = 0, first = true, lastTick = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = value;
    if (first) {
      first = false;
      if (chunk[0] === 0xEF && chunk[1] === 0xBB && chunk[2] === 0xBF) {   // byte-order mark
        chunk = chunk.subarray(3);
        base = 3;
      }
    }
    const ends = B.recordEnds(chunk, state);
    let from = 0;
    for (const end of ends) {
      let bytes = chunk.subarray(from, end);
      if (carry.length) {
        const joined = new Uint8Array(carry.length + bytes.length);
        joined.set(carry);
        joined.set(bytes, carry.length);
        bytes = joined;
        carry = new Uint8Array(0);
      }
      onRecord(decode(trimEol(bytes)), base, base + bytes.length);
      base += bytes.length;
      from = end;
    }
    if (from < chunk.length) {
      const rest = chunk.subarray(from);
      const joined = new Uint8Array(carry.length + rest.length);
      joined.set(carry);
      joined.set(rest, carry.length);
      carry = joined;
    }
    const now = Date.now();
    if (now - lastTick > 80) {
      lastTick = now;
      onProgress(base + carry.length);
    }
  }
  if (carry.length) onRecord(decode(trimEol(carry)), base, base + carry.length);
  onProgress(file.size);
}

/* ---------- columns the page already holds ---------- */

function convertColumns(m) {
  const n = m.a.length;
  const lat = new Float64Array(n), lon = new Float64Array(n), status = new Uint8Array(n), precision = new Float32Array(n);
  const errors = [];
  const cfg = { mode: m.mode, one: 0, lat: 0, lon: 1 };
  const row = [ null, null ];
  for (let i = 0; i < n; i++) {
    row[0] = m.a[i];
    row[1] = m.b ? m.b[i] : null;
    const res = B.readRow(row, cfg);
    status[i] = B.statusOf(res);
    if (res.lat !== undefined) {
      lat[i] = res.lat;
      lon[i] = res.lon;
      precision[i] = res.precision;
    } else {
      lat[i] = lon[i] = precision[i] = NaN;
      if (!res.empty) errors.push([ i, res.error ]);
    }
    if (i % 20000 === 19999) postMessage({ type: "progress", job: m.job, done: i + 1, total: n });
  }
  postMessage({ type: "done", job: m.job, lat, lon, status, precision, errors }, [ lat.buffer, lon.buffer, status.buffer, precision.buffer ]);
}

/* ---------- a CSV of any size ---------- */

async function convertCsv(m) {
  const cfg = m.cfg, delim = m.delim;
  const lat = grow(Float64Array), lon = grow(Float64Array), status = grow(Uint8Array), precision = grow(Float32Array);
  const starts = grow(Float64Array), ends = grow(Float64Array), recNo = grow(Uint32Array);
  const errors = new Map();
  const counts = { ok: 0, failed: 0, empty: 0, mistyped: 0 };
  let rec = 0, header = false, maxFields = 0;
  await eachRecord(m.file, (text, start, end) => {
    rec++;
    if (!text.trim()) return;
    const fields = B.parseCsvRecord(text, delim);
    if (fields.length > maxFields) maxFields = fields.length;
    if (!header) {           // the first line with anything on it holds the column names
      header = true;
      return;
    }
    if (!fields.some(c => c.trim() !== "")) return;
    const res = B.readRow(fields, cfg);
    const st = B.statusOf(res);
    const i = status.length;
    status.push(st);
    starts.push(start);
    ends.push(end);
    recNo.push(rec);
    if (st === B.OK) {
      lat.push(res.lat);
      lon.push(res.lon);
      precision.push(res.precision);
      counts.ok++;
    } else {
      lat.push(NaN);
      lon.push(NaN);
      precision.push(NaN);
      if (st === B.EMPTY) counts.empty++;
      else {
        counts.failed++;
        if (st === B.MISTYPED) counts.mistyped++;
        errors.set(i, res.error);
      }
    }
  }, bytes => postMessage({ type: "progress", job: m.job, done: bytes, total: m.file.size, rows: status.length }));
  big = { file: m.file, cfg, delim, maxFields, errors, lat: lat.done(), lon: lon.done(), status: status.done(), starts: starts.done(), ends: ends.done(), recNo: recNo.done() };
  big.checks = B.qualityChecks(big.lat, big.lon, big.status, precision.done(), big.recNo);
  counts.check = big.checks.size;
  counts.coarse = big.checks.coarse || 0;
  // The page gets its own copies for the preview and the map.
  const out = { lat: big.lat.slice(), lon: big.lon.slice(), status: big.status.slice(), recNo: big.recNo.slice() };
  postMessage({ type: "done", job: m.job, n: big.status.length, counts, checks: [ ...big.checks ], ...out }, [ out.lat.buffer, out.lon.buffer, out.status.buffer, out.recNo.buffer ]);
}

// Original text and reason for some rows, read back from the file by position.
async function rowsWindow(m) {
  if (!big) return postMessage({ type: "window", job: m.job, rows: [] });
  const ids = m.ids, rows = [];
  let k = 0;
  while (k < ids.length) {
    // Rows next to each other are read from the file in one go.
    let j = k;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
    const from = big.starts[ids[k]];
    const buf = new Uint8Array(await big.file.slice(from, big.ends[ids[j]]).arrayBuffer());
    for (let q = k; q <= j; q++) {
      const i = ids[q];
      const text = decode(trimEol(buf.subarray(big.starts[i] - from, big.ends[i] - from)));
      const fields = B.parseCsvRecord(text, big.delim), c = big.cfg;
      rows.push({ i, raw: B.rawOf(fields, c), error: big.errors.get(i) || "", cells: c.mode === "one" ? [ fields[c.one] ] : [ fields[c.lat], fields[c.lon] ] });
    }
    k = j + 1;
  }
  postMessage({ type: "window", job: m.job, rows });
}

// The same file again, every line kept as it was, with the new columns on the end.
async function exportCsv(m) {
  if (!big) return postMessage({ type: "exported", job: m.job, blob: null });
  needProj(m.f.grid ? m.gridSpec : "off");
  const d = big.delim, grid = m.f.grid ? B.gridCells(m.gridSpec) : null;
  const names = B.outCols({ empty: true }, m.f, grid).map(c => c[0]);
  const blobs = [];
  let parts = [ "﻿" ], size = 0, header = false, i = 0;
  const flush = () => {
    blobs.push(new Blob([ parts.join("") ], { type: "text/csv;charset=utf-8" }));
    parts = [];
    size = 0;
  };
  const add = (text, cells, fields) => {
    const line = text + d.repeat(Math.max(0, big.maxFields - fields)) + (cells ? d + cells.map(c => B.csvCell(c, d)).join(d) : "") + "\n";
    parts.push(line);
    size += line.length;
    if (size > 4e6) flush();
  };
  await eachRecord(big.file, (text, start) => {
    if (!text.trim()) return add(text, null, big.maxFields);
    const fields = B.parseCsvRecord(text, d).length;
    if (!header) {
      header = true;
      return add(text, names, fields);
    }
    if (i < big.starts.length && big.starts[i] === start) {
      const st = big.status[i];
      const res = st === B.EMPTY ? { empty: true } : st === B.OK ? { lat: big.lat[i], lon: big.lon[i], check: big.checks.get(i) } : rowRepair(i);
      add(text, B.outCols(res, m.f, grid).map(c => c[1]), fields);
      i++;
    } else {
      add(text, null, fields);
    }
  }, bytes => postMessage({ type: "progress", job: m.job, done: bytes, total: big.file.size, rows: i }));
  flush();
  postMessage({ type: "exported", job: m.job, blob: new Blob(blobs, { type: "text/csv;charset=utf-8" }) });
}

// The converted rows as points, each with its original columns and the new ones.
async function exportGeo(m) {
  if (!big) return postMessage({ type: "exported", job: m.job, blob: null });
  needProj(m.f.grid ? m.gridSpec : "off");
  const G = self.CordifyGeoIO, d = big.delim, grid = m.f.grid ? B.gridCells(m.gridSpec) : null;
  const added = B.outCols({ empty: true }, m.f, grid).filter(c => c[0] !== "Convert_Status").map(c => c[0]);
  const isPkg = m.format === "gpkg";
  let pkg = null, tb = null, w = null;
  if (isPkg) {
    importScripts(m.sqlJs + "sql-wasm.js");
    pkg = G.gpkg(await self.initSqlJs({ locateFile: f => m.sqlJs + f }));
  } else {
    w = G.textWriter(m.format, m.title || "Cordify");
  }
  const blobs = [];
  let parts = w ? [ w.head ] : [], size = 0, head = null, nameCol = -1, i = 0;
  const flush = () => {
    blobs.push(new Blob([ parts.join("") ]));
    parts = [];
    size = 0;
  };
  await eachRecord(big.file, (text, start) => {
    if (!text.trim()) return;
    if (!head) {
      head = B.parseCsvRecord(text, d).map((c, j) => c.replace(/\s+/g, " ").trim() || `Column ${j + 1}`);
      nameCol = head.findIndex(h => G.NAME_KEY.test(h));
      if (isPkg) tb = pkg.table(m.title, head.map(h => ({ name: h, type: "TEXT" })).concat(added.map(n => ({ name: n, type: G.NUMERIC.test(n) ? "DOUBLE" : "TEXT" }))));
      return;
    }
    if (i >= big.starts.length || big.starts[i] !== start) return;
    const k = i++;
    const fixed = big.status[k] !== B.OK && big.repaired ? big.repaired.get(k) : null;
    if (big.status[k] !== B.OK && !fixed) return;
    const fields = B.parseCsvRecord(text, d);
    const res = fixed ? { ...fixed } : { lat: big.lat[k], lon: big.lon[k], check: big.checks.get(k) };
    const cols = B.outCols(res, m.f, grid).filter(c => c[0] !== "Convert_Status");
    if (isPkg) {
      tb.point(res.lat, res.lon, head.map((h, j) => fields[j]).concat(cols.map(c => c[1])));
      return;
    }
    const name = nameCol >= 0 && (fields[nameCol] || "").trim() ? fields[nameCol] : `Row ${big.recNo[k]}`;
    const s = w.point(name, res.lat, res.lon, head.map((h, j) => [ h, fields[j] ]).concat(cols));
    parts.push(s);
    size += s.length;
    if (size > 4e6) flush();
  }, bytes => postMessage({ type: "progress", job: m.job, done: bytes, total: big.file.size, rows: i }));
  if (isPkg) {
    postMessage({ type: "exported", job: m.job, ext: "gpkg", blob: new Blob([ pkg.finish() ], { type: "application/geopackage+sqlite3" }) });
    return;
  }
  parts.push(w.tail);
  flush();
  postMessage({ type: "exported", job: m.job, ext: w.ext, blob: new Blob(blobs, { type: w.mime }) });
}

// A row that did not convert: its repair if there is one, else the reason (and why Repair could not help).
function rowRepair(i) {
  const fixed = big.repaired && big.repaired.get(i);
  if (fixed) return { ...fixed };
  const note = big.repairNotes && big.repairNotes.get(i);
  return { error: (big.errors.get(i) || "") + (note ? `; Repair: ${note}` : "") };
}

self.onmessage = e => {
  const m = e.data;
  const fail = err => postMessage({ type: "error", job: m.job, message: String(err && err.message || err) });
  try {
    if (m.type === "columns") convertColumns(m);
    else if (m.type === "csv") convertCsv(m).catch(fail);
    else if (m.type === "window") rowsWindow(m).catch(fail);
    else if (m.type === "export") exportCsv(m).catch(fail);
    else if (m.type === "exportGeo") exportGeo(m).catch(fail);
    else if (m.type === "repaired") {
      if (big) {
        big.repaired = new Map(m.entries);
        big.repairNotes = new Map(m.notes);
      }
      postMessage({ type: "ok", job: m.job });
    }
  } catch (err) {
    fail(err);
  }
};
