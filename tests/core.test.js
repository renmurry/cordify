// Run with:  node tests/core.test.js   (or: npm test)
// Reading, writing and projecting coordinates. The projection checks that need
// proj4 are skipped, with a message, when it has not been installed (npm install).
const C = require("../assets/js/core.js");

let pass = 0, fail = 0, skipped = 0;
function expect(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const DEG = 1e-12;   // far below a micrometre on the ground

/* ---------- reading one value ---------- */

expect("DMS with marks and letter", near(C.parseDmsString("12°34'56.7\" N"), 12 + 34 / 60 + 56.7 / 3600, DEG));
expect("DMS with spaces only", near(C.parseDmsString("12 34 56.7"), 12.58241666666667, 1e-12));
expect("typographic marks ′ ″", near(C.parseDmsString("12°34′56.7″S"), -(12 + 34 / 60 + 56.7 / 3600), DEG));
expect("leading letter", C.parseDmsString("W 77 35 12") === -(77 * 3600 + 35 * 60 + 12) / 3600);
expect("26°30' is exactly 26.5", C.parseDmsString("26°30'") === 26.5);
expect("minus sign with zero degrees keeps its sign", C.parseDmsString("-0° 30'") === -0.5);
expect("true minus sign (−) is read", C.parseDmsString("−0.5") === -0.5 && C.parseDecimal("−12.25") === -12.25);
expect("comma as decimal point", C.parseDmsString("12,5") === 12.5 && C.parseDecimal("12,5") === 12.5);
let exact = true;
for (const s of [ "26.933417", "95.044528", "0.1", "179.999999999", "-33.868800001" ]) {
  if (C.parseDmsString(s) !== parseFloat(s) || C.parseCoord(s, "lon") !== parseFloat(s)) exact = false;
}
expect("a plain decimal is read exactly as written", exact);
expect("zero is never negative zero", Object.is(C.parseDmsString("0° 0' 0\" S"), 0));
expect("60 minutes rejected", C.parseDmsString("12°60'") === null);
expect("60 seconds rejected", C.parseDmsString("12°30'60\"") === null);
expect("three-digit seconds rejected", C.parseDmsString("26°43'034") === null);
expect("conflicting letters rejected", C.parseDmsString("N 12 30 S") === null);
expect("decimal degrees followed by minutes rejected", C.parseDmsString("12.5° 30'") === null);
expect("decimal minutes followed by seconds rejected", C.parseDmsString("12° 30.5' 10\"") === null);
expect("degrees + decimal minutes accepted", C.parseDmsString("12° 30.5'") === (12 * 3600 + 30.5 * 60) / 3600);
expect("1234 is not split into 12°34' (and is not a coordinate)", C.parseDmsString("1234") === null);
expect("empty and junk", C.parseDmsString("") === null && C.parseDmsString("abc") === null && C.parseDecimal("1e5") === null);

/* ---------- ranges ---------- */

expect("poles accepted", C.parseCoord("90", "lat") === 90 && C.parseCoord("90° S", "lat") === -90);
expect("past the pole rejected", C.parseCoord("90°0'0.1\" N", "lat") === null && C.parseCoord("90.0000001", "lat") === null);
expect("±180 accepted", C.parseCoord("180", "lon") === 180 && C.parseCoord("180° W", "lon") === -180);
expect("past 180 rejected", C.parseCoord("180°0'0.1\" E", "lon") === null);
expect("E on a latitude rejected", C.parseCoord("12 E", "lat") === null);
expect("N on a longitude rejected", C.parseCoord("12 N", "lon") === null);

/* ---------- pairs ---------- */

const pair = s => C.splitPair(s);
expect("decimal pair", JSON.stringify(pair("12.58, 77.59")) === '["12.58","77.59"]');
expect("DMS pair with letters", JSON.stringify(pair("12°34'56\"N 77°35'12\"E")) === '["12°34\'56\\"N","77°35\'12\\"E"]');
expect("letters decide the order", JSON.stringify(pair("E 77 35 12 N 12 34 56")) === '["N 12 34 56","E 77 35 12"]');
expect("six bare numbers", JSON.stringify(pair("12 34 56 77 35 12")) === '["12 34 56","77 35 12"]');
expect("semicolon pair with decimal commas", JSON.stringify(pair("12,5; 77,25")) === '["12,5","77,25"]');
expect("three values is not a pair", pair("1, 2, 3") === null);

/* ---------- writing ---------- */

expect("DMS basic", C.formatDMS(26.189922, "lat", 2) === "26° 11' 23.72\" N", C.formatDMS(26.189922, "lat", 2));
expect("59.9996\" carries into minutes", C.formatDMS(12 + 34 / 60 + 59.9996 / 3600, "lat", 3) === "12° 35' 0.000\" N");
expect("carry goes all the way to degrees", C.formatDMS(12.99999999, "lon", 2) === "13° 0' 0.00\" E");
expect("carry at the pole and at 180", C.formatDMS(89.9999999999, "lat", 3) === "90° 0' 0.000\" N" && C.formatDMS(-179.9999999999, "lon", 3) === "180° 0' 0.000\" W");
expect("a tiny negative shows as zero north", C.formatDMS(-1e-12, "lat", 3) === "0° 0' 0.000\" N");
expect("trim drops trailing zeros", C.formatDMS(12.5, "lat", 3, true) === "12° 30' 0\" N");
expect("DDM basic", C.formatDDM(26.189922, "lat", 4) === "26° 11.3953' N", C.formatDDM(26.189922, "lat", 4));
expect("DDM carry", C.formatDDM(12.99999999, "lat", 4) === "13° 0.0000' N");
expect("DD as a number", C.formatDD(26.1899220001, 6) === 26.189922 && Object.is(C.formatDD(-1e-9, 6), 0));
expect("DD text has no -0.000000", C.formatDDText(-1e-9, 6) === "0.000000" && C.formatDDText(-0.5, 2) === "-0.50");
expect("not-a-number gives empty text", C.formatDMS(NaN, "lat") === "" && C.formatDD(null) === "" && C.formatDDText(Infinity) === "");

// Text -> number -> text comes back the same at survey precision (0.00001" is about 0.3 mm).
let roundTrip = true;
for (let i = 0; i < 2000; i++) {
  const lat = Math.sin(i * 12.9898) * 90, lon = Math.sin(i * 78.233) * 180;
  const a = C.formatDMS(lat, "lat", 5), b = C.formatDMS(lon, "lon", 5);
  if (C.formatDMS(C.parseCoord(a, "lat"), "lat", 5) !== a || C.formatDMS(C.parseCoord(b, "lon"), "lon", 5) !== b) roundTrip = false;
  if (C.formatDDText(C.parseDecimal(C.formatDDText(lat, 9)), 9) !== C.formatDDText(lat, 9)) roundTrip = false;
}
expect("2000 random points survive DMS and 9-decimal round trips", roundTrip);

/* ---------- UTM (built in, no library) ---------- */

expect("zone from longitude", C.utmZone(26.9, 95.03) === 46 && C.utmZone(40.7, -74) === 18 && C.utmZone(0, -180) === 1 && C.utmZone(0, 179.9) === 60 && C.utmZone(0, 180) === 1);
expect("Norway and Svalbard exceptions", C.utmZone(60, 5) === 32 && C.utmZone(78, 10) === 33 && C.utmZone(78, 25) === 35 && C.utmZone(73, 5) === 31);

let p = C.project(0, 93, "utm");
expect("equator on a central meridian is 500000, 0", near(p.e, 500000, 1e-6) && near(p.n, 0, 1e-6) && p.label === "UTM zone 46N" && p.epsg === 32646, p);
// Meridian arc from the equator to 45° N on WGS 84 is 4 984 944.378 m; UTM scales it by 0.9996.
p = C.project(45, 3, "utm");
expect("northing on the central meridian at 45° N", near(p.e, 500000, 1e-6) && near(p.n, 0.9996 * 4984944.378, 0.001), p);
p = C.project(-33.8688, 151.2093, "utm");
expect("southern hemisphere adds 10 000 000 m", p.label === "UTM zone 56S" && p.epsg === 32756 && p.n > 6e6 && p.n < 7e6, p);
expect("outside 80° S to 84° N is refused", !!C.project(85, 0, "utm").error && !!C.project(-81, 0, "utm").error);
expect("a fixed zone by EPSG code", C.project(26.9, 95.03, "epsg:32646").label === "UTM zone 46N" && near(C.project(26.9, 95.03, "epsg:32646").e, C.project(26.9, 95.03, "utm").e, 1e-9));
expect("off gives nothing", C.project(1, 1, "off") === null && C.describeGrid("off").off === true);
expect("helpful errors", /4 to 6 digits/.test(C.describeGrid("epsg:abc").error) && /already gives/.test(C.describeGrid("epsg:4326").error) && /not built in/.test(C.describeGrid("epsg:99999").error) && /Paste/.test(C.describeGrid("def:").error));

/* ---------- checks against proj4 (the library the app loads) ---------- */

let proj4 = null;
try {
  proj4 = require("proj4");
  proj4 = proj4.default || proj4;
} catch (e) {}

if (!proj4) {
  skipped = 5;
  console.log("SKIPPED: 5 projection checks need proj4. Run `npm install` first.");
} else {
  // Built-in UTM against proj4's, over the whole world, both hemispheres.
  let worst = 0;
  for (let lat = -79.5; lat <= 83.5; lat += 3.7) {
    for (let lon = -179.9; lon <= 179.9; lon += 2.3) {
      const mine = C.project(lat, lon, "utm");
      const zone = C.utmZone(lat, lon);
      const theirs = proj4("WGS84", `+proj=utm +zone=${zone}${lat < 0 ? " +south" : ""} +datum=WGS84 +units=m +no_defs`).forward([ lon, lat ]);
      worst = Math.max(worst, Math.abs(mine.e - theirs[0]), Math.abs(mine.n - theirs[1]));
    }
  }
  expect("built-in UTM agrees with proj4 to 1 mm everywhere", worst < 0.001, worst);

  p = C.project(0, 180, "epsg:3857");
  expect("Web Mercator edge is 20 037 508.343 m", near(p.e, 20037508.342789244, 1e-6) && near(p.n, 0, 1e-6), p);

  // 7-parameter shift: the grid origin of the British National Grid sits near 49° N, 2° W in OSGB36.
  p = C.project(52.6579776, 1.7160665, "epsg:27700");
  const back = proj4("WGS84", "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs").inverse([ p.e, p.n ]);
  expect("British National Grid lands in Norfolk and inverts to the same point", p.e > 651000 && p.e < 652000 && p.n > 313000 && p.n < 314000 && near(back[1], 52.6579776, 1e-7) && near(back[0], 1.7160665, 1e-7), p);

  p = C.project(48.8566, 2.3522, "def:+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs");
  const viaCode = C.project(48.8566, 2.3522, "epsg:2154");
  expect("a pasted definition gives the same as its EPSG code", p.label === "Custom grid" && near(p.e, viaCode.e, 1e-6) && near(p.n, viaCode.n, 1e-6) && p.e > 650000 && p.e < 655000, p);

  expect("a broken definition is reported, not thrown", /could not be read/.test(C.describeGrid("def:+proj=nonsense").error || ""), C.describeGrid("def:+proj=nonsense"));
}

console.log(`\ncore: ${pass} passed, ${fail} failed` + (skipped ? `, ${skipped} skipped` : ""));
process.exit(fail ? 1 : 0);
