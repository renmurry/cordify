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
| `tesseract/tesseract.min.js`, `worker.min.js` | Tesseract.js (OCR for the Scan tab) | 5.1.1 | https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/ | Apache-2.0 |
| `tesseract/tesseract-core-*.wasm.js` | Tesseract engine | 5.1.1 | https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/ | Apache-2.0 |
| `tesseract/eng.traineddata.gz` | English language data | 1.0.0 (4.0.0_best_int) | https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/ | Apache-2.0 |
| `pdfjs/pdf.min.js`, `pdf.worker.min.js` | PDF.js (reads PDFs for the Scan tab) | 3.11.174 | https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/ | Apache-2.0 |

The Tesseract and PDF.js files (about 12 MB) are loaded only when the Scan tab is
first used, and stored for offline use from then on.

Checksums at the time of copying (SHA-256 for Leaflet and JSZip, SHA-512 for
proj4, SHA-384 for sql.js):

```
leaflet/leaflet.css   sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=
leaflet/leaflet.js    sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=
proj4.js              sha512-aIqYhZWmKBmfxEcdqUuqln8wMYFvGUKw4sqfjNcCoEQgx2iZF26+ikx0kz35uHjwpejMeHCcfHUpCtkohi2raw==
jszip.min.js          sha256-rMfkFFWoB2W1/Zx+4bgHim0WC7vKRVrq6FTeZclH1Z4=
sql-wasm.js           sha384-8D3Rsfo535FqoC1pHCCQMrNf75UgzyoG/HQm9zOzITRrz3QKzecc2E7JXKGCXoWu
sql-wasm.wasm         sha384-kSm0AH9ho89napVfNFf/kCRTH6xBoCS3qf/ATGJeYFQFKiegBMLhQ3aUIZBlYLpa
tesseract/tesseract.min.js                  sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F
tesseract/worker.min.js                     sha384-zxn+VqofFzXpH99dUb3fa4ywoSBQJPy6/6oEaJHPlblZXr53a0g1Jl6720vgSzB7
tesseract/tesseract-core-lstm.wasm.js       sha384-EKWY5JDwphQoyxhvYU7eaCcyQ0EdV6fZK3L2vzfZcv2ichRdNd6pSnyWPNv6fMuR
tesseract/tesseract-core-simd-lstm.wasm.js  sha384-YM1G+zaWYy9VSRP2C101LCgzh7n3Hqb6OEm9qDoZYgCADsni3nnECskC3WialQB7
tesseract/eng.traineddata.gz                sha384-JI+fraGAoc5GBGIliuqzHRnP1nJyrukg5ggNSBv/TO+YOVj+6Te6XXQOx7ia10xq
pdfjs/pdf.min.js                            sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e
pdfjs/pdf.worker.min.js                     sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2
```
