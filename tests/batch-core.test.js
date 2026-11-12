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
expect("output columns in order", same(cols.map(c => c[0]), [ "Lat_DD", "Lon_DD", "Lat_DMS", "Lon_DMS", "Easting", "Northing", "Grid", "Convert_Status" ]), cols);
expect("output values", cols[0][1] === 26.923417123 && cols[2][1] === "26° 55' 24.30\" N" && cols[4][1] === 702017.909 && cols[6][1] === "UTM zone 46N (EPSG:32646)" && cols[7][1] === "OK", cols);
cols = B.outCols({ error: "latitude is missing" }, f, B.gridCells("utm"));
expect("a failed row has empty cells and the reason", cols.slice(0, 7).every(c => c[1] === "") && cols[7][1] === "Not converted: latitude is missing", cols);
expect("an empty row says Empty", B.outCols({ empty: true }, { dd: true, ddDigits: 6 }, null).pop()[1] === "Empty");

console.log(`\nbatch-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
