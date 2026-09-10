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
// of data arrives from /api/state, which requires a signed session token.
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
  }
  *{box-sizing:border-box}
  body{margin:0;padding:20px;background:var(--bg);color:var(--ink);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:900px;margin:0 auto;display:grid;gap:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
  h1{font-size:19px;margin:0 0 4px}
  h2{font-size:14px;margin:0 0 12px;color:var(--muted);font-weight:600;
     text-transform:uppercase;letter-spacing:.04em}
  .sub{color:var(--muted);margin:0}
  .banner{border-radius:10px;padding:14px 16px;border:1px solid}
  .banner.pending{background:var(--warnbg);border-color:#e3c67d;color:var(--warn)}
  .banner.active{background:var(--goodbg);border-color:#9ecdb4;color:var(--good)}
  .banner.bad{background:var(--badbg);border-color:#e0a99c;color:var(--bad)}
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
  .pill.skipped{background:#eee;color:#555}
  .pill.failed{background:var(--badbg);color:var(--bad)}
  .pill.pending_link,.pill.received{background:var(--warnbg);color:var(--warn)}
  .awb{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .why{color:var(--muted);font-size:12px;margin-top:3px;max-width:46ch}
  a.btn{display:inline-block;background:var(--ink);color:#fff;text-decoration:none;
        padding:9px 14px;border-radius:8px;font-weight:600;font-size:13px}
  .empty{color:var(--muted);padding:22px 8px;text-align:center}
  .scroll{overflow-x:auto}
  @media (prefers-color-scheme:dark){
    :root{--bg:#1a1a1a;--card:#242424;--ink:#e3e3e3;--muted:#a0a0a0;--line:#3a3a3a;
          --goodbg:#12301f;--warnbg:#302713;--badbg:#301613}
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>NovaX Logistics</h1>
    <p class="sub">Orders from this store are booked with NovaX automatically. The AWB goes back to Shopify as the tracking number.</p>
  </div>

  <div id="status"></div>

  <div class="grid" id="stats"></div>

  <div class="card">
    <h2>Recent orders</h2>
    <div class="scroll"><div id="orders"><p class="empty">Loading…</p></div></div>
  </div>

  <div class="card">
    <h2>Full dashboard</h2>
    <p class="sub" style="margin-bottom:12px">Labels, bulk booking, invoices, returns and COD settlement live in the NovaX portal.</p>
    <a class="btn" href="${esc(portalUrl)}" target="_blank" rel="noopener">Open NovaX portal</a>
  </div>
</div>

<script>
(function(){
  var SHOP = ${JSON.stringify(shop)};

  function el(id){ return document.getElementById(id); }
  function h(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function money(n){
    if (n == null || isNaN(n)) return "—";
    return "Rs " + Number(n).toLocaleString("en-PK", { maximumFractionDigits: 0 });
  }

  // App Bridge mints a fresh, short-lived session token per call. Asking for a
  // new one every time is deliberate -- caching it means the first request
  // after it expires fails, which reads to a merchant as "the app is broken".
  async function token(){
    if (window.shopify && window.shopify.idToken) return await window.shopify.idToken();
    throw new Error("App Bridge not ready");
  }

  async function api(path){
    var res = await fetch(path, { headers: { Authorization: "Bearer " + (await token()) } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }

  function renderStatus(s){
    var box = el("status");
    if (!s) {
      box.innerHTML = '<div class="banner bad"><strong>Not connected</strong>' +
        'This store is not registered with NovaX yet. Reinstall the app, or contact NovaX support.</div>';
      return;
    }
    if (s.status === "pending_link" || !s.linked) {
      var n = s.pending_count || 0;
      box.innerHTML = '<div class="banner pending"><strong>Waiting for NovaX to confirm your account</strong>' +
        'Your store is installed. We are matching it to your NovaX merchant account — this is a manual check and is usually done the same working day.' +
        (n ? ' <b>' + n + ' order' + (n === 1 ? '' : 's') + '</b> received so far will be booked automatically as soon as it is confirmed — nothing is lost.' : '') +
        '</div>';
      return;
    }
    box.innerHTML = '<div class="banner active"><strong>Connected' +
      (s.client_name ? ' — ' + h(s.client_name) : '') + '</strong>' +
      'New orders are booked with NovaX automatically.' +
      (s.failed_count ? ' <b>' + s.failed_count + '</b> could not be booked — see the reasons below.' : '') +
      '</div>';
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

  function renderOrders(rows){
    var box = el("orders");
    if (!rows || !rows.length) {
      box.innerHTML = '<p class="empty">No orders yet. The next order this store receives will appear here.</p>';
      return;
    }
    box.innerHTML = '<table><thead><tr>' +
      '<th>Order</th><th>AWB</th><th>COD</th><th>Status</th><th>Received</th>' +
      '</tr></thead><tbody>' + rows.map(function(r){
        var when = r.received_at ? new Date(r.received_at).toLocaleString("en-PK",
          { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }) : "—";
        var why = (r.status === "skipped" || r.status === "failed") && r.error
          ? '<div class="why">' + h(r.error) + '</div>' : "";
        return '<tr>' +
          '<td>' + h(r.order_name || "—") + why + '</td>' +
          '<td class="awb">' + h(r.awb || "—") + '</td>' +
          '<td>' + money(r.cod_amount) + '</td>' +
          '<td><span class="pill ' + h(r.status) + '">' + h(r.status.replace(/_/g, " ")) + '</span></td>' +
          '<td>' + h(when) + '</td>' +
        '</tr>';
      }).join("") + '</tbody></table>';
  }

  (async function(){
    try {
      var state = await api("state");
      renderStatus(state.shop);
      renderStats(state.shop, state.wallet);
      renderOrders(state.orders);
    } catch (e) {
      el("status").innerHTML = '<div class="banner bad"><strong>Could not load</strong>' +
        h(String(e.message || e)) + ' — reload the page, and tell NovaX support if it keeps happening.</div>';
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
