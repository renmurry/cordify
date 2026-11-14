// Run with:  node tests/report.test.js   (or: npm test)
// Scan first: the short report on a file before converting. Made-up values only.
const R = require("../assets/js/report.js");
const H = require("../assets/js/habits.js");

let pass = 0, fail = 0;
function expect(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}
const has = (r, re) => r.bullets.some(b => re.test(b.text));
const offers = (r, type) => r.bullets.some(b => (b.acts || []).some(a => a.type === type));

// A clean two-column sheet
const clean = [];
for (let i = 0; i < 40; i++) clean.push([ "v", `26.${100 + i}`, `94.${500 + i}` ]);
let r = R.scan([ { name: "Mon", head: [ "Village", "Lat", "Long" ], mode: "two", lat: 1, lon: 2, found: true, rows: clean } ], {});
expect("clean sheet: 3 to 5 bullets", r.bullets.length >= 3 && r.bullets.length <= 5, r.bullets.length);
expect("clean sheet: 40 rows found", has(r, /^40 rows with coordinates/));
expect("clean sheet: columns named", has(r, /“Lat”, “Long”/));
expect("clean sheet: all read", has(r, /40 of 40 rows \(100%\) read as typed/));
expect("clean sheet: no Repair tip", !has(r, /Repair/));
expect("clean sheet: where the points sit", has(r, /Points sit around 26\.1° N, 94\.5° E/));
expect("clean sheet: copy text has a bullet per line", r.text.split("\n").length === r.bullets.length && r.text.startsWith("• "));
expect("stats carry the sheet", r.stats[0].name === "Mon" && r.stats[0].ok === 40 && r.stats[0].failed === 0);

// The same sheet with problems added: two readings, a wrong letter, a missing value, an empty
// row, a duplicate position and a far point; a grid sheet; a sheet with no coordinates.
const messy = clean.concat([
  [ "v", "26°41'451", "94°50'123" ], [ "v", "26°42'451", "94°51'123" ],
  [ "v", "26.9O1", "95.1" ], [ "v", "26.9", "" ], [ "", "", "" ],
  [ "v", "26.105", "94.505" ], [ "v", "29.1", "94.5" ]
]);
const grid = [ [ "684557", "2856045" ], [ "684600", "2856100" ], [ "684700", "2856200" ] ];
r = R.scan([
  { name: "Mon", head: [ "Village", "Lat", "Long" ], mode: "two", lat: 1, lon: 2, found: true, rows: messy },
  { name: "Grid", head: [ "Easting", "Northing" ], mode: "two", lat: 1, lon: 0, found: true, grid: true, rows: grid },
  { name: "Notes", head: [ "Remark" ], found: false, rows: [ [ "hi" ] ] }
], {});
expect("messy: 5 bullets at most", r.bullets.length === 5, r.bullets.map(b => b.text));
expect("messy: sheets and empty row counted", has(r, /^3 sheets, 49 rows with coordinates \(1 empty row skipped\)/), r.text);
expect("messy: sheet without coordinates named", has(r, /No coordinate column was found in “Notes”/));
expect("messy: why rows failed", has(r, /2 have two possible readings, 1 has a wrong character, 1 is missing one value and 3 are in another coordinate system/), r.text);
expect("messy: grid sheet reported", has(r, /“Grid” holds grid coordinates in metres/));
expect("messy: grid rows not counted as wrong characters", r.stats[1].failed === 3 && !has(r, /4 have a wrong character/));
expect("messy: far and duplicate rows", has(r, /1 far from the rest/) && has(r, /1 at the same position as another row/), r.text);
expect("messy: coarse sheet said once", has(r, /“Mon” is typed to only about 100 m throughout/));
expect("messy: Repair offered", offers(r, "repair"));
expect("messy: kinds set", r.bullets.every(b => [ "ok", "warn", "bad", "tip" ].includes(b.kind)));

// A grid sheet in a known zone: an action to choose it, and its failures explained by it
r = R.scan([ { name: "S", head: [ "Easting", "Northing (UTM 46N)" ], mode: "two", lat: 1, lon: 0, found: true, grid: true, rows: grid } ], {});
expect("zone in the column name: suggested with an action", r.bullets.some(b => (b.acts || []).some(a => a.type === "system" && a.system.kind === "utm" && a.system.zone === 46 && !a.system.south)), r.bullets);
expect("zone in the column name: no Repair tip for rows the system explains", !has(r, /Repair/), r.text);
r = R.scan([ { name: "S", head: [ "Easting", "Northing" ], mode: "two", lat: 1, lon: 0, found: true, system: { kind: "utm", zone: 46, south: false }, rows: grid } ], {});
expect("system already chosen: read as it", has(r, /^The values are read as UTM zone 46N.$/) && has(r, /3 of 3 rows \(100%\) read as typed/), r.text);

// Typing habits: rows typed as degrees + decimal minutes with ° ' settle 26°41'451 the same way
const ddm = [];
for (let i = 0; i < 30; i++) ddm.push([ `26°41.${100 + i}' N, 94°50.${200 + i}' E` ]);
const two = [ [ "26°41'451 N, 94°50'123 E" ], [ "26°42'451 N, 94°51'123 E" ], [ "26°43'451 N, 94°52'123 E" ] ];
r = R.scan([ { name: "S", head: [ "GPS" ], mode: "one", one: 0, found: true, rows: ddm.concat(two) } ], {});
expect("habits: 3 rows with two readings", r.stats[0].two === 3, r.stats[0]);
expect("habits: all 3 would be settled", r.stats[0].settle === 3, r.stats[0].settle);
expect("habits: the tip says so", has(r, /Ticking “Use typing habits to choose between readings” would settle 3 of the 3 rows/), r.text);
expect("habits: offered as an action", offers(r, "habits"));
expect("habits: no Repair needed once settled", !offers(r, "repair"));
r = R.scan([ { name: "S", head: [ "GPS" ], mode: "one", one: 0, found: true, rows: ddm.concat(two) } ], { habitsOn: true });
expect("habits already ticked: said, not offered", has(r, /is ticked and settles 3 of the 3 rows/) && !offers(r, "habits"), r.text);
const way = H.describe({ marks: "'°", sep: ",", hemi: "after", elev: false });
expect("habits: the way rows are typed is described", r.text.includes(`(${way})`), [ way, r.text ]);

// Nothing to read
r = R.scan([ { name: "S", head: [ "x" ], found: false, rows: [] } ], {});
expect("no coordinates: still 3 bullets", r.bullets.length === 3 && r.bullets[0].kind === "bad" && has(r, /Nothing to convert/), r.text);

// A sample of a large file is said to be one
r = R.scan([ { name: "big.csv", head: [ "Lat", "Lon" ], mode: "two", lat: 0, lon: 1, found: true, rows: clean.map(x => x.slice(1)), total: 1000000 } ], {});
expect("sample: said", has(r, /read from a sample of the file/));

// Failure families
expect("familyOf two", R.familyOf({ error: "x — two readings fit: a or b", mistyped: true }) === "two");
expect("familyOf swap", R.familyOf({ error: "latitude and longitude look swapped", mistyped: true }) === "swap");
expect("familyOf missing", R.familyOf({ error: "longitude is missing" }) === "missing");
expect("familyOf wrong", R.familyOf({ error: "character 5: O", mistyped: true }) === "wrong");
expect("familyOf other", R.familyOf({ error: "latitude has no numbers" }) === "other");

console.log(`report: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
