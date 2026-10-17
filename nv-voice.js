/* NovaX rider voice notes: player for staff pages (admin, Support Desk).
 * 18 Oct 2026. The merchant portal has its own copy inside client-app.js.
 *
 * A page drops an empty <div data-nvvn="AWB"></div> wherever a parcel's note
 * should be heard, and calls NVVoice.init(function () { return supabaseClient; })
 * once. Slots are filled from voice_notes_for() (admins and support agents
 * may read any parcel), and play through a one-hour signed URL from the
 * private parcel-voice bucket. Staff plays are not recorded as "heard":
 * that mark is the merchant's. Notes vanish once a parcel is returned or
 * delivered (sql_novax_rider_voice_notes_20261018.sql).
 */
(function () {
  "use strict";
  var getSb = function () { return null; }, cache = {}, asked = {}, audio = null, playing = "", fillT = null;
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function clock(ms) { var x = Math.max(0, Math.round(Number(ms || 0) / 1000)); return Math.floor(x / 60) + ":" + String(x % 60).padStart(2, "0"); }
  function when(iso) { try { return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Karachi" }); } catch (e) { return ""; } }
  function css() {
    if (document.getElementById("nvvnCss")) return;
    var s = document.createElement("style"); s.id = "nvvnCss";
    /* Works on the dark admin and the light Support Desk: tints come from
       currentColor, the play button is the NovaX green on both. */
    s.textContent =
      ".nvvn:empty{display:none}.nvvn{display:grid;gap:8px;margin:8px 0}" +
      ".nvvn-box{display:grid;grid-template-columns:42px minmax(0,1fr);gap:10px;align-items:center;padding:9px 11px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:12px;background:color-mix(in srgb,currentColor 6%,transparent);text-align:left}" +
      ".nvvn-play{width:42px;height:42px;border-radius:50%;border:0;background:#13c477;color:#04130d;display:grid;place-items:center;cursor:pointer;padding:0}" +
      ".nvvn-play i{width:0;height:0;border-left:12px solid currentColor;border-top:8px solid transparent;border-bottom:8px solid transparent;margin-left:3px}" +
      ".nvvn-play.is-on i{width:12px;height:14px;border:0;margin:0;background:linear-gradient(90deg,currentColor 0 4px,transparent 4px 8px,currentColor 8px 12px)}" +
      ".nvvn-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.nvvn-top b{font-size:13.5px}" +
      ".nvvn-len{margin-left:auto;font:700 12.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.8}" +
      ".nvvn-heard{font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;background:color-mix(in srgb,#13c477 22%,transparent)}" +
      ".nvvn-unheard{font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;background:color-mix(in srgb,#e0a100 26%,transparent)}" +
      ".nvvn-meta{font-size:12px;opacity:.75;margin-top:2px;overflow-wrap:anywhere}" +
      ".nvvn-bar{height:4px;border-radius:2px;background:color-mix(in srgb,currentColor 15%,transparent);margin-top:6px;overflow:hidden}.nvvn-bar i{display:block;height:100%;width:0;background:#13c477}";
    document.head.appendChild(s);
  }
  function html(awb, notes) {
    if (!notes || !notes.length) return "";
    return notes.slice(0, 3).map(function (n) {
      var on = playing === n.id && audio && !audio.paused, st = n.status === "Consignee not available" ? "Not available" : n.status;
      return '<div class="nvvn-box" data-nvvn-id="' + esc(n.id) + '"><button type="button" class="nvvn-play' + (on ? " is-on" : "") + '" data-nvvn-play="' + esc(n.id) + '" aria-label="' + (on ? "Pause" : "Play") + ' the rider’s voice note for ' + esc(awb) + '"><i aria-hidden="true"></i></button>' +
        '<div><div class="nvvn-top"><b>Rider’s voice note</b>' + (n.first_played_at ? '<span class="nvvn-heard">Merchant heard it</span>' : '<span class="nvvn-unheard">Merchant has not played it</span>') +
        '<span class="nvvn-len">' + clock(n.duration_ms) + '</span></div><div class="nvvn-meta">' + esc([n.rider, st, n.reason, when(n.recorded_at)].filter(Boolean).join(" · ")) + '</div><div class="nvvn-bar" aria-hidden="true"><i></i></div></div></div>';
    }).join("");
  }
  function fill() {
    var need = [];
    document.querySelectorAll("[data-nvvn]").forEach(function (el) {
      var awb = el.getAttribute("data-nvvn"); if (!awb) return;
      if (cache[awb] === undefined) { need.push(awb); return; }
      var h = html(awb, cache[awb]); if (el.__nvvn !== h) { el.innerHTML = h; el.__nvvn = h; }
    });
    if (need.length) load(need);
  }
  async function load(awbs) {
    var sb = getSb(), now = Date.now();
    awbs = Array.from(new Set(awbs)).filter(function (a) { return !asked[a] || now - asked[a] > 60000; });
    if (!sb || !awbs.length) return;
    awbs.forEach(function (a) { asked[a] = now; });
    try {
      var r = await sb.rpc("voice_notes_for", { p_awbs: awbs.slice(0, 200) });
      if (r.error) throw r.error;
      awbs.forEach(function (a) { cache[a] = []; });
      (r.data || []).forEach(function (n) { (cache[n.awb] = cache[n.awb] || []).push(n); });
    } catch (e) { if (window.console) console.warn("NovaX voice notes", e && e.message || e); return; }
    fill();
  }
  function find(id) { for (var a in cache) { var n = (cache[a] || []).find(function (x) { return x.id === id; }); if (n) return n; } return null; }
  function paint() {
    document.querySelectorAll("[data-nvvn-play]").forEach(function (b) {
      var on = b.getAttribute("data-nvvn-play") === playing && audio && !audio.paused;
      b.classList.toggle("is-on", !!on);
    });
  }
  async function play(id) {
    var n = find(id), sb = getSb(); if (!n || !sb) return;
    if (!audio) {
      audio = new Audio(); audio.preload = "auto";
      audio.addEventListener("timeupdate", function () {
        var total = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number((find(playing) || {}).duration_ms || 0) / 1000;
        document.querySelectorAll('[data-nvvn-id="' + playing + '"] .nvvn-bar i').forEach(function (i) { i.style.width = total ? Math.min(100, audio.currentTime / total * 100) + "%" : "0"; });
      });
      ["play", "pause", "ended"].forEach(function (ev) { audio.addEventListener(ev, paint); });
    }
    if (playing === id && !audio.paused) { audio.pause(); return; }
    if (playing === id && audio.src) { try { await audio.play(); } catch (e) {} return; }
    try {
      var u = await sb.storage.from("parcel-voice").createSignedUrl(n.storage_path, 3600);
      if (u.error || !u.data || !u.data.signedUrl) throw (u.error || new Error("no link"));
      playing = id; audio.src = u.data.signedUrl; await audio.play();
    } catch (e) { alert("Could not play this voice note. It may have been removed after the parcel was returned."); }
    paint();
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-nvvn-play]"); if (!b) return;
    e.preventDefault(); e.stopPropagation(); play(b.getAttribute("data-nvvn-play"));
  }, true);
  window.NVVoice = {
    init: function (fn) {
      getSb = typeof fn === "function" ? fn : getSb; css();
      try {
        new MutationObserver(function (list) {
          for (var i = 0; i < list.length; i++) for (var j = 0; j < list[i].addedNodes.length; j++) {
            var nd = list[i].addedNodes[j];
            if (nd.nodeType === 1 && (nd.hasAttribute("data-nvvn") || (nd.querySelector && nd.querySelector("[data-nvvn]")))) { clearTimeout(fillT); fillT = setTimeout(fill, 60); return; }
          }
        }).observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
      fill();
    },
    refill: function () { cache = {}; asked = {}; fill(); }
  };
})();
