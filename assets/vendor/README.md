# Third-party libraries

Copied here unchanged so Cordify works with no internet and never loads code
from another site. To update one, replace the file with the new version from
the same source, update this table, and bump `CACHE_NAME` in
`service-worker.js`.

| File | Library | Version | Source | Licence |
|---|---|---|---|---|
| `leaflet/` | Leaflet (maps) | 1.9.4 | https://unpkg.com/leaflet@1.9.4/dist/ | BSD-2-Clause |
| `proj4.js` | proj4js (projections) | 2.8.1 | https://cdn.jsdelivr.net/npm/proj4@2.8.1/dist/proj4.js | MIT |
| `jszip.min.js` | JSZip (KMZ, zipped CSV) | 3.10.1 | https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js | MIT or GPL-3.0 |
| `xlsx.full.min.js` | SheetJS (Excel, CSV) | 0.20.3 | https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js | Apache-2.0 |
| `sql-wasm.js`, `sql-wasm.wasm` | sql.js (GeoPackage) | 1.10.3 | https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/ | MIT |

Checksums at the time of copying (SHA-256 for Leaflet and JSZip, SHA-512 for
proj4, SHA-384 for sql.js):

```
leaflet/leaflet.css   sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=
leaflet/leaflet.js    sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=
proj4.js              sha512-aIqYhZWmKBmfxEcdqUuqln8wMYFvGUKw4sqfjNcCoEQgx2iZF26+ikx0kz35uHjwpejMeHCcfHUpCtkohi2raw==
jszip.min.js          sha256-rMfkFFWoB2W1/Zx+4bgHim0WC7vKRVrq6FTeZclH1Z4=
sql-wasm.js           sha384-8D3Rsfo535FqoC1pHCCQMrNf75UgzyoG/HQm9zOzITRrz3QKzecc2E7JXKGCXoWu
sql-wasm.wasm         sha384-kSm0AH9ho89napVfNFf/kCRTH6xBoCS3qf/ATGJeYFQFKiegBMLhQ3aUIZBlYLpa
```
