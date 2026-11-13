// Run with:  node tests/batch-core.test.js   (or: npm test)
// Reading rows, finding columns and CSV handling for Batch convert.
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- rows ---------- */

const two = { mode: "two", lat: 1, lon: 2 }, one = { mode: "one", one: 0 };
let r = B.readRow([ "A", "26.923417123", "95.034528456" ], two);
expect("two columns, full precision kept", r.lat === 26.923417123 && r.lon === 95.034528456 && B.statusOf(r) === B.OK, r);
r = B.readRow([ "26°55'24.3\" N, 95°02'04.3\" E" ], one);
expect("one column DMS pair", Math.abs(r.lat - 26.92341666666667) < 1e-12 && Math.abs(r.lon - 95.03452777777778) < 1e-12, r);
r = B.readRow([ "E 94.8, N 26.2" ], one);
expect("letters decide the order", r.lat === 26.2 && r.lon === 94.8, r);
expect("blank row is empty", B.statusOf(B.readRow([ "A", "", " - " ], two)) === B.EMPTY);
r = B.readRow([ "A", "", "95.1" ], two);
expect("one value missing", r.error === "latitude is missing" && B.statusOf(r) === B.FAILED, r);
r = B.readRow([ "A", "95.03", "26.92" ], two);
expect("swapped columns are reported, not fixed", /swapped/.test(r.error) && B.statusOf(r) === B.MISTYPED, r);
r = B.readRow([ "A", "12.5° 30'", "95.1" ], two);
expect("ambiguous value is not guessed", r.lat === undefined && B.statusOf(r) === B.MISTYPED, r);
expect("original text for the preview", B.rawOf([ "A", "1", "2" ], two) === "1  |  2" && B.rawOf([ "1, 2" ], one) === "1, 2");

/* ---------- columns ---------- */

let d = B.detect([ "ID", "Latitude", "Longitude" ], [ [ "a", "26.9", "95.0" ] ]);
expect("finds Lat and Lon columns by name", d.found && d.mode === "two" && d.lat === 1 && d.lon === 2, d);
d = B.detect([ "ID", "Notes", "Where" ], [ [ "a", "x", "26.92, 95.03" ], [ "b", "y", "26.93, 95.04" ] ]);
expect("finds a pair column by its values", d.found && d.mode === "one" && d.one === 2, d);
expect("says so when nothing looks like coordinates", B.detect([ "A", "B" ], [ [ "x", "y" ] ]).found === false);

/* ---------- CSV ---------- */

expect("plain record", same(B.parseCsvRecord("a,b,,d"), [ "a", "b", "", "d" ]));
expect("quotes, doubled quotes and a comma inside", same(B.parseCsvRecord('1,"26°55\'24.3"" N, 95°2\'4"" E",x'), [ "1", "26°55'24.3\" N, 95°2'4\" E", "x" ]));
expect("line break inside quotes", same(B.parseCsvRecord('"a\nb",c'), [ "a\nb", "c" ]));
expect("semicolon and tab", same(B.parseCsvRecord("a;b,c;d", ";"), [ "a", "b,c", "d" ]) && same(B.parseCsvRecord("a\tb", "\t"), [ "a", "b" ]));
expect("trailing delimiter gives an empty last cell", same(B.parseCsvRecord("a,"), [ "a", "" ]) && same(B.parseCsvRecord(""), [ "" ]));
expect("records split outside quotes only", same(B.splitCsvRecords('h1,h2\r\n1,"x\ny"\n2,z'), [ "h1,h2", '1,"x\ny"', "2,z" ]));
expect("delimiter sniffing", B.sniffDelimiter("a;b;c\n1;2;3\n") === ";" && B.sniffDelimiter("a\tb\n1\t2\n") === "\t" && B.sniffDelimiter("a,b\n1,2\n") === "," && B.sniffDelimiter("id;lat,lon\n1;26,9\n") === ";");
expect("cells are quoted only when needed", B.csvCell('26° 11\' 23.72" N') === '"26° 11\' 23.72"" N"' && B.csvCell(26.5) === "26.5" && B.csvCell("a;b", ";") === '"a;b"' && B.csvCell(null) === "");

// Record ends found in raw bytes, in pieces of any size, match the text version.
const text = 'id,coord\n1,"26.9, 95.0"\r\n2,"line\nbreak"\n\n3,x';
const bytes = Buffer.from(text, "utf8");
for (const size of [ 1, 3, 7, 1000 ]) {
  const state = { quoted: false }, ends = [];
  for (let at = 0; at < bytes.length; at += size) {
    B.recordEnds(bytes.subarray(at, at + size), state).forEach(e => ends.push(at + e));
  }
  const records = [];
  let from = 0;
  for (const e of ends.concat(bytes.length)) {
    if (e > from) records.push(bytes.subarray(from, e).toString("utf8").replace(/\r?\n$/, ""));
    from = e;
  }
  expect(`byte scan in pieces of ${size}`, same(records, B.splitCsvRecords(text)), records);
}

/* ---------- output ---------- */

const f = { dd: true, dms: true, ddm: false, ddDigits: 9, secDigits: 2, minDigits: 4, grid: true };
let cols = B.outCols({ lat: 26.923417123, lon: 95.034528456 }, f, B.gridCells("utm"));
expect("output columns in order", same(cols.map(c => c[0]), [ "Lat_DD", "Lon_DD", "Lat_DMS", "Lon_DMS", "Easting", "Northing", "Grid", "Convert_Status", "Convert_Check" ]), cols);
expect("output values", cols[0][1] === 26.923417123 && cols[2][1] === "26° 55' 24.30\" N" && cols[4][1] === 702017.909 && cols[6][1] === "UTM zone 46N (EPSG:32646)" && cols[7][1] === "OK", cols);
cols = B.outCols({ error: "latitude is missing" }, f, B.gridCells("utm"));
expect("a failed row has empty cells and the reason", cols.slice(0, 7).every(c => c[1] === "") && cols[7][1] === "Not converted: latitude is missing", cols);
expect("an empty row says Empty", B.outCols({ empty: true }, { dd: true, ddDigits: 6 }, null).find(c => c[0] === "Convert_Status")[1] === "Empty");
cols = B.outCols({ lat: 26.9, lon: 95, check: "same position as row 4" }, { dd: true, ddDigits: 6 }, null);
expect("a row worth checking says so in both status columns", cols.find(c => c[0] === "Convert_Status")[1] === "OK - check" && cols.find(c => c[0] === "Convert_Check")[1] === "same position as row 4", cols);
expect("colour of a row", B.kindOf({ lat: 1, lon: 2 }) === "ok" && B.kindOf({ lat: 1, lon: 2, check: "x" }) === "check" && B.kindOf({ error: "x" }) === "bad" && B.kindOf({ empty: true }) === null);

cols = B.outCols({ lat: 26.69085, lon: 95.022933, repaired: "fixed", check: "repaired: ' read as decimal point" }, { dd: true, ddDigits: 6 }, null);
expect("a repaired row has its values and says so", cols[0][1] === 26.69085 && cols.find(c => c[0] === "Convert_Status")[1] === "Repaired - check" && /' read as decimal point/.test(cols.find(c => c[0] === "Convert_Check")[1]), cols);
cols = B.outCols({ lat: 26.2, lon: 95.1, repaired: "check", check: "best guess, several readings fit" }, { dd: true, ddDigits: 6 }, null);
expect("a repaired best guess says so", cols.find(c => c[0] === "Convert_Status")[1] === "Best guess - check");
expect("colour of a repaired row", B.kindOf({ lat: 1, lon: 2, repaired: "fixed" }) === "fixed" && B.kindOf({ lat: 1, lon: 2, repaired: "check" }) === "check");

/* ---------- how finely a value was typed ---------- */

const m = t => Math.round(B.precisionOf(t));
expect("precision: decimal degrees", m("25.811") === 111 && m("26.923417") === 0 && m("26") === 111320 && m("26.3193 N") === 11, [ m("25.811"), m("26.3193 N") ]);
expect("precision: degrees + decimal minutes", m("26°41.451'") === 2 && m("26°41'") === 1855);
expect("precision: degrees, minutes, seconds", m("26°55'24.3\"") === 3 && m("26 55 24") === 31);
r = B.readRow([ "A", "25.811", "94.84" ], two);
expect("a row reports its coarser value", Math.round(r.precision) === 1113, r);
r = B.readRow([ "26.923417, 95.034528" ], one);
expect("a one-column pair reports its precision too", Math.round(r.precision) === 0 && r.lat === 26.923417, r);

/* ---------- converted rows worth checking ---------- */

// A district-sized cloud of points around 26.9, 95.0, plus three that are not right.
const pts = [];
for (let i = 0; i < 40; i++) pts.push([ 26.9 + Math.sin(i * 1.7) * 0.15, 95.0 + Math.cos(i * 2.3) * 0.15, 1 ]);
pts.push([ 29.84, 94.84, 1 ]);                    // 40: mistyped degree, about 330 km away
pts.push([ pts[3][0], pts[3][1], 1 ]);            // 41: same position as row index 3
pts.push([ 26.95, 95.05, 1113 ]);                 // 42: typed to 2 decimals
pts.push([ 0, 0, NaN ]);                          // 43: not converted
const status = Uint8Array.from(pts.map((p, i) => i === 43 ? B.FAILED : B.OK));
const checks = B.qualityChecks(pts.map(p => p[0]), pts.map(p => p[1]), status, pts.map(p => p[2]), pts.map((p, i) => i + 2));
expect("a point hundreds of km off is flagged", /far from the other points: about 3\d\d km/.test(checks.get(40) || ""), checks.get(40));
expect("a repeated position names the first row", checks.get(41) === "same position as row 5", checks.get(41));
expect("a coarse value is flagged with its size", checks.get(42) === "low precision: typed to about 1 km", checks.get(42));
expect("nothing else is flagged, and failed rows are ignored", checks.size === 3 && !checks.has(43), [ ...checks.keys() ]);
expect("a sheet typed finely has no sheet-wide note", checks.coarse === undefined);
// A sheet where every value has 3 decimals: one note for the sheet, not a mark on every row.
const rough = B.qualityChecks(pts.slice(0, 40).map(p => p[0]), pts.slice(0, 40).map(p => p[1]), new Uint8Array(40).fill(B.OK),
  pts.slice(0, 40).map((p, i) => i === 7 ? 111320 : i === 9 ? 1113.2 : 111.32), pts.slice(0, 40).map((p, i) => i + 2));
expect("a coarse sheet gets one note", Math.round(rough.coarse) === 111 && B.nice(rough.coarse) === "100 m", rough.coarse);
expect("...and only a row much coarser than the rest is marked", rough.size === 1 && rough.get(7) === "low precision: typed to about 100 km", [ ...rough ]);
expect("...not one digit short, which is usually a zero Excel dropped (25.810 -> 25.81)", !rough.has(9));
const few = B.qualityChecks([ 26.9, 29.8 ], [ 95, 94.8 ], Uint8Array.from([ B.OK, B.OK ]), null, [ 2, 3 ]);
expect("too few points to judge distance: no far flags", few.size === 0);

console.log(`\nbatch-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
