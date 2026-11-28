/* Back button inside the NovaX app (28 Nov 2026).
 *
 * An iPhone app has no browser back button, so a page opened inside the app
 * (privacy, terms, support, account deletion, password reset) was a dead end.
 * Inside the app only, this adds a round Back button at the top left: it goes
 * back if there is somewhere to go, otherwise to the app's start page.
 * Pages opened in the in-app browser (with Done) are not "inside the app"
 * and get nothing.
 */
(function () {
  try {
    var C = window.Capacitor, app = !!(C && C.isNativePlatform && C.isNativePlatform());
    if (!app) { try { app = sessionStorage.getItem("nvApp") === "1"; } catch (e) {} }
    if (!app || window.top !== window.self) return;
    function add() {
      if (document.getElementById("nvAppBack")) return;
      var st = document.createElement("style");
      st.textContent = "#nvAppBack{position:fixed;top:calc(env(safe-area-inset-top) + 10px);left:10px;z-index:2147483000;width:44px;height:44px;" +
        "display:flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:rgba(255,255,255,.94);color:#0d1a13;" +
        "box-shadow:0 2px 10px rgba(0,0,0,.18);cursor:pointer;-webkit-tap-highlight-color:transparent}" +
        "#nvAppBack:active{transform:scale(.94)}#nvAppBack svg{width:22px;height:22px}" +
        "body{padding-top:max(env(safe-area-inset-top), 0px)}";
      document.head.appendChild(st);
      var b = document.createElement("button");
      b.type = "button"; b.id = "nvAppBack"; b.setAttribute("aria-label", "Back");
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
      b.onclick = function () {
        if (history.length > 1 && document.referrer && document.referrer.indexOf(location.origin) === 0) { history.back(); return; }
        var signed = false; try { signed = !!localStorage.getItem("novaxSession"); } catch (e) {}
        location.href = signed ? "client.html?source=app" : "index.html?source=app";
      };
      document.body.appendChild(b);
    }
    if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
  } catch (e) {}
})();
