// Run with:  node tests/habits.test.js   (or: npm test)
// Typing habits: rows typed the same way mean the same format. Made-up values only.
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
const near = (a, b) => Math.abs(a - b) < 1e-6;
const rows = list => list.map(text => ({ text }));

// One column, three habits: plain decimal degrees, DMS with ′ ″ and N/E, DDM with ° ’ and elevation.
const sheet = rows([
  "27.102944\n93.152286\n157.78 m", "27.111111\n93.163333\n160.10 m", "27.120000\n93.170001\n171.00 m", "27.130100\n93.180200\n165.00 m",
  "27°11′51.4″ N, 93°2′22.7″ E", "27°12′01.4″ N, 93°3′22.7″ E", "27°13′11.4″ N, 93°4′22.7″ E", "27°14′21.4″ N, 93°5′22.7″ E", "27°15′31.4″ N, 93°6′22.7″ E",
  "N 27°11.461’, E 093°05.389’, 1136m", "N 27°12.461’, E 093°06.389’, 1100m", "N 27°13.461’, E 093°07.389’, 1036m",
  "27°11’451, 93°01’376, 893m", "27°12’471, 93°01’487, 881m"
]);
const habits = H.learn(sheet);
const ddm = habits.find(h => h.fmt === "DDM");
expect("three habits are learned", habits.length === 3, habits);
expect("the DDM habit: ° ’ marks, comma, N/E before, elevation", ddm && ddm.marks === "°’" && ddm.sep === "," && ddm.hemi === "before" && ddm.elev && ddm.n === 3 && ddm.dec === 3, ddm);

// 27°11'451 has two readings (27°11.451' or 27°11'45.1"); the DMS habit is the bigger one,
// but uses other marks (′ ″), so the DDM habit (° ’) decides.
let d = H.decide(sheet[12], habits);
expect("a habit with the same marks decides, not the most common format", d && d.rule === "habit" && d.texts[0] === "27°11.451’", d);
expect("...the value is right", d && near(d.lat, 27 + 11.451 / 60) && near(d.lon, 93 + 1.376 / 60), d);
expect("...and the reason says which rows", d && /typed like 3 other rows \(° ’, comma, N\/E before, elevation\)/.test(d.why), d && d.why);

// With no habit of the same marks, nothing is decided.
d = H.decide(sheet[12], H.learn(sheet.slice(0, 9)));
expect("no matching habit: not decided", d === null, d);
expect("no habits at all: not decided", H.decide(sheet[12], []) === null);

// Rows that read fine are never decided (nothing to choose).
expect("a row that reads fine is left alone", H.decide(sheet[0], habits) === null);
expect("a row with no possible reading is left alone", H.decide({ text: "27.9864.83, 93.142802" }, habits) === null);

// The other value in the same cell: its latitude is DDM, so the longitude is DDM too.
d = H.decide({ text: "27ᵒ11.170 N\n94ᵒ01206E" }, []);
expect("the other value in the cell decides", d && d.rule === "cell" && d.texts[1] === "94°01.206’ E", d);
d = H.decide({ text: "27°189922’.N\n93°838020’.E" }, []);
expect("...also when the other value has only one reading", d && d.rule === "cell" && d.texts[0] === "27.189922 N" && near(d.lat, 27.189922), d);

// Run-together values learned from rows with only one reading.
const ll = rows([ "N2765.997’\nE09374.564’", "N2766.949’\nE09373.678’", "N2769.882’\nE09376.132’" ]);
const hl = H.learn(ll);
expect("rows with one possible reading teach a habit", hl.length === 1 && hl[0].fmt === "DD" && hl[0].n === 3, hl);

// Two separate columns
const two = [ { lat: "27.10", lon: "93.10" }, { lat: "27°11’451", lon: "93°01’376" } ];
d = H.decide(two[1], []);
expect("two columns: nothing decided without evidence", d === null, d);
expect("two columns: features", H.featuresOf(two[1]).sep === "|");

// Summary lines
const lines = H.summary(habits);
expect("summary lists the habits", lines.length === 3 && /^5 rows: degrees, minutes, seconds, 1 decimal \(° ′ ″, comma, N\/E after\)$/.test(lines[0]), lines);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
