/* NovaX Logistics — service worker.
 *
 * The previous worker at this path was deliberately SELF-REMOVING: it deleted
 * every cache and unregistered itself. That was the right call at the time,
 * because an earlier cache-first worker had served merchants a stale portal
 * after a deploy and there was no way to push them off it.
 *
 * This one is built so that cannot happen:
 *
 *   HTML is NETWORK-FIRST. A merchant on a working connection always gets the
 *   deploy that is live right now. The cache is only ever a fallback for when
 *   the network fails, which is the case it exists for -- a rider's phone in a
 *   basement, a merchant on a train.
 *
 *   Everything else is cache-first, because it is either immutable or
 *   inconsequential.
 *
 *   The cache name carries a version. Activating a new worker deletes every
 *   cache that is not the current one, so a bad cache cannot outlive a deploy.
 *
 *   ?nosw=1 on any URL makes the worker unregister itself and get out of the
 *   way. That is the kill switch, and it is the reason it is safe to ship
 *   this at all.
 */
var CACHE = "novax-v3";
var PRECACHE = ["/client.html", "/assets/favicon.svg"];

self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* Individually, so one 404 cannot fail the whole install. */
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  /* Never touch anything that is not ours: Supabase, the CDN, analytics. */
  if (url.origin !== self.location.origin) return;

  /* The kill switch. */
  if (url.searchParams.has("nosw")) {
    event.respondWith(
      (async function () {
        try {
          var keys = await caches.keys();
          await Promise.all(keys.map(function (k) { return caches.delete(k); }));
          await self.registration.unregister();
        } catch (e) {}
        return fetch(req);
      })()
    );
    return;
  }

  var isHTML = req.mode === "navigate" ||
               (req.headers.get("accept") || "").indexOf("text/html") > -1;

  if (isHTML) {
    /* NETWORK FIRST. Cache only as a fallback for a failed network. */
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match("/client.html");
        });
      })
    );
    return;
  }

  /* Static assets: cache first, refresh in the background. */
  event.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
