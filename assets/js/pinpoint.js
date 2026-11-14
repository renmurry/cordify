/*
 * Cordify — Point to the exact wrong character
 * Reads a coordinate cell as typed and says which character breaks it, why, and what
 * it probably should be. Three formats are known: decimal degrees (26.189922),
 * degrees + decimal minutes (26°41.451') and degrees, minutes, seconds (26°41'27").
 * Every position refers to the cell exactly as typed (1 = first character).
 *
 * It never changes a value: it only explains. When two readings fit, both are given
 * and neither is chosen. No UI; also runs in Node and in the batch worker.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CordifyPinpoint = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LOOK_DEG = /[ᵒº˚⁰]/;
  const INVISIBLE = { "​": "a zero-width space", "‌": "an invisible joiner", "‍": "an invisible joiner", "﻿": "an invisible mark", "⁠": "an invisible joiner", "­": "a soft hyphen" };
  const MARK_KIND = ch => /°/.test(ch) ? 0 : /^(''|['’‘′`´ʹ])$/.test(ch) ? 1 : /["”“″ʺ]/.test(ch) ? 2 : -1;
  const MARK_TEXT = [ "°", "’", "”" ];
  const LETTER_DIGIT = { O: "0", o: "0", I: "1", l: "1", "|": "1", S: "5", B: "8" };
  const LABEL = /^(lat|latitude|long|longitude|lon|lng)$/i;
  const UNIT = /^(m|mtr|mtrs|metres?|meters?|ft|msl|amsl|elev|elevation|alt|altitude)$/i;
  const SEP = /^(\n|\r|;|\t)$/;

  const isD = ch => ch !== undefined && /\d/.test(ch);
  // A letter typed for a digit sits between digits (O, l, I may also touch a decimal point).
  function betweenDigits(c, i, pointOk) {
    const p = c[i - 1], n = c[i + 1];
    if (!pointOk) return isD(p) && isD(n);
    return (isD(p) || p === ".") && (isD(n) || n === ".") && (isD(p) || isD(n));
  }
  const show = ch => ch === "\t" ? "a tab" : ch === "\n" ? "a line break" : ch === " " ? "a space" : ch === " " ? "a no-break space" : `'${ch}'`;

  /*
   * Same-length clean-up of the text, so positions still match what was typed.
   * Returns { w, found[] } where found are problems and notes with positions.
   */
  function prepass(s) {
    const c = [ ...s ].length === s.length ? s.split("") : null;
    const found = [];
    if (!c) return { w: s, found };          // characters outside the basic plane: leave as is
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (LOOK_DEG.test(ch)) {
        found.push({ at: i, len: 1, kind: "note", why: `'${ch}' is read as a degree sign °` });
        c[i] = "°";
      } else if (INVISIBLE[ch]) {
        found.push({ at: i, len: 1, kind: "note", why: `${INVISIBLE[ch]} is ignored` });
        c[i] = " ";
      } else if (ch === " ") {
        c[i] = " ";
      } else if (LETTER_DIGIT[ch] && betweenDigits(c, i, /[OoIl|]/.test(ch))) {
        found.push({ at: i, len: 1, kind: "error", why: `the letter ${ch} is typed where the digit ${LETTER_DIGIT[ch]} belongs`, letter: true });
        c[i] = LETTER_DIGIT[ch];
      }
    }
    // "°" typed for "0" inside a number: 2°.87868, 22.7°4, 51.°9444, 28.2°°12
    let inFrac = false;
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (/\d/.test(ch)) continue;
      if (ch === ".") { inFrac = true; continue; }
      if (ch === "°") {
        const prevOk = /[\d.]/.test(c[i - 1] || ""), next = c[i + 1] || "";
        if (prevOk && /[\d.°]/.test(next) && (inFrac || next === ".")) {
          found.push({ at: i, len: 1, kind: "error", why: "° is typed inside a number, where 0 belongs", zero: true });
          c[i] = "0";
          continue;
        }
      }
      inFrac = false;
    }
    return { w: c.join(""), found };
  }

  // Tokens of the cleaned text, each with its position.
  const TOKEN = /(\d+(?:\.(?: +(?=\d))?\d*)*|\.\d+)|(°)|(''|['’‘′`´ʹ])|(["”“″ʺ])|([A-Za-z]+)|(\n|\r|;|\t)|(,)|( +)|([\s\S])/g;
  function tokens(w) {
    const out = [];
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(w))) {
      const t = { at: m.index, len: m[0].length, text: m[0] };
      if (m[1] !== undefined) t.type = "num";
      else if (m[2] || m[3] || m[4]) { t.type = "mark"; t.mark = MARK_KIND(m[0]); }
      else if (m[5] !== undefined) t.type = /^[NSEW]$/i.test(m[5]) ? "hemi" : LABEL.test(m[5]) ? "label" : UNIT.test(m[5]) ? "unit" : "word";
      else if (m[6] !== undefined) t.type = "sep";
      else if (m[7] !== undefined) t.type = "comma";
      else if (m[8] !== undefined) t.type = "space";
      else t.type = "other";
      out.push(t);
    }
    return out;
  }

  // The cell's tokens -> values (each a run of tokens), with the separators between them.
  function valuesOf(toks, w) {
    const decimalComma = !w.includes(".") && /\d,\d/.test(w);
    const chunks = [ [] ], seps = [];
    for (const t of toks) {
      if (t.type === "sep" || t.type === "comma" && !decimalComma) {
        seps.push(t);
        chunks.push([]);
      } else {
        chunks[chunks.length - 1].push(t);
      }
    }
    let vals = chunks.map(ch => ch.filter(t => t.type !== "label"))
      .filter(ch => ch.some(t => t.type === "num"));
    // Elevation: a number with a unit (893m), or a third whole number.
    const isElev = ch => ch.some(t => t.type === "unit") && ch.filter(t => t.type === "num").length === 1;
    const elevation = vals.filter(isElev);
    vals = vals.filter(ch => !isElev(ch));
    if (vals.length === 1) vals = splitOne(vals[0]);
    if (vals.length === 3) {
      const last = vals[2].filter(t => t.type === "num");
      if (last.length === 1 && !vals[2].some(t => t.type === "mark" || t.type === "hemi") && /^\d+$/.test(last[0].text) && +last[0].text > 180) {
        elevation.push(vals.pop());
      }
    }
    return { vals, seps, elevation, decimalComma };
  }

  // One run holding both values: split at N/S/E/W letters, at a repeated °, or between plain numbers.
  function splitOne(run) {
    const hemis = run.map((t, i) => t.type === "hemi" ? i : -1).filter(i => i >= 0);
    const firstReal = run.findIndex(t => t.type !== "space");
    if (hemis.length === 2) {
      const cut = hemis[0] === firstReal ? hemis[1] : hemis[0] + 1;
      return [ run.slice(0, cut), run.slice(cut) ].filter(r => r.some(t => t.type === "num"));
    }
    const nums = run.map((t, i) => t.type === "num" ? i : -1).filter(i => i >= 0);
    const degs = run.map((t, i) => t.type === "mark" && t.mark === 0 ? i : -1).filter(i => i >= 0);
    if (degs.length === 2) {
      const cut = nums.filter(i => i < degs[1]).pop();
      if (cut > 0) return [ run.slice(0, cut), run.slice(cut) ];
    }
    if (!run.some(t => t.type === "mark") && nums.length >= 2 && nums.length % 2 === 0 && nums.length <= 6) {
      const cut = nums[nums.length / 2];
      return [ run.slice(0, cut), run.slice(cut) ];
    }
    return [ run ];
  }

  const isLatHemi = h => /^[NS]$/i.test(h);
  const limit = role => role === "lat" ? 90 : 180;

  // One value's tokens -> problems and possible readings.
  function checkValue(run, role, w, found) {
    const errors = [];
    const err = (at, len, why, readings) => errors.push({ at, len: Math.max(1, len), kind: "error", why, readings: readings || [] });
    const hemiTok = run.find(t => t.type === "hemi");
    if (hemiTok) role = isLatHemi(hemiTok.text) ? "lat" : "lon";
    const which = role === "lat" ? "latitude" : "longitude";
    for (const t of run) {
      if (t.type === "word") err(t.at, t.len, `the letters '${t.text}' don't belong in a coordinate`);
      const sign = /^[-+−–]$/.test(t.text) && run.find(u => u.type === "num" || u.type === "other") === t;
      if (t.type === "other" && t.text !== "." && !sign) err(t.at, t.len, `${show(t.text)} doesn't belong in a coordinate`);
      if (t.type === "other" && t.text === "." && !run.some(u => u.type === "hemi" && Math.abs(u.at - t.at) === 1)) {
        err(t.at, 1, "a decimal point with no digits after it");
      }
    }
    // Numbers with the mark typed after each.
    const comps = [];
    for (let k = 0; k < run.length; k++) {
      const t = run[k];
      if (t.type === "num") {
        const prev = comps[comps.length - 1];
        if (t.text.startsWith(".") && prev && prev.mark) {
          // 26°26'.257 — the mark is typed before the decimal point
          err(prev.mark.at, prev.mark.len, `${prev.mark.text} is typed before the decimal point; it belongs after ${prev.digits}${t.text}`);
          errors[errors.length - 1].rewrite = true;
          prev.order = true;
          prev.digits += t.text;
          prev.end = t.at + t.len;
          continue;
        }
        comps.push({ digits: t.text.replace(/ /g, ""), at: t.at, len: t.len, end: t.at + t.len, text: t.text, mark: null });
      } else if (t.type === "mark") {
        const prev = comps[comps.length - 1];
        if (!prev) err(t.at, t.len, `${t.text} comes before any number`);
        else if (!prev.mark) prev.mark = t;
        // else: the closing mark after 26°26'.257", or a doubled mark: nothing to add
      }
    }
    if (!comps.length) return { errors, role };
    // Space after a decimal point: 95. 165864
    for (const c of comps) {
      const sp = c.text.search(/\. +\d/);
      if (sp >= 0) err(c.at + sp + 1, c.text.slice(sp + 1).search(/\d/), "a space is typed after the decimal point");
      if (sp >= 0) errors[errors.length - 1].rewrite = true;
    }
    for (const e of errors) if (e.rewrite) { e.readings = [ rebuild(comps, run) ]; delete e.rewrite; }
    if (comps.length > 3) {
      err(comps[3].at, comps[3].len, `${which} has ${comps.length} numbers; at most 3 (degrees, minutes, seconds) are expected`);
      return { errors, role };
    }
    // Marks in the wrong place: 26°10°29.0838' (second ° should be ')
    comps.forEach((c, i) => {
      if (c.mark && c.mark.mark >= 0 && c.mark.mark !== i) {
        if (i > 0 && c.mark.mark === 0) err(c.mark.at, c.mark.len, `a second °; this one should be ${MARK_TEXT[i]}`, [ rebuild(comps, run) ]);
        else if (i === 0 && c.mark.mark > 0 && comps.length > 1) err(c.mark.at, c.mark.len, `${c.mark.text} is typed where ° belongs`, [ rebuild(comps, run) ]);
      }
    });

    // Two decimal points in one number
    const multi = comps.findIndex(c => (c.digits.match(/\./g) || []).length > 1);
    if (multi >= 0) {
      const c = comps[multi], p1 = c.text.indexOf("."), p2 = c.text.indexOf(".", p1 + 1);
      const [ a, b, d ] = c.digits.split(".");
      if (multi === 0 && comps.length === 1 && b.length === 2 && +b < 60 && +a <= limit(role)) {
        err(c.at + p1, 1, "this point should be °", [ withHemi(run, `${a}°${b}.${d}’`) ]);
      } else {
        err(c.at + p2, 1, "a second decimal point in one number");
      }
      return { errors, role };
    }

    const num = c => parseFloat(c.digits);
    const intOf = c => c.digits.split(".")[0];
    const fracOf = c => c.digits.includes(".") ? c.digits.split(".")[1] : "";
    const c0 = comps[0], c1 = comps[1], c2 = comps[2];

    // Degrees and the next digits typed together: N2665.997, E09474.976, 26123456
    if (num(c0) > limit(role)) {
      const int = intOf(c0), frac = fracOf(c0);
      const lead = int.match(/^0*/)[0].length;
      const degLen = role === "lat" ? 2 : (+int.slice(lead, lead + 3) <= 180 && int.length - lead >= 4 ? 3 : 2);
      const dEnd = lead + degLen;
      if (comps.length === 1 && int.length > dEnd) {
        const deg = int.slice(0, dEnd), rest = int.slice(dEnd);
        const readings = [];
        if (rest.length === 2 && +rest < 60) readings.push(withHemi(run, `${deg}°${rest}${frac ? "." + frac : ""}’`));
        readings.push(withHemi(run, `${deg}.${rest}${frac}`));
        const why = frac ? `the decimal point is in the wrong place: the degrees are ${deg}, so the point (or a °) belongs after them` :
          `no decimal point: the degrees are ${deg}, so the point (or a °) belongs after them`;
        err(c0.at + dEnd, 1, why, readings);
      } else {
        err(c0.at, c0.len, `${which} can't be over ${limit(role)} (typed ${c0.digits})`);
      }
      return { errors, role };
    }
    if (c1) {
      const m = num(c1), int1 = intOf(c1), frac1 = fracOf(c1);
      const sep0 = c0.mark ? c0.mark : { at: c1.at, len: 1, text: "" };
      if (fracOf(c0)) {
        err(c0.at + c0.text.indexOf("."), 1, "the degrees have a decimal point, yet minutes follow");
      } else if (!frac1 && int1.length >= 3 && !c2) {
        // 26°189922' — the ° is where the decimal point goes (or minutes with the point missing)
        const readings = [ withHemi(run, `${c0.digits}.${int1}`) ];
        if (+int1.slice(0, 2) < 60) readings.push(withHemi(run, `${c0.digits}°${int1.slice(0, 2)}.${int1.slice(2)}’`));
        err(sep0.at, sep0.len, `${sep0.text || "the space"} is followed by ${int1}, which can't be minutes (two digits, 0–59): the ° is probably the decimal point`, readings);
      } else if (m >= 60 && int1.length >= 3 && !c2) {
        // 94°4757.08472' — minutes and seconds typed together
        const mm = int1.slice(0, 2), ss = int1.slice(2) + (frac1 ? "." + frac1 : "");
        const ok = +mm < 60 && parseFloat(ss) < 60;
        err(c1.at + 2, 1, `minutes can't be ${c1.digits}: the minutes are probably ${mm} and a ’ is missing after them`, ok ? [ withHemi(run, `${c0.digits}°${mm}’${ss}”`) ] : []);
      } else if (m >= 60) {
        err(c1.at, c1.len, `minutes can't be ${c1.digits} (0–59)`);
      } else if (c2) {
        const s = num(c2), int2 = intOf(c2), frac2 = fracOf(c2);
        const sep1 = c1.mark ? c1.mark : { at: c2.at, len: 1, text: "" };
        if (frac1) {
          err(c1.at + c1.text.indexOf("."), 1, "the minutes have a decimal point, yet seconds follow");
        } else if (!frac2 && int2.length >= 3) {
          // 26°41'451 — the ' is where the decimal point goes (or a point is missing in the seconds)
          const readings = [ withHemi(run, `${c0.digits}°${c1.digits}.${int2}’`) ];
          if (+int2.slice(0, 2) < 60) readings.push(withHemi(run, `${c0.digits}°${c1.digits}’${int2.slice(0, 2)}.${int2.slice(2)}”`));
          err(sep1.at, sep1.len, `${sep1.text || "the space"} is followed by ${int2}, which can't be seconds (two digits, 0–59): the ’ is probably the decimal point`, readings);
        } else if (s >= 60) {
          err(c2.at, c2.len, `seconds can't be ${c2.digits} (0–59)`);
        }
      }
    }
    if (!errors.length && num(c0) > limit(role)) err(c0.at, c0.len, `${which} can't be over ${limit(role)}`);
    return { errors, role };

    // The value written back in a corrected form, from its parts.
    // Each number gets the mark its position calls for: ° then ’ then ”.
    function rebuild(cs, r) {
      return withHemi(r, cs.map((c, i) => c.digits + (c.mark || i < cs.length - 1 ? MARK_TEXT[i] : "")).join(""));
    }
  }

  // Keeps the N/S/E/W letter where it was typed.
  function withHemi(run, body) {
    const h = run.find(t => t.type === "hemi");
    if (!h) return body;
    const firstNum = run.find(t => t.type === "num");
    return h.at < firstNum.at ? `${h.text.toUpperCase()} ${body}` : `${body} ${h.text.toUpperCase()}`;
  }

  /*
   * explain(text, role?) -> { problems: [{at, len, kind: "error"|"note", why, readings[]}], summary, readings }
   * role: "lat" or "lon" for a cell holding one value; omit for a cell holding both.
   */
  function explain(text, role) {
    const s = String(text ?? "");
    const { w, found } = prepass(s);
    const toks = tokens(w);
    const { vals, seps } = valuesOf(toks, w);
    const problems = found.slice();
    // Pre-pass fixes become readings of their value.
    if (role) {
      if (vals.length > 1) {
        const at = vals[1][0].at;
        problems.push({ at, len: 1, kind: "error", why: `this cell should hold only the ${role === "lat" ? "latitude" : "longitude"}, but has ${vals.length} values`, readings: [] });
      } else if (vals.length === 1) {
        problems.push(...checkValue(vals[0], role, w, found).errors);
      }
    } else if (vals.length === 1) {
      problems.push({ at: vals[0][0].at, len: s.trimEnd().length - vals[0][0].at, kind: "error", why: "only one value is here; latitude and longitude are both needed", readings: [] });
    } else if (vals.length > 2) {
      const between = seps.filter(t => t.at > vals[0][0].at && t.at < vals[vals.length - 1][0].at);
      const tab = between.find(t => t.text === "\t");
      const at = tab ? tab.at : vals[2][0].at;
      problems.push({ at, len: 1, kind: "error", why: `the cell holds ${vals.length} values instead of 2${tab ? "; this tab joins two of them" : ""}`, readings: [] });
    } else if (vals.length === 2) {
      vals.forEach((v, i) => problems.push(...checkValue(v, i === 0 ? "lat" : "lon", w, found).errors));
    }
    // A value whose only problems came from the pre-pass: its reading is the cleaned text.
    for (const p of problems) {
      if ((p.letter || p.zero) && !p.readings) {
        const v = vals.find(v => v[0].at <= p.at && v[v.length - 1].at + v[v.length - 1].len > p.at);
        p.readings = v ? [ w.slice(v[0].at, v[v.length - 1].at + v[v.length - 1].len).trim() ] : [];
      }
      p.readings = p.readings || [];
    }
    problems.sort((a, b) => a.at - b.at || (a.kind === "error" ? -1 : 1));
    const errors = problems.filter(p => p.kind === "error");
    return { problems, errors: errors.length, summary: summaryOf(errors), text: s };
  }

  function summaryOf(errors) {
    if (!errors.length) return "";
    const one = p => {
      const r = p.readings;
      return `character ${p.at + 1}: ${p.why}` + (r.length === 1 ? ` → ${r[0]}` : r.length > 1 ? ` — two readings fit: ${r[0]} or ${r[1]}` : "");
    };
    return errors.slice(0, 2).map(one).join("; ") + (errors.length > 2 ? `; and ${errors.length - 2} more` : "");
  }

  // The "lat  |  lon" text Batch shows for two-column rows, or one cell's text.
  const JOIN = "  |  ";
  function explainShown(raw) {
    const s = String(raw ?? "");
    const j = s.indexOf(JOIN);
    if (j < 0) return [ { offset: 0, r: explain(s) } ];
    return [ { offset: 0, r: explain(s.slice(0, j), "lat") }, { offset: j + JOIN.length, r: explain(s.slice(j + JOIN.length), "lon") } ];
  }

  // HTML of the text with the problem characters marked (esc: the page's HTML escaper).
  function markup(raw, esc) {
    const s = String(raw ?? "");
    const marks = [];
    for (const { offset, r } of explainShown(s)) {
      for (const p of r.problems) marks.push({ ...p, at: p.at + offset });
    }
    if (!marks.length) return esc(s);
    marks.sort((a, b) => a.at - b.at);
    let out = "", i = 0;
    for (const m of marks) {
      if (m.at < i) continue;
      out += esc(s.slice(i, m.at));
      const piece = s.slice(m.at, m.at + m.len);
      const shown = /^\s+$/.test(piece) ? piece.replace(/\t/g, "⇥").replace(/\n/g, "↵\n").replace(/ /g, "·") : piece;
      const tip = m.why + (m.readings && m.readings.length ? ` → ${m.readings.join(" or ")}` : "");
      out += `<mark class="pin pin-${m.kind}" title="${esc(tip)}">${esc(shown)}</mark>`;
      i = m.at + m.len;
    }
    return out + esc(s.slice(i));
  }

  return { explain, explainShown, markup, summaryOf };
});
