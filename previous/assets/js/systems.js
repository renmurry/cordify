/*
 * Cordify — Coordinate systems other than latitude/longitude in degrees
 * Recognises a sheet typed in UTM (with or without the zone), MGRS, Web Mercator
 * metres, radians, or with latitude and longitude swapped, and reads it. Also shifts
 * values from an older datum (Everest / Kalianpur) to WGS 84.
 *
 * A system is decided for a whole column, never from one cell: 0.45, 1.65 may be a
 * real place. A UTM zone that is not written anywhere is found from where the points
 * must be (a boundary, village locations, or points already converted). Nothing is
 * read in another system until the user says yes. No UI; also runs in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"));
  } else {
    root.CordifySystems = factory(root.CordifyCore);
  }
})(typeof self !== "undefined" ? self : this, function (C) {
  "use strict";

  const RAD = 180 / Math.PI;

  /* ---------- UTM ---------- */

  // UTM -> WGS 84 by the Krüger series (to n³: better than a millimetre inside a zone).
  function utmInverse(e, n, zone, south) {
    const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
    const nn = f / (2 - f), A = a / (1 + nn) * (1 + nn * nn / 4 + Math.pow(nn, 4) / 64);
    const beta = [ nn / 2 - 2 * nn * nn / 3 + 37 * nn ** 3 / 96, nn * nn / 48 + nn ** 3 / 15, 17 * nn ** 3 / 480 ];
    const delta = [ 2 * nn - 2 * nn * nn / 3 - 2 * nn ** 3, 7 * nn * nn / 3 - 8 * nn ** 3 / 5, 56 * nn ** 3 / 15 ];
    const xi = (n - (south ? 1e7 : 0)) / (k0 * A), eta = (e - 500000) / (k0 * A);
    let xp = xi, ep = eta;
    beta.forEach((b, i) => {
      const j = 2 * (i + 1);
      xp -= b * Math.sin(j * xi) * Math.cosh(j * eta);
      ep -= b * Math.cos(j * xi) * Math.sinh(j * eta);
    });
    const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
    let phi = chi;
    delta.forEach((d, i) => { phi += d * Math.sin(2 * (i + 1) * chi); });
    const lon0 = zone * 6 - 183;
    const lon = lon0 + Math.atan2(Math.sinh(ep), Math.cos(xp)) * RAD;
    return { lat: phi * RAD, lon: ((lon + 540) % 360) - 180 };
  }

  /* ---------- MGRS ---------- */

  const BANDS = "CDEFGHJKLMNPQRSTUVWX";
  const BAND_MIN_N = { C: 1100000, D: 2000000, E: 2800000, F: 3700000, G: 4600000, H: 5500000, J: 6400000, K: 7300000, L: 8200000, M: 9100000,
    N: 0, P: 800000, Q: 1700000, R: 2600000, S: 3500000, T: 4400000, U: 5300000, V: 6200000, W: 7000000, X: 7900000 };
  const COL_ORIGIN = "AJSAJS", ROW_ORIGIN = "AFAFAF";
  const skipIO = c => c === 73 || c === 79;   // I, O are never used

  // Steps through the letters from an origin, skipping I and O, wrapping at the last one.
  function stepLetters(origin, steps, last) {
    let c = origin.charCodeAt(0);
    for (let k = 0; k < steps; k++) {
      c++;
      if (skipIO(c)) c++;
      if (skipIO(c)) c++;
      if (c > last.charCodeAt(0)) c = 65;
    }
    return String.fromCharCode(c);
  }
  function lettersBetween(origin, target, last) {
    for (let k = 0; k < 26; k++) if (stepLetters(origin, k, last) === target) return k;
    return -1;
  }

  // "46RFQ8455756045" or "46R FQ 84557 56045" -> { zone, south, e, n } or null
  const MGRS = /^\s*(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*(\d{1,5})\s*(\d{0,5})\s*$/i;
  function mgrsToUtm(text) {
    const m = String(text ?? "").match(MGRS);
    if (!m) return null;
    const zone = +m[1], band = m[2].toUpperCase(), col = m[3].toUpperCase(), row = m[4].toUpperCase();
    let digits = m[5] + m[6];
    if (zone < 1 || zone > 60 || digits.length % 2) return null;
    const half = digits.length / 2, unit = Math.pow(10, 5 - half);
    const set = (zone - 1) % 6;
    const ci = lettersBetween(COL_ORIGIN[set], col, "Z");
    const ri = lettersBetween(ROW_ORIGIN[set], row, "V");
    if (ci < 0 || ri < 0 || ci > 7) return null;
    let n100 = ri * 100000;
    while (n100 < BAND_MIN_N[band]) n100 += 2000000;
    return { zone, south: band < "N", e: (ci + 1) * 100000 + (+digits.slice(0, half) || 0) * unit, n: n100 + (+digits.slice(half) || 0) * unit };
  }

  // WGS 84 -> MGRS text at 1 m ("46RFQ8455756045"). Used to check the reading in tests.
  function toMgrs(lat, lon) {
    const zone = C.utmZone(lat, lon), u = C.utmForward(lat, lon, zone, lat < 0);
    const set = (zone - 1) % 6;
    const band = BANDS[Math.max(0, Math.min(19, Math.floor((lat + 80) / 8)))];
    const col = stepLetters(COL_ORIGIN[set], Math.floor(u.e / 100000) - 1, "Z");
    const row = stepLetters(ROW_ORIGIN[set], Math.floor(u.n / 100000) % 20, "V");
    const pad = v => String(Math.floor(v % 100000)).padStart(5, "0");
    return `${zone}${band}${col}${row}${pad(u.e)}${pad(u.n)}`;
  }

  /* ---------- one cell ---------- */

  // "46R 684557 2856045", "Zone 46N 684557mE 2856045mN" -> { zone, south, e, n }
  const UTM_CELL = /^\s*(?:utm\s*)?(?:zone\s*)?(\d{1,2})\s*([C-HJ-NP-X]|north|south)?\b[\s,;:]*(\d{5,7}(?:\.\d+)?)\s*(?:m\s*)?E?\b[\s,;]*(\d{6,8}(?:\.\d+)?)\s*(?:m\s*)?N?\s*$/i;
  function utmCell(text) {
    const m = String(text ?? "").match(UTM_CELL);
    if (!m) return null;
    const zone = +m[1];
    if (zone < 1 || zone > 60) return null;
    const e = +m[3], n = +m[4];
    let south = false;
    const l = (m[2] || "").toUpperCase();
    if (l === "SOUTH") south = true;
    else if (l === "S") {
      // S is a southern hemisphere, or latitude band S (32° to 40° N): the northing says which.
      const asBand = utmInverse(e, n, zone, false);
      south = !(asBand.lat >= 32 && asBand.lat < 40);
    } else if (l && l !== "NORTH" && l !== "N") south = l < "N";
    return { zone, south, e, n };
  }

  // Any cell with its own zone: UTM or MGRS -> { lat, lon, how } or null
  function readCell(text, datum) {
    const u = utmCell(text), g = u ? null : mgrsToUtm(text);
    const p = u || g;
    if (!p) return null;
    const r = gridInverse(p.e, p.n, p.zone, p.south, datum);
    if (!valid(r.lat, r.lon)) return null;
    return { ...r, how: `${g ? "MGRS" : "UTM"} zone ${p.zone}${p.south ? "S" : "N"}` };
  }

  // UTM metres -> WGS 84 latitude/longitude. Metres measured on another datum also use that
  // datum's ellipsoid, so they go through the projection library in one step (shifted: true).
  function gridInverse(e, n, zone, south, datum) {
    const d = datum && DATUMS[datum];
    if (!d || !d.def) return utmInverse(e, n, zone, south);
    const P = getProj4();
    if (!P) return { lat: NaN, lon: NaN };
    const [ x, y ] = P(d.def.replace("+proj=longlat", `+proj=utm +zone=${zone}${south ? " +south" : ""} +units=m`), "WGS84", [ e, n ]);
    return { lat: y, lon: x, shifted: true };
  }

  /* ---------- whole sheets ---------- */

  const R_MERC = 6378137;
  const merc = (x, y) => ({ lon: x / R_MERC * RAD, lat: (2 * Math.atan(Math.exp(y / R_MERC)) - Math.PI / 2) * RAD });
  const valid = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const plain = v => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const t = String(v ?? "").trim().replace(/\s*m[EN]?$/i, "").replace(/,(?=\d{3}(\D|$))/g, "");
    return /^[+-]?\d+(\.\d+)?$/.test(t) ? +t : null;
  };
  // The two plain numbers of a row: two cells, or one cell holding exactly two.
  function numbersOf(cells) {
    if (cells.length === 2) {
      const a = plain(cells[0]), b = plain(cells[1]);
      return a === null || b === null ? null : [ a, b ];
    }
    const t = String(cells[0] ?? "");
    if (/[°ᵒº˚'’′"”″A-DF-MO-RT-VX-Z]/i.test(t.replace(/\b(m|mE|mN|E|N)\b/g, ""))) return null;
    const nums = t.match(/[+-]?\d+(?:\.\d+)?/g);
    return nums && nums.length === 2 ? nums.map(Number) : null;
  }

  const LABEL = {
    utm: s => `UTM zone ${s.zone}${s.south ? "S" : "N"}`, mercator: () => "Web Mercator metres (EPSG:3857)", cell: () => "UTM / MGRS with the zone in each cell",
    radians: () => "radians", swap: () => "longitude first (swapped)"
  };
  const labelOf = s => LABEL[s.kind] ? LABEL[s.kind](s) : s.kind;

  /*
   * read(cells, system, twoColumns) -> { lat, lon } or { error }
   * cells: [one cell] or [latitude-or-northing cell, longitude-or-easting cell].
   */
  function read(cells, system, datum) {
    const two = cells.length === 2;
    if (system.kind === "cell") {
      const r = readCell(cells.join(" "), datum);
      return r ? r : { error: "not UTM or MGRS with a zone (for example 46R 684557 2856045)" };
    }
    if (system.kind === "swap") {
      // The longitude was typed first: in the latitude column, or first in the cell.
      let a, b;
      if (two) [ a, b ] = [ cells[1], cells[0] ];
      else {
        const p = C.splitPair(String(cells[0]));
        if (!p) return { error: "could not find two values" };
        [ a, b ] = [ p[1], p[0] ];
      }
      const lat = C.parseCoord(String(a), "lat"), lon = C.parseCoord(String(b), "lon");
      return lat === null || lon === null ? { error: "does not read with the longitude first either" } : { lat, lon };
    }
    const nums = numbersOf(cells);
    if (!nums) return { error: "expected two plain numbers" };
    // Two columns are given as [northing/y/latitude, easting/x/longitude]; one cell as "easting, northing"
    // for grids and "latitude, longitude" for radians.
    let r;
    if (system.kind === "plain") {
      r = { lat: nums[0], lon: nums[1] };
    } else if (system.kind === "radians") {
      const [ la, lo ] = nums;
      r = { lat: la * RAD, lon: lo * RAD };
    } else {
      // Grid metres are large; a value like 26.9, 95.1 is degrees typed into a grid sheet.
      if (system.kind === "utm" && (Math.abs(nums[0]) < 1000 || Math.abs(nums[1]) < 1000)) return { error: "too small for metres; this looks like degrees" };
      const [ e, n ] = two ? [ nums[1], nums[0] ] : eastingFirst(nums);
      r = system.kind === "mercator" ? merc(e, n) : gridInverse(e, n, system.zone, system.south, datum);
    }
    return valid(r.lat, r.lon) ? r : { error: `outside the world when read as ${labelOf(system)}` };
  }
  // "684557, 2856045" or "2856045, 684557": the UTM easting is the one between 100 000 and 900 000.
  function eastingFirst(nums) {
    const inE = v => v >= 100000 && v <= 900000;
    return inE(nums[1]) && !inE(nums[0]) ? [ nums[1], nums[0] ] : nums;
  }

  /*
   * detect(rows, ref, opts) -> null or a suggestion { system, label, why, sure, choices? }
   * rows: [{ cells: [...] }] sampled from one sheet (all one cell, or all two cells).
   * ref:  { inside(lat, lon) -> bool } and/or { near(lat, lon) -> bool }: where the points must be.
   * opts: { swapped: share of rows reported as swapped, head: column names }
   */
  function detect(rows, ref, opts = {}) {
    const n = rows.length;
    if (!n) return null;
    const head = (opts.head || []).join(" ");
    // 1. The zone is in each cell (UTM with zone, MGRS).
    const withZone = rows.filter(r => readCell(r.cells.join(" "))).length;
    if (withZone >= Math.max(2, 0.6 * n)) {
      return { system: { kind: "cell" }, label: labelOf({ kind: "cell" }), why: `${withZone} of ${n} rows give a UTM zone or an MGRS square`, sure: true };
    }
    const pairs = rows.map(r => numbersOf(r.cells)).filter(Boolean);
    // How well a reading fits: the share of rows landing where the points must be.
    const fit = sys => {
      if (!ref) return null;
      let ok = 0, tried = 0;
      for (const r of rows) {
        const p = read(r.cells, sys);
        if (p.error) continue;
        tried++;
        if ((ref.inside && ref.inside(p.lat, p.lon)) || (ref.near && ref.near(p.lat, p.lon))) ok++;
      }
      return tried ? ok / n : 0;
    };
    // 2. Grid metres
    const big = pairs.filter(([ a, b ]) => Math.abs(a) >= 1000 && Math.abs(b) >= 1000).length;
    if (big >= Math.max(2, 0.6 * n)) {
      const twoCols = rows[0].cells.length === 2;
      const zoneInHead = head.match(/\bzone\s*(\d{1,2})\s*([NS])?\b|\butm\s*(\d{1,2})\s*([NS])?\b|\b(\d{1,2})\s*([NS])\b/i);
      const choices = [ { kind: "mercator" } ];
      for (let z = 1; z <= 60; z++) choices.push({ kind: "utm", zone: z, south: false }, { kind: "utm", zone: z, south: true });
      if (zoneInHead) {
        const z = +(zoneInHead[1] || zoneInHead[3] || zoneInHead[5]), s = /s/i.test(zoneInHead[2] || zoneInHead[4] || zoneInHead[6] || "");
        if (z >= 1 && z <= 60) {
          const sys = { kind: "utm", zone: z, south: s };
          return { system: sys, label: labelOf(sys), why: "the zone is in the column name", sure: true, choices };
        }
      }
      if (ref) {
        const scored = choices.map(sys => ({ sys, f: fit(sys) })).filter(x => x.f > 0).sort((a, b) => b.f - a.f);
        if (scored.length && scored[0].f >= 0.5 && (scored.length === 1 || scored[1].f < scored[0].f * 0.5)) {
          const best = scored[0];
          return { system: best.sys, label: labelOf(best.sys), why: `the only one of 121 systems that puts ${Math.round(best.f * 100)}% of the rows ${ref.inside ? "inside your boundary" : "near your other points"}`, sure: true, choices };
        }
      }
      return { system: null, label: "grid coordinates in metres", why: `${big} of ${n} rows are two numbers of a thousand or more${twoCols ? "" : ""}: these are metres, not degrees. Pick the system they were written in`, sure: false, choices };
    }
    // 3. Radians: every number within ±π, written with several decimals.
    const radianLike = pairs.filter(([ a, b ]) => Math.abs(a) <= Math.PI / 2 && Math.abs(b) <= Math.PI && /\.\d{3,}/.test(String(a) + String(b))).length;
    if (pairs.length >= 3 && radianLike === pairs.length && radianLike >= 0.8 * n) {
      const sys = { kind: "radians" };
      const fr = fit(sys), fd = fit({ kind: "plain" });
      if (ref && fr >= 0.5) return { system: sys, label: labelOf(sys), why: `read as radians, ${Math.round(fr * 100)}% of the rows land ${ref.inside ? "inside your boundary" : "near your other points"}`, sure: true };
      if (!ref || fd === 0) return { system: sys, label: labelOf(sys), why: "every value is under 3.15 (π) with several decimals; as degrees they would all sit near 0° N, 0° E", sure: false };
    }
    // 4. Swapped: most rows only read the other way round.
    if ((opts.swapped || 0) >= 0.5) {
      return { system: { kind: "swap" }, label: labelOf({ kind: "swap" }), why: `${Math.round(opts.swapped * 100)}% of the rows only read with the first value as the longitude`, sure: true };
    }
    return null;
  }

  /* ---------- datums ---------- */

  const DATUMS = {
    wgs84: { label: "WGS 84 (GPS, Google Earth)" },
    kalianpur1937: { label: "Everest / Kalianpur 1937 (older Survey of India maps)", def: "+proj=longlat +a=6377276.345 +rf=300.8017 +towgs84=282,726,254 +no_defs" },
    kalianpur1975: { label: "Everest / Kalianpur 1975 (Indian 1975)", def: "+proj=longlat +a=6377299.151 +rf=300.8017255 +towgs84=295,736,257 +no_defs" }
  };
  const getProj4 = () => (typeof proj4 !== "undefined" ? proj4 : (typeof self !== "undefined" && self.proj4) || null);
  // Latitude/longitude on another datum -> WGS 84 (three-parameter shift: good to about 10–20 m).
  function toWgs84(lat, lon, datum) {
    const d = DATUMS[datum];
    if (!d || !d.def) return { lat, lon };
    const P = getProj4();
    if (!P) return { error: "the projection library did not load" };
    const [ x, y ] = P(d.def, "WGS84", [ lon, lat ]);
    return valid(y, x) ? { lat: y, lon: x } : { error: "could not shift the datum" };
  }

  return { utmInverse, mgrsToUtm, toMgrs, utmCell, readCell, read, detect, labelOf, toWgs84, DATUMS, numbersOf };
});
