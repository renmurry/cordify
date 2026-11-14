/*
 * Cordify — Typing habits
 * Rows typed the same way were almost always typed by one person or one GPS unit, so
 * they mean the same format. This learns each habit from the rows that read clearly
 * (as typed, or with one possible reading) and uses it to choose between two readings
 * of a mistyped cell, e.g. 26°41'451: 26°41.451' or 26°41'45.1".
 *
 * A habit is: the mark characters used (° ' " or ′ ″ or ᵒ …), the separator between
 * latitude and longitude, where N/E letters sit, whether an elevation follows, and the
 * format with its number of decimals. A column often holds several habits, so the
 * format that is most common in the column is never used on its own.
 *
 * Order of evidence: the other value in the same cell, then a habit with the same mark
 * characters. Nothing else is guessed. Optional (the user ticks it); no UI; also runs
 * in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./core.js"), require("./repair-engine.js"), require("./pinpoint.js"));
  } else {
    root.CordifyHabits = factory(root.CordifyCore, root.CordifyRepair, root.CordifyPinpoint);
  }
})(typeof self !== "undefined" ? self : this, function (C, R, P) {
  "use strict";

  const MIN_ROWS = 3;   // a habit seen fewer times than this is not trusted
  const FORMAT_NAME = { DD: "decimal degrees", DDM: "degrees + decimal minutes", DMS: "degrees, minutes, seconds" };
  const SEP_NAME = { "\n": "line breaks", ",": "comma", ";": "semicolon", "\t": "tab", " ": "space", "|": "two columns" };

  // Format and decimals of one value's text: "26°41.451’" -> { fmt: "DDM", dec: 3 }
  function formatOf(text) {
    const n = String(text).match(/\d+(?:\.\d+)?/g) || [];
    if (!n.length) return null;
    return { fmt: [ "DD", "DD", "DDM", "DMS" ][Math.min(n.length, 3)], dec: (n[n.length - 1].split(".")[1] || "").length };
  }

  // How a row was typed, apart from its numbers. row: { text } or { lat, lon } (two cells).
  function featuresOf(row) {
    const two = row.text === undefined;
    const all = two ? `${row.lat ?? ""}\u0000${row.lon ?? ""}` : String(row.text ?? "");
    const marks = [ ...new Set(all.match(/[°ᵒº˚⁰'’‘′`´ʹ"”“″ʺ]/g) || []) ].sort().join("");
    let sep = "|";
    if (!two) {
      const m = all.trim().match(/\d[^\d\n,;\t]*?([\n,;\t])/) || all.trim().match(/\d\S*?( )\S*\d/);
      sep = m ? m[1] : " ";
    }
    const first = two ? String(row.lat ?? "") : all;
    const hemi = /^\s*[NSEW](?![A-Za-z])/i.test(first) ? "before" : /\d[^A-Za-z\d\n,;]*[NSEW](?![A-Za-z])/i.test(first) ? "after" : "none";
    const elev = /\d\s*(?:m|mtr|mtrs|metres?|meters?|ft)\b/i.test(two ? "" : all);
    return { marks, sep, hemi, elev };
  }

  // Each value of a row with the readings it can have: [{ role, options: [{ text, fmt, dec }] }]
  function valuesOf(row) {
    const cells = row.text === undefined ? [ [ row.lat, "lat" ], [ row.lon, "lon" ] ] : [ [ row.text, undefined ] ];
    const out = [];
    for (const [ t, role ] of cells) {
      const r = P.explain(String(t ?? ""), role);
      if (!r.values) return null;
      for (const v of r.values) {
        let options;
        if (!v.errors.length) options = [ v.text ];
        else if (v.errors.some(e => !e.readings.length)) return null;
        else options = v.errors[0].readings;
        out.push({ role: v.role, options: options.map(text => ({ text, ...formatOf(text) })).filter(o => o.fmt) });
      }
    }
    return out.length === 2 && out.every(v => v.options.length) ? out : null;
  }

  const keyOf = (f, s) => `${f.fmt}.${f.dec}\u0000${s.marks}\u0000${s.sep}\u0000${s.hemi}\u0000${s.elev}`;

  /*
   * learn(rows) -> habits: the ways rows were typed, each with how many rows and the format.
   * Rows that read clearly count: as typed, or with only one possible reading.
   */
  function learn(rows) {
    const map = new Map();
    for (const row of rows) {
      const vals = valuesOf(row);
      if (!vals || vals.some(v => v.options.length !== 1)) continue;
      const f = vals[0].options[0], s = featuresOf(row);
      if (vals[1].options[0].fmt !== f.fmt) continue;   // a cell typed two ways teaches nothing
      const k = keyOf(f, s);
      const h = map.get(k) || { fmt: f.fmt, dec: f.dec, ...s, n: 0 };
      h.n++;
      map.set(k, h);
    }
    return [ ...map.values() ].sort((a, b) => b.n - a.n);
  }

  // "° ’, comma, N/E after, elevation"
  function describe(h) {
    const parts = [];
    const order = ch => /[°ᵒº˚⁰]/.test(ch) ? 0 : /["”“″ʺ]/.test(ch) ? 2 : 1;
    if (h.marks) parts.push(h.marks.split("").sort((a, b) => order(a) - order(b)).join(" "));
    if (SEP_NAME[h.sep] && h.sep !== "|") parts.push(SEP_NAME[h.sep]);
    if (h.hemi !== "none") parts.push(`N/E ${h.hemi}`);
    if (h.elev) parts.push("elevation");
    return parts.join(", ") || "plain numbers";
  }
  const nameOf = h => `${FORMAT_NAME[h.fmt]}${h.dec ? `, ${h.dec} decimal${h.dec === 1 ? "" : "s"}` : ""}`;

  /*
   * decide(row, habits) -> null, or { texts: [latText, lonText], lat, lon, rule, why, habit? }
   * Only rows with two readings are decided. The result is a reading to check, not a fact.
   */
  function decide(row, habits) {
    const vals = valuesOf(row);
    if (!vals || !vals.some(v => v.options.length > 1)) return null;
    const fmts = vals.map(v => new Set(v.options.map(o => o.fmt)));
    const common = [ ...fmts[0] ].filter(f => fmts[1].has(f));
    let fmt = null, rule = null, habit = null;
    if (common.length === 1) {
      fmt = common[0];
      rule = "cell";
    } else if (common.length > 1 && habits && habits.length) {
      const s = featuresOf(row);
      const amb = vals.find(v => v.options.length > 1);
      // Only a habit with the same mark characters is the same habit.
      const scored = common.map(f => {
        const o = amb.options.find(x => x.fmt === f);
        const best = habits.filter(h => h.fmt === f && h.dec === o.dec && h.marks === s.marks && h.n >= MIN_ROWS)
          .map(h => ({ h, score: (h.sep === s.sep) + (h.hemi === s.hemi) + (h.elev === s.elev) }))
          .sort((a, b) => b.score - a.score || b.h.n - a.h.n)[0];
        return { f, best };
      }).filter(x => x.best);
      if (scored.length === 1) {
        fmt = scored[0].f;
        habit = scored[0].best.h;
        rule = "habit";
      } else if (scored.length > 1) {
        scored.sort((a, b) => b.best.score - a.best.score || b.best.h.n - a.best.h.n);
        if (scored[0].best.score > scored[1].best.score) {
          fmt = scored[0].f;
          habit = scored[0].best.h;
          rule = "habit";
        }
      }
    }
    if (!fmt) return null;
    const texts = vals.map(v => (v.options.find(o => o.fmt === fmt) || {}).text);
    if (texts.some(t => !t)) return null;
    const num = (t, role) => C.parseCoord(R.cleanText(t).text, role);
    const lat = num(texts[0], vals[0].role), lon = num(texts[1], vals[1].role);
    if (lat === null || lon === null) return null;
    const [ la, lo ] = vals[0].role === "lon" ? [ lon, lat ] : [ lat, lon ];
    const why = rule === "cell" ?
      `the other value in this cell is typed as ${FORMAT_NAME[fmt]}, so this one is too → ${texts.join(", ")}` :
      `typed like ${habit.n} other rows (${describe(habit)}), which are ${nameOf(habit)} → ${texts.join(", ")}`;
    return { texts, lat: la, lon: lo, rule, why, habit };
  }

  // One line per habit, for the "Typing habits found" summary.
  function summary(habits, max = 6) {
    return habits.filter(h => h.n >= MIN_ROWS).slice(0, max).map(h => `${h.n} rows: ${nameOf(h)} (${describe(h)})`);
  }

  return { learn, decide, summary, featuresOf, formatOf, describe, MIN_ROWS };
});
