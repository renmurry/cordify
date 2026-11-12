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

console.log(`\ngeo-io: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
