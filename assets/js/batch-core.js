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
    module.exports = factory(require("./core.js"), require("./repair-engine.js"), require("./pinpoint.js"));
  } else {
    root.CordifyBatchCore = factory(root.CordifyCore, root.CordifyRepair, root.CordifyPinpoint);
  }
})(typeof self !== "undefined" ? self : this, function (C, R, P) {
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

  // How finely one typed value was given, in metres on the ground: the size of its
  // last digit. 25.811 -> 111 m; 26°41.451' -> 2 m; 26°55'24.3" -> 3 m.
  const UNIT_M = [ 111320, 1855.3, 30.92 ];   // one degree, minute, second of latitude
  function precisionOf(text) {
    const nums = String(text ?? "").match(/\d+(?:\.\d+)?/g);
    if (!nums) return NaN;
    const k = Math.min(nums.length, 3);
    const dec = (nums[k - 1].split(".")[1] || "").length;
    return UNIT_M[k - 1] * Math.pow(10, -dec);
  }

  // One value (latitude or longitude) from its own cell.
  function readOne(text, role) {
    const c = R.cleanText(text);
    const bad = changesValue(c.notes);
    if (bad.length) return { error: `looks mistyped (${bad.join(", ")})`, mistyped: true };
    const v = C.parseCoord(c.text, role);
    if (v !== null) return { value: v, precision: precisionOf(c.text) };
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
    if (lat !== null && lon !== null) return { lat, lon, precision: Math.max(precisionOf(a.text), precisionOf(b.text)) };
    if (!role(a) && !role(b) && C.parseCoord(str(b), "lat") !== null && C.parseCoord(str(a), "lon") !== null) {
      return { error: "latitude and longitude look swapped (longitude first)", mistyped: true };
    }
    return { error: NOT_VALID(lat === null ? "latitude" : "longitude"), mistyped: true };
  }

  // A value that could not be read: say which character is wrong, when that can be found.
  // Missing values and swapped columns keep their own message.
  function pinned(res, text, role) {
    if (res.error === undefined || !P || /swapped|missing|no numbers/.test(res.error)) return res;
    const r = P.explain(text, role);
    if (r.errors) res.error = (role ? `${role === "lat" ? "latitude" : "longitude"} cell, ` : "") + r.summary;
    return res;
  }

  function readRow(r, cfg) {
    if (cfg.mode === "one") {
      if (BLANK(r[cfg.one])) return { empty: true };
      return pinned(readPair(String(r[cfg.one])), String(r[cfg.one]));
    }
    const a = r[cfg.lat], b = r[cfg.lon];
    if (BLANK(a) && BLANK(b)) return { empty: true };
    if (BLANK(a) || BLANK(b)) return { error: BLANK(a) ? "latitude is missing" : "longitude is missing" };
    const la = readOne(String(a), "lat"), lo = readOne(String(b), "lon");
    if (la.value !== undefined && lo.value !== undefined) return { lat: la.value, lon: lo.value, precision: Math.max(la.precision, lo.precision) };
    // Swapped columns?
    const sa = readOne(String(b), "lat"), so = readOne(String(a), "lon");
    if (sa.value !== undefined && so.value !== undefined) return { error: "latitude and longitude look swapped (columns the wrong way round?)", mistyped: true };
    return pinned({ error: la.error || lo.error, mistyped: la.mistyped || lo.mistyped }, String(la.error ? a : b), la.error ? "lat" : "lon");
  }

  const statusOf = res => res.empty ? EMPTY : res.lat !== undefined ? OK : res.mistyped ? MISTYPED : FAILED;
  // The original coordinate text of a row, as shown in the preview.
  const rawOf = (r, cfg) => cfg.mode === "one" ? String(r[cfg.one] ?? "") : `${r[cfg.lat] ?? ""}  |  ${r[cfg.lon] ?? ""}`;

  /* ---------- rows that converted but deserve a second look ---------- */

  const OUTLIER_MIN_KM = 25;      // never call a point "far" if it is closer than this
  const OUTLIER_SPREAD = 6;       // ...or closer than this many times the typical distance
  const COARSE_M = 50;            // values given more coarsely than this are flagged

  const nice = m => m >= 1000 ? `${+(m / 1000).toPrecision(1)} km` : `${+m.toPrecision(1)} m`;
  function kmBetween(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }
  const medianOf = a => {
    const s = Float64Array.from(a).sort(), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /*
   * Converted rows that are worth checking, without changing any value:
   *   far       much further from the middle of the sheet's points than the rest (often a mistyped digit)
   *   duplicate exactly the same position as another row
   *   coarse    typed too roughly to place a point well (3 decimals of a degree is about 100 m)
   * lat, lon, status, precision: one entry per row (typed arrays are fine); rowNo: the row
   * number to show for each. Returns Map(row index -> "reason; reason").
   * When most of the sheet is typed coarsely, that is one fact about the sheet, not a reason
   * to mark every row: the Map then carries .coarse (the typical size, in metres) and only
   * rows much coarser than the rest are marked.
   */
  function qualityChecks(lat, lon, status, precision, rowNo) {
    const out = new Map();
    const add = (i, text) => out.set(i, out.has(i) ? `${out.get(i)}; ${text}` : text);
    const ok = [];
    for (let i = 0; i < status.length; i++) if (status[i] === OK) ok.push(i);
    if (ok.length >= 5) {
      const cLat = medianOf(ok.map(i => lat[i])), cLon = medianOf(ok.map(i => lon[i]));
      const d = ok.map(i => kmBetween(lat[i], lon[i], cLat, cLon));
      const limit = Math.max(OUTLIER_MIN_KM, OUTLIER_SPREAD * medianOf(d));
      ok.forEach((i, k) => {
        if (d[k] > limit) add(i, `far from the other points: about ${Math.round(d[k])} km from the middle of this sheet`);
      });
    }
    const seen = new Map();
    for (const i of ok) {
      const key = `${lat[i].toFixed(7)},${lon[i].toFixed(7)}`;
      if (seen.has(key)) add(i, `same position as row ${rowNo[seen.get(key)]}`);
      else seen.set(key, i);
    }
    if (precision) {
      const known = ok.filter(i => precision[i] > 0);
      const typical = known.length ? medianOf(known.map(i => precision[i])) : 0;
      if (typical > COARSE_M) out.coarse = typical;
      // 20 times rougher than the rest: two digits fewer, not one. Excel stores 25.810 as the
      // number 25.81, so one digit fewer than the rest of the sheet is usually a dropped zero.
      const limit = Math.max(COARSE_M, typical * 20);
      for (const i of known) if (precision[i] > limit) add(i, `low precision: typed to about ${nice(precision[i])}`);
    }
    return out;
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
    // res.repaired: "fixed" (one clear reading) or "check" (best guess) when Repair rebuilt a mistyped value
    const done = res.repaired === "fixed" ? "Repaired - check" : res.repaired ? "Best guess - check" : res.check ? "OK - check" : "OK";
    cols.push([ "Convert_Status", res.empty ? "Empty" : ok ? done : "Not converted: " + res.error ],
      [ "Convert_Check", ok && res.check ? res.check : "" ]);
    return cols;
  }
  // The two columns that describe a row rather than hold a value.
  const STATUS_COLS = new Set([ "Convert_Status", "Convert_Check" ]);
  // How a row is coloured in Excel: converted, converted but worth checking, not converted.
  const kindOf = res => res.empty ? null : res.lat === undefined ? "bad" : res.repaired === "fixed" ? "fixed" : res.repaired || res.check ? "check" : "ok";

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
    precisionOf, qualityChecks, STATUS_COLS, kindOf, nice,
    parseCsvRecord, splitCsvRecords, sniffDelimiter, csvCell, recordEnds, outCols, gridCells
  };
});
