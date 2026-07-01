// Cordify service worker
// Strategy:
//   - Navigations + same-origin scripts/styles: NETWORK-FIRST (so users get
//     updates immediately), falling back to cache when offline.
//   - Everything else: cache-first.
// Bump CACHE_NAME whenever you ship changes you want users to receive.
const CACHE_NAME = 'cordify-cache-v3';
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

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)));
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

  // Cache-first for other same-origin assets (icons, etc.)
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req))
  );
});
