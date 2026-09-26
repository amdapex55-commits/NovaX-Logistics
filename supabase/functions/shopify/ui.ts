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
    --bg:#f6f6f7; --card:#fff; --ink:#1a1a1a; --muted:#616161; --faint:#8a8a8a;
    --line:#e3e3e3; --warn:#8a6116; --warnbg:#fff6e0;
    --bad:#8e1f0b; --badbg:#fdf0ed; --good:#0b7c4d; --goodbg:#eaf4ee;
    --info:#1f4f8a; --infobg:#eaf1fa;
    --goodln:#9ecdb4; --warnln:#e3c67d; --badln:#e0a99c; --infoln:#a8c3e2;
    /* The button is an inversion PAIR, not --ink used as a surface. --ink
       flips to near-white in dark mode, and white-on-white measured 1.28:1. */
    --btn-bg:#1a1a1a; --btn-fg:#fff; --neutralbg:#eee; --neutral:#555;
    --field:#fff; --fieldline:#b5b5b5; --focus:#1f5eff;
    --s1:6px; --s2:10px; --s3:14px; --s4:18px; --s5:24px;
    --r1:8px; --r2:12px;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:var(--s5) var(--s4) 40px;background:var(--bg);color:var(--ink);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:940px;margin:0 auto;display:grid;gap:var(--s3)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--r2);padding:var(--s4) var(--s5)}
  .hdr{display:flex;align-items:center;gap:var(--s2)}
  .mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#0b7c4d,#14c77b);
    display:grid;place-items:center;color:#fff;font-weight:800;font-size:12px;letter-spacing:.02em;flex:none}
  h1{font-size:17px;margin:0;letter-spacing:-.01em}
  h2{font-size:11.5px;margin:0 0 var(--s3);color:var(--faint);font-weight:700;
     text-transform:uppercase;letter-spacing:.07em}
  .sub{color:var(--muted);margin:var(--s2) 0 0;max-width:68ch}
  .banner{border-radius:var(--r1);padding:var(--s3) var(--s4);border:1px solid}
  .banner.pending{background:var(--warnbg);border-color:var(--warnln);color:var(--warn)}
  .banner.active{background:var(--goodbg);border-color:var(--goodln);color:var(--good)}
  .banner.bad{background:var(--badbg);border-color:var(--badln);color:var(--bad)}
  .banner.info{background:var(--infobg);border-color:var(--infoln);color:var(--info)}
  .banner strong{display:block;margin-bottom:3px;font-size:14px}
  .banner span{display:block;max-width:74ch}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:var(--s2)}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:var(--r1);padding:var(--s3) var(--s4)}
  .stat .n{font-size:21px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .stat .l{color:var(--muted);font-size:12px;margin-top:1px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--faint);font-weight:700;font-size:10.5px;
     text-transform:uppercase;letter-spacing:.07em;padding:0 var(--s2) var(--s2);
     border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:var(--s3) var(--s2);border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:0}
  td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
  .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:650;white-space:nowrap}
  .pill.booked{background:var(--goodbg);color:var(--good)}
  .pill.skipped,.pill.cancelled{background:var(--neutralbg);color:var(--neutral)}
  .pill.failed{background:var(--badbg);color:var(--bad)}
  .pill.pending_link,.pill.received,.pill.awaiting_approval{background:var(--warnbg);color:var(--warn)}
  .awb{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
  .awb .more{display:block;color:var(--faint);font-size:11.5px;margin-top:2px;font-weight:400}
  /* One sub-line under the pill instead of a second pill: two pills stacked in
     a narrow cell read as two separate problems when it is one row. */
  .sub2{display:block;margin-top:4px;font-size:11.5px;color:var(--muted)}
  .sub2.warnish{color:var(--warn)} .sub2.badish{color:var(--bad)}
  .why{color:var(--muted);font-size:12px;margin-top:4px;max-width:42ch;line-height:1.45}
  .btn{display:inline-block;background:var(--btn-bg);color:var(--btn-fg);text-decoration:none;
       padding:9px 15px;border-radius:var(--r1);font-weight:650;font-size:13px;border:1px solid transparent;
       cursor:pointer;font-family:inherit;line-height:1.2}
  .btn.small{padding:5px 10px;font-size:12px;border-radius:7px}
  .btn.ghost{background:transparent;color:var(--ink);border-color:var(--fieldline)}
  .btn.ghost:hover{background:var(--neutralbg)}
  .btn[disabled]{opacity:.5;cursor:default}
  :focus-visible{outline:2px solid var(--focus);outline-offset:2px}
  .row{display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center}
  label{display:block;font-size:12px;color:var(--muted);margin:0 0 5px}
  input[type=text],select{width:100%;padding:9px 11px;border:1px solid var(--fieldline);
    border-radius:var(--r1);background:var(--field);color:var(--ink);font:inherit;font-size:13px}
  select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),
    linear-gradient(135deg,var(--muted) 50%,transparent 50%);
    background-position:calc(100% - 17px) 17px,calc(100% - 12px) 17px;
    background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:32px}
  .check{display:flex;align-items:flex-start;gap:8px;color:var(--ink);font-size:13px;margin:0}
  .check input{width:16px;height:16px;margin:2px 0 0;flex:none}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;
        text-transform:uppercase;font-size:18px;font-weight:700;text-align:center}
  .fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:var(--s3)}
  .empty{color:var(--muted);padding:26px var(--s2);text-align:center}
  .empty strong{display:block;color:var(--ink);margin-bottom:3px}
  /* .scroll had overflow-x:auto and nothing to overflow: the table shrank to
     fit instead, and on a phone the reason column collapsed to about 60px and
     wrapped one word per line. A min-width makes the container do its job. */
  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 calc(var(--s5) * -1);padding:0 var(--s5)}
  /* 680px was not enough once the action column took a fixed 236px: the order
     column collapsed and the hold reason wrapped one word per line again. */
  .scroll table{min-width:840px}
  th:first-child,td:first-child{min-width:190px}
  .note{font-size:12px;color:var(--faint);margin:5px 0 0;line-height:1.45}
  /* A fixed width here so every row wraps its buttons the same way. Left to
     itself the column sized to the widest row and the others wrapped
     differently, which reads as misalignment rather than as a list. */
  .actions{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
  .actions .btn{white-space:nowrap}
  th:last-child,td:last-child{width:236px;min-width:236px}
  .msg{font-size:13px;line-height:1.45}
  .msg:empty{display:none}
  .msg.ok{color:var(--good)} .msg.err{color:var(--bad)}
  .hide{display:none!important}
  .bar{display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center;margin-bottom:var(--s3)}
  @media (max-width:640px){
    body{padding:var(--s3) var(--s2) 32px}
    .card{padding:var(--s3) var(--s3)}
    .scroll{margin:0 calc(var(--s3) * -1);padding:0 var(--s3)}
  }
  @media (prefers-color-scheme:dark){
    /* Shopify admin has a dark mode, so this runs for real merchants. The
       background tokens were flipped here and the FOREGROUND ones were not:
       --good/--warn/--bad kept their light-theme values and sat on the new
       dark fills at 1.88-2.73:1, and the button reached 1.28:1. Every colour
       used as text or as a border now flips with the surface behind it. */
    :root{--bg:#1a1a1a;--card:#242424;--ink:#e3e3e3;--muted:#a0a0a0;--faint:#8c8c8c;--line:#3a3a3a;
          --goodbg:#12301f;--warnbg:#302713;--badbg:#301613;--infobg:#132233;
          --good:#5fe0a8;--warn:#e8b64c;--bad:#f0a396;--info:#8fbdf0;
          --goodln:#2f6b4c;--warnln:#6b5524;--badln:#6b3228;--infoln:#2a4a6b;
          --btn-bg:#e3e3e3;--btn-fg:#1a1a1a;--neutralbg:#32363a;--neutral:#c2c8ce;
          --field:#1c1c1c;--fieldline:#4a4a4a;--focus:#7aa2ff}
  }
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="hdr"><span class="mark">NX</span><h1>NovaX Logistics</h1></div>
    <p class="sub" id="lede">Cash-on-delivery courier for Pakistan. Orders from this store become NovaX parcels, and the AWB goes back to Shopify as the tracking number.</p>
  </div>

  <div id="status"></div>

  <!-- Connect ------------------------------------------------------------ -->
  <div class="card hide" id="connect">
    <h2>Connect your NovaX account</h2>
    <p class="sub">Open the NovaX portal, go to <b>Integrations</b>, and generate a connect code. Paste it here. The code proves you own the account — we never match stores to accounts by email address.</p>
    <div class="fields" style="margin-top:var(--s4)">
      <div>
        <label for="code">Connect code</label>
        <input type="text" id="code" class="code" maxlength="12" autocomplete="off" spellcheck="false" placeholder="ABCD2345">
      </div>
      <div style="align-self:end">
        <button class="btn" id="linkBtn" type="button">Connect this store</button>
      </div>
    </div>
    <div class="msg" id="linkMsg" style="margin-top:var(--s3)"></div>
    <div class="row" style="margin-top:var(--s4)">
      <a class="btn ghost" id="getCode" href="#" target="_blank" rel="noopener">Get my code</a>
      <a class="btn ghost" id="signup" href="#" target="_blank" rel="noopener">I don't have a NovaX account</a>
    </div>
  </div>

  <div class="grid" id="stats"></div>

  <!-- Booking rules ------------------------------------------------------- -->
  <div class="card hide" id="settings">
    <h2>What gets booked</h2>
    <div class="fields">
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
        <p class="note">Online-store orders carry no location, so this only filters POS and draft orders. Leave it blank unless you sell in person.</p>
      </div>
      <div style="align-self:end">
        <label class="check" for="confirmed"><input type="checkbox" id="confirmed"> <span>Also book orders already paid online</span></label>
        <p class="note">Off by default: NovaX is a cash-on-delivery courier, so a prepaid parcel is carried with nothing to collect.</p>
      </div>
    </div>
    <div class="row" style="margin-top:var(--s4)">
      <button class="btn" id="saveBtn" type="button">Save</button>
      <span class="msg" id="setMsg"></span>
    </div>
  </div>

  <!-- Orders -------------------------------------------------------------- -->
  <div class="card hide" id="ordersCard">
    <h2>Orders</h2>
    <div class="bar" id="bulkBar">
      <button class="btn small hide" id="approveAll" type="button">Approve all held orders</button>
      <button class="btn small ghost" id="pickupBtn" type="button">Request a pickup</button>
      <button class="btn small ghost" id="syncBtn" type="button">Check for missing orders</button>
      <span class="msg" id="bulkMsg"></span>
    </div>
    <div class="msg" id="rowMsg" style="margin-bottom:var(--s2)"></div>
    <div class="card hide" id="ticketPanel" style="margin-bottom:var(--s3);background:var(--bg)">
      <label for="ticketBody">Tell NovaX what is wrong with <span id="ticketWhich"></span></label>
      <input type="text" id="ticketBody" maxlength="500" placeholder="The buyer says the address is wrong" autocomplete="off">
      <div class="row" style="margin-top:10px">
        <button class="btn small" id="ticketSend" type="button">Send to NovaX</button>
        <button class="btn small ghost" id="ticketCancel" type="button">Cancel</button>
      </div>
    </div>
    <div class="scroll"><div id="orders"><p class="empty">Loading…</p></div></div>
  </div>

  <div class="card">
    <h2>Full dashboard</h2>
    <p class="sub" style="margin-bottom:12px">Invoices, returns, bulk booking and COD settlement live in the NovaX portal.</p>
    <a class="btn" id="portal" href="${esc(portalUrl)}" target="_blank" rel="noopener">Open NovaX portal</a>
  </div>
</div>

<script>
(function(){
  var SHOP = ${JSON.stringify(shop)};
  var PORTAL = ${JSON.stringify(portalUrl)};
  var state = null;

  function el(id){ return document.getElementById(id); }
  function show(id, on){ el(id).classList[on ? "remove" : "add"]("hide"); }
  function h(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function money(n){
    if (n == null || isNaN(n)) return "—";
    return "Rs " + Number(n).toLocaleString("en-PK", { maximumFractionDigits: 0 });
  }
  function list(s){
    return String(s || "").split(",").map(function(x){ return x.trim(); }).filter(Boolean);
  }

  // App Bridge mints a fresh, short-lived session token per call. Asking for a
  // new one every time is deliberate -- caching it means the first request
  // after it expires fails, which reads to a merchant as "the app is broken".
  async function token(){
    if (window.shopify && window.shopify.idToken) return await window.shopify.idToken();
    throw new Error("App Bridge not ready");
  }

  async function api(path, body){
    var init = { headers: { Authorization: "Bearer " + (await token()) } };
    if (body !== undefined) {
      init.method = "POST";
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var res = await fetch(path, init);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }

  function say(id, text, ok){
    var n = el(id);
    n.textContent = text || "";
    n.className = "msg " + (text ? (ok ? "ok" : "err") : "");
  }

  // ---- status -------------------------------------------------------------

  function renderStatus(s){
    var box = el("status");
    if (!s) {
      box.innerHTML = '<div class="banner bad"><strong>This store is not registered with NovaX</strong>' +
        '<span>Uninstall and reinstall the app. If it happens again, message NovaX on WhatsApp 0312 3922558.</span></div>';
      show("connect", false); show("settings", false); show("ordersCard", false);
      return;
    }
    if (!s.linked) {
      var n = s.pending_count || 0;
      box.innerHTML = '<div class="banner pending"><strong>One step left: connect your NovaX account</strong>' +
        '<span>Nothing is booked until you do.' +
        (n ? ' <b>' + n + '</b> order' + (n === 1 ? '' : 's') + ' received so far ' +
             (n === 1 ? 'is' : 'are') + ' being held and will be booked the moment you connect — nothing is lost.' : '') +
        '</span></div>';
      show("connect", true); show("settings", false); show("ordersCard", n > 0);
    // Nothing here works until the store is connected, so nothing here is offered.
    el("approveAll").classList.add("hide");
    el("pickupBtn").classList.add("hide");
    el("syncBtn").classList.add("hide");
      return;
    }

    var bits = [];
    if (s.awaiting_count)      bits.push('<b>' + s.awaiting_count + '</b> waiting for your approval');
    if (s.failed_count)        bits.push('<b>' + s.failed_count + '</b> could not be booked');
    if (s.sync_failed_count)   bits.push('<b>' + s.sync_failed_count + '</b> booked but not synced to Shopify');
    box.innerHTML = '<div class="banner ' + (s.failed_count || s.sync_failed_count ? "info" : "active") + '">' +
      '<strong>Connected' + (s.client_name ? ' — ' + h(s.client_name) : '') + '</strong>' +
      '<span>' + (s.booking_mode === "manual"
        ? 'Every order is held for your approval.'
        : 'Matching orders are booked automatically.') +
      (bits.length ? ' ' + bits.join(', ') + '.' : '') +
      '</span></div>';
    show("connect", false); show("settings", true); show("ordersCard", true);
    el("pickupBtn").classList.remove("hide");
    el("syncBtn").classList.remove("hide");
    el("approveAll").classList[s.awaiting_count ? "remove" : "add"]("hide");
    el("approveAll").textContent = "Approve all " + s.awaiting_count + " held order" +
      (s.awaiting_count === 1 ? "" : "s");
  }

  function renderStats(s, w){
    if (!s || !s.linked) { el("stats").innerHTML = ""; return; }
    var cells = [
      [s.orders_booked || 0, "Orders booked"],
      [money(w && w.available_balance), "COD available"],
      [money(w && w.pending_payout), "Payout pending"],
      [money(w && w.paid_this_month), "Paid this month"]
    ];
    el("stats").innerHTML = cells.map(function(c){
      return '<div class="stat"><div class="n">' + h(c[0]) + '</div><div class="l">' + h(c[1]) + '</div></div>';
    }).join("");
  }

  function renderSettings(s){
    if (!s || !s.linked) return;
    el("mode").value = s.booking_mode === "manual" ? "manual" : "auto";
    el("confirmed").checked = Boolean(s.rule_require_confirmed);
    el("tags").value = (s.rule_exclude_tags  || []).join(", ");
    el("pay").value  = (s.rule_payment_modes || []).join(", ");
    el("ship").value = (s.rule_shipping_names|| []).join(", ");
    el("locs").value = (s.rule_location_ids  || []).join(", ");
  }

  // ---- orders -------------------------------------------------------------

  // "Booked, waiting for a rider" and "booked, but Shopify has not been told"
  // are different problems with different fixes, so they are different pills.
  function statusCell(r){
    var label = String(r.status || "").replace(/_/g, " ");
    var out = '<span class="pill ' + h(r.status) + '">' + h(label) + '</span>';
    if (r.parcel_status && r.parcel_status !== "New booked") {
      out += '<span class="sub2">' + h(r.parcel_status) + '</span>';
    }
    if (r.status === "booked" && r.fulfill_state === "ready") {
      out += '<span class="sub2">Tracking sync pending</span>';
    } else if (r.status === "booked" && r.fulfill_state === "failed") {
      out += '<span class="sub2 badish">Tracking not sent to Shopify</span>';
    }
    if (r.recall_requested) out += '<span class="sub2 badish">Recall requested</span>';
    return out;
  }

  function actionsCell(r){
    var a = [];
    if (r.status === "awaiting_approval") {
      a.push('<button class="btn small" data-act="approve" data-id="' + h(r.shopify_order_id) + '">Book it</button>');
      a.push('<button class="btn small ghost" data-act="reject" data-id="' + h(r.shopify_order_id) + '">Decline</button>');
    }
    if (r.awb) {
      a.push('<a class="btn small ghost" target="_blank" rel="noopener" href="' +
             h(r.tracking_url) + '">Track</a>');
      a.push('<a class="btn small ghost" target="_blank" rel="noopener" href="' +
             h(PORTAL + "?awb=" + encodeURIComponent(r.awb)) + '">Label</a>');
    }
    if (r.status === "booked") {
      a.push('<button class="btn small ghost" data-act="split" data-id="' + h(r.shopify_order_id) + '">Extra box</button>');
    }
    if (r.status === "booked" || r.status === "failed" || r.awb) {
      a.push('<button class="btn small ghost" data-act="ticket" data-id="' + h(r.shopify_order_id) + '">Problem?</button>');
    }
    if ((r.status === "booked" && !r.recall_requested) || r.status === "awaiting_approval") {
      a.push('<button class="btn small ghost" data-act="cancel" data-id="' + h(r.shopify_order_id) + '">Cancel</button>');
    }
    return '<div class="actions">' + a.join("") + '</div>';
  }

  function renderOrders(rows){
    var box = el("orders");
    if (!rows || !rows.length) {
      box.innerHTML = '<div class="empty"><strong>No orders yet</strong>' +
        'The next order this store receives appears here, with its AWB.</div>';
      return;
    }
    box.innerHTML = '<table><thead><tr>' +
      '<th>Order</th><th>AWB</th><th>COD</th><th>Status</th><th>Received</th><th></th>' +
      '</tr></thead><tbody>' + rows.map(function(r){
        var when = r.received_at ? new Date(r.received_at).toLocaleString("en-PK",
          { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }) : "—";
        var why = "";
        if (r.status === "awaiting_approval" && r.hold_reason) why = r.hold_reason;
        else if (r.fulfill_state === "failed" && r.fulfill_error) {
          why = "Parcel is booked and moving. Shopify was not updated: " + r.fulfill_error;
        } else if ((r.status === "skipped" || r.status === "failed" || r.status === "cancelled") && r.error) {
          why = r.error;
        }
        return '<tr data-order-name="' + h(r.order_name || "") + '">' +
          '<td>' + h(r.order_name || "—") + (why ? '<div class="why">' + h(why) + '</div>' : "") + '</td>' +
          '<td class="awb">' + h(r.awb || "—") +
            ((r.extra_awbs && r.extra_awbs.length)
              ? '<span class="more">+ ' + r.extra_awbs.map(h).join(", ") + '</span>' : "") + '</td>' +
          '<td class="num">' + money(r.cod_amount) + '</td>' +
          '<td>' + statusCell(r) + '</td>' +
          '<td class="num">' + h(when) + '</td>' +
          '<td>' + actionsCell(r) + '</td>' +
        '</tr>';
      }).join("") + '</tbody></table>';
  }

  // ---- load ---------------------------------------------------------------

  async function load(){
    state = await api("state");
    renderStatus(state.shop);
    renderStats(state.shop, state.wallet);
    renderSettings(state.shop);
    renderOrders(state.orders);
    var portal = (state.shop && state.shop.portal_url) || PORTAL;
    el("portal").href = portal;
    el("getCode").href = portal + "#integrations";
    el("signup").href  = portal.replace("client.html", "index.html") + "#signup";
  }

  // ---- actions ------------------------------------------------------------

  el("linkBtn").addEventListener("click", async function(){
    var btn = this, code = el("code").value.trim();
    if (!code) { say("linkMsg", "Enter the code from your NovaX portal.", false); return; }
    btn.disabled = true; say("linkMsg", "Connecting…", true);
    try {
      var r = await api("api/link", { code: code });
      say("linkMsg", r.message || (r.ok ? "Connected." : "Could not connect."), Boolean(r.ok));
      if (r.ok) await load();
    } catch (e) {
      say("linkMsg", "Could not reach NovaX: " + String(e.message || e), false);
    } finally { btn.disabled = false; }
  });

  el("saveBtn").addEventListener("click", async function(){
    var btn = this;
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
      say("setMsg", r.message || "Saved.", Boolean(r.ok));
      if (r.ok) await load();
    } catch (e) {
      say("setMsg", "Could not save: " + String(e.message || e), false);
    } finally { btn.disabled = false; }
  });

  el("approveAll").addEventListener("click", async function(){
    var btn = this; btn.disabled = true; say("bulkMsg", "Approving…", true);
    try {
      var r = await api("api/approve-all", {});
      say("bulkMsg", r.message || "", Boolean(r.ok));
      setTimeout(load, 2000);
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

  // NOTE: no alert(), confirm() or prompt() anywhere in this page. Chrome
  // blocks all three inside a cross-origin iframe, and this page only ever
  // runs as one -- inside admin.shopify.com. A confirm() here does not warn
  // the merchant, it silently returns false, and a prompt() returns null, so
  // the button simply does nothing. Every prompt and every result is inline.
  var ticketFor = null, splitArmed = null;

  function closeTicket(){
    ticketFor = null;
    el("ticketPanel").classList.add("hide");
    el("ticketBody").value = "";
  }

  el("ticketCancel").addEventListener("click", closeTicket);

  el("ticketSend").addEventListener("click", async function(){
    var body = el("ticketBody").value.trim();
    if (!body) { say("rowMsg", "Write what the problem is first.", false); return; }
    this.disabled = true;
    try {
      var r = await api("api/ticket", { order_id: ticketFor, body: body });
      say("rowMsg", r.message || "", Boolean(r.ok));
      if (r.ok) closeTicket();
    } catch (e) { say("rowMsg", String(e.message || e), false); }
    finally { this.disabled = false; }
  });

  el("syncBtn").addEventListener("click", async function(){
    var btn = this; btn.disabled = true; say("bulkMsg", "Asking Shopify for the last 48 hours…", true);
    try {
      var r = await api("api/reconcile", {});
      say("bulkMsg", r.message || "", Boolean(r.ok));
      if (r.recovered) setTimeout(load, 1500);
    } catch (e) { say("bulkMsg", String(e.message || e), false); }
    finally { btn.disabled = false; }
  });

  el("orders").addEventListener("click", async function(ev){
    var b = ev.target.closest("button[data-act]");
    if (!b) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id");

    if (act === "ticket") {
      ticketFor = id;
      el("ticketWhich").textContent = "order " + (b.closest("tr").getAttribute("data-order-name") || id);
      el("ticketPanel").classList.remove("hide");
      el("ticketBody").focus();
      say("rowMsg", "");
      return;
    }

    // An extra box is a second parcel and a second delivery fee. Two clicks,
    // with the cost said out loud, because the merchant pays for this.
    if (act === "split" && splitArmed !== id) {
      splitArmed = id;
      b.textContent = "Confirm — this is a 2nd parcel and a 2nd delivery fee";
      setTimeout(function(){
        if (splitArmed === id) { splitArmed = null; b.textContent = "Extra box"; }
      }, 6000);
      return;
    }
    splitArmed = null;

    b.disabled = true;
    var prev = b.textContent;
    b.textContent = "…";
    say("rowMsg", "");
    try {
      var r;
      if (act === "cancel")     r = await api("api/order/cancel", { order_id: id });
      else if (act === "split") r = await api("api/order/split",  { order_id: id });
      else                      r = await api("api/order/decide", { order_id: id, decision: act });

      say("rowMsg", (r && r.message) || "", Boolean(r && r.ok));
      if (r && r.ok) setTimeout(load, (act === "approve" || act === "split") ? 1800 : 400);
      else { b.disabled = false; b.textContent = prev; }
    } catch (e) {
      b.disabled = false; b.textContent = prev;
      say("rowMsg", "Could not reach NovaX: " + String(e.message || e), false);
    }
  });

  (async function(){
    try {
      await load();
    } catch (e) {
      el("status").innerHTML = '<div class="banner bad"><strong>Could not load</strong>' +
        h(String(e.message || e)) + ' — reload the page, and message NovaX on WhatsApp 0312 3922558 if it keeps happening.</div>';
      el("orders").innerHTML = "";
    }
  })();
})();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
