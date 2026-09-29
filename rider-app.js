(function () {
  "use strict";
  var R = window.NovaXRider, P = window.NovaXPayment;
  var sb = window.supabase && window.supabase.createClient(
    "https://rhzunbzbdzicajqtohwp.supabase.co", "sb_publishable_yH8i0Q43BAxXoExo95r0rQ_fCeRdHXA",
    { global: { fetch: async function (url, options) {
      var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 20000);
      var source = options && options.signal;
      function abort() { controller.abort(); }
      if (source) { if (source.aborted) abort(); else source.addEventListener("abort", abort, { once: true }); }
      try { return await fetch(url, Object.assign({}, options, { signal: controller.signal })); }
      finally { clearTimeout(timer); if (source) source.removeEventListener("abort", abort); }
    } } });
  var userId, riderId, queue, cacheKey, channel, authSubscription, lastSync = 0, connected = false;
  var busy = false, loading = false, flushing = false, authorized = false, refreshTimer, retryTimer = null, retryDelay = 0;
  var data = { rider: null, parcels: [], clients: {}, cash: null };
  var ACTIVE = Object.keys(R ? R.ACTIONS : {}).concat(["Refused", "Consignee not available", "Out of service area"]);
  function q(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(v) { return "Rs " + Number(v || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 }); }
  function today() { return R.day(new Date()); }
  function msg(text, type, id) { var el = q(id || "notice"); el.className = "notice show " + (type || "info"); el.textContent = text; }
  function failGate(text) {
    q("gateSpin").classList.add("hidden"); q("gateTitle").textContent = "Route unavailable";
    q("gateText").textContent = text; q("retryBtn").classList.remove("hidden"); q("loginLink").classList.remove("hidden");
  }
  function jobs() { return queue ? queue.read() : []; }
  function key(prefix) { return prefix + "-" + riderId + "-" + crypto.randomUUID(); }
  function lock(fn) {
    if (!navigator.locks) return Promise.reject(new Error("Update this browser before saving rider actions. Secure local locking is unavailable."));
    return navigator.locks.request(queue.key, fn);
  }
  function paintNetwork() {
    q("network").textContent = !navigator.onLine ? "Offline" : connected ? "Connected" : "Connection unverified";
    q("network").style.color = connected && navigator.onLine ? "#087854" : "#a72d24";
    var waiting = queue ? jobs().filter(function (j) { return j.state !== "review"; }).length : 0;
    if (waiting) q("network").textContent += " \u00b7 " + waiting + " saved, waiting to send";
    q("lastSync").textContent = lastSync ? "Synced " + Math.max(0, Math.floor((Date.now() - lastSync) / 60000)) + " min ago" : "Not synced yet";
  }
  function paintQueue() {
    var list = jobs(), review = list.filter(function (j) { return j.state === "review"; });
    q("queueNote").className = "notice";
    if (list.length) msg(list.length + " saved action(s): " + review.length + " need office review. Keep this phone's data until all actions are confirmed.", review.length ? "error" : "info", "queueNote");
    q("queueReview").innerHTML = review.map(function (j) {
      return '<article class="parcel"><b>Not confirmed: ' + esc(j.to || j.kind) + '</b><p>' + esc((j.list || []).join(", ")) + ' ' + esc(j.error || "Office review required") + '</p><small>Reference ' + esc(j.key) + '</small><div class="actions"><button class="btn secondary" data-write data-retry="' + esc(j.key) + '">Retry saved action</button></div></article>';
    }).join("");
  }
  function controls() {
    document.querySelectorAll("[data-write]").forEach(function (b) { b.disabled = busy || flushing || !authorized || b.hasAttribute("data-blocked"); });
    q("depositCashBtn").disabled = busy || flushing || !authorized || !connected || !navigator.onLine || !data.cash || !data.cash.count || jobs().length > 0 || data.cash.review;
    q("refreshBtn").disabled = loading || busy || flushing; paintNetwork();
  }
  function payment(p) { return P.classify({ cod: p.cod, paymentMode: p.meta.paymentMode || p.meta.payment_mode }); }
  function contact(p) {
    if (!R.isOrigin(p)) return { name: p.consignee, phone: p.phone, address: p.address, city: p.city };
    var c = data.clients[p.clientId] || {};
    return { name: c.name || "Shipper details unavailable", phone: c.phone || "", address: c.address || "", city: c.city || "" };
  }
  var LABELS = { "Collected by rider": "Collected from shipper", "Arrived at warehouse": "Handed to warehouse", "Parcel received at destination": "Receive parcel", "Parcel out for delivery": "Take out for delivery", Delivered: "Delivered", Refused: "Refused", "Consignee not available": "Not available", "Return in transit": "Dispatch return", "Return received at origin": "Receive return at origin", "Return out for delivery": "Take return to shipper", "Return to shipper": "Returned to shipper" };
  function card(p, actionable) {
    var c = contact(p), pay = payment(p), origin = R.isOrigin(p), location = [c.address, c.city].filter(Boolean).join(", ");
    var call = R.phone(c.phone), validPhone = /^\+?\d{9,15}$/.test(call);
    var age = Math.max(0, (Date.now() - R.timestamp(p.statusSince)) / 3600000);
    var limit = p.status === "Parcel now in transit" ? 72 : ["Parcel received at destination", "Parcel out for delivery", "Reattempt", "Reassigned"].includes(p.status) ? 24 : null;
    var breach = limit && age >= limit;
    var swapOut = p.meta.swapLeg === "out" && p.status === "Parcel out for delivery";
    var swapPending = jobs().some(function (j) { return j.kind === "swap" && j.awb === p.awb && j.state !== "review"; });
    var actions = actionable && swapOut ? (swapPending ? '<span class="pending-label">Saved on this phone \u2014 sending\u2026</span>' :
      '<button class="btn" data-write data-swap="exchanged" data-awb="' + esc(p.awb) + '">Exchange done</button>' +
      '<button class="btn secondary" data-write data-swap="failed" data-awb="' + esc(p.awb) + '">Can\u2019t exchange</button>')
      : actionable ? (R.ACTIONS[p.status] || []).map(function (s) {
      var disabled = s === "Delivered" && pay.conflict || ["Collected by rider", "Return to shipper"].includes(s) && !c.address;
      return '<button class="btn ' + (s === "Refused" ? "danger" : s === "Consignee not available" ? "secondary" : "") + '" data-write data-action="' + esc(s) + '" data-awb="' + esc(p.awb) + '"' + (disabled ? ' data-blocked disabled' : '') + '>' + esc(LABELS[s]) + '</button>';
    }).join("") : "";
    return '<article class="parcel' + (p.pending ? ' pending' : '') + (breach ? ' sla-breach' : '') + '" data-search="' + esc([p.awb, c.name, c.phone, call, c.address, c.city].join(" ").toLowerCase()) + '"><div class="parcel-head"><b class="awb">' + esc(p.awb) + '</b><span class="status">' + esc(p.status) + '</span></div>' + swapTag(p) + jline(p) + '<p><b>' + esc(c.name || "Name not recorded") + '</b><br>' + esc(location || "Address missing. Contact the office.") + '<br>' + esc(c.phone || "Phone not recorded") + '</p><div class="moneyline">' + (origin ? "No recipient COD collection on this task" : pay.conflict ? '<span class="error-text">' + esc(pay.label) + '. Office correction required.</span>' : (p.status === "Delivered" ? 'Delivered COD ' : 'Collect ') + money(pay.collectable)) + '</div>' + (p.pending ? '<p class="pending-label">Saved on this phone. Server confirmation pending.</p>' : '') + (breach ? '<p class="sla-note">Overdue by ' + Math.floor(age - limit) + 'h</p>' : '') + '<div class="contacts">' + (validPhone ? '<a class="call" href="tel:' + esc(call) + '">Call ' + (origin ? 'shipper' : 'consignee') + '</a>' : '') + (location ? '<a class="call" href="https://www.google.com/maps/search/?api=1&amp;query=' + encodeURIComponent(location) + '" target="_blank" rel="noopener">Navigate</a><button class="call" data-copy="' + esc(location) + '">Copy address</button>' : '') + '</div>' + (actions ? '<div class="actions">' + actions + '</div>' : '') + '</article>';
  }
  /* The same journey the merchant and admin see (nv-journey.js). */
  function swapTag(p) {
    if (p.meta.swapLeg === "out") return '<p class="swaptag">NOVA SWAP \u00b7 hand over the new item, collect the old one' + (p.meta.swapPairAwb ? ' \u00b7 return AWB <b>' + esc(p.meta.swapPairAwb) + '</b>' : '') + '</p>';
    if (p.meta.swapLeg === "back") return '<p class="swaptag back">NOVA SWAP RETURN \u00b7 old item going back to the merchant</p>';
    return "";
  }
  function jline(p) {
    try {
      if (!window.NVJourney) return "";
      var g = window.NVJourney.progress({ status: p.status, city: p.city, pickupCity: p.meta.pickupCity || "", steps: p.meta.steps || [], processHistory: p.meta.processHistory || [] });
      return '<p class="jstep' + (g.tone === "bad" ? " bad" : "") + '">Step ' + esc(g.step) + ' &middot; ' + esc(g.label) + '</p>';
    } catch (_) { return ""; }
  }
  /* Confirmation a rider can SEE. The notice sits at the top of the page, so
     a rider tapping Delivered halfway down a 40-stop list never saw it and
     tapped again. This floats above the nav, and the phone buzzes: once when
     saved on the phone, twice when NovaX confirms. */
  var toastTimer = null;
  function ping(text, type, buzz) {
    var t = q("riderToast");
    if (!t) { t = document.createElement("div"); t.id = "riderToast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite"); document.body.appendChild(t); }
    t.className = "rider-toast show " + (type || "info"); t.textContent = text;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = "rider-toast " + (type || "info"); }, type === "error" ? 6000 : 3200);
    try { if (buzz && navigator.vibrate) navigator.vibrate(buzz); } catch (_) {}
  }
  function list(id, rows, actionable, empty) {
    q(id).innerHTML = rows.map(function (p) { return card(p, actionable); }).join("") || '<p class="empty">' + esc(empty || "No parcels here.") + '</p>';
  }
  function stat(label, value, cash) { return '<div class="stat' + (cash ? ' money' : '') + '"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>'; }
  function render() {
    if (!data.rider) return;
    var rows = R.overlay(data.parcels, jobs()), group = function (statuses) { return rows.filter(function (p) { return statuses.includes(p.status); }); };
    var pickups = group(["New booked", "Collected by rider"]), transit = group(["Parcel now in transit"]), received = group(["Parcel received at destination", "Reattempt", "Reassigned"]), delivery = group(["Parcel out for delivery"]), failed = group(["Refused", "Consignee not available", "Out of service area"]), returns = group(["Ready for return", "Return in transit", "Return received at origin", "Return out for delivery"]);
    var delivered = data.parcels.filter(function (p) { return p.status === "Delivered" && R.day(R.deliveredAt(p)) === today(); });
    q("riderName").textContent = data.rider.name || "My Route";
    q("routeName").textContent = data.rider.branch || "Deliveries, pickups & returns"; q("todayLabel").textContent = today();
    q("stats").innerHTML = stat("Pickups", pickups.length) + stat("Delivery stops", delivery.length) + stat("Returns", returns.length) + stat("Cash to hand over", data.cash ? money(data.cash.net) : "Unavailable", true);
    q("todaySummary").innerHTML = '<p>' + delivered.length + ' confirmed deliveries today. ' + jobs().filter(function (j) { return j.kind === "status" && j.to === "Delivered" && j.state !== "review"; }).length + ' delivery action(s) awaiting confirmation.</p>';
    q("pickupCount").textContent = pickups.length; q("deliveryCount").textContent = delivery.length; q("returnCount").textContent = returns.length;
    list("pickupList", pickups, true); list("transitList", transit, true); list("receivedList", received, true); list("deliveryList", delivery, true); list("failedList", failed, false); list("attentionList", failed.concat(rows.filter(function (p) { return payment(p).conflict; })), false, "No failed attempts or payment conflicts."); list("returnList", returns, true); list("returnedList", group(["Return to shipper"]), false);
    var held = data.parcels.filter(function (p) { return p.status === "Delivered" && p.cod > 0 && !R.truth(p.meta.cashReceived); });
    list("cashList", held.filter(function (p) { return p.meta.cashDepositStatus !== "pending_confirmation"; }), false);
    list("cashPendingList", held.filter(function (p) { return p.meta.cashDepositStatus === "pending_confirmation"; }), false);
    list("cashHistoryList", data.parcels.filter(function (p) { return p.status === "Delivered" && R.truth(p.meta.cashReceived) && p.cod > 0; }), false);
    var cash = data.cash;
    q("cashHero").innerHTML = cash ? '<div class="cash-grid">' + stat("Delivered COD, all days", money(cash.gross)) + stat("Unsettled route expenses", money(cash.expenses)) + stat("Net handover", money(cash.net), true) + stat("Awaiting office", money(cash.pending)) + '</div>' + (cash.review ? '<p class="error-text">Cash reconciliation needs office review. Handover is disabled.</p>' : '') : '<p class="error-text">Server cash reconciliation unavailable. Refresh online before handing over cash.</p>';
    if (cash && Number(data.rider.cash_limit)>0 && cash.gross>Number(data.rider.cash_limit)) q("cashHero").insertAdjacentHTML("beforeend",'<p class="error-text">Cash exceeds your configured limit of '+money(data.rider.cash_limit)+'. Contact the office before continuing collections.</p>');
    q("expenseList").innerHTML = (cash && cash.expense_rows || []).map(function (e) { return '<article class="parcel"><b>' + esc(e.category) + ' &middot; ' + money(e.amount) + '</b><p>' + esc(e.note) + '</p><small>' + esc(e.expenseDate) + (R.truth(e.settled) ? ' &middot; Settled' : ' &middot; Unsettled') + '</small></article>'; }).join("") || '<p class="empty">No recent expenses.</p>';
    renderDistance(delivered); applySearch(); paintQueue(); controls();
    document.querySelectorAll("[data-blocked]").forEach(function (b) { b.disabled = true; });
  }
  function renderDistance(deliveries) {
    var stops = deliveries.map(function (p) { return { p: p, l: p.meta.deliveryLocation }; }).filter(function (s) { var l = s.l; return l && typeof l.lat === "number" && typeof l.lng === "number" && Math.abs(l.lat) <= 90 && Math.abs(l.lng) <= 180 && typeof l.accuracy === "number" && l.accuracy >= 0 && l.accuracy <= 500; }).sort(function (a, b) { return R.timestamp(a.l.at || R.deliveredAt(a.p)) - R.timestamp(b.l.at || R.deliveredAt(b.p)); });
    var total = 0;
    for (var i = 1; i < stops.length; i++) { var a = stops[i - 1].l, b = stops[i].l, rad = Math.PI / 180, h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2; total += 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h))); }
    q("routeStats").innerHTML = stat("GPS stops", stops.length) + stat("Between-stop distance", total.toFixed(1) + " km");
    q("routeSegments").textContent = "";
  }
  function applySearch() {
    var value = q("riderSearch").value.trim().toLowerCase();
    document.querySelectorAll(".list").forEach(function (el) {
      var cards = el.querySelectorAll("[data-search]"), visible = 0;
      cards.forEach(function (c) { var show = !value || c.dataset.search.includes(value); c.hidden = !show; if (show) visible++; });
      var previous = el.querySelector(".search-empty"); if (previous) previous.remove();
      if (cards.length && !visible) { var n = document.createElement("p"); n.className = "empty search-empty"; n.textContent = "No matching parcels."; el.appendChild(n); }
    });
  }
  async function paged(make) {
    var rows = [], size = 500;
    for (var offset = 0; ; offset += size) { var r = await make().order("id", { ascending: true }).range(offset, offset + size - 1); if (r.error) throw r.error; rows = rows.concat(r.data || []); if (!r.data || r.data.length < size) return rows; }
  }
  async function identity() {
    var s = await sb.auth.getSession(); if (s.error) throw s.error;
    if (!s.data.session || s.data.session.user.id !== userId) throw new Error("Rider session changed. Sign in again before sending updates.");
  }
  async function load(silent) {
    if (loading || busy || flushing || !authorized) return;
    loading = true; controls();
    try {
      await identity();
      var pr = await sb.from("profiles").select("role,status,rider_id").eq("id",userId).single();
      if (pr.error) throw pr.error;
      if (!pr.data || String(pr.data.role).toLowerCase() !== "rider" || String(pr.data.status).toLowerCase() !== "active" || pr.data.rider_id !== riderId) { authorized = false; throw new Error("Rider access changed. Sign in again or contact the office."); }
      var rr = await sb.from("riders").select("id,name,branch,cash_limit,meta").eq("id", riderId).single(); if (rr.error) throw rr.error;
      var cols = "id,awb,client_id,consignee,phone,address,city,cod_amount,status,status_since,updated_at,delivered_at,meta";
      var active = await paged(function () { return sb.from("parcels").select(cols).eq("rider_id", riderId).in("status", ACTIVE); });
      var recent = await paged(function () { return sb.from("parcels").select(cols).eq("rider_id", riderId).in("status", ["Delivered", "Return to shipper"]).gte("updated_at", new Date(Date.now() - 30 * 864e5).toISOString()); });
      var due = await paged(function () { return sb.from("parcels").select(cols).eq("rider_id", riderId).eq("status", "Delivered").or("meta->>cashReceived.is.null,meta->>cashReceived.neq.true"); });
      var merged = new Map(); active.concat(recent, due).forEach(function (p) { merged.set(p.id, R.mapParcel(p)); });
      var clientIds = Array.from(new Set(Array.from(merged.values()).filter(R.isOrigin).map(function (p) { return p.clientId; }).filter(Boolean))), clients = {};
      for (var i = 0; i < clientIds.length; i += 100) { var cr = await sb.from("clients").select("id,name,phone,address,city").in("id", clientIds.slice(i, i + 100)); if (cr.error) throw cr.error; (cr.data || []).forEach(function (c) { clients[c.id] = c; }); }
      var cash = await sb.rpc("rider_cash_summary");
      await identity();
      data = { rider: rr.data, parcels: Array.from(merged.values()), clients: clients, cash: cash.error ? null : cash.data };
      connected = true; lastSync = Date.now();
      try { localStorage.setItem(cacheKey, JSON.stringify({ user: userId, rider: riderId, at: lastSync, data: data })); }
      catch (_) { msg("This phone cannot cache the route. Do not reload it offline.", "error"); }
      q("gate").classList.add("hidden"); render(); subscribe();
      if (cash.error) msg("Cash and expense services are unavailable. Handover is disabled; contact the office.", "error");
      else if (!silent) msg("Route and cash refreshed.", "ok");
    } catch (e) {
      connected = false;
      if (!authorized) { q("gate").classList.remove("hidden"); failGate(String(e.message || e)); }
      else if (!data.rider) failGate(String(e.message || e));
      else msg("Refresh failed. Showing your last saved route: " + String(e.message || e), "error");
    } finally { loading = false; controls(); if (connected) void flush(); }
  }
  function subscribe() {
    if (channel) return;
    channel = sb.channel("rider_" + riderId).on("postgres_changes", { event: "*", schema: "public", table: "parcels", filter: "rider_id=eq." + riderId }, function () {
      clearTimeout(refreshTimer); refreshTimer = setTimeout(function () { if (!busy && !flushing) void load(true); }, 1500);
    }).subscribe();
  }
  async function save(job, id) {
    await lock(function () {
      var pending = jobs();
      if (pending.some(function (j) { return j.kind === job.kind && (job.kind === "swap" ? j.awb === job.awb : (job.kind !== "status" || j.to === job.to && JSON.stringify(j.list) === JSON.stringify(job.list))); })) throw new Error("This action already has a saved request. Reconnect or ask the office to review it; do not submit it twice.");
      queue.add(Object.assign(job, { key: key(job.kind), at: new Date().toISOString(), state: "pending" }));
    });
    render(); msg("Saved on this phone. Awaiting server confirmation.", "info", id);
    ping(navigator.onLine ? "Saved \u2014 sending to NovaX\u2026" : "Saved on this phone. It will send when you are back online.", "info", 30);
  }
  async function flush() {
    if (flushing || loading || busy || !authorized || !navigator.onLine || !jobs().some(function (j) { return j.state !== "review"; })) return;
    flushing = true; controls(); var changed = false;
    try {
      await lock(async function () {
        var pending = jobs().filter(function (j) { return j.state !== "review"; });
        for (var j of pending) {
          if (!authorized || !navigator.onLine) break;
          await identity();
          var name, args;
          if (j.kind === "status") { name = "rider_batch_update_status"; args = { p_awbs: j.list, p_to: j.to, p_reason: j.reason || "", p_batch_key: j.key, p_delivery_loc: j.location || null }; }
          else if (j.kind === "swap") { name = "rider_swap_complete"; args = { p_out_awb: j.awb, p_outcome: j.outcome, p_reason: j.reason || "", p_key: j.key, p_loc: j.location || null }; }
          else if (j.kind === "expense") { name = "rider_add_expense"; args = { p_key: j.key, p_category: j.category, p_amount: j.amount, p_note: j.note }; }
          else if (j.kind === "deposit") { name = "rider_deposit_cash_checked"; args = { p_batch_key: j.key, p_expected_gross: j.gross, p_expected_expenses: j.expenses, p_expected_net: j.net }; }
          else throw new Error("Unknown saved action. Contact the office.");
          var response;
          try { response = await sb.rpc(name, args); } catch (e) { response = { error: e }; }
          if (response.error) {
            connected = false;
            if (R.retryable(response.error)) {
              msg("Connection interrupted. The same saved reference will retry; do not repeat the action.", "info");
              /* Retry on its own instead of waiting for the next minute's
                 refresh: 5s, 10s, 20s ... up to a minute. Same key, so a
                 request that did land is not applied twice. */
              retryDelay = Math.min(60000, retryDelay ? retryDelay * 2 : 5000);
              clearTimeout(retryTimer); retryTimer = setTimeout(function () { void flush(); }, retryDelay);
              break;
            }
            queue.change(j.key, { state: "review", error: String(response.error.message || response.error) });
            jobs().forEach(function (other) { if (other.key !== j.key && other.kind === "status" && (other.list || []).some(function (awb) { return (j.list || []).includes(awb); })) queue.change(other.key, { state: "review", error: "Earlier action needs office review: " + j.key }); });
            msg("Action rejected. Its reference is kept for office review: " + String(response.error.message || response.error), "error");
            ping("Not accepted: " + String(response.error.message || response.error).slice(0, 120), "error", [120]); break;
          }
          if (!response.data || j.kind === "status" && !Array.isArray(response.data.moved)) { queue.change(j.key, { state: "review", error: "Unexpected server acknowledgement; office must check this reference." }); break; }
          await identity(); queue.remove(j.key); connected = true; changed = true; retryDelay = 0;
          if (j.kind === "swap") {
            data.parcels.forEach(function (p) { if (p.awb.toUpperCase() === String(j.awb).toUpperCase()) { p.status = j.outcome === "exchanged" ? "Delivered" : "Refused"; p.updatedAt = j.at; p.statusSince = j.at; if (j.outcome === "exchanged") p.deliveredAt = j.at; } });
            ping(j.outcome === "exchanged" ? "\u2713 Exchange done \u2014 new item delivered, old item collected (" + (response.data.back_awb || "") + ")" : "\u2713 Recorded: exchange did not happen. Bring the new item back.", "ok", [40, 60, 40]);
          }
          else if (j.kind === "status") ping("\u2713 " + ((j.list || []).length > 1 ? (j.list.length + " parcels") : (j.list || [""])[0]) + ": " + (LABELS[j.to] || j.to) + " \u2014 confirmed", "ok", [40, 60, 40]);
          else if (j.kind === "expense") ping("\u2713 Expense recorded", "ok", [40, 60, 40]);
          if (j.kind === "status") data.parcels.forEach(function (p) { if (j.list.includes(p.awb.toUpperCase())) { p.status = j.to; p.updatedAt = j.at; p.statusSince = j.at; if (j.to === "Delivered") p.deliveredAt = j.at; } });
          msg(j.kind === "deposit" ? money(response.data.net) + " handover recorded. Awaiting office receipt confirmation. Ref " + j.key : "Confirmed by NovaX: " + (j.to || j.kind) + ". Ref " + j.key, "ok", j.kind === "deposit" ? "cashResult" : j.kind === "expense" ? "expenseResult" : "notice");
        }
      });
    } catch (e) { connected = false; msg(String(e.message || e), "error"); }
    finally { flushing = false; render(); if (changed) void load(true); }
  }
  function confirm(title, text, reasons) {
    return new Promise(function (resolve) {
      var dialog = q("actionDialog"), input = q("reasonOther");
      q("dialogTitle").textContent = title; q("dialogText").textContent = text; q("dialogError").textContent = ""; input.value = "";
      q("reasonLabel").classList.toggle("hidden", !reasons);
      q("reasonPresets").innerHTML = (reasons || []).map(function (r) { return '<button class="btn secondary" type="button" data-reason="' + esc(r) + '">' + esc(r) + '</button>'; }).join("");
      q("reasonPresets").onclick = function (e) { var b = e.target.closest("[data-reason]"); if (b) input.value = b.dataset.reason; };
      dialog.querySelector("form").onsubmit = function (e) { if (e.submitter && e.submitter.value === "confirm" && reasons && !input.value.trim()) { e.preventDefault(); q("dialogError").textContent = "Choose or enter a reason."; } };
      dialog.returnValue = "cancel"; dialog.onclose = function () { resolve(dialog.returnValue === "confirm" ? input.value.trim() || true : null); dialog.onclose = null; }; dialog.showModal();
    });
  }
  /* The first fix a cheap phone returns is often a cell-tower guess, 500 m
     or more out, and it was saved as the delivery point. This watches for up
     to 10 s and keeps the best reading, stopping early at 25 m or better. */
  function gps() {
    return new Promise(function (resolve) {
      var at = new Date().toISOString();
      if (!navigator.geolocation) { resolve({ unavailable: true, at: at }); return; }
      var best = null, done = false, watch = null, timer = null;
      function out(p) { return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), at: at }; }
      function finish() {
        if (done) return; done = true; clearTimeout(timer);
        if (watch != null) { try { navigator.geolocation.clearWatch(watch); } catch (_) {} }
        resolve(best ? out(best) : { unavailable: true, at: at });
      }
      function take(p) {
        if (!p || !p.coords) return;
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
        if (best.coords.accuracy <= 25) finish(); else msg("Getting GPS fix\u2026 \u00b1" + Math.round(best.coords.accuracy) + " m", "info");
      }
      if (typeof navigator.geolocation.watchPosition !== "function") {
        navigator.geolocation.getCurrentPosition(function (p) { best = p; finish(); }, finish, { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 });
        return;
      }
      timer = setTimeout(finish, 10000);
      msg("Getting GPS fix\u2026", "info");
      try { watch = navigator.geolocation.watchPosition(take, function (e) { if (e && e.code === 1) finish(); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }); }
      catch (_) { finish(); }
    });
  }
  async function update(list, to) {
    if (busy || flushing || !authorized) return;
    busy = true; controls();
    try {
      var reason = "", rows = R.overlay(data.parcels, jobs()), errors = R.validate(list, to, "temporary", rows);
      if (errors.length) throw new Error("Nothing submitted. " + errors.join("; "));
      if (to === "Refused" || to === "Consignee not available") {
        reason = await confirm(to, "Record what actually happened at this stop.", ["No answer on call", "Not at address", "Address not found", "Customer refused", "Asked to try later"]); if (!reason) return;
      } else if (["Delivered", "Return to shipper", "Arrived at warehouse"].includes(to)) {
        var p = rows.find(function (r) { return r.awb.toUpperCase() === list[0]; });
        if (!await confirm(LABELS[to], to === "Delivered" ? p.awb + ": confirm the parcel was received and you collected exactly " + money(payment(p).collectable) + "." : "Confirm physical handover of " + list.join(", ") + ".")) return;
      }
      var location = to === "Delivered" ? await gps() : null;
      await save({ kind: "status", list: list, to: to, reason: reason, location: location });
      if (location && location.unavailable) msg("Delivery saved on this phone without GPS. Server confirmation is still pending.", "info");
      else if (location && location.accuracy > 100) msg("Delivery saved. GPS was weak (\u00b1" + location.accuracy + " m), so the office sees the location as approximate.", "info");
      if (to === "Parcel received at destination") q("receiveAwbs").value = "";
    } catch (e) { msg(String(e.message || e), "error"); }
    finally { busy = false; render(); void flush(); }
  }
  async function swapAction(awb, outcome) {
    if (busy || flushing || !authorized) return;
    busy = true; controls();
    try {
      var p = data.parcels.find(function (x) { return x.awb.toUpperCase() === String(awb).toUpperCase(); });
      if (!p) throw new Error("Parcel not found on your route. Refresh.");
      var pair = p.meta.swapPairAwb || "";
      var reason = "";
      if (outcome === "exchanged") {
        if (!await confirm("Exchange done?", "1. Take the old item and put it in a bag.\n2. Stick return label " + pair + " on it, or write " + pair + " on the bag.\n3. Hand over the new item.\n\nConfirm only when you have the old item in your hand.")) return;
      } else {
        reason = await confirm("Exchange did not happen", "Keep the new item. It goes back to the merchant.", ["Customer does not have the old item", "Customer changed their mind", "Customer not available", "Address not found"]);
        if (!reason) return;
      }
      var location = outcome === "exchanged" ? await gps() : null;
      await save({ kind: "swap", awb: p.awb, outcome: outcome, reason: reason === true ? "" : reason, location: location });
    } catch (e) { msg(String(e.message || e), "error"); }
    finally { busy = false; render(); void flush(); }
  }
  q("expenseForm").onsubmit = async function (e) {
    e.preventDefault(); if (busy || flushing) return; busy = true; controls();
    try {
      var amount = Number(q("expenseAmount").value);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) throw new Error("Enter an amount from Rs 0.01 to Rs 100,000, with at most two decimal places.");
      await save({ kind: "expense", amount: amount, category: q("expenseCategory").value, note: q("expenseNote").value.trim() }, "expenseResult");
      q("expenseAmount").value = ""; q("expenseNote").value = "";
    } catch (err) { msg(String(err.message || err), "error", "expenseResult"); }
    finally { busy = false; render(); void flush(); }
  };
  q("depositCashBtn").onclick = async function () {
    if (busy || flushing || jobs().length || !connected || !navigator.onLine) return;
    busy = true; controls();
    try {
      var r = await sb.rpc("rider_cash_summary"); if (r.error) throw r.error; data.cash = r.data;
      if (!data.cash.count || data.cash.review) throw new Error("No reconciled cash is available. Contact the office.");
      var c = data.cash;
      if (!await confirm("Confirm physical cash handover", "Confirm you physically handed " + money(c.net) + " to the office. Gross COD " + money(c.gross) + ", less unsettled expenses " + money(c.expenses) + ". This does not transfer money. The office must confirm receipt.")) return;
      await save({ kind: "deposit", gross: c.gross, expenses: c.expenses, net: c.net }, "cashResult");
    } catch (e) { msg(String(e.message || e), "error", "cashResult"); }
    finally { busy = false; render(); void flush(); }
  };
  q("receiveBtn").onclick = function () { void update(R.awbs(q("receiveAwbs").value), "Parcel received at destination"); };
  q("receiveAwbs").oninput = function () { q("receiveLoadCount").textContent = R.awbs(q("receiveAwbs").value).length + " AWBs loaded"; };
  q("riderSearch").oninput = applySearch;
  q("refreshBtn").onclick = function () { void load(false); };
  q("retryBtn").onclick = function () { if (authorized) void load(false); else void boot(); };
  document.addEventListener("click", async function (e) {
    var retry = e.target.closest("[data-retry]");
    if (retry) { if (busy || flushing || !authorized) return; try { await lock(function () { queue.change(retry.dataset.retry,{state:"pending",error:""}); }); render(); void flush(); } catch (err) { msg(String(err.message || err),"error"); } return; }
    var sw = e.target.closest("[data-swap]"); if (sw) { if (!sw.disabled) void swapAction(sw.dataset.awb, sw.dataset.swap); return; }
    var action = e.target.closest("[data-action]"); if (action) { if (!action.disabled) void update([action.dataset.awb.toUpperCase()], action.dataset.action); return; }
    var view = e.target.closest("[data-view]");
    if (view) { document.querySelectorAll(".view").forEach(function (el) { el.classList.toggle("hidden", el.id !== "view-" + view.dataset.view); }); document.querySelectorAll(".navbtn").forEach(function (b) { b.classList.toggle("active", b === view); if (b === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); }); window.scrollTo(0, 0); return; }
    var station = e.target.closest("[data-station]"); if (station) { ["transit", "received"].forEach(function (s) { q("station-" + s).classList.toggle("hidden", station.dataset.station !== s); }); document.querySelectorAll("[data-station]").forEach(function (b) { b.classList.toggle("active", b === station); b.setAttribute("aria-pressed", String(b === station)); }); return; }
    var copy = e.target.closest("[data-copy]"); if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); msg("Address copied.", "ok"); } catch (_) { msg("Copy unavailable on this phone. Use Navigate or Call.", "error"); } }
  });
  /* LIVE SCANNING. The old button only took one photo at a time: point,
     shoot, wait, repeat -- forty times for a bag of forty. This keeps the
     camera open and adds every new AWB it sees, with a buzz for each, until
     Done. "find" mode reads one code and jumps to that parcel. Falls back to
     the photo picker where the camera or BarcodeDetector is missing
     (iPhone Safari), and a keyboard scanner still types into the box. */
  var scanSession = null;
  function scanFormats() {
    return BarcodeDetector.getSupportedFormats().then(function (supported) {
      return ["code_128", "code_39", "ean_13", "qr_code"].filter(function (f) { return supported.includes(f); });
    });
  }
  function awbFrom(raw) {
    var v = String(raw || "").trim();
    var m = v.match(/[?&]awb=([A-Za-z0-9-]{3,50})/); if (m) v = m[1];
    return /^[a-z0-9-]{3,50}$/i.test(v) ? v.toUpperCase() : "";
  }
  function beep() {
    try {
      var A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      var ctx = beep.ctx || (beep.ctx = new A()), o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 1400; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.07);
    } catch (_) {}
  }
  function stopScan() {
    if (!scanSession) return;
    var sess = scanSession; scanSession = null;
    clearInterval(sess.loop);
    try { sess.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
    if (sess.ov && sess.ov.parentNode) sess.ov.parentNode.removeChild(sess.ov);
    if (sess.mode === "list" && sess.found.length) msg(sess.found.length + " AWB" + (sess.found.length === 1 ? "" : "s") + " scanned. Check the list, then Mark received.", "ok");
  }
  async function startScan(mode) {
    if (scanSession) return;
    if (!window.BarcodeDetector || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (mode === "list" && window.BarcodeDetector) { q("scanFile").click(); return; }
      msg("Camera scanning is not available in this browser. Type the AWB; a keyboard scanner also works.", "info");
      (mode === "list" ? q("receiveAwbs") : q("riderSearch")).focus(); return;
    }
    var formats;
    try { formats = await scanFormats(); } catch (_) { formats = []; }
    if (!formats.length) { msg("This phone cannot read barcodes. Type the AWB.", "info"); return; }
    var stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
    catch (e) {
      if (mode === "list") { msg("Camera permission was not given. Take a photo of the barcode instead.", "info"); q("scanFile").click(); }
      else msg("Camera permission was not given. Type the AWB to search.", "info");
      return;
    }
    var ov = document.createElement("div"); ov.className = "scan-ov"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "Barcode scanner");
    ov.innerHTML = '<video playsinline muted autoplay></video><div class="scan-frame" aria-hidden="true"></div>' +
      '<div class="scan-panel"><p class="scan-status">' + (mode === "list" ? "Point at each AWB barcode. Every new one is added." : "Point at the AWB barcode.") + '</p>' +
      '<p class="scan-list"></p><div class="actions"><button class="btn" type="button" data-scan-done>' + (mode === "list" ? "Done" : "Cancel") + '</button></div></div>';
    document.body.appendChild(ov);
    var video = ov.querySelector("video"); video.srcObject = stream;
    try { await video.play(); } catch (_) {}
    var detector = new BarcodeDetector({ formats: formats }), busyDetect = false;
    scanSession = { mode: mode, stream: stream, ov: ov, found: [], loop: null };
    ov.querySelector("[data-scan-done]").onclick = stopScan;
    scanSession.loop = setInterval(async function () {
      var sess = scanSession; if (!sess || busyDetect || video.readyState < 2) return;
      busyDetect = true;
      try {
        var codes = await detector.detect(video);
        codes.map(function (c) { return awbFrom(c.rawValue); }).filter(Boolean).forEach(function (awb) {
          if (!scanSession || sess.found.indexOf(awb) > -1) return;
          sess.found.push(awb); beep(); try { if (navigator.vibrate) navigator.vibrate(40); } catch (_) {}
          if (mode === "find") {
            q("riderSearch").value = awb; applySearch(); stopScan();
            var hit = Array.from(document.querySelectorAll(".view:not(.hidden) [data-search]")).find(function (c) { return !c.hidden; });
            if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: "center" });
            ping(hit ? awb + " found" : awb + " is not on this screen. Check the other tabs.", hit ? "ok" : "info");
            return;
          }
          q("receiveAwbs").value = R.awbs(q("receiveAwbs").value + "\n" + awb).join("\n"); q("receiveAwbs").oninput();
          ov.querySelector(".scan-status").textContent = sess.found.length + " scanned. Keep going, or tap Done.";
          ov.querySelector(".scan-list").textContent = sess.found.slice(-4).reverse().join("  \u00b7  ");
        });
      } catch (_) {}
      busyDetect = false;
    }, 250);
  }
  q("scanBtn").onclick = function () { void startScan("list"); };
  if (q("searchScanBtn")) q("searchScanBtn").onclick = function () { void startScan("find"); };
  document.addEventListener("visibilitychange", function () { if (document.hidden) stopScan(); });
  q("scanFile").onchange = async function () {
    var file = q("scanFile").files[0], bitmap; if (!file) return;
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error("Photo is too large. Use a closer, smaller photo or type the AWB.");
      var supported = await BarcodeDetector.getSupportedFormats(), formats = ["code_128", "code_39", "ean_13", "qr_code"].filter(function (f) { return supported.includes(f); });
      if (!formats.length) throw new Error("Supported barcode formats are unavailable. Type the AWB.");
      bitmap = await createImageBitmap(file); var found = await new BarcodeDetector({ formats: formats }).detect(bitmap);
      var values = found.map(function (b) { return b.rawValue; }).filter(function (v) { return /^[a-z0-9-]{3,50}$/i.test(v); });
      if (!values.length) throw new Error("No AWB barcode found. Try a clear photo or type the AWB.");
      q("receiveAwbs").value = R.awbs(q("receiveAwbs").value + "\n" + values.join("\n")).join("\n"); q("receiveAwbs").oninput();
    } catch (e) { msg(String(e.message || e), "error"); } finally { if (bitmap) bitmap.close(); q("scanFile").value = ""; }
  };
  q("logoutBtn").onclick = async function () {
    if (busy || flushing) { msg("Wait for the current action before signing out.", "info"); return; }
    try {
      if (jobs().length && !await confirm("Saved actions remain", "Some actions are not confirmed. They stay attached to this rider on this phone and cannot send under another rider. Contact the office before clearing browser data. Sign out?")) return;
      var r = await sb.auth.signOut({ scope: "local" }); if (r.error) throw r.error;
      localStorage.removeItem(cacheKey); authorized = false; location.replace("index.html#signin");
    } catch (e) { msg("Sign-out failed: " + String(e.message || e), "error"); }
  };
  async function boot() {
    try {
      if (!sb || !R || !P) throw new Error("A required app file did not load. Reconnect and reload.");
      var s = await sb.auth.getSession(); if (s.error) throw s.error; if (!s.data.session) { location.replace("index.html#signin"); return; }
      userId = s.data.session.user.id;
      var profile = await sb.from("profiles").select("role,status,rider_id").eq("id", userId).single();
      if (profile.error && !navigator.onLine) {
        var remembered = JSON.parse(localStorage.getItem("novaxRiderIdentity:" + userId) || "null");
        if (remembered && remembered.user === userId && Date.now()-remembered.at < 864e5) profile = { data: remembered.profile };
      }
      if (profile.error) throw profile.error;
      if (!profile.data || String(profile.data.role).toLowerCase() !== "rider" || String(profile.data.status).toLowerCase() !== "active" || !profile.data.rider_id) throw new Error("This account is not an active rider. Contact the office.");
      riderId = profile.data.rider_id; queue = new R.Queue(localStorage, userId, riderId); cacheKey = "novaxRiderRoute:v2:" + userId + ":" + riderId; jobs(); authorized = true;
      if (navigator.onLine) { try { localStorage.setItem("novaxRiderIdentity:" + userId,JSON.stringify({user:userId,at:Date.now(),profile:profile.data})); } catch (_) {} }
      try { var cached = JSON.parse(localStorage.getItem(cacheKey) || "null"); if (cached && cached.user === userId && cached.rider === riderId) { data = cached.data; data.cash = null; lastSync = cached.at; render(); q("gate").classList.add("hidden"); } } catch (_) {}
      if (localStorage.getItem("novaxRiderQueue")) msg("Legacy saved updates exist on this phone. The office must review them; they will not be sent under an unverified rider.", "error");
      if (authSubscription) authSubscription.unsubscribe();
      authSubscription = sb.auth.onAuthStateChange(function (event, session) {
        if (event === "SIGNED_OUT" || session && session.user.id !== userId) {
          authorized = false; connected = false; data = { rider: null, parcels: [], clients: {}, cash: null };
          q("gate").classList.remove("hidden"); failGate("Your session changed. Sign in again.");
          if (channel) { void sb.removeChannel(channel); channel = null; }
          try { localStorage.removeItem(cacheKey); localStorage.removeItem("novaxRiderIdentity:" + userId); } catch (_) {} controls();
        }
      }).data.subscription;
      await load(true);
    } catch (e) { authorized = false; failGate(String(e.message || e)); }
  }
  window.addEventListener("online", function () { void load(true); });
  window.addEventListener("offline", function () { connected = false; controls(); });
  window.addEventListener("storage", function (e) { if (queue && e.key === queue.key && authorized) render(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { paintNetwork(); void load(true); } });
  setInterval(function () { paintNetwork(); if (!document.hidden && authorized && !busy && !flushing) void load(true); }, 60000);
  if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("nosw")) navigator.serviceWorker.register("/sw.js").catch(function () { msg("Offline app files could not be saved. Avoid reloading without signal.", "error"); });
  void boot();
})();
