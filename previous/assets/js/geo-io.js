/*
 * Cordify — GIS file formats
 * Reads points out of GeoJSON, KML and GPX into a plain table (so Batch convert can
 * treat them like a spreadsheet), and writes points as GeoJSON, KML, GPX and
 * GeoPackage. All coordinates are WGS 84 (EPSG:4326), which is what these formats use.
 *
 * No screen code: used on the page, in the background worker and in Node tests.
 * (Reading KML and GPX needs the browser's XML reader, so that part is page-only.)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CordifyGeoIO = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- reading: everything becomes rows of a table ---------- */

  // Collects points; lines and polygons are kept as their corner points, in order.
  function table() {
    const items = [], keys = [];
    let hasEle = false, hasShape = false;
    return {
      add(name, shape, vertex, lon, lat, ele, props) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        if (Number.isFinite(ele)) hasEle = true;
        if (shape !== "Point") hasShape = true;
        for (const k of Object.keys(props || {})) if (!keys.includes(k)) keys.push(k);
        items.push({ name, shape, vertex, lon, lat, ele, props: props || {} });
      },
      done() {
        const fixed = [ "Name", "Latitude", "Longitude" ].concat(hasEle ? [ "Elevation" ] : [], hasShape ? [ "Geometry", "Vertex" ] : []);
        // A property called like one of our own columns keeps its data under a clear name.
        const names = keys.map(k => fixed.some(f => f.toLowerCase() === k.toLowerCase()) ? `${k} (original)` : k);
        const rows = items.map(p => [ p.name ?? "", p.lat, p.lon ]
          .concat(hasEle ? [ Number.isFinite(p.ele) ? p.ele : "" ] : [], hasShape ? [ p.shape, p.vertex ] : [],
            keys.map(k => {
              const v = p.props[k];
              return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v;
            })));
        return { head: fixed.concat(names), rows };
      }
    };
  }

  const NAME_KEY = /^(name|id|point|point ?(name|id|no)|label|station|gcp|title)$/i;
  function parseGeoJSON(obj) {
    if (typeof obj === "string") obj = JSON.parse(obj);
    const t = table();
    const walk = (g, name, props) => {
      if (!g) return;
      const c = g.coordinates;
      const line = (pts, shape) => pts.forEach((p, i) => t.add(name, shape, i + 1, +p[0], +p[1], +p[2], props));
      if (g.type === "Point") t.add(name, "Point", 1, +c[0], +c[1], +c[2], props);
      else if (g.type === "MultiPoint") line(c, "Point");
      else if (g.type === "LineString") line(c, "LineString");
      else if (g.type === "MultiLineString") c.forEach(l => line(l, "LineString"));
      else if (g.type === "Polygon") c.forEach(ring => line(ring, "Polygon"));
      else if (g.type === "MultiPolygon") c.forEach(poly => poly.forEach(ring => line(ring, "Polygon")));
      else if (g.type === "GeometryCollection") (g.geometries || []).forEach(x => walk(x, name, props));
    };
    const feature = f => {
      // The property used as the name goes in the Name column, not in a second copy of it.
      const props = { ...(f.properties || {}) };
      const key = Object.keys(props).find(x => NAME_KEY.test(x));
      const name = key ? String(props[key]) : f.id != null ? String(f.id) : "";
      if (key) delete props[key];
      walk(f.geometry, name, props);
    };
    if (obj && obj.type === "FeatureCollection") (obj.features || []).forEach(feature);
    else if (obj && obj.type === "Feature") feature(obj);
    else walk(obj, "", {});
    return t.done();
  }

  // Tag names without their namespace prefix, so kml:Placemark and Placemark are the same.
  const local = el => el.localName || el.nodeName.replace(/^.*:/, "");
  const kids = (el, name) => [ ...el.children ].filter(c => local(c) === name);
  const all = (el, name) => [ ...el.getElementsByTagName("*") ].filter(c => local(c) === name);
  const textOf = (el, name) => {
    const c = kids(el, name)[0];
    return c ? c.textContent.trim() : "";
  };
  function xml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("not valid XML");
    return doc;
  }

  function parseKml(text) {
    const doc = xml(text), t = table();
    for (const pm of all(doc, "Placemark")) {
      const props = {};
      const desc = textOf(pm, "description");
      if (desc) props.description = desc;
      all(pm, "Data").forEach(d => { props[d.getAttribute("name") || "data"] = textOf(d, "value"); });
      all(pm, "SimpleData").forEach(d => { props[d.getAttribute("name") || "data"] = d.textContent.trim(); });
      const name = textOf(pm, "name");
      for (const c of all(pm, "coordinates")) {
        const parent = local(c.parentNode);
        const shape = parent === "Point" ? "Point" : parent === "LinearRing" ? "Polygon" : "LineString";
        c.textContent.trim().split(/\s+/).forEach((tuple, i) => {
          const p = tuple.split(",");
          if (p.length >= 2) t.add(name, shape, i + 1, parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]), props);
        });
      }
    }
    return t.done();
  }

  function parseGpx(text) {
    const doc = xml(text), t = table();
    const point = (el, name, shape, i, extra) => {
      const props = { ...extra };
      for (const k of [ "time", "desc", "cmt", "sym", "type", "fix", "sat", "hdop", "vdop", "pdop" ]) {
        const v = textOf(el, k);
        if (v) props[k] = v;
      }
      const ele = textOf(el, "ele");
      t.add(textOf(el, "name") || name, shape, i, parseFloat(el.getAttribute("lon")), parseFloat(el.getAttribute("lat")), ele === "" ? NaN : parseFloat(ele), props);
    };
    all(doc, "wpt").forEach(el => point(el, "", "Point", 1, {}));
    all(doc, "rte").forEach(r => all(r, "rtept").forEach((el, i) => point(el, textOf(r, "name"), "LineString", i + 1, { part: "route" })));
    all(doc, "trk").forEach(tr => {
      let i = 0;
      all(tr, "trkpt").forEach(el => point(el, textOf(tr, "name"), "LineString", ++i, { part: "track" }));
    });
    return t.done();
  }

  /* ---------- writing text formats, one point at a time ---------- */

  // Pin colours for Google Earth, the same as Cordify's review table (KML colours are aabbggrr).
  const KML_COLOURS = { ok: "ff327d2e", fixed: "ff0097c9", check: "ff007be0", bad: "ff2828c6", confirmed: "ffc06515" };
  const KML_STYLES = Object.entries(KML_COLOURS).map(([ id, c ]) =>
    `<Style id="${id}"><IconStyle><color>${c}</color><scale>0.9</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`).join("");

  const escXml = s => String(s ?? "").replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  const num = v => +v.toFixed(9);   // 9 decimals of a degree is about 0.1 mm

  /*
   * format: "geojson" | "kml" | "gpx". Returns { head, point(name, lat, lon, props), tail, ext, mime }
   * where props is a list of [ key, value ] pairs. Build the file as head + points + tail.
   */
  function textWriter(format, title) {
    let first = true;
    if (format === "geojson") {
      return {
        ext: "geojson", mime: "application/geo+json",
        head: `{"type":"FeatureCollection","name":${JSON.stringify(title)},"features":[\n`,
        point(name, lat, lon, props) {
          const properties = {};
          for (const [ k, v ] of props) if (v !== "" && v != null) properties[k] = v;
          const s = (first ? "" : ",\n") + JSON.stringify({ type: "Feature", geometry: { type: "Point", coordinates: [ num(lon), num(lat) ] }, properties });
          first = false;
          return s;
        },
        tail: "\n]}\n"
      };
    }
    if (format === "kml") {
      return {
        ext: "kml", mime: "application/vnd.google-earth.kml+xml",
        head: `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escXml(title)}</name>\n${KML_STYLES}\n`,
        // kind ("ok", "fixed", "check", "bad", "confirmed") colours the pin; leave it out for plain pins.
        point(name, lat, lon, props, kind) {
          const data = props.filter(p => p[1] !== "" && p[1] != null).map(([ k, v ]) => `<Data name="${escXml(k)}"><value>${escXml(v)}</value></Data>`).join("");
          return `<Placemark><name>${escXml(name)}</name>${kind && KML_COLOURS[kind] ? `<styleUrl>#${kind}</styleUrl>` : ""}${data ? `<ExtendedData>${data}</ExtendedData>` : ""}<Point><coordinates>${num(lon)},${num(lat)},0</coordinates></Point></Placemark>\n`;
        },
        tail: "</Document></kml>\n"
      };
    }
    if (format === "gpx") {
      return {
        ext: "gpx", mime: "application/gpx+xml",
        head: `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Cordify" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${escXml(title)}</name></metadata>\n`,
        point(name, lat, lon, props) {
          const desc = props.filter(p => p[1] !== "" && p[1] != null).map(([ k, v ]) => `${k}: ${v}`).join("; ");
          return `<wpt lat="${num(lat)}" lon="${num(lon)}"><name>${escXml(name)}</name>${desc ? `<desc>${escXml(desc)}</desc>` : ""}</wpt>\n`;
        },
        tail: "</gpx>\n"
      };
    }
    throw new Error("unknown format " + format);
  }

  /* ---------- writing GeoPackage (needs sql.js, passed in as SQL) ---------- */

  const WGS84_WKT = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';
  const ident = s => '"' + String(s).replace(/"/g, '""') + '"';

  // A point as GeoPackage stores it: "GP" header, then standard well-known binary.
  function gpkgPoint(lon, lat) {
    const buf = new ArrayBuffer(29), v = new DataView(buf);
    v.setUint8(0, 0x47);
    v.setUint8(1, 0x50);
    v.setUint8(2, 0);          // version
    v.setUint8(3, 1);          // little-endian, no envelope
    v.setInt32(4, 4326, true); // srs
    v.setUint8(8, 1);          // WKB: little-endian
    v.setUint32(9, 1, true);   // WKB: Point
    v.setFloat64(13, lon, true);
    v.setFloat64(21, lat, true);
    return new Uint8Array(buf);
  }

  // Column names that are safe and unique inside one table.
  function columnNames(names) {
    const used = new Set([ "fid", "geom" ]);
    return names.map((n, j) => {
      let base = String(n ?? "").trim().replace(/[\u0000-\u001F"]/g, "").slice(0, 60) || `column_${j + 1}`, name = base, k = 2;
      while (used.has(name.toLowerCase())) name = `${base}_${k++}`;
      used.add(name.toLowerCase());
      return name;
    });
  }

  /*
   * gpkg(SQL) -> { table(name, columns), finish() }
   *   columns: [ { name, type: "TEXT" | "DOUBLE" } ]
   *   table() -> { point(lat, lon, values) }   one feature per call
   *   finish() -> Uint8Array, the .gpkg file
   */
  function gpkg(SQL) {
    const db = new SQL.Database();
    db.run("PRAGMA application_id = 1196444487; PRAGMA user_version = 10200;");
    db.run(`CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
      CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
      CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id));`);
    db.run("INSERT INTO gpkg_spatial_ref_sys VALUES ('WGS 84 geodetic', 4326, 'EPSG', 4326, ?, 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid'), ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system'), ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system')", [ WGS84_WKT ]);
    const tables = new Set();
    const closers = [];
    return {
      table(wanted, columns) {
        let base = String(wanted || "points").replace(/[^\w]+/g, "_").replace(/^(\d)/, "_$1").replace(/^gpkg_/i, "t_gpkg_").slice(0, 50) || "points", name = base, k = 2;
        while (tables.has(name.toLowerCase())) name = `${base}_${k++}`;
        tables.add(name.toLowerCase());
        const names = columnNames(columns.map(c => c.name));
        db.run(`CREATE TABLE ${ident(name)} (fid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, geom POINT${names.map((n, j) => `, ${ident(n)} ${columns[j].type === "DOUBLE" ? "DOUBLE" : "TEXT"}`).join("")})`);
        db.run("BEGIN");
        const stmt = db.prepare(`INSERT INTO ${ident(name)} VALUES (NULL, ?${", ?".repeat(names.length)})`);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
        closers.push(() => {
          stmt.free();
          db.run("COMMIT");
          db.run("INSERT INTO gpkg_contents (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id) VALUES (?, 'features', ?, ?, ?, ?, ?, 4326)", [ name, name, n ? minX : null, n ? minY : null, n ? maxX : null, n ? maxY : null ]);
          db.run("INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', 'POINT', 4326, 0, 0)", [ name ]);
        });
        return {
          point(lat, lon, values) {
            const row = [ gpkgPoint(lon, lat) ];
            for (let j = 0; j < names.length; j++) {
              const v = values[j];
              row.push(v === "" || v == null ? null : columns[j].type === "DOUBLE" ? (Number.isFinite(+v) ? +v : null) : String(v));
            }
            stmt.run(row);
            n++;
            if (lon < minX) minX = lon;
            if (lon > maxX) maxX = lon;
            if (lat < minY) minY = lat;
            if (lat > maxY) maxY = lat;
          }
        };
      },
      finish() {
        closers.forEach(c => c());
        const bytes = db.export();
        db.close();
        return bytes;
      }
    };
  }

  // Which of the output columns hold numbers (the rest are text).
  const NUMERIC = /^(Lat_DD|Lon_DD|Easting|Northing)$/;

  /* ---------- writing a Shapefile ---------- */

  // The coordinate system file (.prj) for WGS 84 latitude/longitude, as ArcGIS and QGIS write it.
  const SHP_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

  // Column names a Shapefile accepts: at most 10 letters, digits or _, starting with a letter, unique.
  function dbfNames(names) {
    const used = new Set();
    return names.map((n, j) => {
      let base = String(n ?? "").normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || `FIELD${j + 1}`;
      if (!/^[A-Za-z]/.test(base)) base = `F${base}`;
      base = base.slice(0, 10);
      let name = base, k = 1;
      while (used.has(name.toUpperCase())) {
        const tail = `_${k++}`;
        name = base.slice(0, 10 - tail.length) + tail;
      }
      used.add(name.toUpperCase());
      return name;
    });
  }

  /*
   * A point Shapefile, as the five files it is made of: { shp, shx, dbf, prj, cpg } (Uint8Array or text)
   * plus names (the short column names, in column order).
   *   points   [ { lat, lon, values: [...] } ]
   *   columns  [ { name, type: "TEXT" | "DOUBLE" } ]   one per value
   * Text is stored as UTF-8 (the .cpg file says so), up to 254 bytes per value.
   */
  function shapefile(points, columns) {
    const n = points.length, enc = new TextEncoder();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.lon < minX) minX = p.lon;
      if (p.lon > maxX) maxX = p.lon;
      if (p.lat < minY) minY = p.lat;
      if (p.lat > maxY) maxY = p.lat;
    }
    if (!n) minX = minY = maxX = maxY = 0;
    // .shp (the points) and .shx (where each one starts). Lengths are counted in 16-bit words.
    const shp = new DataView(new ArrayBuffer(100 + 28 * n)), shx = new DataView(new ArrayBuffer(100 + 8 * n));
    for (const [ v, bytes ] of [ [ shp, 100 + 28 * n ], [ shx, 100 + 8 * n ] ]) {
      v.setInt32(0, 9994);                // file code (big-endian)
      v.setInt32(24, bytes / 2);          // file length in words (big-endian)
      v.setInt32(28, 1000, true);         // version
      v.setInt32(32, 1, true);            // shape type: point
      v.setFloat64(36, minX, true);
      v.setFloat64(44, minY, true);
      v.setFloat64(52, maxX, true);
      v.setFloat64(60, maxY, true);
    }
    points.forEach((p, i) => {
      const o = 100 + 28 * i;
      shp.setInt32(o, i + 1);             // record number (big-endian)
      shp.setInt32(o + 4, 10);            // content length in words
      shp.setInt32(o + 8, 1, true);
      shp.setFloat64(o + 12, p.lon, true);
      shp.setFloat64(o + 20, p.lat, true);
      shx.setInt32(100 + 8 * i, o / 2);
      shx.setInt32(104 + 8 * i, 10);
    });

    // .dbf (the attributes): dBASE III with fixed-width text and number columns.
    const names = dbfNames(columns.map(c => c.name));
    const decimals = columns.map(c => c.type === "DOUBLE" ? (/easting|northing/i.test(c.name) ? 3 : 9) : 0);
    const fit = (s, w) => {
      let b = enc.encode(s);
      while (b.length > w) {
        s = s.slice(0, -1);
        b = enc.encode(s);
      }
      return b;
    };
    const text = points.map(p => columns.map((c, j) => {
      const v = p.values[j];
      if (c.type === "DOUBLE") return v === "" || v == null || !Number.isFinite(+v) ? "" : (+v).toFixed(decimals[j]);
      if (v == null) return "";
      if (v instanceof Date) return isNaN(v) ? "" : v.toISOString().slice(0, 19).replace("T", " ");
      return String(v).replace(/\s*[\r\n]+\s*/g, " ").trim();
    }));
    const widths = columns.map((c, j) => c.type === "DOUBLE" ? 20 : Math.min(254, Math.max(1, ...text.map(r => enc.encode(r[j]).length))));
    const headerLen = 32 + 32 * columns.length + 1, recLen = 1 + widths.reduce((a, w) => a + w, 0);
    const dbf = new Uint8Array(headerLen + recLen * n + 1), dv = new DataView(dbf.buffer);
    const today = new Date();
    dbf[0] = 0x03;
    dbf[1] = today.getFullYear() - 1900;
    dbf[2] = today.getMonth() + 1;
    dbf[3] = today.getDate();
    dv.setUint32(4, n, true);
    dv.setUint16(8, headerLen, true);
    dv.setUint16(10, recLen, true);
    columns.forEach((c, j) => {
      const o = 32 + 32 * j;
      dbf.set(enc.encode(names[j]), o);
      dbf[o + 11] = (c.type === "DOUBLE" ? "N" : "C").charCodeAt(0);
      dbf[o + 16] = widths[j];
      dbf[o + 17] = decimals[j];
    });
    dbf[headerLen - 1] = 0x0D;
    text.forEach((row, i) => {
      let o = headerLen + i * recLen;
      dbf.fill(0x20, o, o + recLen);      // blank record, not deleted
      o++;
      row.forEach((s, j) => {
        const b = fit(s, widths[j]);
        dbf.set(b, columns[j].type === "DOUBLE" ? o + widths[j] - b.length : o);   // numbers right-aligned
        o += widths[j];
      });
    });
    dbf[dbf.length - 1] = 0x1A;
    return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer), dbf, prj: SHP_PRJ, cpg: "UTF-8", names };
  }

  // The column that names each point: an ID or name column, else any "…name…" column, else the village.
  function labelColumn(head) {
    let i = head.findIndex(h => NAME_KEY.test(String(h ?? "").trim()));
    if (i < 0) i = head.findIndex(h => /name/i.test(h));
    if (i < 0) i = head.findIndex(h => /village|locality|site|place/i.test(h));
    return i;
  }

  return { parseGeoJSON, parseKml, parseGpx, textWriter, gpkg, gpkgPoint, columnNames, shapefile, dbfNames, labelColumn, KML_COLOURS, NAME_KEY, NUMERIC };
});
