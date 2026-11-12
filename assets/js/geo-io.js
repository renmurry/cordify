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
        head: `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escXml(title)}</name>\n`,
        point(name, lat, lon, props) {
          const data = props.filter(p => p[1] !== "" && p[1] != null).map(([ k, v ]) => `<Data name="${escXml(k)}"><value>${escXml(v)}</value></Data>`).join("");
          return `<Placemark><name>${escXml(name)}</name>${data ? `<ExtendedData>${data}</ExtendedData>` : ""}<Point><coordinates>${num(lon)},${num(lat)},0</coordinates></Point></Placemark>\n`;
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

  return { parseGeoJSON, parseKml, parseGpx, textWriter, gpkg, gpkgPoint, columnNames, NAME_KEY, NUMERIC };
});
