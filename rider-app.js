(function () {
  "use strict";
  /* ═══ City rider app (29 Sep 2026) ═══════════════════════════════════════
     One rider IS the city. Three jobs, three buttons:
       Pickup   -- collect from shippers in my city, and nothing else
       Delivery -- receive what arrives from other cities, take parcels at my
                   station out, then Delivered / Reattempt / Refused
       Transit  -- send parcels at my station that belong to another city, as a batch
     Everything comes from rider_station_view() and goes back through
     rider_station_action(): the server decides what is legal for this rider's
     cities. Actions are saved on the phone first (offline-safe, one key per
     action, replayed until the server answers). */
  var R = window.NovaXRider, P = window.NovaXPayment;
  /* ═══ PREVIEW (?demo=1) ═════════════════════════════════════════════════
     The rider app with sample data and no sign-in, to show a new rider or a
     partner what it looks like. Same rule as the merchant portal's demo:
     there is no account and no connection to NovaX at all. The "server" is
     an object in this page's memory (demoClient, below), so a real station
     can be neither read nor changed, and nothing is kept on the phone.
     Everything about it is inert unless ?demo is in the address. */
  var DEMO = (function () { try { return new URLSearchParams(location.search).has("demo"); } catch (_) { return /[?&]demo\b/.test(location.search); } })();
  var store = DEMO ? (function () { var m = {}; return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } }; })() : (function () { try { return window.localStorage; } catch (_) { return null; } })();
  var sb = DEMO ? demoClient() : window.supabase && window.supabase.createClient(
    "https://rhzunbzbdzicajqtohwp.supabase.co", "sb_publishable_yH8i0Q43BAxXoExo95r0rQ_fCeRdHXA",
    { global: { fetch: async function (url, options) {
      var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 20000);
      var source = options && options.signal;
      function abort() { controller.abort(); }
      if (source) { if (source.aborted) abort(); else source.addEventListener("abort", abort, { once: true }); }
      try { return await fetch(url, Object.assign({}, options, { signal: controller.signal })); }
      finally { clearTimeout(timer); if (source) source.removeEventListener("abort", abort); }
    } } });
  if (sb && !DEMO) window.NovaXRiderClient = sb;   /* rider.html's Instant check uses this one client */
  var userId, riderId, queue, cacheKey, authSubscription, lastSync = 0, lastFull = 0, stampOff = false, checking = false, connected = false;
  var busy = false, loading = false, flushing = false, authorized = false, retryTimer = null, retryDelay = 0;
  var data = { rider: null, parcels: [], batches: [], cash: null };
  var ui = { view: "home", tab: { delivery: "station" }, sel: new Set(), selScope: "", transitTo: "", openBatch: {} };

  /* ---- words: English / Roman Urdu -------------------------------------- */
  var LANG = "en";
  try { LANG = localStorage.getItem("novaxRiderLang") === "ur" ? "ur" : "en"; } catch (_) {}
  var TXT = {
    pickup: ["Parcel Pickup", "Parcel Uthana"], delivery: ["Parcel Delivery", "Parcel Delivery"], transit: ["Parcel Transit", "Doosre Shehar Bhejna"],
    home: ["Home", "Home"], navProcess: ["Process", "Kaam"], procTitle: ["Process parcels", "Parcel process karein"], procHelp: ["Type, paste or scan tracking numbers. The N is optional and the commas go in by themselves.", "Tracking number likhein, paste ya scan karein. N zaroori nahi, comma khud lag jata hai."], navPickup: ["Pickup", "Uthana"], navDelivery: ["Delivery", "Delivery"], navTransit: ["Transit", "Bhejna"], navCash: ["Cash", "Cash"],
    receiveTab: ["Arriving", "Aane wale"],
    pickupHelp: ["Parcels to collect from shippers in {city}.", "{city} ke shippers se uthane wale parcel."],
    receiveHelp: ["On their way to your station from another city. Mark them received when they reach you.", "Doosre shehar se aap ke station aa rahe hain. Pohanchne par received lagayein."],
    wrongCity: ["This address looks like {looks}, not {city}. Do not go. Tell the office.", "Yeh address {looks} ka lagta hai, {city} ka nahi. Mat jayein. Office ko batayein."],
    stationTab: ["At station", "Station par"], outTab: ["Out now", "Rastay mein"], doneToday: ["Delivered today", "Aaj deliver hue"],
    attention: ["Needs attention", "Dhyan dein"], waitShipper: ["{n} refused / not available are waiting for the shipper’s decision. Nothing to do now.", "{n} mana / nahi mila parcel shipper ke faislay ke intezar mein hain. Abhi kuch nahi karna."],
    seeThem: ["See them", "Dekhein"], notTaken: ["Not accepted by NovaX", "NovaX ne qabool nahi kiya"], tryAgain: ["Try again", "Dobara bhejein"], removeIt: ["Remove", "Hata dein"],
    cashWaitSend: ["Waiting for your saved deliveries to reach NovaX. The handover opens after they send.", "Aap ki saved deliveries NovaX ko ja rahi hain. Us ke baad cash jama kar sakte hain."],
    cashOffline: ["No internet. Connect to record the handover.", "Internet nahi hai. Cash jama karne ke liye internet on karein."], todayList: ["What you marked today", "Aaj aap ne kya lagaya"], noneToday: ["Nothing marked yet today.", "Aaj abhi kuch nahi lagaya."],
    voiceSent: ["Voice note sent", "Voice note bhej diya"], voiceSkipped: ["Mic blocked", "Mic band tha"], voiceMissing: ["No voice note", "Voice note nahi"], transitHelp: ["Parcels at your station that belong to another city. Send them together as one batch.", "Yeh parcel doosre shehar ke hain. Sab ek batch mein bhejein."],
    sentBatches: ["Batches sent", "Bheje gaye batch"], cash: ["Cash reconciliation", "Cash hisaab"], method: ["How was it sent?", "Kaise bheja?"], txn: ["Transaction ID", "Transaction ID"],
    handover: ["Record today's cash handover", "Aaj ka cash jama karwaya"], cashToHand: ["Cash to hand over", "Jama karwana hai"], awaitingOffice: ["Awaiting office confirmation", "Office ki tasdeeq baqi"],
    confirmedCash: ["Confirmed cash · recent", "Tasdeeq shuda cash"], expenses: ["Route expenses", "Kharchay"], clear: ["Clear", "Hatao"],
    collectN: ["Mark {n} collected", "{n} parcel utha liye"], receiveN: ["Mark {n} received", "{n} parcel mil gaye"], outN: ["Take {n} out for delivery", "{n} delivery ke liye nikale"],
    sendN: ["Send {n} to {city}", "{n} parcel {city} bhejo"], delivered: ["Delivered", "Deliver ho gaya"], reattempt: ["Reattempt", "Dobara jana"],
    refused: ["Refused", "Mana kar diya"], notAvailable: ["Not available", "Nahi mila"], returned: ["Returned to shipper", "Shipper ko wapis de diya"],
    selectAll: ["Select all", "Sab chuno"], nothing: ["Nothing here.", "Yahan kuch nahi."], call: ["Call", "Call"], directions: ["Directions", "Rasta"],
    saved: ["Saved on phone — sending…", "Phone par save — bhej rahe hain…"], attempts: ["attempt", "koshish"], toCollect: ["to collect", "uthane hain"],
    incoming: ["arriving", "aane wale"], atStation: ["at station", "station par"], outNow: ["out now", "rastay mein"], toSend: ["to send", "bhejne hain"],
    exchange: ["Exchange done", "Exchange ho gaya"], cantExchange: ["Can’t exchange", "Exchange nahi hua"],
    voiceTitle: ["Voice note for the shipper", "Shipper ke liye awaaz ka paigham"],
    voiceAsk: ["Tell the shipper what happened at the door. Up to 60 seconds.", "Shipper ko batayein darwaze par kya hua. 60 second tak."],
    voiceTapStart: ["Tap to record", "Record karein"], voiceTapStop: ["Tap to stop", "Rokein"],
    voiceAgain: ["Record again", "Dobara record"], voiceSend: ["Send voice note", "Paigham bhejein"],
    voiceRetryMic: ["Try again", "Dobara koshish"], voiceSkip: ["Mic blocked, skip", "Mic band, skip"],
    voiceShort: ["Too short. Speak for at least 3 seconds.", "Bohat chhota. Kam az kam 3 second bolein."],
    voiceBig: ["This recording is too large. Record a shorter note.", "Recording bohat bari hai. Chhota paigham record karein."],
    voiceBlocked: ["Your phone blocked the microphone. Allow it for this app (tap the lock icon next to the address, then Microphone), then tap Try again.", "Phone ne mic band kar diya hai. Is app ke liye mic allow karein (address ke saath lock icon, phir Microphone), phir Dobara koshish dabayein."],
    voiceNoMic: ["The microphone could not be started on this phone.", "Is phone par mic shuru nahi ho saka."],
    voiceRecorded: ["Recorded {len}. Listen, then send.", "{len} record hua. Sun kar bhejein."],
    voicePending: ["Voice note waiting to send", "Awaaz ka paigham bhejna baqi hai"], voiceSent: ["Voice note sent", "Awaaz ka paigham chala gaya"],
    voiceSaved: ["Voice note saved. It sends after the parcel update.", "Paigham save ho gaya. Parcel update ke baad jayega."],
    showAwbs: ["Show the {n} tracking numbers", "{n} tracking number dekhein"], stReceived: ["received", "mil gaya"], stSelected: ["ticked", "tick"],
    stWaiting: ["on the way", "raste mein"], stElsewhere: ["not in your list", "aap ki list mein nahi"],
    checkTitle: ["Check the {n} parcels", "{n} parcel check karein"], checkTitle1: ["Check the parcel", "Parcel check karein"],
    checkText: ["Keep the tick on every parcel you have in your hands. Untick any that did not arrive. Only ticked parcels are marked received.", "Jo parcel aap ke haath mein hai us par tick rehne dein. Jo nahi aaya us ka tick hata dein. Sirf tick wale received honge."],
    checkCount: ["{k} of {n} ticked", "{n} mein se {k} par tick"], returnsGroup: ["Returns coming back", "Wapis aane wale"], noBatch: ["Not in a batch", "Batch ke baghair"],
    demoBar: ["Preview with sample data. Nothing here is real, and nothing is saved.", "Yeh sirf namoona hai. Yahan kuch asli nahi, aur kuch save nahi hota."], demoExit: ["Exit", "Band"],
    demoNoCall: ["Preview: calls and WhatsApp are switched off.", "Namoona: call aur WhatsApp band hain."],
    installTitle: ["Add NovaX Rider to your home screen", "NovaX Rider ko home screen par lagayein"], installSub: ["It opens like an app, with one tap.", "App ki tarah ek tap se khulega."],
    installBtn: ["Add", "Lagayein"], installDone: ["NovaX Rider is on your home screen.", "NovaX Rider home screen par lag gaya."],
    installAndroid: ["Tap ⋮ at the top right of Chrome, then “Add to Home screen”. On some phones it says “Install app”. If it is not in the list, tap “Open in Chrome” below and tap Add again there.", "Chrome mein upar dayein ⋮ dabayein, phir “Add to Home screen”. Kuch phones mein “Install app” likha hota hai. Agar list mein na ho to neeche “Chrome mein kholein” dabayein aur wahan dobara Lagayein dabayein."],
    installSamsung: ["Tap ☰ at the bottom right, then “Add page to”, then “Home screen”. Or tap “Open in Chrome” below and tap Add there.", "Neeche dayein ☰ dabayein, phir “Add page to”, phir “Home screen”. Ya neeche “Chrome mein kholein” dabayein aur wahan Lagayein dabayein."],
    installFirefox: ["Tap ⋮, then “Add to Home screen” (or “Install”). Or tap “Open in Chrome” below and tap Add there.", "⋮ dabayein, phir “Add to Home screen” (ya “Install”). Ya neeche “Chrome mein kholein” dabayein aur wahan Lagayein dabayein."],
    installOpera: ["Tap the Opera menu, then “Add to…”, then “Home screen”. Or tap “Open in Chrome” below and tap Add there.", "Opera ka menu dabayein, phir “Add to…”, phir “Home screen”. Ya neeche “Chrome mein kholein” dabayein aur wahan Lagayein dabayein."],
    installEdge: ["Tap ☰ at the bottom, then “Add to phone”. Or tap “Open in Chrome” below and tap Add there.", "Neeche ☰ dabayein, phir “Add to phone”. Ya neeche “Chrome mein kholein” dabayein aur wahan Lagayein dabayein."],
    installOtherAndroid: ["This browser cannot put an app on the home screen. Tap “Open in Chrome” below, then tap Add there.", "Is browser se app home screen par nahi lagti. Neeche “Chrome mein kholein” dabayein, phir wahan Lagayein dabayein."],
    installIos: ["Tap the Share button (the square with an arrow) at the bottom of Safari, then “Add to Home Screen”, then “Add”.", "Safari ke neeche Share button (teer wala dabba) dabayein, phir “Add to Home Screen”, phir “Add”."],
    installIosOther: ["Tap the Share button, then “Add to Home Screen”. If it is not there, open this page in Safari and do the same.", "Share button dabayein, phir “Add to Home Screen”. Agar na ho to yeh page Safari mein kholein aur wahi karein."],
    installDesktop: ["This is made for the rider’s phone. On a computer, click the install icon at the right end of the address bar in Chrome or Edge.", "Yeh rider ke phone ke liye hai. Computer par Chrome ya Edge mein address bar ke dayein kinare install ka nishan dabayein."],
    installReady: ["Ready. Tap Add now.", "Tayyar hai. Ab Lagayein dabayein."], installOpenChrome: ["Open in Chrome", "Chrome mein kholein"],
    gpsWait: ["Getting GPS…", "GPS dhoond rahe hain…"],
    geoOff: ["Location is off for this app, so the office cannot see where you deliver. Turn it on: tap the icon left of the web address, then Permissions, then Location, then Allow. Or phone Settings, Apps, Chrome, Permissions, Location.",
      "Is app ki Location band hai, office ko pata nahi chalta aap ne kahan deliver kiya. On karein: web address ke baayein nishan dabayein, phir Permissions, phir Location, phir Allow. Ya phone Settings, Apps, Chrome, Permissions, Location."],
    routeTitle: ["Today's route", "Aaj ka rasta"], routeSum: ["{n} stops · {km} km", "{n} stop · {km} km"], distToday: ["Distance today", "Aaj ka faasla"],
    routeNote: ["Straight line from each stop to the next. The road is longer. Stops without GPS are not counted.", "Har stop se agle tak seedhi line. Sarak ka rasta lamba hota hai. Baghair GPS wale stop nahi gine jaate."],
    routeMap: ["Open on map", "Map par dekhein"],
    act_delivered: ["Delivered", "Deliver"], act_refused: ["Refused", "Mana"], act_not_available: ["Not available", "Nahi mila"], act_reattempt: ["Reattempt", "Dobara"],
    act_out: ["Took out", "Delivery ke liye nikale"], act_collect: ["Collected", "Uthaye"], act_receive: ["Received", "Station par mile"], act_transit: ["Sent", "Bheje"],
    flag_same: ["same place as the stop before", "pichle stop wali jagah"], flag_weak: ["weak GPS, not counted", "GPS kamzor, nahi gina"],
    flag_nogps: ["no GPS", "GPS nahi"], flag_jump: ["GPS jumped, not counted", "GPS ghalat, nahi gina"],
    shopNote: ["Shop's note", "Shop ka note"], mayOpen: ["May open before paying", "Pay se pehle khol sakta hai"], noOpen: ["Do not open", "Kholne na dein"], fragile: ["Fragile", "Nazuk"]
  };
  function t(k, vars) { var s = (TXT[k] || [k, k])[LANG === "ur" ? 1 : 0]; if (vars) Object.keys(vars).forEach(function (v) { s = s.split("{" + v + "}").join(vars[v]); }); return s; }
  function paintWords() {
    document.querySelectorAll("[data-t]").forEach(function (el) { el.textContent = t(el.getAttribute("data-t")); });
    q("langBtn").textContent = LANG === "ur" ? "English" : "Urdu";
    if (installStepsKey && q("installSteps")) q("installSteps").textContent = t(installStepsKey);
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
    var mins = Math.floor((Date.now() - lastSync) / 60000);
    q("lastSync").textContent = !lastSync ? "Not synced yet" : mins < 1 ? "Up to date" : "Synced " + mins + " min ago";
  }
  function paintQueue() {
    var list = jobs(), review = list.filter(function (j) { return j.state === "review"; });
    q("queueNote").className = "notice";
    var waiting = list.length - review.length;
    if (waiting) msg(waiting === 1 ? "1 action saved on this phone, sending to NovaX…" : waiting + " actions saved on this phone, sending to NovaX…", "info", "queueNote");
    /* 21 Oct 2026 audit: these cards showed a reference code and "office
       review", but the office never saw them. Now they say in plain words
       what NovaX refused and why, and the refusal is logged for the office. */
    q("queueReview").innerHTML = review.map(function (j) {
      var what = DONE_VERB[j.action || j.to] || (j.kind === "expense" ? "Expense" : j.kind === "deposit" ? "Cash handover" : j.kind === "swap" ? "Nova Swap" : "Action");
      var awbs = (j.list || (j.awb ? [j.awb] : [])), why = String(j.error || "").replace(/^[A-Z]\d{6,}:\s*/, "");
      return '<article class="parcel reject"><b>' + esc(t("notTaken")) + '</b><p><b>' + esc(what) + (awbs.length ? ' · ' + esc(awbs.slice(0, 6).join(", ")) + (awbs.length > 6 ? " +" + (awbs.length - 6) : "") : "") + '</b></p><p>' + esc(why || "Ask the office.") + '</p>' +
        '<div class="actions"><button class="btn secondary" data-write data-retry="' + esc(j.key) + '">' + esc(t("tryAgain")) + '</button><button class="btn danger" data-write data-discard="' + esc(j.key) + '">' + esc(t("removeIt")) + '</button></div></article>';
    }).join("");
  }
  /* Saved actions that change what cash the rider holds. Anything else --
     a disputed pickup, a transit batch -- must not freeze the handover. */
  function cashJobs() {
    /* A refused action is not counted by NovaX, so it must not hold the
       handover shut (21 Oct 2026 audit): only actions still sending do. */
    return jobs().filter(function (j) {
      return j.state !== "review" && (j.kind === "deposit" || j.kind === "expense" || (j.kind === "swap" && j.outcome === "exchanged") ||
        (j.kind === "station" && j.action === "delivered") || (j.kind === "status" && j.to === "Delivered"));
    });
  }
  function controls() {
    document.querySelectorAll("[data-write]").forEach(function (b) { b.disabled = busy || flushing || !authorized || b.hasAttribute("data-blocked"); });
    q("depositCashBtn").disabled = busy || flushing || !authorized || !connected || !navigator.onLine || !data.cash || !data.cash.count || cashJobs().length > 0 || data.cash.review;
    var cw = q("cashWhy");
    if (cw) { var why = !data.cash || !data.cash.count ? "" : !navigator.onLine || !connected ? t("cashOffline") : cashJobs().length ? t("cashWaitSend") : ""; cw.textContent = why; cw.classList.toggle("hidden", !why); }
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
  /* The WhatsApp button opens a chat with this message already typed (14 Oct
     2026). A rider writes to a customer mostly to ask where they are, and a
     message from an unknown number asking for a location reads like a scam
     unless it says who is writing, which parcel, from which shop, and what
     is owed. The tracking link lets the customer check that it is real. A
     return goes to the shop, so it says whose parcel is coming back. Written
     in the language the rider has chosen in the app. */
  function waText(p, pay) {
    var ur = LANG === "ur", rider = (data.rider && data.rider.name) || "", shop = (p.shipper && p.shipper.name) || "";
    var m = p.meta || {}, lines;
    if (isReturn(p) || m.swapLeg === "back") {
      lines = ur
        ? ["Assalam o Alaikum! Main " + rider + ", NovaX Logistics se. Aap ka wapis aane wala parcel le kar aa raha hoon.", "Meherbani kar ke yahan WhatsApp par apni location bhej dein.", "",
           "Parcel: " + p.awb, "Customer: " + (p.consignee || "") + (p.city ? ", " + p.city : ""), "Kuch ada nahi karna."]
        : ["Assalam o Alaikum! I am " + rider + " from NovaX Logistics. I am bringing back your returned parcel.", "Please send me your location here on WhatsApp.", "",
           "Parcel: " + p.awb, "Customer: " + (p.consignee || "") + (p.city ? ", " + p.city : ""), "Nothing to pay."];
    } else {
      var cash = pay.conflict ? "" : pay.collectable > 0 ? (ur ? "Ada karne hain: " : "Cash to pay: ") + money(pay.collectable)
        : (ur ? "Pehle se ada ho chuka hai, kuch nahi dena." : "Already paid, nothing to pay.");
      lines = ur
        ? ["Assalam o Alaikum! Main " + rider + ", NovaX Logistics se. Aap ka parcel le kar aa raha hoon.", "Meherbani kar ke yahan WhatsApp par apni location bhej dein taa ke main aap tak pohanch sakoon.", "",
           "Parcel: " + p.awb, shop ? "Bhejne wala: " + shop : "", m.category ? "Saman: " + m.category : "", m.orderId ? "Order: " + m.orderId : "", cash]
        : ["Assalam o Alaikum! I am " + rider + " from NovaX Logistics. I am bringing your parcel.", "Please send me your location here on WhatsApp so I can reach you.", "",
           "Parcel: " + p.awb, shop ? "From: " + shop : "", m.category ? "Contents: " + m.category : "", m.orderId ? "Order: " + m.orderId : "", cash];
      if (m.swapLeg === "out") lines.push(ur ? "Badalne wala purana saman tayyar rakhein." : "Please keep the item you are exchanging ready.");
    }
    lines.push((ur ? "Track: " : "Track it: ") + "https://novaxlogistics.com/tracking.html?awb=" + encodeURIComponent(p.awb));
    return lines.filter(function (x, i) { return x !== "" || i === 2; }).join("\n");
  }
  /* Why the server would refuse to take this parcel out right now. */
  function outLock(p) {
    if (p.bucket !== "station") return "";
    var retry = /^(Refused|Consignee not available|Reattempt|Reassigned|Parcel received at destination)$/.test(p.status);
    if (retry && Number(p.attempts || 0) >= 3) return LANG === "ur" ? "3 dafa ja chuke — office wapsi karega" : "3 attempts done — the office sends it back";
    return "";
  }
  /* 21 Oct 2026: a Reattempt booked for a later day used to be locked for
     every rider until that day (Khalid marked one, Arsalan could not take it
     out). Now it is a warning: any rider of the city can take it out after
     confirming. Returns the day the customer asked for, or "". */
  function laterDay(p) {
    if (p.bucket !== "station" || p.status !== "Reattempt") return "";
    var nx = String(p.meta.nextAttempt || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(nx) && nx > today() ? nx : "";
  }
  function dayLabel(d) { try { return new Date(d + "T12:00:00+05:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Karachi" }); } catch (_) { return d; } }
  function card(p, opts) {
    opts = opts || {};
    var c = where(p), pend = pendingAwbs().has(p.awb.toUpperCase()), pay = payment(p), lock = opts.select ? outLock(p) : "";
    var vn = VOICE.pending[p.awb.toUpperCase()];
    var call = R.phone(c.phone), validPhone = /^\+?\d{9,15}$/.test(call);
    var sel = opts.select ? '<input type="checkbox" class="pick" data-pick="' + esc(p.awb) + '"' + (ui.sel.has(p.awb) && !lock ? " checked" : "") + (pend || lock ? " disabled" : "") + ' aria-label="Select ' + esc(p.awb) + '">' : "";
    var tag = p.meta.swapLeg === "out" ? '<p class="swaptag">NOVA SWAP · collect the old item' + (p.meta.swapPairAwb ? ' · return AWB <b>' + esc(p.meta.swapPairAwb) + '</b>' : '') + '</p>' :
              p.meta.swapLeg === "back" ? '<p class="swaptag back">NOVA SWAP RETURN · going back to the merchant</p>' :
              isReturn(p) ? '<p class="swaptag back">RETURN · going back to ' + esc(p.shipper && p.shipper.name || "the shipper") + '</p>' :
              /* Nova Recover: a support agent phoned the customer after a refusal and they agreed to take it. */
              (p.meta.recover && p.meta.recover.by && !p.meta.recover.rebookedAs) ? '<p class="swaptag">NOVA RECOVER · customer agreed on the phone' +
                (p.meta.recover.date ? ' · deliver ' + esc(p.meta.recover.date) : '') + (p.meta.recover.note ? ' · ' + esc(p.meta.recover.note) : '') + '</p>' : "";
    /* What the customer tapped on their tracking page (9 Oct 2026). Shown as
       they said it, with the time; the office has not changed the parcel. */
    var cr = p.customerReply, crSay = cr ? ({
      home_today:    ["Customer says: home today", "Customer ne kaha: aaj ghar par hoon"],
      tomorrow:      ["Customer asked: deliver tomorrow", "Customer ne kaha: kal deliver karein"],
      call_first:    ["Customer asked: call first", "Customer ne kaha: pehle call karein"],
      wrong_address: ["Customer says the address is wrong", "Customer ne kaha: address ghalat hai"] })[cr.choice] : null;
    var crWhen = ""; try { if (cr && cr.at) crWhen = new Date(cr.at).toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }); } catch (e) {}
    if (crSay) tag += '<p class="swaptag custsay">' + esc(LANG === "ur" ? crSay[1] : crSay[0]) + (cr.note ? ' · ' + esc(cr.note) : '') + (crWhen ? ' · ' + esc(crWhen) : '') + '</p>';
    /* What the shop wrote when booking (printed on the label, never shown
       here until 14 Oct 2026): whether the customer may open it before
       paying, fragile, and the shop's own note. */
    if (p.bucket === "station" || p.bucket === "out") {
      var sn = [], open = String(p.meta.allowOpen || ""), note = String(p.meta.comments || "").trim();
      if (open === "Yes") sn.push('<b class="open-yes">' + esc(t("mayOpen")) + '</b>'); else if (open === "No") sn.push('<b class="open-no">' + esc(t("noOpen")) + '</b>');
      if (String(p.meta.fragile || "") === "Yes" && !/fragile/i.test(note)) sn.push(esc(t("fragile")));
      if (note) sn.push(esc(t("shopNote")) + ': ' + esc(note.slice(0, 180)));
      if (sn.length) tag += '<p class="shopnote">' + sn.join(' · ') + '</p>';
    }
    var money2 = (isReturn(p) || p.meta.swapLeg === "back") ? (LANG === "ur" ? "Shipper ko wapsi · kuch collect nahi karna" : "Return to shipper · collect nothing") : p.cod > 0 ? (pay.conflict ? '<span class="error-text">COD/prepaid conflict — marked Prepaid. Call the office.</span>' : "COD " + money(p.cod)) : "Prepaid · collect nothing";
    var att = Number(p.attempts || 0), attTxt = att ? (att + " " + t("attempts") + (att > 1 ? (LANG === "ur" ? "" : "s") : "")) : "";
    var route = (p.origin || "") + " → " + (p.city || "");
    var ageD = Math.floor((Date.now() - R.timestamp(p.statusSince)) / 864e5);
    var age = isFinite(ageD) && ageD >= 1 ? (ageD + (LANG === "ur" ? " din" : (ageD === 1 ? " day" : " days"))) : "";
    var body = '<div class="parcel-head">' + sel + '<b class="awb">' + esc(p.awb) + '</b><span class="status">' + esc(p.status) + '</span></div>' + tag +
      (vn ? '<p class="vnote">\ud83c\udf99 ' + esc(vn === "review" ? "Voice note not accepted. See saved actions on Home." : t("voicePending")) + '</p>' : '') +
      '<p><b>' + esc(c.name || "Name not recorded") + '</b><br>' + esc(c.address || "Address missing. Call the office.") + (c.phone ? '<br>' + esc(c.phone) : "") + '</p>' +
      '<p class="meta-line">' + esc(route) + (age ? ' · <b class="' + (ageD >= 3 ? 'age-old' : '') + '">' + esc(age) + '</b>' : '') + (attTxt ? ' · ' + esc(attTxt) : '') + (p.meta.weight ? ' · ' + esc(p.meta.weight) : '') + (p.exception ? ' · ' + esc(p.exception) : '') + '</p>' +
      (p.heldBy && p.bucket === "out" ? '<p class="meta-line">Was with ' + esc(p.heldBy) + ' — now yours</p>' : '') +
      (p.outside ? '<p class="meta-line error-text">Outside your cities — call the office before delivering.</p>' : '') +
      (lock ? '<p class="meta-line error-text">' + esc(lock) + '</p>' : '') +
      (opts.select && !lock && laterDay(p) ? '<p class="meta-line">' + esc(LANG === "ur" ? "Customer ne " + dayLabel(laterDay(p)) + " ka kaha — pehle bhi le ja sakte hain" : "Customer asked for " + dayLabel(laterDay(p)) + " — you can still take it out") + '</p>' : '') +
      '<div class="moneyline">' + money2 + '</div>';
    if (opts.contacts && (validPhone || c.address)) {
      var wa = call.replace(/^\+/, "");
      body += '<div class="contacts">' +
        (validPhone ? '<a class="call" href="tel:' + esc(call) + '">' + esc(t("call")) + '</a><a class="call" href="https://wa.me/' + esc(wa) + '?text=' + esc(encodeURIComponent(waText(p, pay))) + '" target="_blank" rel="noopener">WhatsApp</a>' : '') +
        (c.address ? '<a class="call" href="' + esc(typeof R.directionsUrl === "function" ? R.directionsUrl(c.address, c.city)
          : "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(c.address + ", " + (c.city || ""))) + '" target="_blank" rel="noopener">' + esc(t("directions")) + '</a>' : '') + '</div>';
    }
    if (pend) body += '<p class="pending-label">' + esc(t("saved")) + '</p>';
    else if (opts.outcomes) body += '<div class="actions">' + outcomeButtons(p, pay) + '</div>';
    var search = [p.awb, c.name, c.phone, c.address, p.city, p.origin, p.consignee, CITY_WORDS[p.city] || ""].join(" ").toLowerCase();
    return '<article class="parcel' + (pend ? ' pending' : '') + (ui.sel.has(p.awb) && !lock ? ' picked' : '') + '" data-awb="' + esc(p.awb) + '" data-search="' + esc(search) + '">' + body + '</article>';
  }
  function outcomeButtons(p, pay) {
    if (p.meta.swapLeg === "out" && p.status === "Parcel out for delivery")
      return '<button class="btn" data-write data-swap="exchanged" data-awb="' + esc(p.awb) + '">' + esc(t("exchange")) + '</button><button class="btn secondary" data-write data-swap="failed" data-awb="' + esc(p.awb) + '">' + esc(t("cantExchange")) + '</button>';
    if (p.status === "Return out for delivery")
      return '<button class="btn" data-write data-act="delivered" data-awb="' + esc(p.awb) + '">' + esc(t("returned")) + '</button><button class="btn secondary" data-write data-act="not_available" data-awb="' + esc(p.awb) + '">' + esc(t("notAvailable")) + '</button>';
    var att = Number(p.attempts || 0);
    /* One reattempt per parcel (3 Oct 2026); the server refuses a second. */
    var raUsed = !!(p.meta && Array.isArray(p.meta.steps) && p.meta.steps.indexOf("Reattempt") >= 0);
    return '<button class="btn" data-write data-act="delivered" data-awb="' + esc(p.awb) + '"' + (pay.conflict ? ' data-blocked disabled' : '') + '>' + esc(t("delivered")) + '</button>' +
      (att < 3 && !raUsed ? '<button class="btn secondary" data-write data-act="reattempt" data-awb="' + esc(p.awb) + '">' + esc(t("reattempt")) + '</button>' : '') +
      '<button class="btn danger" data-write data-act="refused" data-awb="' + esc(p.awb) + '">' + esc(t("refused")) + '</button>' +
      '<button class="btn secondary" data-write data-act="not_available" data-awb="' + esc(p.awb) + '">' + esc(t("notAvailable")) + '</button>' +
      (att >= 3 ? '<p class="sla-note">3 attempts done. Mark Refused so it goes back.</p>'
        : raUsed ? '<p class="sla-note">' + esc(LANG === "ur" ? "Reattempt ho chuka — deliver karein ya Refused / Not available lagayein." : "Already reattempted once. Deliver it, or mark Refused or Not available.") + '</p>' : '');
  }
  function empty() { return '<p class="empty">' + esc(t("nothing")) + '</p>'; }
  /* A tracking number with its last four digits large: the part a rider reads and types. */
  function awbHtml(a) { a = String(a || ""); return '<span class="awbx">' + esc(a.slice(0, -4)) + '<b>' + esc(a.slice(-4)) + '</b></span>'; }
  function selectAllBtn(scope, awbs) {
    if (!awbs.length) return "";
    return '<button class="btn secondary selall" type="button" data-selall="' + esc(scope) + '" data-awbs="' + esc(awbs.join(",")) + '">' + esc(t("selectAll")) + ' (' + awbs.length + ')</button>';
  }

  /* ---- render ------------------------------------------------------------ */
  /* Today (19 Oct 2026): every status this rider set today, newest first, and
     for Refused / Not available whether the voice note went. Fetched after the
     station so it can never hold up the main screen. */
  var TODAY = null;
  function loadToday() {
    try {
      Promise.resolve(sb.rpc("rider_today")).then(function (r) {
        if (r && !r.error && Array.isArray(r.data)) { TODAY = r.data; renderToday(); }
      }, function () {});
    } catch (_) {}
  }
  function renderToday() {
    var el = q("todayList"); if (!el) return;
    if (!TODAY) { el.innerHTML = ""; return; }
    if (!TODAY.length) { el.innerHTML = '<p class="empty">' + esc(t("noneToday")) + '</p>'; return; }
    el.innerHTML = TODAY.map(function (x) {
      var tm = ""; try { tm = new Date(x.changed_at).toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Karachi" }); } catch (_) {}
      var v = x.voice === "sent" ? '<span class="tg ok">' + esc(t("voiceSent")) + '</span>' : x.voice === "skipped" ? '<span class="tg warn">' + esc(t("voiceSkipped")) + '</span>' : x.voice === "missing" ? '<span class="tg bad">' + esc(t("voiceMissing")) + '</span>' : "";
      return '<div class="today-row"><span class="today-t">' + esc(tm) + '</span><span class="today-m"><b>' + esc(x.awb) + '</b> ' + esc(x.to_status) + '<small>' + esc([x.consignee, x.city].filter(Boolean).join(" · ")) + '</small></span>' + v + '</div>';
    }).join("");
  }
  function render() {
    if (!data.rider) return;
    paintWords();
    var cities = (data.rider.cities || []).join(" + ") || "No city set";
    q("riderName").textContent = data.rider.name || "My station";
    q("routeName").textContent = cities;
    var pick = inBucket("pickup"), inc = inBucket("incoming"), st = inBucket("station"), out = inBucket("out"), tr = inBucket("transit"), done = inBucket("done");
    var pend = pendingAwbs(), free = function (list) { return list.filter(function (p) { return !pend.has(p.awb.toUpperCase()) && !outLock(p); }); };
    (function prune() {
      var want = { collect: "pickup", receive: "incoming", station: "station", transit: "transit" }[scopeNow()];
      var ok = new Set(data.parcels.filter(function (p) { return p.bucket === want && !pend.has(p.awb.toUpperCase()) && !outLock(p); }).map(function (p) { return p.awb; }));
      Array.from(ui.sel).forEach(function (a) { if (!ok.has(a)) ui.sel.delete(a); });
      if (!ui.sel.size) ui.selScope = "";
    })();
    q("homePickup").textContent = pick.length + " " + t("toCollect");
    q("homeDelivery").textContent = (inc.length ? inc.length + " " + t("incoming") + " · " : "") + st.length + " " + t("atStation") + " · " + out.length + " " + t("outNow");
    q("pickupHelp").textContent = t("pickupHelp", { city: cities });
    q("nArriving").textContent = inc.length; q("nStation").textContent = st.length; q("nOut").textContent = out.length;
    q("homeTransit").textContent = tr.length + " " + t("toSend");
    var deliveredToday = done.filter(function (p) { return R.day(R.deliveredAt(p)) === today(); });
    q("stats").innerHTML = stat("Delivered today", deliveredToday.length) + stat("Out now", out.length) + stat("Cash to hand over", data.cash ? money(data.cash.net) : "Unavailable", true) +
      (data.route ? stat(t("distToday"), kmText(data.route.km)) : "") + stat("City", cities);
    renderRoute();
    /* 21 Oct 2026 audit: 17 refusals the rider cannot act on filled Home and
       pushed "What you marked today" 5,000 px down. They are one line now;
       only parcels the rider can do something about are listed. */
    var onShipper = st.filter(function (p) { return p.status === "Refused" || p.status === "Consignee not available"; });
    var attn = st.filter(function (p) { return Number(p.attempts || 0) >= 2 && onShipper.indexOf(p) < 0; }).concat(out.filter(function (p) { return payment(p).conflict; }));
    var waitLine = onShipper.length ? '<p class="attn-line">' + esc(t("waitShipper", { n: onShipper.length })) + ' <button type="button" class="linkish" data-goto="delivery:station">' + esc(t("seeThem")) + ' ›</button></p>' : "";
    q("attentionList").innerHTML = (waitLine + attn.map(function (p) { return card(p); }).join("")) || '<p class="empty">All clear.</p>';

    // Pickup: grouped by shipper. A shipper whose address is in another city
    // goes last, with a warning instead of "Select all".
    var myCities = (data.rider.cities || []).map(function (c) { return c.toLowerCase(); });
    var groups = {}, odd = {};
    pick.forEach(function (p) { var k = p.client_id || "?"; (groups[k] = groups[k] || []).push(p); });
    /* An older rider-core.js kept by the phone has no wrongCity: no warning, never a blank screen. */
    Object.keys(groups).forEach(function (k) { odd[k] = typeof R.wrongCity === "function" ? R.wrongCity((groups[k][0].shipper || {}).address, myCities) : ""; });
    q("collectList").innerHTML = Object.keys(groups).sort(function (x, y) { return (odd[x] ? 1 : 0) - (odd[y] ? 1 : 0); }).map(function (k) {
      var list = groups[k], s = list[0].shipper || {}, ph = R.phone(s.phone), okPh = /^\+?\d{9,15}$/.test(ph);
      return '<section class="shipper' + (odd[k] ? ' odd-city' : '') + '"><div class="shipper-head"><div><b>' + esc(s.name || "Shipper") + '</b><small>' + esc(s.address || "") + '</small></div>' +
        (okPh ? '<a class="call" href="tel:' + esc(ph) + '">' + esc(t("call")) + '</a>' : '') + '</div>' +
        (odd[k] ? '<p class="wrong-city" role="alert">' + esc(t("wrongCity", { looks: odd[k], city: cities })) + '</p>'
          : selectAllBtn("collect", free(list).map(function (p) { return p.awb; }))) + list.map(function (p) { return card(p, { select: true }); }).join("") + '</section>';
    }).join("") || empty();

    // Arriving (Delivery): batches + parcels on their way here from another city
    var batches = (data.batches || []).filter(function (b) { return myCities.indexOf(String(b.to_city).toLowerCase()) > -1; });
    q("batchList").innerHTML = batches.map(function (b) {
      var got = (b.received || []).length, all = (b.awbs || []).length;
      var awaiting = (b.awbs || []).filter(function (a) { return (b.received || []).indexOf(a) < 0; });
      /* The card used to say only "0 / 11 received": a rider pressing Select all
         could not see which tracking numbers he was about to confirm. */
      var rows = (b.awbs || []).map(function (a) {
        var p = inc.filter(function (x) { return x.awb === a; })[0], state = (b.received || []).indexOf(a) > -1 ? "stReceived" : !p ? "stElsewhere" : ui.sel.has(a) ? "stSelected" : "stWaiting";
        var any = p || data.parcels.filter(function (x) { return x.awb === a; })[0];   /* a received one is now At station: still show whose it is */
        return '<li class="' + state + '">' + awbHtml(a) + '<span class="who">' + esc(any ? any.consignee : "") + '</span><span class="st">' + esc(t(state)) + '</span></li>';
      }).join("");
      return '<article class="parcel batch"><div class="parcel-head"><b>' + esc(b.code) + '</b><span class="status">' + esc(b.status) + '</span></div><p>' + esc(b.from_city) + ' → ' + esc(b.to_city) + ' · ' + esc(b.reference || "") + '<br>' + got + ' / ' + all + ' received</p>' +
        (got && awaiting.length ? '<p class="meta-line error-text">Not arrived yet: ' + esc(awaiting.join(", ")) + '</p>' : '') +
        '<details class="batch-awbs" data-batch="' + esc(b.code) + '"' + (ui.openBatch[b.code] ? " open" : "") + '><summary>' + esc(t("showAwbs", { n: all })) + '</summary><ol>' + rows + '</ol></details>' +
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
    /* Audit 17 Oct 2026: "Ready to deliver (7)" over "Select all (6)". A
       reattempt booked for a later day (or a parcel past 3 attempts) cannot
       go out now, so it is counted in its own group, not in today's run. */
    var notReady = st.filter(function (p) { return !waitingOn(p) && outLock(p); });
    var later = st.filter(function (p) { return !waitingOn(p) && !outLock(p) && laterDay(p); });
    var ready = st.filter(function (p) { return !waitingOn(p) && !outLock(p) && !laterDay(p); });
    var stuck = st.filter(waitingOn).sort(function (x, y) { return R.timestamp(x.statusSince) - R.timestamp(y.statusSince); });
    q("stationList").innerHTML = (st.length ? "" : empty()) +
      (ready.length ? '<h3 class="grp">' + esc(LANG === "ur" ? "Deliver karne ke liye tayyar" : "Ready to deliver") + " (" + ready.length + ")</h3>" + selectAllBtn("station", free(ready).map(function (p) { return p.awb; })) + ready.map(function (p) { return card(p, { select: true, contacts: true }); }).join("") : "") +
      (later.length ? '<h3 class="grp">' + esc(LANG === "ur" ? "Customer ne baad ka din kaha" : "Customer asked for a later day") + " (" + later.length + ")</h3>" + later.map(function (p) { return card(p, { select: true, contacts: true }); }).join("") : "") +
      (notReady.length ? '<h3 class="grp">' + esc(LANG === "ur" ? "Abhi nahi ja sakte" : "Can’t go out now") + " (" + notReady.length + ")</h3>" + notReady.map(function (p) { return card(p, { select: true, contacts: true }); }).join("") : "") +
      (stuck.length ? '<details class="grp-fold" data-fold="stuck"' + (ui.openStuck ? " open" : "") + '><summary class="grp">' + esc(LANG === "ur" ? "Mana / nahi mila — shipper ke faislay ka intezar" : "Refused or not available — waiting for the shipper") + " (" + stuck.length + ")</summary>" + stuck.map(function (p) { return card(p, { select: true, contacts: true }); }).join("") + '</details>' : "");
    q("outList").innerHTML = out.map(function (p) { return card(p, { outcomes: true, contacts: true }); }).join("") || empty();
    q("doneList").innerHTML = deliveredToday.map(function (p) { return card(p); }).join("") || empty();

    // Transit: grouped by where it is going
    var tg = {};
    /* RIDER-012: a batch leaves ONE station. A two-city rider (Islamabad +
       Rawalpindi) gets one group per station and destination. */
    /* 27 Oct 2026: a parcel waiting at the Lahore hub leaves from the hub, not from its pickup city. */
    tr.forEach(function (p) { var ret = p.status === "Ready for return", from = ret ? p.city : ((p.meta && p.meta.atHub) || p.origin), to = ret ? p.origin : p.city;
      var k = (ret ? "R" : "F") + "|" + from + "|" + to; (tg[k] = tg[k] || []).push(p); });
    var multi = (data.rider.cities || []).length > 1;
    q("transitGroups").innerHTML = Object.keys(tg).sort().map(function (k) {
      var bits = k.split("|"), ret = bits[0] === "R", from = bits[1], to = bits[2], list = tg[k], ids = free(list).map(function (p) { return p.awb; });
      return '<section class="shipper"><div class="shipper-head"><div><b>' + (multi ? esc(from) + " \u2192 " : "") + (ret ? "Returns to " : "To ") + esc(to) + ' (' + list.length + ')</b></div>' +
        (ids.length ? '<button class="btn" type="button" data-write data-sendall="' + esc(to) + '" data-awbs="' + esc(ids.join(",")) + '">' + esc(t("sendN", { n: ids.length, city: to })) + '</button>' : '') + '</div>' +
        list.map(function (p) { return card(p, { select: true }); }).join("") + '</section>';
    }).join("") || empty();
    q("sentList").innerHTML = (data.batches || []).filter(function (b) { return b.from_city && myCities.indexOf(String(b.from_city).toLowerCase()) > -1; }).map(function (b) {
      return '<article class="parcel batch"><div class="parcel-head"><b>' + esc(b.code) + '</b><span class="status">' + esc(b.status) + '</span></div><p>To ' + esc(b.to_city) + ' · ' + esc(b.reference || "") + ' · ' + (b.awbs || []).length + ' parcels</p></article>';
    }).join("") || empty();

    renderCash(); paintView(); applySearch(); paintQueue(); paintBar(); controls();
    document.querySelectorAll("[data-blocked]").forEach(function (b) { b.disabled = true; });
    geoSync(); paintGeo();
  }
  function stat(label, value, cash) { return '<div class="stat' + (cash ? ' money' : '') + '"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>'; }
  function kmText(v) { var n = Number(v || 0); return (n < 10 ? n.toFixed(1) : String(Math.round(n))) + " km"; }
  function clock(iso) {
    try { return new Date(R.timestamp(iso)).toLocaleTimeString("en-GB", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit", hour12: true }); } catch (_) { return ""; }
  }
  /* Today's stops from the server (nv_rider_route), the km from each stop
     to the one before, and a map of the last ten that have a place. */
  function renderRoute() {
    var el = q("routeBox"); if (!el) return;
    var rt = data.route, stops = rt && Array.isArray(rt.stops) ? rt.stops : [];
    el.classList.toggle("hidden", !stops.length);
    if (!stops.length) { el.innerHTML = ""; return; }
    var pts = stops.filter(function (s) { return s.lat != null && (!s.flag || s.flag === "same"); }).slice(-10);
    var map = pts.length > 1 ? "https://www.google.com/maps/dir/" + pts.map(function (s) { return Number(s.lat).toFixed(6) + "," + Number(s.lng).toFixed(6); }).join("/")
      : pts.length ? "https://www.google.com/maps/search/?api=1&query=" + Number(pts[0].lat).toFixed(6) + "," + Number(pts[0].lng).toFixed(6) : "";
    var rows = stops.slice().reverse().map(function (s) {
      var awbs = s.awbs || [], what = awbs.length > 2 ? awbs.length + " parcels" : awbs.join(", ");
      return '<li class="' + (s.flag ? "flag-" + esc(s.flag) : "") + '"><span class="rt-time">' + esc(clock(s.at)) + '</span><span class="rt-what"><b>' + esc(t("act_" + s.action)) + '</b> ' + esc(what) +
        (s.flag ? '<small>' + esc(t("flag_" + s.flag)) + '</small>' : '') + '</span><span class="rt-km">' + (s.km != null ? "+" + esc(kmText(s.km)) : "") + '</span></li>';
    }).join("");
    el.innerHTML = '<details data-route' + (ui.routeOpen ? " open" : "") + '><summary><b>' + esc(t("routeTitle")) + '</b><span>' + esc(t("routeSum", { n: stops.length, km: kmText(rt.km).replace(" km", "") })) + '</span></summary>' +
      '<ol class="route-list">' + rows + '</ol><p class="sub">' + esc(t("routeNote")) + '</p>' +
      (map ? '<a class="call" href="' + esc(map) + '" target="_blank" rel="noopener">' + esc(t("routeMap")) + '</a>' : '') + '</details>';
  }
  function renderCash() {
    var cash = data.cash;
    var mine = data.parcels.filter(function (p) { return p.status === "Delivered" && p.cod > 0 && p.rider_id === riderId; });
    q("cashHero").innerHTML = cash ? '<div class="cash-grid">' + stat("Delivered COD", money(cash.gross)) + stat("Unsettled expenses", money(cash.expenses)) + stat("Net to hand over", money(cash.net), true) + stat("Awaiting office", money(cash.pending)) + '</div>' + (cash.review ? '<p class="error-text">Expenses need office review before handover.</p>' : '') : '<p class="sub">Cash service unavailable.</p>';
    if (cash && data.rider && Number(data.rider.cash_limit) > 0 && cash.gross > Number(data.rider.cash_limit)) q("cashHero").insertAdjacentHTML("beforeend", '<p class="error-text">Cash is over your limit of ' + money(data.rider.cash_limit) + '. Hand it over today.</p>');
    /* RIDER-001: these lists used to be filtered from the station view, which
       only carries the last 36 hours of deliveries, so they did not add up to
       the totals above them. The cash service now returns the rows itself. */
    var cashRow = function (x) {
      return '<article class="parcel cashrow"><div class="parcel-head"><b class="awb">' + esc(x.awb) + '</b><span class="status">' + esc(money(x.cod)) + '</span></div>' +
        '<p class="meta-line">' + esc(x.consignee || "") + ' · ' + esc(x.city || "") + (x.delivered_at ? ' · delivered ' + esc(R.day(x.delivered_at)) : '') + '</p></article>';
    };
    var handRows = cash && Array.isArray(cash.hand_rows) ? cash.hand_rows : null;
    q("cashList").innerHTML = handRows ? (handRows.map(cashRow).join("") || empty())
      : (mine.filter(function (p) { return !R.truth(p.meta.cashReceived) && p.meta.cashDepositStatus !== "pending_confirmation"; }).map(function (p) { return card(p); }).join("") || empty());
    q("cashPendingList").innerHTML = cash && Array.isArray(cash.pending_rows) ? (cash.pending_rows.map(function (d) {
        return '<article class="parcel cashrow"><div class="parcel-head"><b>' + esc(money(d.net)) + '</b><span class="status">' + esc(d.method || "Handover") + '</span></div>' +
          '<p class="meta-line">' + esc(String(d.parcels || 0)) + ' parcels' + (d.reference ? ' · ref ' + esc(d.reference) : '') + (d.at ? ' · ' + esc(R.day(d.at)) : '') + '</p>' +
          '<p class="meta-line">' + esc((d.awbs || []).join(", ")) + '</p></article>';
      }).join("") || empty()) : empty();
    q("cashHistoryList").innerHTML = cash && Array.isArray(cash.confirmed_rows) ? (cash.confirmed_rows.map(cashRow).join("") || empty()) : empty();
    q("expenseList").innerHTML = (cash && cash.expense_rows || []).map(function (e) { return '<article class="parcel"><b>' + esc(e.category) + ' &middot; ' + money(e.amount) + '</b><p>' + esc(e.note) + '</p><small>' + esc(e.expenseDate) + (R.truth(e.settled) ? ' &middot; Settled' : ' &middot; Unsettled') + '</small></article>'; }).join("") || empty();
  }
  function paintView() {
    document.querySelectorAll(".view").forEach(function (el) { el.classList.toggle("hidden", el.id !== "view-" + ui.view); });
    document.querySelectorAll(".navbtn").forEach(function (b) { var on = b.dataset.view === ui.view; b.classList.toggle("active", on); if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    q("searchRow").classList.toggle("hidden", ["pickup", "delivery", "transit"].indexOf(ui.view) < 0);
    if (ui.view === "process") { try { procPaint(); } catch (_) {} }
    q("deliveryReceive").classList.toggle("hidden", ui.tab.delivery !== "receive");
    q("deliveryStation").classList.toggle("hidden", ui.tab.delivery !== "station"); q("deliveryOut").classList.toggle("hidden", ui.tab.delivery !== "out");
    document.querySelectorAll("[data-tab]").forEach(function (b) { var p = b.dataset.tab.split(":"), on = ui.tab[p[0]] === p[1]; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
  }
  /* What a selection means depends on the screen it was made on. */
  function scopeNow() {
    if (ui.view === "pickup") return "collect";
    if (ui.view === "delivery" && ui.tab.delivery === "receive") return "receive";
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
    var tos = new Set(), froms = new Set(), kinds = new Set();
    awbs.forEach(function (a) { var p = data.parcels.find(function (x) { return x.awb === a; }); if (p) { var ret = p.status === "Ready for return";
      tos.add(ret ? p.origin : p.city); froms.add(ret ? p.city : ((p.meta && p.meta.atHub) || p.origin)); kinds.add(ret); } });
    return tos.size === 1 && froms.size === 1 && kinds.size === 1 ? Array.from(tos)[0] : "";
  }
  /* Cards on the screen the rider is looking at: not the other tab's panel. */
  function shownCards() {
    return Array.from(document.querySelectorAll(".view:not(.hidden) [data-search]")).filter(function (c) { return !c.hidden && !c.closest(".hidden"); });
  }
  /* Other ways riders type a city (19 Oct 2026): common spellings, joined-up
     forms and the Urdu names, so "harrapa", "yousufwala" or "ملتان" find it. */
  var CITY_WORDS = {
    "Karachi": "khi کراچی", "Lahore": "lhr لاہور", "Islamabad": "isb اسلام آباد", "Rawalpindi": "pindi rwp راولپنڈی",
    "Faisalabad": "faisal abad lyallpur fsd فیصل آباد", "Multan": "mltn ملتان", "Sahiwal": "sahiwaal ساہیوال", "Okara": "okarra اوکاڑہ",
    "Chichawatni": "chicha watni chichawatney چیچہ وطنی", "Harappa": "harrapa harapa harrappa ہڑپہ",
    "Yousuf Wala": "yousufwala yousaf wala yousafwala yusuf wala yusufwala یوسف والا", "Adda Gamber": "gamber gambar adda gambar اڈا گمبر"
  };
  function applySearch() {
    var raw = q("riderSearch").value.trim().toLowerCase(), digits = raw.replace(/\D/g, "");
    document.querySelectorAll(".view:not(.hidden) .list").forEach(function (el) {
      var cards = el.querySelectorAll("[data-search]"), visible = 0;
      cards.forEach(function (c) {
        var awb = String(c.dataset.awb || "").toLowerCase();
        var show = !raw || c.dataset.search.includes(raw) || (raw.indexOf(" ") > -1 || /wala|watni/.test(raw) ? c.dataset.search.replace(/\s+/g, "").includes(raw.replace(/\s+/g, "")) : false) || (digits.length >= 3 && awb.replace(/\D/g, "").endsWith(digits));
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
      /* The three answers are fetched together (14 Oct 2026). One after the
         other they took about 2 s on office wifi, longer on a phone. */
      var got = await Promise.all([sb.from("profiles").select("role,status,rider_id").eq("id", userId).single(), sb.rpc("rider_station_view"), sb.rpc("rider_cash_summary")]);
      var pr = got[0], v = got[1], cash = got[2];
      if (pr.error) throw pr.error;
      if (!pr.data || String(pr.data.role).toLowerCase() !== "rider" || String(pr.data.status).toLowerCase() !== "active" || pr.data.rider_id !== riderId) { authorized = false; throw new Error("Rider access changed. Sign in again or contact the office."); }
      if (v.error) throw v.error;
      await identity();
      var view = v.data || {};
      data = { rider: view.rider || { name: "Rider", cities: [] }, parcels: (view.parcels || []).map(function (p) {
          var m = R.mapParcel(p); m.bucket = p.bucket; m.origin = p.origin || "Karachi"; m.attempts = Number(p.attempts || 0);
          m.shipper = p.shipper || null; m.exception = p.exception || ""; m.customerReply = p.customer_reply || null; m.rider_id = p.rider_id; m.client_id = p.client_id; m.heldBy = p.held_by || ""; return m;
        }), batches: view.batches || [], cash: cash.error ? null : cash.data, route: view.route || null, stamp: view.stamp || "" };
      connected = true; lastSync = lastFull = Date.now();
      try { store.setItem(cacheKey, JSON.stringify({ user: userId, rider: riderId, at: lastSync, data: data })); }
      catch (_) { msg("This phone cannot save the station for offline use. Do not reload without signal.", "error"); }
      q("gate").classList.add("hidden"); render(); loadToday();
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
        if (job.kind === "expense") return j.amount === job.amount && j.category === job.category && j.note === job.note && (Date.now() - Date.parse(j.at || 0)) < 15000;
        if (job.kind === "deposit") return true;
        return job.kind !== "status" || j.to === job.to && JSON.stringify(j.list) === JSON.stringify(job.list);
      })) throw new Error("This action is already saved. Reconnect or ask the office to review it; do not submit it twice.");
      queue.add(Object.assign(job, { key: key(job.kind), at: new Date().toISOString(), state: "pending" }));
    });
    render(); msg(SAVED_MSG, "info", id);
    ping(navigator.onLine ? "Saved — sending to NovaX…" : "Saved on this phone. It will send when you are back online.", "info", 30);
  }
  /* "Awaiting server confirmation" is true only until NovaX answers. It used
     to stay on screen after the green "✓ collected", so a rider could not
     tell whether the action had gone through. */
  var SAVED_MSG = "Saved on this phone. Awaiting server confirmation.";
  function clearSaved() { ["notice", "expenseResult", "cashResult"].forEach(function (id) { var el = q(id); if (el && el.textContent === SAVED_MSG) { el.className = "notice"; el.textContent = ""; } }); }
  var DONE_VERB = { collect: "Collect", receive: "Receive", out: "Take out", delivered: "Delivered", reattempt: "Reattempt", refused: "Refused", not_available: "Not available", transit: "Send batch", Delivered: "Delivered" };
  var DONE_WORDS = { collect: "collected", receive: "received", out: "out for delivery", delivered: "delivered", reattempt: "set for reattempt", refused: "marked refused", not_available: "marked not available", transit: "sent" };
  /* 21 Oct 2026: a rider action NovaX refuses is written to the office's
     error log (portal_error_logs, source "rider") with the rider's email, so
     "I could not take it out" can be looked up instead of guessed. */
  function logReject(rpc, text) {
    if (DEMO || !sb) return;
    try { Promise.resolve(sb.rpc("log_portal_error", { p_source: "rider", p_rpc_name: rpc, p_page: "rider.html · " + (data.rider && data.rider.name || ""), p_message: String(text).slice(0, 480), p_severity: "warning" })).catch(function () {}); } catch (_) {}
  }
  async function flush() {
    if (flushing || loading || busy || !authorized || !navigator.onLine || !jobs().some(function (j) { return j.state !== "review"; })) { void voiceFlush(); return; }
    flushing = true; controls(); var changed = false, rejected = false;
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
            /* A rejection is an ANSWER from the server: the connection is fine.
               Only a network-type failure means we are offline. Marking a
               rejection as "not connected" disabled the cash handover over an
               unrelated parcel dispute (audit RIDER-018). */
            if (R.retryable(response.error)) {
              connected = false;
              msg("Connection interrupted. The same saved reference will retry; do not repeat the action.", "info");
              retryDelay = Math.min(60000, retryDelay ? retryDelay * 2 : 5000);
              clearTimeout(retryTimer); retryTimer = setTimeout(function () { void flush(); }, retryDelay);
              break;
            }
            /* With two riders on one station the usual refusal is "the other
               rider already has it". Fetch the station again so the parcel
               leaves this screen now, not at the next minute's refresh. */
            rejected = true;
            queue.change(j.key, { state: "review", error: String(response.error.message || response.error) });
            logReject(name, (j.action || j.to || j.kind) + " " + (j.list || (j.awb ? [j.awb] : [])).slice(0, 20).join(",") + ": " + String(response.error.message || response.error));
            msg("Action rejected. Its reference is kept for office review: " + String(response.error.message || response.error), "error");
            ping("Not accepted: " + String(response.error.message || response.error).slice(0, 140), "error", [120]); break;
          }
          if (!response.data || (j.kind === "station" || j.kind === "status") && !Array.isArray(response.data.moved)) { queue.change(j.key, { state: "review", error: "Unexpected server acknowledgement; office must check this reference." }); break; }
          if (j.kind === "station") {
            var sent = (j.list || []).map(function (a) { return String(a).toUpperCase(); }).sort().join(","),
                got = response.data.moved.map(function (a) { return String(a).toUpperCase(); }).sort().join(",");
            if (sent !== got) { queue.change(j.key, { state: "review", error: "NovaX confirmed " + response.data.moved.length + " of " + (j.list || []).length + " parcels; office must check this reference." }); break; }
          }
          await identity(); queue.remove(j.key); connected = true; changed = true; retryDelay = 0;
          if (j.kind === "station") ping("✓ " + response.data.count + " parcel" + (response.data.count === 1 ? "" : "s") + " " + (DONE_WORDS[j.action] || "saved") + (response.data.batch ? " · batch " + response.data.batch : ""), "ok", [40, 60, 40]);
          else if (j.kind === "swap") ping(j.outcome === "exchanged" ? "✓ Exchange done — new item delivered, old item collected (" + (response.data.back_awb || "") + ")" : "✓ Recorded: exchange did not happen. Bring the new item back.", "ok", [40, 60, 40]);
          else if (j.kind === "expense") ping("✓ Expense recorded", "ok", [40, 60, 40]);
          if (j.kind === "deposit") msg(money(response.data.net) + " handover recorded (" + (j.method || "") + "). Awaiting office confirmation. Ref " + j.key, "ok", "cashResult");
        }
      });
    } catch (e) { connected = false; msg(String(e.message || e), "error"); }
    finally { flushing = false; if (changed && !jobs().some(function (j) { return j.state !== "review"; })) clearSaved(); render(); if (changed || rejected) void load(true); void voiceFlush(); }
  }

  /* ---- dialogs ----------------------------------------------------------- */
  function confirm(title, text, reasons, extra) {
    return new Promise(function (resolve) {
      var dialog = q("actionDialog"), input = q("reasonOther"), ex = q("extraInput");
      q("dialogTitle").textContent = title; q("dialogText").textContent = text; q("dialogError").textContent = ""; input.value = ""; ex.value = extra && extra.value || "";
      q("reasonLabel").classList.toggle("hidden", !reasons);
      q("extraLabel").classList.toggle("hidden", !extra);
      ex.type = extra && extra.type || "text"; ex.min = extra && extra.min_value || ""; ex.max = extra && extra.max_value || "";
      if (extra) { q("extraLabelText").textContent = extra.label; ex.placeholder = extra.placeholder || ""; }
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
  /* Before parcels are marked received: every one listed, ticked, grouped by
     batch, so the rider checks them against what is in his hands and unticks
     what did not come. Resolves with the ticked tracking numbers, or null. */
  function checkParcels(list) {
    return new Promise(function (resolve) {
      var dialog = q("actionDialog"), box = q("reasonPresets"), go = q("dialogConfirm"), was = go.textContent, groups = {}, order = [];
      list.forEach(function (a) {
        var p = data.parcels.filter(function (x) { return x.awb === a; })[0] || { awb: a, consignee: "", meta: {} };
        /* the batch that lists it (what the screen shows), else the code on the parcel */
        var bt = (data.batches || []).filter(function (b) { return (b.awbs || []).indexOf(a) > -1; })[0];
        var g = bt ? bt.code : p.meta && p.meta.transitBatch ? p.meta.transitBatch : isReturn(p) ? t("returnsGroup") : t("noBatch");
        if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(p);
      });
      q("dialogTitle").textContent = list.length === 1 ? t("checkTitle1") : t("checkTitle", { n: list.length });
      q("dialogText").textContent = t("checkText");
      q("dialogError").textContent = ""; q("reasonLabel").classList.add("hidden"); q("extraLabel").classList.add("hidden");
      box.classList.add("check"); box.onclick = null;
      box.innerHTML = '<p class="check-count" id="checkCount"></p>' + order.map(function (g) {
        return '<h3 class="grp">' + esc(g) + ' (' + groups[g].length + ')</h3>' + groups[g].map(function (p) {
          return '<label class="check-row"><input type="checkbox" data-keep="' + esc(p.awb) + '" checked>' + awbHtml(p.awb) +
            '<span class="who">' + esc(p.consignee || "") + (p.city ? '<small>' + esc((p.origin || "") + " → " + p.city) + '</small>' : '') + '</span></label>';
        }).join("");
      }).join("");
      function count() {
        var k = box.querySelectorAll("[data-keep]:checked").length;
        q("checkCount").textContent = t("checkCount", { k: k, n: list.length });
        go.textContent = t("receiveN", { n: k }); go.disabled = !k;
      }
      box.onchange = count; count();
      dialog.querySelector("form").onsubmit = null;
      dialog.returnValue = "cancel";
      dialog.onclose = function () {
        var keep = dialog.returnValue === "confirm" ? Array.from(box.querySelectorAll("[data-keep]:checked")).map(function (x) { return x.dataset.keep; }) : null;
        go.textContent = was; go.disabled = false; box.classList.remove("check"); box.onchange = null; box.innerHTML = "";
        dialog.onclose = null; resolve(keep && keep.length ? keep : null);
      };
      dialog.showModal();
    });
  }
  /* ---- voice notes (18 Oct 2026) -------------------------------------------
     After Refused or Not available the rider records up to 60 seconds for the
     shipper, who plays it in the portal. The status saves first, exactly as
     before; the recording waits on this phone (IndexedDB, survives a closed
     app) and uploads only after NovaX has confirmed that status, because the
     storage rule checks it. Database side: sql_novax_rider_voice_notes_20261018.sql.
     The only way past the recorder without a note is a blocked microphone,
     which is recorded (rider_voice_skip) and shows on the office report. */
  var VOICE = { db: null, mem: {}, pending: {}, flushing: false, timer: null, MAX: 60000, MIN: 3000, BYTES: 1048576 };
  /* Piloted with Khalid, then switched on for every rider on 18 Oct 2026
     ("*"). Remove "*" to go back to only the listed riders. The demo always
     has it. Waiting notes still send for anyone. */
  var VOICE_RIDERS = ["*", "234b3d41-47ef-46bd-b427-d27f0ea9fd53"];   // every rider (18 Oct 2026); Khalid, Lahore piloted it
  function voiceOn() { return DEMO || VOICE_RIDERS.indexOf("*") > -1 || VOICE_RIDERS.indexOf(String(riderId || "")) > -1; }
  function voiceDb() {
    if (VOICE.db) return VOICE.db;
    VOICE.db = new Promise(function (resolve) {
      try {
        var req = indexedDB.open("novaxRiderVoice", 1);
        req.onupgradeneeded = function () { req.result.createObjectStore("notes", { keyPath: "key" }); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
        /* 21 Oct 2026: on some riders' phones storage never answered, and the
           "microphone blocked" button waited on it forever. Memory instead. */
        setTimeout(function () { resolve(null); }, 2500);
      } catch (_) { resolve(null); }
    });
    return VOICE.db;
  }
  /* Falls back to memory when IndexedDB is unavailable (private window): the
     note still sends, but only while the app stays open. */
  /* 18 Oct 2026: iPhone Safari refused to store the recording (a Blob) and
     failed with an empty error, which the recorder showed as "null" and
     which left the rider stuck on it. The note is now stored as plain bytes,
     every failure has a readable message, and when the phone cannot store it
     at all the note is kept in memory and still sends while the app is open:
     storage trouble never blocks a rider. */
  function voiceTx(mode, fn) {
    return voiceDb().then(function (db) {
      if (!db) return fn(null);
      return new Promise(function (resolve, reject) {
        var tx, out;
        try { tx = db.transaction("notes", mode); out = fn(tx.objectStore("notes")); }
        catch (e) { reject(e || new Error("This phone could not open its storage.")); return; }
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { reject(tx.error || new Error("This phone could not save the voice note.")); };
        tx.onabort = function () { reject(tx.error || new Error("This phone could not save the voice note.")); };
        setTimeout(function () { reject(new Error("This phone's storage did not answer.")); }, 4000);
      });
    });
  }
  function voiceAll() {
    var mem = Object.keys(VOICE.mem).map(function (k) { return VOICE.mem[k]; });
    return voiceTx("readonly", function (st) { return st ? st.getAll() : null; }).catch(function () { return null; }).then(function (rows) {
      var byKey = {};
      (rows || []).concat(mem).forEach(function (x) { if (x && x.key) byKey[x.key] = x; });
      return Object.keys(byKey).map(function (k) { return byKey[k]; }).filter(function (x) { return x.user === userId && x.rider === riderId; });
    });
  }
  function voicePut(row) {
    VOICE.mem[row.key] = row;
    return voiceTx("readwrite", function (st) { if (st) st.put(row); }).then(function () { if (row.state !== "review") VOICE.memOnly = false; })
      .catch(function () { VOICE.memOnly = true; });   /* kept in memory; sends while the app is open */
  }
  function voiceDel(k) { delete VOICE.mem[k]; return voiceTx("readwrite", function (st) { if (st) st["delete"](k); }).catch(function () {}); }
  function voiceBlob(r) { return r.blob instanceof Blob ? r.blob : new Blob([r.buf || new ArrayBuffer(0)], { type: r.mime }); }
  function voiceRefresh() {
    return voiceAll().then(function (rows) {
      var m = {}; rows.forEach(function (r) { m[r.awb] = r.state === "review" ? "review" : (m[r.awb] || "pending"); });
      VOICE.pending = m; VOICE.rows = rows;
    }).catch(function () {});
  }
  function voiceMime() {
    if (!window.MediaRecorder) return null;
    var c = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (var i = 0; i < c.length; i++) { try { if (MediaRecorder.isTypeSupported(c[i])) return c[i]; } catch (_) {} }
    return "";
  }
  function voiceKind(m) {
    m = String(m || "").split(";")[0].trim();
    return { "audio/webm": ["audio/webm", "webm"], "audio/mp4": ["audio/mp4", "m4a"], "audio/ogg": ["audio/ogg", "ogg"],
             "audio/aac": ["audio/aac", "aac"], "audio/mpeg": ["audio/mpeg", "mp3"] }[m] || ["audio/webm", "webm"];
  }
  function voiceClock(ms) { var x = Math.max(0, Math.round(ms / 1000)); return Math.floor(x / 60) + ":" + String(x % 60).padStart(2, "0"); }
  /* Resolves when the rider has sent a note or recorded why there is none. */
  function voiceCapture(p, action, reason, location) {
    return new Promise(function (resolve) {
      var dialog = q("voiceDialog"), rec = q("voiceRec"), recText = q("voiceRecText"), bar = q("voiceBar"), time = q("voiceTime");
      var stage = q("voiceStage"), review = q("voiceReview"), blocked = q("voiceBlocked"), err = q("voiceError"), play = q("voicePlay");
      var stream = null, mr = null, chunks = [], startedAt = 0, recordedAt = "", tick = null, blob = null, dur = 0, url = "", mime = "";
      var status = action === "refused" ? t("refused") : t("notAvailable");
      q("voiceFor").innerHTML = "<b>" + esc(p.awb) + "</b> · " + esc(status) + (reason ? " · " + esc(reason) : "");
      function show(which) { stage.classList.toggle("hidden", which !== "stage"); review.classList.toggle("hidden", which !== "review"); blocked.classList.toggle("hidden", which !== "blocked"); }
      function idle() { rec.classList.remove("on"); recText.textContent = t("voiceTapStart"); bar.style.width = "0"; time.textContent = "0:00 / 1:00"; }
      function stopTracks() { try { if (stream) stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (_) {} stream = null; }
      function reset() { err.textContent = ""; if (url) { URL.revokeObjectURL(url); url = ""; } play.removeAttribute("src"); blob = null; dur = 0; idle(); show("stage"); }
      function fail(why, text) { stopTracks(); clearInterval(tick); idle(); q("voiceBlockedText").textContent = text; blocked.dataset.why = why; show("blocked"); }
      function finish(row) {
        clearInterval(tick); stopTracks(); if (url) URL.revokeObjectURL(url);
        dialog.removeEventListener("cancel", noCancel); dialog.close(); resolve(row);
      }
      function noCancel(e) { e.preventDefault(); }
      async function start() {
        err.textContent = "";
        mime = voiceMime();
        if (mime === null || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { fail("mic_error", t("voiceNoMic")); return; }
        /* Some phones and in-app browsers never answer the microphone request:
           after 10 s the rider gets the "microphone blocked" exit. */
        try { stream = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }),
          new Promise(function (_, no) { setTimeout(function () { no(Object.assign(new Error("No answer"), { name: "TimeoutError" })); }, 10000); })]); }
        catch (e) { fail(e && (e.name === "NotAllowedError" || e.name === "SecurityError") ? "no_mic" : "mic_error", e && (e.name === "NotAllowedError" || e.name === "SecurityError") ? t("voiceBlocked") : t("voiceNoMic")); return; }
        try { mr = new MediaRecorder(stream, Object.assign({ audioBitsPerSecond: 24000 }, mime ? { mimeType: mime } : {})); }
        catch (_) { try { mr = new MediaRecorder(stream); } catch (e2) { fail("mic_error", t("voiceNoMic")); return; } }
        chunks = [];
        mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstop = function () {
          clearInterval(tick); stopTracks(); rec.classList.remove("on");
          dur = Math.min(VOICE.MAX, Date.now() - startedAt);
          blob = new Blob(chunks, { type: mr.mimeType || mime || "audio/webm" });
          if (dur < VOICE.MIN) { idle(); err.textContent = t("voiceShort"); blob = null; return; }
          if (blob.size > VOICE.BYTES) { idle(); err.textContent = t("voiceBig"); blob = null; return; }
          /* A phone that records but hands back (almost) nothing, e.g. after a
             call interrupted it: offer another try or the microphone exit now,
             rather than a note NovaX would refuse later. */
          if (blob.size < 800) { blob = null; fail("mic_error", t("voiceNoMic")); return; }
          url = URL.createObjectURL(blob); play.src = url; time.textContent = voiceClock(dur);
          q("voiceLen").textContent = t("voiceRecorded", { len: voiceClock(dur) }); show("review");
        };
        mr.start(1000); startedAt = Date.now(); recordedAt = new Date().toISOString();
        rec.classList.add("on"); recText.textContent = t("voiceTapStop");
        tick = setInterval(function () {
          var e = Date.now() - startedAt; bar.style.width = Math.min(100, e / VOICE.MAX * 100) + "%"; time.textContent = voiceClock(e) + " / 1:00";
          if (e >= VOICE.MAX && mr && mr.state === "recording") mr.stop();
        }, 200);
        try { if (navigator.vibrate) navigator.vibrate(30); } catch (_) {}
      }
      rec.onclick = function () { if (mr && mr.state === "recording") mr.stop(); else void start(); };
      q("voiceAgain").onclick = reset;
      q("voiceRetryMic").onclick = function () { reset(); void start(); };
      q("voiceSend").onclick = async function () {
        if (!blob) return;
        var kind = voiceKind(blob.type), cid = p.client_id || p.clientId || "";
        var rand = Array.from(crypto.getRandomValues(new Uint8Array(4))).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
        var buf; try { buf = await blob.arrayBuffer(); } catch (e) { buf = null; }
        var row = { key: "voice-" + riderId + "-" + crypto.randomUUID(), type: "note", user: userId, rider: riderId, awb: p.awb.toUpperCase(), action: action,
          path: cid + "/" + p.awb.toUpperCase() + "/" + riderId + "-" + Date.now() + "-" + rand + "." + kind[1], mime: kind[0], bytes: blob.size, duration_ms: Math.round(dur),
          reason: reason || "", lat: location && location.lat || null, lng: location && location.lng || null, accuracy: location && location.accuracy || null,
          recorded_at: recordedAt, buf: buf, blob: buf ? null : blob, state: "pending", at: new Date().toISOString() };
        /* 21 Oct 2026: the dialog closes now; saving to the phone and sending
           follow behind it, so storage can never hold a rider here. */
        VOICE.mem[row.key] = row; finish(row);
        voicePut(row).then(function () { ping(VOICE.memOnly ? "Voice note saved. Keep the app open until it sends." : t("voiceSaved"), "info", 30); void voiceFlush(); });
      };
      q("voiceSkip").onclick = async function () {
        var row = { key: "voice-" + riderId + "-" + crypto.randomUUID(), type: "skip", why: blocked.dataset.why === "no_mic" ? "no_mic" : "mic_error",
          user: userId, rider: riderId, awb: p.awb.toUpperCase(), action: action, state: "pending", at: new Date().toISOString() };
        VOICE.mem[row.key] = row; finish(row);
        voicePut(row).then(function () { void voiceFlush(); });
      };
      dialog.addEventListener("cancel", noCancel);
      reset(); dialog.showModal();
    }).then(function (row) { return voiceRefresh().then(function () { render(); return row; }); });
  }
  /* A send that never answers would keep every later note waiting: after
     45 s it counts as a network failure and is tried again. */
  function voiceLimit(pr) {
    return Promise.race([Promise.resolve(pr), new Promise(function (ok) { setTimeout(function () { ok({ error: { message: "network timeout" } }); }, 45000); })]);
  }
  /* Sends waiting notes once their parcel's status has reached NovaX. */
  async function voiceFlush() {
    if (VOICE.flushing || flushing || !authorized || !navigator.onLine || !sb) return;
    VOICE.flushing = true;
    try {
      var rows = (await voiceAll()).filter(function (r) { return r.state !== "review"; }), waiting = pendingAwbs();
      for (var r of rows) {
        if (waiting.has(r.awb)) continue;   /* its Refused / not available is still on the phone */
        var res;
        if (r.type === "skip") {
          try { res = await voiceLimit(sb.rpc("rider_voice_skip", { p_awb: r.awb, p_why: r.why })); } catch (e) { res = { error: e }; }
        } else {
          var up;
          try { up = await voiceLimit(sb.storage.from("parcel-voice").upload(r.path, voiceBlob(r), { contentType: r.mime, upsert: false, cacheControl: "3600" })); } catch (e) { up = { error: e }; }
          /* Already there from an earlier try that lost its answer: attach it. */
          if (up && up.error && !/exist|duplicate|409/i.test(String(up.error.message || up.error.statusCode || up.error))) res = up;
          else {
            try {
              res = await voiceLimit(sb.rpc("rider_voice_attach", { p_awb: r.awb, p_path: r.path, p_duration_ms: r.duration_ms, p_mime: r.mime, p_bytes: r.bytes,
                p_reason: r.reason || null, p_lat: r.lat, p_lng: r.lng, p_accuracy: r.accuracy, p_recorded_at: r.recorded_at }));
            } catch (e) { res = { error: e }; }
          }
        }
        if (res && res.error) {
          if (R.retryable(res.error) || /fetch|network/i.test(String(res.error.message || res.error))) {
            clearTimeout(VOICE.timer); VOICE.timer = setTimeout(function () { void voiceFlush(); }, 30000); break;
          }
          await voicePut(Object.assign({}, r, { state: "review", error: String(res.error.message || res.error) }));
          logReject(r.type === "skip" ? "rider_voice_skip" : "rider_voice_attach", r.awb + ": " + String(res.error.message || res.error));
          continue;
        }
        await voiceDel(r.key);
        if (r.type === "note") ping("🎙 " + t("voiceSent") + " · " + r.awb, "ok", [30]);
      }
    } catch (e) { /* the next refresh tries again */ }
    finally { VOICE.flushing = false; await voiceRefresh(); paintVoiceQueue(); render(); }
  }
  /* Notes NovaX would not accept stay on the phone until the rider retries or
     removes them, beside the other saved actions. */
  function paintVoiceQueue() {
    var host = q("voiceReview2");
    if (!host) { host = document.createElement("div"); host.id = "voiceReview2"; host.className = "list"; var qr = q("queueReview"); if (!qr) return; qr.insertAdjacentElement("afterend", host); }
    var bad = (VOICE.rows || []).filter(function (r) { return r.state === "review"; });
    host.innerHTML = bad.map(function (r) {
      return '<article class="parcel"><b>Voice note not accepted: ' + esc(r.awb) + '</b><p>' + esc(r.error || "") + '</p><div class="actions"><button class="btn secondary" type="button" data-vretry="' + esc(r.key) + '">Retry</button><button class="btn danger" type="button" data-vdrop="' + esc(r.key) + '">Remove from phone</button></div></article>';
    }).join("");
    host.onclick = async function (e) {
      var a = e.target.closest("[data-vretry]"), b = e.target.closest("[data-vdrop]");
      var k = a ? a.dataset.vretry : b ? b.dataset.vdrop : ""; if (!k) return;
      var row = (VOICE.rows || []).find(function (x) { return x.key === k; }); if (!row) return;
      if (a) { await voicePut(Object.assign({}, row, { state: "pending", error: "" })); void voiceFlush(); }
      else if (window.confirm("Remove this voice note from the phone? The shipper will not hear it.")) { await voiceDel(k); await voiceRefresh(); paintVoiceQueue(); render(); }
    };
  }

  /* ---- GPS (14 Oct 2026) --------------------------------------------------
     A phone needs time to find itself: asked at the moment of "Delivered",
     the reading came after up to 10 s of waiting, often weak, and the rider
     stood there watching "Getting GPS fix". Now the phone follows the rider
     while he has parcels out (or is on Pickup with shippers to visit) and the
     app is open, so a sharp reading is usually ready the moment he taps.
     Every action that happens at a door (delivered, refused, not available,
     reattempt, exchange, collected) and taking parcels out at the station
     saves where he was; the office sees the stops and the km between them. */
  var geo = { watch: null, fix: null, fixAt: 0, denied: false };
  function geoWanted() {
    return !DEMO && authorized && !document.hidden && !!navigator.geolocation && typeof navigator.geolocation.watchPosition === "function" &&
      (inBucket("out").length > 0 || (ui.view === "pickup" && inBucket("pickup").length > 0));
  }
  function geoStop() { if (geo.watch != null) { try { navigator.geolocation.clearWatch(geo.watch); } catch (_) {} geo.watch = null; } }
  function geoSync() {
    if (!geoWanted()) { geoStop(); return; }
    if (geo.watch != null) return;
    try {
      geo.watch = navigator.geolocation.watchPosition(function (p) {
        if (!p || !p.coords) return; var was = geo.denied; geo.fix = p; geo.fixAt = Date.now(); geo.denied = false; if (was) paintGeo();
      }, function (e) { if (e && e.code === 1) { geo.denied = true; geoStop(); paintGeo(); } }, { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 });
    } catch (_) { geo.watch = null; }
  }
  function paintGeo() {
    var el = q("geoNote"); if (!el) return;
    el.classList.toggle("hidden", !(geo.denied && authorized && (inBucket("out").length || ui.view === "pickup")));
    el.textContent = t("geoOff");
  }
  /* The reading saved with an action. "at" is when the rider tapped, so an
     action saved offline still lands at the right time on his route. wait:
     how long to keep looking for a reading within 30 m; 0 = use what the
     phone already has. */
  function gps(wait) {
    var at = new Date().toISOString();
    if (DEMO) return Promise.resolve({ lat: 31.5204, lng: 74.3587, accuracy: 15, at: at, fix_at: at });   /* no location prompt on a preview */
    if (!navigator.geolocation) return Promise.resolve({ unavailable: true, reason: "no_gps", at: at });
    var GOOD = 30, FRESH = 20000;
    function out(p, when) { return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), at: at, fix_at: new Date(when).toISOString() }; }
    var best = geo.fix && Date.now() - geo.fixAt <= FRESH ? geo.fix : null, bestAt = geo.fixAt;
    if (best && best.coords.accuracy <= GOOD) return Promise.resolve(out(best, bestAt));
    if (!wait) return Promise.resolve(best ? out(best, bestAt) : { unavailable: true, reason: geo.denied ? "denied" : "no_fix", at: at });
    return new Promise(function (resolve) {
      var done = false, watch = null, timer = null;
      function finish(reason) {
        if (done) return; done = true; clearTimeout(timer);
        if (watch != null) { try { navigator.geolocation.clearWatch(watch); } catch (_) {} }
        resolve(best ? out(best, bestAt) : { unavailable: true, reason: reason || (geo.denied ? "denied" : "no_fix"), at: at });
      }
      function take(p) {
        if (!p || !p.coords) return;
        geo.fix = p; geo.fixAt = Date.now(); geo.denied = false;
        if (!best || p.coords.accuracy < best.coords.accuracy) { best = p; bestAt = geo.fixAt; }
        if (best.coords.accuracy <= GOOD) finish(); else msg(t("gpsWait") + " ±" + Math.round(best.coords.accuracy) + " m", "info");
      }
      function fail(e) { if (e && e.code === 1) { geo.denied = true; paintGeo(); finish("denied"); } }
      msg(t("gpsWait"), "info");
      timer = setTimeout(function () { finish(); }, wait);
      if (typeof navigator.geolocation.watchPosition !== "function") { navigator.geolocation.getCurrentPosition(function (p) { take(p); finish(); }, function (e) { fail(e); finish(); }, { enableHighAccuracy: true, timeout: wait, maximumAge: 0 }); return; }
      try { watch = navigator.geolocation.watchPosition(take, fail, { enableHighAccuracy: true, timeout: wait, maximumAge: 0 }); } catch (_) { finish(); }
    });
  }

  /* ---- actions ----------------------------------------------------------- */
  async function station(list, action, reason, extra, location) {
    await save({ kind: "station", list: list.map(function (a) { return String(a).toUpperCase(); }).sort(), action: action, reason: reason || "", extra: extra || {}, location: location || null });
  }
  /* Collecting at a shipper and taking parcels out at the station are stops
     on the route too: a short wait, never the full one. */
  var BAR_GPS = { collect: 5000, out: 5000 };
  async function runBar() {
    if (busy || flushing || !authorized) return;
    var scope = scopeNow(), list = Array.from(ui.sel);
    if (!list.length) return;
    busy = true; controls();
    try {
      var action = { collect: "collect", receive: "receive", station: "out" }[scope];
      if (action === "receive") {
        var keep = await checkParcels(list);
        if (!keep) return;   /* closed without confirming: the selection stays as it was */
        list = keep;   /* what was unticked did not arrive: it is left out, and the selection clears below */
      }
      if (action) {
        var extra = null;
        if (action === "out") {
          var early = data.parcels.filter(function (p) { return list.indexOf(p.awb) > -1 && laterDay(p); });
          if (early.length) {
            var names = early.slice(0, 5).map(function (p) { return p.awb + " (" + dayLabel(laterDay(p)) + ")"; }).join(", ") + (early.length > 5 ? " +" + (early.length - 5) : "");
            if (!await confirm(LANG === "ur" ? "Pehle le ja rahe hain?" : "Take out early?", (LANG === "ur" ? "Customer ne baad ka din kaha tha: " : "The customer asked for a later day: ") + names + ". " + (LANG === "ur" ? "Customer se baat ho gayi hai to aaj le jayein." : "Take it out today only if the customer is ready."))) return;
            extra = { early: true };
          }
        }
        var here = BAR_GPS[action] ? await gps(BAR_GPS[action]) : null;
        for (var ci = 0; ci < list.length; ci += 200) await station(list.slice(ci, ci + 200), action, "", extra, here);
      }
      else if (scope === "transit") {
        if (list.length > 200) throw new Error("A batch can hold 200 parcels. Select 200 or fewer and send the rest as a second batch.");
        await sendTransit(list);
      }
      else return;
      ui.sel.clear(); ui.selScope = "";
    } catch (e) { msg(String(e.message || e), "error"); }
    finally { busy = false; render(); void flush(); }
  }
  async function sendTransit(list) {
    var to = transitTarget(list); if (!to) throw new Error("Pick parcels going to one city.");
    if (list.length > 200) throw new Error("A batch can hold 200 parcels. Select 200 or fewer and send the rest as a second batch.");
    var res = await confirm(t("sendN", { n: list.length, city: to }), "Enter the bus or courier reference (bilty number) for this batch.", null,
      { label: "Bilty / reference", placeholder: "e.g. Daewoo 123456", required: true, min: 2, error: "Enter the bilty or courier reference." });
    if (!res) throw new Error("Not sent.");
    await station(list, "transit", "", { to_city: to, reference: res.extra });
  }
  async function outcome(awb, action) {
    if (busy || flushing || !authorized) return;
    busy = true; controls();
    var voiceNext = null;
    try {
      var p = data.parcels.find(function (x) { return x.awb === awb; }); if (!p) throw new Error("Parcel not found. Refresh.");
      var reason = "", extra = {}, location = null;
      if (action === "delivered") {
        var what = p.status === "Return out for delivery" ? "Confirm " + p.awb + " was handed back to the shipper." :
          p.awb + ": confirm the customer received it and you collected exactly " + money(payment(p).collectable) + ".";
        if (!await confirm(p.status === "Return out for delivery" ? t("returned") : t("delivered"), what)) return;
      } else if (action === "reattempt") {
        var d = R.day(new Date(Date.now() + 864e5)), dMin = today(), dMax = R.day(new Date(Date.now() + 14 * 864e5));
        var r = await confirm(t("reattempt"), "Why is it coming back to the station, and when to try again?", ["Customer asked for tomorrow", "Phone off", "Not at home", "Address incomplete"],
          { label: LANG === "ur" ? "Agli dafa kab" : "Next try", type: "date", value: d, min_value: dMin, max_value: dMax, required: true, min: 10, error: "Choose the next date." });
        if (!r) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.extra) || r.extra < dMin || r.extra > dMax) throw new Error("Choose a date between today and 14 days from now.");
        reason = r.reason; extra = { next_date: r.extra };
      } else if (action === "refused") {
        reason = await confirm(t("refused"), "What did the customer say?", ["Customer refused", "Wrong item ordered", "No money", "Fake order"]); if (!reason) return;
      } else if (action === "not_available") {
        reason = await confirm(t("notAvailable"), "What happened at this stop?", ["No answer on call", "Not at address", "Address not found", "Shop closed"]); if (!reason) return;
      }
      /* Where the rider is when it happens: a refusal or "not at home" is
         proof of a visit only with a place on it. */
      location = await gps(10000);
      await station([awb], action, reason === true ? "" : reason, extra, location);
      /* 18 Oct 2026: a refusal or "not available" is explained to the shipper
         in the rider's own voice. Mandatory; the status is already saved. */
      /* The recorder opens after this action is released (below), so the
         refusal itself is sent while the rider records. */
      if ((action === "refused" || action === "not_available") && voiceOn()) voiceNext = { p: p, action: action, reason: reason === true ? "" : reason, location: location };
      if (location && location.unavailable) msg(location.reason === "denied" ? t("geoOff") : "Saved without GPS. Server confirmation is still pending.", location.reason === "denied" ? "error" : "info");
      else if (location && location.accuracy > 100) msg("Saved. GPS was weak (±" + location.accuracy + " m), so the office sees the location as approximate.", "info");
    } catch (e) { msg(String(e.message || e), "error"); voiceNext = null; }
    finally { busy = false; render(); void flush(); }
    /* Recorder after release: the saved refusal starts sending now, and the
       note follows it once NovaX has confirmed that status. */
    if (voiceNext) { try { await voiceCapture(voiceNext.p, voiceNext.action, voiceNext.reason, voiceNext.location); } catch (e) { msg(String(e && e.message || e || "Voice note could not open."), "error"); } }
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
      var location = await gps(result === "exchanged" ? 10000 : 0);   /* the server keeps the place of an exchange only */
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
    var place = { pickup: "Pickup", incoming: "Delivery → Arriving", station: "Delivery → At station", out: "Delivery → Out now", transit: "Transit", done: "Delivered" }[p.bucket] || p.status;
    ping(p.awb + " is in " + place + " (" + p.status + ").", "info"); return false;
  }

  /* ---- add to home screen ------------------------------------------------
     Android (Chrome, Samsung, Edge) hands us an install prompt to show when
     the rider taps Add. iPhone and the browsers that give no prompt get the
     steps for their own menu instead. Nothing shows once the app is running
     from the home screen, or after the rider says not now on this phone. */
  var installEvt = null, installStepsKey = "";
  function standalone() { try { return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true; } catch (_) { return false; } }
  /* Which steps to show. The menu is different in every browser, and several
     (in-app browsers, some phone makers' own) cannot do it at all: those are
     sent to Chrome, where it always works. */
  function installKind() {
    var ua = navigator.userAgent || "";
    if (/Android/i.test(ua)) {
      if (/; wv\)|FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|MicroMessenger|Snapchat|TikTok|MiuiBrowser|VivoBrowser|HeyTapBrowser|OppoBrowser|UCBrowser|PHX\//i.test(ua)) return "installOtherAndroid";
      if (/SamsungBrowser/i.test(ua)) return "installSamsung";
      if (/Firefox/i.test(ua)) return "installFirefox";
      if (/OPR\/|Opera/i.test(ua)) return "installOpera";
      if (/EdgA\//i.test(ua)) return "installEdge";
      return "installAndroid";
    }
    if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return /CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua) ? "installIosOther" : "installIos";
    return "installDesktop";
  }
  function installFlag(k) { try { return localStorage.getItem(k) === "1"; } catch (_) { return false; } }
  function paintInstall() {
    var card = q("installCard"); if (!card) return;
    /* a fresh prompt means the app is not installed (any more), whatever this phone remembered */
    var show = !DEMO && !standalone() && !installFlag("novaxRiderInstallHide") && (!!installEvt || !installFlag("novaxRiderInstalled"));
    card.classList.toggle("hidden", !show);
  }
  q("installBtn").onclick = async function () {
    if (installEvt) {
      var e = installEvt; installEvt = null;
      try { e.prompt(); await e.userChoice; } catch (_) {}
      installStepsKey = ""; q("installSteps").classList.add("hidden"); q("installChrome").classList.add("hidden");
      paintInstall(); return;
    }
    installStepsKey = installKind(); q("installSteps").textContent = t(installStepsKey); q("installSteps").classList.remove("hidden");
    q("installChrome").classList.toggle("hidden", !/Android/i.test(navigator.userAgent || ""));
  };
  q("installHide").onclick = function () { try { localStorage.setItem("novaxRiderInstallHide", "1"); } catch (_) {} q("installCard").classList.add("hidden"); };
  /* Chrome hands the prompt over only after about half a minute on the page.
     If the rider tapped Add before that and is reading the steps, tell him
     the button is ready now. */
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); installEvt = e;
    if (installStepsKey) { installStepsKey = "installReady"; q("installSteps").textContent = t("installReady"); q("installChrome").classList.add("hidden"); }
    paintInstall();
  });
  window.addEventListener("appinstalled", function () {
    installEvt = null; try { localStorage.setItem("novaxRiderInstalled", "1"); } catch (_) {}
    paintInstall(); ping(t("installDone"), "ok", 30);
  });
  paintInstall();

  /* ---- Process (27 Oct 2026) ---------------------------------------------
     One place to work a pile of parcels: type, paste or scan tracking
     numbers in any shape -- N7810390, n7810390, 7810390, with or without
     commas, even run together -- and each 7-digit run becomes one AWB with
     the commas put in for you. The app then says what can happen to them
     here and does it in one tap: receive the sack, take everything out for
     delivery, collect. It uses the same saved actions as the other tabs, so
     offline saving, retries and the office log all still apply. */
  var PROC = { list: [] };
  function procParse(raw, typing) {
    var out = [], tail = "";
    String(raw || "").split(/[^0-9]+/).forEach(function (run, i, all) {
      if (!run) return;
      while (run.length >= 7) { out.push("N" + run.slice(0, 7)); run = run.slice(7); }
      if (run) { if (typing && i === all.length - 1) tail = run; }
    });
    var seen = {}; out = out.filter(function (a) { if (seen[a]) return false; seen[a] = true; return true; });
    return { awbs: out, tail: tail };
  }
  function procKind(p, mine) {
    if (!p) return { k: "missing", why: LANG === "ur" ? "Aap ke station par nahi" : "Not at your station" };
    if (pendingAwbs().has(p.awb.toUpperCase())) return { k: "saved", why: LANG === "ur" ? "Pehle se save" : "Already saved, sending" };
    if (p.bucket === "incoming") {
      var hub = p.meta && p.meta.hub && mine.indexOf(String(p.city).toLowerCase()) < 0;
      return { k: "receive", hub: !!hub, why: hub ? (LANG === "ur" ? "Hub par lein, phir " + p.city + " bhejein" : "Receive at the hub, then send to " + p.city) : (LANG === "ur" ? "Aa raha hai" : "Arriving") };
    }
    if (p.bucket === "station") { var lk = outLock(p); return lk ? { k: "locked", why: lk } : { k: "out", later: !!laterDay(p), why: laterDay(p) ? (LANG === "ur" ? "Customer ne " + dayLabel(laterDay(p)) + " kaha" : "Customer asked for " + dayLabel(laterDay(p))) : (LANG === "ur" ? "Station par" : "At station") }; }
    if (p.bucket === "pickup") return { k: "collect", why: LANG === "ur" ? "Uthana hai" : "To collect" };
    if (p.bucket === "transit") return { k: "transit", why: (LANG === "ur" ? "Bhejna hai: " : "To send to ") + (p.status === "Ready for return" ? p.origin : p.city) };
    if (p.bucket === "out") return { k: "isout", why: p.heldBy ? (LANG === "ur" ? p.heldBy + " ke paas" : "Out with " + p.heldBy) : (LANG === "ur" ? "Pehle se bahar" : "Already out for delivery") };
    if (p.bucket === "done") return { k: "done", why: LANG === "ur" ? "Deliver ho chuka" : "Delivered" };
    return { k: "other", why: p.status };
  }
  function procPaint() {
    var host = q("procList"), plan = q("procPlan"); if (!host || !plan) return;
    var mine = (data.rider && data.rider.cities || []).map(function (c) { return String(c).toLowerCase(); });
    var rows = PROC.list.map(function (a) { var p = data.parcels.find(function (x) { return x.awb.toUpperCase() === a; }); return { awb: a, p: p, s: procKind(p, mine) }; });
    var tone = { receive: "warn", out: "ok", collect: "warn", transit: "warn", locked: "bad", missing: "bad", isout: "", done: "", saved: "", other: "" };
    host.innerHTML = rows.map(function (r) {
      return '<div class="proc-row"><b class="awbx">' + esc(r.awb) + '</b><span class="proc-who">' + esc(r.p ? (r.p.consignee || "") + (r.p.city ? " · " + r.p.city : "") : "") + '</span>' +
        '<span class="tg ' + (tone[r.s.k] || "") + '">' + esc(r.s.why) + '</span><button type="button" class="proc-x" data-proc-del="' + esc(r.awb) + '" aria-label="Remove ' + esc(r.awb) + '">\u00d7</button></div>';
    }).join("");
    var by = function (k) { return rows.filter(function (r) { return r.s.k === k; }); };
    var rec = by("receive"), recLocal = rec.filter(function (r) { return !r.s.hub; }), outs = by("out"), col = by("collect"), tr = by("transit");
    var b = [];
    if (outs.length) b.push('<button class="btn proc-go" type="button" data-write data-proc="out">' + esc((LANG === "ur" ? "Delivery ke liye nikalein: " : "Take out for delivery: ") + outs.length) + '</button>');
    if (rec.length) b.push('<button class="btn proc-go secondary" type="button" data-write data-proc="receive">' + esc((LANG === "ur" ? "Receive karein: " : "Receive: ") + rec.length) + (rec.length > recLocal.length ? esc(LANG === "ur" ? " (" + (rec.length - recLocal.length) + " aage bhejne wale)" : " (" + (rec.length - recLocal.length) + " to send on)") : "") + '</button>');
    if (recLocal.length) b.push('<button class="btn proc-go" type="button" data-write data-proc="recout">' + esc((LANG === "ur" ? "Receive karke nikalein: " : "Receive and take out: ") + recLocal.length) + '</button>');
    if (col.length) b.push('<button class="btn proc-go secondary" type="button" data-write data-proc="collect">' + esc((LANG === "ur" ? "Uthayein: " : "Collect: ") + col.length) + '</button>');
    if (tr.length) b.push('<button class="btn proc-go secondary" type="button" data-proc-view="transit">' + esc((LANG === "ur" ? "Bhejne wale " + tr.length + " · Transit kholen" : tr.length + " to send on · open Transit")) + '</button>');
    var count = q("procCount"); if (count) count.textContent = rows.length ? (rows.length + (LANG === "ur" ? " number" : rows.length === 1 ? " number" : " numbers")) : "";
    plan.innerHTML = b.join("") || (rows.length ? '<p class="empty">' + esc(LANG === "ur" ? "Inn par yahan kuch nahi ho sakta." : "Nothing to do here for these numbers.") + '</p>' : "");
    controls();
  }
  function procSetFromInput(typing) {
    var el = q("procInput"); if (!el) return;
    var r = procParse(el.value, typing);
    /* Redraw only when the numbers change: tapping a button first blurs the
       box, and redrawing then replaced the button under the finger, so the
       tap was lost (found 27 Oct with a real tap). */
    var changed = r.awbs.join() !== PROC.list.join();
    PROC.list = r.awbs;
    var formatted = r.awbs.join(", ") + (r.tail ? (r.awbs.length ? ", " : "") + r.tail : (typing && r.awbs.length && /[0-9]$/.test(el.value) ? ", " : ""));
    if (el.value !== formatted && (typing || changed)) { el.value = formatted; try { el.setSelectionRange(formatted.length, formatted.length); } catch (_) {} }
    if (changed) procPaint();
  }
  function procAdd(awb) { var a = String(awb || "").toUpperCase().replace(/^N?/, "N"); if (!/^N\d{7}$/.test(a) || PROC.list.indexOf(a) > -1) return false;
    PROC.list.push(a); var el = q("procInput"); if (el) el.value = PROC.list.join(", ") + ", "; procPaint(); return true; }
  async function procRun(mode) {
    if (busy || flushing || !authorized) return;
    var mine = (data.rider && data.rider.cities || []).map(function (c) { return String(c).toLowerCase(); });
    var rows = PROC.list.map(function (a) { var p = data.parcels.find(function (x) { return x.awb.toUpperCase() === a; }); return { awb: a, p: p, s: procKind(p, mine) }; });
    var pick = function (k) { return rows.filter(function (r) { return r.s.k === k; }).map(function (r) { return r.p.awb; }); };
    var recv = pick("receive"), recLocal = rows.filter(function (r) { return r.s.k === "receive" && !r.s.hub; }).map(function (r) { return r.p.awb; });
    var outs = pick("out"), col = pick("collect"), done = [];
    busy = true; controls();
    try {
      if (mode === "collect" && col.length) { for (var i = 0; i < col.length; i += 200) await station(col.slice(i, i + 200), "collect", "", null, await gps(BAR_GPS.collect)); done = col; }
      if (mode === "receive" && recv.length) { for (var j = 0; j < recv.length; j += 200) await station(recv.slice(j, j + 200), "receive", "", null, null); done = recv; }
      if (mode === "recout" && recLocal.length) {
        if (!await confirm(LANG === "ur" ? "Receive karke nikalein" : "Receive and take out", (LANG === "ur" ? recLocal.length + " parcel receive honge aur delivery ke liye nikal jayenge." : recLocal.length + " parcels are received at your station and taken out for delivery in one go."))) return;
        var here = await gps(BAR_GPS.out);
        for (var k = 0; k < recLocal.length; k += 200) await station(recLocal.slice(k, k + 200), "receive", "", null, null);
        for (var l = 0; l < recLocal.length; l += 200) await station(recLocal.slice(l, l + 200), "out", "", null, here);
        done = recLocal;
      }
      if (mode === "out" && outs.length) {
        var extra = null, early = rows.filter(function (r) { return r.s.k === "out" && r.s.later; });
        if (early.length) {
          if (!await confirm(LANG === "ur" ? "Pehle le ja rahe hain?" : "Take out early?", (LANG === "ur" ? "Customer ne baad ka din kaha tha: " : "The customer asked for a later day: ") + early.slice(0, 5).map(function (r) { return r.awb; }).join(", ") + (early.length > 5 ? " +" + (early.length - 5) : "") + ". " + (LANG === "ur" ? "Customer se baat ho gayi hai to aaj le jayein." : "Take it out today only if the customer is ready."))) return;
          extra = { early: true };
        }
        var here2 = await gps(BAR_GPS.out);
        for (var m = 0; m < outs.length; m += 200) await station(outs.slice(m, m + 200), "out", "", extra, here2);
        done = outs;
      }
      if (done.length) {
        PROC.list = PROC.list.filter(function (a) { return done.map(function (d) { return d.toUpperCase(); }).indexOf(a) < 0; });
        var el = q("procInput"); if (el) el.value = PROC.list.length ? PROC.list.join(", ") + ", " : "";
      }
    } catch (e) { msg(String(e.message || e), "error"); }
    finally { busy = false; render(); procPaint(); void flush(); }
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
          if (ui.view === "process") procAdd(awb); else locate(awb);
          ov.querySelector(".scan-status").textContent = (ui.view === "process" ? PROC.list.length + " in the list" : ui.sel.size + " selected") + ". Keep scanning, or tap Done.";
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
      values.forEach(function (v) { if (ui.view === "process") procAdd(v); else locate(v); });
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
    if (busy || flushing || cashJobs().length || !connected || !navigator.onLine) return;
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
  q("procInput").addEventListener("input", function () { procSetFromInput(true); });
  q("procInput").addEventListener("paste", function () { setTimeout(function () { procSetFromInput(false); }, 0); });
  q("procInput").addEventListener("blur", function () { procSetFromInput(false); });
  q("procClear").onclick = function () { PROC.list = []; q("procInput").value = ""; procPaint(); q("procInput").focus(); };
  q("procScan").onclick = function () { void startScan(); };
  q("view-process").addEventListener("click", function (e) {
    var del = e.target.closest("[data-proc-del]");
    if (del) { var a = del.getAttribute("data-proc-del"); PROC.list = PROC.list.filter(function (x) { return x !== a; }); q("procInput").value = PROC.list.length ? PROC.list.join(", ") + ", " : ""; procPaint(); return; }
    var go = e.target.closest("[data-proc]"); if (go) { void procRun(go.getAttribute("data-proc")); return; }
    var v = e.target.closest("[data-proc-view]"); if (v) { ui.view = v.getAttribute("data-proc-view"); ui.sel.clear(); ui.selScope = ""; render(); window.scrollTo(0, 0); }
  });
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
  document.addEventListener("toggle", function (e) {
    var d = e.target; if (d && d.matches && d.matches("details[data-batch]")) ui.openBatch[d.dataset.batch] = d.open;
    if (d && d.matches && d.matches("details[data-route]")) ui.routeOpen = d.open;
    if (d && d.matches && d.matches("details[data-fold=stuck]")) ui.openStuck = d.open;
  }, true);
  document.addEventListener("change", function (e) {
    var cb = e.target.closest && e.target.closest("[data-pick]"); if (!cb) return;
    var awb = cb.dataset.pick;
    if (cb.checked) { ui.sel.add(awb); ui.selScope = scopeNow(); } else ui.sel.delete(awb);
    var card2 = cb.closest(".parcel"); if (card2) card2.classList.toggle("picked", cb.checked);
    paintBar(); controls();
  });
  document.addEventListener("click", async function (e) {
    /* Tapping a card's top row (AWB and status) ticks its box: a 30 px box is
       a small target on a bike with gloves on. Links and buttons keep their own job. */
    var head = e.target.closest(".parcel-head");
    if (head && !e.target.closest("input,button,a,label")) {
      var hcb = head.querySelector("[data-pick]");
      if (hcb && !hcb.disabled) { hcb.checked = !hcb.checked; hcb.dispatchEvent(new Event("change", { bubbles: true })); }
      if (hcb) return;
    }
    var retry = e.target.closest("[data-retry]");
    if (retry) { if (busy || flushing || !authorized) return; try { await lock(function () { queue.change(retry.dataset.retry, { state: "pending", error: "" }); }); render(); void flush(); } catch (err) { msg(String(err.message || err), "error"); } return; }
    var dis = e.target.closest("[data-discard]");
    if (dis) {
      if (busy || flushing || !authorized) return;
      var jk = dis.dataset.discard, job = jobs().find(function (j) { return j.key === jk; });
      if (!job) return;
      if (!navigator.onLine) { msg("Connect to the internet first, so the office has a record of what was removed.", "error"); return; }
      if (!await confirm("Remove this saved action?", "Only do this after the office has checked it. It will not be sent to NovaX, and the office keeps a record that it was removed.")) return;
      busy = true; controls();
      try {
        var lr = await sb.rpc("rider_queue_discard", { p_key: job.key, p_kind: job.kind, p_detail: job });
        if (lr.error) throw lr.error;
        await lock(function () { queue.remove(job.key); });
        ping("Removed. The office has a record of it.", "ok", 30);
      } catch (err) { msg("Could not remove it: " + String(err.message || err), "error"); }
      finally { busy = false; render(); }
      return;
    }
    var sw = e.target.closest("[data-swap]"); if (sw) { if (!sw.disabled) void swapAction(sw.dataset.awb, sw.dataset.swap); return; }
    var act = e.target.closest("[data-act]"); if (act) { if (!act.disabled) void outcome(act.dataset.awb, act.dataset.act); return; }
    var all = e.target.closest("[data-selall]");
    if (all) {
      var room = 200 - ui.sel.size, skipped = 0;
      String(all.dataset.awbs || "").split(",").filter(Boolean).forEach(function (a) {
        var cardEl = Array.from(document.querySelectorAll('.view:not(.hidden) [data-awb="' + a + '"]')).find(function (el) { return !el.hidden && !el.closest(".hidden"); });
        var cb = cardEl && cardEl.querySelector("[data-pick]");
        if (!cb || cb.disabled || ui.sel.has(a)) return;
        if (room <= 0) { skipped++; return; }
        ui.sel.add(a); room--;
      });
      ui.selScope = scopeNow(); render();
      if (skipped) ping("200 selected — the most one action can carry. Send these, then select the rest.", "info");
      return;
    }
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
    var go = e.target.closest("[data-goto]");
    if (go) { var g = go.dataset.goto.split(":"); ui.view = g[0]; if (g[1]) ui.tab[g[0]] = g[1]; if (g[1] === "station") ui.openStuck = true; ui.sel.clear(); ui.selScope = ""; q("riderSearch").value = ""; render(); window.scrollTo(0, 0); return; }
    var tab = e.target.closest("[data-tab]");
    if (tab) { var p = tab.dataset.tab.split(":"); ui.tab[p[0]] = p[1]; ui.sel.clear(); ui.selScope = ""; q("riderSearch").value = ""; render(); return; }
    var view = e.target.closest("[data-view]");
    if (view) {
      ui.view = view.dataset.view; ui.sel.clear(); ui.selScope = ""; q("riderSearch").value = ""; render(); window.scrollTo(0, 0);
      if (ui.view === "cash" && Date.now() - lastFull > 30000) void load(true);   /* cash figures are not in the 15-second check */
      return;
    }
  });
  q("logoutBtn").onclick = async function () {
    if (DEMO) { location.href = "index.html"; return; }
    if (busy || flushing) { msg("Wait for the current action before signing out.", "info"); return; }
    try {
      if (jobs().length && !await confirm("Saved actions remain", "Some actions are not confirmed. They stay attached to this rider on this phone and cannot send under another rider. Contact the office before clearing browser data. Sign out?")) return;
      var r = await sb.auth.signOut({ scope: "local" }); if (r.error) throw r.error;
      store.removeItem(cacheKey); authorized = false; forgetNote(); location.replace(SIGNIN_URL);
    } catch (e) { msg("Sign-out failed: " + String(e.message || e), "error"); }
  };
  /* The homepage is the one sign-in for every role. "for=rider" lets it greet
     a rider as a rider. The note below is what its Sign in buttons read to
     send a signed-in rider straight back here; it is written only for this
     login and removed when this login ends, so the next person on the same
     phone is never pointed at the wrong page. */
  var SIGNIN_URL = "index.html?for=rider#signin";
  function rememberNote(email) {
    if (DEMO) return;
    try { localStorage.setItem("novaxSession", JSON.stringify({ role: "rider", email: email || "", uid: userId, client_id: null, rider_id: riderId, at: Date.now() })); } catch (_) {}
  }
  function forgetNote() {
    if (DEMO) return;
    try { var n = JSON.parse(localStorage.getItem("novaxSession") || "null"); if (!n || !n.uid || n.uid === userId) localStorage.removeItem("novaxSession"); } catch (_) {}
  }
  async function boot() {
    try {
      if (!sb || !R || !P) throw new Error("A required app file did not load. Reconnect and reload.");
      var s = await sb.auth.getSession(); if (s.error) throw s.error; if (!s.data.session) { location.replace(SIGNIN_URL); return; }
      userId = s.data.session.user.id;
      var profile = await sb.from("profiles").select("role,status,rider_id").eq("id", userId).single();
      if (profile.error && !navigator.onLine) {
        var remembered = JSON.parse(store.getItem("novaxRiderIdentity:" + userId) || "null");
        if (remembered && remembered.user === userId && Date.now() - remembered.at < 864e5) profile = { data: remembered.profile };
      }
      if (profile.error) throw profile.error;
      if (profile.data && String(profile.data.role).toLowerCase() === "sales") { location.replace("sales.html"); return; }
      if (profile.data && String(profile.data.role).toLowerCase() === "support") { location.replace("care.html"); return; }
      if (!profile.data || String(profile.data.role).toLowerCase() !== "rider" || String(profile.data.status).toLowerCase() !== "active" || !profile.data.rider_id) throw new Error("This account is not an active rider. Contact the office.");
      riderId = profile.data.rider_id; queue = new R.Queue(store, userId, riderId); void voiceRefresh().then(function () { paintVoiceQueue(); render(); void voiceFlush(); }); cacheKey = "novaxRiderStation:v1:" + userId + ":" + riderId; jobs(); authorized = true;
      if (navigator.onLine) { try { store.setItem("novaxRiderIdentity:" + userId, JSON.stringify({ user: userId, at: Date.now(), profile: profile.data })); } catch (_) {} }
      rememberNote(s.data.session.user.email);
      try { var cached = JSON.parse(store.getItem(cacheKey) || "null"); if (cached && cached.user === userId && cached.rider === riderId) { data = cached.data; data.cash = null; lastSync = cached.at; render(); q("gate").classList.add("hidden"); } } catch (_) {}
      if (store.getItem("novaxRiderQueue")) msg("Legacy saved updates exist on this phone. The office must review them; they will not be sent under an unverified rider.", "error");
      if (authSubscription) authSubscription.unsubscribe();
      authSubscription = sb.auth.onAuthStateChange(function (event, session) {
        if (event === "SIGNED_OUT" || session && session.user.id !== userId) {
          authorized = false; connected = false; data = { rider: null, parcels: [], batches: [], cash: null };
          q("gate").classList.remove("hidden"); failGate("Your session changed. Sign in again.");
          try { store.removeItem(cacheKey); store.removeItem("novaxRiderIdentity:" + userId); } catch (_) {} if (event === "SIGNED_OUT") forgetNote(); geoStop(); controls();
        }
      }).data.subscription;
      await load(true);
      if (!connected && data.rider) msg("Offline. Showing your last saved station.", "error");
    } catch (e) { authorized = false; failGate(String(e.message || e)); }
  }
  /* ---- staying current (14 Oct 2026) -------------------------------------
     The app used to download the whole station (about 310 KB for Lahore)
     once a minute, and again every time the rider came back from WhatsApp,
     a call or Maps. Now it asks every 15 seconds whether anything changed,
     which costs a few bytes, and downloads only when something did, or at
     least every 3 minutes for the cash figures. If the server has no such
     check it falls back to the old download once a minute. */
  var CHECK_MS = 15000, FULL_MS = 180000;
  async function check() {
    if (document.hidden || !authorized || loading || busy || flushing || checking) return;
    if (!navigator.onLine) { paintNetwork(); return; }
    var age = Date.now() - lastFull;
    if (stampOff || !data.stamp) { if (age >= 60000) void load(true); else paintNetwork(); return; }
    if (age >= FULL_MS) { void load(true); return; }
    checking = true;
    try {
      var r; try { r = await sb.rpc("rider_station_stamp"); } catch (e) { r = { error: e }; }
      if (r.error) {
        if (R.retryable(r.error)) { connected = false; return; }
        if (/PGRST202|could not find the function/i.test(String(r.error.code || "") + " " + String(r.error.message || ""))) stampOff = true;
        void load(true); return;   /* a refusal (blocked, signed out): the full load says why */
      }
      connected = true;
      if (r.data !== data.stamp) void load(true); else lastSync = Date.now();
    } finally { checking = false; paintNetwork(); }
  }
  window.addEventListener("online", function () { void load(true); void voiceFlush(); });
  window.addEventListener("offline", function () { connected = false; controls(); });
  window.addEventListener("storage", function (e) { if (queue && e.key === queue.key && authorized) render(); });
  document.addEventListener("visibilitychange", function () { if (document.hidden) { stopScan(); geoSync(); } else { paintNetwork(); geoSync(); void check(); } });
  setInterval(function () { paintNetwork(); void check(); }, CHECK_MS);
  if (!DEMO && "serviceWorker" in navigator && !new URLSearchParams(location.search).has("nosw")) navigator.serviceWorker.register("/sw.js").catch(function () { msg("Offline app files could not be saved. Avoid reloading without signal.", "error"); });
  /* ---- preview: the station that lives in this page's memory -------------- */
  function demoClient() {
    var now = Date.now(), iso = function (h) { return new Date(now - (h || 0) * 36e5).toISOString(); }, n = 0, rows = [], batches = [], expenses = [], deposits = [];
    var me = "demo-rider", up = function (a) { return String(a || "").toUpperCase(); };
    var SH = { z: { name: "Zeb Store", phone: "0300 0000001", address: "Shop 14, Main Boulevard, Gulberg, Lahore" }, a: { name: "Anarkali Fabrics", phone: "0300 0000002", address: "Shop 3, New Anarkali, Lahore" },
               k: { name: "Karachi Kicks", phone: "0300 0000003", address: "Tariq Road, Karachi" } };
    var WHO = ["Ayesha K.", "Bilal R.", "Sana M.", "Hamza T.", "Fatima N.", "Usman J.", "Maryam S.", "Ali Z.", "Hira B.", "Omar F."];
    var AT = ["House 12, Block C, Johar Town", "Flat 4, Street 9, Model Town", "House 88, Phase 5, DHA Lahore", "Shop 6, Liberty Market, Gulberg", "House 31, Wapda Town", "House 7, Iqbal Town"];
    function add(bucket, status, origin, city, hours, sh, x) {
      n++; var p = { id: "demo-" + n, awb: "N" + (9000000 + n), client_id: "demo-" + sh, rider_id: null, consignee: WHO[n % WHO.length], phone: "0300 0000" + String(100 + n),
        address: AT[n % AT.length], city: city, origin: origin, cod_amount: 950 + (n * 170) % 2400, status: status, bucket: bucket, status_since: iso(hours), updated_at: iso(hours), delivered_at: null,
        held_by: null, outside: false, meta: { weight: "0.5 kg" }, exception: "", customer_reply: null, attempts: 0, shipper: Object.assign({ from_request: false }, SH[sh]) };
      Object.keys(x || {}).forEach(function (k) { p[k] = x[k]; }); rows.push(p); return p;
    }
    add("pickup", "New booked", "Lahore", "Lahore", 3, "z"); add("pickup", "New booked", "Lahore", "Lahore", 3, "z"); add("pickup", "New booked", "Lahore", "Karachi", 2, "z");
    add("pickup", "New booked", "Lahore", "Lahore", 20, "a"); add("pickup", "New booked", "Lahore", "Islamabad", 20, "a");
    var coming = [0, 0, 0, 0].map(function () { return add("incoming", "Parcel now in transit", "Karachi", "Lahore", 18, "k", { meta: { weight: "1 kg", transitBatch: "KAR-LAH-DEMO" } }).awb; });
    add("incoming", "Return in transit", "Lahore", "Karachi", 40, "a");
    for (var i = 0; i < 4; i++) add("station", "Parcel received at destination", "Karachi", "Lahore", 5 + i, "k");
    add("station", "Parcel received at destination", "Lahore", "Lahore", 4, "z", { cod_amount: 0, meta: { weight: "0.5 kg", paymentMode: "Prepaid" } });
    add("station", "Parcel received at destination", "Lahore", "Lahore", 6, "a", { customer_reply: { choice: "call_first", note: "", at: iso(1) } });
    add("station", "Reattempt", "Karachi", "Lahore", 20, "k", { attempts: 1, exception: "Customer asked for tomorrow", meta: { weight: "0.5 kg", steps: ["Reattempt"], nextAttempt: R.day(new Date(now + 864e5)) } });
    add("station", "Refused", "Karachi", "Lahore", 50, "k", { attempts: 1, exception: "Customer refused" }); add("station", "Refused", "Lahore", "Lahore", 30, "a", { attempts: 1, exception: "No money" });
    for (i = 0; i < 3; i++) add("out", "Parcel out for delivery", i ? "Karachi" : "Lahore", "Lahore", 2, i ? "k" : "z", { attempts: 1, rider_id: me });
    add("transit", "Collected by rider", "Lahore", "Karachi", 6, "z"); add("transit", "Collected by rider", "Lahore", "Karachi", 6, "a"); add("transit", "Collected by rider", "Lahore", "Islamabad", 7, "a");
    add("done", "Delivered", "Karachi", "Lahore", 1, "k", { rider_id: me, delivered_at: iso(1), attempts: 1 }); add("done", "Delivered", "Lahore", "Lahore", 2, "z", { rider_id: me, delivered_at: iso(2), attempts: 1 });
    batches.push({ code: "KAR-LAH-DEMO", kind: "forward", from_city: "Karachi", to_city: "Lahore", reference: "Daewoo 558812", awbs: coming.slice(), received: [], status: "Sent", sent_at: iso(18) });
    function copy(v) { return JSON.parse(JSON.stringify(v)); }
    function put(p, status, bucket) { p.status = status; p.bucket = bucket; p.status_since = p.updated_at = iso(0); }
    function cash() {
      var hand = rows.filter(function (p) { return p.status === "Delivered" && p.cod_amount > 0 && !p._hand; }), g = hand.reduce(function (t, p) { return t + p.cod_amount; }, 0);
      var x = expenses.reduce(function (t, e) { return t + (e.settled ? 0 : e.amount); }, 0), row = function (p) { return { awb: p.awb, consignee: p.consignee, city: p.city, cod: p.cod_amount, delivered_at: p.delivered_at }; };
      return { gross: g, expenses: x, net: Math.max(0, g - x), count: hand.length, pending: deposits.reduce(function (t, d) { return t + d.net; }, 0), review: x > g, hand_rows: hand.map(row), pending_rows: deposits, confirmed_rows: [], expense_rows: expenses };
    }
    var rev = 1;   /* the preview's answer to "has anything changed?" */
    /* A made-up morning in Lahore: out from the station, two deliveries, one refusal. */
    var route = (function () {
      var st = [{ h: 3, action: "out", awbs: ["N9000020", "N9000021", "N9000022", "N9000026", "N9000027"], lat: 31.5204, lng: 74.3587, acc: 12 },
        { h: 2, action: "delivered", awbs: ["N9000027"], lat: 31.5102, lng: 74.3431, acc: 9, km: 1.86 },
        { h: 1.5, action: "refused", awbs: ["N9000019"], lat: 31.4983, lng: 74.3302, acc: 16, km: 1.8 },
        { h: 1, action: "delivered", awbs: ["N9000026"], lat: 31.4721, lng: 74.2717, acc: 11, km: 6.27 }];
      return { day: R.day(new Date()), km: 9.9, n: st.length, gps: st.length, same: 0, stops: st.map(function (s) { var o = Object.assign({ at: iso(s.h) }, s); delete o.h; return o; }) };
    })();
    function act(a) {
      rev++;
      var codes = (a.p_awbs || []).map(up), ex = a.p_extra || {}, moved = [], batch = null;
      if (a.p_action === "transit") {
        batch = "LAH-" + String(ex.to_city || "").replace(/[^a-z]/gi, "").slice(0, 3).toUpperCase() + "-DEMO-" + (batches.length + 1);
        batches.unshift({ code: batch, kind: "forward", from_city: "Lahore", to_city: ex.to_city, reference: ex.reference, awbs: codes, received: [], status: "Sent", sent_at: iso(0), mine: true });
      }
      codes.forEach(function (code) {
        var p = rows.filter(function (r) { return up(r.awb) === code && r.bucket; })[0]; if (!p) return;
        var back = /^Return/.test(p.status), local = String(p.city).toLowerCase() === "lahore";
        if (a.p_action === "collect") put(p, local ? "Parcel received at destination" : "Collected by rider", local ? "station" : "transit");
        else if (a.p_action === "receive") { put(p, back ? "Return received at origin" : "Parcel received at destination", "station");
          batches.forEach(function (b) { if (b.awbs.indexOf(code) > -1 && b.received.indexOf(code) < 0) { b.received.push(code); b.status = b.received.length === b.awbs.length ? "Received" : "Partly received"; } }); }
        else if (a.p_action === "out") { put(p, back ? "Return out for delivery" : "Parcel out for delivery", "out"); p.attempts++; p.rider_id = me; }
        else if (a.p_action === "delivered") { if (back) put(p, "Return to shipper", null); else { put(p, "Delivered", "done"); p.delivered_at = iso(0); p.rider_id = me; } }
        else if (a.p_action === "reattempt") { put(p, "Reattempt", "station"); p.exception = a.p_reason || ""; p.meta.nextAttempt = ex.next_date; p.meta.steps = (p.meta.steps || []).concat(["Reattempt"]); }
        else if (a.p_action === "refused") { put(p, "Refused", "station"); p.exception = a.p_reason || ""; }
        else if (a.p_action === "not_available") { put(p, back ? "Return received at origin" : "Consignee not available", "station"); p.exception = a.p_reason || ""; }
        else if (a.p_action === "transit") put(p, "Parcel now in transit", null);
        moved.push(p.awb);
      });
      return { action: a.p_action, count: moved.length, moved: moved, batch: batch };
    }
    function rpc(name, a) {
      a = a || {}; var d = {};
      if (name === "rider_station_view") d = { rider: { id: me, name: "Demo Rider", branch: "Lahore Hub", cities: ["Lahore"], cash_limit: 75000 }, parcels: rows.filter(function (p) { return p.bucket; }),
        batches: batches.filter(function (b) { return b.mine || b.status !== "Received"; }), route: route, stamp: "demo-" + rev, server_time: iso(0) };
      else if (name === "rider_station_stamp") d = "demo-" + rev;
      else if (name === "rider_cash_summary") d = cash();
      else if (name === "rider_today") d = rows.filter(function (p) { return /Delivered|Refused|Consignee not available/.test(p.status); }).slice(0, 6).map(function (p, i) {
          return { awb: p.awb, consignee: p.consignee, city: p.city, to_status: p.status, changed_at: iso((i + 1) * 0.5), voice: p.status === "Delivered" ? null : (i % 2 ? "sent" : "skipped") }; });
      else if (name === "rider_station_action") d = act(a);
      else if (name === "rider_add_expense") { expenses.unshift({ category: a.p_category, amount: Number(a.p_amount) || 0, note: a.p_note || "", expenseDate: R.day(new Date()), settled: false, createdAt: iso(0) }); d = { ok: true }; }
      else if (name === "rider_deposit_cash_v2") { var c = cash(), hand = rows.filter(function (p) { return p.status === "Delivered" && p.cod_amount > 0 && !p._hand; });
        hand.forEach(function (p) { p._hand = true; }); expenses.forEach(function (e) { e.settled = true; });
        deposits.push({ batch: a.p_batch_key, net: c.net, gross: c.gross, expenses: c.expenses, method: a.p_method, reference: a.p_reference, at: iso(0), parcels: hand.length, awbs: hand.map(function (p) { return p.awb; }) }); d = { net: c.net }; }
      else d = { ok: true };
      return Promise.resolve({ data: copy(d), error: null });
    }
    var session = { data: { session: { user: { id: "demo-user", email: "" } } }, error: null };
    return { rpc: rpc,
      storage: { from: function () { return { upload: function (path) { return Promise.resolve({ data: { path: path }, error: null }); } }; } },
      auth: { getSession: function () { return Promise.resolve(session); }, signOut: function () { return Promise.resolve({ error: null }); }, onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; } },
      from: function () { var o = { select: function () { return o; }, eq: function () { return o; }, single: function () { return Promise.resolve({ data: { role: "rider", status: "active", rider_id: me }, error: null }); } }; return o; } };
  }
  if (DEMO) {
    q("notice").insertAdjacentHTML("beforebegin", '<div class="demo-bar" data-t="demoBar" role="note"></div>');
    q("logoutBtn").setAttribute("data-t", "demoExit");
    /* a made-up number must never ring a real phone */
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("a.call"); if (!a) return;
      if (/^(tel:|https:\/\/wa\.me\/)/.test(a.getAttribute("href") || "")) { e.preventDefault(); e.stopPropagation(); ping(t("demoNoCall"), "info"); }
    }, true);
  }
  paintWords();
  void boot();
})();
