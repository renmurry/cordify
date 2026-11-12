/*
 * Cordify — Batch convert, the part with no screen
 * Reads a row's coordinate cell(s), finds the coordinate column(s), and reads and
 * writes CSV. Used on the page (batch.js, sheet.js), inside the background worker
 * (batch-worker.js) and in Node tests.
 *
 * It never guesses: values that look mistyped are reported, with the reason.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"), require("./repair-engine.js"));
  } else {
    root.CordifyBatchCore = factory(root.CordifyCore, root.CordifyRepair);
  }
})(typeof self !== "undefined" ? self : this, function (C, R) {
  "use strict";

  // Row results, small enough to hold millions of them in a typed array.
  const EMPTY = 0, OK = 1, FAILED = 2, MISTYPED = 3;

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
    const c = R.cleanText(text);
    const bad = changesValue(c.notes);
    if (bad.length) return { error: `looks mistyped (${bad.join(", ")})`, mistyped: true };
    const v = C.parseCoord(c.text, role);
    if (v !== null) return { value: v };
    const which = role === "lat" ? "latitude" : "longitude";
    return /\d/.test(c.text) ? { error: NOT_VALID(which), mistyped: true } : { error: `${which} has no numbers` };
  }

  // A whole pair from one cell: "26.92, 95.03", "26°55'7" N, 95°4'43.6" E, 120m", "N 26 34 56 E 77 35 12"...
  function readPair(text) {
    const s = R.splitCell(text);
    if (s.empty) return { empty: true };
    const bad = changesValue(s.notes);
    if (bad.length) return { error: `looks mistyped (${bad.join(", ")})`, mistyped: true };
    if (s.problem || s.parts.length !== 2) return { error: s.problem || "could not find two values (latitude and longitude)" };
    let [ a, b ] = s.parts;
    const role = p => p.hemi === "N" || p.hemi === "S" ? "lat" : p.hemi === "E" || p.hemi === "W" ? "lon" : null;
    if (role(a) === "lon" && role(b) === "lat") [ a, b ] = [ b, a ];   // "E 94.8, N 26.2": letters decide
    const str = p => p.hemi ? `${p.text} ${p.hemi}` : p.text;
    const lat = C.parseCoord(str(a), "lat"), lon = C.parseCoord(str(b), "lon");
    if (lat !== null && lon !== null) return { lat, lon };
    if (!role(a) && !role(b) && C.parseCoord(str(b), "lat") !== null && C.parseCoord(str(a), "lon") !== null) {
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

  const statusOf = res => res.empty ? EMPTY : res.lat !== undefined ? OK : res.mistyped ? MISTYPED : FAILED;
  // The original coordinate text of a row, as shown in the preview.
  const rawOf = (r, cfg) => cfg.mode === "one" ? String(r[cfg.one] ?? "") : `${r[cfg.lat] ?? ""}  |  ${r[cfg.lon] ?? ""}`;

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

  /* ---------- CSV ---------- */

  // One record (a line, which may hold line breaks inside quotes) -> its fields.
  function parseCsvRecord(line, delim = ",") {
    const out = [];
    let i = 0;
    const n = line.length;
    while (i <= n) {
      if (line[i] === '"') {
        let j = i + 1, cell = "";
        for (;;) {
          const q = line.indexOf('"', j);
          if (q < 0) { cell += line.slice(j); j = n; break; }
          cell += line.slice(j, q);
          if (line[q + 1] === '"') { cell += '"'; j = q + 2; }
          else { j = q + 1; break; }
        }
        const next = line.indexOf(delim, j);
        if (next < 0) { out.push(cell + line.slice(j)); break; }
        out.push(cell + line.slice(j, next));
        i = next + 1;
      } else {
        const next = line.indexOf(delim, i);
        if (next < 0) { out.push(line.slice(i)); break; }
        out.push(line.slice(i, next));
        i = next + 1;
      }
    }
    return out;
  }

  // Text -> records, splitting on line breaks that are not inside quotes.
  function splitCsvRecords(text) {
    const out = [];
    let start = 0, quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 34) quoted = !quoted;
      else if (ch === 10 && !quoted) {
        out.push(text.slice(start, text.charCodeAt(i - 1) === 13 ? i - 1 : i));
        start = i + 1;
      }
    }
    if (start < text.length) out.push(text.slice(start).replace(/\r$/, ""));
    return out;
  }

  // Comma, semicolon or tab: whichever splits the first lines into the most (and equal) columns.
  function sniffDelimiter(text) {
    const lines = splitCsvRecords(text).filter(l => l.trim()).slice(0, 10);
    let best = ",", bestScore = 0;
    // On a tie the semicolon wins: such files usually use the comma as the decimal point.
    for (const d of [ ";", "\t", "," ]) {
      const counts = lines.map(l => parseCsvRecord(l, d).length);
      const first = counts[0] || 1;
      const same = counts.filter(c => c === first).length;
      const score = first > 1 ? first * same : 0;
      if (score > bestScore) { best = d; bestScore = score; }
    }
    return best;
  }

  function csvCell(v, delim = ",") {
    const t = v == null ? "" : String(v);
    return t.includes('"') || t.includes(delim) || t.includes("\n") || t.includes("\r") ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  /*
   * Finds where records end in raw bytes, so a file of any size can be read a piece at
   * a time. Works for UTF-8 and Windows-1252, where a quote is always byte 34 and a
   * line break always byte 10. Feed it chunks in order; `quoted` carries over.
   * Returns the byte positions just after each record's line break.
   */
  function recordEnds(bytes, state) {
    const ends = [];
    let quoted = state.quoted;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 34) quoted = !quoted;
      else if (b === 10 && !quoted) ends.push(i + 1);
    }
    state.quoted = quoted;
    return ends;
  }

  /* ---------- output columns ---------- */

  // The new cells for one row, as [ header, value ] pairs. `grid(lat, lon)` gives the
  // Easting/Northing cells when a grid system is chosen.
  function outCols(res, f, grid) {
    const ok = res.lat !== undefined;
    const cols = [];
    if (f.dd) cols.push([ "Lat_DD", ok ? C.formatDD(res.lat, f.ddDigits) : "" ], [ "Lon_DD", ok ? C.formatDD(res.lon, f.ddDigits) : "" ]);
    if (f.dms) cols.push([ "Lat_DMS", ok ? C.formatDMS(res.lat, "lat", f.secDigits) : "" ], [ "Lon_DMS", ok ? C.formatDMS(res.lon, "lon", f.secDigits) : "" ]);
    if (f.ddm) cols.push([ "Lat_DDM", ok ? C.formatDDM(res.lat, "lat", f.minDigits) : "" ], [ "Lon_DDM", ok ? C.formatDDM(res.lon, "lon", f.minDigits) : "" ]);
    if (f.grid && grid) cols.push(...grid(ok ? res.lat : null, ok ? res.lon : null));
    cols.push([ "Convert_Status", res.empty ? "Empty" : ok ? "OK" : "Not converted: " + res.error ]);
    return cols;
  }

  // Grid cells from a system spec (see core.js project): what grid.js does on the page.
  function gridCells(spec) {
    return (lat, lon) => {
      const p = lat == null || lon == null ? null : C.project(lat, lon, spec);
      if (!p) return [ [ "Easting", "" ], [ "Northing", "" ], [ "Grid", "" ] ];
      if (p.error) return [ [ "Easting", "" ], [ "Northing", "" ], [ "Grid", p.error ] ];
      return [ [ "Easting", C.formatGrid(p.e) ], [ "Northing", C.formatGrid(p.n) ], [ "Grid", p.label + (p.epsg ? ` (EPSG:${p.epsg})` : "") ] ];
    };
  }

  return {
    EMPTY, OK, FAILED, MISTYPED, BLANK, readOne, readPair, readRow, statusOf, rawOf, detect,
    parseCsvRecord, splitCsvRecords, sniffDelimiter, csvCell, recordEnds, outCols, gridCells
  };
});
