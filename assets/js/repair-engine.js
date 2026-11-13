/*
 * Cordify repair engine
 * Rebuilds malformed latitude/longitude text using a boundary polygon as the
 * constraint. Works for any area in the world (WGS84 lat/lon).
 *
 * Idea: every coordinate is a string of digits plus some marks (°, ', ", ., space).
 * The engine tries every sensible reading of those digits - decimal degrees,
 * degrees + decimal minutes, degrees/minutes/seconds - with each mark either
 * used or ignored. Each reading gets a cost (how much it had to change), and
 * only readings that land inside the boundary are kept.
 *
 * Pure functions, no DOM: usable in the browser (window.CordifyRepair) and Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"));
  } else {
    root.CordifyRepair = factory(root.CordifyCore);
  }
})(typeof self !== "undefined" ? self : this, function (Core) {
  "use strict";

  const SEP_PRIORITY = { dot: 4, deg: 3, min: 2, sec: 2, space: 1 };
  const DEDUPE_KM = 0.15;          // candidates closer than this are the same place
  const VILLAGE_MATCH_KM = 3;      // a clean point this close to its village is trusted
  const VILLAGE_MIN_POINTS = 3;
  const CLEAR_WIN = 2.5;           // best reading this much cheaper than the next = clear winner
  const FAR_FROM_VILLAGE_KM = 10;
  const ESTIMATE_TRUST_KM = 30;    // no boundary file: a correctly typed point this close to the estimated area is kept
  const HABIT_MIN_ROWS = 3;        // rows typed the same way before their common reading is used for all of them
  const HABIT_SHARE = 0.5;         // ...and the share of them that must already read best that way

  /* ---------- text clean-up ---------- */

  function normalizeText(raw) {
    let s = String(raw ?? "");
    s = s.replace(/[ᵒº˚⁰]/g, "°");
    try {
      s = s.normalize("NFKC");
    } catch (e) {}
    s = s.replace(/\r/g, "").replace(/\t/g, " ")
      .replace(/[’‘′`´ʹ]/g, "'").replace(/[”“″ʺ]/g, '"').replace(/''/g, '"')
      .toUpperCase();
    return s;
  }

  // Returns { text, notes[] } with labels removed and obvious typing slips fixed.
  function cleanText(raw) {
    const notes = [];
    let s = normalizeText(raw);
    const before = s;
    s = s.replace(/\bLAT(?:ITUDE)?\b\.?\s*:?/g, " ")
      .replace(/\bL\s?ONG(?:ITUDE)?\b\.?\s*:?|\bLON\b\.?\s*:?|\bLNG\b\.?\s*:?/g, " ");
    if (s !== before) {
      notes.push({ text: "labels removed", cost: 0 });
    }
    // "N." / ".N" around hemisphere letters
    s = s.replace(/([NSEW])\./g, "$1 ").replace(/\.([NSEW])\b/g, " $1");
    // 26°26'.257 -> 26°26.257  (mark typed before the decimal point). This changes how the
    // value reads, so it is recorded: the converter reports it, Repair marks it for checking.
    if (/(\d)\s*['"]\s*\.(?=\d)/.test(s)) {
      s = s.replace(/(\d)\s*['"]\s*\.(?=\d)/g, "$1.");
      notes.push({ text: "mark before a decimal point ignored", cost: 0.5 });
    }
    // 95. 165864 -> 95.165864
    if (/(\d)\.\s+(?=\d)/.test(s)) {
      s = s.replace(/(\d)\.\s+(?=\d)/g, "$1.");
      notes.push({ text: "space after decimal point removed", cost: 0.25 });
    }
    // Decimal commas (only when no dots are used anywhere)
    if (!s.includes(".") && (s.match(/\d,\d/g) || []).length >= 2) {
      s = s.replace(/(\d),(\d)/g, "$1.$2");
      notes.push({ text: "decimal commas read as points", cost: 0 });
    }
    const ocr = ocrFix(s);
    s = ocr.text;
    notes.push(...ocr.notes);
    return { text: s, notes };
  }

  // Letters and symbols that are really digits (bad OCR or keyboard slips).
  function ocrFix(s) {
    const c = [ ...s ];
    const isD = ch => ch !== undefined && /\d/.test(ch);
    let letters = 0, degZero = 0;
    for (let i = 0; i < c.length; i++) {
      const p = isD(c[i - 1]), n = isD(c[i + 1]);
      if (c[i] === "O" && (p || n)) {
        c[i] = "0"; letters++;
      } else if ((c[i] === "I" || c[i] === "|" || c[i] === "L") && (p || n)) {
        c[i] = "1"; letters++;
      } else if (c[i] === "S" && p && n) {
        c[i] = "5"; letters++;
      } else if (c[i] === "B" && p && n) {
        c[i] = "8"; letters++;
      }
    }
    // "°" typed for "0" inside a number: 2°.87868, 22.7°4, 51.°9444, 28.2°°12
    let inFrac = false;
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (/\d/.test(ch)) {
        continue;
      }
      if (ch === ".") {
        inFrac = true;
        continue;
      }
      if (ch === "°") {
        const prevOk = /[\d.]/.test(c[i - 1] || "");
        const next = c[i + 1] || "";
        const nextOk = /[\d.°]/.test(next);
        if (prevOk && nextOk && (inFrac || next === ".")) {
          c[i] = "0"; degZero++;
          continue;
        }
      }
      inFrac = false;
    }
    const notes = [];
    if (letters) {
      notes.push({ text: "letters read as digits (O→0, l→1…)", cost: 1 });
    }
    if (degZero) {
      notes.push({ text: "° read as 0 inside a number", cost: 1 });
    }
    return { text: c.join(""), notes };
  }

  /* ---------- splitting a cell into latitude / longitude parts ---------- */

  const ELEVATION = /^[+-]?\d+(?:\.\d+)?\s*(?:M|MTR|MTRS|METRES?|METERS?|FT|N)\.?$/;

  // Returns { parts: [{text, hemi}], notes[], problem? }
  function splitCell(raw) {
    const cleaned = cleanText(raw);
    const notes = cleaned.notes.slice();
    let s = cleaned.text.trim();
    if (!s || /^[-–—_.\s]*$/.test(s) || /^(NIL|NA|N\.A|NONE|NULL)$/.test(s)) {
      return { parts: [], notes, empty: true };
    }
    let chunks = s.split(/\n|;|,/).map(t => t.trim()).filter(Boolean);
    let elevation = false;
    while (chunks.length > 2 && ELEVATION.test(chunks[chunks.length - 1])) {
      chunks.pop();
      elevation = true;
    }
    if (chunks.length === 1) {
      chunks = splitSingle(chunks[0]);
      if (chunks.length > 2 && ELEVATION.test(chunks[chunks.length - 1])) {
        chunks.pop();
        elevation = true;
      }
    }
    if (elevation) {
      notes.push({ text: "elevation removed", cost: 0 });
    }
    if (chunks.length > 2) {
      const withHemi = chunks.filter(t => hemiOf(t).hemi);
      if (withHemi.length === 2) {
        chunks = withHemi;
      } else {
        chunks = chunks.slice(0, 2);
        notes.push({ text: "extra values ignored", cost: 2 });
      }
    }
    if (chunks.length < 2) {
      return { parts: [], notes, problem: "could not find two values (latitude and longitude)" };
    }
    return { parts: chunks.map(hemiOf), notes };
  }

  // One chunk holding both values: split at N/S/E/W letters or at the middle space.
  function splitSingle(t) {
    const letters = [ ...t.matchAll(/(^|[^A-Z])([NSEW])(?=[^A-Z]|$)/g) ].map(m => m.index + m[1].length);
    if (letters.length === 2) {
      const i = /[NSEW]\s*$/.test(t) ? letters[0] + 1 : letters[1];
      return [ t.slice(0, i).trim(), t.slice(i).trim() ].filter(Boolean);
    }
    const tok = t.split(/\s+/).filter(Boolean);
    if (tok.length >= 2 && tok.length % 2 === 0 && tok.length <= 6) {
      return [ tok.slice(0, tok.length / 2).join(" "), tok.slice(tok.length / 2).join(" ") ];
    }
    if (tok.length === 3 && ELEVATION.test(tok[2])) {
      return [ tok[0], tok[1], tok[2] ];
    }
    return [ t ];
  }

  // Leading or trailing N/S/E/W: "N 26°3'", "26.31 N", "E094°50'", "95°01'E"
  function hemiOf(t) {
    let text = t.trim(), hemi = null;
    let m = text.match(/^([NSEW])(?![A-Z])\s*/);
    if (m) {
      hemi = m[1];
      text = text.slice(m[0].length);
    }
    m = text.match(/(^|[^A-Z])([NSEW])\s*$/);
    if (m) {
      if (!hemi) {
        hemi = m[2];
      }
      text = text.slice(0, m.index + m[1].length);
    }
    return { text: text.trim(), hemi };
  }

  /* ---------- reading one part ---------- */

  // Digits plus the marks between them: { S, seps: Map(pos -> type), sign, stray }
  function parsePart(text) {
    let t = text.trim(), sign = null;
    if (/^[+-]/.test(t)) {
      sign = t[0] === "-" ? -1 : 1;
      t = t.slice(1);
    }
    let S = "", stray = false;
    const seps = new Map();
    for (const ch of t) {
      if (ch >= "0" && ch <= "9") {
        S += ch;
        continue;
      }
      const type = ch === "°" ? "deg" : ch === "'" ? "min" : ch === '"' ? "sec" : ch === "." ? "dot" : /\s/.test(ch) ? "space" : null;
      if (!type) {
        if (ch !== "-" && ch !== "+") {
          stray = true;
        }
        continue;
      }
      const p = S.length;
      if (p === 0) {
        continue;
      }
      const prev = seps.get(p);
      if (!prev || SEP_PRIORITY[type] > SEP_PRIORITY[prev]) {
        seps.set(p, type);
      }
    }
    seps.delete(S.length);
    return { S, seps, sign, stray };
  }

  const frac = d => d ? +("0." + d) : 0;

  function breakCost(role, sep) {
    if (role === "decimal") {
      return { dot: [ 0 ], deg: [ 1, "° read as decimal point" ], min: [ 1.5, "' read as decimal point" ], sec: [ 1.5, '" read as decimal point' ], space: [ 0.5, "space read as decimal point" ] }[sep] || [ 2, "decimal point added" ];
    }
    if (role === "deg") {
      return { deg: [ 0 ], space: [ 0.25 ], dot: [ 1, ". read as °" ], min: [ 1, "' read as °" ], sec: [ 1.5, '" read as °' ] }[sep] || [ 2, "degree/minute split added" ];
    }
    return { min: [ 0 ], space: [ 0.25 ], deg: [ 0.5, "° read as minute mark" ], dot: [ 1, ". read as minute mark" ], sec: [ 1, '" read as minute mark' ] }[sep] || [ 2, "minute/second split added" ];
  }
  const UNUSED_COST = { dot: [ 2, "extra decimal point ignored" ], deg: [ 1.5, "° ignored" ], min: [ 1.5, "' ignored" ], sec: [ 1.5, '" ignored' ], space: [ 1, "space ignored" ] };

  // All sensible readings of one part, as magnitudes (sign handled later).
  function readings(pp, role) {
    const S = pp.S, n = S.length, out = [];
    if (!n || n > 14) {
      return out;
    }
    const max = role === "lat" ? 90 : 180;
    const add = (format, value, breaks) => {
      if (value > max) {
        return;
      }
      let cost = 0;
      const notes = [];
      const used = new Set();
      for (const [ pos, r ] of breaks) {
        const [ c, note ] = breakCost(r, pp.seps.get(pos));
        cost += c;
        if (note) {
          notes.push(note);
        }
        used.add(pos);
      }
      for (const [ pos, type ] of pp.seps) {
        if (!used.has(pos)) {
          cost += UNUSED_COST[type][0];
          notes.push(UNUSED_COST[type][1]);
        }
      }
      out.push({ format, value, cost, notes });
    };
    for (let k = 1; k <= Math.min(3, n); k++) {
      const deg = +S.slice(0, k);
      if (deg > max) {
        continue;
      }
      const restDD = S.slice(k);
      add("DD", deg + frac(restDD), restDD ? [ [ k, "decimal" ] ] : []);
      for (let m = 1; m <= 2 && k + m <= n; m++) {
        const mi = +S.slice(k, k + m);
        if (mi >= 60) {
          continue;
        }
        const restM = S.slice(k + m);
        add("DDM", deg + (mi + frac(restM)) / 60, restM ? [ [ k, "deg" ], [ k + m, "decimal" ] ] : [ [ k, "deg" ] ]);
        for (let s = 1; s <= 2 && k + m + s <= n; s++) {
          const se = +S.slice(k + m, k + m + s);
          if (se >= 60) {
            continue;
          }
          const restS = S.slice(k + m + s);
          add("DMS", deg + mi / 60 + (se + frac(restS)) / 3600,
            restS ? [ [ k, "deg" ], [ k + m, "min" ], [ k + m + s, "decimal" ] ] : [ [ k, "deg" ], [ k + m, "min" ] ]);
        }
      }
    }
    return out;
  }

  // Signed values for a part in a given role, with hemisphere/sign rules applied.
  function signedReadings(part, pp, role) {
    const base = readings(pp, role);
    const out = [];
    const hemiNeg = part.hemi === "S" || part.hemi === "W";
    for (const r of base) {
      if (pp.sign === -1 || hemiNeg) {
        out.push({ ...r, value: -r.value });
      } else if (pp.sign === 1 || part.hemi) {
        out.push(r);
      } else {
        out.push(r);
        if (r.value !== 0) {
          out.push({ ...r, value: -r.value, cost: r.cost + 0.25, notes: r.notes.concat("minus sign assumed") });
        }
      }
    }
    return out;
  }

  /* ---------- geometry ---------- */

  // feature: { name, props, rings: [[ [lon,lat], ... ], ...] }  (even-odd rule, so holes work)
  function buildFeature(src, index) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, nEdges = 0;
    for (const r of src.rings) {
      for (const [ x, y ] of r) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      nEdges += r.length;
    }
    const B = Math.max(16, Math.min(2048, Math.round(nEdges / 40)));
    const h = (maxY - minY) / B || 1;
    const bands = Array.from({ length: B }, () => []);
    for (const r of src.rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [ x1, y1 ] = r[j], [ x2, y2 ] = r[i];
        if (y1 === y2) {
          continue;
        }
        const b1 = Math.max(0, Math.min(B - 1, Math.floor((Math.min(y1, y2) - minY) / h)));
        const b2 = Math.max(0, Math.min(B - 1, Math.floor((Math.max(y1, y2) - minY) / h)));
        for (let b = b1; b <= b2; b++) {
          bands[b].push(x1, y1, x2, y2);
        }
      }
    }
    return {
      index, name: src.name || null, props: src.props || {},
      bbox: [ minX, minY, maxX, maxY ], bands, h, minY, B,
      center: [ (minX + maxX) / 2, (minY + maxY) / 2 ]
    };
  }

  function contains(f, lon, lat) {
    const [ minX, minY, maxX, maxY ] = f.bbox;
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) {
      return false;
    }
    const b = Math.max(0, Math.min(f.B - 1, Math.floor((lat - f.minY) / f.h)));
    const e = f.bands[b];
    let inside = false;
    for (let i = 0; i < e.length; i += 4) {
      const x1 = e[i], y1 = e[i + 1], x2 = e[i + 2], y2 = e[i + 3];
      if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) {
        inside = !inside;
      }
    }
    return inside;
  }

  function featureAt(features, lon, lat) {
    for (const f of features) {
      if (contains(f, lon, lat)) {
        return f;
      }
    }
    return null;
  }

  function km(lat1, lon1, lat2, lon2) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Distance from a point to a box [minLon, minLat, maxLon, maxLat]; 0 inside.
  function kmToBox(lat, lon, b) {
    return km(lat, lon, Math.min(b[3], Math.max(b[1], lat)), Math.min(b[2], Math.max(b[0], lon)));
  }

  function unionBbox(features) {
    const b = [ Infinity, Infinity, -Infinity, -Infinity ];
    for (const f of features) {
      b[0] = Math.min(b[0], f.bbox[0]); b[1] = Math.min(b[1], f.bbox[1]);
      b[2] = Math.max(b[2], f.bbox[2]); b[3] = Math.max(b[3], f.bbox[3]);
    }
    return b;
  }

  /* ---------- one row ---------- */

  // Prepare a row: returns { empty, problem, parts, notes, pp[] }
  function prepareRow(row) {
    let split;
    if (row.latText !== undefined || row.lonText !== undefined) {
      const a = String(row.latText ?? "").trim(), b = String(row.lonText ?? "").trim();
      const blank = v => !v || /^[-–—_.\s]*$/.test(v) || /^(NIL|NA|NONE|NULL)$/i.test(v);
      if (blank(a) && blank(b)) {
        return { empty: true, notes: [] };
      }
      const ca = cleanText(a), cb = cleanText(b);
      split = { parts: [ hemiOf(ca.text), hemiOf(cb.text) ], notes: ca.notes.concat(cb.notes) };
      if (blank(a) || blank(b)) {
        return { problem: "latitude or longitude is missing", notes: split.notes };
      }
    } else {
      split = splitCell(row.text);
    }
    if (split.empty) {
      return { empty: true, notes: split.notes };
    }
    if (split.problem) {
      return { problem: split.problem, notes: split.notes };
    }
    const pp = split.parts.map(p => parsePart(p.text));
    const notes = split.notes.slice();
    if (pp.some(p => p.stray)) {
      notes.push({ text: "stray characters removed", cost: 0.5 });
    }
    return { parts: split.parts, pp, notes };
  }

  // Every lat/lon pair for a prepared row (optionally limited to a bbox).
  function pairsFor(prep, bbox, opts = {}) {
    const out = [];
    const baseCost = prep.notes.reduce((a, n) => a + n.cost, 0);
    const baseNotes = prep.notes.map(n => n.text);
    const [ p0, p1 ] = prep.parts;
    const assignments = [];
    const letterRole = p => p.hemi === "N" || p.hemi === "S" ? "lat" : p.hemi === "E" || p.hemi === "W" ? "lon" : null;
    const r0 = letterRole(p0), r1 = letterRole(p1);
    // natural: first = lat. Letters override the order when present.
    const natural = !(r0 === "lon" || r1 === "lat");
    assignments.push({ lat: 0, lon: 1, cost: natural ? 0 : (r0 && r1 ? 1.5 : 1), note: natural ? null : (r0 && r1 ? "N/S/E/W labels swapped" : "latitude/longitude swapped") });
    assignments.push({ lat: 1, lon: 0, cost: natural ? (r0 && r1 ? 1.5 : 1) : 0, note: natural ? (r0 && r1 ? "N/S/E/W labels swapped" : "latitude/longitude swapped") : null });
    for (const a of assignments) {
      const latPart = { ...prep.parts[a.lat] }, lonPart = { ...prep.parts[a.lon] };
      // A letter on the wrong value is ignored once we decide the values are swapped.
      if (a.note && latPart.hemi && letterRole(latPart) === "lon") {
        latPart.hemi = null;
      }
      if (a.note && lonPart.hemi && letterRole(lonPart) === "lat") {
        lonPart.hemi = null;
      }
      let lats = signedReadings(latPart, prep.pp[a.lat], "lat");
      let lons = signedReadings(lonPart, prep.pp[a.lon], "lon");
      if (bbox) {
        lats = lats.filter(r => r.value >= bbox[1] && r.value <= bbox[3]);
        lons = lons.filter(r => r.value >= bbox[0] && r.value <= bbox[2]);
      }
      for (const la of lats) {
        for (const lo of lons) {
          // Both values of a pair are almost always typed the same way.
          const mismatch = la.format !== lo.format ? 1 : 0;
          const notes = baseNotes.concat(a.note ? [ a.note ] : [], la.notes.map(t => "lat: " + t), lo.notes.map(t => "lon: " + t));
          if (la.format !== "DD" || lo.format !== "DD") {
            notes.push(`read as ${la.format === lo.format ? la.format : la.format + " / " + lo.format}`);
          }
          out.push({ lat: la.value, lon: lo.value, cost: baseCost + a.cost + la.cost + lo.cost + mismatch, notes, format: [ la.format, lo.format ], digitFix: false });
        }
      }
    }
    return out;
  }

  // The reading with nothing changed, if there is one.
  function cleanPair(prep) {
    if (!prep.parts) {
      return null;
    }
    const pairs = pairsFor(prep, null).filter(p => p.cost === 0);
    return pairs.length ? pairs[0] : null;
  }

  // Wrong degree digit: 29.84 -> 26.84. Only tried when nothing else fits.
  function digitFixPairs(prep, features, bbox, limit = 40) {
    const base = pairsFor(prep, null).sort((a, b) => a.cost - b.cost).slice(0, limit);
    const out = [];
    for (const p of base) {
      for (const role of [ "lat", "lon" ]) {
        const v = Math.abs(p[role]), sgn = Math.sign(p[role]) || 1;
        const deg = Math.floor(v), rest = v - deg;
        const ds = String(deg);
        for (let i = 0; i < ds.length; i++) {
          for (let d = 0; d <= 9; d++) {
            if (String(d) === ds[i]) {
              continue;
            }
            const nd = +(ds.slice(0, i) + d + ds.slice(i + 1));
            const nv = sgn * (nd + rest);
            const lat = role === "lat" ? nv : p.lat, lon = role === "lon" ? nv : p.lon;
            if (lat < bbox[1] || lat > bbox[3] || lon < bbox[0] || lon > bbox[2]) {
              continue;
            }
            const f = featureAt(features, lon, lat);
            if (f) {
              out.push({ ...p, lat, lon, cost: p.cost + 3, notes: p.notes.concat(`${role}: degree digit changed ${deg}→${nd}`), digitFix: true, feature: f.index });
            }
          }
        }
      }
    }
    return out;
  }

  function dedupe(cands) {
    cands.sort((a, b) => a.cost - b.cost);
    const out = [];
    for (const c of cands) {
      if (!out.some(o => km(o.lat, o.lon, c.lat, c.lon) < DEDUPE_KM)) {
        out.push(c);
      }
    }
    return out;
  }

  const median = a => {
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /* ---------- whole table ---------- */

  /*
   * rows: [{ id, text } or { id, latText, lonText }, with optional group, village]
   * opts: { features: built features, groupFeatures: { group: [featureIndex...] } | null,
   *         digitFix: true, estimated: true when the features were guessed by estimateAreas
   *         rather than given as a boundary file }
   * Returns one result per row:
   *   { id, status: ok|fixed|choose|outside|failed|empty, lat, lon, confidence,
   *     notes[], candidates[], chosen }
   * plus results.habits: groups of rows typed the same way that were read one common way
   *   [ { group, pattern, rows: [index...], signature, example, n } ]
   */
  function repairRows(rows, opts) {
    const features = opts.features;
    const allowDigit = opts.digitFix !== false;
    const targetFor = row => {
      const idx = opts.groupFeatures && row.group != null ? opts.groupFeatures[row.group] : null;
      return idx && idx.length ? idx.map(i => features[i]) : features;
    };
    const villageKey = row => row.village ? `${row.group ?? ""}||${String(row.village).trim().toUpperCase()}` : null;

    // Pass 1: prepare + clean readings, for village anchors.
    const preps = rows.map(prepareRow);
    const cleanByVillage = new Map();
    preps.forEach((p, i) => {
      const c = p.parts ? cleanPair(p) : null;
      p.clean = c;
      const vk = villageKey(rows[i]);
      if (c && vk) {
        if (!cleanByVillage.has(vk)) cleanByVillage.set(vk, []);
        cleanByVillage.get(vk).push(c);
      }
    });
    const villageCentre = vk => {
      const pts = vk && cleanByVillage.get(vk);
      if (!pts || pts.length < VILLAGE_MIN_POINTS) return null;
      return { lat: median(pts.map(p => p.lat)), lon: median(pts.map(p => p.lon)), n: pts.length };
    };

    // Pass 2: candidates inside the target area (unranked).
    const results = rows.map((row, i) => {
      const prep = preps[i];
      const res = { id: row.id, status: "failed", lat: null, lon: null, confidence: 0, notes: [], candidates: [], chosen: -1 };
      if (prep.empty) {
        res.status = "empty";
        return res;
      }
      if (prep.problem) {
        res.notes = [ prep.problem ];
        return res;
      }
      const target = targetFor(row);
      const bbox = unionBbox(target);
      const vc = villageCentre(villageKey(row));
      if (prep.clean) {
        const f = featureAt(target, prep.clean.lon, prep.clean.lat);
        if (f) {
          Object.assign(res, { status: "ok", lat: prep.clean.lat, lon: prep.clean.lon, confidence: 100, notes: [], candidates: [ { ...prep.clean, feature: f.index } ], chosen: 0 });
          return res;
        }
        // No boundary file: the area is only a guess from the other rows, so a correctly
        // typed point just outside it is kept as typed. Far-away ones still get suggestions.
        const off = opts.estimated ? kmToBox(prep.clean.lat, prep.clean.lon, bbox) : Infinity;
        if (off <= ESTIMATE_TRUST_KM) {
          Object.assign(res, {
            status: "ok", lat: prep.clean.lat, lon: prep.clean.lon, confidence: 90, candidates: [ { ...prep.clean, feature: -1 } ], chosen: 0,
            notes: [ `typed correctly, ${off.toFixed(0)} km outside the estimated area — kept as typed (no boundary file was given)` ]
          });
          return res;
        }
        // Typed correctly, agrees with its village, but outside: never move it.
        if (vc && km(prep.clean.lat, prep.clean.lon, vc.lat, vc.lon) <= VILLAGE_MATCH_KM) {
          const inAny = featureAt(features, prep.clean.lon, prep.clean.lat);
          Object.assign(res, {
            status: "outside", lat: prep.clean.lat, lon: prep.clean.lon, confidence: 0,
            notes: [ `outside the boundary but matches ${vc.n - 1} other points from this village — check the boundary or the district` + (inAny ? ` (it falls in polygon ${inAny.index + 1})` : "") ]
          });
          return res;
        }
      }
      let cands = [];
      for (const p of pairsFor(prep, bbox)) {
        if (p.cost === 0 && prep.clean) {
          continue;
        }
        const f = featureAt(target, p.lon, p.lat);
        if (f) {
          cands.push({ ...p, feature: f.index });
        }
      }
      if (!cands.length && allowDigit) {
        cands = digitFixPairs(prep, target, bbox);
      }
      cands = dedupe(cands);
      if (!cands.length) {
        res.notes = [ prep.clean ? "outside the boundary and no correction lands inside" : "no reading of these numbers lands inside the boundary" ];
        if (prep.clean) {
          res.lat = prep.clean.lat;
          res.lon = prep.clean.lon;
        }
        return res;
      }
      res.candidates = cands;
      res.status = "pending";
      return res;
    });

    // Village centres from the best guess of every row (median, so a few wrong ones don't matter).
    const guessByVillage = new Map();
    results.forEach((r, i) => {
      const vk = villageKey(rows[i]);
      const g = r.status === "pending" ? r.candidates[0] : (r.lat != null ? r : null);
      if (vk && g) {
        if (!guessByVillage.has(vk)) guessByVillage.set(vk, []);
        guessByVillage.get(vk).push(g);
      }
    });
    const guessCentre = vk => {
      const pts = vk && guessByVillage.get(vk);
      if (!pts || pts.length < VILLAGE_MIN_POINTS) return null;
      return { lat: median(pts.map(p => p.lat)), lon: median(pts.map(p => p.lon)), n: pts.length };
    };

    // Pass 3: rank and decide.
    results.forEach((res, i) => {
      if (res.status !== "pending") {
        return;
      }
      const vc = villageCentre(villageKey(rows[i])) || guessCentre(villageKey(rows[i]));
      let cands = res.candidates;
      for (const c of cands) {
        c.distKm = vc ? km(c.lat, c.lon, vc.lat, vc.lon) : null;
        c.score = c.cost + (c.distKm == null ? 0 : Math.min(3, c.distKm / 5));
      }
      cands.sort((a, b) => a.score - b.score);
      cands = res.candidates = cands.slice(0, 6);
      res.chosen = 0;
      const best = cands[0];
      res.lat = best.lat;
      res.lon = best.lon;
      res.notes = best.notes.slice();
      const far = best.distKm != null && best.distKm > FAR_FROM_VILLAGE_KM;
      if (far) {
        res.notes.push(`${best.distKm.toFixed(1)} km from this village's other points`);
      }
      const clearWin = cands.length === 1 || cands[1].score - best.score >= CLEAR_WIN;
      // A value that was typed validly is never changed without the user confirming.
      const wasValid = !!preps[i].clean;
      if (wasValid) {
        res.notes.unshift("the original value looks valid but is outside the boundary — confirm this correction");
      }
      res.status = clearWin && !best.digitFix && !far && !wasValid ? "fixed" : "choose";
      res.confidence = Math.max(5, Math.round(
        95 - best.cost * 8 - (cands.length === 1 ? 0 : clearWin ? 8 : 25) - (best.digitFix ? 25 : 0) - (far ? 20 : 0)));
      if (res.status === "choose" && cands.length > 1) {
        res.notes.push(`${cands.length} possible readings land inside — choose one`);
      } else if (cands.length > 1) {
        res.notes.push(`${cands.length - 1} other reading${cands.length > 2 ? "s" : ""} possible, clearly less likely`);
      }
      res.wasValid = wasValid;
      res.far = far;
    });

    results.habits = applyHabits(rows, results, preps, opts, row => unionBbox(targetFor(row)));
    return results;
  }

  // What a reading did, without the parts that differ from row to row.
  const signatureOf = c => c ? c.notes.filter(n => !/km from|possible|other reading|confirm this correction/.test(n)).join("|") : "";

  /*
   * Pass 4: rows typed the same way (same pattern, same group) were almost always typed
   * by one person with one habit, e.g. ' where the decimal point goes. When most of
   * them already read best one way, read the others that way too, so a typing habit
   * is decided once instead of row by row. Nothing becomes "ok": these still need checking.
   * With an estimated area (no boundary file), a row of the habit whose reading lands just
   * outside the area (within ESTIMATE_TRUST_KM) is read the same way too.
   */
  function applyHabits(rows, results, preps, opts, bboxOf) {
    const groups = new Map(), others = new Map();
    const keyOf = i => `${rows[i].group ?? ""}\u0000${patternOf(rows[i])}`;
    results.forEach((r, i) => {
      const into = r.status === "fixed" || r.status === "choose" ? groups : r.status === "failed" && preps[i].parts && !preps[i].clean ? others : null;
      if (!into) return;
      const key = keyOf(i);
      if (!into.has(key)) into.set(key, []);
      into.get(key).push(i);
    });
    const habits = [];
    for (const [ key, list ] of groups) {
      if (list.length < HABIT_MIN_ROWS) continue;
      const best = new Map();
      for (const i of list) {
        const s = signatureOf(results[i].candidates[results[i].chosen]);
        best.set(s, (best.get(s) || 0) + 1);
      }
      const [ sig, n ] = [ ...best ].sort((a, b) => b[1] - a[1])[0];
      if (!sig || n < HABIT_MIN_ROWS || n < list.length * HABIT_SHARE) continue;
      const members = [];
      // Rows of the habit with no reading inside an estimated area: read the habit's way if
      // that lands just outside it. Their only candidates may be unlikely ones (a changed digit).
      const outsideReading = i => {
        if (!opts.estimated || preps[i].clean) return null;
        const bbox = bboxOf(rows[i]);
        let best = null;
        for (const p of pairsFor(preps[i], null)) {
          if (signatureOf(p) !== sig || (best && p.cost >= best.cost)) continue;
          const off = kmToBox(p.lat, p.lon, bbox);
          if (off <= ESTIMATE_TRUST_KM) best = { ...p, feature: -1, offKm: off };
        }
        return best;
      };
      for (const i of list.concat(others.get(key) || [])) {
        const res = results[i];
        let k = res.candidates.findIndex(c => signatureOf(c) === sig);
        if (k < 0) {
          const c = outsideReading(i);
          if (!c) continue;
          res.candidates = [ c ].concat(res.candidates.filter(x => !x.digitFix));
          res.chosen = -1;    // set below, with its notes
          res.wasValid = false;
          if (res.status === "failed") res.status = "choose";
          k = 0;
        }
        members.push(i);
        const c = res.candidates[k];
        if (k !== res.chosen) {
          res.chosen = k;
          res.lat = c.lat;
          res.lon = c.lon;
          res.notes = (res.wasValid ? [ "the original value looks valid but is outside the boundary — confirm this correction" ] : []).concat(c.notes);
        }
        if (c.offKm != null) res.notes.push(`${c.offKm.toFixed(1)} km outside the estimated area`);
        res.notes.push(`read the same way as ${n - (list.includes(i) && k === 0 ? 1 : 0)} other rows typed like this`);
        // One clear habit is as good as one clear reading — unless the value was valid,
        // needed a changed digit, or lands far from its village.
        const far = c.distKm != null && c.distKm > FAR_FROM_VILLAGE_KM;
        if (res.status === "choose" && !res.wasValid && !c.digitFix && !far) {
          res.status = "fixed";
        }
        res.confidence = Math.max(res.confidence, Math.min(80, Math.round(40 + 40 * n / list.length) - (far ? 20 : 0)));
      }
      const [ group, pattern ] = key.split("\u0000");
      habits.push({ group, pattern, rows: members, signature: sig, example: members[0], n: members.length });
    }
    return habits.sort((a, b) => b.n - a.n);
  }

  /*
   * Link each group (e.g. district) to the polygon(s) it belongs to, using the rows
   * that are typed correctly. Returns { group: { feature, votes, total, share } }.
   */
  function learnGroupFeatures(rows, features, minPoints = 3, minShare = 0.5) {
    const votes = new Map();
    const tally = (g, fi) => {
      if (!votes.has(g)) votes.set(g, new Map());
      const m = votes.get(g);
      m.set(fi, (m.get(fi) || 0) + 1);
    };
    const unresolvedRows = [];
    rows.forEach(r => {
      const p = prepareRow(r);
      const c = p.parts ? cleanPair(p) : null;
      if (c) {
        const f = featureAt(features, c.lon, c.lat);
        tally(r.group, f ? f.index : -1);
      } else if (p.parts) {
        unresolvedRows.push(r);
      }
    });
    const decide = () => {
      const out = {};
      for (const [ g, m ] of votes) {
        let total = 0, best = -1, bestN = 0;
        for (const [ fi, n ] of m) {
          total += n;
          if (fi >= 0 && n > bestN) {
            best = fi;
            bestN = n;
          }
        }
        if (best >= 0 && bestN >= minPoints && bestN / total >= minShare) {
          out[g] = { feature: best, votes: bestN, total, share: bestN / total };
        }
      }
      return out;
    };
    let result = decide();
    // Two groups claiming one polygon: drop the much weaker claim (a few stray rows).
    if (features.length > 1) {
      const byFeature = new Map();
      for (const [ g, v ] of Object.entries(result)) {
        if (!byFeature.has(v.feature)) byFeature.set(v.feature, []);
        byFeature.get(v.feature).push(g);
      }
      for (const gs of byFeature.values()) {
        if (gs.length < 2) continue;
        const max = Math.max(...gs.map(g => result[g].votes));
        for (const g of gs) {
          if (result[g].votes < max * 0.2 && result[g].votes < 10) {
            delete result[g];
          }
        }
      }
    }
    // Groups still unlinked: vote with rows whose repair has exactly one answer,
    // ignoring polygons already taken by other groups.
    const missing = new Set(rows.map(r => r.group).filter(g => g != null && !(g in result)));
    if (missing.size) {
      const taken = new Set(Object.values(result).map(v => v.feature));
      const free = features.length > 1 ? features.filter(f => !taken.has(f.index)) : features;
      const sub = rows.filter(r => missing.has(r.group));
      if (free.length) {
        const res = repairRows(sub, { features: free, groupFeatures: null, digitFix: false });
        const v2 = new Map();
        res.forEach((x, i) => {
          const fi = x.status === "ok" || x.status === "fixed" ? x.candidates[x.chosen].feature : null;
          if (fi == null) return;
          const g = sub[i].group;
          if (!v2.has(g)) v2.set(g, new Map());
          v2.get(g).set(fi, (v2.get(g).get(fi) || 0) + 1);
        });
        for (const [ g, m ] of v2) {
          let best = -1, bestN = 0, total = 0;
          for (const [ fi, n ] of m) {
            total += n;
            if (n > bestN) { best = fi; bestN = n; }
          }
          if (bestN >= Math.min(minPoints, 2) && bestN / total >= minShare) {
            result[g] = { feature: best, votes: bestN, total, share: bestN / total, fromRepairs: true };
          }
        }
      }
    }
    return result;
  }

  /* ---------- output formats ---------- */

  // Written by core.js, the same code the converter uses.
  const { formatDMS, formatDDM, formatDD } = Core;

  /*
   * No boundary? Estimate an area per group from the rows that are already
   * typed correctly (middle 90% of their points, padded). Less reliable than a
   * real boundary, but enough to choose between readings that are far apart.
   */
  function estimateAreas(rows, opts = {}) {
    const minPts = opts.minPoints || 3;
    const byGroup = new Map(), all = [];
    rows.forEach(r => {
      const p = prepareRow(r);
      const c = p.parts ? cleanPair(p) : null;
      if (!c) return;
      all.push(c);
      const g = r.group ?? "";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(c);
    });
    const pct = (a, q) => {
      const s = a.slice().sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
    };
    // The middle 80% of the clean points, so a few mistyped-but-valid values (29.8 for 26.8)
    // can't stretch it, then padded generously (at least 0.15°, about 16 km) so real points
    // at the edge of the district are not cut off.
    const box = pts => {
      const la = pts.map(p => p.lat), lo = pts.map(p => p.lon);
      let b = [ pct(lo, 0.1), pct(la, 0.1), pct(lo, 0.9), pct(la, 0.9) ];
      const padX = Math.max(0.15, (b[2] - b[0]) * 0.75), padY = Math.max(0.15, (b[3] - b[1]) * 0.75);
      b = [ b[0] - padX, b[1] - padY, b[2] + padX, b[3] + padY ];
      return [ [ [ b[0], b[1] ], [ b[2], b[1] ], [ b[2], b[3] ], [ b[0], b[3] ], [ b[0], b[1] ] ] ];
    };
    const src = [], groupFeatures = {};
    if (all.length < minPts) {
      return { features: [], src: [], groupFeatures, cleanPoints: all.length };
    }
    src.push({ name: "Estimated area (all rows)", props: { name: "Estimated area (all rows)" }, rings: box(all) });
    for (const [ g, pts ] of byGroup) {
      if (pts.length >= minPts) {
        groupFeatures[g] = [ src.length ];
        src.push({ name: `Estimated area: ${g}`, props: { name: `Estimated area: ${g || "rows"}` }, rings: box(pts) });
      }
    }
    for (const r of rows) {
      const g = r.group ?? "";
      if (!(g in groupFeatures)) groupFeatures[g] = [ 0 ];
    }
    return { features: src.map((f, i) => buildFeature(f, i)), src, groupFeatures, cleanPoints: all.length };
  }

  // Rows typed the same way share a pattern, e.g. "9°9'9, 9°9'9, 9M".
  function patternOf(row) {
    const raw = row.text !== undefined ? row.text : `${row.latText ?? ""} | ${row.lonText ?? ""}`;
    return normalizeText(raw).replace(/\d+/g, "9").replace(/\s+/g, " ").trim();
  }

  return {
    patternOf, formatDMS, formatDDM, formatDD, estimateAreas, normalizeText, cleanText, splitCell, parsePart, readings, prepareRow, pairsFor,
    buildFeature, contains, featureAt, km, kmToBox, repairRows, learnGroupFeatures, signatureOf
  };
});
