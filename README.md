# Cordify

A small, fast web app for converting geographic coordinates between two common
formats, with history, mapping, and batch (spreadsheet) conversion.

**Live site:** https://renmurry.github.io/cordify/

## What it does

- **DMS ⇄ DD** — convert coordinates between Degrees/Minutes/Seconds
  (e.g. `12° 34' 56.7" N`) and Decimal Degrees (e.g. `12.582417`), in both
  directions, with adjustable precision.
- **Batch convert** — upload an Excel (`.xlsx`/`.xls`) or `.csv` file. Every
  sheet (or one) is read, and the coordinate column(s) are found for you: both
  values in one column (`26.92, 95.03`) or separate Lat and Lon columns. Values
  in decimal degrees, DMS or degrees + decimal minutes are read; pick which of
  those formats to add as new columns. You get an exact count of rows converted,
  and the rows that couldn't be read are listed with the reason (badly typed
  values can be fixed in Repair). Download the same workbook with the new
  columns, or CSV (one per sheet, zipped, opens correctly in Excel).
- **History** — every conversion is saved locally in your browser. You can
  review, export (JSON/CSV), or clear it.
- **Map** — plot any result, or all of your history, on an interactive
  OpenStreetMap (via Leaflet).
- **Export** — save your points as GeoJSON, KML, or KMZ for use in Google Earth
  and GIS tools.
- **Repair (Advanced mode)** — turn on **Advanced** in the header to get the
  Repair tab. Upload a boundary (KML, KMZ, zipped Shapefile in WGS84, or
  GeoJSON) and a spreadsheet of badly typed coordinates. Cordify tries every
  sensible reading of each value (misplaced decimal points, missing °/′/″,
  `°` typed for `0`, swapped lat/lon, letters typed for digits, a wrong degree
  digit) and keeps only readings that fall inside the boundary. Each row is
  marked: unchanged, corrected (yellow), needs checking (orange) or not fixed
  (red). Values that were typed correctly are never changed without your
  confirmation. Every coordinate column in every sheet is found (one-column
  pairs or Lat + Lon pairs, several per row). Export the same workbook with
  new columns in decimal degrees, DMS and/or degrees + decimal minutes, or
  GeoJSON/KML. Without a boundary file, the area is estimated from the rows
  that are already correct (less reliable). Works for any area in the world.
  While reviewing you can place a point by clicking the map, see flags for
  duplicate points and points far from their village, and save your progress
  to a small file to continue later.
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
assets/js/repair-engine.js  Coordinate repair logic (no UI; also runs in Node)
assets/js/repair-ui.js   Repair tab: boundary/data upload, review, export
assets/js/batch.js       Batch convert (Convert tab)
assets/js/tips.js        Tooltips and the one-time Repair hint
assets/js/brand-swap.js  The swapping "DMS ⇄ decimal degrees" header text
tests/history.test.html  Browser test page for the history store
tests/repair-engine.test.js  Repair tests: run `node tests/repair-engine.test.js`
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
