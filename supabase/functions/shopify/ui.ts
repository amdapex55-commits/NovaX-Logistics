// ---------------------------------------------------------------------------
// The page a merchant sees inside Shopify admin.
//
// Served by the edge function rather than from GitHub Pages, because Shopify
// requires every HTML route to return
//   Content-Security-Policy: frame-ancestors https://<shop> https://admin.shopify.com;
// and that value changes per shop. GitHub Pages cannot set response headers at
// all, so a static host is not an option no matter how simple the page is.
//
// The page holds no secrets: it is handed the public API key, and every piece
// of data arrives from /api/*, each of which requires a signed App Bridge
// session token naming the shop. The shop in that token is the only shop a
// request can touch -- nothing here sends a shop parameter.
// ---------------------------------------------------------------------------

export function frameAncestors(shop: string): string {
  return `frame-ancestors https://${shop} https://admin.shopify.com;`;
}

export function embeddedApp(apiKey: string, shop: string, portalUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NovaX Logistics</title>
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${esc(apiKey)}"></script>
<style>
  :root{
    --bg:#f6f6f7; --card:#fff; --ink:#1a1a1a; --muted:#5a5a5a; --faint:#6b6b6b;
    --line:#e6e6e7; --line2:#d9d9da; --warn:#8a6116; --warnbg:#fff6e0;
    --bad:#8e1f0b; --badbg:#fdf0ed; --good:#0b7c4d; --goodbg:#eaf4ee;
    --info:#1f4f8a; --infobg:#eaf1fa;
    --goodln:#9ecdb4; --warnln:#e3c67d; --badln:#e0a99c; --infoln:#a8c3e2;
    /* The button is an inversion PAIR, not --ink used as a surface. --ink flips
       to near-white in dark mode, and white-on-white measured 1.28:1. */
    --btn-bg:#1a1a1a; --btn-fg:#fff; --neutralbg:#eee; --neutral:#555;
    --field:#fff; --fieldline:#b5b5b5; --focus:#1f5eff; --sel:#f2f7ff;
    --s1:6px; --s2:10px; --s3:14px; --s4:18px; --s5:24px; --r1:8px; --r2:12px;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:var(--s4) var(--s3) 48px;background:var(--bg);color:var(--ink);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  /* Grid and flex items default to min-width:auto, which is how a wide child
     used to stretch the whole document to 955px on a 390px phone. */
  .wrap{max-width:1040px;margin:0 auto;display:grid;gap:var(--s3);min-width:0}
  .wrap > *{min-width:0}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--r2);
    padding:var(--s4);min-width:0}
  .hdr{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap}
  .mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#0b7c4d,#14c77b);
    display:grid;place-items:center;color:#fff;font-weight:800;font-size:11px;flex:none}
  h1{font-size:16px;margin:0;letter-spacing:-.01em}
  h2{font-size:11.5px;margin:0 0 var(--s3);color:var(--faint);font-weight:700;
     text-transform:uppercase;letter-spacing:.07em}
  .sub{color:var(--muted);margin:var(--s1) 0 0;max-width:68ch}
  .banner{border-radius:var(--r1);padding:var(--s3) var(--s4);border:1px solid}
  .banner.pending{background:var(--warnbg);border-color:var(--warnln);color:var(--warn)}
  .banner.active{background:var(--goodbg);border-color:var(--goodln);color:var(--good)}
  .banner.bad{background:var(--badbg);border-color:var(--badln);color:var(--bad)}
  .banner.info{background:var(--infobg);border-color:var(--infoln);color:var(--info)}
  .banner strong{display:block;margin-bottom:2px;font-size:14px}
  .banner span{display:block;max-width:74ch}

  /* ---- queue tabs: the counts ARE the navigation ---- */
  .tabs{display:flex;gap:var(--s1);flex-wrap:wrap;margin-bottom:var(--s3)}
  .tab{display:inline-flex;align-items:center;gap:7px;padding:8px 12px;border-radius:999px;
    border:1px solid var(--line2);background:var(--card);color:var(--ink);cursor:pointer;
    font:inherit;font-size:13px;font-weight:600;min-height:38px;white-space:nowrap}
  .tab:hover{background:var(--neutralbg)}
  .tab[aria-selected="true"]{background:var(--btn-bg);color:var(--btn-fg);border-color:var(--btn-bg)}
  .tab .n{font-variant-numeric:tabular-nums;font-weight:700;padding:1px 7px;border-radius:999px;
    background:var(--neutralbg);color:var(--neutral);font-size:12px}
  .tab[aria-selected="true"] .n{background:rgba(255,255,255,.22);color:var(--btn-fg)}
  .tab.urgent .n{background:var(--warnbg);color:var(--warn)}
  .tab.danger .n{background:var(--badbg);color:var(--bad)}
  .tab[aria-selected="true"].urgent .n,.tab[aria-selected="true"].danger .n{
    background:rgba(255,255,255,.22);color:var(--btn-fg)}

  /* ---- one shipment, one row. Same markup on phone and desktop. ---- */
  /* F06: the phone rules named .state, but .state sits inside an unclassified
     wrapper -- the WRAPPER is the grid child. The rules applied to nothing, the
     wrapper took the auto-sized column, and the recipient was squeezed to 38px
     at 390 and to 0px at 320. Explicit areas on the real children. */
  .ship{display:grid;gap:var(--s2);padding:var(--s3) 0;border-bottom:1px solid var(--line);
    grid-template-columns:minmax(140px,1.4fr) minmax(160px,1.3fr) minmax(90px,auto) auto;
    grid-template-areas:"who st money act";align-items:start}
  .ship > .who{grid-area:who} .ship > .st{grid-area:st}
  .ship > .money{grid-area:money} .ship > .act{grid-area:act}
  .ship:last-child{border-bottom:0}
  .ship > *{min-width:0}
  .ship .who{min-width:0}
  .ship .ord{font-weight:650;letter-spacing:-.01em}
  .ship .name{color:var(--muted);font-size:13px;margin-top:1px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ship .awb{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
    color:var(--muted);margin-top:3px}
  .ship .awb a{color:var(--muted)}
  .ship .money{font-variant-numeric:tabular-nums;font-weight:650;text-align:right;white-space:nowrap}
  .ship .money small{display:block;font-weight:400;color:var(--faint);font-size:11.5px}
  .ship .act{display:flex;gap:var(--s1);align-items:flex-start;justify-content:flex-end;flex-wrap:wrap}
  .ship.busy{background:var(--sel)}

  /* ---- shipment state and Shopify sync are DIFFERENT things ---- */
  .state{font-size:13px;min-width:0}
  .state .pill{white-space:normal}
  .state .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;
    font-weight:650;white-space:nowrap}
  .pill.booked{background:var(--goodbg);color:var(--good)}
  .pill.skipped,.pill.cancelled{background:var(--neutralbg);color:var(--neutral)}
  .pill.failed{background:var(--badbg);color:var(--bad)}
  .pill.pending_link,.pill.received,.pill.awaiting_approval{background:var(--warnbg);color:var(--warn)}
  /* Quieter than the shipment state on purpose: a sync problem is a warning
     about Shopify, not a change in where the parcel is. */
  .sync{display:inline-flex;align-items:center;gap:5px;margin-top:5px;font-size:12px;color:var(--muted)}
  .sync .dot{width:7px;height:7px;border-radius:50%;background:var(--warnln);flex:none}
  .sync.bad{color:var(--bad)} .sync.bad .dot{background:var(--bad)}
  .why{color:var(--muted);font-size:12.5px;margin-top:5px;max-width:60ch;line-height:1.45}
  .why b{color:var(--ink);font-weight:600}
  .rowmsg{font-size:12.5px;margin-top:6px}
  .rowmsg.ok{color:var(--good)} .rowmsg.err{color:var(--bad)}
  .rowmsg:empty{display:none}

  /* ---- controls ---- */
  .btn{display:inline-block;background:var(--btn-bg);color:var(--btn-fg);text-decoration:none;
    padding:9px 14px;border-radius:var(--r1);font-weight:650;font-size:13px;
    border:1px solid transparent;cursor:pointer;font-family:inherit;line-height:1.2;min-height:38px}
  .btn.small{padding:7px 11px;font-size:12.5px;min-height:34px}
  .btn.ghost{background:transparent;color:var(--ink);border-color:var(--line2)}
  .btn.ghost:hover{background:var(--neutralbg)}
  .btn.danger{color:var(--bad);border-color:var(--badln);background:transparent}
  .btn[disabled]{opacity:.5;cursor:default}
  :focus-visible{outline:2px solid var(--focus);outline-offset:2px}
  .menu{position:relative}
  .menu > ul{position:absolute;right:0;top:calc(100% + 4px);z-index:20;margin:0;padding:5px;
    list-style:none;background:var(--card);border:1px solid var(--line2);border-radius:var(--r1);
    box-shadow:0 8px 24px rgba(0,0,0,.12);min-width:190px;display:none}
  .menu[open] > ul{display:block}
  .menu li button{display:block;width:100%;text-align:left;background:none;border:0;
    padding:9px 11px;border-radius:6px;font:inherit;font-size:13px;color:var(--ink);cursor:pointer;min-height:38px}
  .menu li button:hover{background:var(--neutralbg)}
  .menu li button.danger{color:var(--bad)}
  .row{display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center}
  label{display:block;font-size:12px;color:var(--muted);margin:0 0 5px}
  input[type=text],input[type=search],select{width:100%;padding:9px 11px;border:1px solid var(--fieldline);
    border-radius:var(--r1);background:var(--field);color:var(--ink);font:inherit;font-size:13px;min-height:38px}
  .check{display:flex;align-items:flex-start;gap:8px;color:var(--ink);font-size:13px;margin:0}
  .check input{width:16px;height:16px;margin:2px 0 0;flex:none}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;
    text-transform:uppercase;font-size:18px;font-weight:700;text-align:center}
  .fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(215px,100%),1fr));gap:var(--s3);min-width:0}
  .fields > *{min-width:0}
  .empty{color:var(--muted);padding:28px var(--s2);text-align:center}
  .empty strong{display:block;color:var(--ink);margin-bottom:3px}
  .note{font-size:12px;color:var(--faint);margin:5px 0 0;line-height:1.45}
  .msg{font-size:13px;line-height:1.45}
  .msg:empty{display:none}
  .msg.ok{color:var(--good)} .msg.err{color:var(--bad)}
  .hide{display:none!important}
  .bar{display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center;margin-bottom:var(--s3)}
  .bar .grow{flex:1;min-width:190px}
  .dim{color:var(--faint);font-size:12px}

  /* ---- money: a strip, not a wall of cards competing with dispatch ---- */
  .money-strip{display:flex;gap:var(--s4);flex-wrap:wrap;align-items:baseline;
    padding:var(--s3) var(--s4);background:var(--card);border:1px solid var(--line);border-radius:var(--r2)}
  .money-strip b{font-variant-numeric:tabular-nums;font-size:15px;font-weight:650}
  .money-strip span{color:var(--muted);font-size:12.5px}
  .money-strip .sep{flex:1}
  /* The default link blue sits at about 2.3:1 on the dark card. */
  .money-strip a{color:var(--info);font-weight:650;text-decoration:none}
  .money-strip a:hover{text-decoration:underline}
  .ship .awb a{text-decoration:none;border-bottom:1px solid var(--line2)}

  /* ---- preview before a chargeable decision ---- */
  .preview{border:1px solid var(--infoln);background:var(--infobg);border-radius:var(--r1);
    padding:var(--s3);margin-top:var(--s2);font-size:13px;color:var(--info)}
  .preview dl{display:grid;grid-template-columns:auto 1fr;gap:3px var(--s3);margin:0 0 var(--s2)}
  .preview dt{color:var(--info);opacity:.75}
  .preview dd{margin:0;color:var(--ink)}
  .preview .fee{font-weight:700}

  details.settings > summary{cursor:pointer;font-size:13px;font-weight:650;list-style:none;
    padding:var(--s2) 0;min-height:38px;display:flex;align-items:center;gap:8px}
  details.settings > summary::-webkit-details-marker{display:none}
  details.settings > summary::before{content:"▸";color:var(--faint)}
  details.settings[open] > summary::before{content:"▾"}
  .dirty{font-size:11.5px;font-weight:700;color:var(--warn);background:var(--warnbg);
    padding:2px 8px;border-radius:999px}

  @media (max-width:760px){
    body{padding:var(--s3) var(--s2) 40px}
    .card{padding:var(--s3)}
    /* A phone gets stacked shipment rows, not a horizontally scrolled table. */
    .ship{grid-template-columns:minmax(0,1fr) auto;
      grid-template-areas:"who money" "st st" "act act";gap:var(--s1) var(--s2)}
    .ship .name{white-space:normal}
    .ship .awb{display:flex;flex-wrap:wrap;gap:4px 10px}
    .btn.small{min-height:40px;padding:10px 13px;font-size:13px}
    .ship .act .btn{flex:1;min-width:120px;text-align:center}
  }
  @media (prefers-color-scheme:dark){
    /* Shopify admin has a dark mode, so this runs for real merchants. Every
       colour used as text or as a border flips with the surface behind it. */
    :root{--bg:#1a1a1a;--card:#242424;--ink:#e3e3e3;--muted:#a8a8a8;--faint:#949494;
          --line:#3a3a3a;--line2:#4a4a4a;
          --goodbg:#12301f;--warnbg:#302713;--badbg:#301613;--infobg:#132233;
          --good:#5fe0a8;--warn:#e8b64c;--bad:#f0a396;--info:#8fbdf0;
          --goodln:#2f6b4c;--warnln:#6b5524;--badln:#6b3228;--infoln:#2a4a6b;
          --btn-bg:#e3e3e3;--btn-fg:#1a1a1a;--neutralbg:#32363a;--neutral:#c2c8ce;
          --field:#1c1c1c;--fieldline:#4a4a4a;--focus:#7aa2ff;--sel:#1e2733}
  }
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="hdr"><span class="mark">NX</span><h1>NovaX Logistics</h1></div>
  </div>

  <div id="status" role="status" aria-live="polite"></div>

  <!-- Connect --------------------------------------------------------- -->
  <div class="card hide" id="connect">
    <h2>Connect your NovaX account</h2>
    <p class="sub">Open the NovaX portal, go to <b>Integrations</b>, and copy the connect code shown there. The code proves you own the account — we never match stores to accounts by email address.</p>
    <div class="fields" style="margin-top:var(--s4)">
      <div>
        <label for="code">Connect code</label>
        <input type="text" id="code" class="code" maxlength="12" autocomplete="off" spellcheck="false" placeholder="ABCD2345">
      </div>
      <div style="align-self:end">
        <button class="btn" id="linkBtn" type="button">Connect this store</button>
      </div>
    </div>
    <div class="msg" id="linkMsg" role="status" aria-live="polite" style="margin-top:var(--s3)"></div>
    <div class="row" style="margin-top:var(--s4)">
      <a class="btn ghost" id="getCode" href="#" target="_blank" rel="noopener">Get my code</a>
      <a class="btn ghost" id="signup" href="#" target="_blank" rel="noopener">I don't have a NovaX account</a>
    </div>
  </div>

  <!-- ORDERS: the work surface, first on the page --------------------- -->
  <div class="card hide" id="ordersCard">
    <div class="tabs" id="tabs" role="tablist"></div>

    <div class="bar">
      <input type="search" id="q" class="grow" placeholder="Search order number, AWB or recipient" autocomplete="off">
      <button class="btn small" id="approveAll" type="button">Approve all</button>
      <button class="btn small ghost" id="pickupBtn" type="button">Request a pickup</button>
      <button class="btn small ghost" id="syncBtn" type="button">Check for missing orders</button>
    </div>
    <div class="msg" id="bulkMsg" role="status" aria-live="polite" style="margin-bottom:var(--s2)"></div>
    <div class="hide" id="staleNote" role="status" aria-live="polite" style="margin-bottom:var(--s3)"></div>

    <div id="orders"><p class="empty">Loading…</p></div>

    <div class="bar" style="margin:var(--s3) 0 0">
      <button class="btn small ghost" id="prevPage" type="button">Newer</button>
      <button class="btn small ghost" id="nextPage" type="button">Older</button>
      <span class="dim" id="pageInfo"></span>
      <span class="sep" style="flex:1"></span>
      <span class="dim" id="freshness"></span>
    </div>
  </div>

  <!-- Money: compact, scoped, and out of the way ---------------------- -->
  <div class="money-strip hide" id="money"></div>

  <!-- Settings: collapsed ---------------------------------------------- -->
  <div class="card hide" id="settings">
    <details class="settings" id="settingsBox">
      <summary>Booking settings <span class="dirty hide" id="dirtyFlag">unsaved</span></summary>
      <div class="fields" style="margin-top:var(--s3)">
        <div>
          <label for="mode">Booking</label>
          <select id="mode">
            <option value="auto">Book matching orders automatically</option>
            <option value="manual">Hold every order for approval</option>
          </select>
        </div>
        <div>
          <label for="tags">Never book orders tagged</label>
          <input type="text" id="tags" placeholder="pickup, wholesale" autocomplete="off">
          <p class="note">A hard exclusion. These are skipped, not held, and Approve all cannot release them.</p>
        </div>
        <div>
          <label for="pay">Only these payment methods</label>
          <input type="text" id="pay" placeholder="cod, easypaisa — blank means any" autocomplete="off">
        </div>
        <div>
          <label for="ship">Only these shipping methods</label>
          <input type="text" id="ship" placeholder="Standard — blank means any" autocomplete="off">
        </div>
        <div>
          <label for="locs">Only these POS location IDs</label>
          <input type="text" id="locs" placeholder="blank means any" autocomplete="off">
          <p class="note">Online-store orders carry no location, so this only filters POS and draft orders.</p>
        </div>
        <div style="align-self:end">
          <label class="check" for="confirmed"><input type="checkbox" id="confirmed"> <span>Also book orders already paid online</span></label>
          <p class="note">Off by default: NovaX is a cash-on-delivery courier, so a prepaid parcel is carried with nothing to collect.</p>
        </div>
      </div>
      <div class="row" style="margin-top:var(--s4)">
        <button class="btn" id="saveBtn" type="button">Save</button>
        <span class="msg" id="setMsg" role="status" aria-live="polite"></span>
      </div>
    </details>
  </div>

  <div class="card">
    <h2>NovaX portal</h2>
    <p class="sub" style="margin-bottom:var(--s3)">Invoices, returns, bulk booking and COD settlement. Anyone with access to this app in your Shopify admin can book, approve and cancel — use Shopify's own staff permissions to control who opens it.</p>
    <a class="btn ghost" id="portal" href="${esc(portalUrl)}" target="_blank" rel="noopener">Open NovaX portal</a>
  </div>
</div>
<script>
(function(){
  var SHOP = ${JSON.stringify(shop)};
  var PORTAL = ${JSON.stringify(portalUrl)};
  var state = null, page = 0, PAGE = 25, tab = "all";
  var lastGoodOrders = null, lastGoodKey = null, lastGoodAt = null, lastLoaded = null, inFlight = null;
  function viewKey(){ return tab + "|" + page + "|" + (el("q") ? el("q").value.trim() : ""); }

  function el(id){ return document.getElementById(id); }
  function show(id, on){ var n = el(id); if (n) n.classList[on ? "remove" : "add"]("hide"); }
  function h(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function money(n){
    if (n == null || isNaN(n)) return "—";
    return "Rs " + Number(n).toLocaleString("en-PK", { maximumFractionDigits: 0 });
  }
  function list(s){ return String(s||"").split(",").map(function(x){return x.trim();}).filter(Boolean); }

  // NOTE: no alert(), confirm() or prompt() anywhere in this page. Chrome blocks
  // all three inside a cross-origin iframe, and this page only ever runs as one.
  // They fail silently, so a button that uses them is simply dead.

  // App Bridge mints a fresh, short-lived session token per call. Asking for a
  // new one every time is deliberate: caching it means the first request after
  // it expires fails, which reads to a merchant as "the app is broken".
  async function token(){
    if (window.shopify && window.shopify.idToken) return await window.shopify.idToken();
    throw new Error("App Bridge not ready");
  }

  // Anchored to the app's own path: served at /shopify/app/ the old relative
  // paths resolved to /shopify/app/state and every call 404'd.
  var API_BASE = location.pathname.replace(/\\/app\\/?$/, "") || "/shopify";

  async function api(path, body){
    var init = { headers: { Authorization: "Bearer " + (await token()) } };
    if (body !== undefined) {
      init.method = "POST";
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var res = await fetch(API_BASE + "/" + path.replace(/^\\//, ""), init);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }

  function say(id, text, ok){
    var n = el(id); if (!n) return;
    n.textContent = text || "";
    n.className = (n.classList.contains("rowmsg") ? "rowmsg " : "msg ") + (text ? (ok ? "ok" : "err") : "");
    n.setAttribute("aria-live", text && ok === false ? "assertive" : "polite");
  }

  // ---- shipment state, kept separate from Shopify sync --------------------

  var MOVING = ["Collected by rider","Arrived at warehouse","Parcel now in transit",
                "Parcel received at destination","Parcel out for delivery"];
  var OPEN_PARCEL = ["New booked"].concat(MOVING.slice(0,3));

  function stateCell(r){
    var label = String(r.status || "").replace(/_/g, " ");
    // The shipment's own state wins the visual weight; where the parcel is
    // matters more than whether Shopify has been told.
    var main = r.parcel_status
      ? '<span class="pill ' + h(r.status) + '">' + h(r.parcel_status) + '</span>'
      : '<span class="pill ' + h(r.status) + '">' + h(label) + '</span>';

    var extra = "";
    if (r.recall_requested) extra += '<span class="sync bad"><span class="dot"></span>Recall requested</span>';
    else if (r.fulfill_state === "failed") extra += '<span class="sync bad"><span class="dot"></span>Tracking not sent to Shopify</span>';
    else if (r.fulfill_state === "ready") extra += '<span class="sync"><span class="dot"></span>Tracking sync pending</span>';

    var why = "";
    if (r.status === "awaiting_approval" && r.hold_reason) why = r.hold_reason;
    else if (r.fulfill_state === "failed" && r.fulfill_error) why = "Shopify was not updated: " + r.fulfill_error;
    else if ((r.status === "skipped" || r.status === "failed" || r.status === "cancelled") && r.error) why = r.error;

    return '<div class="state">' + main + extra +
      (why ? '<div class="why">' + h(why) + '</div>' : "") +
      '<div class="rowmsg" id="m-' + h(r.shopify_order_id) + '"></div></div>';
  }

  // One main action, everything else behind a menu.
  function actions(r){
    var id = h(r.shopify_order_id);
    var openParcel = !r.parcel_status || OPEN_PARCEL.indexOf(r.parcel_status) >= 0;
    var movedOn = r.parcel_status && MOVING.indexOf(r.parcel_status) >= 0;
    var main = "", more = [];

    if (r.status === "awaiting_approval") {
      main = '<button class="btn small" data-act="preview" data-id="' + id + '">Review &amp; book</button>';
      more.push(['reject', 'Decline this order', 'danger']);
    } else if (r.fulfill_state === "failed") {
      main = '<button class="btn small" data-act="resync" data-id="' + id + '">Retry sync</button>';
    } else if (r.status === "skipped" || r.status === "failed") {
      main = '<button class="btn small" data-act="recheck" data-id="' + id + '">Try again</button>';
    } else if (r.awb) {
      main = '<a class="btn small ghost" target="_blank" rel="noopener" href="' + h(r.tracking_url) + '">Track</a>';
    }

    if (r.awb) more.push(['label', 'Print label', '']);
    if (r.status === "booked" && openParcel && !r.recall_requested) {
      more.push(['splitPreview', 'Add another box', '']);
    }
    if (r.status === "awaiting_approval" || (r.status === "booked" && !r.recall_requested && openParcel && !movedOn)) {
      more.push(['cancel', 'Cancel this shipment', 'danger']);
    } else if (r.status === "booked" && movedOn && !r.recall_requested) {
      // After pickup a rider is carrying it: the honest word is recall.
      more.push(['cancel', 'Request a recall', 'danger']);
    }
    if (r.awb || r.status === "failed") more.push(['ticket', 'Report a problem', '']);

    var menu = more.length
      ? '<details class="menu"><summary class="btn small ghost" role="button">More</summary><ul>' +
        more.map(function(m){
          return '<li><button type="button" class="' + m[2] + '" data-act="' + m[0] + '" data-id="' + id + '">' + h(m[1]) + '</button></li>';
        }).join("") + '</ul></details>'
      : "";
    return '<div class="act">' + main + menu + '</div>';
  }

  function renderOrders(rows, degraded){
    var box = el("orders");
    // F10: every load replaced innerHTML, so an open support form or review
    // panel -- and whatever the merchant had typed into it -- vanished under
    // them. Never redraw over work in progress.
    //
    // G08/G09: the deferral kept only the rows. Switching queues with a preview
    // open left the OLD list on screen under the NEW tab's label, and a
    // degraded read was deferred without its degraded flag -- so closing the
    // preview drew an empty list as healthy data and cached it as a success.
    if (box.querySelector(".ticket, .preview")) {
      pending = { rows: rows, degraded: Boolean(degraded), key: viewKey() };
      return;
    }
    // An outage is not an empty store.
    // F11: the warning was written and then immediately replaced by the cached
    // rows, so an outage looked like ordinary data. The notice stays ABOVE the
    // stale rows, and the cache is keyed to the view it was read for.
    var stale = el("staleNote");
    if (degraded) {
      var cacheOk = lastGoodOrders && lastGoodKey === viewKey();
      stale.className = "banner bad";
      stale.innerHTML = '<strong>Orders could not be loaded</strong><span>This is a problem on our side, not an empty store.' +
        (cacheOk ? ' The list below was last read at ' + h(lastGoodAt) + ' and may be out of date.'
                 : ' Press Check for missing orders to try again.') + '</span>';
      if (!cacheOk) { box.innerHTML = ""; return; }
      rows = lastGoodOrders;
    } else {
      stale.className = "hide"; stale.innerHTML = "";
      if (rows) {
        lastGoodOrders = rows; lastGoodKey = viewKey();
        lastGoodAt = new Date().toLocaleTimeString("en-PK",
          { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" }) + " PKT";
      }
    }

    if (!rows || !rows.length) {
      box.innerHTML = '<div class="empty"><strong>' +
        (el("q").value.trim() ? "No matching orders"
          : (tab === "all" ? "No orders yet" : "Nothing in this queue")) + '</strong>' +
        (el("q").value.trim() ? "Nothing here matches “" + h(el("q").value.trim()) + "”."
          : (tab === "all" ? "The next order this store receives appears here, with its AWB."
                           : "Good — there is nothing to deal with here.")) + '</div>';
    } else {
      box.innerHTML = rows.map(function(r){
        var where = [r.consignee, r.city].filter(Boolean).join(" · ");
        var awbs = [r.awb].concat(r.extra_awbs || []).filter(Boolean);
        return '<article class="ship" data-row="' + h(r.shopify_order_id) + '">' +
          '<div class="who">' +
            '<div class="ord">' + h(r.order_name || ("#" + r.shopify_order_id)) + '</div>' +
            (where ? '<div class="name">' + h(where) + '</div>' : '') +
            (awbs.length ? '<div class="awb">' + awbs.map(function(a){
                return '<a href="https://novaxlogistics.com/tracking.html?awb=' + encodeURIComponent(a) +
                       '" target="_blank" rel="noopener">' + h(a) + '</a>'; }).join(" · ") + '</div>' : '') +
          '</div>' +
          '<div class="st">' + stateCell(r) + '</div>' +
          '<div class="money">' + money(r.cod_amount) +
            (r.fee != null ? '<small>fee ' + money(r.fee) + '</small>' : '') +
          '</div>' +
          actions(r) +
        '</article>';
      }).join("");
    }

    var total = (rows && rows[0] && rows[0].total_count) || 0;
    var from = page * PAGE + 1, to = page * PAGE + (rows ? rows.length : 0);
    el("pageInfo").textContent = total ? ("Showing " + from + "–" + to + " of " + total) : "";
    el("prevPage").disabled = page === 0;
    el("nextPage").disabled = !total || (page + 1) * PAGE >= total;
  }

  function renderTabs(s){
    var defs = [
      ["held",   "Needs approval", s.awaiting_count || 0,   "urgent"],
      ["failed", "Booking failed", s.failed_count || 0,     "danger"],
      ["sync",   "Sync failed",    s.sync_failed_count || 0,"danger"],
      ["moving", "Moving",         s.moving_count || 0,     ""],
      ["all",    "All",            s.total_orders || 0,     ""]
    ];
    el("tabs").innerHTML = defs.map(function(d){
      return '<button class="tab ' + d[3] + '" role="tab" data-tab="' + d[0] + '"' +
        ' aria-selected="' + (tab === d[0] ? "true" : "false") + '">' +
        h(d[1]) + '<span class="n">' + d[2] + '</span></button>';
    }).join("");
    el("approveAll").classList[s.awaiting_count ? "remove" : "add"]("hide");
  }

  function renderStatus(s){
    var box = el("status");
    if (!s) {
      box.innerHTML = '<div class="banner bad"><strong>This store is not registered with NovaX</strong>' +
        '<span>Uninstall and reinstall the app. If it happens again, message NovaX on WhatsApp 0312 3922558.</span></div>';
      show("connect", false); show("settings", false); show("ordersCard", false); show("money", false);
      return;
    }
    if (s.status === "blocked" || s.status === "uninstalled") {
      var d = s.status === "blocked"
        ? ["This store is blocked", "NovaX support has paused this connection. Nothing is being booked. Message 0312 3922558."]
        : ["The app is no longer installed", "Reinstall NovaX from your Shopify admin to start booking again. Nothing has been lost."];
      box.innerHTML = '<div class="banner bad"><strong>' + h(d[0]) + '</strong><span>' + h(d[1]) + '</span></div>';
      show("connect", false); show("settings", false); show("ordersCard", true); show("money", false);
      return;
    }
    if (!s.linked) {
      var n = s.pending_count || 0;
      box.innerHTML = '<div class="banner pending"><strong>One step left: connect your NovaX account</strong>' +
        '<span>Nothing is booked until you do.' +
        (n ? ' <b>' + n + '</b> order' + (n === 1 ? '' : 's') + ' received so far ' + (n === 1 ? 'is' : 'are') +
             ' being held and will be booked the moment you connect — nothing is lost.' : '') +
        '</span></div>';
      show("connect", true); show("settings", false); show("ordersCard", n > 0); show("money", false);
      return;
    }

    var trouble = [];
    if (s.webhooks_ok === false) trouble.push("Shopify is not sending us this store's orders — reinstall the app");
    if (s.last_error) trouble.push(s.last_error);
    box.innerHTML = trouble.length
      ? '<div class="banner bad"><strong>Connected, but something needs fixing</strong><span>' + h(trouble.join(". ")) + '</span></div>'
      : '<div class="banner active"><strong>Connected — ' + h(s.client_name || "your NovaX account") + '</strong>' +
        '<span>' + (s.booking_mode === "manual" ? "Every order is held for your approval."
                                                : "Matching orders are booked automatically.") + '</span></div>';
    show("connect", false); show("settings", true); show("ordersCard", true); show("money", true);
    el("pickupBtn").classList.remove("hide");
    el("syncBtn").classList.remove("hide");
  }

  function renderMoney(s, w){
    if (!s || !s.linked) return;
    el("money").innerHTML =
      '<span><b>' + h(s.orders_booked || 0) + '</b> <span>orders booked from this store</span></span>' +
      '<span class="sep"></span>' +
      '<span><b>' + money(w && w.available_balance) + '</b> <span>COD available</span></span>' +
      '<span><b>' + money(w && w.pending_payout) + '</b> <span>payout pending</span></span>' +
      '<span><a href="' + h((s.portal_url || PORTAL)) + '?tab=money" target="_blank" rel="noopener">Settlement →</a></span>' +
      '<span class="dim" style="flex-basis:100%">Money is for your whole NovaX account, including other stores and parcels booked in the portal.</span>';
  }

  var settingsDirty = false;
  ["mode","confirmed","tags","pay","ship","locs"].forEach(function(id){
    var n = el(id); if (!n) return;
    ["input","change"].forEach(function(ev){ n.addEventListener(ev, function(){
      settingsDirty = true; el("dirtyFlag").classList.remove("hide"); }); });
  });

  function renderSettings(s){
    if (!s || !s.linked || settingsDirty) return;
    el("mode").value = s.booking_mode === "manual" ? "manual" : "auto";
    el("confirmed").checked = Boolean(s.rule_require_confirmed);
    el("tags").value = (s.rule_exclude_tags  || []).join(", ");
    el("pay").value  = (s.rule_payment_modes || []).join(", ");
    el("ship").value = (s.rule_shipping_names|| []).join(", ");
    el("locs").value = (s.rule_location_ids  || []).join(", ");
  }

  // ---- load ---------------------------------------------------------------

  async function load(){
    var q = el("q") ? el("q").value.trim() : "";
    // Keep where the merchant was standing.
    var scroll = window.scrollY;
    var req = api("state?limit=" + PAGE + "&offset=" + (page * PAGE) +
      "&filter=" + encodeURIComponent(tab) + "&q=" + encodeURIComponent(q));
    inFlight = req;
    var s = await req;
    if (inFlight !== req) return;   // a newer request already answered
    state = s;
    lastLoaded = new Date();

    renderStatus(state.shop);
    if (state.shop) { renderTabs(state.shop); renderMoney(state.shop, state.wallet); renderSettings(state.shop); }
    renderOrders(state.orders, state.degraded && state.degraded.orders);

    var portal = (state.shop && state.shop.portal_url) || PORTAL;
    el("portal").href = portal;
    el("getCode").href = portal + "?tab=integrations";
    el("signup").href  = portal.replace("client.html", "index.html") + "#signup";
    // F11: this said "Updated" even when the orders read had failed.
    el("freshness").textContent = (state.degraded && state.degraded.orders)
      ? ("Orders last read " + (lastGoodAt || "—"))
      : ("Updated " + lastLoaded.toLocaleTimeString("en-PK",
          { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" }) + " PKT");
    window.scrollTo(0, scroll);
  }

  var pending = null;
  function redrawIfIdle(){
    if (!pending || el("orders").querySelector(".ticket, .preview")) return;
    var p = pending; pending = null;
    // If the merchant changed tab, page or search while the panel was open, the
    // deferred rows belong to a view they are no longer looking at. Re-read.
    if (p.key !== viewKey()) { load().catch(function(){}); return; }
    renderOrders(p.rows, p.degraded);
  }

  var poll = null;
  function startPolling(){
    if (poll) clearInterval(poll);
    poll = setInterval(function(){
      if (document.visibilityState === "visible" && !document.querySelector(".ship.busy") &&
          !el("orders").querySelector(".ticket, .preview")) {
        load().catch(function(){});
      }
    }, 60000);
  }
  document.addEventListener("visibilitychange", function(){
    // Same guard as the poll: coming back to the tab must not wipe a draft.
    if (document.visibilityState === "visible" && !document.querySelector(".ship.busy") &&
        !el("orders").querySelector(".ticket, .preview")) {
      load().catch(function(){});
    }
  });

  // ---- tabs, search, paging ----------------------------------------------

  el("tabs").addEventListener("click", function(ev){
    var b = ev.target.closest("[data-tab]"); if (!b) return;
    tab = b.getAttribute("data-tab"); page = 0;
    load().catch(function(e){ say("bulkMsg", String(e.message || e), false); });
  });
  var searchTimer = null;
  el("q").addEventListener("input", function(){
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ page = 0; load().catch(function(){}); }, 350);
  });
  el("prevPage").addEventListener("click", function(){ if (page > 0) { page--; load().catch(function(){}); } });
  el("nextPage").addEventListener("click", function(){ page++; load().catch(function(){}); });

  // ---- per-row work -------------------------------------------------------

  function rowOf(id){ return document.querySelector('[data-row="' + CSS.escape(id) + '"]'); }
  function rowSay(id, text, ok){
    var n = document.getElementById("m-" + id);
    if (n) { n.textContent = text || ""; n.className = "rowmsg " + (text ? (ok ? "ok" : "err") : ""); }
  }
  // Everything a row can open, closed in one place, plus the confirmation
  // state that belongs to it. G10: Cancel removed the panel and left
  // splitConfirm set, so reopening Add another box and pressing Book once
  // silently sent confirm_additional:true -- bypassing the very warning the
  // merchant had just cancelled.
  function closePanels(id){
    var row = rowOf(id);
    if (row) row.querySelectorAll(".preview, .ticket").forEach(function(n){ n.remove(); });
    delete splitConfirm[id];
    if (ticketFor === id) ticketFor = null;
    redrawIfIdle();
  }

  function busy(id, on){
    var row = rowOf(id); if (!row) return;
    row.classList[on ? "add" : "remove"]("busy");
    row.querySelectorAll("button, .btn").forEach(function(b){ b.disabled = on; });
  }

  function orderById(id){
    return (state && state.orders || []).filter(function(o){ return String(o.shopify_order_id) === String(id); })[0];
  }

  // A preview before anything chargeable: who, where, how much, how heavy, and
  // the actual fee -- not "another delivery fee".
  async function showPreview(id, kind){
    var o = orderById(id); if (!o) return;
    var row = rowOf(id); if (!row) return;
    if (row.querySelector(".preview")) return;

    var weight = kind === "split" ? "0.5 kg" : (o.weight || "0.8 kg");
    var weightNote = kind === "split" ? "" : (o.weight_known ? "" : " (estimated)");
    var cod = kind === "split" ? 0 : o.cod_amount;
    var box = document.createElement("div");
    box.className = "preview";
    box.innerHTML =
      '<dl>' +
        '<dt>To</dt><dd>' + h([o.consignee, o.address, o.city].filter(Boolean).join(", ") || "address on the order") + '</dd>' +
        '<dt>Collect</dt><dd>' + money(cod) + (kind === "split" ? ' <span class="dim">(collected once, on the first box)</span>' : '') + '</dd>' +
        '<dt>Weight</dt><dd>' + h(weight) + h(weightNote) + '</dd>' +
        '<dt>Delivery fee</dt><dd class="fee" data-fee>checking…</dd>' +
      '</dl>' +
      '<div class="row">' +
        '<button class="btn small" data-act="' + (kind === "split" ? "split" : "approve") + '" data-id="' + h(id) + '">' +
          (kind === "split" ? "Book this extra box" : "Book this shipment") + '</button>' +
        '<button class="btn small ghost" data-act="closePreview" data-id="' + h(id) + '">Cancel</button>' +
      '</div>';
    row.querySelector(".state").appendChild(box);

    try {
      var q = await api("api/quote", { city: o.city || "", weight: weight });
      box.querySelector("[data-fee]").textContent = q && q.fee != null
        ? money(q.fee) + (kind === "split" ? " for this extra box" : "")
        : "quoted at pickup";
    } catch { box.querySelector("[data-fee]").textContent = "quoted at pickup"; }
  }

  el("orders").addEventListener("click", async function(ev){
    var b = ev.target.closest("[data-act]"); if (!b) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id");
    var menu = b.closest("details.menu"); if (menu) menu.open = false;

    if (act === "preview")       return showPreview(id, "book");
    if (act === "splitPreview")  return showPreview(id, "split");
    if (act === "closePreview")  { closePanels(id); return; }
    if (act === "label") {
      var o = orderById(id);
      window.open((state.shop.portal_url || PORTAL) + "?awb=" + encodeURIComponent(o && o.awb || ""), "_blank", "noopener");
      return;
    }
    if (act === "ticket") { ticketFor = id; openTicket(id); return; }

    busy(id, true);
    rowSay(id, act === "approve" ? "Booking…" : "Working…", true);
    try {
      var r;
      if (act === "approve")      r = await api("api/order/decide", { order_id: id, decision: "approve" });
      else if (act === "reject")  r = await api("api/order/decide", { order_id: id, decision: "reject" });
      else if (act === "cancel")  r = await api("api/order/cancel", { order_id: id });
      else if (act === "resync")  r = await api("api/order/resync", { order_id: id });
      else if (act === "recheck") r = await api("api/order/recheck", { order_id: id });
      else if (act === "split") {
        // The same intent must never book two boxes.
        splitKeys[id] = splitKeys[id] || (id + ":" + Date.now() + ":" + Math.random().toString(36).slice(2, 8));
        r = await api("api/order/split", { order_id: id, key: splitKeys[id],
          confirm_additional: Boolean(splitConfirm[id]) });
        // The server asks once when it suspects a retry rather than a new box.
        if (r && r.needs_confirm) {
          // Ask on the button, not behind it.
          splitConfirm[id] = true;
          var again = rowOf(id) && rowOf(id).querySelector("[data-act='split']");
          if (again) again.textContent = "Yes, book another box";
        }
        if (r && r.ok) { delete splitKeys[id]; delete splitConfirm[id]; }
      }

      rowSay(id, (r && r.message) || "", Boolean(r && r.ok));
      // G03: a successful Book left its preview open, and renderOrders refuses
      // to redraw while a preview exists -- so the row stayed disabled, still
      // saying "awaiting approval", and polling refused to run. Only a full
      // reload recovered it. A finished action closes what it opened.
      closePanels(id);
      if (r && r.ok) {
        setTimeout(function(){
          load().catch(function(e){
            busy(id, false);
            rowSay(id, ((r && r.message) || "Done") + " — but the screen could not refresh: " + String(e.message || e), false);
          });
        }, (act === "approve" || act === "split" || act === "recheck") ? 1800 : 500);
      } else busy(id, false);
    } catch (e) {
      busy(id, false);
      rowSay(id, "Could not reach NovaX: " + String(e.message || e), false);
    }
  });

  // ---- support ticket, scoped to one order --------------------------------

  var ticketFor = null, splitKeys = {}, splitConfirm = {};
  function openTicket(id){
    var row = rowOf(id); if (!row) return;
    if (row.querySelector(".ticket")) return;
    var o = orderById(id);
    var box = document.createElement("div");
    box.className = "preview ticket";
    box.innerHTML = '<label for="tb-' + h(id) + '">What is wrong with ' + h(o && o.order_name || ("#" + id)) + '?</label>' +
      '<input type="text" id="tb-' + h(id) + '" maxlength="500" placeholder="The buyer says the address is wrong">' +
      '<div class="row" style="margin-top:var(--s2)">' +
        '<button class="btn small" data-send="' + h(id) + '">Send to NovaX</button>' +
        '<button class="btn small ghost" data-act="closeTicket" data-id="' + h(id) + '">Cancel</button>' +
      '</div>';
    row.querySelector(".state").appendChild(box);
    box.querySelector("input").focus();
    box.addEventListener("click", async function(ev){
      var c = ev.target.closest("[data-act='closeTicket']");
      if (c) { closePanels(id); return; }
      var sBtn = ev.target.closest("[data-send]");
      if (!sBtn) return;
      var body = box.querySelector("input").value.trim();
      if (!body) { rowSay(id, "Write what the problem is first.", false); return; }
      sBtn.disabled = true;
      try {
        var r = await api("api/ticket", { order_id: id, body: body });
        rowSay(id, r.message || "", Boolean(r.ok));
        if (r.ok) closePanels(id);
      } catch (e) { rowSay(id, String(e.message || e), false); }
      finally { sBtn.disabled = false; }
    });
  }

  // ---- connect, settings, bulk -------------------------------------------

  el("linkBtn").addEventListener("click", async function(){
    var btn = this, code = el("code").value.trim();
    if (!code) { say("linkMsg", "Enter the code from your NovaX portal.", false); return; }
    btn.disabled = true; say("linkMsg", "Connecting…", true);
    try {
      var r = await api("api/link", { code: code });
      say("linkMsg", r.message || (r.ok ? "Connected." : "Could not connect."), Boolean(r.ok));
      if (r.ok) await load();
    } catch (e) { say("linkMsg", "Could not reach NovaX: " + String(e.message || e), false); }
    finally { btn.disabled = false; }
  });

  el("saveBtn").addEventListener("click", async function(){
    var btn = this;
    var fields = ["mode","confirmed","tags","pay","ship","locs"];
    var snap = function(){ return fields.map(function(id){
      var n = el(id); return n.type === "checkbox" ? String(n.checked) : n.value; }).join("\u0000"); };
    var before = snap();
    btn.disabled = true; say("setMsg", "Saving…", true);
    try {
      var r = await api("api/settings", {
        booking_mode: el("mode").value,
        require_confirmed: el("confirmed").checked,
        exclude_tags: list(el("tags").value),
        payment_modes: list(el("pay").value),
        shipping_names: list(el("ship").value),
        location_ids: list(el("locs").value)
      });
      if (r.ok && snap() !== before) {
        say("setMsg", "Saved — but you changed something while it was saving, so your newer edits are still unsaved. Press Save again.", false);
        return;
      }
      say("setMsg", r.message || "Saved.", Boolean(r.ok));
      if (r.ok) { settingsDirty = false; el("dirtyFlag").classList.add("hide"); await load(); }
    } catch (e) { say("setMsg", "Could not save: " + String(e.message || e), false); }
    finally { btn.disabled = false; }
  });

  var approveArmed = false;
  el("approveAll").addEventListener("click", async function(){
    var btn = this;
    var n = (state && state.shop && state.shop.awaiting_count) || 0;
    if (!approveArmed) {
      approveArmed = true;
      var held = (state && state.orders || []).filter(function(o){ return o.status === "awaiting_approval"; });
      var total = held.reduce(function(a, o){ return a + (Number(o.cod_amount) || 0); }, 0);
      say("bulkMsg", "This books " + n + " held order" + (n === 1 ? "" : "s") +
        (total ? ", " + money(total) + " of COD" : "") + ", each with its own delivery fee. " +
        "Orders you excluded by tag are NOT included. Press again to confirm.", false);
      btn.textContent = "Confirm — book all " + n;
      setTimeout(function(){
        if (approveArmed) { approveArmed = false; say("bulkMsg", ""); btn.textContent = "Approve all"; }
      }, 8000);
      return;
    }
    approveArmed = false; btn.textContent = "Approve all";
    btn.disabled = true; say("bulkMsg", "Approving…", true);
    try {
      var r = await api("api/approve-all", {});
      say("bulkMsg", r.message || "", Boolean(r.ok));
      setTimeout(function(){ load().catch(function(e){
        say("bulkMsg", (r.message || "Done") + " — refresh failed: " + String(e.message || e), false); }); }, 2000);
    } catch (e) { say("bulkMsg", String(e.message || e), false); }
    finally { btn.disabled = false; }
  });

  el("pickupBtn").addEventListener("click", async function(){
    var btn = this; btn.disabled = true; say("bulkMsg", "Requesting…", true);
    try {
      var r = await api("api/pickup", { note: "Requested from Shopify" });
      say("bulkMsg", r.message || "", Boolean(r.ok));
    } catch (e) { say("bulkMsg", String(e.message || e), false); }
    finally { btn.disabled = false; }
  });

  el("syncBtn").addEventListener("click", async function(){
    var btn = this; btn.disabled = true; say("bulkMsg", "Asking Shopify for the last 48 hours…", true);
    try {
      var r = await api("api/reconcile", {});
      say("bulkMsg", r.message || "", Boolean(r.ok));
      if (r.discovered) setTimeout(function(){ load().catch(function(){}); }, 1500);
    } catch (e) { say("bulkMsg", String(e.message || e), false); }
    finally { btn.disabled = false; }
  });

  (async function(){
    try {
      await load();
      startPolling();
    } catch (e) {
      el("status").innerHTML = '<div class="banner bad"><strong>Could not load</strong><span>' +
        h(String(e.message || e)) + ' — reload the page, and message NovaX on WhatsApp 0312 3922558 if it keeps happening.</span></div>';
      el("orders").innerHTML = "";
    }
  })();
})();
</script>
</body>
</html>
`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
