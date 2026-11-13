/*
 * Cordify — Scan, the part with no screen
 * Finds latitude/longitude pairs in ordinary text: the words read out of a
 * photographed page, a scanned PDF or a typed report. Text in, a list of
 * candidate points out. Nothing is trusted silently: anything that needed a
 * guess is marked "check", and anything unreadable is kept as "failed" so a
 * person can fix it.
 *
 * Pure functions, no DOM: usable in the browser (window.CordifyScanCore) and Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"));
  } else {
    root.CordifyScanCore = factory(root.CordifyCore);
  }
})(typeof self !== "undefined" ? self : this, function (C) {
  "use strict";

  /* ---------- what one written value looks like ---------- */

  const H = "[NSEW]";
  // A direction letter belongs to a value only on the same line, and never when it is
  // the start of a name such as "W-2" or "E.14" (which would flip the sign).
  const AFTER = `[ \\t]*\\b${H}\\b(?![-.\\d])`;
  const lead = `(?:\\b${H}\\b[ \\t]*)?`, trail = `(?:${AFTER})?`;
  // 26°55'24.3" N  (scanners often read ° as o or *)
  const DMS = `${lead}-?\\d{1,3}\\s*[°º˚*o]\\s*\\d{1,2}\\s*['′’‘\`´]\\s*\\d{1,2}(?:[.,]\\d+)?\\s*(?:"|″|”|“|''|′′)?${trail}`;
  // N 26 55 24.3  or  26 55 24.3 N  (no marks, so a letter is required)
  const DMS_BARE = `(?:\\b${H}\\b\\s*\\d{1,3}\\s+\\d{1,2}\\s+\\d{1,2}(?:\\.\\d+)?|\\d{1,3}\\s+\\d{1,2}\\s+\\d{1,2}(?:\\.\\d+)?${AFTER})`;
  // 26° 55.405' N
  const DDM = `${lead}-?\\d{1,3}\\s*[°º˚]\\s*\\d{1,2}[.,]\\d+\\s*['′’]?${trail}`;
  // 26.923417  (at least three decimals, or it is probably not a coordinate)
  const DD = `${lead}-?\\d{1,3}\\.\\d{3,}\\s*°?${trail}`;
  const VALUE = `(?:${DMS}|${DMS_BARE}|${DDM}|${DD})`;
  const PAIR = new RegExp(
    `(?:\\blat(?:itude)?\\b\\.?\\s*[:=-]?\\s*)?(${VALUE})\\s*(?:[,;/|]|\\band\\b)?\\s*(?:\\blon(?:g(?:itude)?)?\\b\\.?\\s*[:=-]?\\s*)?(${VALUE})`, "gi");

  /* ---------- tidying what the scanner read ---------- */

  // In a run that is clearly a number, O is 0 and l / I / | is 1. Same length, so
  // positions in the text still line up. Returns the positions that were changed.
  function fixDigits(text) {
    const changed = new Set();
    const out = text.replace(/[\dOolI|][\dOolI|.,]{2,}/g, (tok, at) => {
      if ((tok.match(/\d/g) || []).length < 2 || !/[OolI|]/.test(tok)) return tok;
      return tok.replace(/[OolI|]/g, (ch, i) => {
        // "26o55'..." is a degree sign read as o, not a zero: tidyValue deals with that one.
        if (/[Oo]/.test(ch) && /\d/.test(tok[i - 1] || "") && /^\d{1,2}\s*['′’‘`´]/.test(text.slice(at + i + 1, at + i + 6))) return ch;
        changed.add(at + i);
        return /[Oo]/.test(ch) ? "0" : "1";
      });
    });
    return { text: out, changed };
  }

  function tidyValue(v) {
    return v.trim()
      .replace(/[′’‘`´]/g, "'").replace(/[″”“]|''/g, '"')
      .replace(/[º˚*]/g, "°")
      .replace(/(\d)\s*o\s*(?=\d)/gi, "$1°")          // 26o55 -> 26°55
      .replace(/(\d),(\d)/g, "$1.$2")                  // decimal comma
      .replace(/\s+/g, " ");
  }
  const hemi = v => {
    const m = v.toUpperCase().match(/\b[NSEW]\b/);
    return m ? m[0] : "";
  };

  // Two written values -> a point, with how sure we are.
  function readPair(a, b) {
    a = tidyValue(a);
    b = tidyValue(b);
    const ha = hemi(a), hb = hemi(b);
    if (/[EW]/.test(ha) && /[NS]/.test(hb)) [ a, b ] = [ b, a ];   // letters decide the order
    const lat = C.parseCoord(a, "lat"), lon = C.parseCoord(b, "lon");
    if (lat !== null && lon !== null) return { lat, lon, status: "ok", note: "", text: `${a}, ${b}` };
    if (!ha && !hb) {
      const lat2 = C.parseCoord(b, "lat"), lon2 = C.parseCoord(a, "lon");
      if (lat2 !== null && lon2 !== null) return { lat: lat2, lon: lon2, status: "check", note: "longitude seems to be written first", text: `${a}, ${b}` };
    }
    return { lat: null, lon: null, status: "failed", note: "could not be read as a coordinate", text: `${a}, ${b}` };
  }

  // The words just before a coordinate on its line are usually its name ("GCP-01", "Well 3").
  function nameBefore(text, at) {
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    let s = text.slice(lineStart, at).replace(/\s+/g, " ").trim();
    s = s.replace(/[\s:;,|=\-–(]*\b(lat(itude)?|coord\w*|location|position|gps|at)\b[\s:;,|=\-–(]*$/i, "").replace(/[\s:;,|=\-–(]+$/, "").replace(/^[\s:;,|=\-–)\d.]*[.)]\s+/, "").trim();
    return s.length <= 40 ? s : "";
  }

  /*
   * findCoordinates(text) -> [ { index, end, raw, name, lat, lon, status, note, text } ]
   *   index/end  where it sits in the text given
   *   raw        exactly what was written there
   *   text       the tidied reading ("26° 55' 24.3\" N, 95° 2' 4.3\" E")
   *   status     "ok" | "check" (read, but look at it) | "failed" (looks like a coordinate, could not be read)
   */
  function findCoordinates(text) {
    text = String(text ?? "");
    const fixed = fixDigits(text);
    const out = [], seen = new Set();
    PAIR.lastIndex = 0;
    let m;
    while ((m = PAIR.exec(fixed.text))) {
      const index = m.index + m[0].indexOf(m[1]), end = m.index + m[0].replace(/\s+$/, "").length;
      const r = readPair(m[1], m[2]);
      // Two plain decimal numbers that are not a valid pair are just numbers, not a failed coordinate.
      const plain = v => /^\s*-?\d{1,3}\.\d+\s*$/.test(v);
      if (r.status === "failed" && plain(m[1]) && plain(m[2])) {
        PAIR.lastIndex = m.index + m[0].indexOf(m[2]);   // the second number may start a real pair
        continue;
      }
      let touched = false;
      for (let i = index; i < end && !touched; i++) touched = fixed.changed.has(i);
      if (touched && r.status === "ok") {
        r.status = "check";
        r.note = "letters were read as digits (O as 0, l as 1)";
      }
      const key = r.lat === null ? `x${index}` : `${r.lat.toFixed(9)},${r.lon.toFixed(9)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ index, end, raw: text.slice(index, end).replace(/\s+/g, " ").trim(), name: nameBefore(text, m.index), ...r });
    }
    return out;
  }

  // Re-read text a person has typed or corrected: "lat, lon" in any accepted form.
  function readTyped(s) {
    const found = findCoordinates(s);
    if (found.length === 1 && found[0].status !== "failed") return found[0];
    const parts = C.splitPair(s);
    if (parts) {
      const lat = C.parseCoord(parts[0], "lat"), lon = C.parseCoord(parts[1], "lon");
      if (lat !== null && lon !== null) return { lat, lon, status: "ok", note: "", text: `${parts[0]}, ${parts[1]}` };
    }
    return null;
  }

  return { findCoordinates, readTyped, readPair, fixDigits, nameBefore };
});
