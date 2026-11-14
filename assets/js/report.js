/*
 * Cordify — Scan first: a short report on a file before anything is converted
 * Reads every coordinate row the way Batch would and says, in three to five plain
 * bullet points: what was found, how many rows read as typed and why the rest did
 * not, whether a sheet is in another coordinate system, what ticking "typing
 * habits" or opening Repair would settle, and which converted rows deserve a look.
 *
 * Nothing is changed and nothing is guessed: every number comes from the same
 * reading the conversion itself would do. No UI; also runs in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./batch-core.js"), require("./habits.js"), require("./systems.js"));
  } else {
    root.CordifyReport = factory(root.CordifyBatchCore, root.CordifyHabits, root.CordifySystems);
  }
})(typeof self !== "undefined" ? self : this, function (B, H, S) {
  "use strict";

  const MAX_BULLETS = 5, MIN_BULLETS = 3;
  const SYS_SAMPLE = 400;       // rows per sheet looked at to find the coordinate system
  const OK_ENOUGH = 0.9;        // a sheet read this well as degrees needs no system question

  const count = n => Number(n).toLocaleString("en-US");
  const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many || one + "s"}`;
  const q = s => `“${s}”`;
  const list = a => a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
  const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
  const medianOf = a => {
    const s = Float64Array.from(a).sort(), m = s.length >> 1;
    return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
  };
  const kmBetween = (lat1, lon1, lat2, lon2) => {
    const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  };

  // Why a row could not be read, in a handful of families.
  function familyOf(res) {
    const e = res.error || "";
    if (/two readings fit/.test(e)) return "two";
    if (/swapped/.test(e)) return "swap";
    if (/missing|only one value/.test(e)) return "missing";
    if (res.mistyped) return "wrong";
    return "other";
  }

  /*
   * One sheet, read row by row. sheet: { name, head, mode, one, lat, lon, found, system?, rows, total? }
   * rows: the data rows (header removed, blank rows dropped) as arrays of cells; total: the
   * sheet's row count when `rows` is only a sample of it.
   */
  function scanSheet(sheet, opts) {
    const st = { name: sheet.name, found: sheet.found !== false, rows: 0, empty: 0, ok: 0, failed: 0,
      two: 0, swap: 0, missing: 0, wrong: 0, other: 0, settle: 0, habits: [], check: 0, far: 0, dup: 0, rough: 0, coarse: 0,
      system: sheet.system || null, suggest: null, lat: [], lon: [], sample: !!(sheet.sample || (sheet.total && sheet.total > sheet.rows.length)) };
    if (!st.found) return st;
    const cfg = { mode: sheet.mode, one: sheet.one, lat: sheet.lat, lon: sheet.lon, system: sheet.system || null, datum: opts.datum || null };
    const n = sheet.rows.length;
    const lat = new Float64Array(n), lon = new Float64Array(n), status = new Uint8Array(n), precision = new Float32Array(n);
    const results = new Array(n), swapped = [];
    for (let i = 0; i < n; i++) {
      const res = B.readRow(sheet.rows[i], cfg);
      results[i] = res;
      status[i] = B.statusOf(res);
      if (res.empty) {
        st.empty++;
        lat[i] = lon[i] = precision[i] = NaN;
        continue;
      }
      st.rows++;
      if (res.lat !== undefined) {
        st.ok++;
        lat[i] = res.lat;
        lon[i] = res.lon;
        precision[i] = res.precision;
        st.lat.push(res.lat);
        st.lon.push(res.lon);
      } else {
        st.failed++;
        lat[i] = lon[i] = precision[i] = NaN;
        const f = familyOf(res);
        st[f]++;
        if (f === "swap") swapped.push(i);
      }
    }
    // Converted rows worth a second look, the way Batch marks them.
    const checks = B.qualityChecks(lat, lon, status, precision, sheet.rows.map((_, i) => i + 1));
    st.check = checks.size;
    for (const text of checks.values()) {
      if (/far from/.test(text)) st.far++;
      if (/same position/.test(text)) st.dup++;
      if (/low precision/.test(text)) st.rough++;
    }
    if (checks.coarse) st.coarse = checks.coarse;
    // Typing habits: what ticking the box would settle among the rows with two readings.
    if (H && !cfg.system) {
      const cells = r => cfg.mode === "one" ? [ r[cfg.one] ] : [ r[cfg.lat], r[cfg.lon] ];
      const rowOf = r => {
        const c = cells(r);
        return cfg.mode === "one" ? { text: String(c[0] ?? "") } : { lat: String(c[0] ?? ""), lon: String(c[1] ?? "") };
      };
      const used = sheet.rows.filter((_, i) => status[i] !== B.EMPTY);
      const habits = H.learn(used.map(rowOf));
      st.habits = habits.filter(h => h.n >= H.MIN_ROWS);
      if (st.two) {
        for (let i = 0; i < n; i++) {
          if (status[i] < B.FAILED || familyOf(results[i]) !== "two") continue;
          if (H.decide(rowOf(sheet.rows[i]), habits)) st.settle++;
        }
      }
    }
    // Another coordinate system? Only asked about a sheet that does not read well as degrees.
    if (S && !cfg.system && st.rows) {
      const okShare = st.ok / st.rows;
      const nearZero = st.lat.some((la, k) => Math.abs(la) < 1.6 && Math.abs(st.lon[k]) < 3.2);
      if (okShare <= OK_ENOUGH || nearZero) {
        const ids = [];
        const step = Math.max(1, Math.ceil(n / SYS_SAMPLE));
        for (let i = 0; i < n; i += step) if (status[i] !== B.EMPTY) ids.push(i);
        const cells = r => (cfg.mode === "one" ? [ r[cfg.one] ] : [ r[cfg.lat], r[cfg.lon] ]).map(c => c ?? "");
        const head = (cfg.mode === "one" ? [ sheet.head[cfg.one] ] : [ sheet.head[cfg.lat], sheet.head[cfg.lon] ]).map(h => String(h ?? ""));
        const share = ids.length ? ids.filter(i => swapped.includes(i)).length / ids.length : 0;
        st.suggest = S.detect(ids.map(i => ({ cells: cells(sheet.rows[i]) })), opts.ref || null, { swapped: share, head }) || null;
      }
    }
    return st;
  }

  // How the coordinates sit in the sheet: "separate Lat and Lon columns (“Lat”, “Long”)".
  function columnsText(sheets) {
    const kinds = new Map();
    for (const s of sheets) {
      if (s.found === false) continue;
      const k = s.mode === "one" ? `one column (${q(String(s.head[s.one] ?? ""))})` : `separate columns (${q(String(s.head[s.lat] ?? ""))}, ${q(String(s.head[s.lon] ?? ""))})`;
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    const parts = [ ...kinds ].sort((a, b) => b[1] - a[1]).map(([ k, n ]) => sheets.length > 1 && kinds.size > 1 ? `${k} in ${plural(n, "sheet")}` : k);
    return parts.length ? `Coordinates are in ${list(parts)}.` : "";
  }

  /*
   * scan(sheets, opts) -> { bullets: [{ text, kind, act? }], text, stats }
   * sheets: see scanSheet. opts: { ref, datum, habitsOn, many } — ref: where the points must be
   * (see systems.detect); habitsOn: whether "Use typing habits" is already ticked.
   * kind: "ok" | "warn" | "bad" | "tip". act: a thing the page can offer to do:
   *   { type: "system", sheet, system } | { type: "habits" } | { type: "repair" }
   */
  function scan(sheets, opts = {}) {
    const stats = sheets.map(s => scanSheet(s, opts));
    const used = stats.filter(s => s.found), noCol = stats.filter(s => !s.found).map(s => s.name);
    const sum = k => used.reduce((a, s) => a + s[k], 0);
    const rows = sum("rows"), ok = sum("ok"), failed = sum("failed"), empty = sum("empty");
    // Failures of a sheet that looks like another system are explained by that, not by their characters.
    const plain = used.filter(s => !s.suggest), sumPlain = k => plain.reduce((a, s) => a + s[k], 0);
    const inSys = used.filter(s => s.suggest).reduce((a, s) => a + s.failed, 0);
    const two = sumPlain("two"), swap = sumPlain("swap"), missing = sumPlain("missing"), wrong = sumPlain("wrong"), other = sumPlain("other");
    const settle = sum("settle"), check = sum("check"), far = sum("far"), dup = sum("dup"), rough = sum("rough");
    const many = sheets.length > 1;
    const sampled = used.some(s => s.sample);
    const bullets = [];

    // 1. What was found
    {
      const parts = [ (many ? `${plural(sheets.length, "sheet")}, ` : "") + `${plural(rows, "row")} with coordinates` + (empty ? ` (${plural(empty, "empty row")} skipped)` : "") + (sampled ? ", read from a sample of the file" : "") + "." ];
      const cols = columnsText(sheets);
      if (cols) parts.push(cols);
      if (noCol.length) parts.push(`No coordinate column was found in ${list(noCol.map(q))}.`);
      bullets.push({ text: parts.join(" "), kind: rows ? (noCol.length ? "warn" : "ok") : "bad" });
    }
    if (!rows) {
      bullets.push({ text: "Nothing to convert: no cell holds a pair of coordinates. Check that the right sheet is ticked and that the coordinate column has a heading such as Latitude / Longitude or GPS.", kind: "bad" });
      return finish(bullets, stats);
    }

    // 2. How many read as typed, and why the rest did not
    {
      let t = `${count(ok)} of ${plural(rows, "row")} (${pct(ok, rows)}%) read as typed.`;
      if (failed) {
        const why = [];
        if (two) why.push(`${count(two)} ${two === 1 ? "has" : "have"} two possible readings`);
        if (wrong) why.push(`${count(wrong)} ${wrong === 1 ? "has" : "have"} a wrong character`);
        if (missing) why.push(`${count(missing)} ${missing === 1 ? "is" : "are"} missing one value`);
        if (swap) why.push(`${count(swap)} look${swap === 1 ? "s" : ""} swapped (longitude first)`);
        if (other) why.push(`${count(other)} ${other === 1 ? "has" : "have"} no readable numbers`);
        if (inSys) why.push(`${count(inSys)} ${inSys === 1 ? "is" : "are"} in another coordinate system (next point)`);
        t += ` ${count(failed)} could not be read: ${list(why)}.`;
      }
      bullets.push({ text: t, kind: !failed ? "ok" : pct(ok, rows) >= 80 || inSys === failed ? "warn" : "bad" });
    }

    // 3. Another coordinate system, per sheet
    const sys = used.filter(s => s.suggest || s.system);
    if (sys.length) {
      const parts = [], acts = [];
      for (const s of sys) {
        const lab = many ? `${q(s.name)} ` : "";
        if (s.system) parts.push(`${lab}${many ? "is" : "are"} read as ${S.labelOf(s.system)}`);
        else if (s.suggest.system) {
          parts.push(`${lab}look${many ? "s" : ""} like ${s.suggest.label} (${s.suggest.why}): choose it before converting`);
          acts.push({ type: "system", sheet: s.name, system: s.suggest.system, label: s.suggest.label });
        } else parts.push(`${lab}hold${many ? "s" : ""} ${s.suggest.label}: ${s.suggest.why}`);
      }
      const text = (many ? "" : "The values ") + list(parts) + ".";
      bullets.push({ text: text.charAt(0).toUpperCase() + text.slice(1), kind: sys.some(s => s.suggest) ? "warn" : "ok", acts });
    }

    // 4. What would settle the rows that did not read
    const fixable = failed - inSys;   // rows a different system does not explain
    if (fixable) {
      const ways = used.reduce((a, s) => a + s.habits.length, 0);
      const top = used.flatMap(s => s.habits).sort((a, b) => b.n - a.n)[0];
      let t = "", acts = [];
      if (two) {
        t = ways > 1 ? `Rows were typed ${plural(ways, "way")} (most often ${H.describe(top)}). ` : ways === 1 ? `Rows are all typed the same way (${H.describe(top)}). ` : "";
        if (settle) {
          t += opts.habitsOn ? `“Use typing habits” is ticked and settles ${count(settle)} of the ${plural(two, "row")} with two readings; they are marked orange to check.`
            : `Ticking “Use typing habits to choose between readings” would settle ${count(settle)} of the ${plural(two, "row")} with two readings (marked orange to check).`;
          if (!opts.habitsOn) acts.push({ type: "habits" });
        } else t += `Typing habits would not settle the ${plural(two, "row")} with two readings: no other rows are typed the same way.`;
        const rest = fixable - settle;
        if (rest) t += ` Repair, with a boundary or village list, is the way to fix the ${rest === fixable ? plural(rest, "row") : `other ${plural(rest, "row")}`}.`;
      } else {
        t = `Open Repair to fix the ${plural(fixable, "row")} that could not be read; a boundary file or village list makes its fixes reliable.`;
      }
      if (fixable - settle > 0) acts.push({ type: "repair" });
      bullets.push({ text: t.trim(), kind: "tip", acts });
    }

    // 5. Converted rows worth a look
    if (check || used.some(s => s.coarse)) {
      const why = [];
      if (far) why.push(`${count(far)} far from the rest of ${many ? "their sheet" : "the sheet"} (often a wrong degree digit)`);
      if (dup) why.push(`${count(dup)} at the same position as another row`);
      if (rough) why.push(`${count(rough)} typed much more roughly than the rest`);
      let t = check ? `${plural(check, "converted row")} ${check === 1 ? "is" : "are"} worth a look: ${list(why)}.` : "";
      const coarse = used.filter(s => s.coarse);
      if (coarse.length) t += ` ${list(coarse.map(s => (many ? q(s.name) : "The sheet") + ` is typed to only about ${B.nice(s.coarse)} throughout`))}.`;
      bullets.push({ text: t.trim(), kind: "warn" });
    }

    // Where the points sit: a sanity check, when there is room for it
    if (bullets.length < MAX_BULLETS && ok >= 1) {
      const lats = used.flatMap(s => s.lat), lons = used.flatMap(s => s.lon);
      const la = medianOf(lats), lo = medianOf(lons);
      const spread = medianOf(lats.map((v, i) => kmBetween(v, lons[i], la, lo)));
      const near = s => Math.abs(s) >= 10 ? Math.abs(s).toFixed(1) : Math.abs(s).toFixed(2);
      const t = `Points sit around ${near(la)}° ${la < 0 ? "S" : "N"}, ${near(lo)}° ${lo < 0 ? "W" : "E"}` + (ok >= 3 ? `, most within about ${spread >= 10 ? Math.round(spread) : Math.max(1, +spread.toFixed(1))} km of there.` : ".");
      bullets.push({ text: t, kind: "ok" });
    }
    return finish(bullets.slice(0, MAX_BULLETS), stats);
  }

  function finish(bullets, stats) {
    // Fewer than three bullets means a file with nothing (or next to nothing) to read.
    if (bullets.length < MIN_BULLETS) {
      bullets.push({ text: "Once the coordinates are found, Convert all rows adds the formats you tick as new columns and lists any row that cannot be read with the reason.", kind: "tip" });
    }
    return { bullets, text: bullets.map(b => `• ${b.text}`).join("\n"), stats };
  }

  /*
   * On the page: draws a report into `box`. opts.onAct(act) runs an offered action; acts
   * opts.show(act) rejects are not drawn. "Copy report" copies the bullets as plain text.
   */
  function render(box, result, opts = {}) {
    const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const label = a => a.type === "system" ? `Read as ${a.label}` : a.type === "habits" ? "Tick “Use typing habits”" : a.type === "repair" ? "Open Repair" : "";
    const show = opts.show || (() => true);
    box.innerHTML = `<div class="scan-report-head"><strong>Scan report</strong> <span class="hint">nothing is converted or changed by a scan</span></div><ul>` +
      result.bullets.map((b, i) => `<li class="rep-${esc(b.kind)}">${esc(b.text)}` +
        (b.acts || []).map((a, k) => show(a) && opts.onAct ? ` <button type="button" class="btn-quiet rep-act" data-bullet="${i}" data-act="${k}">${esc(label(a))}</button>` : "").join("") + "</li>").join("") +
      `</ul><div class="actions"><button type="button" data-do="copy">Copy report</button><button type="button" class="btn-quiet" data-do="close">Close</button></div>`;
    box.hidden = false;
    box.onclick = e => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.do === "close") {
        box.hidden = true;
      } else if (b.dataset.do === "copy") {
        copyText(result.text).then(ok => {
          b.textContent = ok ? "Copied" : "Could not copy";
          setTimeout(() => { b.textContent = "Copy report"; }, 1500);
        });
      } else if (b.dataset.act !== undefined) {
        const act = (result.bullets[+b.dataset.bullet].acts || [])[+b.dataset.act];
        if (act) opts.onAct(act);
      }
    };
  }

  function copyText(text) {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return Promise.resolve(ok);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  return { scan, scanSheet, familyOf, render, MAX_BULLETS, MIN_BULLETS };
});
