// Run with:  node tests/geo-io.test.js   (or: npm test)
// GIS file formats. Reading KML and GPX needs a browser, so it is checked there;
// here: reading GeoJSON, and writing GeoJSON, KML, GPX and GeoPackage geometry.
const G = require("../assets/js/geo-io.js");

let pass = 0, fail = 0;
function expect(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- reading GeoJSON ---------- */

let t = G.parseGeoJSON({ type: "FeatureCollection", features: [
  { type: "Feature", geometry: { type: "Point", coordinates: [ 95.034528456, 26.923417123, 412.5 ] }, properties: { name: "GCP-01", fix: "Fixed", sigma_mm: 8 } },
  { type: "Feature", geometry: { type: "Point", coordinates: [ 95.04, 26.93 ] }, properties: { name: "GCP-02", note: "no height" } },
  { type: "Feature", geometry: null, properties: { name: "nothing" } }
] });
expect("points become rows, longitude/latitude the right way round", same(t.head, [ "Name", "Latitude", "Longitude", "Elevation", "fix", "sigma_mm", "note" ]) && t.rows.length === 2 && t.rows[0][1] === 26.923417123 && t.rows[0][2] === 95.034528456 && t.rows[0][3] === 412.5, t);
expect("missing values are blank", t.rows[1][0] === "GCP-02" && t.rows[1][3] === "" && t.rows[1][4] === "" && t.rows[1][6] === "no height", t.rows[1]);

t = G.parseGeoJSON(JSON.stringify({ type: "Feature", id: 7, geometry: { type: "LineString", coordinates: [ [ 1, 2 ], [ 3, 4 ] ] }, properties: { Latitude: "mine" } }));
expect("lines come in as their corner points", same(t.head, [ "Name", "Latitude", "Longitude", "Geometry", "Vertex", "Latitude (original)" ]) && same(t.rows, [ [ "7", 2, 1, "LineString", 1, "mine" ], [ "7", 4, 3, "LineString", 2, "mine" ] ]), t);
t = G.parseGeoJSON({ type: "MultiPolygon", coordinates: [ [ [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 0 ] ] ] ] });
expect("a bare polygon geometry", t.rows.length === 4 && t.rows[2][3] === "Polygon" && t.rows[2][4] === 3, t);
expect("nothing usable gives no rows", G.parseGeoJSON({ type: "FeatureCollection", features: [] }).rows.length === 0);

/* ---------- writing ---------- */

const props = [ [ "ID", "GCP <1> & \"co\"" ], [ "Lat_DD", 26.923417123 ], [ "Empty", "" ] ];
let w = G.textWriter("geojson", "survey");
let text = w.head + w.point("A", 26.923417123, 95.034528456, props) + w.point("B", -33.8688, 151.2093, []) + w.tail;
const gj = JSON.parse(text);
expect("GeoJSON is valid and exact", gj.features.length === 2 && same(gj.features[0].geometry.coordinates, [ 95.034528456, 26.923417123 ]) && gj.features[0].properties.Lat_DD === 26.923417123 && !("Empty" in gj.features[0].properties) && gj.name === "survey", gj);
expect("GeoJSON reads back to the same points", same(G.parseGeoJSON(text).rows.map(r => [ r[1], r[2] ]), [ [ 26.923417123, 95.034528456 ], [ -33.8688, 151.2093 ] ]));

w = G.textWriter("kml", "a & b");
text = w.head + w.point("P<1>", 26.5, 95.25, props) + w.tail;
expect("KML escapes text and writes lon,lat", text.includes("<name>a &amp; b</name>") && text.includes("<name>P&lt;1&gt;</name>") && text.includes("<coordinates>95.25,26.5,0</coordinates>") && text.includes('<Data name="ID"><value>GCP &lt;1&gt; &amp; &quot;co&quot;</value></Data>') && !text.includes('name="Empty"'), text);

w = G.textWriter("gpx", "t");
text = w.head + w.point("P1", 26.5, 95.25, props) + w.tail;
expect("GPX waypoint", text.includes('<wpt lat="26.5" lon="95.25"><name>P1</name><desc>ID: GCP &lt;1&gt; &amp; &quot;co&quot;; Lat_DD: 26.923417123</desc></wpt>') && text.includes('version="1.1"'), text);

/* ---------- GeoPackage pieces that need no database ---------- */

const b = G.gpkgPoint(95.034528456, 26.923417123), v = new DataView(b.buffer);
expect("point blob: GP header, EPSG:4326, WKB point", b.length === 29 && b[0] === 0x47 && b[1] === 0x50 && b[3] === 1 && v.getInt32(4, true) === 4326 && b[8] === 1 && v.getUint32(9, true) === 1 && v.getFloat64(13, true) === 95.034528456 && v.getFloat64(21, true) === 26.923417123);
expect("column names are made safe and unique", same(G.columnNames([ "ID", "id", "geom", "", 'a"b', "fid" ]), [ "ID", "id_2", "geom_2", "column_4", "ab", "fid_2" ]), G.columnNames([ "ID", "id", "geom", "", 'a"b', "fid" ]));

/* ---------- coloured KML pins ---------- */

w = G.textWriter("kml", "t");
text = w.head + w.point("A", 26.5, 95.25, [], "bad") + w.point("B", 26.6, 95.3, []) + w.tail;
expect("KML has a style per colour and a pin can use one", /<Style id="bad">/.test(text) && /<Style id="ok">/.test(text) && /<name>A<\/name><styleUrl>#bad<\/styleUrl>/.test(text) && /<name>B<\/name><Point>/.test(text));

/* ---------- Shapefile (read back by the published format, byte by byte) ---------- */

expect("short column names are safe and unique", JSON.stringify(G.dbfNames([ "Name of the Farmer", "Name of the Village", "Lat_DD", "1st visit", "Área (ha)", "" ])) ===
  JSON.stringify([ "Name_of_th", "Name_of__1", "Lat_DD", "F1st_visit", "Area_ha", "FIELD6" ]), G.dbfNames([ "Name of the Farmer", "Name of the Village", "Lat_DD", "1st visit", "Área (ha)", "" ]));

const pts = [
  { lat: 26.923417, lon: 95.034528, values: [ "Wangkhao", 26.923417, "Fixed" ] },
  { lat: -33.8688, lon: 151.2093, values: [ "Kōhima — ऊँचा", -33.8688, "line one\nline two" ] },
  { lat: 0, lon: 0, values: [ "", "", null ] }
];
const cols = [ { name: "Village", type: "TEXT" }, { name: "Lat_DD", type: "DOUBLE" }, { name: "Note", type: "TEXT" } ];
const s = G.shapefile(pts, cols);
const shp = new DataView(s.shp.buffer), shx = new DataView(s.shx.buffer), dbf = new DataView(s.dbf.buffer);
expect("shp header: code 9994, length in words, version 1000, point type", shp.getInt32(0) === 9994 && shp.getInt32(24) * 2 === s.shp.length && shp.getInt32(28, true) === 1000 && shp.getInt32(32, true) === 1);
expect("shp bounding box", shp.getFloat64(36, true) === 0 && shp.getFloat64(44, true) === -33.8688 && shp.getFloat64(52, true) === 151.2093 && shp.getFloat64(60, true) === 26.923417);
const rec = i => ({ no: shp.getInt32(100 + 28 * i), len: shp.getInt32(104 + 28 * i), type: shp.getInt32(108 + 28 * i, true), x: shp.getFloat64(112 + 28 * i, true), y: shp.getFloat64(120 + 28 * i, true) });
expect("shp records hold longitude, latitude exactly", rec(0).no === 1 && rec(0).len === 10 && rec(0).type === 1 && rec(0).x === 95.034528 && rec(0).y === 26.923417 && rec(1).x === 151.2093 && rec(2).no === 3, [ rec(0), rec(1) ]);
expect("shx points at each record", shx.getInt32(24) * 2 === s.shx.length && shx.getInt32(100) === 50 && shx.getInt32(108) === 64 && shx.getInt32(104) === 10);

const dec = new TextDecoder();
const nRec = dbf.getUint32(4, true), hLen = dbf.getUint16(8, true), rLen = dbf.getUint16(10, true);
const fields = [];
for (let o = 32; s.dbf[o] !== 0x0D; o += 32) fields.push({ name: dec.decode(s.dbf.slice(o, o + 11)).replace(/\0+$/, ""), type: String.fromCharCode(s.dbf[o + 11]), len: s.dbf[o + 16], dec: s.dbf[o + 17] });
expect("dbf header: version, records, sizes", s.dbf[0] === 3 && nRec === 3 && hLen === 32 + 32 * 3 + 1 && rLen === 1 + fields.reduce((a, f) => a + f.len, 0) && s.dbf.length === hLen + rLen * 3 + 1 && s.dbf[s.dbf.length - 1] === 0x1A);
expect("dbf fields: text and number", fields[0].name === "Village" && fields[0].type === "C" && fields[1].name === "Lat_DD" && fields[1].type === "N" && fields[1].len === 20 && fields[1].dec === 9 && fields[2].type === "C", fields);
const cellsOf = i => {
  let o = hLen + i * rLen + 1;
  return fields.map(f => {
    const v = dec.decode(s.dbf.slice(o, o + f.len));
    o += f.len;
    return v;
  });
};
const r1 = cellsOf(1);
expect("dbf text is UTF-8, line breaks become spaces", r1[0].trim() === "Kōhima — ऊँचा" && r1[2].trim() === "line one line two" && s.cpg === "UTF-8", r1);
expect("dbf numbers are right-aligned with their decimals", cellsOf(0)[1] === "26.923417000".padStart(20) && cellsOf(1)[1].trim() === "-33.868800000", cellsOf(0)[1]);
expect("empty values are blank", cellsOf(2).every(v => v.trim() === "") && s.dbf[hLen + 2 * rLen] === 0x20);
expect("the .prj says WGS 84", /GCS_WGS_1984/.test(s.prj) && /6378137/.test(s.prj));
const long = G.shapefile([ { lat: 1, lon: 1, values: [ "é".repeat(300) ] } ], [ { name: "T", type: "TEXT" } ]);
expect("text longer than 254 bytes is cut at a character, not in the middle of one", long.dbf[32 + 16] === 254 && new TextDecoder("utf-8", { fatal: true }).decode(long.dbf.slice(32 + 32 + 1 + 1, 32 + 32 + 1 + 1 + 254)).length === 127);
expect("no points still makes valid files", G.shapefile([], cols).shp.length === 100 && new DataView(G.shapefile([], cols).dbf.buffer).getUint32(4, true) === 0);

console.log(`\ngeo-io: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
