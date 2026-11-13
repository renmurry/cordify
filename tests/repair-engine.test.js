// Run with:  node tests/repair-engine.test.js
// Uses a made-up square boundary in the southern hemisphere so nothing here is
// specific to one country.
const R = require("../assets/js/repair-engine.js");

let pass = 0, fail = 0;
function expect(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("PASS:", name);
  } else {
    fail++;
    console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}
const near = (a, b, tol = 1e-4) => Math.abs(a - b) < tol;

// Square from 23.0–24.0 S, 46.0–47.0 W (around São Paulo)
const square = R.buildFeature({ name: "Test area", rings: [ [ [ -47, -24 ], [ -46, -24 ], [ -46, -23 ], [ -47, -23 ], [ -47, -24 ] ] ] }, 0);
const run = rows => R.repairRows(rows.map((r, i) => ({ id: i, ...r })), { features: [ square ] });

let [ r ] = run([ { text: "-23.5505, -46.6333" } ]);
expect("clean decimal pair is unchanged", r.status === "ok" && near(r.lat, -23.5505) && near(r.lon, -46.6333), r);

[ r ] = run([ { text: "23°33'01.8\" S 46°38'0\" W" } ]);
expect("clean DMS with S/W letters", r.status === "ok" && near(r.lat, -23.55050, 1e-4), r);

[ r ] = run([ { text: "23°550500' S, 46°633300' W" } ]);
expect("° used as decimal point is repaired", (r.status === "fixed" || r.status === "choose") && near(r.lat, -23.5505) && near(r.lon, -46.6333), r);

[ r ] = run([ { text: "23.5505, 46.6333" } ]);
expect("missing minus sign on longitude is found", r.status !== "failed" && near(r.lon, -46.6333), r);

[ r ] = run([ { text: "-46.6333, -23.5505" } ]);
expect("swapped lat/lon is repaired", r.status !== "failed" && near(r.lat, -23.5505), r);

[ r ] = run([ { text: "23°33'0l.8\" S, 46°38'O\" W" } ]);
expect("letters typed for digits (l→1, O→0)", r.status !== "failed" && near(r.lat, -23.5505, 1e-4), r);

[ r ] = run([ { text: "23°33'2°.5\" S, 46°38'1\" W" } ]);
expect("° typed for 0 inside seconds", r.status !== "failed" && near(r.lat, -(23 + 33 / 60 + 20.5 / 3600), 1e-5), r);

[ r ] = run([ { text: "23.5505, -46.6333, 760m" } ]);
expect("elevation is ignored", r.status !== "failed" && near(r.lat, -23.5505), r);

[ r ] = run([ { text: "-29.5505, -46.6333" } ]);
expect("wrong degree digit is only offered for checking", r.status === "choose" && r.candidates.some(c => c.digitFix), r);

[ r ] = run([ { text: "-12.0, -80.0" } ]);
expect("valid value far outside is not invented into the area", r.status === "failed" || r.status === "outside", r);

[ r ] = run([ { text: "-" } ]);
expect("dash means empty", r.status === "empty", r);

// A tight village cluster outside the boundary must not be moved.
const rows = [ 0, 1, 2, 3 ].map(i => ({ text: `-22.${500 + i}, -46.${600 + i}`, village: "V", group: "G" }));
const res = R.repairRows(rows.map((x, i) => ({ id: i, ...x })), { features: [ square ] });
expect("clean village cluster outside is flagged, not moved", res.every(x => x.status === "outside"), res.map(x => x.status));

// Point-in-polygon with a hole (even-odd rule)
const donut = R.buildFeature({ rings: [ [ [ 0, 0 ], [ 10, 0 ], [ 10, 10 ], [ 0, 10 ], [ 0, 0 ] ], [ [ 4, 4 ], [ 6, 4 ], [ 6, 6 ], [ 4, 6 ], [ 4, 4 ] ] ] }, 0);
expect("point in ring is inside", R.contains(donut, 2, 2));
expect("point in hole is outside", !R.contains(donut, 5, 5));

// Output formats
expect("DMS format", R.formatDMS(26.189922, "lat", 2) === `26° 11' 23.72" N`, R.formatDMS(26.189922, "lat", 2));
expect("DMS rounding carries (no 60\")", R.formatDMS(12.9999999, "lat", 2) === `13° 0' 0.00" N`, R.formatDMS(12.9999999, "lat", 2));
expect("DMS west", R.formatDMS(-46.6333, "lon", 1) === `46° 37' 59.9" W`, R.formatDMS(-46.6333, "lon", 1));
expect("DDM format", R.formatDDM(26.189922, "lat", 4) === `26° 11.3953' N`, R.formatDDM(26.189922, "lat", 4));
expect("DDM south", R.formatDDM(-23.5505, "lat", 3) === `23° 33.030' S`, R.formatDDM(-23.5505, "lat", 3));
expect("DD rounding", R.formatDD(26.1899224, 6) === 26.189922);

// No boundary: area estimated from correct rows
const est = R.estimateAreas([
  ...[ 0, 1, 2, 3, 4 ].map(i => ({ text: `-23.5${i}, -46.6${i}`, group: "A" })),
  { text: "-23°55'05\" -46°63'33\"", group: "A" }
]);
expect("estimated area built from correct rows", est.features.length >= 1 && est.cleanPoints === 5, est.cleanPoints);
const estRes = R.repairRows([ { id: 0, text: "-23°520000', -46°620000'", group: "A" } ], { features: est.features, groupFeatures: est.groupFeatures });
expect("repair works with an estimated area", estRes[0].status !== "failed" && near(estRes[0].lat, -23.52), estRes[0]);

/* ---------- patterns seen in a real survey workbook (numbers made up) ---------- */

// 30 correctly typed points in a district around 26.85 N, 95.05 E, five villages.
const villages = [ "Alpha", "Bravo", "Charlie", "Delta", "Echo" ];
const clean = Array.from({ length: 30 }, (_, i) => ({
  text: `${(26.72 + (i % 10) * 0.025).toFixed(6)}, ${(94.95 + Math.floor(i / 3) * 0.02).toFixed(6)}`, group: "Mon", village: villages[i % 5]
}));
const runEstimated = extra => {
  const rows = clean.concat(extra).map((r, i) => ({ id: i, ...r }));
  const e = R.estimateAreas(rows);
  const out = R.repairRows(rows, { features: e.features, groupFeatures: e.groupFeatures, estimated: true });
  return { out: out.slice(clean.length), habits: out.habits, all: out };
};

// One typing habit: degrees + decimal minutes with ’ where the decimal point goes, plus elevation.
const habitRows = Array.from({ length: 10 }, (_, i) => ({ text: `26°${40 + i}’${String(100 + i * 37).padStart(3, "0")}, 95°0${i % 6}’${String(200 + i * 41)}, ${900 + i}m`, group: "Mon", village: "Foxtrot" }));
let h = runEstimated(habitRows);
expect("a typing habit is read the same way for every row", h.out.every(r => r.status === "fixed"), h.out.map(r => r.status));
expect("...as degrees + decimal minutes", near(h.out[0].lat, 26 + 40.1 / 60, 1e-9) && near(h.out[3].lon, 95 + 3.323 / 60, 1e-9), [ h.out[0].lat, h.out[3].lon ]);
expect("...and reported once as a habit", h.habits.length === 1 && h.habits[0].n === 10 && /' read as decimal point/.test(h.habits[0].signature), h.habits);
expect("...and each row says so", /read the same way as \d+ other rows/.test(h.out[5].notes.join(" ")), h.out[5].notes);
// The same habit for a village just beyond the estimated area (about 5 km), and one typed 90 km off.
h = runEstimated(habitRows.concat([
  { text: "26°33’000, 95°02’000, 800m", group: "Mon", village: "Kilo" },
  { text: "26°33’300, 95°02’400, 810m", group: "Mon", village: "Kilo" },
  { text: "26°45’013, 94°00’022, 689m", group: "Mon", village: "Lima" }
]));
expect("a habit row just outside an estimated area is read the habit's way", h.out[10].status === "fixed" && near(h.out[10].lat, 26.55, 1e-9) && near(h.out[11].lon, 95 + 2.4 / 60, 1e-9) && /km outside the estimated area/.test(h.out[10].notes.join(" ")), h.out[10]);
expect("...and joins the habit", h.habits[0].n === 12 && h.habits[0].rows.includes(clean.length + 10), h.habits[0].n);
expect("...but one 90 km off is not", h.out[12].status !== "fixed" && !(h.out[12].lat != null && near(h.out[12].lon, 94.0004, 1e-3)), h.out[12]);
expect("signatureOf ignores row-specific notes", R.signatureOf({ notes: [ "a", "3.2 km from this village's other points", "b" ] }) === "a|b");

// ° used as the decimal point in both values, about 10 km beyond the other points. The estimated
// area must reach that far, and the reading that treats both values the same way must win over
// a mixed one (27.05 as degrees + minutes) that also lands inside.
h = runEstimated([ { text: "27°030000’.N\n95°038020’.E", group: "Mon", village: "Golf" } ]);
expect("both values read the same way (° as decimal point)", near(h.out[0].lat, 27.03, 1e-9) && near(h.out[0].lon, 95.03802, 1e-9), h.out[0]);

// No boundary file: a correctly typed point a little outside the guessed area is kept as typed,
// one far away is not.
h = runEstimated([ { text: "26.50000, 95.05000", group: "Mon", village: "Hotel" }, { text: "29.84220, 95.04310", group: "Mon", village: "India" } ]);
expect("valid point just outside an estimated area is kept as typed", h.out[0].status === "ok" && h.out[0].lat === 26.5 && /kept as typed/.test(h.out[0].notes[0]), h.out[0]);
expect("valid point far outside still gets a suggestion to check", h.out[1].status !== "ok" && h.out[1].status !== "fixed", h.out[1]);
expect("clean rows inside are untouched", h.all.slice(0, clean.length).every(r => r.status === "ok" && r.confidence === 100));

// With a real boundary the old rule stands: a valid point outside is never accepted silently.
const tight = R.buildFeature({ name: "Box", rings: [ [ [ 94.9, 26.7 ], [ 95.2, 26.7 ], [ 95.2, 27.0 ], [ 94.9, 27.0 ], [ 94.9, 26.7 ] ] ] }, 0);
[ r ] = R.repairRows([ { id: 0, text: "26.50000, 95.05000" } ], { features: [ tight ] });
expect("with a boundary file, a valid point outside is not marked ok", r.status !== "ok", r);
expect("...but what was typed is recorded, so a person can keep it", r.typed && r.typed.lat === 26.5 && r.typed.lon === 95.05, r.typed);
[ r ] = R.repairRows([ { id: 0, text: "26.80000, 95.05000" } ], { features: [ tight ] });
expect("a point inside has nothing to keep", r.status === "ok" && r.typed === undefined, r);
[ r ] = R.repairRows([ { id: 0, text: "26°48’000, 95°03’000" } ], { features: [ tight ] });
expect("a mistyped value has nothing to keep as typed", r.typed === undefined && r.status !== "ok", r);

// Excel stores numbers with all of a computer's digits; a correctly typed one must still read.
const wide = R.buildFeature({ rings: [ [ [ 94, 26 ], [ 96, 26 ], [ 96, 28 ], [ 94, 28 ], [ 94, 26 ] ] ] }, 0);
[ r ] = R.repairRows([ { id: 0, text: "26.183333333333334, 95.01666666666667" } ], { features: [ wide ] });
expect("a full-precision number reads as typed", r.status === "ok" && near(r.lat, 26.183333333333334, 1e-11) && near(r.lon, 95.01666666666667, 1e-11), r);
[ r ] = R.repairRows([ { id: 0, latText: String(26.183333333333334), lonText: String(95.01666666666667) } ], { features: [ wide ] });
expect("...also from two separate cells", r.status === "ok", r);

/* ---------- village locations file ---------- */

expect("village names match however they are typed", R.placeKey("Tamlu Village") === "tamlu" && R.placeKey("TAMLU vill.") === "tamlu" && R.placeKey(" tamlu ") === "tamlu" && R.placeKey("T/Chingha") === "tchingha");
const places = R.buildPlaces([
  { name: "Kilo Village", lat: 26.55, lon: 95.03 },
  { name: "Mike", lat: 26.80, lon: 94.96 },
  { name: "Twin", lat: 26.70, lon: 95.00 }, { name: "Twin", lat: 26.95, lon: 95.15 },          // same name, far apart: ambiguous
  { name: "Twin", lat: 26.95, lon: 95.15, group: "North" }                                       // ...but known within its district
]);
expect("an ambiguous name is left out, a district-qualified one is kept", !places.has("twin") && places.has("north|twin") && places.ambiguous === 1);
expect("lookup prefers the row's district", R.placeFor(places, { village: "TWIN", group: "North" }).lat === 26.95 && R.placeFor(places, { village: "Twin", group: "South" }) === null);

// Two readings land inside; the one near the village's known location wins clearly.
const box2 = R.buildFeature({ name: "Box", rings: [ [ [ 94.5, 26.0 ], [ 95.5, 26.0 ], [ 95.5, 27.5 ], [ 94.5, 27.5 ], [ 94.5, 26.0 ] ] ] }, 0);
const amb = { id: 0, text: "26°48’000, 94°58’000", village: "Mike" };   // 26.8 / 26.48, 94.9667 / 94.58
let noRef = R.repairRows([ amb ], { features: [ box2 ] })[0];
let withRef = R.repairRows([ amb ], { features: [ box2 ], places })[0];
expect("without village locations, several readings fit", noRef.status === "choose", noRef);
expect("with them, the reading at the village wins", withRef.status === "fixed" && near(withRef.lat, 26.8, 1e-9) && near(withRef.lon, 94 + 58 / 60, 1e-9), withRef);

// A valid point outside the boundary but at its village's known location agrees with it.
const tight2 = R.buildFeature({ name: "Box", rings: [ [ [ 94.9, 26.7 ], [ 95.2, 26.7 ], [ 95.2, 27.0 ], [ 94.9, 27.0 ], [ 94.9, 26.7 ] ] ] }, 0);
[ r ] = R.repairRows([ { id: 0, text: "26.56, 95.04", village: "Kilo" } ], { features: [ tight2 ], places });
expect("a valid point at its village's location, outside the boundary, can be kept", r.status === "outside" && /village locations file/.test(r.notes[0]) && r.typed.lat === 26.56, r);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
