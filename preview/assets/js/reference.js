/*
 * Cordify — reference data kept on this device
 * The boundary and the village locations a person loads in Repair are remembered in
 * this browser's IndexedDB (db.js), never uploaded. Repair and Batch convert both use them.
 *
 * window.CordifyReference:
 *   readPlaces(file)        a village locations file -> [ { name, lat, lon, group } ]
 *   loadPlaces() / savePlaces(name, list) / forgetPlaces()
 *   loadBoundary()          the boundary saved by Repair: { name, src, nameField, savedAt } or null
 *   groupFeatures(rows, features, src)   which polygon(s) each group (sheet or district) belongs to
 */
(function () {
  "use strict";
  const BOUNDARY_KEY = "cordify_boundary_v1", PLACES_KEY = "cordify_places_v1";
  const DB = () => window.CordifyDB;
  const NAME = /village|vill\b|locality|place|site|settlement|habitation/i;
  const DISTRICT = /district|^dist\b|dtname|block|circle|sub.?div/i;

  async function get(key) {
    try {
      return DB() && await DB().ready ? await DB().get(key) : null;
    } catch (e) {
      return null;
    }
  }
  async function set(key, value) {
    try {
      if (!DB() || !await DB().ready) return false;
      await DB().set(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }
  async function del(key) {
    try {
      if (DB() && await DB().ready) await DB().del("kv", key);
    } catch (e) {}
  }

  function decode(buf) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch (e) {
      return new TextDecoder("windows-1252").decode(buf);
    }
  }

  // Names and points from a spreadsheet: a name column (Village, Locality, Name…), the
  // coordinate column(s) found the way Batch convert finds them, and a district column if any.
  function placesFromWorkbook(wb) {
    const B = window.CordifyBatchCore, out = [];
    const multi = wb.SheetNames.length > 1;
    for (const sheet of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: "", raw: true });
      const h = aoa.findIndex(r => r.some(c => String(c).trim() !== ""));
      if (h < 0) continue;
      const head = aoa[h].map(c => String(c).replace(/\s+/g, " ").trim());
      const data = aoa.slice(h + 1);
      const cfg = B.detect(head, data.slice(0, 60));
      if (!cfg.found) continue;
      const coord = new Set(cfg.mode === "one" ? [ cfg.one ] : [ cfg.lat, cfg.lon ]);
      const free = j => !coord.has(j);
      let ni = head.findIndex((x, j) => free(j) && NAME.test(x));
      if (ni < 0) ni = head.findIndex((x, j) => free(j) && /name/i.test(x) && !DISTRICT.test(x));
      if (ni < 0) continue;
      const di = head.findIndex((x, j) => free(j) && j !== ni && DISTRICT.test(x));
      for (const r of data) {
        const name = String(r[ni] ?? "").trim();
        if (!name) continue;
        const res = B.readRow(r, cfg);
        if (res.lat === undefined) continue;
        out.push({ name, lat: res.lat, lon: res.lon, group: di >= 0 ? String(r[di] ?? "").trim() : multi ? sheet : "" });
      }
    }
    return out;
  }

  async function readPlaces(file) {
    const G = window.CordifyGeoIO;
    if (/\.(kml|kmz|geojson|json|gpx)$/i.test(file.name)) {
      let t;
      if (/\.kmz$/i.test(file.name)) {
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        const entry = Object.values(zip.files).find(f => /\.kml$/i.test(f.name));
        if (!entry) throw new Error("This KMZ file has no KML inside.");
        t = G.parseKml(await entry.async("string"));
      } else {
        const text = decode(await file.arrayBuffer()).replace(/^﻿/, "");
        t = /\.kml$/i.test(file.name) ? G.parseKml(text) : /\.gpx$/i.test(file.name) ? G.parseGpx(text) : G.parseGeoJSON(text);
      }
      const gi = t.head.indexOf("Geometry");
      const di = t.head.findIndex((h, j) => j > 2 && DISTRICT.test(h));
      return t.rows.filter(r => gi < 0 || r[gi] === "Point")
        .map(r => ({ name: String(r[0] ?? "").trim(), lat: +r[1], lon: +r[2], group: di >= 0 ? String(r[di] ?? "").trim() : "" }))
        .filter(p => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    }
    if (typeof XLSX === "undefined") throw new Error("The spreadsheet library did not load. Reload the page and try again.");
    const buf = await file.arrayBuffer();
    const wb = /\.csv$/i.test(file.name) ? XLSX.read(decode(buf).replace(/^﻿/, ""), { type: "string" }) : XLSX.read(buf, { type: "array" });
    return placesFromWorkbook(wb);
  }

  /*
   * Which polygon(s) each group belongs to, the way Repair proposes it in step 3: learned from
   * where the group's correctly typed points fall. An area drawn on the map and attached to a
   * polygon counts as part of it.
   */
  function groupFeatures(rows, features, src) {
    const R = window.CordifyRepair;
    const learned = R.learnGroupFeatures(rows, features);
    const out = {};
    for (const [ g, v ] of Object.entries(learned)) out[g] = [ v.feature ].concat(attached(src, v.feature));
    return { groupFeatures: out, learned };
  }
  const attached = (src, k) => (src || []).map((f, i) => f.props && f.props.attachTo === k ? i : -1).filter(i => i >= 0);

  window.CordifyReference = {
    readPlaces, placesFromWorkbook, groupFeatures, attached,
    loadBoundary: () => get(BOUNDARY_KEY),
    loadPlaces: () => get(PLACES_KEY),
    savePlaces: (name, list) => set(PLACES_KEY, { name, list, savedAt: Date.now() }),
    forgetPlaces: () => del(PLACES_KEY)
  };
})();
