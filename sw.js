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
var CACHE = "novax-v235";
/* The two Nova Instant pages a phone on a weak connection must still be able
   to open: the customer's booking/tracking page and the Instant rider's page. */
var SHELLS = ["/client.html", "/rider.html", "/instant.html", "/instant-rider.html", "/instant-account.html"];
var PRECACHE = SHELLS.concat(["/assets/favicon.svg", "/offline.html"]);

self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* Individually, so one 404 cannot fail the whole install. */
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(u).catch(function () {});
      })).then(function () {
        /* Precaching the HTML alone was a trap. That HTML hardcodes ONE bundle
           URL (client-app.js?v=<hash>); assets are cache-first and activate
           deletes older caches, so the offline fallback could serve a shell
           whose bundle was in no cache. Offline, that shell can never boot --
           every function it needs is simply absent, and the merchant sees
           "one file did not arrive" with a Reload that changes nothing.
           Read the scripts the shell actually asks for and cache them with it,
           so the pair is always coherent. */
        return Promise.all(SHELLS.map(function (shell) { return c.match(shell).then(function (res) {
          if (!res) return;
          return res.clone().text().then(function (html) {
            var urls = [], re = /<script[^>]+src="([^"]+)"/g, m;
            while ((m = re.exec(html))) {
              if (m[1].indexOf("//") === -1) urls.push(m[1]);   /* same-origin only */
            }
            var css = /<link[^>]+href="([^"]+\.css[^\"]*)"/g;
            while ((m = css.exec(html))) { if (m[1].indexOf("//") === -1) urls.push(m[1]); }
            return Promise.all(urls.map(function (u) {
              return c.add(u).catch(function () {});
            }));
          });
        }).catch(function () {}); }));
      });
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
    /* NETWORK FIRST. Cache only as a fallback for a failed network.
       cache:"no-cache" revalidates with the server every time: GitHub Pages
       sends max-age=600, so a plain fetch could hand back a page up to ten
       minutes old after a fix went out. */
    event.respondWith(
      fetch(req, { cache: "no-cache" }).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          /* A tracking link (instant.html?t=...) has never been cached under
             its own address, so it falls back to the saved page, which then
             says the booking could not be loaded and tries again. */
          var shell = SHELLS.indexOf(url.pathname) > -1 ? url.pathname :
                      (url.pathname === "/" || url.pathname === "/index.html") ? "/index.html" : null;
          var saved = shell ? caches.match(shell).then(function (c) { return c || (shell === "/index.html" ? caches.match("/") : null); }) : Promise.resolve(null);
          return saved.then(function (cached) {
            if (cached) return cached;
            /* No saved copy: the NovaX offline page (it retries by itself and
               reloads once the site answers). Status stays 503. */
            return caches.match("/offline.html").then(function (page) {
              if (page) return page.text().then(function (html) {
                return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
              });
              return new Response("Offline. Reconnect to open this page.", { status: 503, headers: { "Content-Type": "text/plain" } });
            });
          });
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

/* ── Nova Instant job alerts ──
   nvi-push sends an empty push (no payload), so the words are fixed here.
   The rider app's "Send me a test alert" leaves a note in the cache first,
   so a test says it is a test. Tapping opens (or brings back) the rider app. */
self.addEventListener("push", function (event) {
  event.waitUntil(
    caches.open("nvi-flags").then(function (c) {
      return c.match("/__nvi_test").then(function (hit) {
        if (!hit) return false;
        return hit.text().then(function (t) { c.delete("/__nvi_test"); return Date.now() - Number(t) < 120000; });
      });
    }).catch(function () { return false; }).then(function (isTest) {
      return self.registration.showNotification(isTest ? "Test alert: job alerts work" : "New Nova Instant job", {
        body: isTest ? "New jobs will ring like this, even with the phone locked." : "A parcel is waiting for a rider. Open the app to see it and accept.",
        tag: "nvi-job",
        renotify: true,
        requireInteraction: !isTest,
        icon: "/assets/icon-192.png",
        badge: "/assets/icon-192.png",
        vibrate: [300, 120, 300, 120, 300],
        data: { url: "/instant-rider.html" }
      });
    })
  );
});
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/instant-rider.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      var i;
      /* The Instant rider page on its own. */
      for (i = 0; i < list.length; i++) {
        if (list[i].frameType !== "nested" && list[i].url.indexOf("/instant-rider.html") > -1 && "focus" in list[i]) return list[i].focus();
      }
      /* The NovaX rider app, which has Nova Instant as a tab: bring it forward on that tab. */
      for (i = 0; i < list.length; i++) {
        if (list[i].frameType !== "nested" && list[i].url.indexOf("/rider.html") > -1 && "focus" in list[i]) {
          list[i].postMessage({ nvi: "open-instant" });
          return list[i].focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
