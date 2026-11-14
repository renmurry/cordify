// Run with:  node tests/pinpoint.test.js   (or: npm test)
// Pointing to the exact wrong character in a typed coordinate. The values are made up,
// in the shapes that real field sheets are typed in.
const P = require("../assets/js/pinpoint.js");
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
const errs = (t, role) => P.explain(t, role).problems.filter(p => p.kind === "error");
const first = (t, role) => errs(t, role)[0] || {};

// Correct values have nothing to point at
for (const t of [ "26.92, 95.03", "26°41.451’ N, 95°01.376’ E", "26°41’27.1” N 95°1’37.6” E", "N 26.5 E 94.25", "-33.86, 151.21", "26.902944\n95.052286\n157.78 m" ]) {
  expect(`no problem in ${JSON.stringify(t)}`, errs(t).length === 0, P.explain(t).problems);
}
expect("one correct value with its role", errs("94.83", "lon").length === 0);

// ' typed where the decimal point goes (seconds can't be 451): both readings, the ' marked
let p = first("27°12’451, 93°05’376, 893m");
expect("’ before three digits is pointed at", p.at === 5 && p.len === 1, p);
expect("...with both readings", p.readings.join(" | ") === "27°12.451’ | 27°12’45.1”", p.readings);
p = first("27°12’034, 93°05’003");
expect("three digits after ’ even under 60", p.at === 5 && p.readings.join(" | ") === "27°12.034’ | 27°12’03.4”", p);
expect("...and the second value too", errs("27°12’451, 93°05’376, 893m").length === 2);

// ° typed where the decimal point goes (minutes can't be 189922)
p = first("25°193322’.N\n93°838020’.E");
expect("° before six digits is pointed at", p.at === 2, p);
expect("...decimal degrees first", p.readings[0] === "25.193322 N", p.readings);
p = errs("25°193322’.N\n93°838020’.E")[1];
expect("...only one reading when minutes would be 83", p.readings.length === 1 && p.readings[0] === "93.838020 E", p);

// The mark typed before the decimal point
p = first("25°26’.257”N\n93°53’.691”E");
expect("’ before the point is pointed at", p.at === 5 && /before the decimal point/.test(p.why), p);
expect("...with the value written properly", p.readings[0] === "25°26.257’ N", p.readings);

// Degrees and minutes typed together with no °
p = first("N2565.997’\nE09374.976’");
expect("point in the wrong place: minutes would be 65, so one reading", p.at === 3 && p.readings.length === 1 && p.readings[0] === "N 25.65997", p);
p = first("N2546.434’\nE09374.976’");
expect("point in the wrong place: two readings fit when minutes are under 60", p.readings.length === 2, p.readings);
p = first("25123456, 93.5");
expect("decimal point missing (Excel dropped it)", p.at === 2 && p.readings[0] === "25.123456", p);

// ° typed for 0, letters typed for digits
p = first("25°51’51.°9444” N, 94°2’33.25452” E");
expect("° inside a number is pointed at", p.at === 9 && p.readings[0] === "25°51’51.09444” N", p);
p = first("25.5O12, 94.2");
expect("letter O for 0", p.at === 4 && /letter O/.test(p.why) && p.readings[0] === "25.5012", p);
p = first("25.5l2, 94.2");
expect("letter l for 1", p.at === 4 && p.readings[0] === "25.512", p);
expect("N, S, E, W are never read as digits", errs("25.5 S, 94.2 E").length === 0);

// Points and spaces
p = first("25.9864.83,94.142802,139m");
expect("a second decimal point", p.at === 7 && /second decimal point/.test(p.why), p);
p = first("N 25°41.461’, E 093.55.389’, 1136m");
expect("a point where ° belongs", p.at === 19 && p.readings[0] === "E 093°55.389’", p);
p = first("26.000901, 94. 165864,166m");
expect("a space after the decimal point", p.at === 14 && p.readings[0] === "94.165864", p);

// Marks in the wrong order
p = first("25°10°29.0838’.N\n93°48°52.71732’E");
expect("a second ° where ’ belongs", p.at === 5 && p.readings[0] === "25°10’29.0838” N", p);
p = first("25°44.58292’.N\n93°4757.08472’.E");
expect("minutes and seconds typed together", p.at === 20 && p.readings[0] === "93°47’57.08472” E", p);
p = first("25ᵒ11N\n94ᵒ75E");
expect("minutes over 59", /minutes can't be 75/.test(p.why), p);

// Look-alike and invisible characters are noted, not errors
let r = P.explain("25ᵒ11.170 N\n94ᵒ01.206E");
expect("ᵒ is read as ° and noted", r.errors === 0 && r.problems.some(x => x.kind === "note" && x.at === 2), r.problems);
r = P.explain("25.5​, 94.2");
expect("a zero-width space is noted", r.errors === 0 && r.problems.some(x => x.kind === "note" && /zero-width/.test(x.why)), r.problems);
p = first("25.08861\t25.088612\n94.729061\n94.72");
expect("a tab joining extra values is pointed at", p.at === 8 && /4 values/.test(p.why), p);
p = first("25.08861");
expect("one value only", /only one value/.test(p.why), p);
p = first("25.5x", "lat");
expect("a stray letter", p.at === 4 && /'x'/.test(p.why), p);
p = first("95.5", "lat");
expect("latitude over 90", /can't be over 90/.test(p.why), p);

// Marked-up text for the screen
const esc = s => s.replace(/</g, "&lt;");
let html = P.markup("27°12’451, 93°05’376", esc);
expect("markup marks the wrong characters", (html.match(/<mark class="pin pin-error"/g) || []).length === 2 && html.startsWith("27°12<mark"), html);
html = P.markup("25.5O12  |  94.2", esc);
expect("markup reads 'lat  |  lon' as two cells", /<mark class="pin pin-error"[^>]*>O<\/mark>/.test(html), html);
html = P.markup("25.08861\t25.088612\n94.7\n94.72", esc);
expect("a marked tab is made visible", html.includes(">⇥</mark>"), html);
expect("nothing to mark: plain text", P.markup("26.92, 95.03", esc) === "26.92, 95.03");

// Batch messages now point to the character
let res = B.readRow([ "27°12’451, 93°05’376" ], { mode: "one", one: 0 });
expect("batch error names the character", /^character 6: ’/.test(res.error) && B.statusOf(res) === B.MISTYPED, res);
res = B.readRow([ "25.5O12", "94.2" ], { mode: "two", lat: 0, lon: 1 });
expect("two-column batch error names the cell", /^latitude cell, character 5: the letter O/.test(res.error), res);
res = B.readRow([ "94.2", "25.5" ], { mode: "two", lat: 0, lon: 1 });
expect("swapped columns keep their message", /swapped/.test(res.error), res);

// Grid metres are named as such, with no readings in degrees
let g = P.explain("684557, 2856045");
expect("grid metres in one cell", g.errors === 1 && /grid coordinates in metres/.test(g.summary) && g.problems[0].readings.length === 0, g.summary);
g = P.explain("2856045", "lat");
expect("grid metres in a column", g.errors === 1 && /grid coordinates/.test(g.summary), g.summary);
expect("ordinary degrees are not grid metres", P.explain("26.5, 94.2").errors === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
