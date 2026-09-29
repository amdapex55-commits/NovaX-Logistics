(function () {
  "use strict";
  /* ═══ City rider app (29 Sep 2026) ═══════════════════════════════════════
     One rider IS the city. Three jobs, three buttons:
       Pickup   -- collect from shippers in my city; receive batches from others
       Delivery -- take parcels at my station out, then Delivered / Reattempt / Refused
       Transit  -- send parcels at my station that belong to another city, as a batch
     Everything comes from rider_station_view() and goes back through
     rider_station_action(): the server decides what is legal for this rider's
     cities. Actions are saved on the phone first (offline-safe, one key per
     action, replayed until the server answers). */
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
  var userId, riderId, queue, cacheKey, authSubscription, lastSync = 0, connected = false;
  var busy = false, loading = false, flushing = false, authorized = false, retryTimer = null, retryDelay = 0;
  var data = { rider: null, parcels: [], batches: [], cash: null };
  var ui = { view: "home", tab: { pickup: "collect", delivery: "station" }, sel: new Set(), selScope: "", transitTo: "" };

  /* ---- words: English / Roman Urdu -------------------------------------- */
  var LANG = "en";
  try { LANG = localStorage.getItem("novaxRiderLang") === "ur" ? "ur" : "en"; } catch (_) {}
  var TXT = {
    pickup: ["Parcel Pickup", "Parcel Uthana"], delivery: ["Parcel Delivery", "Parcel Delivery"], transit: ["Parcel Transit", "Doosre Shehar Bhejna"],
    home: ["Home", "Home"], navPickup: ["Pickup", "Uthana"], navDelivery: ["Delivery", "Delivery"], navTransit: ["Transit", "Bhejna"], navCash: ["Cash", "Cash"],
    collectTab: ["Collect from shippers", "Shipper se lena"], receiveTab: ["Receive batch", "Aaya hua maal"],
    stationTab: ["At station", "Station par"], outTab: ["Out now", "Rastay mein"], doneToday: ["Delivered today", "Aaj deliver hue"],
    attention: ["Needs attention", "Dhyan dein"], transitHelp: ["Parcels at your station that belong to another city. Send them together as one batch.", "Yeh parcel doosre shehar ke hain. Sab ek batch mein bhejein."],
    sentBatches: ["Batches sent", "Bheje gaye batch"], cash: ["Cash reconciliation", "Cash hisaab"], method: ["How was it sent?", "Kaise bheja?"], txn: ["Transaction ID", "Transaction ID"],
    handover: ["Record today's cash handover", "Aaj ka cash jama karwaya"], cashToHand: ["Cash to hand over", "Jama karwana hai"], awaitingOffice: ["Awaiting office confirmation", "Office ki tasdeeq baqi"],
    confirmedCash: ["Confirmed cash · recent", "Tasdeeq shuda cash"], expenses: ["Route expenses", "Kharchay"], clear: ["Clear", "Hatao"],
    collectN: ["Mark {n} collected", "{n} parcel utha liye"], receiveN: ["Mark {n} received", "{n} parcel mil gaye"], outN: ["Take {n} out for delivery", "{n} delivery ke liye nikale"],
    sendN: ["Send {n} to {city}", "{n} parcel {city} bhejo"], delivered: ["Delivered", "Deliver ho gaya"], reattempt: ["Reattempt", "Dobara jana"],
    refused: ["Refused", "Mana kar diya"], notAvailable: ["Not available", "Nahi mila"], returned: ["Returned to shipper", "Shipper ko wapis de diya"],
    selectAll: ["Select all", "Sab chuno"], nothing: ["Nothing here.", "Yahan kuch nahi."], call: ["Call", "Call"], directions: ["Directions", "Rasta"],
    saved: ["Saved on phone — sending…", "Phone par save — bhej rahe hain…"], attempts: ["attempt", "koshish"], toCollect: ["to collect", "uthane hain"],
    incoming: ["coming in", "aa rahe hain"], atStation: ["at station", "station par"], outNow: ["out now", "rastay mein"], toSend: ["to send", "bhejne hain"],
    exchange: ["Exchange done", "Exchange ho gaya"], cantExchange: ["Can’t exchange", "Exchange nahi hua"]
  };
  function t(k, vars) { var s = (TXT[k] || [k, k])[LANG === "ur" ? 1 : 0]; if (vars) Object.keys(vars).forEach(function (v) { s = s.replace("{" + v + "}", vars[v]); }); return s; }
  function paintWords() {
    document.querySelectorAll("[data-t]").forEach(function (el) { el.textContent = t(el.getAttribute("data-t")); });
    q("langBtn").textContent = LANG === "ur" ? "English" : "Urdu";
    document.documentElement.lang = LANG === "ur" ? "ur-Latn" : "en";
  }

  function q(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(v) { return "Rs " + Number(v || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 }); }
  function today() { return R.day(new Date()); }
  function msg(text, type, id) { var el = q(id || "notice"); el.className = "notice show " + (type || "info"); el.textContent = text; }
  function failGate(text) {
    q("gateSpin").classList.add("hidden"); q("gateTitle").textContent = "Station unavailable";
    q("gateText").textContent = text; q("retryBtn").classList.remove("hidden"); q("loginLink").classList.remove("hidden");
  }
  function jobs() { return queue ? queue.read() : []; }
  function key(prefix) { return prefix + "-" + riderId + "-" + crypto.randomUUID(); }
  function lock(fn) {
    if (!navigator.locks) return Promise.reject(new Error("Update this browser before saving rider actions. Secure local locking is unavailable."));
    return navigator.locks.request(queue.key, fn);
  }
  var toastTimer = null;
  function ping(text, type, buzz) {
    var el = q("riderToast");
    if (!el) { el = document.createElement("div"); el.id = "riderToast"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite"); document.body.appendChild(el); }
    el.className = "rider-toast show " + (type || "info"); el.textContent = text;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.className = "rider-toast " + (type || "info"); }, type === "error" ? 6000 : 3200);
    try { if (buzz && navigator.vibrate) navigator.vibrate(buzz); } catch (_) {}
  }
  function paintNetwork() {
    q("network").textContent = !navigator.onLine ? "Offline" : connected ? "Connected" : "Connection unverified";
    q("network").style.color = connected && navigator.onLine ? "#087854" : "#a72d24";
    var waiting = queue ? jobs().filter(function (j) { return j.state !== "review"; }).length : 0;
    if (waiting) q("network").textContent += " · " + waiting + " saved, waiting to send";
    q("lastSync").textContent = lastSync ? "Synced " + Math.max(0, Math.floor((Date.now() - lastSync) / 60000)) + " min ago" : "Not synced yet";
  }
  function paintQueue() {
    var list = jobs(), review = list.filter(function (j) { return j.state === "review"; });
    q("queueNote").className = "notice";
    if (list.length) msg(list.length + " saved action(s): " + review.length + " need office review. Keep this phone's data until all actions are confirmed.", review.length ? "error" : "info", "queueNote");
    q("queueReview").innerHTML = review.map(function (j) {
      return '<article class="parcel"><b>Not confirmed: ' + esc(j.action || j.to || j.kind) + '</b><p>' + esc((j.list || [j.awb]).join(", ")) + ' ' + esc(j.error || "Office review required") + '</p><small>Reference ' + esc(j.key) + '</small><div class="actions"><button class="btn secondary" data-write data-retry="' + esc(j.key) + '">Retry saved action</button></div></article>';
    }).join("");
  }
  function controls() {
    document.querySelectorAll("[data-write]").forEach(function (b) { b.disabled = busy || flushing || !authorized || b.hasAttribute("data-blocked"); });
    q("depositCashBtn").disabled = busy || flushing || !authorized || !connected || !navigator.onLine || !data.cash || !data.cash.count || jobs().length > 0 || data.cash.review;
    q("refreshBtn").disabled = loading || busy || flushing; paintNetwork();
  }
  function payment(p) { return P.classify({ cod: p.cod, paymentMode: p.meta.paymentMode || p.meta.payment_mode }); }

  /* ---- parcels ----------------------------------------------------------- */
  function pendingAwbs() {
    var s = new Set();
    jobs().forEach(function (j) { if (j.state !== "review") (j.list || (j.awb ? [j.awb] : [])).forEach(function (a) { s.add(String(a).toUpperCase()); }); });
    return s;
  }
  function inBucket(b) { return data.parcels.filter(function (p) { return p.bucket === b; }); }
  function isReturn(p) { return /return/i.test(p.status) || (p.status === "Ready for return"); }
  function where(p) {
    /* The people a rider meets for this parcel: the shipper for a pickup or a
       return going home, the customer for everything else. */
    var s = p.shipper || {};
    if (p.bucket === "pickup" || /^Return (received|out)/.test(p.status)) return { name: s.name || "Shipper", phone: s.phone || "", address: s.address || "", city: p.origin };
    var pc = p.meta.pickupContact;
    return { name: p.consignee, phone: p.phone, address: p.address, city: p.city, alt: pc };
  }
  function card(p, opts) {
    opts = opts || {};
    var c = where(p), pend = pendingAwbs().has(p.awb.toUpperCase()), pay = payment(p);
    var call = R.phone(c.phone), validPhone = /^\+?\d{9,15}$/.test(call);
    var sel = opts.select ? '<input type="checkbox" class="pick" data-pick="' + esc(p.awb) + '"' + (ui.sel.has(p.awb) ? " checked" : "") + (pend ? " disabled" : "") + ' aria-label="Select ' + esc(p.awb) + '">' : "";
    var tag = p.meta.swapLeg === "out" ? '<p class="swaptag">NOVA SWAP · collect the old item' + (p.meta.swapPairAwb ? ' · return AWB <b>' + esc(p.meta.swapPairAwb) + '</b>' : '') + '</p>' :
              p.meta.swapLeg === "back" ? '<p class="swaptag back">NOVA SWAP RETURN · going back to the merchant</p>' :
              isReturn(p) ? '<p class="swaptag back">RETURN · going back to ' + esc(p.shipper && p.shipper.name || "the shipper") + '</p>' : "";
    var money2 = p.cod > 0 ? (pay.conflict ? '<span class="error-text">COD/prepaid conflict — marked Prepaid. Call the office.</span>' : "COD " + money(p.cod)) : "Prepaid · collect nothing";
    var att = Number(p.attempts || 0), attTxt = att ? (att + " " + t("attempts") + (att > 1 ? (LANG === "ur" ? "" : "s") : "")) : "";
    var route = (p.origin || "") + " → " + (p.city || "");
    var ageD = Math.floor((Date.now() - R.timestamp(p.statusSince)) / 864e5);
    var age = isFinite(ageD) && ageD >= 1 ? (ageD + (LANG === "ur" ? " din" : (ageD === 1 ? " day" : " days"))) : "";
    var body = '<div class="parcel-head">' + sel + '<b class="awb">' + esc(p.awb) + '</b><span class="status">' + esc(p.status) + '</span></div>' + tag +
      '<p><b>' + esc(c.name || "Name not recorded") + '</b><br>' + esc(c.address || "Address missing. Call the office.") + (c.phone ? '<br>' + esc(c.phone) : "") + '</p>' +
      '<p class="meta-line">' + esc(route) + (age ? ' · <b class="' + (ageD >= 3 ? 'age-old' : '') + '">' + esc(age) + '</b>' : '') + (attTxt ? ' · ' + esc(attTxt) : '') + (p.meta.weight ? ' · ' + esc(p.meta.weight) : '') + (p.exception ? ' · ' + esc(p.exception) : '') + '</p>' +
      (p.heldBy && p.bucket === "out" ? '<p class="meta-line">Was with ' + esc(p.heldBy) + ' — now yours</p>' : '') +
      '<div class="moneyline">' + money2 + '</div>';
    if (opts.contacts && validPhone) {
      var wa = call.replace(/^\+/, "");
      body += '<div class="contacts"><a class="call" href="tel:' + esc(call) + '">' + esc(t("call")) + '</a><a class="call" href="https://wa.me/' + esc(wa) + '" target="_blank" rel="noopener">WhatsApp</a>' +
        (c.address ? '<a class="call" href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.address + ", " + (c.city || "")) + '" target="_blank" rel="noopener">' + esc(t("directions")) + '</a>' : '') + '</div>';
    }
    if (pend) body += '<p class="pending-label">' + esc(t("saved")) + '</p>';
    else if (opts.outcomes) body += '<div class="actions">' + outcomeButtons(p, pay) + '</div>';
    var search = [p.awb, c.name, c.phone, c.address, p.city, p.origin, p.consignee].join(" ").toLowerCase();
    return '<article class="parcel' + (pend ? ' pending' : '') + (ui.sel.has(p.awb) ? ' picked' : '') + '" data-awb="' + esc(p.awb) + '" data-search="' + esc(search) + '">' + body + '</article>';
  }
  function outcomeButtons(p, pay) {
    if (p.meta.swapLeg === "out" && p.status === "Parcel out for delivery")
      return '<button class="btn" data-write data-swap="exchanged" data-awb="' + esc(p.awb) + '">' + esc(t("exchange")) + '</button><button class="btn secondary" data-write data-swap="failed" data-awb="' + esc(p.awb) + '">' + esc(t("cantExchange")) + '</button>';
    if (p.status === "Return out for delivery")
      return '<button class="btn" data-write data-act="delivered" data-awb="' + esc(p.awb) + '">' + esc(t("returned")) + '</button><button class="btn secondary" data-write data-act="not_available" data-awb="' + esc(p.awb) + '">' + esc(t("notAvailable")) + '</button>';
    var att = Number(p.attempts || 0);
    return '<button class="btn" data-write data-act="delivered" data-awb="' + esc(p.awb) + '"' + (pay.conflict ? ' data-blocked disabled' : '') + '>' + esc(t("delivered")) + '</button>' +
      (att < 3 ? '<button class="btn secondary" data-write data-act="reattempt" data-awb="' + esc(p.awb) + '">' + esc(t("reattempt")) + '</button>' : '') +
      '<button class="btn danger" data-write data-act="refused" data-awb="' + esc(p.awb) + '">' + esc(t("refused")) + '</button>' +
      '<button class="btn secondary" data-write data-act="not_available" data-awb="' + esc(p.awb) + '">' + esc(t("notAvailable")) + '</button>' +
      (att >= 3 ? '<p class="sla-note">3 attempts done. Mark Refused so it goes back.</p>' : '');
  }
  function empty() { return '<p class="empty">' + esc(t("nothing")) + '</p>'; }
  function selectAllBtn(scope, awbs) {
    if (!awbs.length) return "";
    return '<button class="btn secondary selall" type="button" data-selall="' + esc(scope) + '" data-awbs="' + esc(awbs.join(",")) + '">' + esc(t("selectAll")) + ' (' + awbs.length + ')</button>';
  }

  /* ---- render ------------------------------------------------------------ */
  function render() {
    if (!data.rider) return;
    paintWords();
    var cities = (data.rider.cities || []).join(" + ") || "No city set";
    q("riderName").textContent = data.rider.name || "My station";
    q("routeName").textContent = cities;
    var pick = inBucket("pickup"), inc = inBucket("incoming"), st = inBucket("station"), out = inBucket("out"), tr = inBucket("transit"), done = inBucket("done");
    var pend = pendingAwbs(), free = function (list) { return list.filter(function (p) { return !pend.has(p.awb.toUpperCase()); }); };
    q("homePickup").textContent = pick.length + " " + t("toCollect") + " · " + inc.length + " " + t("incoming");
    q("homeDelivery").textContent = st.length + " " + t("atStation") + " · " + out.length + " " + t("outNow");
    q("homeTransit").textContent = tr.length + " " + t("toSend");
    var deliveredToday = done.filter(function (p) { return R.day(R.deliveredAt(p)) === today(); });
    q("stats").innerHTML = stat("Delivered today", deliveredToday.length) + stat("Out now", out.length) + stat("Cash to hand over", data.cash ? money(data.cash.net) : "Unavailable", true) + stat("City", cities);
    var attn = st.filter(function (p) { return Number(p.attempts || 0) >= 2 || p.status === "Refused"; }).concat(out.filter(function (p) { return payment(p).conflict; }));
    q("attentionList").innerHTML = attn.map(function (p) { return card(p); }).join("") || '<p class="empty">All clear.</p>';

    // Pickup: grouped by shipper
    var groups = {};
    pick.forEach(function (p) { var k = p.client_id || "?"; (groups[k] = groups[k] || []).push(p); });
    q("collectList").innerHTML = Object.keys(groups).map(function (k) {
      var list = groups[k], s = list[0].shipper || {}, ph = R.phone(s.phone);
      return '<section class="shipper"><div class="shipper-head"><div><b>' + esc(s.name || "Shipper") + '</b><small>' + esc(s.address || "") + '</small></div>' +
        (/^\+?\d{9,15}$/.test(ph) ? '<a class="call" href="tel:' + esc(ph) + '">' + esc(t("call")) + '</a>' : '') + '</div>' +
        selectAllBtn("collect", free(list).map(function (p) { return p.awb; })) + list.map(function (p) { return card(p, { select: true }); }).join("") + '</section>';
    }).join("") || empty();

    // Receive: batches + parcels coming in
    var myCities = (data.rider.cities || []).map(function (c) { return c.toLowerCase(); });
    var batches = (data.batches || []).filter(function (b) { return myCities.indexOf(String(b.to_city).toLowerCase()) > -1; });
    q("batchList").innerHTML = batches.map(function (b) {
      var got = (b.received || []).length, all = (b.awbs || []).length;
      var awaiting = (b.awbs || []).filter(function (a) { return (b.received || []).indexOf(a) < 0; });
      return '<article class="parcel batch"><div class="parcel-head"><b>' + esc(b.code) + '</b><span class="status">' + esc(b.status) + '</span></div><p>' + esc(b.from_city) + ' → ' + esc(b.to_city) + ' · ' + esc(b.reference || "") + '<br>' + got + ' / ' + all + ' received</p>' +
        selectAllBtn("receive", awaiting.filter(function (a) { return inc.some(function (p) { return p.awb === a && !pend.has(a); }); })) + '</article>';
    }).join("");
    q("receiveList").innerHTML = (inc.length ? selectAllBtn("receive", free(inc).map(function (p) { return p.awb; })) : "") + (inc.map(function (p) { return card(p, { select: true }); }).join("") || empty());

    // Delivery
    /* Real data, 29 Sep: 15 refusals in Lahore up to 16 days old, 13 in
       Islamabad/Rawalpindi up to 21 days, mixed in with parcels that arrived
       today. Ready-to-deliver first; refusals after, oldest first, so a
       rider building today's run does not scroll past a fortnight of
       "Refused". */
    var waitingOn = function (p) { return p.status === "Refused" || p.status === "Consignee not available"; };
    var ready = st.filter(function (p) { return !waitingOn(p); });
    var stuck = st.filter(waitingOn).sort(function (x, y) { return R.timestamp(x.statusSince) - R.timestamp(y.statusSince); });
    q("stationList").innerHTML = (st.length ? "" : empty()) +
      (ready.length ? '<h3 class="grp">' + esc(LANG === "ur" ? "Deliver karne ke liye tayyar" : "Ready to deliver") + " (" + ready.length + ")</h3>" + selectAllBtn("station", free(ready).map(function (p) { return p.awb; })) + ready.map(function (p) { return card(p, { select: true, contacts: true }); }).join("") : "") +
      (stuck.length ? '<h3 class="grp">' + esc(LANG === "ur" ? "Mana / nahi mila — shipper ke faislay ka intezar" : "Refused or not available — waiting for the shipper") + " (" + stuck.length + ")</h3>" + stuck.map(function (p) { return card(p, { select: true, contacts: true }); }).join("") : "");
    q("outList").innerHTML = out.map(function (p) { return card(p, { outcomes: true, contacts: true }); }).join("") || empty();
    q("doneList").innerHTML = deliveredToday.map(function (p) { return card(p); }).join("") || empty();

    // Transit: grouped by where it is going
    var tg = {};
    tr.forEach(function (p) { var to = p.status === "Ready for return" ? p.origin : p.city; var k = (p.status === "Ready for return" ? "R:" : "F:") + to; (tg[k] = tg[k] || []).push(p); });
    q("transitGroups").innerHTML = Object.keys(tg).sort().map(function (k) {
      var list = tg[k], to = k.slice(2), ret = k[0] === "R", ids = free(list).map(function (p) { return p.awb; });
      return '<section class="shipper"><div class="shipper-head"><div><b>' + (ret ? "Returns to " : "To ") + esc(to) + ' (' + list.length + ')</b></div>' +
        (ids.length ? '<button class="btn" type="button" data-write data-sendall="' + esc(to) + '" data-awbs="' + esc(ids.join(",")) + '">' + esc(t("sendN", { n: ids.length, city: to })) + '</button>' : '') + '</div>' +
        list.map(function (p) { return card(p, { select: true }); }).join("") + '</section>';
    }).join("") || empty();
    q("sentList").innerHTML = (data.batches || []).filter(function (b) { return b.from_city && myCities.indexOf(String(b.from_city).toLowerCase()) > -1; }).map(function (b) {
      return '<article class="parcel batch"><div class="parcel-head"><b>' + esc(b.code) + '</b><span class="status">' + esc(b.status) + '</span></div><p>To ' + esc(b.to_city) + ' · ' + esc(b.reference || "") + ' · ' + (b.awbs || []).length + ' parcels</p></article>';
    }).join("") || empty();

    renderCash(); paintView(); applySearch(); paintQueue(); paintBar(); controls();
    document.querySelectorAll("[data-blocked]").forEach(function (b) { b.disabled = true; });
  }
  function stat(label, value, cash) { return '<div class="stat' + (cash ? ' money' : '') + '"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>'; }
  function renderCash() {
    var cash = data.cash;
    var mine = data.parcels.filter(function (p) { return p.status === "Delivered" && p.cod > 0 && p.rider_id === riderId; });
    q("cashHero").innerHTML = cash ? '<div class="cash-grid">' + stat("Delivered COD", money(cash.gross)) + stat("Unsettled expenses", money(cash.expenses)) + stat("Net to hand over", money(cash.net), true) + stat("Awaiting office", money(cash.pending)) + '</div>' + (cash.review ? '<p class="error-text">Expenses need office review before handover.</p>' : '') : '<p class="sub">Cash service unavailable.</p>';
    if (cash && data.rider && Number(data.rider.cash_limit) > 0 && cash.gross > Number(data.rider.cash_limit)) q("cashHero").insertAdjacentHTML("beforeend", '<p class="error-text">Cash is over your limit of ' + money(data.rider.cash_limit) + '. Hand it over today.</p>');
    q("cashList").innerHTML = mine.filter(function (p) { return !R.truth(p.meta.cashReceived) && p.meta.cashDepositStatus !== "pending_confirmation"; }).map(function (p) { return card(p); }).join("") || empty();
    q("cashPendingList").innerHTML = mine.filter(function (p) { return p.meta.cashDepositStatus === "pending_confirmation"; }).map(function (p) { return card(p); }).join("") || empty();
    q("cashHistoryList").innerHTML = mine.filter(function (p) { return R.truth(p.meta.cashReceived); }).map(function (p) { return card(p); }).join("") || empty();
    q("expenseList").innerHTML = (cash && cash.expense_rows || []).map(function (e) { return '<article class="parcel"><b>' + esc(e.category) + ' &middot; ' + money(e.amount) + '</b><p>' + esc(e.note) + '</p><small>' + esc(e.expenseDate) + (R.truth(e.settled) ? ' &middot; Settled' : ' &middot; Unsettled') + '</small></article>'; }).join("") || empty();
  }
  function paintView() {
    document.querySelectorAll(".view").forEach(function (el) { el.classList.toggle("hidden", el.id !== "view-" + ui.view); });
    document.querySelectorAll(".navbtn").forEach(function (b) { var on = b.dataset.view === ui.view; b.classList.toggle("active", on); if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    q("searchRow").classList.toggle("hidden", ["pickup", "delivery", "transit"].indexOf(ui.view) < 0);
    q("pickupCollect").classList.toggle("hidden", ui.tab.pickup !== "collect"); q("pickupReceive").classList.toggle("hidden", ui.tab.pickup !== "receive");
    q("deliveryStation").classList.toggle("hidden", ui.tab.delivery !== "station"); q("deliveryOut").classList.toggle("hidden", ui.tab.delivery !== "out");
    document.querySelectorAll("[data-tab]").forEach(function (b) { var p = b.dataset.tab.split(":"), on = ui.tab[p[0]] === p[1]; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
  }
  /* What a selection means depends on the screen it was made on. */
  function scopeNow() {
    if (ui.view === "pickup") return ui.tab.pickup === "collect" ? "collect" : "receive";
    if (ui.view === "delivery" && ui.tab.delivery === "station") return "station";
    if (ui.view === "transit") return "transit";
    return "";
  }
  function paintBar() {
    var scope = scopeNow();
    if (ui.selScope && ui.selScope !== scope) { ui.sel.clear(); ui.selScope = ""; }
    var n = ui.sel.size, bar = q("actionBar");
    if (!n || !scope) { bar.classList.add("hidden"); document.body.classList.remove("has-bar"); return; }
    var label = scope === "collect" ? t("collectN", { n: n }) : scope === "receive" ? t("receiveN", { n: n }) : scope === "station" ? t("outN", { n: n }) : "";
    if (scope === "transit") {
      var to = transitTarget(Array.from(ui.sel));
      label = to ? t("sendN", { n: n, city: to }) : "Pick parcels for one city";
    }
    q("actionGo").textContent = label; q("actionInfo").textContent = n + " selected";
    q("actionGo").disabled = busy || flushing || !authorized || (scope === "transit" && !transitTarget(Array.from(ui.sel)));
    bar.classList.remove("hidden"); document.body.classList.add("has-bar");
  }
  function transitTarget(awbs) {
    var tos = new Set(), kinds = new Set();
    awbs.forEach(function (a) { var p = data.parcels.find(function (x) { return x.awb === a; }); if (p) { tos.add(p.status === "Ready for return" ? p.origin : p.city); kinds.add(p.status === "Ready for return"); } });
    return tos.size === 1 && kinds.size === 1 ? Array.from(tos)[0] : "";
  }
  /* Cards on the screen the rider is looking at: not the other tab's panel. */
  function shownCards() {
    return Array.from(document.querySelectorAll(".view:not(.hidden) [data-search]")).filter(function (c) { return !c.hidden && !c.closest(".hidden"); });
  }
  function applySearch() {
    var raw = q("riderSearch").value.trim().toLowerCase(), digits = raw.replace(/\D/g, "");
    document.querySelectorAll(".view:not(.hidden) .list").forEach(function (el) {
      var cards = el.querySelectorAll("[data-search]"), visible = 0;
      cards.forEach(function (c) {
        var awb = String(c.dataset.awb || "").toLowerCase();
        var show = !raw || c.dataset.search.includes(raw) || (digits.length >= 3 && awb.replace(/\D/g, "").endsWith(digits));
        c.hidden = !show; if (show) visible++;
      });
      var prev = el.querySelector(".search-empty"); if (prev) prev.remove();
      if (cards.length && !visible) { var n = document.createElement("p"); n.className = "empty search-empty"; n.textContent = "No matching parcels."; el.appendChild(n); }
    });
  }

  /* ---- load -------------------------------------------------------------- */
  async function identity() {
    var s = await sb.auth.getSession(); if (s.error) throw s.error;
    if (!s.data.session || s.data.session.user.id !== userId) throw new Error("Rider session changed. Sign in again before sending updates.");
  }
  async function load(silent) {
    if (loading || busy || flushing || !authorized) return;
    loading = true; controls();
    try {
      await identity();
      var pr = await sb.from("profiles").select("role,status,rider_id").eq("id", userId).single();
      if (pr.error) throw pr.error;
      if (!pr.data || String(pr.data.role).toLowerCase() !== "rider" || String(pr.data.status).toLowerCase() !== "active" || pr.data.rider_id !== riderId) { authorized = false; throw new Error("Rider access changed. Sign in again or contact the office."); }
      var v = await sb.rpc("rider_station_view"); if (v.error) throw v.error;
      var cash = await sb.rpc("rider_cash_summary");
      await identity();
      var view = v.data || {};
      data = { rider: view.rider || { name: "Rider", cities: [] }, parcels: (view.parcels || []).map(function (p) {
          var m = R.mapParcel(p); m.bucket = p.bucket; m.origin = p.origin || "Karachi"; m.attempts = Number(p.attempts || 0);
          m.shipper = p.shipper || null; m.exception = p.exception || ""; m.rider_id = p.rider_id; m.client_id = p.client_id; m.heldBy = p.held_by || ""; return m;
        }), batches: view.batches || [], cash: cash.error ? null : cash.data };
      connected = true; lastSync = Date.now();
      try { localStorage.setItem(cacheKey, JSON.stringify({ user: userId, rider: riderId, at: lastSync, data: data })); }
      catch (_) { msg("This phone cannot save the station for offline use. Do not reload without signal.", "error"); }
      q("gate").classList.add("hidden"); render();
      if (!(data.rider.cities || []).length) msg("No city is set on your rider account. Ask the office to set it.", "error");
      else if (cash.error) msg("Cash services are unavailable. Handover is disabled; contact the office.", "error");
      else if (!silent) msg("Station refreshed.", "ok");
    } catch (e) {
      connected = false;
      if (!authorized) { q("gate").classList.remove("hidden"); failGate(String(e.message || e)); }
      else if (!data.rider) failGate(String(e.message || e));
      else msg("Refresh failed. Showing your last saved station: " + String(e.message || e), "error");
    } finally { loading = false; controls(); if (connected) void flush(); }
  }

  /* ---- save + send ------------------------------------------------------- */
  async function save(job, id) {
    await lock(function () {
      var pending = jobs();
      if (pending.some(function (j) {
        if (j.kind !== job.kind || j.state === "review") return false;
        if (job.kind === "swap") return j.awb === job.awb;
        if (job.kind === "station") return j.action === job.action && JSON.stringify(j.list) === JSON.stringify(job.list);
        return job.kind !== "status" || j.to === job.to && JSON.stringify(j.list) === JSON.stringify(job.list);
      })) throw new Error("This action is already saved. Reconnect or ask the office to review it; do not submit it twice.");
      queue.add(Object.assign(job, { key: key(job.kind), at: new Date().toISOString(), state: "pending" }));
    });
    render(); msg("Saved on this phone. Awaiting server confirmation.", "info", id);
    ping(navigator.onLine ? "Saved — sending to NovaX…" : "Saved on this phone. It will send when you are back online.", "info", 30);
  }
  var DONE_WORDS = { collect: "collected", receive: "received", out: "out for delivery", delivered: "delivered", reattempt: "set for reattempt", refused: "marked refused", not_available: "marked not available", transit: "sent" };
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
          if (j.kind === "station") { name = "rider_station_action"; args = { p_awbs: j.list, p_action: j.action, p_reason: j.reason || "", p_key: j.key, p_loc: j.location || null, p_extra: j.extra || {} }; }
          else if (j.kind === "swap") { name = "rider_swap_complete"; args = { p_out_awb: j.awb, p_outcome: j.outcome, p_reason: j.reason || "", p_key: j.key, p_loc: j.location || null }; }
          else if (j.kind === "status") { name = "rider_batch_update_status"; args = { p_awbs: j.list, p_to: j.to, p_reason: j.reason || "", p_batch_key: j.key, p_delivery_loc: j.location || null }; }
          else if (j.kind === "expense") { name = "rider_add_expense"; args = { p_key: j.key, p_category: j.category, p_amount: j.amount, p_note: j.note }; }
          else if (j.kind === "deposit") { name = "rider_deposit_cash_v2"; args = { p_batch_key: j.key, p_expected_gross: j.gross, p_expected_expenses: j.expenses, p_expected_net: j.net, p_method: j.method, p_reference: j.reference || "" }; }
          else throw new Error("Unknown saved action. Contact the office.");
          var response;
          try { response = await sb.rpc(name, args); } catch (e) { response = { error: e }; }
          if (response.error) {
            connected = false;
            if (R.retryable(response.error)) {
              msg("Connection interrupted. The same saved reference will retry; do not repeat the action.", "info");
              retryDelay = Math.min(60000, retryDelay ? retryDelay * 2 : 5000);
              clearTimeout(retryTimer); retryTimer = setTimeout(function () { void flush(); }, retryDelay);
              break;
            }
            queue.change(j.key, { state: "review", error: String(response.error.message || response.error) });
            msg("Action rejected. Its reference is kept for office review: " + String(response.error.message || response.error), "error");
            ping("Not accepted: " + String(response.error.message || response.error).slice(0, 140), "error", [120]); break;
          }
          if (!response.data || (j.kind === "station" || j.kind === "status") && !Array.isArray(response.data.moved)) { queue.change(j.key, { state: "review", error: "Unexpected server acknowledgement; office must check this reference." }); break; }
          await identity(); queue.remove(j.key); connected = true; changed = true; retryDelay = 0;
          if (j.kind === "station") ping("✓ " + response.data.count + " parcel" + (response.data.count === 1 ? "" : "s") + " " + (DONE_WORDS[j.action] || "saved") + (response.data.batch ? " · batch " + response.data.batch : ""), "ok", [40, 60, 40]);
          else if (j.kind === "swap") ping(j.outcome === "exchanged" ? "✓ Exchange done — new item delivered, old item collected (" + (response.data.back_awb || "") + ")" : "✓ Recorded: exchange did not happen. Bring the new item back.", "ok", [40, 60, 40]);
          else if (j.kind === "expense") ping("✓ Expense recorded", "ok", [40, 60, 40]);
          if (j.kind === "deposit") msg(money(response.data.net) + " handover recorded (" + (j.method || "") + "). Awaiting office confirmation. Ref " + j.key, "ok", "cashResult");
        }
      });
    } catch (e) { connected = false; msg(String(e.message || e), "error"); }
    finally { flushing = false; render(); if (changed) void load(true); }
  }

  /* ---- dialogs ----------------------------------------------------------- */
  function confirm(title, text, reasons, extra) {
    return new Promise(function (resolve) {
      var dialog = q("actionDialog"), input = q("reasonOther"), ex = q("extraInput");
      q("dialogTitle").textContent = title; q("dialogText").textContent = text; q("dialogError").textContent = ""; input.value = ""; ex.value = extra && extra.value || "";
      q("reasonLabel").classList.toggle("hidden", !reasons);
      q("extraLabel").classList.toggle("hidden", !extra); if (extra) { q("extraLabelText").textContent = extra.label; ex.placeholder = extra.placeholder || ""; }
      q("reasonPresets").innerHTML = (reasons || []).map(function (r) { return '<button class="btn secondary" type="button" data-reason="' + esc(r) + '">' + esc(r) + '</button>'; }).join("");
      q("reasonPresets").onclick = function (e) { var b = e.target.closest("[data-reason]"); if (b) input.value = b.dataset.reason; };
      dialog.querySelector("form").onsubmit = function (e) {
        if (e.submitter && e.submitter.value === "confirm") {
          if (reasons && !input.value.trim()) { e.preventDefault(); q("dialogError").textContent = "Choose or enter a reason."; return; }
          if (extra && extra.required && ex.value.trim().length < (extra.min || 1)) { e.preventDefault(); q("dialogError").textContent = extra.error || "Fill this in."; return; }
        }
      };
      dialog.returnValue = "cancel";
      dialog.onclose = function () {
        var ok = dialog.returnValue === "confirm";
        resolve(!ok ? null : (extra ? { reason: input.value.trim(), extra: ex.value.trim() } : (input.value.trim() || true)));
        dialog.onclose = null;
      };
      dialog.showModal();
    });
  }
  /* Best GPS reading within 10 s, stopping early at 25 m. */
  function gps() {
    return new Promise(function (resolve) {
      var at = new Date().toISOString();
      if (!navigator.geolocation) { resolve({ unavailable: true, at: at }); return; }
      var best = null, done = false, watch = null, timer = null;
      function out(p) { return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), at: at }; }
      function finish() { if (done) return; done = true; clearTimeout(timer); if (watch != null) { try { navigator.geolocation.clearWatch(watch); } catch (_) {} } resolve(best ? out(best) : { unavailable: true, at: at }); }
      function take(p) { if (!p || !p.coords) return; if (!best || p.coords.accuracy < best.coords.accuracy) best = p; if (best.coords.accuracy <= 25) finish(); else msg("Getting GPS fix… ±" + Math.round(best.coords.accuracy) + " m", "info"); }
      if (typeof navigator.geolocation.watchPosition !== "function") { navigator.geolocation.getCurrentPosition(function (p) { best = p; finish(); }, finish, { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }); return; }
      timer = setTimeout(finish, 10000); msg("Getting GPS fix…", "info");
      try { watch = navigator.geolocation.watchPosition(take, function (e) { if (e && e.code === 1) finish(); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }); } catch (_) { finish(); }
    });
  }

  /* ---- actions ----------------------------------------------------------- */
  async function station(list, action, reason, extra, location) {
    await save({ kind: "station", list: list.map(function (a) { return String(a).toUpperCase(); }).sort(), action: action, reason: reason || "", extra: extra || {}, location: location || null });
  }
  async function runBar() {
    if (busy || flushing || !authorized) return;
    var scope = scopeNow(), list = Array.from(ui.sel);
    if (!list.length) return;
    busy = true; controls();
    try {
      if (scope === "collect") await station(list, "collect");
      else if (scope === "receive") await station(list, "receive");
      else if (scope === "station") await station(list, "out");
      else if (scope === "transit") await sendTransit(list);
      else return;
      ui.sel.clear(); ui.selScope = "";
    } catch (e) { msg(String(e.message || e), "error"); }
    finally { busy = false; render(); void flush(); }
  }
  async function sendTransit(list) {
    var to = transitTarget(list); if (!to) throw new Error("Pick parcels going to one city.");
    var res = await confirm(t("sendN", { n: list.length, city: to }), "Enter the bus or courier reference (bilty number) for this batch.", null,
      { label: "Bilty / reference", placeholder: "e.g. Daewoo 123456", required: true, min: 2, error: "Enter the bilty or courier reference." });
    if (!res) throw new Error("Not sent.");
    await station(list, "transit", "", { to_city: to, reference: res.extra });
  }
  async function outcome(awb, action) {
    if (busy || flushing || !authorized) return;
    busy = true; controls();
    try {
      var p = data.parcels.find(function (x) { return x.awb === awb; }); if (!p) throw new Error("Parcel not found. Refresh.");
      var reason = "", extra = {}, location = null;
      if (action === "delivered") {
        var what = p.status === "Return out for delivery" ? "Confirm " + p.awb + " was handed back to the shipper." :
          p.awb + ": confirm the customer received it and you collected exactly " + money(payment(p).collectable) + ".";
        if (!await confirm(p.status === "Return out for delivery" ? t("returned") : t("delivered"), what)) return;
        location = await gps();
      } else if (action === "reattempt") {
        var tom = new Date(Date.now() + 864e5); var d = tom.toISOString().slice(0, 10);
        var r = await confirm(t("reattempt"), "Why is it coming back to the station, and when to try again?", ["Customer asked for tomorrow", "Phone off", "Not at home", "Address incomplete"],
          { label: "Next try (YYYY-MM-DD)", value: d, required: true, min: 8, error: "Enter the next date." });
        if (!r) return; reason = r.reason; extra = { next_date: r.extra };
      } else if (action === "refused") {
        reason = await confirm(t("refused"), "What did the customer say?", ["Customer refused", "Wrong item ordered", "No money", "Fake order"]); if (!reason) return;
      } else if (action === "not_available") {
        reason = await confirm(t("notAvailable"), "What happened at this stop?", ["No answer on call", "Not at address", "Address not found", "Shop closed"]); if (!reason) return;
      }
      await station([awb], action, reason === true ? "" : reason, extra, location);
      if (location && location.unavailable) msg("Saved without GPS. Server confirmation is still pending.", "info");
      else if (location && location.accuracy > 100) msg("Saved. GPS was weak (±" + location.accuracy + " m), so the office sees the location as approximate.", "info");
    } catch (e) { msg(String(e.message || e), "error"); }
    finally { busy = false; render(); void flush(); }
  }
  async function swapAction(awb, result) {
    if (busy || flushing || !authorized) return;
    busy = true; controls();
    try {
      var p = data.parcels.find(function (x) { return x.awb.toUpperCase() === String(awb).toUpperCase(); });
      if (!p) throw new Error("Parcel not found. Refresh.");
      var pair = p.meta.swapPairAwb || "", reason = "";
      if (result === "exchanged") {
        if (!await confirm("Exchange done?", "1. Take the old item and put it in a bag.\n2. Stick return label " + pair + " on it, or write " + pair + " on the bag.\n3. Hand over the new item.\n\nConfirm only when you have the old item in your hand.")) return;
      } else {
        reason = await confirm("Exchange did not happen", "Keep the new item. It goes back to the merchant.", ["Customer does not have the old item", "Customer changed their mind", "Customer not available", "Address not found"]);
        if (!reason) return;
      }
      var location = result === "exchanged" ? await gps() : null;
      await save({ kind: "swap", awb: p.awb, outcome: result, reason: reason === true ? "" : reason, location: location });
    } catch (e) { msg(String(e.message || e), "error"); }
    finally { busy = false; render(); void flush(); }
  }
  /* A scanned or typed AWB lands where it belongs: selected if it is on this
     screen, otherwise the rider is told where it is (or that it is not his). */
  function locate(awb) {
    awb = String(awb || "").toUpperCase();
    var scope = scopeNow(), p = data.parcels.find(function (x) { return x.awb.toUpperCase() === awb; });
    var fits = { collect: "pickup", receive: "incoming", station: "station", transit: "transit" }[scope];
    if (!p) { ping(awb + " is not on your station. Check the city on the label.", "error", [120]); return false; }
    if (pendingAwbs().has(awb)) { ping(awb + " is already saved.", "info"); return false; }
    if (fits && p.bucket === fits) {
      ui.sel.add(p.awb); ui.selScope = scope; render();
      var el = document.querySelector('[data-awb="' + p.awb + '"]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
      ping("✓ " + p.awb + " selected (" + ui.sel.size + ")", "ok", 30); return true;
    }
    var place = { pickup: "Pickup → Collect", incoming: "Pickup → Receive batch", station: "Delivery → At station", out: "Delivery → Out now", transit: "Transit", done: "Delivered" }[p.bucket] || p.status;
    ping(p.awb + " is in " + place + " (" + p.status + ").", "info"); return false;
  }

  /* ---- scanning ---------------------------------------------------------- */
  var scanSession = null;
  function awbFrom(raw) { var v = String(raw || "").trim(); var m = v.match(/[?&]awb=([A-Za-z0-9-]{3,50})/); if (m) v = m[1]; return /^[a-z0-9-]{3,50}$/i.test(v) ? v.toUpperCase() : ""; }
  function beep() { try { var A = window.AudioContext || window.webkitAudioContext; if (!A) return; var ctx = beep.ctx || (beep.ctx = new A()), o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 1400; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.07); } catch (_) {} }
  function stopScan() {
    if (!scanSession) return; var s = scanSession; scanSession = null; clearInterval(s.loop);
    try { s.stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (_) {}
    if (s.ov && s.ov.parentNode) s.ov.parentNode.removeChild(s.ov);
  }
  async function startScan() {
    if (scanSession) return;
    if (!window.BarcodeDetector || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (window.BarcodeDetector) { q("scanFile").click(); return; }
      msg("Camera scanning is not available on this phone. Type the last 4 digits of the AWB in the box and press Enter.", "info"); q("riderSearch").focus(); return;
    }
    var formats = []; try { var sup = await BarcodeDetector.getSupportedFormats(); formats = ["code_128", "code_39", "ean_13", "qr_code"].filter(function (f) { return sup.includes(f); }); } catch (_) {}
    if (!formats.length) { msg("This phone cannot read barcodes. Type the last 4 digits instead.", "info"); return; }
    var stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
    catch (_) { msg("Camera permission was not given. Take a photo of the barcode instead.", "info"); q("scanFile").click(); return; }
    var ov = document.createElement("div"); ov.className = "scan-ov"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "Barcode scanner");
    ov.innerHTML = '<video playsinline muted autoplay></video><div class="scan-frame" aria-hidden="true"></div><div class="scan-panel"><p class="scan-status">Point at each AWB barcode.</p><p class="scan-list"></p><div class="actions"><button class="btn" type="button" data-scan-done>Done</button></div></div>';
    document.body.appendChild(ov);
    var video = ov.querySelector("video"); video.srcObject = stream; try { await video.play(); } catch (_) {}
    var detector = new BarcodeDetector({ formats: formats }), working = false, seen = [];
    scanSession = { stream: stream, ov: ov, loop: null };
    ov.querySelector("[data-scan-done]").onclick = stopScan;
    scanSession.loop = setInterval(async function () {
      if (!scanSession || working || video.readyState < 2) return; working = true;
      try {
        (await detector.detect(video)).map(function (c) { return awbFrom(c.rawValue); }).filter(Boolean).forEach(function (awb) {
          if (seen.indexOf(awb) > -1) return; seen.push(awb); beep();
          locate(awb);
          ov.querySelector(".scan-status").textContent = ui.sel.size + " selected. Keep scanning, or tap Done.";
          ov.querySelector(".scan-list").textContent = seen.slice(-4).reverse().join("  ·  ");
        });
      } catch (_) {}
      working = false;
    }, 250);
  }
  q("scanFile").onchange = async function () {
    var file = q("scanFile").files[0], bitmap; if (!file) return;
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error("Photo is too large. Use a closer photo or type the AWB.");
      var sup = await BarcodeDetector.getSupportedFormats(), formats = ["code_128", "code_39", "ean_13", "qr_code"].filter(function (f) { return sup.includes(f); });
      bitmap = await createImageBitmap(file); var found = await new BarcodeDetector({ formats: formats }).detect(bitmap);
      var values = found.map(function (b) { return awbFrom(b.rawValue); }).filter(Boolean);
      if (!values.length) throw new Error("No AWB barcode found. Try a clear photo or type the last 4 digits.");
      values.forEach(locate);
    } catch (e) { msg(String(e.message || e), "error"); } finally { if (bitmap) bitmap.close(); q("scanFile").value = ""; }
  };

  /* ---- events ------------------------------------------------------------ */
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
      var method = q("depositMethod").value, ref = q("depositRef").value.trim();
      if (method !== "Cash to office" && ref.length < 4) throw new Error("Enter the transaction ID from the " + method + " receipt.");
      var r = await sb.rpc("rider_cash_summary"); if (r.error) throw r.error; data.cash = r.data;
      if (!data.cash.count || data.cash.review) throw new Error("No reconciled cash is available. Contact the office.");
      var c = data.cash;
      if (!await confirm("Confirm today's cash handover", "You sent " + money(c.net) + " by " + method + (ref ? " (ref " + ref + ")" : "") + ". Gross COD " + money(c.gross) + ", less expenses " + money(c.expenses) + ". The office confirms receipt.")) return;
      await save({ kind: "deposit", gross: c.gross, expenses: c.expenses, net: c.net, method: method, reference: ref }, "cashResult");
      q("depositRef").value = "";
    } catch (e) { msg(String(e.message || e), "error", "cashResult"); }
    finally { busy = false; render(); void flush(); }
  };
  q("riderSearch").oninput = applySearch;
  q("riderSearch").onkeydown = function (e) {
    if (e.key !== "Enter") return; e.preventDefault();
    var raw = q("riderSearch").value.trim(); if (!raw) return;
    applySearch();
    var digits = raw.replace(/\D/g, ""), up = raw.toUpperCase();
    var exact = data.parcels.find(function (p) { return p.awb.toUpperCase() === up; });
    if (exact) { if (locate(exact.awb)) q("riderSearch").value = ""; applySearch(); return; }
    if (digits.length >= 3) {
      var hits = shownCards();
      if (hits.length === 1) { if (locate(hits[0].dataset.awb)) q("riderSearch").value = ""; applySearch(); }
      else msg(hits.length ? hits.length + " parcels end in " + digits + ". Type more digits." : "No parcel ends in " + digits + " here.", "info");
    }
  };
  q("scanBtn").onclick = function () { void startScan(); };
  q("refreshBtn").onclick = function () { void load(false); };
  q("retryBtn").onclick = function () { if (authorized) void load(false); else void boot(); };
  q("langBtn").onclick = function () { LANG = LANG === "ur" ? "en" : "ur"; try { localStorage.setItem("novaxRiderLang", LANG); } catch (_) {} render(); paintWords(); };
  q("actionGo").onclick = function () { void runBar(); };
  q("actionClear").onclick = function () { ui.sel.clear(); ui.selScope = ""; render(); };
  document.addEventListener("change", function (e) {
    var cb = e.target.closest && e.target.closest("[data-pick]"); if (!cb) return;
    var awb = cb.dataset.pick;
    if (cb.checked) { ui.sel.add(awb); ui.selScope = scopeNow(); } else ui.sel.delete(awb);
    var card2 = cb.closest(".parcel"); if (card2) card2.classList.toggle("picked", cb.checked);
    paintBar(); controls();
  });
  document.addEventListener("click", async function (e) {
    var retry = e.target.closest("[data-retry]");
    if (retry) { if (busy || flushing || !authorized) return; try { await lock(function () { queue.change(retry.dataset.retry, { state: "pending", error: "" }); }); render(); void flush(); } catch (err) { msg(String(err.message || err), "error"); } return; }
    var sw = e.target.closest("[data-swap]"); if (sw) { if (!sw.disabled) void swapAction(sw.dataset.awb, sw.dataset.swap); return; }
    var act = e.target.closest("[data-act]"); if (act) { if (!act.disabled) void outcome(act.dataset.awb, act.dataset.act); return; }
    var all = e.target.closest("[data-selall]");
    if (all) { String(all.dataset.awbs || "").split(",").filter(Boolean).forEach(function (a) { ui.sel.add(a); }); ui.selScope = scopeNow(); render(); return; }
    var send = e.target.closest("[data-sendall]");
    if (send) {
      if (busy || flushing || !authorized) return;
      ui.sel = new Set(String(send.dataset.awbs || "").split(",").filter(Boolean)); ui.selScope = "transit";
      busy = true; controls();
      try { await sendTransit(Array.from(ui.sel)); ui.sel.clear(); ui.selScope = ""; }
      catch (err) { if (String(err.message) !== "Not sent.") msg(String(err.message || err), "error"); }
      finally { busy = false; render(); void flush(); }
      return;
    }
    var tab = e.target.closest("[data-tab]");
    if (tab) { var p = tab.dataset.tab.split(":"); ui.tab[p[0]] = p[1]; ui.sel.clear(); ui.selScope = ""; render(); return; }
    var view = e.target.closest("[data-view]");
    if (view) { ui.view = view.dataset.view; ui.sel.clear(); ui.selScope = ""; q("riderSearch").value = ""; render(); window.scrollTo(0, 0); return; }
  });
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
        if (remembered && remembered.user === userId && Date.now() - remembered.at < 864e5) profile = { data: remembered.profile };
      }
      if (profile.error) throw profile.error;
      if (!profile.data || String(profile.data.role).toLowerCase() !== "rider" || String(profile.data.status).toLowerCase() !== "active" || !profile.data.rider_id) throw new Error("This account is not an active rider. Contact the office.");
      riderId = profile.data.rider_id; queue = new R.Queue(localStorage, userId, riderId); cacheKey = "novaxRiderStation:v1:" + userId + ":" + riderId; jobs(); authorized = true;
      if (navigator.onLine) { try { localStorage.setItem("novaxRiderIdentity:" + userId, JSON.stringify({ user: userId, at: Date.now(), profile: profile.data })); } catch (_) {} }
      try { var cached = JSON.parse(localStorage.getItem(cacheKey) || "null"); if (cached && cached.user === userId && cached.rider === riderId) { data = cached.data; data.cash = null; lastSync = cached.at; render(); q("gate").classList.add("hidden"); } } catch (_) {}
      if (localStorage.getItem("novaxRiderQueue")) msg("Legacy saved updates exist on this phone. The office must review them; they will not be sent under an unverified rider.", "error");
      if (authSubscription) authSubscription.unsubscribe();
      authSubscription = sb.auth.onAuthStateChange(function (event, session) {
        if (event === "SIGNED_OUT" || session && session.user.id !== userId) {
          authorized = false; connected = false; data = { rider: null, parcels: [], batches: [], cash: null };
          q("gate").classList.remove("hidden"); failGate("Your session changed. Sign in again.");
          try { localStorage.removeItem(cacheKey); localStorage.removeItem("novaxRiderIdentity:" + userId); } catch (_) {} controls();
        }
      }).data.subscription;
      await load(true);
      if (!connected && data.rider) msg("Offline. Showing your last saved station.", "error");
    } catch (e) { authorized = false; failGate(String(e.message || e)); }
  }
  window.addEventListener("online", function () { void load(true); });
  window.addEventListener("offline", function () { connected = false; controls(); });
  window.addEventListener("storage", function (e) { if (queue && e.key === queue.key && authorized) render(); });
  document.addEventListener("visibilitychange", function () { if (document.hidden) stopScan(); else { paintNetwork(); void load(true); } });
  setInterval(function () { paintNetwork(); if (!document.hidden && authorized && !busy && !flushing) void load(true); }, 60000);
  if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("nosw")) navigator.serviceWorker.register("/sw.js").catch(function () { msg("Offline app files could not be saved. Avoid reloading without signal.", "error"); });
  paintWords();
  void boot();
})();
