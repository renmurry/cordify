/*
 * Cordify — Repair tab (Advanced mode)
 * Boundary upload (KML / KMZ / zipped Shapefile / GeoJSON), coordinate input
 * (Excel / CSV / pasted text), linking groups to polygons, review and export.
 * The repair logic itself lives in repair-engine.js.
 */
(function () {
  "use strict";
  const R = window.CordifyRepair;
  const $ = id => document.getElementById(id);
  const PAGE = 50;
  const STATUS = {
    ok: { label: "Unchanged", cls: "st-ok" },
    fixed: { label: "Corrected", cls: "st-fixed" },
    choose: { label: "Check", cls: "st-choose" },
    outside: { label: "Outside", cls: "st-bad" },
    failed: { label: "Not fixed", cls: "st-bad" },
    empty: { label: "Empty", cls: "st-empty" },
    confirmed: { label: "Checked", cls: "st-confirmed" },
    guess: { label: "Best guess", cls: "st-choose" },
    placed: { label: "Placed by you", cls: "st-confirmed" },
    rejected: { label: "Rejected", cls: "st-bad" }
  };
  const COLORS = { placed: "#1565c0", guess: "#e07b00", ok: "#2e7d32", fixed: "#c99700", choose: "#e07b00", outside: "#c62828", failed: "#c62828", confirmed: "#1565c0", rejected: "#c62828" };

  const state = {
    src: [], features: [], fieldKeys: [], nameField: "",
    source: "file", workbook: null, fileName: "", sheets: {}, rows: [],
    links: {}, learned: {}, results: [], decisions: new Map(),
    filter: "all", page: 0, map: null, boundaryLayer: null, pointLayer: null,
    estimated: false, userSrc: [], userFeatures: [], boundaryName: "",
    flags: new Map(), placing: null, dirty: false, pendingResume: null,
    places: null, placesList: [], placesName: "", placesLayer: null, drawing: null
  };

  /* ---------------- Advanced mode + tab ---------------- */

  function initAdvanced() {
    const box = $("advanced-mode");
    const tab = $("tab-repair");
    if (!box || !tab) {
      return;
    }
    let on = false;
    try {
      on = localStorage.getItem("cordify_advanced") === "1";
    } catch (e) {}
    box.checked = on;
    tab.hidden = !on;
    box.addEventListener("change", () => {
      tab.hidden = !box.checked;
      try {
        localStorage.setItem("cordify_advanced", box.checked ? "1" : "0");
      } catch (e) {}
      if (!box.checked && $("repair-tab").style.display !== "none") {
        $("tab-convert").click();
      }
    });
    tab.addEventListener("click", showRepairTab);
    [ "tab-convert", "tab-map", "tab-history" ].forEach(id => $(id)?.addEventListener("click", () => {
      $("repair-tab").style.display = "none";
      tab.classList.remove("is-active");
    }));
  }

  function showRepairTab() {
    [ "convert-tab", "history-tab", "map-tab" ].forEach(id => {
      const el = $(id);
      if (el) {
        el.style.display = "none";
      }
    });
    document.querySelectorAll(".tabs .tab-btn").forEach(b => b.classList.remove("is-active"));
    $("tab-repair").classList.add("is-active");
    $("repair-tab").style.display = "";
    if (state.pendingDraw) {
      state.pendingDraw = false;
      drawBoundary();
    }
    if (state.map) {
      setTimeout(() => {
        state.map.invalidateSize();
        if (!state.fitted) {
          fitMap();
          state.fitted = true;
        }
      }, 50);
    }
  }

  /* ---------------- helpers ---------------- */

  function setStatus(id, text, kind) {
    const el = $(id);
    if (!el) {
      return;
    }
    el.textContent = text;
    el.className = "hint" + (kind ? " " + kind : "");
  }
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = v => v == null ? "" : (+v).toFixed(6);
  const featureLabel = f => {
    const nm = state.nameField && f.props ? f.props[state.nameField] : null;
    if (nm) return `${nm}`;
    // An unnamed polygon is easier to recognise by the group (sheet or district) linked to it.
    const linked = Object.entries(state.links || {}).filter(([ , v ]) => v !== "all" && v !== "" && v != null && +v === f.index).map(([ g ]) => g);
    return `Polygon ${f.index + 1}` + (linked.length ? ` · ${linked.join(", ")}` : "");
  };
  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 300);
  }

  /* ---------------- boundary readers ---------------- */

  async function readBoundary(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".kml")) {
      return parseKml(await file.text());
    }
    if (name.endsWith(".kmz") || name.endsWith(".zip")) {
      if (typeof JSZip === "undefined") {
        throw new Error("The zip library did not load. Check your internet connection and reload.");
      }
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const files = Object.values(zip.files).filter(f => !f.dir);
      const kml = files.find(f => /\.kml$/i.test(f.name));
      const shp = files.find(f => /\.shp$/i.test(f.name));
      if (shp) {
        const base = shp.name.replace(/\.shp$/i, "");
        const pick = ext => files.find(f => f.name.toLowerCase() === (base + ext).toLowerCase()) || files.find(f => f.name.toLowerCase().endsWith(ext));
        const prj = pick(".prj");
        if (prj) {
          const wkt = await prj.async("string");
          if (/PROJCS/i.test(wkt)) {
            throw new Error("This shapefile is in a projected system (for example UTM). Export it in WGS84 (EPSG:4326) latitude/longitude and try again.");
          }
        }
        const dbf = pick(".dbf");
        const cpg = pick(".cpg");
        const enc = cpg ? (await cpg.async("string")).trim() : "";
        return parseShapefile(await shp.async("arraybuffer"), dbf ? await dbf.async("arraybuffer") : null, enc);
      }
      if (kml) {
        return parseKml(await kml.async("string"));
      }
      throw new Error("No .kml or .shp file was found inside this zip.");
    }
    if (name.endsWith(".geojson") || name.endsWith(".json")) {
      return parseGeoJson(JSON.parse(await file.text()));
    }
    throw new Error("Use a KML, KMZ, zipped Shapefile or GeoJSON file.");
  }

  function parseKml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) {
      throw new Error("This KML file could not be read.");
    }
    const out = [];
    const ringOf = el => {
      const c = el.getElementsByTagNameNS("*", "coordinates")[0];
      if (!c) return null;
      const pts = c.textContent.trim().split(/\s+/).map(t => t.split(",").slice(0, 2).map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
      return pts.length >= 3 ? pts : null;
    };
    for (const pm of doc.getElementsByTagNameNS("*", "Placemark")) {
      const rings = [];
      for (const poly of pm.getElementsByTagNameNS("*", "Polygon")) {
        for (const b of [ ...poly.getElementsByTagNameNS("*", "outerBoundaryIs"), ...poly.getElementsByTagNameNS("*", "innerBoundaryIs") ]) {
          const r = ringOf(b);
          if (r) rings.push(r);
        }
      }
      if (!rings.length) {
        continue;
      }
      const props = {};
      const nm = [ ...pm.children ].find(c => c.localName === "name");
      if (nm && nm.textContent.trim()) {
        props.name = nm.textContent.trim();
      }
      for (const d of pm.getElementsByTagNameNS("*", "Data")) {
        const v = d.getElementsByTagNameNS("*", "value")[0];
        if (d.getAttribute("name") && v) props[d.getAttribute("name")] = v.textContent.trim();
      }
      for (const d of pm.getElementsByTagNameNS("*", "SimpleData")) {
        if (d.getAttribute("name")) props[d.getAttribute("name")] = d.textContent.trim();
      }
      out.push({ props, rings });
    }
    return out;
  }

  function parseGeoJson(gj) {
    const feats = gj.type === "FeatureCollection" ? gj.features : gj.type === "Feature" ? [ gj ] : [ { type: "Feature", properties: {}, geometry: gj } ];
    const out = [];
    for (const f of feats) {
      const g = f && f.geometry;
      if (!g) continue;
      let rings = [];
      if (g.type === "Polygon") rings = g.coordinates;
      else if (g.type === "MultiPolygon") rings = g.coordinates.flat();
      else continue;
      out.push({ props: f.properties || {}, rings: rings.map(r => r.map(p => [ +p[0], +p[1] ])) });
    }
    return out;
  }

  function parseShapefile(shpBuf, dbfBuf, encoding) {
    const dv = new DataView(shpBuf);
    const shapes = [];
    let pos = 100;
    while (pos + 8 <= dv.byteLength) {
      const len = dv.getInt32(pos + 4, false) * 2;
      const start = pos + 8;
      pos = start + len;
      if (len < 4 || pos > dv.byteLength) break;
      const type = dv.getInt32(start, true);
      if (type === 0) {
        shapes.push(null);
        continue;
      }
      if (type !== 5 && type !== 15 && type !== 25) {
        shapes.push(null);
        continue;
      }
      const nParts = dv.getInt32(start + 36, true), nPoints = dv.getInt32(start + 40, true);
      const parts = [];
      for (let i = 0; i < nParts; i++) parts.push(dv.getInt32(start + 44 + i * 4, true));
      const ptsAt = start + 44 + nParts * 4;
      const rings = [];
      for (let i = 0; i < nParts; i++) {
        const a = parts[i], b = i + 1 < nParts ? parts[i + 1] : nPoints;
        const ring = [];
        for (let k = a; k < b; k++) ring.push([ dv.getFloat64(ptsAt + k * 16, true), dv.getFloat64(ptsAt + k * 16 + 8, true) ]);
        if (ring.length >= 3) rings.push(ring);
      }
      shapes.push(rings);
    }
    const records = dbfBuf ? parseDbf(dbfBuf, encoding) : [];
    const out = [];
    shapes.forEach((rings, i) => {
      if (rings && rings.length) out.push({ props: records[i] || {}, rings });
    });
    return out;
  }

  function parseDbf(buf, encoding) {
    const dv = new DataView(buf);
    const n = dv.getUint32(4, true), headLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true);
    let dec;
    try {
      dec = new TextDecoder(/utf-?8/i.test(encoding) || !encoding ? "utf-8" : encoding);
    } catch (e) {
      dec = new TextDecoder("utf-8");
    }
    const fields = [];
    for (let p = 32; p < headLen - 1 && dv.getUint8(p) !== 0x0d; p += 32) {
      const name = new TextDecoder("latin1").decode(new Uint8Array(buf, p, 11)).replace(/\0.*$/, "").trim();
      fields.push({ name, type: String.fromCharCode(dv.getUint8(p + 11)), len: dv.getUint8(p + 16) });
    }
    const out = [];
    for (let r = 0; r < n; r++) {
      let p = headLen + r * recLen + 1;
      const rec = {};
      for (const f of fields) {
        let v = dec.decode(new Uint8Array(buf, p, f.len)).trim();
        if (f.type === "N" || f.type === "F") v = v === "" ? null : +v;
        rec[f.name] = v;
        p += f.len;
      }
      out.push(rec);
    }
    return out;
  }

  // Uses a boundary: src is [ { name, rings, props } ]. nameField: the attribute that holds the
  // area names, or undefined to guess it.
  function useBoundary(src, name, nameField) {
    state.src = state.userSrc = src;
    state.boundaryName = name;
    state.features = state.userFeatures = src.map((f, i) => R.buildFeature({ rings: f.rings, props: f.props }, i));
    state.estimated = false;
    const keys = new Set();
    src.forEach(f => Object.keys(f.props || {}).forEach(k => keys.add(k)));
    state.fieldKeys = [ ...keys ];
    const guess = nameField !== undefined && (nameField === "" || keys.has(nameField)) ? nameField :
      state.fieldKeys.find(k => /dist|dtname|^name$|name_?2|block|region|area/i.test(k)) || state.fieldKeys.find(k => /name/i.test(k)) || "";
    const sel = $("rp-namefield");
    sel.innerHTML = `<option value="">No names — use polygon numbers</option>` + state.fieldKeys.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join("");
    sel.value = guess;
    state.nameField = guess;
    $("rp-namefield-wrap").hidden = false;
    // The map measures itself when drawn, so a boundary restored while the tab is hidden waits.
    if ($("repair-tab").style.display === "none") state.pendingDraw = true;
    else drawBoundary();
    refreshLinks();
  }

  /* ---------- the boundary, remembered on this device ---------- */

  // Kept in this browser's IndexedDB (db.js), like history. Nothing is uploaded.
  const SAVED_KEY = "cordify_boundary_v1";
  const DB = () => window.CordifyDB;

  async function saveBoundary() {
    try {
      if (!DB() || !await DB().ready) return false;
      await DB().set(SAVED_KEY, { name: state.boundaryName, src: state.userSrc, nameField: state.nameField, savedAt: Date.now() });
      return true;
    } catch (e) {
      return false;
    }
  }

  // Status line for the boundary, with a button to forget the saved one.
  function boundaryStatus(text, kind, saved) {
    setStatus("rp-boundary-status", text, kind);
    $("rp-boundary-download").hidden = !state.userSrc.length;
    if (!saved) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-quiet";
    b.textContent = "Forget it";
    b.setAttribute("data-tip", "Removes the saved boundary from this device. Repair then estimates the area from the correct rows until you load a boundary again.");
    b.addEventListener("click", forgetBoundary);
    $("rp-boundary-status").append(" ", b);
  }
  const polygons = n => `${n} polygon${n === 1 ? "" : "s"}`;

  async function restoreBoundary() {
    if (!DB() || !await DB().ready) return;
    let saved = null;
    try {
      saved = await DB().get(SAVED_KEY);
    } catch (e) {}
    // A file chosen while this was loading wins.
    if (!saved || !Array.isArray(saved.src) || !saved.src.length || state.userSrc.length) return;
    try {
      useBoundary(saved.src, saved.name, saved.nameField);
    } catch (e) {
      return;
    }
    const when = new Date(saved.savedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    boundaryStatus(`Using your saved boundary “${saved.name}” (${polygons(saved.src.length)}), saved on this device on ${when}. Choose another file to replace it.`, "good", true);
  }

  async function forgetBoundary() {
    try {
      if (DB() && await DB().ready) await DB().del("kv", SAVED_KEY);
    } catch (e) {}
    state.src = state.userSrc = [];
    state.features = state.userFeatures = [];
    state.boundaryName = "";
    state.nameField = "";
    state.fieldKeys = [];
    state.pendingDraw = false;
    if (state.boundaryLayer) {
      state.boundaryLayer.remove();
      state.boundaryLayer = null;
    }
    $("rp-boundary").value = "";
    $("rp-boundary-download").hidden = true;
    $("rp-namefield-wrap").hidden = true;
    setStatus("rp-boundary-status", "Saved boundary forgotten. Without one, Repair estimates the area from the rows that are typed correctly.");
    refreshLinks();
  }

  /* ---------- village locations (optional) ---------- */

  const Ref = () => window.CordifyReference;

  function usePlaces(list, name) {
    state.placesList = list;
    state.places = R.buildPlaces(list);
    state.placesName = name;
    drawPlaces();
  }

  // "120 places loaded — 85 of the 90 villages in your data are in it."
  function placesSummary() {
    const p = state.places;
    if (!p) return "";
    const amb = p.ambiguous ? ` (${p.ambiguous} name${p.ambiguous === 1 ? "" : "s"} appear in two places far apart without a district, so they are left out)` : "";
    let match = "";
    if (state.rows && state.rows.length) {
      const villages = new Map();
      state.rows.forEach(r => { if (r.village) villages.set(`${r.group}|${R.placeKey(r.village)}`, r); });
      const found = [ ...villages.values() ].filter(r => R.placeFor(p, r)).length;
      const missing = [ ...villages.values() ].filter(r => !R.placeFor(p, r)).map(r => r.village);
      match = villages.size ? ` ${found} of the ${villages.size} villages in your data are in it` + (missing.length ? `; not found: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ` and ${missing.length - 6} more` : ""}` : "") + "." : "";
    }
    return `${state.placesList.length} place${state.placesList.length === 1 ? "" : "s"} from “${state.placesName}”${amb}.${match}`;
  }
  function placesStatus(prefix, kind) {
    if (!state.places) return;
    setStatus("rp-places-status", (prefix || "") + placesSummary(), kind || "good");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-quiet";
    b.textContent = "Forget it";
    b.setAttribute("data-tip", "Removes the saved village locations from this device.");
    b.addEventListener("click", forgetPlaces);
    $("rp-places-status").append(" ", b);
  }

  async function onPlacesFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setStatus("rp-places-status", "Reading village locations…");
    try {
      const list = await Ref().readPlaces(file);
      if (!list.length) {
        throw new Error("No named points were found. A village locations file needs a name column (Village, Locality, Name…) and coordinates, or named points in KML / GeoJSON.");
      }
      usePlaces(list, file.name);
      const saved = await Ref().savePlaces(file.name, list);
      placesStatus(saved ? "Saved on this device. " : "Could not be saved on this device, so load it again next time. ");
    } catch (err) {
      setStatus("rp-places-status", err.message || "Could not read this file.", "bad");
    }
  }

  async function restorePlaces() {
    const saved = Ref() && await Ref().loadPlaces();
    if (!saved || !Array.isArray(saved.list) || !saved.list.length || state.places) return;
    usePlaces(saved.list, saved.name);
    placesStatus("Using your saved village locations: ");
  }

  async function forgetPlaces() {
    await Ref().forgetPlaces();
    state.placesList = [];
    state.places = null;
    state.placesName = "";
    if (state.placesLayer) {
      state.placesLayer.remove();
      state.placesLayer = null;
    }
    $("rp-places").value = "";
    setStatus("rp-places-status", "Saved village locations forgotten.");
  }

  // Known village locations as small hollow circles, named on hover.
  function drawPlaces() {
    if (!state.map || typeof L === "undefined") return;
    if (state.placesLayer) state.placesLayer.remove();
    state.placesLayer = null;
    if (!state.places || !state.placesList.length) return;
    const g = L.layerGroup();
    state.placesList.slice(0, 5000).forEach(p => L.circleMarker([ p.lat, p.lon ], { radius: 3, weight: 1.5, color: "#5b6d6a", fill: false, interactive: true })
      .bindTooltip(esc(p.name) + (p.group ? ` · ${esc(p.group)}` : "")).addTo(g));
    state.placesLayer = g.addTo(state.map);
  }

  /* ---------- drawing an area on the map ---------- */

  function startDrawing() {
    stopPlacing();
    $("rp-map-wrap").hidden = false;
    ensureMap();
    if (!state.map) return;
    state.map.invalidateSize();
    state.drawing = { pts: [], layer: L.layerGroup().addTo(state.map) };
    state.map.doubleClickZoom.disable();
    $("rp-map").classList.add("is-placing");
    $("rp-draw-attach").innerHTML = `<option value="">a new, separate area</option>` +
      state.features.filter(() => state.userFeatures.length).map(f => `<option value="${f.index}">${esc(featureLabel(f))}</option>`).join("");
    $("rp-draw-attach-wrap").hidden = !state.userFeatures.length;
    drawingChanged();
    $("rp-draw-bar").hidden = false;
    $("rp-map-wrap").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function drawingChanged() {
    const d = state.drawing;
    if (!d) return;
    d.layer.clearLayers();
    const ll = d.pts.map(p => [ p.lat, p.lng ]);
    if (ll.length > 1) L.polygon(ll, { color: "#c62828", weight: 2, dashArray: "5 4", fillOpacity: 0.08, interactive: false }).addTo(d.layer);
    ll.forEach(p => L.circleMarker(p, { radius: 4, color: "#c62828", fillColor: "#fff", fillOpacity: 1, weight: 2, interactive: false }).addTo(d.layer));
    $("rp-draw-text").textContent = d.pts.length < 3 ? `Click the map to add the corners of the area (${d.pts.length} so far, at least 3).` : `${d.pts.length} corners. Keep clicking to add more, or finish.`;
    $("rp-draw-finish").disabled = d.pts.length < 3;
    $("rp-draw-undo").disabled = !d.pts.length;
  }
  function stopDrawing() {
    if (!state.drawing) return;
    state.drawing.layer.remove();
    state.drawing = null;
    state.map.doubleClickZoom.enable();
    $("rp-map").classList.remove("is-placing");
    $("rp-draw-bar").hidden = true;
  }
  async function finishDrawing() {
    const d = state.drawing;
    if (!d || d.pts.length < 3) return;
    const ring = d.pts.map(p => [ p.lng, p.lat ]);
    ring.push(ring[0]);
    const attach = $("rp-draw-attach").value;
    const n = (state.userSrc || []).filter(f => f.props && f.props.drawn).length + 1;
    const name = attach !== "" ? `Added to ${featureLabel(state.features[+attach])}` : `Drawn area ${n}`;
    const props = { name, drawn: true };
    if (attach !== "") props.attachTo = +attach;
    stopDrawing();
    const src = (state.userSrc || []).concat({ name, props, rings: [ ring ] });
    const label = !state.boundaryName ? "Drawn on the map" : /drawn on the map|\+ drawn/i.test(state.boundaryName) ? state.boundaryName : `${state.boundaryName} + drawn areas`;
    useBoundary(src, label, state.nameField || undefined);
    const saved = await saveBoundary();
    boundaryStatus((attach !== "" ? `Area added to ${featureLabel(state.features[+attach])}` : `${name} added`) + `: ${polygons(src.length)} in “${label}”.` + (saved ? " Saved on this device." : ""), "good", saved);
  }

  // The boundary in use (including drawn areas) as a KML file, to reuse or share.
  function downloadBoundary() {
    if (!state.userSrc.length) return;
    const x = s => String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
    const pm = state.userSrc.map((f, i) => {
      const nm = (state.nameField && f.props && f.props[state.nameField]) || (f.props && f.props.name) || f.name || `Polygon ${i + 1}`;
      const rings = f.rings.map(r => r.map(([ lo, la ]) => `${lo},${la},0`).join(" "));
      return `<Placemark><name>${x(nm)}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${rings[0]}</coordinates></LinearRing></outerBoundaryIs>` +
        rings.slice(1).map(r => `<innerBoundaryIs><LinearRing><coordinates>${r}</coordinates></LinearRing></innerBoundaryIs>`).join("") + `</Polygon></Placemark>`;
    }).join("\n");
    const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(state.boundaryName || "Boundary")}</name>\n${pm}\n</Document></kml>\n`;
    download(`${(state.boundaryName || "boundary").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_")}.kml`, new Blob([ kml ], { type: "application/vnd.google-earth.kml+xml" }));
  }

  async function onBoundaryFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setStatus("rp-boundary-status", "Reading boundary…");
    try {
      const src = await readBoundary(file);
      if (!src.length) {
        throw new Error("No polygons were found in this file.");
      }
      useBoundary(src, file.name);
      const saved = await saveBoundary();
      boundaryStatus(`${polygons(src.length)} loaded` + (state.fieldKeys.length ? "" : " (this file has no name field — polygons are numbered)") +
        (saved ? ". Saved on this device, so it loads by itself next time." : ". It could not be saved on this device (storage full or blocked), so load it again next time."), "good", saved);
    } catch (err) {
      state.src = state.userSrc = [];
      state.features = state.userFeatures = [];
      setStatus("rp-boundary-status", err.message || "Could not read this file.", "bad");
    }
  }

  /* ---------------- coordinate input ---------------- */

  const COORD_ONE = /co-?ord|coordinate|geo|gps|location|lat.?\/?.?long|latlon|position/i;
  const LAT = /^\s*lat(itude)?\b/i, LON = /^\s*(lon|lng|long)(gitude)?\b/i;
  const VILLAGE = /village|vill\b|site|place|locality/i;
  const GROUP = /district|\bdist\b|block|region|state|province|zone|county|division/i;
  const LATW = /\b(lat|latitude)\b/i, LONW = /\b(lon|lng|long|longitude)\b/i;
  // A cell holding a whole coordinate pair: two or more numbers plus a mark or letter.
  const looksPair = v => {
    const t = String(v ?? "");
    const nums = (t.match(/\d+(?:\.\d+)?/g) || []).filter(n => n.replace(".", "").length >= 2);
    return nums.length >= 2 && nums.length <= 10 && /[°ᵒº˚'’′"”″.,]|[NSEW]\b/i.test(t);
  };

  // Every coordinate column(s) in a sheet: one-column pairs and Lat + Lon pairs.
  function detectSets(head, data) {
    const sets = [], used = new Set();
    const share = (j, test) => {
      const vals = data.map(r => r[j]).filter(v => String(v ?? "").trim() !== "" && !/^[-–—\s.]*$/.test(String(v)));
      return vals.length ? vals.filter(test).length / vals.length : 0;
    };
    // Lat + Lon pairs by header ("Latitude"/"Longitude", "Start Lat"/"Start Lon"...)
    head.forEach((x, j) => {
      if (!LATW.test(x) || LONW.test(x) || used.has(j)) return;
      const key = x.replace(LATW, "").replace(/[\s_.()-]+/g, "").toLowerCase();
      let k = head.findIndex((y, i) => !used.has(i) && i !== j && LONW.test(y) && !LATW.test(y) && y.replace(LONW, "").replace(/[\s_.()-]+/g, "").toLowerCase() === key);
      if (k < 0) k = head.findIndex((y, i) => i > j && !used.has(i) && LONW.test(y) && !LATW.test(y));
      if (k >= 0) {
        used.add(j); used.add(k);
        sets.push({ use: true, mode: "two", one: j, lat: j, lon: k, label: key ? x.replace(LATW, "").trim() || `${x} + ${head[k]}` : "Lat + Lon" });
      }
    });
    // One-column pairs: by header name, or by content
    head.forEach((x, j) => {
      if (used.has(j)) return;
      const byName = COORD_ONE.test(x) && !LATW.test(x) && !LONW.test(x);
      const s = share(j, looksPair);
      if ((byName && s > 0) || s >= 0.4) {
        used.add(j);
        sets.push({ use: true, mode: "one", one: j, lat: j, lon: j, label: x || `Column ${j + 1}` });
      }
    });
    return sets;
  }

  async function onDataFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (typeof XLSX === "undefined") {
      setStatus("rp-data-status", "The spreadsheet library did not load. Check your internet connection and reload.", "bad");
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
        wb = XLSX.read(buf, { type: "array" });
      }
      state.workbook = wb;
      state.fileName = file.name.replace(/\.[^.]+$/, "");
      state.sheets = {};
      for (const name of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true, blankrows: true });
        const h = aoa.findIndex(r => r.some(c => String(c).trim() !== ""));
        if (h < 0) {
          state.sheets[name] = { aoa, head: [], h: -1, use: false, sets: [], village: -1, rows: 0 };
          continue;
        }
        const head = aoa[h].map(c => String(c).replace(/\s+/g, " ").trim());
        const data = aoa.slice(h + 1, h + 60);
        const sets = detectSets(head, data);
        state.sheets[name] = {
          aoa, head, h, use: sets.length > 0, sets,
          village: head.findIndex(x => VILLAGE.test(x)),
          rows: aoa.length - h - 1
        };
      }
      const groupCols = new Set();
      Object.values(state.sheets).forEach(s => s.head.forEach(x => GROUP.test(x) && groupCols.add(x)));
      const gb = $("rp-groupby");
      gb.innerHTML = `<option value="__sheet">Sheet name</option>` + [ ...groupCols ].map(c => `<option value="col:${esc(c)}">Column: ${esc(c)}</option>`).join("") + `<option value="__none">Nothing — one boundary for all rows</option>`;
      gb.value = wb.SheetNames.length > 1 ? "__sheet" : groupCols.size ? `col:${[ ...groupCols ][0]}` : "__none";
      renderSheets();
      setStatus("rp-data-status", `${wb.SheetNames.length} sheet${wb.SheetNames.length > 1 ? "s" : ""} read from ${file.name}`, "good");
      refreshLinks();
    } catch (err) {
      setStatus("rp-data-status", "Could not read this file.", "bad");
    }
  }

  function renderSheets() {
    const tb = $("rp-sheets");
    const opts = (head, sel, none) => (none ? `<option value="-1"${sel < 0 ? " selected" : ""}>— none —</option>` : "") + head.map((x, j) => `<option value="${j}"${j === sel ? " selected" : ""}>${esc(x || "Column " + (j + 1))}</option>`).join("");
    const html = [];
    for (const [ name, s ] of Object.entries(state.sheets)) {
      if (s.h < 0) continue;
      const sets = s.sets.length ? s.sets : [ null ];
      sets.forEach((set, k) => {
        const first = k === 0;
        html.push(`<tr data-sheet="${esc(name)}" data-set="${set ? k : -1}">
          <td>${first ? esc(name) : ""}</td>
          <td>${first ? s.rows : ""}</td>
          <td>${set ? `<label class="inline"><input type="checkbox" data-k="use"${set.use ? " checked" : ""} aria-label="Use this coordinate column">
            <select data-k="mode"><option value="one"${set.mode === "one" ? " selected" : ""}>One column</option><option value="two"${set.mode === "two" ? " selected" : ""}>Lat + Lon columns</option></select></label>
            <span class="col-one"${set.mode === "two" ? " hidden" : ""}><select data-k="one">${opts(s.head, set.one)}</select></span>
            <span class="col-two"${set.mode === "one" ? " hidden" : ""}><select data-k="lat" aria-label="Latitude column">${opts(s.head, set.lat)}</select> <select data-k="lon" aria-label="Longitude column">${opts(s.head, set.lon)}</select></span>`
            : `<span class="hint">No coordinates found</span>`}
            ${k === sets.length - 1 ? ` <button type="button" class="btn-quiet rp-addset" data-sheet="${esc(name)}">+ Add column</button>` : ""}</td>
          <td>${first ? `<select data-k="village">${opts(s.head, s.village, true)}</select>` : ""}</td>
        </tr>`);
      });
    }
    tb.innerHTML = html.join("");
    $("rp-sheets-wrap").hidden = false;
  }

  function onSheetEdit(e) {
    const tr = e.target.closest("tr[data-sheet]");
    if (!tr) return;
    const s = state.sheets[tr.dataset.sheet];
    const k = e.target.dataset.k;
    if (k === "village") {
      s.village = +e.target.value;
      refreshLinks();
      return;
    }
    const set = s.sets[+tr.dataset.set];
    if (!set) return;
    if (k === "use") set.use = e.target.checked;
    else if (k === "mode") {
      set.mode = e.target.value;
      tr.querySelector(".col-one").hidden = set.mode === "two";
      tr.querySelector(".col-two").hidden = set.mode === "one";
    } else if (k) set[k] = +e.target.value;
    set.label = set.mode === "two" ? `${s.head[set.lat]} + ${s.head[set.lon]}` : s.head[set.one];
    refreshLinks();
  }

  function addSet(sheet) {
    const s = state.sheets[sheet];
    const taken = new Set(s.sets.flatMap(x => x.mode === "two" ? [ x.lat, x.lon ] : [ x.one ]));
    const j = Math.max(0, s.head.findIndex((_, i) => !taken.has(i)));
    s.sets.push({ use: true, mode: "one", one: j, lat: j, lon: Math.min(j + 1, s.head.length - 1), label: s.head[j] });
    renderSheets();
    refreshLinks();
  }

  function buildRows() {
    const rows = [];
    if (state.source === "paste") {
      $("rp-paste").value.split(/\n/).forEach((line, i) => {
        if (line.trim()) rows.push({ id: rows.length, text: line, group: "Pasted", village: null, sheet: "Pasted", rowIndex: i, raw: line });
      });
      return rows;
    }
    const gb = $("rp-groupby").value;
    for (const [ name, s ] of Object.entries(state.sheets)) {
      const sets = s.sets.filter(x => x.use);
      if (s.h < 0 || !sets.length) continue;
      const gcol = gb.startsWith("col:") ? s.head.indexOf(gb.slice(4)) : -1;
      let lastGroup = null;
      for (let i = s.h + 1; i < s.aoa.length; i++) {
        const r = s.aoa[i];
        if (!r || !r.some(c => String(c).trim() !== "")) continue;
        let group = gb === "__sheet" ? name : gb === "__none" ? "All rows" : (gcol >= 0 ? String(r[gcol] ?? "").trim() : "");
        // Merged / blank group cells: carry the last group down.
        if (gb.startsWith("col:")) {
          if (!group) group = lastGroup || "(blank)";
          lastGroup = group;
        }
        const village = s.village >= 0 ? String(r[s.village] ?? "").trim() || null : null;
        s.sets.forEach((set, k) => {
          if (!set.use) return;
          const row = { id: rows.length, sheet: name, rowIndex: i, set: k, setLabel: set.label, multi: sets.length > 1, group, village };
          if (set.mode === "two") {
            row.latText = r[set.lat] === "" ? null : String(r[set.lat]);
            row.lonText = r[set.lon] === "" ? null : String(r[set.lon]);
            row.raw = `${row.latText ?? ""}  |  ${row.lonText ?? ""}`;
          } else {
            row.text = r[set.one] === "" ? null : String(r[set.one]);
            row.raw = row.text ?? "";
          }
          rows.push(row);
        });
      }
    }
    return rows;
  }

  /* ---------------- linking groups to polygons ---------------- */

  const normName = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

  function refreshLinks() {
    const wrap = $("rp-links-wrap");
    state.rows = buildRows();
    if (state.places) placesStatus();
    const ready = state.rows.length > 0;
    $("rp-run").disabled = !ready;
    const noBoundary = !state.userFeatures.length;
    setStatus("rp-run-status", !ready ? "Load coordinates first" :
      noBoundary ? `${state.rows.length} coordinates ready — no boundary loaded, so the area will be estimated from the correct rows (less reliable)` :
      `${state.rows.length} coordinates ready`);
    if (!ready || noBoundary || state.features.length === 1) {
      wrap.hidden = true;
      state.links = {};
      return;
    }
    const groups = [ ...new Set(state.rows.map(r => r.group)) ];
    if (groups.length === 1 && (groups[0] === "All rows" || groups[0] === "Pasted")) {
      wrap.hidden = true;
      state.links = {};
      return;
    }
    // By name first, then learned from the rows that are already correct.
    state.learned = R.learnGroupFeatures(state.rows, state.features);
    const byName = {};
    if (state.nameField) {
      for (const g of groups) {
        const ng = normName(g);
        const f = state.features.find(x => normName(x.props[state.nameField]) === ng) ||
          state.features.find(x => { const n = normName(x.props[state.nameField]); return n && ng && (n.startsWith(ng) || ng.startsWith(n)); });
        if (f) byName[g] = f.index;
      }
    }
    const fopts = sel => `<option value="all"${sel === "all" ? " selected" : ""}>Whole boundary (all polygons)</option>` +
      state.features.map(f => `<option value="${f.index}"${sel === f.index ? " selected" : ""}>${esc(featureLabel(f))}</option>`).join("");
    $("rp-links").innerHTML = groups.map(g => {
      const named = byName[g], learned = state.learned[g];
      const sel = named != null ? named : learned ? learned.feature : "all";
      state.links[g] = sel;
      const why = named != null ? "matched by name" :
        learned ? (learned.fromRepairs ? `guessed from ${learned.votes} repaired points` : `${learned.votes} of ${learned.total} correct points fall here`) :
        "not enough correct points — choose by hand";
      return `<tr data-group="${esc(g)}"><td>${esc(g)}</td><td><select>${fopts(sel)}</select></td><td class="hint">${esc(why)}</td></tr>`;
    }).join("");
    wrap.hidden = false;
    drawBoundary();
  }

  /* ---------------- run + review ---------------- */

  function run(after) {
    state.rows = buildRows();
    if (!state.rows.length) return;
    let groupFeatures = {};
    if (!state.userFeatures.length) {
      const est = R.estimateAreas(state.rows);
      if (!est.features.length) {
        setStatus("rp-run-status", "Not enough correctly typed rows to estimate the area. Load a boundary file.", "bad");
        return;
      }
      state.src = est.src;
      state.features = est.features;
      state.estimated = true;
      groupFeatures = est.groupFeatures;
      drawBoundary();
    } else {
      state.src = state.userSrc;
      state.features = state.userFeatures;
      state.estimated = false;
      for (const [ g, v ] of Object.entries(state.links)) {
        if (v !== "all" && v !== "" && v != null) groupFeatures[g] = [ +v ].concat(Ref() ? Ref().attached(state.userSrc, +v) : []);
      }
    }
    setStatus("rp-run-status", "Repairing…");
    setTimeout(() => {
      const t = performance.now();
      state.results = R.repairRows(state.rows, { features: state.features, groupFeatures, digitFix: $("rp-digitfix").checked, estimated: state.estimated, places: state.places });
      state.decisions = new Map();
      state.page = 0;
      state.filter = "all";
      setStatus("rp-run-status", `Done in ${((performance.now() - t) / 1000).toFixed(1)} s` + (state.estimated ? " — area estimated from correct rows, check results carefully" : ""), "good");
      $("rp-review").hidden = false;
      $("rp-export").hidden = false;
      state.dirty = false;
      if (typeof after === "function") after();
      renderReview();
      drawPoints(true);
    }, 20);
  }

  function effective(i) {
    const res = state.results[i];
    const d = state.decisions.get(i);
    if (d && d.manual) {
      return { status: "placed", lat: d.manual.lat, lon: d.manual.lon, cand: null, res, manual: d.manual };
    }
    if (d && d.rejected) {
      return { status: "rejected", lat: null, lon: null, cand: null, res };
    }
    if (d && d.keep && res.typed) {
      return { status: "confirmed", lat: res.typed.lat, lon: res.typed.lon, cand: null, res, kept: true };
    }
    const k = d && d.chosen != null ? d.chosen : res.chosen;
    const cand = k >= 0 ? res.candidates[k] : null;
    const lat = cand ? cand.lat : res.lat, lon = cand ? cand.lon : res.lon;
    const usable = res.status === "ok" || res.status === "fixed" || res.status === "choose" || (d && d.confirmed);
    return { status: d && d.confirmed ? "confirmed" : d && d.guess ? "guess" : res.status, lat: usable ? lat : (res.status === "outside" ? lat : null), lon: usable ? lon : (res.status === "outside" ? lon : null), cand, res };
  }

  function noteFor(i) {
    const e = effective(i);
    if (e.kept) return "kept as typed by you, although it is outside the boundary";
    if (e.status === "confirmed") return "checked by you" + (e.cand && e.cand.notes.length ? " — " + e.cand.notes.filter(n => !/^read as/.test(n)).join("; ") : "");
    if (e.status === "rejected") return "rejected by you";
    if (e.status === "placed") return "placed by hand on the map" + (e.manual.inside ? "" : " — outside the boundary");
    if (e.status === "guess") return "best guess, not checked — " + e.res.notes.join("; ");
    const d = state.decisions.get(i);
    if (d && d.chosen != null && e.cand) return e.cand.notes.join("; ");
    return e.res.notes.join("; ");
  }

  // Same point for different rows, and points far from the rest of their village.
  const FLAG_KM = 5;
  function computeFlags() {
    const flags = new Map();
    const add = (i, f) => flags.set(i, (flags.get(i) || []).concat(f));
    const byKey = new Map(), byVillage = new Map();
    state.results.forEach((_, i) => {
      const e = effective(i);
      if (e.lat == null) return;
      const k = `${e.lat.toFixed(5)},${e.lon.toFixed(5)}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(i);
      const row = state.rows[i];
      if (row.village) {
        const vk = `${row.group}||${row.village.toUpperCase()}`;
        if (!byVillage.has(vk)) byVillage.set(vk, []);
        byVillage.get(vk).push(i);
      }
    });
    for (const list of byKey.values()) {
      const places = new Set(list.map(i => `${state.rows[i].sheet}|${state.rows[i].rowIndex}`));
      if (places.size < 2) continue;
      for (const i of list) {
        const others = list.filter(j => `${state.rows[j].sheet}|${state.rows[j].rowIndex}` !== `${state.rows[i].sheet}|${state.rows[i].rowIndex}`);
        const names = others.slice(0, 2).map(j => `${state.rows[j].sheet} row ${state.rows[j].rowIndex + 1}${state.rows[j].village ? " (" + state.rows[j].village + ")" : ""}`);
        add(i, { kind: "dup", text: `same point as ${names.join(", ")}${others.length > 2 ? ` and ${others.length - 2} more` : ""}` });
      }
    }
    const med = a => {
      const x = a.slice().sort((p, q) => p - q), m = x.length >> 1;
      return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
    };
    // Far from the village's location in the village locations file.
    if (state.places) {
      state.results.forEach((_, i) => {
        const e = effective(i), p = R.placeFor(state.places, state.rows[i]);
        if (e.lat == null || !p) return;
        const d = R.km(e.lat, e.lon, p.lat, p.lon);
        if (d > FLAG_KM) add(i, { kind: "far", text: `${d.toFixed(1)} km from ${p.name} (village locations file)` });
      });
    }
    for (const list of byVillage.values()) {
      if (list.length < 3) continue;
      const pts = list.map(i => effective(i));
      const c = { lat: med(pts.map(p => p.lat)), lon: med(pts.map(p => p.lon)) };
      list.forEach((i, n) => {
        const d = R.km(pts[n].lat, pts[n].lon, c.lat, c.lon);
        if (d > FLAG_KM) add(i, { kind: "far", text: `${d.toFixed(1)} km from the other points of ${state.rows[i].village}` });
      });
    }
    state.flags = flags;
    return flags;
  }

  const signature = c => c ? c.notes.filter(n => !/km from|possible|other reading/.test(n)).join("|") : "";

  function counts() {
    const c = {};
    state.results.forEach((_, i) => {
      const s = effective(i).status;
      c[s] = (c[s] || 0) + 1;
    });
    return c;
  }

  function filtered() {
    const f = state.filter;
    const out = [];
    if (f === "habit") {
      return habitOpen(state.results.habits[state.habitShown]).map(x => x[0]);
    }
    state.results.forEach((r, i) => {
      const s = effective(i).status;
      if (f === "flag") {
        if (state.flags.has(i)) out.push(i);
        return;
      }
      if (f === "all" ? s !== "empty" : f === "review" ? (s === "fixed" || s === "choose") : f === "problem" ? (s === "outside" || s === "failed" || s === "rejected") : f === "confirmed" ? (s === "confirmed" || s === "placed") : s === f) out.push(i);
    });
    return out;
  }

  const FORMAT_NAME = { DD: "decimal degrees", DDM: "degrees + decimal minutes", DMS: "degrees, minutes, seconds" };
  // "lat: ' read as decimal point|lon: ' read as decimal point|read as DDM" -> plain words
  function describeHabit(sig) {
    const parts = [ ...new Set(sig.split("|").filter(Boolean).map(n => n.replace(/^(lat|lon): /, ""))) ];
    return parts.map(p => p.replace(/^read as (.+)$/, (m, f) => "read as " + f.split(" / ").map(x => FORMAT_NAME[x] || x).join(" / "))).join(", ");
  }
  // Rows of a habit that still wait for a decision, with the reading the habit gives each.
  function habitOpen(h) {
    const out = [];
    for (const i of h.rows) {
      const d = state.decisions.get(i);
      if (d && (d.confirmed || d.rejected || d.manual)) continue;
      const k = state.results[i].candidates.findIndex(c => R.signatureOf(c) === h.signature);
      if (k >= 0) out.push([ i, k ]);
    }
    return out;
  }
  function renderHabits() {
    const box = $("rp-habits");
    const habits = (state.results.habits || []).map((h, n) => ({ h, n, open: habitOpen(h) })).filter(x => x.open.length);
    box.hidden = !habits.length;
    if (!habits.length) return;
    box.innerHTML = `<h3>Typing habits <span class="hint">Rows typed the same way are read the same way. Check one example, then confirm them all at once.</span></h3>` +
      habits.map(({ h, n, open }) => {
        const [ i, k ] = open[0], c = state.results[i].candidates[k], row = state.rows[i];
        return `<div class="rp-habit"><div><b>${esc(h.group || row.sheet)}: ${open.length} row${open.length === 1 ? "" : "s"}</b> typed like <code>${esc(row.raw.replace(/\n/g, " ⏎ "))}</code>
          → <b class="num">${fmt(c.lat)}, ${fmt(c.lon)}</b><br><span class="hint">${esc(describeHabit(h.signature))}</span></div>
          <div class="actions"><button type="button" class="btn-quiet" data-habit-show="${n}">Show them</button><button type="button" data-habit="${n}">Confirm all ${open.length}</button></div></div>`;
      }).join("");
  }

  function renderReview() {
    computeFlags();
    renderHabits();
    const c = counts();
    const chips = [
      [ "all", "All", state.results.length - (c.empty || 0) ],
      [ "ok", "Unchanged", c.ok || 0 ], [ "fixed", "Corrected", c.fixed || 0 ], [ "choose", "Check", c.choose || 0 ],
      [ "guess", "Best guess", c.guess || 0 ], [ "confirmed", "Checked by you", (c.confirmed || 0) + (c.placed || 0) ], [ "flag", "Flags", state.flags.size ], [ "problem", "Outside / not fixed", (c.outside || 0) + (c.failed || 0) + (c.rejected || 0) ],
      [ "empty", "Empty", c.empty || 0 ]
    ];
    const CHIP_TIPS = {
      all: "Every row that has a coordinate.",
      ok: "Typed correctly and inside the area — nothing changed.",
      fixed: "Yellow: one clear correction. Check and confirm.",
      choose: "Orange: several readings fit — choose one in the Reading column.",
      guess: "Set to their most likely reading by 'Use best guess'. Not checked yet.",
      confirmed: "Rows you confirmed, chose or placed on the map.",
      flag: "Duplicate points, or points more than 5 km from the rest of their village.",
      problem: "Red: outside the area, or no reading fits. Use 'Place on map' to set them by hand.",
      empty: "No coordinate in the cell."
    };
    $("rp-summary").innerHTML = chips.map(([ k, label, n ]) => `<button type="button" class="chip chip-${k}${state.filter === k ? " is-active" : ""}" data-filter="${k}" data-tip="${esc(CHIP_TIPS[k] || "")}">${label} <b>${n}</b></button>`).join("");
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    state.page = Math.min(state.page, pages - 1);
    const slice = list.slice(state.page * PAGE, state.page * PAGE + PAGE);
    $("rp-table").innerHTML = slice.map(i => rowHtml(i)).join("") || `<tr><td colspan="7" class="empty">No rows in this view.</td></tr>`;
    $("rp-pager").innerHTML = pages > 1 ? `<button type="button" data-page="${state.page - 1}"${state.page === 0 ? " disabled" : ""}>Previous</button> <span class="hint">Page ${state.page + 1} of ${pages} · ${list.length} rows</span> <button type="button" data-page="${state.page + 1}"${state.page >= pages - 1 ? " disabled" : ""}>Next</button>` : `<span class="hint">${list.length} rows</span>`;
    $("rp-confirm-all").textContent = `Confirm all corrected (${c.fixed || 0})`;
    $("rp-confirm-all").disabled = !c.fixed;
    $("rp-guess-all").textContent = `Use best guess for all to check (${c.choose || 0})`;
    $("rp-guess-all").disabled = !c.choose;
    const keepable = keepableRows().length;
    $("rp-keep-all").hidden = !keepable;
    $("rp-keep-all").textContent = `Keep values that agree with their village (${keepable})`;
  }

  function rowHtml(i) {
    const row = state.rows[i], e = effective(i), res = e.res;
    const st = STATUS[e.status] || STATUS.failed;
    const d = state.decisions.get(i);
    const k = d && d.chosen != null ? d.chosen : res.chosen;
    let choice = "";
    if (res.candidates.length > 1 || res.status === "choose" || res.status === "fixed" || res.typed) {
      const kept = !!(d && d.keep);
      choice = `<select class="rp-choose" data-i="${i}" aria-label="Choose a reading">` +
        (!res.candidates.length && !(d && (d.keep || d.rejected)) ? `<option value="" selected disabled>Choose…</option>` : "") +
        res.candidates.map((c, j) => `<option value="${j}"${j === k && !kept ? " selected" : ""}>${fmt(c.lat)}, ${fmt(c.lon)}${c.distKm != null ? ` · ${c.distKm.toFixed(1)} km from village` : ""}</option>`).join("") +
        (res.typed ? `<option value="typed"${kept ? " selected" : ""}>As typed: ${fmt(res.typed.lat)}, ${fmt(res.typed.lon)}</option>` : "") +
        `<option value="reject"${d && d.rejected ? " selected" : ""}>None of these</option></select>`;
    }
    const similar = res.status === "choose" || res.status === "fixed" ? similarRows(i).length : 0;
    const actions = [
      (res.status === "fixed" || res.status === "choose") && !(d && (d.confirmed || d.rejected)) ? `<button type="button" class="rp-confirm" data-i="${i}" data-tip="Mark this reading as checked by you.">Confirm</button>` : "",
      res.typed && !(d && (d.confirmed || d.rejected || d.manual)) ? `<button type="button" class="rp-keep" data-i="${i}" data-tip="Keep the value exactly as typed and mark it as checked by you. For a village on the border, or where the boundary line is rough.">Keep as typed</button>` : "",
      similar ? `<button type="button" class="btn-quiet rp-similar" data-i="${i}" data-tip="Use the same kind of correction on the other rows typed the same way, and mark them all as checked.">Same for ${similar} similar</button>` : "",
      e.status !== "empty" ? `<button type="button" class="btn-quiet rp-place" data-i="${i}" data-tip="Click on the map to set this point by hand. The map zooms to this village's other points.">${e.status === "failed" || e.status === "outside" || e.status === "rejected" ? "Place on map" : "Move"}</button>` : "",
      e.lat != null ? `<button type="button" class="btn-quiet rp-zoom" data-i="${i}" data-tip="Show this point on the map below.">Map</button>` : ""
    ].join("");
    const fl = state.flags.get(i) || [];
    const tags = fl.map(f => `<span class="flag flag-${f.kind}" data-tip="${esc(f.text)}">${f.kind === "dup" ? "Duplicate" : "Far from village"}</span>`).join(" ");
    const where = (row.sheet === row.group ? esc(row.sheet) : `${esc(row.sheet)} · ${esc(row.group)}`) + (row.multi ? ` · ${esc(row.setLabel)}` : "");
    return `<tr class="${st.cls}" data-i="${i}">
      <td><span class="hint">${where} · row ${row.rowIndex + 1}</span><br>${esc(row.village || "")}</td>
      <td><pre class="raw">${esc(row.raw)}</pre></td>
      <td class="num">${e.lat != null ? `${fmt(e.lat)}<br>${fmt(e.lon)}` : "—"}</td>
      <td><span class="badge ${st.cls}">${st.label}</span>${e.status !== "empty" && e.status !== "ok" ? `<br><span class="hint">${res.confidence}%</span>` : ""}</td>
      <td class="note">${tags ? tags + "<br>" : ""}${esc([ noteFor(i), ...fl.map(f => f.text) ].filter(Boolean).join("; "))}</td>
      <td>${choice}</td>
      <td class="row-actions">${actions}</td>
    </tr>`;
  }

  // Typed correctly, outside the boundary, but sitting with other points of the same village:
  // almost always a village on the border or a rough boundary line.
  function keepableRows() {
    const out = [];
    state.results.forEach((r, i) => {
      const d = state.decisions.get(i);
      if (r.status === "outside" && r.typed && !(d && (d.confirmed || d.rejected || d.manual))) out.push(i);
    });
    return out;
  }

  // Rows typed the same way (same pattern), in the same group, still waiting for review.
  function similarRows(i) {
    const row = state.rows[i];
    const pat = R.patternOf(row);
    const out = [];
    state.results.forEach((r, j) => {
      if (j === i || (r.status !== "choose" && r.status !== "fixed")) return;
      const d = state.decisions.get(j);
      if (d && (d.confirmed || d.rejected)) return;
      if (state.rows[j].set !== row.set) return;
      if (state.rows[j].group === row.group && R.patternOf(state.rows[j]) === pat) out.push(j);
    });
    return out;
  }

  function onTableClick(e) {
    const b = e.target.closest("button");
    if (!b) return;
    const i = +b.dataset.i;
    if (b.classList.contains("rp-keep")) {
      state.decisions.set(i, { keep: true, confirmed: true });
      changed();
    } else if (b.classList.contains("rp-confirm")) {
      const d = state.decisions.get(i) || {};
      state.decisions.set(i, { ...d, confirmed: true });
      changed();
    } else if (b.classList.contains("rp-similar")) {
      const d = state.decisions.get(i) || {};
      const k = d.chosen != null ? d.chosen : state.results[i].chosen;
      const sig = signature(state.results[i].candidates[k]);
      let n = 0;
      for (const j of similarRows(i)) {
        const kk = state.results[j].candidates.findIndex(c => signature(c) === sig);
        if (kk >= 0) {
          state.decisions.set(j, { chosen: kk, confirmed: true });
          n++;
        }
      }
      state.decisions.set(i, { chosen: k, confirmed: true });
      changed();
      flash(`Applied to ${n + 1} rows — marked as checked by you`);
    } else if (b.classList.contains("rp-place")) {
      startPlacing(i);
    } else if (b.classList.contains("rp-zoom")) {
      const ef = effective(i);
      ensureMap();
      state.map.setView([ ef.lat, ef.lon ], 14);
      $("rp-map").scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function onTableChange(e) {
    const s = e.target.closest(".rp-choose");
    if (!s) return;
    const i = +s.dataset.i;
    if (s.value === "reject") state.decisions.set(i, { rejected: true });
    else if (s.value === "typed") state.decisions.set(i, { keep: true, confirmed: true });
    else if (s.value !== "") state.decisions.set(i, { chosen: +s.value, confirmed: true });
    changed();
  }

  function changed() {
    state.dirty = true;
    renderReview();
    drawPoints();
  }

  function flash(msg) {
    setStatus("rp-review-status", msg, "good");
    setTimeout(() => setStatus("rp-review-status", ""), 4000);
  }

  /* ---------------- placing a point by hand ---------------- */

  function startPlacing(i) {
    stopDrawing();
    ensureMap();
    if (!state.map) return;
    state.placing = i;
    const row = state.rows[i];
    $("rp-place-text").textContent = `Click the map to place ${row.sheet} row ${row.rowIndex + 1}${row.village ? " (" + row.village + ")" : ""}.`;
    $("rp-place-banner").hidden = false;
    $("rp-map").classList.add("is-placing");
    // Zoom to where this point probably belongs: its village, else its current position.
    const mates = state.results.map((_, j) => j).filter(j => j !== i && row.village && state.rows[j].village === row.village && state.rows[j].group === row.group && effective(j).lat != null);
    const e = effective(i);
    if (mates.length) {
      const la = mates.map(j => effective(j).lat).sort((a, b) => a - b), lo = mates.map(j => effective(j).lon).sort((a, b) => a - b);
      state.map.setView([ la[la.length >> 1], lo[lo.length >> 1] ], 14);
    } else if (e.lat != null) {
      state.map.setView([ e.lat, e.lon ], 14);
    } else {
      fitMap();
    }
    $("rp-map-wrap").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function stopPlacing() {
    state.placing = null;
    $("rp-place-banner").hidden = true;
    $("rp-map").classList.remove("is-placing");
  }

  function onMapClick(ev) {
    if (state.drawing) {
      state.drawing.pts.push(ev.latlng);
      drawingChanged();
      return;
    }
    if (state.placing == null) return;
    const i = state.placing;
    const lat = ev.latlng.lat, lon = ev.latlng.lng;
    const g = state.rows[i].group;
    const idx = state.links[g];
    const target = idx !== undefined && idx !== "all" && state.features[+idx] ? [ state.features[+idx] ] : state.features;
    const inside = !target.length || !!R.featureAt(target, lon, lat);
    state.decisions.set(i, { manual: { lat, lon, inside } });
    stopPlacing();
    changed();
    flash(`Placed at ${fmt(lat)}, ${fmt(lon)}${inside ? "" : " — note: outside the boundary"}`);
  }

  /* ---------------- save & resume ---------------- */

  const rowKey = r => `${r.sheet}|${r.rowIndex}|${r.set ?? 0}`;

  function saveReview() {
    const decisions = [];
    state.decisions.forEach((d, i) => {
      const r = state.rows[i], e = effective(i);
      const out = { key: rowKey(r), raw: r.raw };
      if (d.manual) out.manual = d.manual;
      else if (d.rejected) out.rejected = true;
      else if (d.keep) {
        out.keep = true;
        out.lat = e.lat;
        out.lon = e.lon;
      } else {
        out.lat = e.lat;
        out.lon = e.lon;
        if (d.confirmed) out.confirmed = true;
        if (d.guess) out.guess = true;
      }
      decisions.push(out);
    });
    const sheets = {};
    for (const [ n, s ] of Object.entries(state.sheets)) {
      sheets[n] = { sets: s.sets, village: s.village };
    }
    const data = {
      app: "cordify-repair", version: 1, saved: new Date().toISOString(),
      fileName: state.fileName, source: state.source, paste: state.source === "paste" ? $("rp-paste").value : undefined,
      boundary: state.boundaryName, groupBy: $("rp-groupby").value, sheets, links: state.links,
      digitFix: $("rp-digitfix").checked, decisions
    };
    download(`${state.fileName || "cordify"}_review.json`, new Blob([ JSON.stringify(data, null, 1) ], { type: "application/json" }));
    state.dirty = false;
    flash(`Progress saved (${decisions.length} choices). Load it in step 3 next time.`);
  }

  async function onResumeFile(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
      if (data.app !== "cordify-repair") throw new Error();
    } catch (e) {
      setStatus("rp-resume-status", "This is not a saved Cordify review.", "bad");
      return;
    }
    if (data.source === "paste") {
      document.querySelector('input[name="rp-source"][value="paste"]').click();
      $("rp-paste").value = data.paste || "";
    } else if (!state.workbook || state.fileName !== data.fileName) {
      setStatus("rp-resume-status", `Load "${data.fileName}" in step 2 first, then load this review again.`, "bad");
      return;
    }
    if (data.boundary && state.boundaryName !== data.boundary) {
      setStatus("rp-resume-status", `This review used the boundary "${data.boundary}". Load it in step 1 first${state.boundaryName ? " (a different boundary is loaded)" : ""}.`, "bad");
      return;
    }
    if (data.source !== "paste") {
      for (const [ n, s ] of Object.entries(data.sheets || {})) {
        if (state.sheets[n]) {
          state.sheets[n].sets = s.sets;
          state.sheets[n].village = s.village;
        }
      }
      renderSheets();
      if ([ ...$("rp-groupby").options ].some(o => o.value === data.groupBy)) $("rp-groupby").value = data.groupBy;
    }
    $("rp-digitfix").checked = data.digitFix !== false;
    refreshLinks();
    for (const [ g, v ] of Object.entries(data.links || {})) {
      if (g in state.links) {
        state.links[g] = v;
        const sel = document.querySelector(`#rp-links tr[data-group="${CSS.escape(g)}"] select`);
        if (sel) sel.value = String(v);
      }
    }
    run(() => {
      const index = new Map(state.rows.map((r, i) => [ rowKey(r), i ]));
      let ok = 0, skipped = 0;
      for (const d of data.decisions || []) {
        const i = index.get(d.key);
        if (i == null || state.rows[i].raw !== d.raw) {
          skipped++;
          continue;
        }
        if (d.manual) state.decisions.set(i, { manual: d.manual });
        else if (d.rejected) state.decisions.set(i, { rejected: true });
        else if (d.keep) {
          const t = state.results[i].typed;
          if (!t || Math.abs(t.lat - d.lat) > 1e-9 || Math.abs(t.lon - d.lon) > 1e-9) {
            skipped++;
            continue;
          }
          state.decisions.set(i, { keep: true, confirmed: true });
        } else {
          const k = state.results[i].candidates.findIndex(c => Math.abs(c.lat - d.lat) < 1e-9 && Math.abs(c.lon - d.lon) < 1e-9);
          if (k < 0) {
            skipped++;
            continue;
          }
          state.decisions.set(i, { chosen: k, confirmed: !!d.confirmed, guess: !!d.guess && !d.confirmed });
        }
        ok++;
      }
      state.dirty = false;
      setStatus("rp-resume-status", `Restored ${ok} of ${(data.decisions || []).length} choices from ${new Date(data.saved).toLocaleString()}` + (skipped ? ` — ${skipped} rows changed since and were skipped` : ""), "good");
    });
  }

  /* ---------------- map ---------------- */

  function ensureMap() {
    if (state.map || typeof L === "undefined") return state.map;
    state.map = L.map("rp-map", { preferCanvas: true }).setView([ 0, 0 ], 2);
    state.map.on("click", onMapClick);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(state.map);
    return state.map;
  }

  function drawBoundary() {
    if (!state.src.length || typeof L === "undefined") return;
    // Show the box before creating/fitting the map, otherwise it measures 0×0.
    $("rp-map-wrap").hidden = false;
    ensureMap();
    state.map.invalidateSize();
    if (state.boundaryLayer) state.boundaryLayer.remove();
    const g = L.layerGroup();
    const linked = new Map();
    for (const [ grp, v ] of Object.entries(state.links)) {
      if (v !== "all") linked.set(+v, (linked.get(+v) || []).concat(grp));
    }
    state.features.forEach((f, i) => {
      const rings = state.src[i].rings.map(r => r.map(([ x, y ]) => [ y, x ]));
      L.polygon(rings, { color: "#0e5f5c", weight: 1.2, fill: false, interactive: false }).addTo(g);
      const own = state.nameField && f.props[state.nameField];
      const label = own ? String(own) : `${i + 1}` + (linked.has(i) ? ` · ${linked.get(i).join(", ")}` : "");
      L.tooltip({ permanent: true, direction: "center", className: "poly-label" }).setLatLng([ f.center[1], f.center[0] ]).setContent(esc(label)).addTo(g);
    });
    state.boundaryLayer = g.addTo(state.map);
    drawPlaces();
    const b = state.features.reduce((a, f) => [ Math.min(a[0], f.bbox[0]), Math.min(a[1], f.bbox[1]), Math.max(a[2], f.bbox[2]), Math.max(a[3], f.bbox[3]) ], [ Infinity, Infinity, -Infinity, -Infinity ]);
    state.fitBox = [ [ b[1], b[0] ], [ b[3], b[2] ] ];
    fitMap();
  }

  function fitMap() {
    if (!state.map || !state.fitBox || $("repair-tab").style.display === "none") return;
    state.map.invalidateSize();
    state.map.fitBounds(state.fitBox, { padding: [ 10, 10 ] });
  }

  function drawPoints(fit) {
    if (!ensureMap()) return;
    if (state.pointLayer) state.pointLayer.remove();
    const g = L.layerGroup();
    state.results.forEach((_, i) => {
      const e = effective(i);
      if (e.lat == null) return;
      const row = state.rows[i];
      L.circleMarker([ e.lat, e.lon ], { radius: 5, weight: 1, color: "#fff", fillColor: COLORS[e.status] || "#888", fillOpacity: 0.9 })
        .bindPopup(`<b>${esc(row.village || row.sheet)}</b><br>${esc((STATUS[e.status] || {}).label)} · ${esc(row.sheet)} row ${row.rowIndex + 1}<br><code>${esc(row.raw)}</code><br>${fmt(e.lat)}, ${fmt(e.lon)}`)
        .addTo(g);
    });
    state.pointLayer = g.addTo(state.map);
  }

  /* ---------------- export ---------------- */

  const STATUS_TEXT = { placed: "Placed by user", ok: "Unchanged", fixed: "Corrected - check", choose: "Needs check", guess: "Best guess - check", confirmed: "Checked by user", outside: "Outside boundary", failed: "Not fixed", rejected: "Rejected by user", empty: "Empty" };

  function formats() {
    const f = {
      dd: $("rp-fmt-dd").checked, dms: $("rp-fmt-dms").checked, ddm: $("rp-fmt-ddm").checked,
      ddDigits: +$("rp-prec-dd").value, secDigits: +$("rp-prec-dms").value, minDigits: +$("rp-prec-ddm").value
    };
    if (!f.dd && !f.dms && !f.ddm) f.dd = true;
    return f;
  }

  // Values for one result in the chosen formats, plus status columns.
  function exportValues(i, f = formats()) {
    const e = effective(i);
    const keep = [ "ok", "fixed", "choose", "guess", "confirmed", "placed" ].includes(e.status) && e.lat != null;
    const lat = keep ? e.lat : null, lon = keep ? e.lon : null;
    const cols = [];
    if (f.dd) cols.push([ "Lat_DD", lat == null ? "" : R.formatDD(lat, f.ddDigits) ], [ "Lon_DD", lon == null ? "" : R.formatDD(lon, f.ddDigits) ]);
    if (f.dms) cols.push([ "Lat_DMS", R.formatDMS(lat, "lat", f.secDigits) ], [ "Lon_DMS", R.formatDMS(lon, "lon", f.secDigits) ]);
    if (f.ddm) cols.push([ "Lat_DDM", R.formatDDM(lat, "lat", f.minDigits) ], [ "Lon_DDM", R.formatDDM(lon, "lon", f.minDigits) ]);
    cols.push([ "Repair_Status", STATUS_TEXT[e.status] || e.status ],
      [ "Confidence", e.status === "empty" ? "" : e.status === "confirmed" || e.status === "placed" ? 100 : e.res.confidence ],
      [ "Repair_Note", noteFor(i) ],
      [ "Repair_Flags", (state.flags.get(i) || []).map(f => f.text).join("; ") ]);
    return { lat, lon, cols };
  }

  // Line breaks inside cells: write plain "\n" (what Excel, QGIS and pandas read from the original),
  // not "\r\n", which would be saved as a "_x000d_" escape some readers show literally.
  const noCR = v => typeof v === "string" ? v.replace(/\r\n?/g, "\n") : v;
  function cleanSheet(ws) {
    const copy = {};
    for (const k of Object.keys(ws)) {
      const c = ws[k];
      copy[k] = k[0] === "!" || !c || typeof c !== "object" ? c : { ...c, v: noCR(c.v), w: noCR(c.w), h: undefined, r: undefined };
    }
    return copy;
  }

  // Excel colour for each result: the same colours as the review table.
  const KIND = { ok: "ok", fixed: "fixed", choose: "check", guess: "check", confirmed: "confirmed", placed: "confirmed", outside: "bad", failed: "bad", rejected: "bad" };
  const LEGEND = [
    [ "ok", "Green", "Unchanged: typed correctly and inside the area." ],
    [ "fixed", "Yellow", "Corrected: one clear reading. Check it." ],
    [ "check", "Orange", "Needs check: several readings were possible, or a best guess was used." ],
    [ "confirmed", "Blue", "Checked by you, or placed by you on the map." ],
    [ "bad", "Red", "Not fixed: outside the area, no reading fits, or rejected by you. The reason is in Repair_Note." ]
  ];

  async function saveColoured(out, plan, name) {
    const C = window.CordifyXlsxColor;
    if (!C || typeof JSZip === "undefined") return XLSX.writeFile(out, name);
    plan.push(C.addLegend(XLSX, out, LEGEND, "When a row holds several coordinates, it takes the colour of the one that needs most attention. Rows with no colour have no coordinate. Made by Cordify."));
    try {
      const bytes = await C.colour(XLSX.write(out, { type: "array", bookType: "xlsx" }), plan, JSZip);
      download(name, new Blob([ bytes ], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    } catch (e) {
      XLSX.writeFile(out, name);   // the same file, without colours
    }
  }

  function exportWorkbook() {
    const out = XLSX.utils.book_new();
    const f = formats();
    const C = window.CordifyXlsxColor;
    const worse = C ? C.worse : (a, b) => b || a;
    if (state.source === "paste") {
      const names = exportValues(0, f).cols.map(c => c[0]);
      const aoa = [ [ "Original" ].concat(names) ];
      const rows = new Map();
      state.rows.forEach((r, i) => {
        aoa.push([ noCR(r.raw) ].concat(exportValues(i, f).cols.map(c => c[1])));
        const kind = KIND[effective(i).status];
        if (kind) rows.set(i + 2, kind);
      });
      XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(aoa), "Repaired");
      return saveColoured(out, [ { sheet: 1, header: 1, rows } ], "cordify_repaired.xlsx");
    }
    const plan = [];
    const bySheet = new Map();
    state.rows.forEach((r, i) => {
      if (!bySheet.has(r.sheet)) bySheet.set(r.sheet, []);
      bySheet.get(r.sheet).push(i);
    });
    for (const name of state.workbook.SheetNames) {
      const s = state.sheets[name];
      if (!bySheet.has(name)) {
        XLSX.utils.book_append_sheet(out, cleanSheet(state.workbook.Sheets[name]), name);
        continue;
      }
      const aoa = s.aoa.map(r => r.map(noCR));
      let col = Math.max(...aoa.map(r => r.length));
      const idx = bySheet.get(name);
      // One block of new columns per coordinate column used; prefixed when there are several.
      const setsUsed = [ ...new Set(idx.map(i => state.rows[i].set)) ];
      for (const k of setsUsed) {
        const rowsK = idx.filter(i => state.rows[i].set === k);
        const prefix = setsUsed.length > 1 ? `${state.rows[rowsK[0]].setLabel} ` : "";
        const names = exportValues(rowsK[0], f).cols.map(c => prefix + c[0]);
        names.forEach((h, j) => { aoa[s.h][col + j] = h; });
        for (const i of rowsK) {
          exportValues(i, f).cols.forEach((c, j) => { aoa[state.rows[i].rowIndex][col + j] = c[1]; });
        }
        col += names.length;
      }
      XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(aoa), name);
      const rows = new Map();
      for (const i of idx) {
        const n = state.rows[i].rowIndex + 1;
        rows.set(n, worse(rows.get(n), KIND[effective(i).status]));
      }
      plan.push({ sheet: out.SheetNames.length, header: s.h + 1, rows });
    }
    return saveColoured(out, plan, `${state.fileName || "cordify"}_repaired.xlsx`);
  }

  function pointFeatures() {
    const f = formats();
    const feats = [];
    state.rows.forEach((r, i) => {
      const v = exportValues(i, f);
      if (v.lat == null) return;
      const props = {};
      if (state.source !== "paste") {
        const s = state.sheets[r.sheet];
        s.head.forEach((h, j) => {
          const val = s.aoa[r.rowIndex][j];
          if (h && val !== "" && val != null) props[h] = noCR(val);
        });
      }
      Object.assign(props, { sheet: r.sheet, row: r.rowIndex + 1 }, r.multi ? { coordinate_column: r.setLabel } : {}, { original: noCR(r.raw) });
      v.cols.forEach(([ k, val ]) => { props[k] = val; });
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [ +v.lon.toFixed(8), +v.lat.toFixed(8) ] }, properties: props });
    });
    return feats;
  }

  function exportGeoJson() {
    download(`${state.fileName || "cordify"}_repaired.geojson`, new Blob([ JSON.stringify({ type: "FeatureCollection", features: pointFeatures() }, null, 1) ], { type: "application/geo+json" }));
  }

  function exportKml() {
    const x = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const style = { "Placed by user": "checked", "Unchanged": "ok", "Checked by user": "checked", "Corrected - check": "fixed", "Needs check": "check", "Best guess - check": "check" };
    const color = { ok: "ff327d2e", checked: "ffc06515", fixed: "ff0097c9", check: "ff007be0" };
    const styles = Object.entries(color).map(([ id, c ]) => `<Style id="${id}"><IconStyle><color>${c}</color><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`).join("");
    const pms = pointFeatures().map(f => {
      const p = f.properties;
      const data = Object.entries(p).map(([ k, v ]) => `<Data name="${x(k)}"><value>${x(v)}</value></Data>`).join("");
      const nm = p[Object.keys(p).find(k => VILLAGE.test(k))] || `${p.sheet} row ${p.row}`;
      return `<Placemark><name>${x(nm)}</name><styleUrl>#${style[p.Repair_Status] || "check"}</styleUrl><ExtendedData>${data}</ExtendedData><Point><coordinates>${f.geometry.coordinates[0]},${f.geometry.coordinates[1]},0</coordinates></Point></Placemark>`;
    }).join("\n");
    const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Cordify repaired points</name>${styles}\n${pms}\n</Document></kml>`;
    download(`${state.fileName || "cordify"}_repaired.kml`, new Blob([ kml ], { type: "application/vnd.google-earth.kml+xml" }));
  }

  /* ---------------- wiring ---------------- */

  function init() {
    if (!R || !$("repair-tab")) return;
    initAdvanced();
    $("rp-boundary").addEventListener("change", onBoundaryFile);
    restoreBoundary();
    $("rp-places").addEventListener("change", onPlacesFile);
    restorePlaces();
    $("rp-draw").addEventListener("click", startDrawing);
    $("rp-draw-finish").addEventListener("click", finishDrawing);
    $("rp-draw-undo").addEventListener("click", () => {
      if (!state.drawing) return;
      state.drawing.pts.pop();
      drawingChanged();
    });
    $("rp-draw-cancel").addEventListener("click", stopDrawing);
    $("rp-boundary-download").addEventListener("click", downloadBoundary);
    $("rp-namefield").addEventListener("change", e => {
      state.nameField = e.target.value;
      refreshLinks();
      if (state.userSrc.length) saveBoundary();   // the choice of name field is remembered too
    });
    $("rp-data").addEventListener("change", onDataFile);
    $("rp-sheets").addEventListener("change", onSheetEdit);
    $("rp-sheets").addEventListener("click", e => {
      const b = e.target.closest(".rp-addset");
      if (b) addSet(b.dataset.sheet);
    });
    $("rp-groupby").addEventListener("change", refreshLinks);
    document.querySelectorAll('input[name="rp-source"]').forEach(r => r.addEventListener("change", e => {
      state.source = e.target.value;
      $("rp-src-file").hidden = state.source !== "file";
      $("rp-src-paste").hidden = state.source !== "paste";
      refreshLinks();
    }));
    let t;
    $("rp-paste").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(refreshLinks, 400);
    });
    $("rp-links").addEventListener("change", e => {
      const tr = e.target.closest("tr[data-group]");
      if (tr) {
        state.links[tr.dataset.group] = e.target.value === "all" ? "all" : +e.target.value;
        drawBoundary();
      }
    });
    $("rp-run").addEventListener("click", run);
    $("rp-summary").addEventListener("click", e => {
      const b = e.target.closest("[data-filter]");
      if (b) {
        state.filter = b.dataset.filter;
        state.page = 0;
        renderReview();
      }
    });
    $("rp-pager").addEventListener("click", e => {
      const b = e.target.closest("[data-page]");
      if (b) {
        state.page = +b.dataset.page;
        renderReview();
        $("rp-table").closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    $("rp-table").addEventListener("click", onTableClick);
    $("rp-habits").addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.habitShow != null) {
        state.filter = "habit";
        state.habitShown = +b.dataset.habitShow;
        state.page = 0;
        renderReview();
        return;
      }
      const h = state.results.habits[+b.dataset.habit];
      if (!h) return;
      const open = habitOpen(h);
      open.forEach(([ i, k ]) => state.decisions.set(i, { chosen: k, confirmed: true }));
      if (state.filter === "habit") state.filter = "all";
      changed();
      flash(`Confirmed ${open.length} rows typed the same way — marked as checked by you`);
    });
    $("rp-table").addEventListener("change", onTableChange);
    $("rp-keep-all").addEventListener("click", () => {
      const list = keepableRows();
      list.forEach(i => state.decisions.set(i, { keep: true, confirmed: true }));
      changed();
      flash(`Kept ${list.length} values as typed — marked as checked by you`);
    });
    $("rp-confirm-all").addEventListener("click", () => {
      state.results.forEach((r, i) => {
        const d = state.decisions.get(i);
        if (r.status === "fixed" && !(d && (d.confirmed || d.rejected))) state.decisions.set(i, { ...(d || {}), confirmed: true });
      });
      changed();
    });
    $("rp-guess-all").addEventListener("click", () => {
      let n = 0;
      state.results.forEach((r, i) => {
        const d = state.decisions.get(i);
        if (r.status === "choose" && !d) {
          state.decisions.set(i, { chosen: r.chosen, guess: true });
          n++;
        }
      });
      changed();
      flash(`${n} rows set to their best guess — they stay marked "Best guess" until you confirm them`);
    });
    // Export formats: remembered per browser
    const FMT_KEYS = [ "rp-fmt-dd", "rp-fmt-dms", "rp-fmt-ddm", "rp-prec-dd", "rp-prec-dms", "rp-prec-ddm" ];
    try {
      const saved = JSON.parse(localStorage.getItem("cordify_repair_formats") || "{}");
      FMT_KEYS.forEach(k => {
        if (saved[k] === undefined || !$(k)) return;
        if ($(k).type === "checkbox") $(k).checked = saved[k];
        else $(k).value = saved[k];
      });
    } catch (e) {}
    FMT_KEYS.forEach(k => $(k)?.addEventListener("change", () => {
      const o = {};
      FMT_KEYS.forEach(x => { o[x] = $(x).type === "checkbox" ? $(x).checked : $(x).value; });
      try {
        localStorage.setItem("cordify_repair_formats", JSON.stringify(o));
      } catch (e) {}
    }));
    $("rp-save").addEventListener("click", saveReview);
    $("rp-resume").addEventListener("change", onResumeFile);
    $("rp-place-cancel").addEventListener("click", stopPlacing);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && state.placing != null) stopPlacing();
      if (e.key === "Escape" && state.drawing) stopDrawing();
    });
    window.addEventListener("beforeunload", e => {
      if (state.dirty && state.decisions.size) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
    $("rp-export-xlsx").addEventListener("click", exportWorkbook);
    $("rp-export-geojson").addEventListener("click", exportGeoJson);
    $("rp-export-kml").addEventListener("click", exportKml);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
