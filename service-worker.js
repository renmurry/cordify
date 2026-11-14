// Cordify service worker
// Strategy:
//   - Navigations + same-origin scripts/styles: NETWORK-FIRST (so users get
//     updates immediately), falling back to cache when offline.
//   - Everything else: cache-first.
// Bump CACHE_NAME whenever you ship changes you want users to receive.
// This copy's folder on the site, e.g. /cordify/
const BASE = new URL('./', self.location).pathname;
const CACHE_NAME = 'cordify-cache-v29';
const PRECACHE = [
  './',
  './index.html',
  './favicon.ico',
  './manifest.json',
  './assets/css/styles.css',
  './assets/js/core.js',
  './assets/js/grid.js',
  './assets/js/app.js',
  './assets/js/historyStore.js',
  './assets/js/repair-engine.js',
  './assets/js/xlsx-color.js',
  './assets/js/repair-ui.js',
  './assets/js/reference.js',
  './assets/js/brand-swap.js',
  './assets/js/looks.js',
  './assets/js/versions.js',
  './assets/js/scan-core.js',
  './assets/js/scan.js',
  './assets/js/batch.js',
  './assets/js/pinpoint.js',
  './assets/js/systems.js',
  './assets/js/batch-core.js',
  './assets/js/habits.js',
  './assets/js/batch-worker.js',
  './assets/js/db.js',
  './assets/js/geo-io.js',
  './assets/js/gis-export.js',
  './assets/js/tips.js',
  './assets/js/sheet.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  // Libraries, kept in the repo so nothing is fetched from another site.
  './assets/vendor/leaflet/leaflet.css',
  './assets/vendor/leaflet/leaflet.js',
  './assets/vendor/leaflet/images/marker-icon.png',
  './assets/vendor/leaflet/images/marker-icon-2x.png',
  './assets/vendor/leaflet/images/marker-shadow.png',
  './assets/vendor/leaflet/images/layers.png',
  './assets/vendor/leaflet/images/layers-2x.png',
  './assets/vendor/proj4.js',
  './assets/vendor/jszip.min.js',
  './assets/vendor/xlsx.full.min.js',
  './assets/vendor/sql-wasm.js',
  './assets/vendor/sql-wasm.wasm'
];
// Map tiles are the only thing that still needs the internet.

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE);
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await clients.claim();
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  // The other versions on the site (previous/, preview/) and the list of versions are always
  // fetched from the network: this offline copy is only for the version it belongs to.
  if (sameOrigin && (url.pathname.startsWith(BASE + 'previous/') || url.pathname.startsWith(BASE + 'preview/') || url.pathname === BASE + 'channels.json')) return;
  const isAppCode = sameOrigin && (
    req.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css')
  );

  if (isAppCode) {
    // Network-first: fresh code when online, cached copy when offline.
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // Only a good copy is stored: a 404 or 500 during a deploy must never replace a working file.
        if (fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (e) {
        const cached = await caches.match(req, { ignoreSearch: true });
        return cached || caches.match('./index.html', { ignoreSearch: true });
      }
    })());
    return;
  }

  // Cache-first for everything else (icons, library images, the .wasm file).
  // The Scan tab's reader (assets/vendor/tesseract, pdfjs: about 12 MB) is not stored at
  // install, only the first time it is used, so people who never scan never download it.
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const fresh = await fetch(req);
    if (sameOrigin && fresh.ok && url.pathname.includes('/assets/vendor/')) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone());
    }
    return fresh;
  })());
});
