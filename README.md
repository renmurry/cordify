# Cordify

A small, fast web app for converting geographic coordinates between two common
formats, with history, mapping, and batch (spreadsheet) conversion.

**Live site:** https://renmurry.github.io/cordify/

## What it does

- **DMS ⇄ DD** — convert coordinates between Degrees/Minutes/Seconds
  (e.g. `12° 34' 56.7" N`) and Decimal Degrees (e.g. `12.582417`), in both
  directions, with adjustable precision (up to 9 decimals of a degree, about
  0.1 mm, or 0.00001 seconds).
- **Easting / Northing** — pick a grid system at the top of the Convert tab and
  every result, saved point, sheet row and batch row also gets grid coordinates
  in metres: UTM (zone chosen for each point), Web Mercator, British National
  Grid, a few other systems by EPSG code, or any system you paste as proj4 or
  WKT text (including 7-parameter datum shifts). Input is always read as
  WGS 84 latitude/longitude.
- **Keep an Excel sheet** — switch it on in the Convert tab and every conversion
  you save (Enter or "Save to history") is also added as a row: Name/ID (counts
  up automatically, e.g. GCP-01 → GCP-02), decimal degrees, DMS, degrees +
  decimal minutes, source, input, date/time and remarks. The sheet is previewed
  live, kept on this device until you clear it, and downloads as Excel. You can
  also load an Excel file you already have and keep adding to it; its other
  columns are kept.
- **Batch convert** — upload an Excel (`.xlsx`/`.xls`), `.csv`, KML, KMZ,
  GeoJSON or GPX file (points in GIS files become rows; lines and polygons
  come in as their corner points). Every
  sheet (or one) is read, and the coordinate column(s) are found for you: both
  values in one column (`26.92, 95.03`) or separate Lat and Lon columns. Values
  in decimal degrees, DMS or degrees + decimal minutes are read; pick which of
  those formats to add as new columns. You get an exact count of rows converted,
  and the rows that couldn't be read are listed with the reason (badly typed
  values can be fixed in Repair). The reason points to the exact character
  that is wrong, marked in yellow, and says what it probably should be, for
  example "character 6: ’ is probably the decimal point — two readings fit:
  26°41.451’ or 26°41’45.1”". When two readings fit, both are given and
  neither is chosen, unless "Use typing habits to choose between readings"
  is ticked: then the reading that matches the other value in the same cell,
  or the rows of the sheet typed the same way (the same ° ' " marks,
  separator, N/E letters and elevation), is used and the row is marked
  orange to check. The habits found are listed for each sheet. One sheet
  often holds several habits, so the most common format is never used on
  its own. The choice is remembered on the device.
  Other coordinate systems are recognised per sheet, never from one cell:
  UTM or MGRS with the zone in the cell, Easting / Northing columns, Web
  Mercator metres, radians, and latitude/longitude typed the wrong way round.
  A missing UTM zone is found from the column name or from the boundary and
  village locations saved in Repair (the only zone of 121 that puts the
  points there); otherwise you pick it. Cordify always asks first ("these
  look like UTM zone 46N … Read them this way?", Yes / Pick another / No) and
  the choice can be undone. "Source datum" converts coordinates measured on
  Everest / Kalianpur 1937 or 1975 (older Survey of India maps, about
  300–400 m off in North-East India) to WGS 84. Download the same workbook with the new
  columns, or CSV (one per sheet, zipped, opens correctly in Excel).
  "Scan first" (also in Repair) reads the file before anything is converted and
  reports in three to five bullet points: how many rows read as typed and why
  the rest did not (two readings, a wrong character, a missing value, swapped),
  whether a sheet is in another coordinate system, how many of the rows with
  two readings "Use typing habits" would settle, which converted rows deserve
  a look (far from the rest, duplicates, typed roughly) and where the points
  sit. Each suggestion is a button (read as UTM zone 46N, tick typing habits,
  open Repair), "Copy report" copies the text, and nothing is changed by a scan.
  Converting runs in the background with a progress bar and a Cancel button.
  CSV files over 5 MB are never loaded whole: they are read from disk a piece
  at a time (a million rows takes a few seconds) and downloaded as CSV. The
  preview scrolls through every row, and "Show on map" plots the result.
  Rows that converted but deserve a second look are marked "OK - check" with
  the reason in a Convert_Check column: far from the other points in the sheet
  (often a mistyped degree, such as 29.8 for 26.8), the same position as
  another row, or typed much more roughly than the rest of the sheet. When a
  whole sheet is typed roughly (25.811 is only good to about 100 m), that is
  said once for the sheet instead of marking every row.
  The Excel download colours each row: green converted, orange worth
  checking, red not converted, with a Legend sheet.
  Rows that could not be read can be repaired right there ("Repair them
  here"), the same way the Repair tab does it: with the boundary and
  village locations saved in the Repair tab if there are any, otherwise
  with an area estimated from the rows that converted. Repaired rows are
  marked yellow (one clear reading) or orange (best guess) to check.
  "Export for GIS…" saves the points in the formats you tick (GeoPackage,
  Shapefile, GeoJSON, KML, KMZ, GPX, CSV, Excel) with the columns you choose,
  as one zip (or a folder you pick) with a folder per sheet and per format.
  Pins and Excel rows are coloured by result, and rows without a coordinate
  are listed in their own file so none go missing. The same export is in
  Repair and on the sheet.
- **History** — every conversion is saved locally in your browser (in
  IndexedDB, so tens of thousands fit). You can
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
  Rows typed the same way (the same "typing habit", such as ' where the
  decimal point goes) are read the same way and listed together, so a whole
  habit can be checked once and confirmed with one click. Without a boundary
  file, correctly typed points near the estimated area are kept as typed.
  A boundary you load is remembered on the device (in the browser's own
  storage, never uploaded) and loads by itself next time; "Forget it"
  removes it. A value typed correctly but outside the boundary (a village on
  the border, or a rough boundary line) can be kept as typed: per row, or in
  one click for all such values that sit with other points of their village.
  With no boundary file, an area can be drawn on the map; a drawn area can
  also be added to a district (for a village just across the line). The
  boundary in use, drawn areas included, downloads as KML.
  A village locations file (a spreadsheet with village names and
  coordinates, or named points in KML or GeoJSON) makes Repair prefer
  readings near each row's own village and flag points far from it. It is
  remembered on the device like the boundary.
  The Excel export colours each row by its result, with a Legend sheet.
  Rows that are not plainly fine show the wrong characters marked in yellow,
  and rows that could not be fixed say which character is wrong. With
  "Use typing habits" ticked, rows with two readings are read like the rest
  of their sheet; where that reading is outside the boundary, nothing is
  chosen and the row is flagged for you.
- **Scan (Advanced mode)** — the Scan tab finds the coordinates written in
  images, PDFs and scanned pages. PDFs with real text are read exactly;
  scanned pages and photos are read with OCR (printed text reads well,
  handwriting usually does not). Each point is shown beside a picture of where
  it was found so you can check or correct it, then added to a sheet with its
  document and page. Nothing is uploaded.
- **Several sheets and one export for GIS** — keep a sheet per project or
  document. "Export for GIS" writes every sheet as GeoPackage, GeoJSON, KML,
  KMZ, GPX, CSV and Excel, one folder per sheet and per format, as a zip (or
  straight into a folder on desktop Chrome and Edge).
- **Three looks** — tap the name "Cordify" to switch between Solid (the
  default: no blur and the strongest contrast, best outdoors and on slower
  phones), Frost (translucent glass) and Neon (dark, with glowing buttons).
  The choice is remembered on the device. On phones, Frost and Neon move the
  tabs to a bar at the bottom of the screen.
- **Installable (PWA)** — can be added to your home screen / desktop and works
  offline after the first visit, including Excel, KMZ and GeoPackage export
  (only map tiles still need internet).

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
assets/js/core.js        Reading, writing and projecting coordinates (no UI; also runs in Node)
assets/js/grid.js        The "Also give Easting / Northing" picker
assets/js/tabs.js        Shows one tab (Convert, Map, History, Repair, Scan) and hides the others
assets/js/app.js         App logic: converter, history, map, exports
assets/js/historyStore.js Conversion history (kept in IndexedDB)
assets/js/db.js          IndexedDB helper for history and the sheet
assets/icons/            App icons (192px, 512px)
service-worker.js        Offline caching (PWA)
manifest.json            PWA configuration
assets/js/repair-engine.js  Coordinate repair logic (no UI; also runs in Node)
assets/js/repair-ui.js   Repair tab: boundary/data upload, review, export
assets/js/batch.js       Batch convert (Convert tab): the screen
assets/js/pinpoint.js    Points to the exact wrong character in a typed coordinate (no UI; also runs in Node)
assets/js/systems.js     Other coordinate systems: UTM, MGRS, Web Mercator, radians, swapped, datums (no UI; also runs in Node)
assets/js/report.js      Scan first: the short report on a file before converting (no UI; also runs in Node)
assets/js/habits.js      Typing habits: learns how a sheet was typed, to choose between two readings (no UI; also runs in Node)
assets/js/batch-core.js  Batch convert: reading rows, finding columns, CSV (no UI; also runs in Node)
assets/js/batch-worker.js Batch convert: background worker that does the converting
assets/js/reference.js   Boundary and village locations kept on the device; reads village lists
assets/js/xlsx-color.js  Adds row colours and a Legend sheet to Excel exports (no UI)
assets/js/geo-io.js      Reads GeoJSON/KML/GPX, writes GeoJSON/KML/GPX/GeoPackage (no UI)
assets/js/scan-core.js   Finds coordinates in ordinary text (no UI; also runs in Node)
assets/js/scan.js        Scan tab: reads images and PDFs, review, add to a sheet
assets/js/sheet.js       "Keep an Excel sheet" (Convert tab)
assets/js/tips.js        Tooltips and the one-time Repair hint
assets/js/brand-swap.js  The swapping "DMS ⇄ decimal degrees" header text
assets/js/looks.js       Solid / Frost / Neon looks (tap the name "Cordify")
tests/history.test.html  Browser test page for the history store
tests/core.test.js       Converter and projection tests
tests/batch-core.test.js Batch reading and CSV tests
tests/geo-io.test.js     GIS format tests
tests/xlsx-color.test.js Excel colour tests
tests/scan-core.test.js  Coordinate-finding tests
tests/repair-engine.test.js  Repair tests
tests/pinpoint.test.js   Wrong-character tests
tests/habits.test.js     Typing-habit tests
tests/systems.test.js    Coordinate-system tests (made-up values)
tests/report.test.js     Scan-first report tests (made-up values)
package.json             Test tooling only (the app needs no install)
```

## Tests

```
npm install
npm test
```

`npm install` only fetches proj4 so the projection results can be checked
against it; without it those checks are skipped and the rest still run.

## Publishing (versions on the live site)

The live site holds three versions, and a menu next to the name switches
between them:

- **Latest**: the newest release tag (`v1.2.3`), at the usual address
- **Previous**: the release before it, at `previous/`, as a fallback
- **Preview**: a branch that is not released yet, at `preview/`, to try first

Previous and Preview work online only, and all three share what the browser
has saved. To publish after tagging a release:

```
node tools/publish-pages.js --push                       # Preview = main, if it has unreleased commits
node tools/publish-pages.js --push --preview my-branch   # Preview = an open pull request's branch
node tools/publish-pages.js --out site                   # build only, to look at locally
```

GitHub Pages must be set to publish from the `gh-pages` branch.

## Running locally

Because it uses a service worker, open it through a local web server rather than
double-clicking the file. For example, with Python installed:

```
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Tech / libraries

Plain HTML, CSS, and JavaScript (no build step). The libraries are kept in
`assets/vendor/`, so the app never contacts another site (only map tiles do): [Leaflet](https://leafletjs.com/) (maps),
[SheetJS](https://sheetjs.com/) (Excel/CSV),
[JSZip](https://stuk.github.io/jszip/) (KMZ),
[proj4js](http://proj4js.org/) (projections), and
[sql.js](https://sql.js.org/) (GeoPackage, loaded only when you export one). Their versions and where
they came from are listed in `assets/vendor/README.md`; the same files are
listed in `service-worker.js` so they are stored for offline use.
