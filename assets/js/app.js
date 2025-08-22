// scripts for cordify

// ---- Robust DMS string parser ----
// Supports: symbols/spaces, , as decimal, signed degrees, leading/trailing NSEW,
// and partial forms: D°, D M, D M S (with or without ° ' ").
function parseDmsString(dmsStr) {
  if (!dmsStr) return null;

  // Normalize
  dmsStr = dmsStr.trim()
    .replace(/[′’‘`´]/g, "'")        // variants -> '
    .replace(/[″“”]/g, '"')          // variants -> "
    .replace(/\u00B0/g, '°')         // ensure standard degree symbol
    .replace(/,/g, '.')              // allow comma decimals
    .toUpperCase()
    .replace(/\s+/g, ' ');

  // Grab leading/trailing direction
  let leadDir = (dmsStr.match(/^[NSWE]/) || [null])[0];
  let tailDir = (dmsStr.match(/[NSWE]$/) || [null])[0];

  if (leadDir && tailDir && leadDir !== tailDir) return null; // conflicting
  let dir = tailDir || leadDir || null;

  // Strip direction chars for numeric parsing
  if (leadDir) dmsStr = dmsStr.slice(1).trim();
  if (tailDir) dmsStr = dmsStr.slice(0, -1).trim();

  // Match deg [min] [sec] using either symbols or spaces
  // Examples: 25 34 47.035 | 25°34'47.035" | -23° 30' | +10 12.5 | 10° | 10 12
  const regex = /^([+-]?\d+(?:\.\d+)?)(?:[°\s]+(\d+(?:\.\d+)?))?(?:['\s]+(\d+(?:\.\d+)?))?(?:"?)$/;
  const m = dmsStr.match(regex);
  if (!m) return null;

  let deg = parseFloat(m[1]);
  let min = m[2] !== undefined ? parseFloat(m[2]) : 0;
  let sec = m[3] !== undefined ? parseFloat(m[3]) : 0;

  if ([deg, min, sec].some(Number.isNaN)) return null;
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;

  let dd = Math.abs(deg) + (min / 60) + (sec / 3600);
  if (deg < 0) dd = -dd; // signed degree overrides
  if (dir === 'S' || dir === 'W') dd = -Math.abs(dd); // NSEW applies sign

  return dd;
}

function dmsToDd(deg, min, sec, dir) {
  if ([deg, min, sec].some(v => Number.isNaN(v))) return null;
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;
  let dd = Math.abs(deg) + min / 60 + sec / 3600;
  if (dir === "S" || dir === "W") dd *= -1;
  if (deg < 0) dd *= -1; // if user typed negative deg, respect it
  return dd;
}

function ddToDms(dd, latlon) {
  if (Number.isNaN(dd)) return null;
  const dir = latlon === "lat" ? (dd < 0 ? "S" : "N") : (dd < 0 ? "W" : "E");
  dd = Math.abs(dd);
  const deg = Math.floor(dd);
  const minFloat = (dd - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = ((minFloat - min) * 60);
  const secStr = sec.toFixed(3).replace(/\.?0+$/,''); // trim trailing zeros
  return `${deg}° ${min}' ${secStr}" ${dir}`;
}

function inLatRange(v) { return v >= -90 && v <= 90; }
function inLonRange(v) { return v >= -180 && v <= 180; }

function convertDmsToDd() {
  const latStr = document.getElementById('dms_lat_string').value.trim();
  const lonStr = document.getElementById('dms_lon_string').value.trim();
  let dd_lat, dd_lon;

  if (latStr) {
    dd_lat = parseDmsString(latStr);
    if (dd_lat === null || !inLatRange(dd_lat)) { alert('Invalid Latitude DMS.'); return; }
  } else {
    dd_lat = dmsToDd(
      parseFloat(document.getElementById('dms_lat_deg').value) || 0,
      parseFloat(document.getElementById('dms_lat_min').value) || 0,
      parseFloat(document.getElementById('dms_lat_sec').value) || 0,
      document.getElementById('dms_lat_dir').value
    );
    if (dd_lat === null || !inLatRange(dd_lat)) { alert('Invalid Latitude D/M/S.'); return; }
  }

  if (lonStr) {
    dd_lon = parseDmsString(lonStr);
    if (dd_lon === null || !inLonRange(dd_lon)) { alert('Invalid Longitude DMS.'); return; }
  } else {
    dd_lon = dmsToDd(
      parseFloat(document.getElementById('dms_lon_deg').value) || 0,
      parseFloat(document.getElementById('dms_lon_min').value) || 0,
      parseFloat(document.getElementById('dms_lon_sec').value) || 0,
      document.getElementById('dms_lon_dir').value
    );
    if (dd_lon === null || !inLonRange(dd_lon)) { alert('Invalid Longitude D/M/S.'); return; }
  }

  document.getElementById('dd_result').value =
    `Latitude (Y): ${dd_lat.toFixed(6)}\nLongitude (X): ${dd_lon.toFixed(6)}`;
}

function convertDdToDms() {
  const dd_lat = parseFloat(document.getElementById('dd_lat').value);
  const dd_lon = parseFloat(document.getElementById('dd_lon').value);

  if (Number.isNaN(dd_lat) || !inLatRange(dd_lat)) { alert('Enter a valid latitude in DD (−90..90).'); return; }
  if (Number.isNaN(dd_lon) || !inLonRange(dd_lon)) { alert('Enter a valid longitude in DD (−180..180).'); return; }

  const dms_lat = ddToDms(dd_lat, "lat");
  const dms_lon = ddToDms(dd_lon, "lon");

  document.getElementById('dms_result').value =
    `Latitude (Y): ${dms_lat}\nLongitude (X): ${dms_lon}`;
}
