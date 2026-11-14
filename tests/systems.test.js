// Run with:  node tests/systems.test.js   (or: npm test)
// Other coordinate systems: UTM, MGRS, Web Mercator, radians, swapped, datums.
let proj4 = null;
try {
  proj4 = require("proj4");
} catch (e) {
  try {
    proj4 = require("../assets/vendor/proj4.js");
  } catch (e2) {}
}
if (proj4) global.proj4 = proj4;
const S = require("../assets/js/systems.js");
const C = require("../assets/js/core.js");
const B = require("../assets/js/batch-core.js");

let pass = 0, fail = 0;
function expect(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}
const m = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));

// UTM there and back, around the world
for (const p of [ { lat: 25.811, lon: 94.841 }, { lat: -33.86, lon: 151.21 }, { lat: 51.5, lon: -0.12 }, { lat: 0.1, lon: 6.1 }, { lat: -54.8, lon: -68.3 }, { lat: 64.1, lon: -21.9 } ]) {
  const z = C.utmZone(p.lat, p.lon), u = C.utmForward(p.lat, p.lon, z, p.lat < 0);
  expect(`UTM back to ${p.lat}, ${p.lon} within 1 mm`, m(S.utmInverse(u.e, u.n, z, p.lat < 0), p) < 0.001);
  const g = S.mgrsToUtm(S.toMgrs(p.lat, p.lon));
  expect(`MGRS back to ${p.lat}, ${p.lon} within 2 m`, g && m(S.utmInverse(g.e, g.n, g.zone, g.south), p) < 2, g);
}
if (proj4) {
  const u = C.utmForward(25.811, 94.841, 46, false), q = proj4("+proj=utm +zone=46 +datum=WGS84 +units=m +no_defs", "WGS84", [ u.e, u.n ]);
  expect("UTM inverse agrees with proj4", m(S.utmInverse(u.e, u.n, 46, false), { lat: q[1], lon: q[0] }) < 0.001);
}

// A published MGRS example: 4QFJ12345678 is in Honolulu
let r = S.readCell("4QFJ12345678");
expect("MGRS 4QFJ12345678 is in Honolulu", r && Math.abs(r.lat - 21.3094) < 0.001 && Math.abs(r.lon + 157.9169) < 0.001, r);
expect("MGRS with spaces", S.readCell("4Q FJ 1234 5678") && m(S.readCell("4Q FJ 1234 5678"), r) < 1);

// UTM with the zone in the cell
r = S.readCell("46R 684557 2856045");
expect("UTM with zone and band", r && m(r, { lat: 25.811, lon: 94.841 }) < 1, r);
expect("UTM written out", m(S.readCell("Zone 46N 684557mE 2856045mN"), { lat: 25.811, lon: 94.841 }) < 1);
expect("33S as latitude band S (northern)", S.readCell("33S 393000 4152000").lat > 37);
expect("33S as southern hemisphere", S.readCell("33S 393000 6152000").lat < -34);
expect("plain degrees are not UTM", S.readCell("25.811, 94.841") === null && S.readCell("26°41’451, 95°01’376") === null);

// Whole-sheet readings
const kip = { lat: 25.811, lon: 94.841 };
expect("Web Mercator metres", m(S.read([ "10557652, 2975691" ], { kind: "mercator" }), kip) < 1);
expect("radians (5 decimals is about 50 m)", m(S.read([ "0.45049, 1.65529" ], { kind: "radians" }), kip) < 100);
expect("swapped in one cell", m(S.read([ "94.841, 25.811" ], { kind: "swap" }), kip) < 0.01);
expect("swapped columns", m(S.read([ "94.841", "25.811" ], { kind: "swap" }), kip) < 0.01);
expect("Easting / Northing columns ([northing, easting])", m(S.read([ 2856045, 684557 ], { kind: "utm", zone: 46, south: false }), kip) < 1);
expect("one cell, northing first", m(S.read([ "2856045, 684557" ], { kind: "utm", zone: 46, south: false }), kip) < 1);
expect("not two numbers: an error", S.read([ "26°41’451" ], { kind: "utm", zone: 46, south: false }).error);

// Finding the system for a sheet
const box = { inside: (lat, lon) => lat > 25 && lat < 27.5 && lon > 93.3 && lon < 95.3 };
const pts = [ [ 25.811, 94.841 ], [ 26.1, 94.5 ], [ 25.9, 94.7 ], [ 26.3, 94.6 ], [ 25.7, 94.9 ] ];
const utmRows = pts.map(([ la, lo ]) => { const u = C.utmForward(la, lo, 46, false); return { cells: [ Math.round(u.n), Math.round(u.e) ] }; });
let d = S.detect(utmRows, box, { head: [ "Northing", "Easting" ] });
expect("grid columns: the boundary picks UTM 46N out of 121", d && d.sure && d.system.kind === "utm" && d.system.zone === 46 && !d.system.south, d && { s: d.system, why: d.why });
d = S.detect(utmRows, null, { head: [ "Northing", "Easting" ] });
expect("grid columns with nothing to go by: asks for the system", d && !d.sure && d.system === null && d.choices.length === 121, d && d.why);
d = S.detect(utmRows, null, { head: [ "Northing (UTM 46N)", "Easting" ] });
expect("the zone in the column name", d && d.sure && d.system.zone === 46, d && d.system);
d = S.detect(pts.map(([ la, lo ]) => ({ cells: [ `${C.utmZone(la, lo)}R ${Math.round(C.utmForward(la, lo, 46, false).e)} ${Math.round(C.utmForward(la, lo, 46, false).n)}` ] })), null);
expect("zone in each cell", d && d.system.kind === "cell", d);
d = S.detect(pts.map(([ la, lo ]) => ({ cells: [ `${(la * Math.PI / 180).toFixed(5)}, ${(lo * Math.PI / 180).toFixed(5)}` ] })), box);
expect("radians, confirmed by the boundary", d && d.sure && d.system.kind === "radians", d);
d = S.detect(pts.map(([ la, lo ]) => ({ cells: [ `${(la * Math.PI / 180).toFixed(5)}, ${(lo * Math.PI / 180).toFixed(5)}` ] })), null);
expect("radians with nothing to go by: suggested, not sure", d && !d.sure && d.system.kind === "radians", d);
d = S.detect(pts.map(([ la, lo ]) => ({ cells: [ `${la}, ${lo}` ] })), box);
expect("ordinary degrees: nothing to suggest", d === null, d);
d = S.detect(pts.map(([ la, lo ]) => ({ cells: [ `${lo}, ${la}` ] })), null, { swapped: 0.9 });
expect("mostly swapped: suggested", d && d.system.kind === "swap", d);

// Batch reads with a system
let res = B.readRow([ 2856045, 684557 ], { mode: "two", lat: 0, lon: 1, system: { kind: "utm", zone: 46, south: false } });
expect("batch: easting/northing with a system", res.lat !== undefined && m(res, kip) < 1, res);
res = B.readRow([ "0.45049, 1.65529" ], { mode: "one", one: 0, system: { kind: "radians" } });
expect("batch: radians", res.lat !== undefined && m(res, kip) < 100, res);
res = B.readRow([ "26.9, 95.1" ], { mode: "one", one: 0, system: { kind: "utm", zone: 46, south: false } });
expect("batch: a degree value in a UTM sheet is reported", /read as UTM zone 46N/.test(res.error || ""), res);
expect("batch: Easting / Northing columns are found", (() => { const c = B.detect([ "Village", "Easting", "Northing" ], [ [ "A", 684557, 2856045 ] ]); return c.found && c.grid && c.lat === 2 && c.lon === 1; })());

expect("batch: a column of UTM cells with zones is found", (() => { const c = B.detect([ "Name", "Grid" ], [ [ "A", "46R 684557 2856045" ], [ "B", "46RFP8455656044" ] ]); return c.found && c.mode === "one" && c.one === 1; })());

// The <select> keys Batch and Repair use for a system, there and back
expect("every choice survives key -> system", S.choices().every(sys => JSON.stringify(S.fromKey(S.keyOf(sys))) === JSON.stringify(sys)));
expect("121 + 3 choices", S.choices().length === 124);
expect("utm:46:N -> UTM zone 46N", JSON.stringify(S.fromKey("utm:46:N")) === JSON.stringify({ kind: "utm", zone: 46, south: false }));
expect("utm:33:S -> southern", S.fromKey("utm:33:S").south === true);
expect("a bad key gives nothing", S.fromKey("") === null && S.fromKey("utm:61:N") === null && S.fromKey("nonsense") === null && S.fromKey(undefined) === null);

// Datum
if (proj4) {
  const w = S.toWgs84(25.81, 94.84, "kalianpur1937");
  const shift = m(w, { lat: 25.81, lon: 94.84 });
  expect("Kalianpur 1937 shifts about 350 m in Nagaland", shift > 300 && shift < 400, shift);
  res = B.readRow([ "25.81, 94.84" ], { mode: "one", one: 0, datum: "kalianpur1975" });
  expect("batch: datum shift applied", res.lat !== undefined && m(res, { lat: 25.81, lon: 94.84 }) > 300, res);
  const ev = proj4("+proj=utm +zone=46 +a=6377299.151 +rf=300.8017255 +towgs84=295,736,257 +units=m", "WGS84", [ 684557, 2856045 ]);
  res = B.readRow([ 2856045, 684557 ], { mode: "two", lat: 0, lon: 1, system: { kind: "utm", zone: 46, south: false }, datum: "kalianpur1975" });
  expect("batch: UTM on Everest uses the Everest ellipsoid, shifted once", res.lat !== undefined && m(res, { lat: ev[1], lon: ev[0] }) < 0.01, res);
  expect("WGS 84 is unchanged", m(S.toWgs84(25.81, 94.84, "wgs84"), { lat: 25.81, lon: 94.84 }) === 0);
} else {
  console.log("(proj4 not found: datum checks skipped)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
