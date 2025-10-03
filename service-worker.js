const CACHE_NAME = 'cordify-cache-v2';
const urlsToCache = [
  './',
  './index.html',
  './favicon.ico',
  './assets/css/styles.css',
  './assets/js/app.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  event.respondWith((async () => {
    // For navigations, try cache first, then network, fallback to cached index.html
    if (req.mode === 'navigate') {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match('./index.html');
      try {
        const fresh = await fetch(req);
        return fresh;
      } catch {
        return cached || fetch(req);
      }
    }
    const cached = await caches.match(req);
    return cached || fetch(req);
  })());
});
