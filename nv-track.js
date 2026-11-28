/* NovaX app health measurements (28 Nov 2026).
 *
 * Small, anonymous events for the admin "App health" tab: which screens
 * people use or bounce off, rage taps, booking completion and how long it
 * takes, sign-in and CNIC failures, notification taps, time until the
 * portal is ready, and script errors. No names, phones, addresses or what a
 * merchant types: a random id per tab, the platform, the event.
 * Sent in batches through nv_app_track (sql_novax_app_health_20261128.sql).
 * Events waiting when the page changes are kept in sessionStorage and sent
 * from the next page, so a tap that navigates is not lost.
 */
(function () {
  if (window.nvTrack) return;
  var ss = null; try { ss = window.sessionStorage; } catch (e) {}
  function sget(k) { try { return ss ? ss.getItem(k) : null; } catch (e) { return null; } }
  function sset(k, v) { try { if (ss) ss.setItem(k, v); } catch (e) {} }

  var SID = sget("nvTrkSid");
  if (!SID) { SID = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 24); sset("nvTrkSid", SID); }
  var C = window.Capacitor, native = false, plat = "web";
  try { native = !!(C && C.isNativePlatform && C.isNativePlatform()); if (native) plat = C.getPlatform() === "ios" ? "ios" : "android"; } catch (e) {}
  var app = native || sget("nvApp") === "1" || /[?&]source=app(&|#|$)/.test(location.search);
  var page = (location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "") || "index";

  var Q = []; try { Q = JSON.parse(sget("nvTrkQ") || "[]") || []; } catch (e) { Q = []; }
  sset("nvTrkQ", "[]");
  var cur = null, curAt = 0, bookAt = 0, timer = null, sending = false, errs = 0;

  /* Demo portal and local copies are not real use. */
  var off = /[?&]demo=1(&|#|$)/.test(location.search) ||
            (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !/[?&]qa=1/.test(location.search));
  function track(name, o) {
    if (off || window.__NOVAX_DEMO) return;
    o = o || {};
    var ev = { n: name, s: String(o.screen || cur || page).slice(0, 60) };
    if (o.ms != null && isFinite(o.ms)) ev.ms = Math.max(0, Math.round(o.ms));
    if (o.meta) ev.m = o.meta;
    Q.push(ev);
    if (Q.length > 60) Q = Q.slice(-60);
    if (Q.length >= 20) flush(); else if (!timer) timer = setTimeout(flush, 6000);
  }
  function flush() {
    clearTimeout(timer); timer = null;
    var sb = window.__nvSb;
    if (!Q.length || sending) return;
    if (!sb || !sb.rpc) { timer = setTimeout(flush, 4000); return; }
    var batch = Q.splice(0, 30); sending = true;
    Promise.resolve(sb.rpc("nv_app_track", { p_session: SID, p_platform: plat, p_source: app ? "app" : "web", p_events: batch }))
      .then(function (r) { sending = false; if (r && r.error) return; if (Q.length) timer = setTimeout(flush, 1000); },
            function () { sending = false; });
  }
  /* Leaving the page: keep what is waiting for the next page in this tab. */
  function park() { if (Q.length) sset("nvTrkQ", JSON.stringify(Q.slice(-60))); }
  window.addEventListener("pagehide", park);
  document.addEventListener("visibilitychange", function () { if (document.hidden) { park(); flush(); } });

  window.nvTrack = track;
  /* client-app.js calls this from showClientTab(). */
  window.nvTrackScreen = function (id) {
    if (!id || id === cur) return;
    var now = Date.now();
    if (cur && curAt && now - curAt < 3000) track("screen_bounce", { screen: cur, ms: now - curAt });
    cur = String(id); curAt = now;
    track("screen", { screen: cur });
    if (cur === "newBooking" && !bookAt) { bookAt = now; track("booking_open"); }
  };
  document.addEventListener("nv:booked", function () {
    track("booking_done", { screen: "newBooking", ms: bookAt ? Date.now() - bookAt : null });
    bookAt = 0;
  });

  /* Rage taps: three taps within 0.8 s on the same spot usually mean
     something did not respond or was not understood. */
  var taps = [], lastRage = 0;
  document.addEventListener("pointerdown", function (e) {
    var t = Date.now(); taps = taps.filter(function (x) { return t - x.t < 800; });
    taps.push({ t: t, x: e.clientX, y: e.clientY });
    if (taps.length < 3 || t - lastRage < 2000) return;
    var a = taps[0], near = taps.every(function (x) { return Math.abs(x.x - a.x) < 32 && Math.abs(x.y - a.y) < 32; });
    if (!near) return;
    lastRage = t; taps = [];
    var el = e.target && e.target.closest ? e.target.closest("button,a,label,input,select,summary,[role=button],[data-tab]") || e.target : null;
    var what = "";
    try { what = el ? (el.getAttribute("aria-label") || el.getAttribute("data-tab") || (el.id ? "#" + el.id : "") || (el.textContent || "").replace(/\s+/g, " ").trim() || el.tagName.toLowerCase()) : ""; } catch (x) {}
    /* Typed text is never sent: inputs report their id or name only. */
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) what = el.id ? "#" + el.id : (el.name || el.tagName.toLowerCase());
    track("rage_tap", { meta: { el: String(what).slice(0, 60) } });
  }, { passive: true, capture: true });

  /* Script errors: the web view's version of a crash. Five per tab at most. */
  window.addEventListener("error", function (e) {
    if (++errs > 5) return;
    var m = String((e && (e.message || (e.error && e.error.message))) || "error").slice(0, 140);
    if (/^Script error\.?$/i.test(m) || /ResizeObserver loop/i.test(m)) return;
    track("js_error", { meta: { why: m, at: String((e && e.filename) || "").split("/").pop().split("?")[0].slice(0, 40) } });
  });

  /* CNIC uploads, wherever they start (signup or the Profile screen). */
  function wrapCnic() {
    var N = window.NVCnic; if (!N || !N.send || N.send.__nvTrk) return !!N;
    var send = N.send;
    N.send = function () {
      var t0 = Date.now();
      return Promise.resolve(send.apply(this, arguments)).then(function (r) {
        track("cnic_ok", { ms: Date.now() - t0 }); return r;
      }, function (err) {
        track("cnic_fail", { ms: Date.now() - t0, meta: { why: String((err && err.message) || err || "failed").slice(0, 120) } });
        throw err;
      });
    };
    N.send.__nvTrk = true; return true;
  }
  if (!wrapCnic()) document.addEventListener("DOMContentLoaded", wrapCnic);

  /* Time until the portal has the merchant's data. */
  if (page === "client") {
    var t0 = (performance && performance.timing && performance.timing.navigationStart) || Date.now();
    var tries = 0, iv = setInterval(function () {
      if (window.__novaxClientDataReady) { clearInterval(iv); track("ready", { screen: "client", ms: Date.now() - t0 }); }
      else if (++tries > 120) clearInterval(iv);
    }, 250);
  }
  if (Q.length) timer = setTimeout(flush, 1500);
})();
