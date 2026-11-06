/*
 * Cordify — "Keep an Excel sheet" (Convert tab)
 * When switched on, every conversion you save (Enter or "Save to history") is also
 * added as a row: Name/ID, all formats (DD, DMS, DDM), source, input, date/time and
 * remarks. The sheet is previewed live, kept on this device until you clear it, can
 * be downloaded as .xlsx, and an existing Excel file can be loaded to continue it.
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const R = () => window.CordifyRepair;
  const KEY = "cordify_sheet_v1", ON_KEY = "cordify_sheet_on";
  const PREVIEW = 100;
  const OWN = [ "Name", "Lat_DD", "Lon_DD", "Lat_DMS", "Lon_DMS", "Lat_DDM", "Lon_DDM", "Source", "Input", "Added", "Remarks" ];

  let state = { rows: [], extraCols: [], fileName: "", nextId: 1 };
  let on = false, lastDeleted = null, pendingFile = null;

  /* ---------- storage (this device only) ---------- */

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (s && Array.isArray(s.rows)) state = { rows: s.rows, extraCols: s.extraCols || [], fileName: s.fileName || "", nextId: s.nextId || s.rows.length + 1 };
      on = localStorage.getItem(ON_KEY) === "1";
    } catch (e) {}
  }
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      note("This browser would not store the sheet (storage full or blocked). Download it now so nothing is lost.", "bad");
    }
  }

  /* ---------- formats ---------- */

  const secDigits = () => +($("precision-dms")?.value || 3);
  function cells(r) {
    const has = r.lat != null && r.lon != null;
    return {
      Name: r.name || "",
      // 7 decimals (about 1 cm) so DMS to 0.001" and DDM to 0.0001' survive a save and reload.
      Lat_DD: has ? R().formatDD(r.lat, 7) : "",
      Lon_DD: has ? R().formatDD(r.lon, 7) : "",
      Lat_DMS: has ? R().formatDMS(r.lat, "lat", secDigits()) : "",
      Lon_DMS: has ? R().formatDMS(r.lon, "lon", secDigits()) : "",
      Lat_DDM: has ? R().formatDDM(r.lat, "lat", 4) : "",
      Lon_DDM: has ? R().formatDDM(r.lon, "lon", 4) : "",
      Source: r.source || "",
      Input: r.input || "",
      Added: r.time ? new Date(r.time) : "",
      Remarks: r.remarks || ""
    };
  }
  const stamp = t => {
    const d = new Date(t), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /* ---------- adding (called by the converter on Enter / Save) ---------- */

  // "GCP-04" -> "GCP-05", "Point 9" -> "Point 10"; names without a number stay as they are.
  function nextName(name) {
    const m = String(name).match(/^(.*?)(\d+)(\D*)$/);
    if (!m) return name;
    const n = String(+m[2] + 1).padStart(m[2].length, "0");
    return m[1] + n + m[3];
  }

  function onSave(rec) {
    if (!on || rec.lat == null || rec.lon == null) return null;
    const name = $("sheet-name").value.trim(), remarks = $("sheet-remarks").value.trim();
    const dup = state.rows.findIndex(r => r.lat != null && Math.abs(r.lat - rec.lat) < 5e-7 && Math.abs(r.lon - rec.lon) < 5e-7);
    state.rows.push({ id: state.nextId++, name, remarks, lat: rec.lat, lon: rec.lon, source: rec.type, input: rec.input, time: Date.now(), extra: {} });
    persist();
    if (name && /\d/.test(name)) $("sheet-name").value = nextName(name);
    $("sheet-remarks").value = "";
    render();
    return dup >= 0 ? `Added to the sheet — note: same point as row ${dup + 1}${state.rows[dup].name ? " (" + state.rows[dup].name + ")" : ""}` : `Added to the sheet (${state.rows.length} point${state.rows.length > 1 ? "s" : ""})`;
  }

  /* ---------- preview ---------- */

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function render() {
    $("sheet-toggle").checked = on;
    $("sheet-fields").hidden = !on;
    $("sheet-card").hidden = !on;
    if (!on) return;
    const n = state.rows.length;
    $("sheet-count").textContent = n ? `${n} point${n > 1 ? "s" : ""}` : "empty";
    $("sheet-download").disabled = !n;
    $("sheet-clear").disabled = !n;
    const list = state.rows.map((r, i) => [ r, i ]).slice(-PREVIEW).reverse();   // newest first
    $("sheet-body").innerHTML = list.map(([ r, i ]) => {
      const c = cells(r);
      const has = r.lat != null;
      return `<tr${has ? "" : ' class="batch-fail"'}>
        <td class="hint">${i + 1}</td>
        <td>${esc(c.Name) || '<span class="hint">—</span>'}</td>
        <td class="num">${has ? `${c.Lat_DD}<br>${c.Lon_DD}` : '<span class="hint">no coordinate</span>'}</td>
        <td class="num">${has ? `${esc(c.Lat_DMS)}<br>${esc(c.Lon_DMS)}` : ""}</td>
        <td class="num">${has ? `${esc(c.Lat_DDM)}<br>${esc(c.Lon_DDM)}` : ""}</td>
        <td class="hint">${r.time ? stamp(r.time) : ""}</td>
        <td class="note">${esc(c.Remarks)}</td>
        <td><button type="button" class="btn-quiet sheet-del" data-i="${i}" aria-label="Delete row ${i + 1}" data-tip="Delete this row (you can undo).">✕</button></td>
      </tr>`;
    }).join("") || `<tr><td colspan="8" class="empty">No points yet. Convert a coordinate and press Enter or “Save to history”.</td></tr>`;
    $("sheet-more").textContent = n > PREVIEW ? `Showing the newest ${PREVIEW} of ${n} points. The download has all of them.` : "";
  }

  function note(text, kind, undo) {
    const el = $("sheet-status");
    el.className = "hint sheet-status" + (kind ? " " + kind : "");
    el.textContent = text;
    if (undo) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-quiet";
      b.textContent = "Undo";
      b.addEventListener("click", undo);
      el.append(" ", b);
    }
  }

  /* ---------- download ---------- */

  function download() {
    if (!state.rows.length || typeof XLSX === "undefined") return;
    const head = OWN.concat(state.extraCols);
    const aoa = [ head ];
    for (const r of state.rows) {
      const c = cells(r);
      aoa.push(OWN.map(k => c[k]).concat(state.extraCols.map(k => r.extra && r.extra[k] !== undefined ? r.extra[k] : "")));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: "yyyy-mm-dd hh:mm" });
    ws["!cols"] = head.map(h => ({ wch: h === "Input" || h === "Remarks" ? 30 : h.includes("DMS") || h.includes("DDM") ? 20 : h === "Added" ? 17 : 14 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Points");
    // Never reuse the loaded file's exact name, so the original is not mistaken for (or replaced by) this one.
    const base = state.fileName ? state.fileName.replace(/_updated$/, "") + "_updated" : "cordify_points";
    XLSX.writeFile(wb, `${base}.xlsx`);
  }

  /* ---------- load an existing file ---------- */

  const COL = {
    Name: /^(name|id|point|point ?(name|id|no)|label|site|station|gcp|no\.?)$/i,
    Remarks: /remark|note|comment|description/i,
    Source: /^source$/i,
    Input: /^input$/i,
    Added: /^(added|date|time|date ?time|timestamp)$/i
  };

  async function onLoadFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (typeof XLSX === "undefined" || !window.CordifyBatch) {
      note("The spreadsheet library did not load. Check your internet connection and reload.", "bad");
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      let wb;
      if (/\.csv$/i.test(file.name)) {
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        } catch (err) {
          text = new TextDecoder("windows-1252").decode(buf);
        }
        wb = XLSX.read(text.replace(/^﻿/, ""), { type: "string" });
      } else {
        wb = XLSX.read(buf, { type: "array", cellDates: true });
      }
      const parsed = parseWorkbook(wb);
      if (!parsed) {
        note("No rows found in this file.", "bad");
        return;
      }
      parsed.fileName = file.name.replace(/\.[^.]+$/, "");
      if (!state.rows.length) {
        apply(parsed, "replace");
      } else {
        pendingFile = parsed;
        $("sheet-choice-text").textContent = `The sheet already has ${state.rows.length} points. What should happen with the ${parsed.rows.length} rows from “${file.name}”?`;
        $("sheet-choice").hidden = false;
      }
    } catch (err) {
      note("Could not read this file. Use .xlsx, .xls or .csv.", "bad");
    }
  }

  // The sheet called "Points", else the first sheet with readable coordinates, else the first with data.
  function parseWorkbook(wb) {
    // Line breaks inside cells: plain "\n" (as Excel, QGIS and pandas read them), never "\r\n",
    // which would be written back as a literal "_x000d_" that some readers show.
    const noCR = v => typeof v === "string" ? v.replace(/\r\n?/g, "\n") : v;
    const sheets = wb.SheetNames.map(name => {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true }).map(r => r.map(noCR));
      const h = aoa.findIndex(r => r.some(c => String(c).trim() !== ""));
      return { name, aoa, h };
    }).filter(s => s.h >= 0 && s.aoa.length > s.h + 1);
    if (!sheets.length) return null;
    const B = window.CordifyBatch;
    let pick = sheets.find(s => /^points$/i.test(s.name));
    if (!pick) pick = sheets.find(s => B.detect(s.aoa[s.h].map(String), s.aoa.slice(s.h + 1, s.h + 60)).found) || sheets[0];
    const head = pick.aoa[pick.h].map((c, j) => String(c).replace(/\s+/g, " ").trim() || `Column ${j + 1}`);
    const data = pick.aoa.slice(pick.h + 1).filter(r => r.some(c => String(c).trim() !== ""));
    // Our own export: use its Lat_DD/Lon_DD directly. Otherwise detect the coordinate column(s).
    const latDD = head.indexOf("Lat_DD"), lonDD = head.indexOf("Lon_DD");
    const cfg = latDD >= 0 && lonDD >= 0 ? { mode: "two", lat: latDD, lon: lonDD } : B.detect(head, data.slice(0, 60));
    const used = new Set();
    const find = re => {
      const j = head.findIndex((x, k) => !used.has(k) && re.test(x));
      if (j >= 0) used.add(j);
      return j;
    };
    // Columns we write ourselves are recognised; everything else is kept as an extra column.
    OWN.forEach(k => {
      const j = head.indexOf(k);
      if (j >= 0) used.add(j);
    });
    const col = {
      Name: head.indexOf("Name") >= 0 ? head.indexOf("Name") : find(COL.Name),
      Remarks: head.indexOf("Remarks") >= 0 ? head.indexOf("Remarks") : find(COL.Remarks),
      Source: head.indexOf("Source"), Input: head.indexOf("Input"),
      Added: head.indexOf("Added") >= 0 ? head.indexOf("Added") : find(COL.Added)
    };
    if (cfg.found !== false) {
      if (cfg.mode === "one") used.add(cfg.one);
      else { used.add(cfg.lat); used.add(cfg.lon); }
    }
    const extraCols = head.filter((_, j) => !used.has(j));
    const extraIdx = head.map((_, j) => j).filter(j => !used.has(j));
    let readable = 0;
    const rows = data.map(r => {
      const res = cfg.found === false ? {} : B.readRow(r, cfg);
      const ok = res.lat !== undefined;
      if (ok) readable++;
      const extra = {};
      extraIdx.forEach((j, k) => { if (r[j] !== "") extra[extraCols[k]] = r[j]; });
      // The original coordinate text always goes in "Input", so nothing is lost.
      const raw = cfg.found === false ? "" : cfg.mode === "one" ? String(r[cfg.one] ?? "") : `${r[cfg.lat] ?? ""}  |  ${r[cfg.lon] ?? ""}`;
      let time = null;
      const t = col.Added >= 0 ? r[col.Added] : "";
      if (t instanceof Date) time = t.getTime();
      else if (t !== "" && !isNaN(Date.parse(t))) time = Date.parse(t);
      return {
        name: col.Name >= 0 ? String(r[col.Name] ?? "") : "", remarks: col.Remarks >= 0 ? String(r[col.Remarks] ?? "") : "",
        lat: ok ? res.lat : null, lon: ok ? res.lon : null,
        source: col.Source >= 0 && r[col.Source] ? String(r[col.Source]) : "Loaded from file",
        input: col.Input >= 0 ? String(r[col.Input] ?? "") : raw.trim() === "|" ? "" : raw, time, extra
      };
    });
    return { rows, extraCols, readable, sheet: pick.name };
  }

  function apply(parsed, how) {
    $("sheet-choice").hidden = true;
    pendingFile = null;
    if (how === "cancel") return;
    if (how === "replace") {
      state = { rows: [], extraCols: [], fileName: parsed.fileName, nextId: 1 };
    }
    for (const c of parsed.extraCols) if (!state.extraCols.includes(c)) state.extraCols.push(c);
    parsed.rows.forEach(r => state.rows.push({ id: state.nextId++, ...r }));
    if (!state.fileName) state.fileName = parsed.fileName;
    persist();
    const named = [ ...state.rows ].reverse().find(r => r.name && /\d/.test(r.name));
    if (named && !$("sheet-name").value) $("sheet-name").value = nextName(named.name);
    render();
    const bad = parsed.rows.length - parsed.readable;
    note(`Loaded ${parsed.rows.length} rows from sheet “${parsed.sheet}”` + (bad ? ` — ${bad} without a readable coordinate (kept; the original text is in the Input column)` : "") + ". New points will be added after them.", bad ? "warn" : "good");
  }

  /* ---------- wiring ---------- */

  function init() {
    if (!$("sheet-toggle")) return;
    load();
    $("sheet-toggle").addEventListener("change", e => {
      on = e.target.checked;
      try {
        localStorage.setItem(ON_KEY, on ? "1" : "0");
      } catch (err) {}
      render();
      if (on) $("sheet-name").focus();
    });
    // Enter in the Name/Remarks fields saves from the converter used last, like Enter there.
    let lastCard = "dms";
    document.querySelectorAll("#convert-tab .tool").forEach((card, k) => card.addEventListener("focusin", () => {
      lastCard = k === 0 ? "dms" : "dd";
    }));
    [ "sheet-name", "sheet-remarks" ].forEach(id => $(id).addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      $(lastCard === "dms" ? "btn-dms2dd" : "btn-dd2dms").click();
    }));
    $("sheet-download").addEventListener("click", download);
    $("sheet-load").addEventListener("change", onLoadFile);
    $("sheet-clear").addEventListener("click", () => {
      if (!state.rows.length) return;
      if (!confirm(`Clear all ${state.rows.length} points from the sheet? Download it first if you need it.`)) return;
      state = { rows: [], extraCols: [], fileName: "", nextId: 1 };
      persist();
      render();
      note("Sheet cleared.");
    });
    $("sheet-body").addEventListener("click", e => {
      const b = e.target.closest(".sheet-del");
      if (!b) return;
      const i = +b.dataset.i;
      lastDeleted = { row: state.rows[i], at: i };
      state.rows.splice(i, 1);
      persist();
      render();
      note(`Row ${i + 1} deleted.`, "", () => {
        if (!lastDeleted) return;
        state.rows.splice(lastDeleted.at, 0, lastDeleted.row);
        lastDeleted = null;
        persist();
        render();
        note("Row restored.", "good");
      });
    });
    $("sheet-choice").addEventListener("click", e => {
      const b = e.target.closest("[data-how]");
      if (b && pendingFile) apply(pendingFile, b.dataset.how);
    });
    $("precision-dms")?.addEventListener("change", render);
    render();
  }

  window.CordifySheet = { onSave };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
