// NovaX Logistics -- intentionally minimal, self-removing service worker.
// NovaX does not use offline/PWA functionality right now. This file exists
// only so any browser tab that still has an old service worker registered
// (from a previous deploy) gets a valid response instead of a 404, and so
// that this worker immediately clears any caches it finds and unregisters
// itself -- no stale cached files are ever served again.
self.addEventListener("install", function (event) {
  self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      try {
        var keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      } catch (e) {}
      try {
        await self.registration.unregister();
      } catch (e) {}
      try {
        var clientsList = await self.clients.matchAll({ type: "window" });
        clientsList.forEach(function (c) { c.navigate(c.url); });
      } catch (e) {}
    })()
  );
});
