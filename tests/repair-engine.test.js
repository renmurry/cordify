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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
