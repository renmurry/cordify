/*
 * Cordify — Scan tab (Advanced mode)
 * Reads images, PDFs and text files on this device, finds the coordinates written
 * in them, and lets you check each one against a picture of where it was found
 * before adding it to a sheet. Nothing is uploaded.
 *
 *   PDFs with real text  -> the text is taken straight from the file (exact)
 *   scanned PDFs, photos -> the page is read with OCR (Tesseract), which makes mistakes
 *
 * The finding itself is in scan-core.js. The two libraries (assets/vendor) are only
 * loaded when the first document is added.
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const S = () => window.CordifyScanCore;
  const VENDOR = new URL("./assets/vendor/", document.baseURI).href;
  const SHOWN = 300;          // rows drawn in the review table
  const MAX_SIDE = 3200;      // largest image side sent to OCR, in pixels

  const state = { items: [], files: [], filter: "all", busy: false, cancelled: false, nextId: 1 };
  let ocr = null;

  /* ---------- libraries, loaded on first use ---------- */

  const loaded = {};
  function script(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = VENDOR + src;
        s.onload = resolve;
        s.onerror = () => {
          delete loaded[src];
          reject(new Error("library"));
        };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }
  async function pdfLib() {
    await script("pdfjs/pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + "pdfjs/pdf.worker.min.js";
    return window.pdfjsLib;
  }
  async function ocrWorker(onProgress) {
    await script("tesseract/tesseract.min.js");
    if (!ocr) {
      ocr = await window.Tesseract.createWorker("eng", 1, {
        workerPath: VENDOR + "tesseract/worker.min.js",
        corePath: VENDOR + "tesseract/",
        langPath: VENDOR + "tesseract/",
        gzip: true,
        logger: m => { if (m.status === "recognizing text" && ocr && ocr.onProgress) ocr.onProgress(m.progress); }
      });
    }
    ocr.onProgress = onProgress;
    return ocr;
  }
  async function stopOcr() {
    const w = ocr;
    ocr = null;
    if (w) {
      try {
        await w.terminate();
      } catch (e) {}
    }
  }

  /* ---------- reading one page ---------- */

  // Lines of text with where they sit on the page: [ { text, x0, y0, x1, y1 } ]
  async function ocrLines(canvas, onProgress) {
    const w = await ocrWorker(onProgress);
    const read = async psm => {
      await w.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await w.recognize(canvas);
      return (data.lines || []).map(l => ({ text: l.text.replace(/\s+$/, ""), x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 })).filter(l => l.text);
    };
    let lines = await read("3");   // automatic layout
    // A table read column by column separates each latitude from its longitude.
    // If values were seen but no pairs, read again strictly row by row.
    const text = lines.map(l => l.text).join("\n");
    if (!S().findCoordinates(text).length && (text.match(/\d{1,3}\.\d{3,}|\d{1,3}\s*[°º]\s*\d{1,2}/g) || []).length >= 2) {
      const rows = await read("6");
      if (S().findCoordinates(rows.map(l => l.text).join("\n")).length) lines = rows;
    }
    return lines;
  }

  // The text a PDF page already contains, grouped into lines.
  function pdfLines(content, viewport, lib) {
    const items = content.items.filter(it => it.str && it.str.trim()).map(it => {
      const t = lib.Util.transform(viewport.transform, it.transform);
      const h = Math.hypot(t[2], t[3]) || 10;
      return { str: it.str, x: t[4], y: t[5], w: it.width * viewport.scale, h };
    }).sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(it.y - last.y) < Math.max(it.h, last.h) * 0.5) last.items.push(it);
      else lines.push({ y: it.y, h: it.h, items: [ it ] });
    }
    return lines.map(l => {
      l.items.sort((a, b) => a.x - b.x);
      let text = "", end = null;
      for (const it of l.items) {
        if (end !== null && it.x - end > it.h * 0.2) text += " ";
        text += it.str;
        end = it.x + it.w;
      }
      const h = Math.max(...l.items.map(i => i.h));
      return { text: text.replace(/\s+/g, " ").trim(), x0: l.items[0].x, y0: l.y - h, x1: end, y1: l.y + h * 0.3 };
    }).filter(l => l.text);
  }

  // A small picture of the lines a coordinate was found on, so it can be checked by eye.
  function crop(canvas, boxes) {
    if (!canvas || !boxes.length) return "";
    const pad = 14;
    const x0 = Math.max(0, Math.min(...boxes.map(b => b.x0)) - pad), y0 = Math.max(0, Math.min(...boxes.map(b => b.y0)) - pad);
    const x1 = Math.min(canvas.width, Math.max(...boxes.map(b => b.x1)) + pad), y1 = Math.min(canvas.height, Math.max(...boxes.map(b => b.y1)) + pad);
    const w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) return "";
    const k = Math.min(1, 640 / w);
    const c = document.createElement("canvas");
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(canvas, x0, y0, w, h, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8);
  }

  // lines -> found points, each with its picture. getCanvas() is only called when something was found.
  async function collect(file, page, lines, getCanvas, how) {
    const starts = [];
    let text = "";
    for (const l of lines) {
      starts.push(text.length);
      text += l.text + "\n";
    }
    const found = S().findCoordinates(text);
    if (!found.length) return 0;
    const canvas = getCanvas ? await getCanvas() : null;
    for (const f of found) {
      const boxes = lines.filter((l, i) => starts[i] < f.end && starts[i] + l.text.length > f.index);
      state.items.push({
        id: state.nextId++, file, page, how, raw: f.raw, text: f.text, name: f.name, lat: f.lat, lon: f.lon,
        status: f.status, note: f.note, crop: crop(canvas, boxes), include: f.status !== "failed"
      });
    }
    return found.length;
  }

  function toCanvas(source, width, height) {
    const k = Math.min(1, MAX_SIDE / Math.max(width, height));
    const c = document.createElement("canvas");
    c.width = Math.round(width * k);
    c.height = Math.round(height * k);
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  /* ---------- reading one file ---------- */

  async function readPdf(file, entry, tick) {
    const lib = await pdfLib();
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    entry.pages = pdf.numPages;
    for (let p = 1; p <= pdf.numPages && !state.cancelled; p++) {
      const page = await pdf.getPage(p);
      const render = async scale => {
        const vp = page.getViewport({ scale });
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        // "print" makes PDF.js draw without waiting for screen frames, so reading
        // carries on when this tab is in the background.
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp, intent: "print" }).promise;
        return c;
      };
      const vp = page.getViewport({ scale: 2 });
      const lines = pdfLines(await page.getTextContent(), vp, lib);
      const letters = lines.reduce((n, l) => n + l.text.replace(/\s/g, "").length, 0);
      if (letters >= 20) {
        tick(`${file.name}: page ${p} of ${pdf.numPages}`, (p - 1) / pdf.numPages);
        entry.points += await collect(file.name, p, lines, () => render(2), "text");
      } else {
        // No text in the file: the page is a picture, so read it with OCR.
        entry.ocr = true;
        const c = await render(2.5);
        const read = await ocrLines(c, f => tick(`${file.name}: reading page ${p} of ${pdf.numPages}`, (p - 1 + f) / pdf.numPages));
        entry.points += await collect(file.name, p, read, async () => c, "ocr");
      }
      page.cleanup();
    }
    await pdf.destroy();
  }

  async function readImage(file, entry, tick) {
    const bmp = await createImageBitmap(file);
    const c = toCanvas(bmp, bmp.width, bmp.height);
    if (bmp.close) bmp.close();
    entry.pages = 1;
    entry.ocr = true;
    const lines = await ocrLines(c, f => tick(`${file.name}: reading`, f));
    entry.points += await collect(file.name, 1, lines, async () => c, "ocr");
  }

  async function readText(file, entry) {
    const buf = await file.arrayBuffer();
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch (e) {
      text = new TextDecoder("windows-1252").decode(buf);
    }
    entry.pages = 1;
    entry.points += await collect(file.name, 1, text.split(/\r?\n/).map(t => ({ text: t, x0: 0, y0: 0, x1: 0, y1: 0 })), null, "text");
  }

  async function onFiles(e) {
    const files = [ ...(e.target.files || []) ];
    e.target.value = "";
    if (!files.length || state.busy) return;
    state.busy = true;
    state.cancelled = false;
    $("scan-progress-wrap").hidden = false;
    $("scan-file").disabled = true;
    const before = state.items.length;
    for (let k = 0; k < files.length && !state.cancelled; k++) {
      const file = files[k];
      const entry = { name: file.name, pages: 0, points: 0, ocr: false, error: "" };
      state.files.push(entry);
      const tick = (text, share) => {
        $("scan-progress").value = (k + Math.max(0, Math.min(1, share || 0))) / files.length;
        $("scan-progress-text").textContent = text;
      };
      tick(`${file.name}: opening`, 0);
      try {
        if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") await readPdf(file, entry, tick);
        else if (/^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file.name)) await readImage(file, entry, tick);
        else await readText(file, entry);
      } catch (err) {
        if (!state.cancelled) {
          entry.error = /password/i.test(String(err && err.name) + String(err && err.message)) ? "is password-protected" : err && err.message === "library" ? "could not be read: a library did not load (reload the page and try again)" : "could not be read";
        }
      }
      renderFiles();
    }
    await stopOcr();   // frees the memory the reader used
    state.busy = false;
    $("scan-progress-wrap").hidden = true;
    $("scan-file").disabled = false;
    const added = state.items.length - before;
    status(state.cancelled ? `Stopped. ${added} point${added === 1 ? "" : "s"} found before stopping.` :
      added ? `Found ${added} point${added === 1 ? "" : "s"}. Check them below before adding them to a sheet.` : "No coordinates were found in these documents.", added ? "good" : "warn");
    render();
  }

  /* ---------- review ---------- */

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LABEL = { ok: "Read", check: "Check", failed: "Not read" };
  const BADGE = { ok: "st-ok", check: "st-choose", failed: "st-bad" };
  const dd = v => window.CordifyCore.formatDDText(v, 7);

  function status(text, kind) {
    const el = $("scan-status");
    el.className = "hint batch-status" + (kind ? " " + kind : "");
    el.textContent = text;
  }

  function renderFiles() {
    $("scan-files").innerHTML = state.files.map(f => `<li>${esc(f.name)} <span class="hint">— ${f.error ? esc(f.error) :
      `${f.pages} page${f.pages === 1 ? "" : "s"}, ${f.points} point${f.points === 1 ? "" : "s"} found${f.ocr ? " (read with OCR: check carefully)" : ""}`}</span></li>`).join("");
  }

  const visible = () => state.items.filter(x => state.filter === "all" || x.status === state.filter);

  function render() {
    const any = state.items.length > 0;
    $("scan-review").hidden = !any;
    $("scan-add").hidden = !any;
    if (!any) return;
    const n = k => state.items.filter(x => x.status === k).length;
    $("scan-chips").innerHTML = [ [ "all", "All", state.items.length ], [ "ok", "Read", n("ok") ], [ "check", "Check", n("check") ], [ "failed", "Not read", n("failed") ] ]
      .map(([ k, t, c ]) => `<button type="button" class="chip${state.filter === k ? " is-active" : ""}" data-filter="${k}">${t}<b>${c}</b></button>`).join("");
    const list = visible();
    $("scan-body").innerHTML = list.slice(0, SHOWN).map(x => `<tr data-id="${x.id}" class="${x.status === "failed" ? "st-bad" : x.status === "check" ? "st-choose" : ""}">
      <td><input type="checkbox" data-k="include" aria-label="Include this point"${x.include ? " checked" : ""}${x.lat === null ? " disabled" : ""}></td>
      <td class="scan-src">${x.crop ? `<img src="${x.crop}" alt="Where this was found in ${esc(x.file)}" loading="lazy">` : `<pre class="raw">${esc(x.raw)}</pre>`}<span class="hint">${esc(x.file)}${x.page > 1 || x.how !== "text" ? ` · page ${x.page}` : ""}</span></td>
      <td><input type="text" data-k="text" value="${esc(x.text)}" aria-label="Coordinate as read" spellcheck="false"><span class="hint scan-dd">${x.lat === null ? "" : `${dd(x.lat)}, ${dd(x.lon)}`}</span></td>
      <td><input type="text" data-k="name" value="${esc(x.name)}" aria-label="Name" placeholder="Name"></td>
      <td><span class="badge ${BADGE[x.status]}">${LABEL[x.status]}</span>${x.note ? `<br><span class="hint">${esc(x.note)}</span>` : ""}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="empty">No points in this view.</td></tr>`;
    $("scan-more").textContent = list.length > SHOWN ? `Showing the first ${SHOWN} of ${list.length}. All included points are added to the sheet.` : "";
    renderAdd();
  }

  function renderAdd() {
    const n = state.items.filter(x => x.include && x.lat !== null).length;
    $("scan-add-btn").disabled = !n;
    $("scan-add-btn").textContent = n ? `Add ${n} point${n === 1 ? "" : "s"} to the sheet` : "Add to the sheet";
    $("scan-map").disabled = !n;
    const Sh = window.CordifySheet;
    if (!Sh) return;
    const book = Sh.list(), sel = $("scan-sheet"), keep = sel.value;
    sel.innerHTML = book.list.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("") + `<option value="__new">New sheet…</option>`;
    sel.value = keep && [ ...sel.options ].some(o => o.value === keep) ? keep : book.active;
  }

  function onEdit(e) {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const x = state.items.find(i => i.id === +tr.dataset.id), k = e.target.dataset.k;
    if (!x || !k) return;
    if (k === "include") x.include = e.target.checked;
    else if (k === "name") x.name = e.target.value;
    else if (k === "text") {
      x.text = e.target.value;
      const r = S().readTyped(x.text);
      if (r) Object.assign(x, { lat: r.lat, lon: r.lon, status: r.status === "check" ? "check" : "ok", note: r.status === "check" ? r.note : "corrected by hand", include: true });
      else Object.assign(x, { lat: null, lon: null, status: "failed", note: "could not be read as a coordinate", include: false });
      if (e.type === "change") return render();
      // While typing, update only this row's readout so the cursor stays put.
      tr.querySelector(".scan-dd").textContent = x.lat === null ? "" : `${dd(x.lat)}, ${dd(x.lon)}`;
      tr.querySelector('[data-k="include"]').checked = x.include;
      tr.querySelector('[data-k="include"]').disabled = x.lat === null;
    }
    renderAdd();
  }

  /* ---------- add to a sheet ---------- */

  async function addToSheet() {
    const Sh = window.CordifySheet;
    const picked = state.items.filter(x => x.include && x.lat !== null);
    if (!Sh || !picked.length) return;
    let id = $("scan-sheet").value;
    if (id === "__new") {
      const name = prompt("Name for the new sheet:", (picked[0].file || "Scanned points").replace(/\.[^.]+$/, ""));
      if (!name || !name.trim()) return;
      id = await Sh.create(name.trim());
    }
    const total = await Sh.addPoints(picked.map(x => ({
      name: x.name.trim(), lat: x.lat, lon: x.lon, input: x.raw, source: x.how === "ocr" ? "Scan (OCR)" : "Scan (text)",
      remarks: x.status === "check" ? x.note : "", extra: { Document: x.file, Page: x.page }
    })), id);
    const done = new Set(picked.map(x => x.id));
    state.items = state.items.filter(x => !done.has(x.id));
    const name = (Sh.list().list.find(s => s.id === id) || {}).name || "the sheet";
    render();
    status(`Added ${picked.length} point${picked.length === 1 ? "" : "s"} to “${name}” (now ${total}). `, "good");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-quiet batch-repair";
    b.textContent = "Open the sheet";
    b.addEventListener("click", () => Sh.show());
    $("scan-status").append(b);
  }

  function showOnMap() {
    const picked = state.items.filter(x => x.include && x.lat !== null);
    if (!picked.length || !window.CordifyMap) return;
    window.CordifyMap.plotPoints(picked.map(x => x.lat), picked.map(x => x.lon), picked.map(x => `${x.name ? x.name + " · " : ""}${x.file}${x.page > 1 ? " p." + x.page : ""}`));
  }

  /* ---------- the tab ---------- */

  function init() {
    const box = $("advanced-mode"), tab = $("tab-scan");
    if (!box || !tab || !$("scan-tab")) return;
    let on = false;
    try {
      on = localStorage.getItem("cordify_advanced") === "1";
    } catch (e) {}
    tab.hidden = !on;
    box.addEventListener("change", () => {
      tab.hidden = !box.checked;
      if (!box.checked && window.CordifyTabs.current() === "scan") window.CordifyTabs.show("convert");
    });
    // Showing and hiding the tabs is tabs.js's job; the sheet list is refreshed when this tab is shown.
    window.CordifyTabs.onShow("scan", renderAdd);
    $("scan-file").addEventListener("change", onFiles);
    $("scan-cancel").addEventListener("click", () => {
      state.cancelled = true;
      stopOcr();
    });
    $("scan-chips").addEventListener("click", e => {
      const b = e.target.closest("[data-filter]");
      if (!b) return;
      state.filter = b.dataset.filter;
      render();
    });
    $("scan-body").addEventListener("input", onEdit);
    $("scan-body").addEventListener("change", onEdit);
    $("scan-add-btn").addEventListener("click", addToSheet);
    $("scan-map").addEventListener("click", showOnMap);
    $("scan-clear").addEventListener("click", () => {
      state.items = [];
      state.files = [];
      renderFiles();
      render();
      status("");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
