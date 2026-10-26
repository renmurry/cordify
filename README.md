# Cordify

A small, fast web app for converting geographic coordinates between two common
formats, with history, mapping, and batch (spreadsheet) conversion.

**Live site:** https://renmurry.github.io/cordify/

## What it does

- **DMS ⇄ DD** — convert coordinates between Degrees/Minutes/Seconds
  (e.g. `12° 34' 56.7" N`) and Decimal Degrees (e.g. `12.582417`), in both
  directions, with adjustable precision.
- **Batch convert** — upload an Excel (`.xlsx`/`.xls`) or `.csv` file, pick the
  latitude/longitude columns, convert every row at once, then download the
  result as XLSX or CSV.
- **History** — every conversion is saved locally in your browser. You can
  review, export (JSON/CSV), or clear it.
- **Map** — plot any result, or all of your history, on an interactive
  OpenStreetMap (via Leaflet).
- **Export** — save your points as GeoJSON, KML, or KMZ for use in Google Earth
  and GIS tools.
- **Installable (PWA)** — can be added to your home screen / desktop and works
  offline after the first visit (map tiles still need internet).

## How to use it

1. Open the live site (link above).
2. On the **Convert** tab, type into either tool, or paste a whole pair such as
   `12°34'56" N, 77°35'12" E` or `12.58, 77.59`. The result updates as you
   type. Press **Enter** or **Save to history** to keep it. Use **Copy** to grab
   the result or **Show on map** to see it plotted.
3. For many rows at once, scroll to **Batch convert**, upload a file, choose
   your columns and direction, click **Convert all rows**, then download.
4. The **History** and **Map** tabs let you revisit and visualize past work. The
   map fills the screen; Plot all, Clear and Export float in its corner.

Everything runs entirely in your browser — no data is sent to any server.

## Project structure

```
index.html              Main app page
assets/css/styles.css    Styling (light + dark mode)
assets/js/app.js         App logic: conversions, batch, map, exports
assets/js/historyStore.js Local storage of conversion history
assets/icons/            App icons (192px, 512px)
service-worker.js        Offline caching (PWA)
manifest.json            PWA configuration
tests/history.test.html  Browser test page for the history store
```

## Running locally

Because it uses a service worker, open it through a local web server rather than
double-clicking the file. For example, with Python installed:

```
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Tech / libraries

Plain HTML, CSS, and JavaScript (no build step). External libraries are loaded
from CDNs: [Leaflet](https://leafletjs.com/) (maps),
[SheetJS](https://sheetjs.com/) (Excel/CSV),
[JSZip](https://stuk.github.io/jszip/) (KMZ), and
[proj4js](http://proj4js.org/) (projections). Versions are pinned in
`index.html` and must match the `CDN_ASSETS` list in `service-worker.js`.
