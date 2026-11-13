// This channel works online only. Its own offline copy is switched off so that it
// never disturbs the offline copy of the latest version on the same site.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
