/*
 * Cordify core
 * The one place where coordinates are read, written and projected. Used by the
 * converter, Batch convert, the sheet and Repair, so they always agree.
 *
 * Pure functions, no DOM: usable in the browser (window.CordifyCore) and Node.
 * Latitude/longitude are WGS 84 decimal degrees held as full-precision numbers;
 * rounding happens only when a value is written out.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(() => {
      try {
        const p = require("proj4");
        return p.default || p;
      } catch (e) {
        return null;
      }
    });
  } else {
    root.CordifyCore = factory(() => typeof root.proj4 !== "undefined" ? root.proj4 : null);
  }
})(typeof self !== "undefined" ? self : this, function (getProj4) {
  "use strict";

  /* ---------- reading ---------- */

  // A true minus sign (−, as copied from web pages and PDFs) is read as a hyphen-minus.
  const tidy = s => String(s ?? "").replace(/[−－]/g, "-");

  const inLatRange = v => v >= -90 && v <= 90;
  const inLonRange = v => v >= -180 && v <= 180;

  // One value as text -> decimal degrees, or null. Accepts 12°34'56.7", 12 34 56.7,
  // 12°34', 12° and 12.5, with an optional N/S/E/W letter or a minus sign.
  function parseDmsString(dmsStr) {
    if (!dmsStr) {
      return null;
    }
    dmsStr = tidy(dmsStr).trim().replace(/[′’‘`´]/g, "'").replace(/[″“”]/g, '"').replace(/°/g, "°").replace(/,/g, ".").toUpperCase().replace(/\s+/g, " ");
    const leadDir = (dmsStr.match(/^[NSWE]/) || [ null ])[0];
    const tailDir = (dmsStr.match(/[NSWE]$/) || [ null ])[0];
    if (leadDir && tailDir && leadDir !== tailDir) {
      return null;
    }
    const dir = tailDir || leadDir || null;
    if (leadDir) {
      dmsStr = dmsStr.slice(1).trim();
    }
    if (tailDir) {
      dmsStr = dmsStr.slice(0, -1).trim();
    }
    // (?![\d.]) stops a number from being split into two (e.g. "1234" is never read as 12° 34').
    const m = dmsStr.match(/^([+-]?\d+(?:\.\d+)?)(?![\d.])\s*°?(?:\s*(\d+(?:\.\d+)?)(?![\d.])\s*'?)?(?:\s*(\d+(?:\.\d+)?)(?![\d.])\s*"?)?$/);
    if (!m) {
      return null;
    }
    // Whole minutes/seconds have at most two digits, degrees at most three:
    // "26°43'034" is not 34 seconds, so it is rejected rather than misread.
    const whole = t => t ? t.replace(/^[+-]/, "").split(".")[0].length : 0;
    if (whole(m[1]) > 3 || whole(m[2]) > 2 || whole(m[3]) > 2) {
      return null;
    }
    // Only the last part may have decimals: "12.5° 30'" has no single meaning.
    const frac = t => t !== undefined && t.includes(".");
    if (frac(m[1]) && m[2] !== undefined || frac(m[2]) && m[3] !== undefined) {
      return null;
    }
    const negative = m[1].startsWith("-");
    const deg = Math.abs(parseFloat(m[1]));
    const min = m[2] !== undefined ? parseFloat(m[2]) : 0;
    const sec = m[3] !== undefined ? parseFloat(m[3]) : 0;
    if ([ deg, min, sec ].some(Number.isNaN)) {
      return null;
    }
    if (min < 0 || min >= 60 || sec < 0 || sec >= 60) {
      return null;
    }
    // A plain number is used exactly as written. With minutes or seconds: one division,
    // so 26°30' is exactly 26.5 and seconds are not rounded twice.
    let dd = m[2] === undefined && m[3] === undefined ? deg : (deg * 3600 + min * 60 + sec) / 3600;
    if (negative || dir === "S" || dir === "W") {
      dd = -dd;
    }
    return dd === 0 ? 0 : dd;
  }

  // One coordinate in any accepted form; rejects E/W on a latitude and N/S on a longitude.
  function parseCoord(str, kind) {
    const v = parseDmsString(str);
    if (v === null) {
      return null;
    }
    const letters = String(str).toUpperCase().match(/[NSEW]/g) || [];
    if (kind === "lat" && letters.some(c => c === "E" || c === "W")) {
      return null;
    }
    if (kind === "lon" && letters.some(c => c === "N" || c === "S")) {
      return null;
    }
    return (kind === "lat" ? inLatRange(v) : inLonRange(v)) ? v : null;
  }

  function parseDecimal(str) {
    const t = tidy(str).trim().replace(",", ".");
    return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t) ? parseFloat(t) : null;
  }

  // Split "lat, lon" text into its two parts. Accepts "12.58, 77.59",
  // "12°34'56"N 77°35'12"E", "N 12 34 56 E 77 35 12", "12 34 56 77 35 12".
  // With N/S/E/W letters the order can be either way round.
  function splitPair(str) {
    const s = tidy(str).trim().replace(/[′’‘`´]/g, "'").replace(/[″“”]/g, '"').replace(/\s+/g, " ");
    if (!s) {
      return null;
    }
    const up = s.toUpperCase();
    const letters = [ ...up.matchAll(/[NSEW]/g) ];
    const clean = t => t.replace(/^[,;\s]+|[,;\s]+$/g, "");
    if (letters.length === 2) {
      let i;
      if (/[NSEW]$/.test(up)) {
        i = letters[0].index + 1;
      } else if (/^[NSEW]/.test(up)) {
        i = letters[1].index;
      } else {
        return null;
      }
      const a = clean(s.slice(0, i)), b = clean(s.slice(i));
      const isLat = t => /[NS]/i.test(t);
      if (isLat(a) && !isLat(b)) {
        return [ a, b ];
      }
      if (isLat(b) && !isLat(a)) {
        return [ b, a ];
      }
      return null;
    }
    if (letters.length) {
      return null;
    }
    let parts = s.split(/\s*;\s*/);
    if (parts.length !== 2) {
      parts = s.split(/\s*,\s+/);
    }
    if (parts.length !== 2 && (s.match(/,/g) || []).length === 1) {
      parts = s.split(",");
    }
    if (parts.length !== 2) {
      const tok = s.split(" ");
      parts = tok.length % 2 === 0 && tok.length <= 6 ? [ tok.slice(0, tok.length / 2).join(" "), tok.slice(tok.length / 2).join(" ") ] : [];
    }
    parts = parts.map(clean);
    return parts.length === 2 && parts[0] && parts[1] ? parts : null;
  }

  /* ---------- writing ---------- */

  const hemiFor = (v, role) => role === "lat" ? (v < 0 ? "S" : "N") : (v < 0 ? "W" : "E");
  const trimZeros = t => t.includes(".") ? t.replace(/\.?0+$/, "") : t;

  // 26.189922 -> 26° 11' 23.72" N. Rounded once, in units of the last digit, so
  // 59.9996" never shows as 60" - it carries into the minutes (and degrees).
  // trim=true drops trailing zeros from the seconds.
  function formatDMS(v, role, secDigits = 2, trim = false) {
    if (v == null || !Number.isFinite(v)) return "";
    const f = Math.pow(10, secDigits);
    const units = Math.round(Math.abs(v) * 3600 * f);
    const deg = Math.floor(units / (3600 * f));
    const min = Math.floor((units - deg * 3600 * f) / (60 * f));
    const sec = ((units - deg * 3600 * f - min * 60 * f) / f).toFixed(secDigits);
    return `${deg}° ${min}' ${trim ? trimZeros(sec) : sec}" ${units ? hemiFor(v, role) : role === "lat" ? "N" : "E"}`;
  }

  // 26.189922 -> 26° 11.3953' N
  function formatDDM(v, role, minDigits = 4) {
    if (v == null || !Number.isFinite(v)) return "";
    const f = Math.pow(10, minDigits);
    const units = Math.round(Math.abs(v) * 60 * f);
    const deg = Math.floor(units / (60 * f));
    const min = (units - deg * 60 * f) / f;
    return `${deg}° ${min.toFixed(minDigits)}' ${units ? hemiFor(v, role) : role === "lat" ? "N" : "E"}`;
  }

  // As a number (for spreadsheet cells): 26.1899220 -> 26.189922
  function formatDD(v, digits = 6) {
    if (v == null || !Number.isFinite(v)) return "";
    const n = +v.toFixed(digits);
    return n === 0 ? 0 : n;
  }

  // As text with a fixed number of decimals; a value that rounds to zero has no minus sign.
  function formatDDText(v, digits = 6) {
    if (v == null || !Number.isFinite(v)) return "";
    const t = v.toFixed(digits);
    return /^-0(\.0*)?$/.test(t) ? t.slice(1) : t;
  }

  /* ---------- grid coordinates (Easting / Northing) ---------- */

  // Standard 6° zones, with the Norway (32V) and Svalbard (31X-37X) exceptions.
  function utmZone(lat, lon) {
    let z = Math.floor(((lon + 180) % 360 + 360) % 360 / 6) + 1;
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) z = 32;
    if (lat >= 72 && lat <= 84) {
      if (lon >= 0 && lon < 9) z = 31;
      else if (lon >= 9 && lon < 21) z = 33;
      else if (lon >= 21 && lon < 33) z = 35;
      else if (lon >= 33 && lon < 42) z = 37;
    }
    return z;
  }

  // WGS 84 -> UTM by the Krüger series (to n³: better than 0.1 mm inside a zone).
  function utmForward(lat, lon, zone, south) {
    const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
    const n = f / (2 - f), A = a / (1 + n) * (1 + n * n / 4 + Math.pow(n, 4) / 64);
    const al = [ n / 2 - 2 * n * n / 3 + 5 * n * n * n / 16, 13 * n * n / 48 - 3 * n * n * n / 5, 61 * n * n * n / 240 ];
    const rad = Math.PI / 180;
    const ph = lat * rad, dl = ((lon - (zone * 6 - 183) + 540) % 360 - 180) * rad;
    const c = 2 * Math.sqrt(n) / (1 + n);
    const t = Math.sinh(Math.atanh(Math.sin(ph)) - c * Math.atanh(c * Math.sin(ph)));
    const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
    let e = eta, nn = xi;
    al.forEach((v, i) => {
      const j = 2 * (i + 1);
      e += v * Math.cos(j * xi) * Math.sinh(j * eta);
      nn += v * Math.sin(j * xi) * Math.cosh(j * eta);
    });
    return { e: 500000 + k0 * A * e, n: k0 * A * nn + (south ? 1e7 : 0) };
  }

  // Grid systems known by EPSG code. Anything else can be given as a definition.
  // `note` says how exact the result is when the datum is not WGS 84.
  const SAME = "Its datum is treated as equal to WGS 84. The real difference (up to about 2 m, growing slowly) is not applied.";
  function epsgSystem(code) {
    const z = code % 100;
    if (code >= 32601 && code <= 32660) return { label: `UTM zone ${z}N`, utm: { zone: z, south: false } };
    if (code >= 32701 && code <= 32760) return { label: `UTM zone ${z}S`, utm: { zone: z, south: true } };
    if (code === 3857) return { label: "Web Mercator", def: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs", note: "Web Mercator is for web maps. Distances and areas are stretched away from the equator, so do not survey with it." };
    if (code === 27700) return { label: "British National Grid", def: "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs", note: "Uses the standard 7-parameter shift from WGS 84 to OSGB36: good to about 5 m, not survey grade." };
    if (code >= 25828 && code <= 25838) return { label: `ETRS89 / UTM zone ${z}N`, def: `+proj=utm +zone=${z} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`, note: SAME };
    if (code >= 26901 && code <= 26923) return { label: `NAD83 / UTM zone ${z}N`, def: `+proj=utm +zone=${z} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`, note: SAME };
    if (code >= 28348 && code <= 28358) return { label: `GDA94 / MGA zone ${z}`, def: `+proj=utm +zone=${z} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`, note: SAME };
    if (code === 2154) return { label: "RGF93 / Lambert-93", def: "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs", note: SAME };
    return null;
  }

  const cache = new Map(), CACHE_MAX = 40;   // a custom definition arrives one keystroke at a time
  // spec: "off" | "utm" | "epsg:32646" | "def:+proj=… or WKT text"
  function resolve(spec) {
    spec = String(spec || "off").trim();
    if (cache.has(spec)) return cache.get(spec);
    let sys;
    if (spec === "off") {
      sys = { off: true };
    } else if (spec === "utm") {
      sys = { auto: true, label: "UTM (zone chosen for each point)" };
    } else if (/^epsg:/i.test(spec)) {
      const raw = spec.slice(5).trim();
      const code = /^\d{4,6}$/.test(raw) ? +raw : NaN;
      const known = Number.isNaN(code) ? null : epsgSystem(code);
      if (!raw) sys = { error: "Type an EPSG code, for example 32646." };
      else if (Number.isNaN(code)) sys = { error: "An EPSG code is a number of 4 to 6 digits, for example 32646." };
      else if (code === 4326) sys = { error: "EPSG:4326 is plain latitude/longitude, which Cordify already gives. Pick a grid system such as UTM." };
      else if (!known) sys = { error: `EPSG:${code} is not built in. Choose “Custom definition” and paste its proj4 or WKT text (QGIS and epsg.io both show it).` };
      else sys = { ...known, epsg: code };
    } else if (/^def:/i.test(spec)) {
      const def = spec.slice(4).trim();
      sys = def ? { label: "Custom grid", def } : { error: "Paste a proj4 or WKT definition." };
    } else {
      sys = { error: "Unknown grid system." };
    }
    if (sys.def) {
      const P = getProj4();
      if (!P) {
        sys = { error: "The projection library did not load. Check your internet connection and reload the page." };
      } else {
        try {
          const conv = P("WGS84", sys.def);
          const probe = conv.forward([ 0, 0 ]);
          if (!Array.isArray(probe)) throw new Error("bad");
          sys.conv = conv;
        } catch (e) {
          sys = { error: sys.epsg ? `EPSG:${sys.epsg} could not be set up.` : "This definition could not be read. It should be proj4 text (starting +proj=…) or WKT." };
        }
      }
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(spec, sys);
    return sys;
  }

  // What the chosen system is, for showing next to the picker.
  function describeGrid(spec) {
    const s = resolve(spec);
    if (s.off) return { off: true };
    if (s.error) return { error: s.error };
    return { label: s.label + (s.epsg ? ` (EPSG:${s.epsg})` : ""), note: s.note || "" };
  }

  // -> { e, n, label, epsg } or { error }, or null when the system is "off".
  function project(lat, lon, spec) {
    const s = resolve(spec);
    if (s.off) return null;
    if (s.error) return { error: s.error };
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: "no coordinate" };
    if (s.auto || s.utm) {
      if (lat < -80 || lat > 84) return { error: "outside the UTM area (80° S to 84° N)" };
      const zone = s.utm ? s.utm.zone : utmZone(lat, lon);
      const south = s.utm ? s.utm.south : lat < 0;
      const r = utmForward(lat, lon, zone, south);
      if (!Number.isFinite(r.e) || !Number.isFinite(r.n)) return { error: "too far from this UTM zone" };
      return { e: r.e, n: r.n, label: `UTM zone ${zone}${south ? "S" : "N"}`, epsg: (south ? 32700 : 32600) + zone };
    }
    let p;
    try {
      p = s.conv.forward([ lon, lat ]);
    } catch (e) {
      p = null;
    }
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return { error: "outside the area this grid covers" };
    return { e: p[0], n: p[1], label: s.label, epsg: s.epsg || null };
  }

  // Easting/Northing to the millimetre.
  const formatGrid = v => Number.isFinite(v) ? +v.toFixed(3) : "";

  return {
    parseDmsString, parseCoord, parseDecimal, splitPair, inLatRange, inLonRange,
    formatDMS, formatDDM, formatDD, formatDDText,
    utmZone, utmForward, describeGrid, project, formatGrid
  };
});
