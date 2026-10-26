// Cordify service worker
// Strategy:
//   - Navigations + same-origin scripts/styles: NETWORK-FIRST (so users get
//     updates immediately), falling back to cache when offline.
//   - Everything else: cache-first.
// Bump CACHE_NAME whenever you ship changes you want users to receive.
const CACHE_NAME = 'cordify-cache-v5';
const PRECACHE = [
  './',
  './index.html',
  './favicon.ico',
  './manifest.json',
  './assets/css/styles.css',
  './assets/js/app.js',
  './assets/js/historyStore.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];
// Pinned library versions (must match index.html). Cached so batch, map and
// KMZ export work offline. Map tiles still need internet.
const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  'https://cdn.jsdelivr.net/npm/proj4@2.8.1/dist/proj4.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE);
    // Best effort: a CDN failure must not block install.
    await Promise.all(CDN_ASSETS.map(async url => {
      try {
        const mode = url.includes('sheetjs') ? 'no-cors' : 'cors';
        const res = await fetch(url, { mode });
        if (res.ok || res.type === 'opaque') await cache.put(url, res);
      } catch (e) {}
    }));
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
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match(req, { ignoreSearch: true });
        return cached || caches.match('./index.html', { ignoreSearch: true });
      }
    })());
    return;
  }

  if (CDN_ASSETS.includes(req.url)) {
    // Pinned versions never change: cache-first, store on first fetch.
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      if (fresh.ok || fresh.type === 'opaque') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
      }
      return fresh;
    })());
    return;
  }

  // Cache-first for other same-origin assets (icons, etc.)
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req))
  );
});
