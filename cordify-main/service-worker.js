const CACHE_NAME = 'cordify-cache-v1';
const urlsToCache = [
  './',
  './index.html',
  './favicon.ico',
  './assets/css/styles.css',
  './assets/js/app.js',
  './assets/js/historyStore.js'
];

self.addEventListener('install', event => {
  // activate new SW immediately
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('activate', event => {
  // take control of uncontrolled clients
  event.waitUntil((async () => {
    clients.claim();
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
    );
  })());
});


self.addEventListener('fetch', event => {
  // prefer cache, ignore query string so versioned URLs still match
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true })
      .then(response => {
        if (response) return response;
        return fetch(event.request).catch(() => {
          // network failed -> try root as a fallback
          return caches.match('/', { ignoreSearch: true });
        });
      })
  );
});
