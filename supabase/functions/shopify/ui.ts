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
    --bg:#f6f6f7; --card:#fff; --ink:#1a1a1a; --muted:#616161;
    --line:#e3e3e3; --brand:#0b7c4d; --warn:#8a6116; --warnbg:#fff6e0;
    --bad:#8e1f0b; --badbg:#fdf0ed; --good:#0b7c4d; --goodbg:#eaf4ee;
    --info:#1f4f8a; --infobg:#eaf1fa;
    /* The button is an inversion PAIR, not --ink used as a surface. --ink
       flips to near-white in dark mode, and white-on-white measured 1.28:1. */
    --btn-bg:#1a1a1a; --btn-fg:#fff; --neutralbg:#eee; --neutral:#555;
    --field:#fff; --fieldline:#b5b5b5;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:20px;background:var(--bg);color:var(--ink);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:920px;margin:0 auto;display:grid;gap:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
  h1{font-size:19px;margin:0 0 4px}
  h2{font-size:14px;margin:0 0 12px;color:var(--muted);font-weight:600;
     text-transform:uppercase;letter-spacing:.04em}
  .sub{color:var(--muted);margin:0}
  .banner{border-radius:10px;padding:14px 16px;border:1px solid}
  .banner.pending{background:var(--warnbg);border-color:#e3c67d;color:var(--warn)}
  .banner.active{background:var(--goodbg);border-color:#9ecdb4;color:var(--good)}
  .banner.bad{background:var(--badbg);border-color:#e0a99c;color:var(--bad)}
  .banner.info{background:var(--infobg);border-color:#a8c3e2;color:var(--info)}
  .banner strong{display:block;margin-bottom:2px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
  .stat .n{font-size:22px;font-weight:650;letter-spacing:-.01em}
  .stat .l{color:var(--muted);font-size:12px;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--muted);font-weight:600;font-size:11px;
     text-transform:uppercase;letter-spacing:.04em;padding:0 8px 8px;border-bottom:1px solid var(--line)}
  td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:0}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
  .pill.booked{background:var(--goodbg);color:var(--good)}
  .pill.skipped,.pill.cancelled{background:var(--neutralbg);color:var(--neutral)}
  .pill.failed{background:var(--badbg);color:var(--bad)}
  .pill.pending_link,.pill.received,.pill.awaiting_approval{background:var(--warnbg);color:var(--warn)}
  .pill.sync{background:var(--infobg);color:var(--info)}
  .awb{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .why{color:var(--muted);font-size:12px;margin-top:3px;max-width:52ch}
  .btn{display:inline-block;background:var(--btn-bg);color:var(--btn-fg);text-decoration:none;
       padding:9px 14px;border-radius:8px;font-weight:600;font-size:13px;border:0;cursor:pointer}
  .btn.small{padding:5px 10px;font-size:12px}
  .btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--fieldline)}
  .btn[disabled]{opacity:.55;cursor:default}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  label{display:block;font-size:12px;color:var(--muted);margin:0 0 4px}
  input[type=text],select{width:100%;padding:9px 10px;border:1px solid var(--fieldline);
    border-radius:8px;background:var(--field);color:var(--ink);font:inherit;font-size:13px}
  input[type=checkbox]{width:16px;height:16px;vertical-align:-2px;margin-right:6px}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;
        text-transform:uppercase;font-size:18px;font-weight:700}
  .fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
  .empty{color:var(--muted);padding:22px 8px;text-align:center}
  .scroll{overflow-x:auto}
  .note{font-size:12px;color:var(--muted);margin-top:6px}
  .actions{display:flex;gap:6px;flex-wrap:wrap}
  .msg{margin-top:10px;font-size:13px}
  .msg.ok{color:var(--good)} .msg.err{color:var(--bad)}
  .hide{display:none!important}
  @media (prefers-color-scheme:dark){
    /* Shopify admin has a dark mode, so this runs for real merchants. The
       background tokens were flipped here and the FOREGROUND ones were not:
       --good/--warn/--bad kept their light-theme values and sat on the new
       dark fills at 1.88-2.73:1, and the button reached 1.28:1. Every colour
       used as text now flips with the surface it sits on. */
    :root{--bg:#1a1a1a;--card:#242424;--ink:#e3e3e3;--muted:#a0a0a0;--line:#3a3a3a;
          --goodbg:#12301f;--warnbg:#302713;--badbg:#301613;--infobg:#132233;
          --good:#5fe0a8;--warn:#e8b64c;--bad:#f0a396;--info:#8fbdf0;--brand:#5fe0a8;
          --btn-bg:#e3e3e3;--btn-fg:#1a1a1a;--neutralbg:#32363a;--neutral:#c2c8ce;
          --field:#1c1c1c;--fieldline:#4a4a4a}
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>NovaX Logistics</h1>
    <p class="sub" id="lede">Cash-on-delivery courier for Pakistan. Orders from this store become NovaX parcels, and the AWB goes back to Shopify as the tracking number.</p>
  </div>

  <div id="status"></div>

  <!-- Connect ------------------------------------------------------------ -->
  <div class="card hide" id="connect">
    <h2>Connect your NovaX account</h2>
    <p class="sub">Open the NovaX portal, go to <b>Integrations</b>, and generate a connect code. Paste it here. The code proves you own the account — we never match stores to accounts by email address.</p>
    <div class="fields" style="margin-top:14px">
      <div>
        <label for="code">Connect code</label>
        <input type="text" id="code" class="code" maxlength="12" autocomplete="off" spellcheck="false" placeholder="ABCD2345">
      </div>
      <div style="align-self:end">
        <button class="btn" id="linkBtn" type="button">Connect this store</button>
      </div>
    </div>
    <div class="msg" id="linkMsg"></div>
    <div class="row" style="margin-top:14px">
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
          <option value="auto">Book every matching order automatically</option>
          <option value="manual">Hold every order for my approval</option>
        </select>
      </div>
      <div>
        <label for="tags">Never book orders tagged</label>
        <input type="text" id="tags" placeholder="pickup, wholesale" autocomplete="off">
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
        <label for="locs">Only these location IDs</label>
        <input type="text" id="locs" placeholder="blank means any" autocomplete="off">
      </div>
      <div style="align-self:end">
        <label><input type="checkbox" id="confirmed"> Only book paid orders</label>
        <div class="note">COD orders are unpaid by design — leave this off if you sell COD.</div>
      </div>
    </div>
    <div class="row" style="margin-top:14px">
      <button class="btn" id="saveBtn" type="button">Save</button>
      <span class="msg" id="setMsg"></span>
    </div>
  </div>

  <!-- Orders -------------------------------------------------------------- -->
  <div class="card hide" id="ordersCard">
    <h2>Orders</h2>
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
        'Uninstall and reinstall the app. If it happens again, message NovaX on WhatsApp 0312 3922558.</div>';
      show("connect", false); show("settings", false); show("ordersCard", false);
      return;
    }
    if (!s.linked) {
      var n = s.pending_count || 0;
      box.innerHTML = '<div class="banner pending"><strong>One step left: connect your NovaX account</strong>' +
        'Nothing is booked until you do.' +
        (n ? ' <b>' + n + '</b> order' + (n === 1 ? '' : 's') + ' received so far ' +
             (n === 1 ? 'is' : 'are') + ' being held and will be booked the moment you connect — nothing is lost.' : '') +
        '</div>';
      show("connect", true); show("settings", false); show("ordersCard", n > 0);
      return;
    }

    var bits = [];
    if (s.awaiting_count)      bits.push('<b>' + s.awaiting_count + '</b> waiting for your approval');
    if (s.failed_count)        bits.push('<b>' + s.failed_count + '</b> could not be booked');
    if (s.sync_failed_count)   bits.push('<b>' + s.sync_failed_count + '</b> booked but not synced to Shopify');
    box.innerHTML = '<div class="banner ' + (s.failed_count || s.sync_failed_count ? "info" : "active") + '">' +
      '<strong>Connected' + (s.client_name ? ' — ' + h(s.client_name) : '') + '</strong>' +
      (s.booking_mode === "manual"
        ? 'Every order is held for your approval.'
        : 'Matching orders are booked automatically.') +
      (bits.length ? ' ' + bits.join(', ') + '.' : '') +
      '</div>';
    show("connect", false); show("settings", true); show("ordersCard", true);
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
    if (r.status === "booked" && r.fulfill_state === "ready") {
      out += ' <span class="pill sync">tracking sync pending</span>';
    } else if (r.status === "booked" && r.fulfill_state === "failed") {
      out += ' <span class="pill failed">tracking sync failed</span>';
    }
    if (r.recall_requested) out += ' <span class="pill failed">recall requested</span>';
    if (r.parcel_status)    out += '<div class="why">' + h(r.parcel_status) + '</div>';
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
    if ((r.status === "booked" && !r.recall_requested) || r.status === "awaiting_approval") {
      a.push('<button class="btn small ghost" data-act="cancel" data-id="' + h(r.shopify_order_id) + '">Cancel</button>');
    }
    return '<div class="actions">' + a.join("") + '</div>';
  }

  function renderOrders(rows){
    var box = el("orders");
    if (!rows || !rows.length) {
      box.innerHTML = '<p class="empty">No orders yet. The next order this store receives will appear here.</p>';
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
        return '<tr>' +
          '<td>' + h(r.order_name || "—") + (why ? '<div class="why">' + h(why) + '</div>' : "") + '</td>' +
          '<td class="awb">' + h(r.awb || "—") + '</td>' +
          '<td>' + money(r.cod_amount) + '</td>' +
          '<td>' + statusCell(r) + '</td>' +
          '<td>' + h(when) + '</td>' +
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

  el("orders").addEventListener("click", async function(ev){
    var b = ev.target.closest("button[data-act]");
    if (!b) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id");
    b.disabled = true;
    var prev = b.textContent;
    b.textContent = "…";
    try {
      var r = act === "cancel"
        ? await api("api/order/cancel", { order_id: id })
        : await api("api/order/decide", { order_id: id, decision: act });
      // A booking takes a moment; reload after it has had one.
      setTimeout(load, act === "approve" ? 1500 : 0);
      if (!r.ok) { b.disabled = false; b.textContent = prev; alert(r.message || "That did not work."); }
    } catch (e) {
      b.disabled = false; b.textContent = prev;
      alert("Could not reach NovaX: " + String(e.message || e));
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
