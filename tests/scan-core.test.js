// Run with:  node tests/scan-core.test.js   (or: npm test)
// Finding coordinates in ordinary text, as read from scanned pages and PDFs.
const S = require("../assets/js/scan-core.js");

let pass = 0, fail = 0;
function expect(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
const find = t => S.findCoordinates(t);

let r = find("GCP-01  26.923417, 95.034528  fixed");
expect("decimal pair with its name", r.length === 1 && r[0].lat === 26.923417 && r[0].lon === 95.034528 && r[0].status === "ok" && r[0].name === "GCP-01", r);

r = find("The well is at 26°55'24.3\" N, 95°02'04.3\" E beside the road.");
expect("DMS pair in a sentence", r.length === 1 && near(r[0].lat, 26 + 55 / 60 + 24.3 / 3600) && near(r[0].lon, 95 + 2 / 60 + 4.3 / 3600) && r[0].status === "ok", r);
expect("raw text is exactly what was written", r[0].raw === "26°55'24.3\" N, 95°02'04.3\" E", r[0].raw);

r = find("Latitude: 26° 55' 24.3\" N\nLongitude: 95° 02' 04.3\" E");
expect("labelled values on two lines", r.length === 1 && near(r[0].lat, 26.92341666666667) && r[0].status === "ok", r);

r = find("E 95 02 04.3  N 26 55 24.3");
expect("bare numbers with letters, longitude first: letters decide", r.length === 1 && near(r[0].lat, 26.92341666666667) && near(r[0].lon, 95.03452777777778) && r[0].status === "ok", r);

r = find("26° 55.405' N 95° 2.0717' E");
expect("degrees + decimal minutes", r.length === 1 && near(r[0].lat, 26 + 55.405 / 60) && r[0].status === "ok", r);

r = find("Site 4: 33°52'07.7\"S 151°12'33.5\"E");
expect("southern hemisphere, typographic-free", r.length === 1 && r[0].lat < 0 && r[0].lon > 0 && r[0].name === "Site 4", r);

r = find("26o55'24.3\" N 95o02'04.3\" E");
expect("o read for the degree sign", r.length === 1 && near(r[0].lat, 26.92341666666667) && r[0].status === "ok", r);

r = find("P7 26.9234l7, 95.O34528");
expect("letters read as digits are fixed but flagged", r.length === 1 && r[0].lat === 26.923417 && r[0].lon === 95.034528 && r[0].status === "check" && /digits/.test(r[0].note), r);

r = find("95.034528, 26.923417");
expect("longitude first without letters is flagged", r.length === 1 && r[0].lat === 26.923417 && r[0].lon === 95.034528 && r[0].status === "check", r);

r = find("Cost 12.500 and 13.750 per unit; totals 1250.000, 99.999");
expect("ordinary numbers are mostly left alone", r.every(x => x.status !== "failed"), r);
expect("numbers out of range are not coordinates", find("values 412.553, 987.221").length === 0);

r = find("91°10'10\" N, 95°02'04\" E");
expect("an impossible DMS value is kept as failed, for a person to fix", r.length === 1 && r[0].status === "failed" && r[0].lat === null, r);

r = find("A 26.923417 95.034528\nB 26.933417 95.044528\nC 26.923417 95.034528");
expect("a table: one point per line, duplicates dropped", r.length === 2 && r[0].name === "A" && r[1].name === "B" && r[1].lat === 26.933417, r);

r = find("W-1 26.923417 95.034528\nW-2 26.933417 95.044528\nE.3 26.943417 95.054528\nS-4 26.953417 95.064528");
expect("a name starting with W, E or S on the next line never flips the sign", r.length === 4 && r.every(x => x.lat > 0 && x.lon > 0 && x.status === "ok") && r[1].name === "W-2", r);
r = find("26.923417 N\n95.034528 E");
expect("letters on their own lines still count", r.length === 1 && r[0].lat === 26.923417 && r[0].lon === 95.034528, r);
r = find("26.923417 S 95.034528 W next");
expect("letters on the same line set the sign", r.length === 1 && r[0].lat === -26.923417 && r[0].lon === -95.034528, r);

r = find("1. Station Alpha — 26,923417; 95,034528");
expect("decimal commas and a numbered list", r.length === 0 || (r.length === 1 && r[0].name.includes("Station Alpha")), r);

const text = "intro\nBM-2 at 26.923417, 95.034528 end";
r = find(text);
expect("index and end point at the coordinate", text.slice(r[0].index, r[0].end) === "26.923417, 95.034528" && r[0].name === "BM-2", r);

expect("nothing in plain prose", find("No coordinates here, just words and the year 2026.").length === 0);
expect("empty input", find("").length === 0 && find(null).length === 0);

let t = S.readTyped("26.923417, 95.034528");
expect("typed correction: decimal", t && t.lat === 26.923417 && t.lon === 95.034528);
t = S.readTyped("26 55 24.3 N 95 02 04.3 E");
expect("typed correction: DMS", t && near(t.lat, 26.92341666666667));
expect("typed nonsense is refused", S.readTyped("hello") === null && S.readTyped("999, 999") === null);

console.log(`\nscan-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
