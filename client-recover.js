/* =====================================================================
   Nova Recover (phase 1, 8 Oct 2026) -- loaded only when the tab opens.

   The merchant sees every parcel that was refused or came back, picks the
   ones worth another try, and sends them to the NovaX Support Desk. An
   agent phones the customer and sells the order again. Rs 100 for each
   order recovered.

   This file is the merchant's side: the launch pop-up, the list with quick
   selection, the confirm sheet (how many rupees the agent may take off),
   "With NovaX" with Take back, and "Recovered". It reads and writes only
   through the client_recover_* functions (sql_novax_recover_20261008.sql),
   so every rule (who may push, the wallet floor, one case per parcel) is
   the server's. Nothing here books a parcel or touches the wallet.

   It reaches the portal through window.__nvRcBridge (client-app.js).

   Published through scripts/build-public.mjs: a new file like this one is
   only on the live site once it is in that list.

   In the demo portal there is no backend, so the same five calls are
   answered from this browser's storage. That copy exists for previewing on
   localhost; the tab is not shown in the public demo.
   ===================================================================== */
(function(){
  "use strict";
  if (window.NovaXRecover) return;

  var B = null, HOST = null;
  var S = { st:null, parcels:[], cases:[], loaded:false, loading:false, err:"", seg:"todo", sel:{}, busy:false,
            key:null, popAsked:false, entered:false, taking:"", phones:{}, casePhones:{}, saving:"" };

  function esc(v){ return B.esc(v == null ? "" : String(v)); }
  function rs(n){ return "Rs " + Math.round(Number(n) || 0).toLocaleString("en-US"); }
  function reduced(){ try{ return matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){ return false; } }
  function seen(){ return document.visibilityState === "visible" && !reduced(); }
  var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function day(iso){
    if (!iso) return "";
    var d = new Date(iso); if (!isFinite(d)) return "";
    var p; try{ p = d.toLocaleDateString("en-CA", { timeZone:"Asia/Karachi" }).split("-"); }catch(e){ p = d.toISOString().slice(0,10).split("-"); }
    var now = new Date().getFullYear();
    return Number(p[2]) + " " + MON[Number(p[1]) - 1] + (Number(p[0]) !== now ? " " + p[0] : "");
  }
  function daysAgo(iso){ var t = Date.parse(iso); return isFinite(t) ? (Date.now() - t) / 86400000 : 9999; }
  /* A number that can be dialled: 10 to 13 digits, the rule the server applies. */
  function okPhone(v){ var d = String(v == null ? "" : v).replace(/\D/g, ""); return d.length >= 10 && d.length <= 13; }
  function newKey(){
    try{ if (crypto && crypto.randomUUID) return "rc-" + crypto.randomUUID(); }catch(e){}
    return "rc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  function friendly(e){
    var m = (e && (e.message || e.error_description)) || String(e || "");
    if (/Failed to fetch|NetworkError|timeout|aborted/i.test(m)) return "No connection. Check your internet and try again.";
    if (/JWT|not authenticated|session/i.test(m)) return "This page is no longer signed in. Sign in again.";
    if (/PGRST202|could not find the function|schema cache/i.test(m)) return "Nova Recover is not available yet.";
    return m || "Something went wrong. Try again.";
  }

  /* ---------------------------------------------------------- backend */
  function rpc(name, args){
    if (B.demo()) return demoRpc(name, args || {});
    var sb = B.sb();
    if (!sb || !sb.rpc) return Promise.reject(new Error("This page is no longer signed in. Sign in again."));
    /* supabase-js resolves with {error}: a failed call must not read as success. */
    return Promise.resolve(sb.rpc(name, args || {})).then(function(r){
      if (!r || r.error) throw new Error(friendly(r && r.error));
      return r.data;
    }, function(e){ throw new Error(friendly(e)); });
  }

  /* The local copy for the demo portal. Same answers, same refusals. */
  var DEMO_KEY = "nvRecoverPreview";
  function demoSeed(){
    var H = 3600000, D = 24 * H, now = Date.now();
    function p(n, name, city, cod, st, age, why){
      return { parcel_id:"demo-rc-" + n, awb:"N90010" + (n < 10 ? "0" + n : n), consignee:name, city:city, cod:cod, status:st,
               kind: st === "Refused" ? "refused" : "returned", came_back_at:new Date(now - age).toISOString(), reason:why, block:null,
               /* The two oldest have no number, like real parcels booked before 19 Aug 2026. */
               phone: n >= 11 ? "" : "0300-00000" + (10 + n), address: n >= 11 ? "" : "House " + (n * 7) + ", Block " + ((n % 9) + 1) + ", " + city };
    }
    return { v:2, accepted:false, seq:1001, cases:[], parcels:[
      p(1,  "Usman Tariq",     "Karachi",    1200, "Refused",            20 * H, "Consignee refused at doorstep"),
      p(2,  "Ayesha Malik",    "Lahore",     3450, "Refused",            1 * D + 3 * H, "Customer said the price was high"),
      p(3,  "Hamza Sheikh",    "Lahore",     2499, "Refused",            2 * D, "Refused, no reason given"),
      p(4,  "Sadia Imran",     "Karachi",    1850, "Return to shipper",  4 * D, "Changed their mind"),
      p(5,  "Bilal Qureshi",   "Islamabad",  5200, "Return to shipper",  5 * D, "Customer not available, then refused"),
      p(6,  "Nimra Javed",     "Rawalpindi",  990, "Return to shipper",  6 * D, "Refused at door"),
      p(7,  "Farhan Ali",      "Karachi",    2750, "Return to shipper",  9 * D, "Asked to deliver later, then refused"),
      p(8,  "Zainab Noor",     "Lahore",     4100, "Return to shipper",  12 * D, "Wanted to open the parcel first"),
      p(9,  "Owais Raza",      "Karachi",    1500, "Return to shipper",  16 * D, "Refused, no reason given"),
      p(10, "Mahnoor Aslam",   "Lahore",     2200, "Return to shipper",  21 * D, "Customer did not have cash"),
      p(11, "Danish Iqbal",    "Islamabad",  3100, "Return to shipper",  33 * D, "Refused at door"),
      p(12, "Rabia Anwar",     "Karachi",     850, "Return to shipper",  47 * D, "Changed their mind")
    ]};
  }
  /* client.html?demo=1&rcreset=1 starts the preview again from the sample parcels. */
  try{ if (/[?&]rcreset=/.test(location.search)) { localStorage.removeItem(DEMO_KEY); localStorage.removeItem("nvRcSeen"); } }catch(e){}
  function demoGet(){
    try{ var j = JSON.parse(localStorage.getItem(DEMO_KEY) || "null"); if (j && j.v === 2 && Array.isArray(j.parcels)) return j; }catch(e){}
    var s = demoSeed(); demoPut(s); return s;
  }
  function demoPut(s){ try{ localStorage.setItem(DEMO_KEY, JSON.stringify(s)); }catch(e){} }
  var DEMO_CFG = { fee:100, wallet_floor:-1000, max_push:30, terms_version:"2026-10-08", wallet_balance:3425 };
  try{ var pc = JSON.parse(localStorage.getItem("nvRecoverPreviewCfg") || "{}") || {};
       ["fee", "wallet_floor", "max_push", "terms_version"].forEach(function(k){ if (pc[k] != null) DEMO_CFG[k] = pc[k]; }); }catch(e){}
  function demoOpen(c){ return c.status === "waiting" || c.status === "calling" || c.status === "callback"; }
  function demoBlock(s, id){
    var cs = s.cases.filter(function(c){ return c.parcel_id === id; });
    if (cs.some(demoOpen)) return "open";
    if (cs.some(function(c){ return c.status === "recovered" || c.status === "not_recovered"; })) return "done";
    if (cs.some(function(c){ return c.status === "unreachable" && daysAgo(c.closed_at) < 7; })) return "wait";
    return null;
  }
  function demoCasePublic(c){ var o = {}; for (var k in c) if (k !== "phone" && k !== "address") o[k] = c[k]; o.no_phone = !String(c.phone || "").trim(); return o; }
  function demoRpc(name, a){
    return new Promise(function(resolve, reject){
      setTimeout(function(){
        try{
          var s = demoGet();
          if (name === "client_recover_state") {
            return resolve({ visible:true, accepted:!!s.accepted && (s.accepted_version || "2026-10-08") === DEMO_CFG.terms_version, terms_version:DEMO_CFG.terms_version, fee:DEMO_CFG.fee,
              wallet_floor:DEMO_CFG.wallet_floor, max_push:DEMO_CFG.max_push, wallet_balance:DEMO_CFG.wallet_balance, wallet_low:false, may_push:true,
              unseen:s.cases.filter(function(c){ return c.status === "recovered" && !c.seen; }).length,
              counts:{ to_recover:s.parcels.filter(function(p){ return demoBlock(s, p.parcel_id) == null; }).length,
                       with_novax:s.cases.filter(demoOpen).length,
                       recovered:s.cases.filter(function(c){ return c.status === "recovered"; }).length } });
          }
          if (name === "client_recover_accept") {
            if (a.p_version !== DEMO_CFG.terms_version) throw new Error("Nova Recover was updated. Reload the page and read the new wording.");
            s.accepted = true; s.accepted_version = DEMO_CFG.terms_version; demoPut(s); return resolve({ accepted:true, terms_version:DEMO_CFG.terms_version });
          }
          if (name === "client_recover_list") {
            return resolve({
              parcels:s.parcels.map(function(p){ var o = {}; for (var k in p) if (k !== "phone" && k !== "address") o[k] = p[k]; o.block = demoBlock(s, p.parcel_id); o.no_phone = !String(p.phone || "").trim(); return o; })
                       .filter(function(p){ return p.block !== "open"; }),
              cases:s.cases.filter(function(c){ return c.status !== "withdrawn"; }).map(demoCasePublic)
                     .sort(function(x, y){ return x.pushed_at < y.pushed_at ? 1 : -1; }) });
          }
          if (name === "client_recover_push") {
            if (!s.accepted || (s.accepted_version || "2026-10-08") !== DEMO_CFG.terms_version) throw new Error("Open Nova Recover and tap Start recovering first.");
            var same = s.cases.filter(function(c){ return a.p_key && c.push_key === a.p_key; });
            if (same.length) return resolve({ pushed:same.length, repeat:true });
            var ids = (a.p_parcels || []).filter(function(x, i, arr){ return x && arr.indexOf(x) === i; });
            if (a.p_in_stock !== true && ids.some(function(id){ var q = s.parcels.filter(function(x){ return x.parcel_id === id; })[0]; return q && q.kind === "returned"; }))
              throw new Error('Tick "I still have the returned items" first.');
            if (!ids.length) throw new Error("Choose at least one parcel.");
            if (ids.length > DEMO_CFG.max_push) throw new Error("Send at most " + DEMO_CFG.max_push + " parcels at a time.");
            var off = Number(a.p_max_discount || 0);
            if (!(off >= 0) || off !== Math.round(off) || off > 50000) throw new Error("The discount must be a whole number of rupees.");
            var bad = ids.filter(function(id){ var p = s.parcels.filter(function(x){ return x.parcel_id === id; })[0]; return !p || demoBlock(s, id) != null; });
            if (bad.length) throw new Error("These can no longer be sent. Refresh the list and try again.");
            var typed = a.p_phones || {};
            var nonum = ids.filter(function(id){ var p = s.parcels.filter(function(x){ return x.parcel_id === id; })[0]; return !String(p.phone || "").trim() && !okPhone(typed[id]); });
            if (nonum.length) throw new Error("Add the customer's phone number for: " + nonum.map(function(id){ return s.parcels.filter(function(x){ return x.parcel_id === id; })[0].awb; }).join(", ") + ". We need it to call them.");
            ids.forEach(function(id){
              var p = s.parcels.filter(function(x){ return x.parcel_id === id; })[0];
              s.cases.push({ id:"demo-case-" + s.seq, code:"RC-" + (s.seq++), parcel_id:id, awb:p.awb, kind:p.kind, status:"waiting",
                consignee:p.consignee, phone:String(p.phone || "").trim() || String(typed[id]).trim(), address:p.address, city:p.city, cod:p.cod, rider_reason:p.reason, came_back_at:p.came_back_at,
                max_discount:Math.min(off, p.cod), item_note:String((a.p_items || {})[id] || "").trim().slice(0, 140) || null,
                merchant_note:String(a.p_note || "").trim().slice(0, 300) || null, push_key:a.p_key || null,
                pushed_at:new Date().toISOString(), tries:0, callback_at:null, closed_at:null, reason:null, rider_fault:false,
                agreed_date:null, agreed_cod:null, new_awb:null, fee:null, merchant:B.clientName() || "Demo store" });
            });
            demoPut(s); return resolve({ pushed:ids.length, repeat:false });
          }
          if (name === "client_recover_summary") {
            var rec = s.cases.filter(function(c){ return c.status === "recovered"; });
            return resolve({ visible:true, recovered:rec.length, cod:rec.reduce(function(t, c){ return t + (c.agreed_cod || 0); }, 0),
              fees:rec.reduce(function(t, c){ return t + (c.fee || 0); }, 0), delivered:0, delivered_cod:0 });
          }
          if (name === "client_recover_seen") {
            s.cases.forEach(function(c){ if (c.status === "recovered") c.seen = true; }); demoPut(s); return resolve({ seen:true });
          }
          if (name === "client_recover_add_phone") {
            var k = s.cases.filter(function(x){ return x.id === a.p_case; })[0];
            if (!okPhone(a.p_phone)) throw new Error("Check the phone number. It should look like 0300 1234567.");
            if (!k) throw new Error("That parcel is not with Nova Recover.");
            if (!demoOpen(k)) throw new Error("This case is already closed.");
            if (String(k.phone || "").trim()) throw new Error("We already have a number for this customer. Message NovaX support if it is wrong.");
            k.phone = String(a.p_phone).trim(); demoPut(s); return resolve({ ok:true, awb:k.awb });
          }
          if (name === "client_recover_withdraw") {
            var c = s.cases.filter(function(x){ return x.id === a.p_case; })[0];
            if (!c) throw new Error("That parcel is not with Nova Recover.");
            if (c.status === "withdrawn") return resolve({ withdrawn:true, awb:c.awb });
            if (c.status !== "waiting" || c.tries > 0) throw new Error("We have already started calling this customer, so it cannot be taken back.");
            c.status = "withdrawn"; demoPut(s); return resolve({ withdrawn:true, awb:c.awb });
          }
          resolve(null);
        }catch(e){ reject(e); }
      }, 260);
    });
  }

  /* -------------------------------------------------------------- load */
  function load(){
    if (S.loading) return;
    S.loading = true; S.err = ""; draw();
    rpc("client_recover_state").then(function(st){
      S.st = st || { visible:false };
      try{ B.setState(S.st); }catch(e){}
      if (!S.st.visible) { S.loading = false; S.loaded = true; draw(); return null; }
      return rpc("client_recover_list").then(function(l){
        S.parcels = (l && l.parcels) || []; S.cases = (l && l.cases) || [];
        /* A parcel that left the list cannot stay selected. */
        var ok = {}; S.parcels.forEach(function(p){ if (!p.block && S.sel[p.parcel_id]) ok[p.parcel_id] = 1; }); S.sel = ok;
        S.loading = false; S.loaded = true;
        var hand = S.pick; S.pick = null;
        if (hand && hand.length) {
          S.sel = {}; S.seg = "todo"; S.key = null;
          S.parcels.forEach(function(p){ if (!p.block && hand.indexOf(p.parcel_id) > -1) S.sel[p.parcel_id] = 1; });
        }
        draw();
        if (!S.st.accepted && !S.popAsked) { S.popAsked = true; openLaunch(); }
        else if (hand && picked().length) openConfirm();
      });
    }).catch(function(e){ S.loading = false; S.err = friendly(e); draw(); });
  }

  /* The merchant has looked at what was recovered: the Home notice can go. */
  function markSeen(){
    if (!S.st || !(Number(S.st.unseen) > 0) || S.seeing) return;
    S.seeing = true;
    rpc("client_recover_seen").then(function(){ S.seeing = false; S.st.unseen = 0; try{ B.setState(S.st); }catch(e){} }, function(){ S.seeing = false; });
  }

  /* ------------------------------------------------------------ derive */
  function pushable(){ return S.parcels.filter(function(p){ return !p.block; }); }
  function blocked(){ return S.parcels.filter(function(p){ return !!p.block; }); }
  function picked(){ return pushable().filter(function(p){ return S.sel[p.parcel_id]; }); }
  function openCases(){ return S.cases.filter(function(c){ return c.status === "waiting" || c.status === "calling" || c.status === "callback"; }); }
  function closedCases(){ return S.cases.filter(function(c){ return c.status === "not_recovered" || c.status === "unreachable"; }); }
  function wonCases(){ return S.cases.filter(function(c){ return c.status === "recovered"; }); }
  /* Cases the desk cannot dial: the parcel had no number and none was typed. */
  function numberless(){ return openCases().filter(function(c){ return c.no_phone; }); }
  function maxPush(){ return (S.st && S.st.max_push) || 30; }
  /* The fee is whatever the server says, including Rs 0. Only a missing
     value falls back. */
  function fee(){ var f = S.st ? S.st.fee : null; return (f == null || f === "" || !isFinite(Number(f))) ? 100 : Number(f); }
  function free(){ return fee() <= 0; }
  function sum(list){ return list.reduce(function(t, p){ return t + (Number(p.cod) || 0); }, 0); }
  function canSend(){ return !!(S.st && S.st.may_push && !S.st.wallet_low); }

  var CASE_TEXT = {
    waiting:["Waiting for a call", "wait"], calling:["Calling", "live"], callback:["Call back", "live"],
    recovered:["Recovered", "won"], not_recovered:["Not recovered", "lost"], unreachable:["Could not reach", "lost"]
  };

  /* -------------------------------------------------------------- draw */
  function draw(){
    if (!HOST) return;
    if (!S.loaded && S.loading) {
      HOST.innerHTML = '<div class="nv-rc-wrap"><div class="nv-rc-sk"><i style="width:46%"></i><i style="width:82%"></i><i style="width:64%"></i></div></div>';
      return;
    }
    if (S.err && !S.loaded) {
      HOST.innerHTML = '<div class="nv-rc-wrap"><div class="panel nv-rc-empty"><h3>Could not open Nova Recover</h3><p>' + esc(S.err) +
        '</p><button type="button" class="action-btn" data-rc="reload">Try again</button></div></div>';
      return;
    }
    if (!S.st || !S.st.visible) {
      HOST.innerHTML = '<div class="nv-rc-wrap"><div class="panel nv-rc-empty"><h3>Nova Recover is not open for this account yet</h3><p>We will tell you when it is.</p></div></div>';
      return;
    }
    var todo = pushable(), oc = openCases(), won = wonCases();
    var h = '<div class="nv-rc-wrap">';
    h += '<header class="nv-rc-head"><div><p class="nv-rc-eyebrow">Nova Recover</p><h2>Recover these orders</h2>' +
         '<p class="nv-rc-lede">' + (todo.length
            ? '<b>' + todo.length + (todo.length === 1 ? ' parcel' : ' parcels') + '</b> worth <b>' + esc(rs(sum(todo))) + '</b> ' + (todo.length === 1 ? 'was' : 'were') + ' refused or came back. We call the customer and sell the order again.'
            : 'We call customers who refused your parcels and sell the order again.') +
         '</p></div><div class="nv-rc-price"><b>' + (free() ? "No fee" : esc(rs(fee()))) + '</b><span>' + (free() ? "for a recovered order, for now." : "for each order we recover.<br>Nothing if we cannot.") + '</span>' +
         '<button type="button" class="nv-rc-link" data-rc="how">How it works</button></div></header>';

    if (S.st.wallet_low) h += '<p class="nv-rc-banner" role="status">Your wallet is at ' + esc(rs(S.st.wallet_balance)) + '. Nova Recover opens again once it is above ' + esc(rs(S.st.wallet_floor)) + '.</p>';
    else if (!S.st.may_push) h += '<p class="nv-rc-banner" role="status">You can see this, but only the account owner or a warehouse login can send parcels.</p>';
    if (B.demo()) h += '<p class="nv-rc-banner is-demo" role="status">Preview with sample parcels. Nothing here reaches a real customer.</p>';
    var nn = numberless().length;
    if (nn) h += '<p class="nv-rc-banner is-num" role="status"><b>We cannot call ' + nn + (nn === 1 ? ' customer' : ' customers') + ' yet.</b> ' +
      (nn === 1 ? 'That order has' : 'Those orders have') + ' no phone number saved with NovaX. ' +
      (S.st.may_push ? (S.seg === "with" ? 'Add ' + (nn === 1 ? 'it' : 'them') + ' below.' : '<button type="button" class="nv-rc-link" data-rc-seg="with">Add ' + (nn === 1 ? 'the number' : 'the numbers') + '</button>')
                     : 'Ask the account owner or a warehouse login to add ' + (nn === 1 ? 'it' : 'them') + '.') + '</p>';

    h += '<div class="nv-rc-segs" role="tablist" aria-label="Nova Recover">' +
      seg("todo", "To recover", todo.length) + seg("with", "With NovaX", oc.length) + seg("won", "Recovered", won.length) + '</div>';

    if (S.seg === "todo") h += drawTodo(todo);
    else if (S.seg === "with") h += drawWith(oc);
    else { h += drawWon(won); markSeen(); }
    h += '</div>';
    HOST.innerHTML = h;
    drawBar();
    if (!S.entered) { S.entered = true; enter(); }
  }
  function seg(id, label, n){
    return '<button type="button" role="tab" class="nv-rc-seg' + (S.seg === id ? " is-on" : "") + '" aria-selected="' + (S.seg === id) + '" data-rc-seg="' + id + '">' +
      esc(label) + ' <span>' + n + '</span></button>';
  }
  function chip(kind){
    return kind === "refused" ? '<span class="nv-rc-chip is-here">Still with NovaX</span>' : '<span class="nv-rc-chip">Returned to you</span>';
  }
  function drawTodo(todo){
    var bl = blocked();
    if (!todo.length && !bl.length) {
      return '<div class="panel nv-rc-empty"><h3>Nothing to recover</h3><p>You have no refused or returned parcels' +
        (openCases().length ? ' left to send. ' + openCases().length + ' are with NovaX now.' : '.') + '</p></div>';
    }
    var cap = maxPush(), n7 = todo.filter(function(p){ return daysAgo(p.came_back_at) <= 30; }).length,
        big = todo.filter(function(p){ return Number(p.cod) >= 2000; }).length, np = picked().length;
    var h = '';
    if (todo.length) {
      h += '<div class="nv-rc-quick" role="group" aria-label="Quick select">' +
        '<button type="button" class="nv-rc-q" data-rc-pick="all">' + (todo.length > cap ? 'Select first ' + cap : 'Select all') + ' <span>' + Math.min(todo.length, cap) + '</span></button>' +
        '<button type="button" class="nv-rc-q" data-rc-pick="week"' + (n7 ? '' : ' disabled') + '>Last 30 days <span>' + Math.min(n7, cap) + '</span></button>' +
        '<button type="button" class="nv-rc-q" data-rc-pick="big"' + (big ? '' : ' disabled') + '>Above Rs 2,000 <span>' + big + '</span></button>' +
        '<button type="button" class="nv-rc-q is-clear" data-rc-pick="none"' + (np ? '' : ' hidden') + '>Clear</button></div>';
      h += '<ul class="nv-rc-list" id="nvRcList">' + todo.map(row).join("") + '</ul>';
    }
    if (bl.length) {
      h += '<h3 class="nv-rc-sub">Already tried</h3><ul class="nv-rc-list is-off">' + bl.map(function(p){
        return '<li class="nv-rc-row is-blocked"><span class="nv-rc-box" aria-hidden="true"></span><span class="nv-rc-main"><b>' + esc(p.consignee || "Customer") +
          '</b><small>' + esc([p.city, day(p.came_back_at)].filter(Boolean).join(" · ")) + '</small><small class="nv-rc-why">' +
          (p.block === "wait" ? "We could not reach them. You can send it again in a few days." : "We already called this customer.") +
          '</small></span><span class="nv-rc-cod">' + esc(rs(p.cod)) + '</span></li>';
      }).join("") + '</ul>';
    }
    return h;
  }
  function row(p){
    var on = !!S.sel[p.parcel_id];
    return '<li><label class="nv-rc-row' + (on ? " is-on" : "") + '" data-rc-row="' + esc(p.parcel_id) + '">' +
      '<input type="checkbox" class="nv-rc-check" data-rc-id="' + esc(p.parcel_id) + '"' + (on ? " checked" : "") + ' aria-label="Select ' + esc(p.consignee || p.awb) + ', ' + esc(rs(p.cod)) + '">' +
      '<span class="nv-rc-box" aria-hidden="true"></span>' +
      '<span class="nv-rc-main"><b>' + esc(p.consignee || "Customer") + '</b>' +
        '<small>' + esc([p.city, day(p.came_back_at), p.awb].filter(Boolean).join(" · ")) + '</small>' +
        (p.reason ? '<small class="nv-rc-why">' + esc(p.reason) + '</small>' : '') +
        (p.no_phone ? '<small class="nv-rc-num">No phone number saved. You will be asked for it.</small>' : '') + chip(p.kind) + '</span>' +
      '<span class="nv-rc-cod">' + esc(rs(p.cod)) + '</span></label></li>';
  }
  function drawWith(oc){
    var cl = closedCases(), h = '';
    if (!oc.length && !cl.length) {
      return '<div class="panel nv-rc-empty"><h3>Nothing with NovaX yet</h3><p>Choose parcels under To recover and send them. We call within one working day.</p>' +
        '<button type="button" class="action-btn" data-rc-seg="todo">Choose parcels</button></div>';
    }
    var need = oc.filter(function(c){ return c.no_phone; }), ready = oc.filter(function(c){ return !c.no_phone; });
    if (need.length) h += '<h3 class="nv-rc-sub">Need a phone number</h3><p class="nv-rc-note">These are older orders, and NovaX has no number saved for them. Add the customer\'s number and we call within one working day.</p>' +
      '<ul class="nv-rc-list">' + need.map(caseRow).join("") + '</ul>' + (ready.length ? '<h3 class="nv-rc-sub">Ready to call</h3>' : '');
    if (ready.length) h += '<p class="nv-rc-note">We call within one working day. You can take a parcel back until we start calling.</p><ul class="nv-rc-list">' + ready.map(caseRow).join("") + '</ul>';
    if (cl.length) h += '<h3 class="nv-rc-sub">Not recovered</h3><ul class="nv-rc-list is-off">' + cl.map(caseRow).join("") + '</ul>';
    return h;
  }
  function caseRow(c){
    var t = CASE_TEXT[c.status] || [c.status, ""], label = t[0];
    if (c.status === "callback" && c.callback_at) label = "Call back on " + day(c.callback_at);
    var canTake = c.status === "waiting" && !(c.tries > 0) && S.st && S.st.may_push;
    var needNum = !!c.no_phone && (c.status === "waiting" || c.status === "calling" || c.status === "callback");
    if (needNum) label = "Cannot call: no phone number";
    return '<li class="nv-rc-row is-case' + (needNum ? " is-num" : "") + '"><span class="nv-rc-dot is-' + (needNum ? "num" : t[1]) + '" aria-hidden="true"></span>' +
      '<span class="nv-rc-main"><b>' + esc(c.consignee || "Customer") + '</b>' +
        '<small>' + esc([c.city, c.awb, "sent " + day(c.pushed_at)].filter(Boolean).join(" · ")) + '</small>' +
        '<small class="nv-rc-state is-' + (needNum ? "num" : t[1]) + '">' + esc(label) + (c.tries > 0 && (c.status === "waiting" || c.status === "callback") ? " · tried " + c.tries + (c.tries === 1 ? " time" : " times") : "") + '</small>' +
        (c.reason ? '<small class="nv-rc-why">' + esc(c.reason) + '</small>' : '') +
        (Number(c.max_discount) > 0 ? '<small class="nv-rc-why">Up to ' + esc(rs(c.max_discount)) + ' off allowed</small>' : '') + '</span>' +
      '<span class="nv-rc-side"><span class="nv-rc-cod">' + esc(rs(c.cod)) + '</span>' +
        (canTake ? '<button type="button" class="nv-rc-take" data-rc-take="' + esc(c.id) + '"' + (S.taking === c.id ? " disabled" : "") + '>' + (S.taking === c.id ? "Taking back…" : "Take back") + '</button>' : '') +
      '</span>' +
      /* The number field gets a line of its own under the row: beside the
         amount on a phone it had 140px and ran out of the row. */
      (needNum && S.st && S.st.may_push ? '<span class="nv-rc-addnum"><label class="nv-rc-sr" for="nvRcNum-' + esc(c.id) + '">Phone number of ' + esc(c.consignee || "the customer") + '</label>' +
          '<input id="nvRcNum-' + esc(c.id) + '" data-rc-casephone="' + esc(c.id) + '" inputmode="tel" autocomplete="off" maxlength="20" placeholder="03xx xxxxxxx" value="' + esc(S.casePhones[c.id] || "") + '">' +
          '<button type="button" class="nv-rc-savenum" data-rc-savenum="' + esc(c.id) + '"' + (S.saving === c.id ? " disabled" : "") + '>' + (S.saving === c.id ? "Saving…" : "Save number") + '</button></span>' : '') +
      '</li>';
  }
  function drawWon(won){
    if (!won.length) {
      return '<div class="panel nv-rc-empty"><h3>Nothing recovered yet</h3><p>When our agent recovers an order it shows here with its AWB, the delivery date the customer agreed' + (free() ? "" : ", and the " + esc(rs(fee())) + " fee") + '.</p></div>';
    }
    return '<ul class="nv-rc-list">' + won.map(function(c){
      return '<li class="nv-rc-row is-won"><span class="nv-rc-dot is-won" aria-hidden="true"></span><span class="nv-rc-main"><b>' + esc(c.consignee || "Customer") +
        '</b><small>' + esc([c.city, c.new_awb || c.awb, c.closed_at ? "recovered " + day(c.closed_at) : ""].filter(Boolean).join(" · ")) + '</small>' +
        '<small class="nv-rc-state is-won">Recovered by NovaX' + (c.agreed_date ? " · delivery " + esc(day(c.agreed_date)) : "") + '</small>' +
        '<small class="nv-rc-why">' + (c.mode === "rebook" || (!c.mode && c.new_awb)
            ? "Booked again as " + esc(c.new_awb) + " (was " + esc(c.awb) + "). Pack this order again and hand it over at your next pickup."
            : "Same parcel, going out again.") +
          (Number(c.agreed_cod) < Number(c.cod) ? " " + esc(rs(Number(c.cod) - Number(c.agreed_cod))) + " taken off." : "") + '</small>' +
        (c.mode === "rebook" || (!c.mode && c.new_awb) ? '<button type="button" class="nv-rc-take" data-rc="label">Print the label</button>' : '') + '</span>' +
        '<span class="nv-rc-side"><span class="nv-rc-cod">' + esc(rs(c.agreed_cod != null ? c.agreed_cod : c.cod)) + '</span><small>' +
          (c.rider_fault ? "No fee" : "Fee " + esc(rs(c.fee != null ? c.fee : fee()))) + '</small></span></li>';
    }).join("") + '</ul>';
  }

  /* The bar that follows the selection. It lives outside the list so a
     re-draw of the rows never restarts its slide. */
  function drawBar(){
    var bar = document.getElementById("nvRcBar");
    var pk = S.seg === "todo" && S.st && S.st.visible ? picked() : [];
    if (!pk.length) { hideBar(); return; }
    if (!bar) {
      bar = document.createElement("div"); bar.id = "nvRcBar"; bar.className = "nv-rc-bar";
      bar.innerHTML = '<div class="nv-rc-bar-in"><div class="nv-rc-bar-t"><b></b><span></span></div><button type="button" class="action-btn" data-rc="send"></button></div>';
      bar.addEventListener("click", function(e){ if (e.target.closest && e.target.closest('[data-rc="send"]')) openConfirm(); });
      document.body.appendChild(bar);
      void bar.offsetWidth;
    }
    var btn = bar.querySelector("button");
    bar.querySelector("b").textContent = pk.length + " selected · " + rs(sum(pk));
    bar.querySelector("span").textContent = free() ? "No fee" : rs(pk.length * fee()) + " if " + (pk.length === 1 ? "it is" : "all are") + " recovered";
    btn.textContent = "Send " + pk.length + " to NovaX";
    btn.disabled = !canSend() || S.busy; btn.tabIndex = 0;
    /* On a phone the portal's own navigation owns the bottom edge: sit on top of it. */
    var nav = document.getElementById("nvBottomNav"), navH = 0;
    try{ if (nav && getComputedStyle(nav).display !== "none") navH = nav.offsetHeight || 0; }catch(e){}
    bar.style.setProperty("--nv-rc-bar-b", navH + "px");
    bar.removeAttribute("aria-hidden"); bar.classList.add("is-in");
    document.body.classList.add("nv-rc-baron");
  }
  function hideBar(){
    var bar = document.getElementById("nvRcBar");
    if (bar) { bar.classList.remove("is-in"); bar.setAttribute("aria-hidden", "true"); var b = bar.querySelector("button"); if (b) b.tabIndex = -1; }
    try{ document.body.classList.remove("nv-rc-baron"); }catch(e){}
  }

  /* Rows rest visible. The entrance is added on top, only on a visible tab. */
  function enter(){
    if (!seen() || !HOST) return;
    Array.prototype.slice.call(HOST.querySelectorAll(".nv-rc-list > li"), 0, 12).forEach(function(li, i){
      li.style.animationDelay = (i * 32) + "ms"; li.classList.add("nv-rc-enter");
    });
  }

  /* ------------------------------------------------------------ sheets */
  function openLaunch(){
    var f = rs(fee());
    var inner = '<div class="nv-rc-sh">' +
      '<p class="nv-rc-eyebrow">New</p><h3 class="nvw-rc-title nv-rc-sh-t">Nova Recover</h3>' +
      '<p class="nv-rc-sh-l">Customers refused these orders. We call them and sell the order again.</p>' +
      '<ol class="nv-rc-steps">' +
        '<li><b>You choose</b><span>Pick the parcels you want us to work on.</span></li>' +
        '<li><b>We call</b><span>A NovaX agent phones the customer within one working day.</span></li>' +
        (free() ? '<li><b>No fee for now</b><span>A recovered order is delivered at your normal rate.</span></li>'
                : '<li><b>' + esc(f) + ' when it works</b><span>For each order we recover. Nothing if we cannot.</span></li>') +
      '</ol>' +
      (free() ? '<p class="nv-rc-fine">There is no Nova Recover fee right now. If one is added, you will see the price here and be asked to agree before you send more parcels.</p>'
              : '<p class="nv-rc-fine">The ' + esc(f) + ' comes from your NovaX Wallet. If the wallet is empty, it comes out of your next COD before you withdraw. A recovered order is delivered at your normal rate. The fee stays if the customer agrees on the call and refuses again at the door.</p>') +
      '<p class="nv-rc-sh-err" role="alert" hidden></p>' +
      /* Agreeing to the price is for a login that may send parcels. */
      (S.st && S.st.may_push === false
        ? '<p class="nv-rc-fine"><b>Only the account owner or a warehouse login can start Nova Recover.</b></p><div class="nvw-rc-acts"><button type="button" class="nvw-sec" data-nvw="close">Close</button></div></div>'
        : '<div class="nvw-rc-acts"><button type="button" class="nvw-primary" data-nvw="start">Start recovering</button>' +
          '<button type="button" class="nvw-sec" data-nvw="close">Not now</button></div></div>');
    B.sheet(inner, function(a, close, b){
      if (a !== "start" || b.disabled) return;
      var err = b.closest(".nv-rc-sh").querySelector(".nv-rc-sh-err");
      b.disabled = true; b.textContent = "Starting…"; err.hidden = true;
      rpc("client_recover_accept", { p_version:S.st.terms_version }).then(function(){
        S.st.accepted = true; close(); draw();
        try{ B.setState(S.st); }catch(e2){}
        if (picked().length) { setTimeout(openConfirm, 260); return; }
        var first = HOST && HOST.querySelector("[data-rc-pick]"); if (first) { try{ first.focus({ preventScroll:true }); }catch(e){} }
      }).catch(function(e){ b.disabled = false; b.textContent = "Start recovering"; err.textContent = friendly(e); err.hidden = false; });
    });
  }

  function openConfirm(){
    if (S.busy) return;
    if (!S.st.accepted) { openLaunch(); return; }
    var pk = picked(); if (!pk.length) return;
    if (!canSend()) { B.toast(S.st.wallet_low ? "Your wallet is too low to use Nova Recover right now." : "Only the account owner or a warehouse login can send parcels.", "error"); return; }
    if (!S.key) S.key = newKey();
    var total = sum(pk), minCod = Math.min.apply(null, pk.map(function(p){ return Number(p.cod) || 0; }));
    var nRet = pk.filter(function(p){ return p.kind === "returned"; }).length;
    var noNum = pk.filter(function(p){ return p.no_phone; });
    var inner = '<div class="nv-rc-sh">' +
      '<h3 class="nvw-rc-title nv-rc-sh-t">Send ' + pk.length + (pk.length === 1 ? " parcel" : " parcels") + ' to Nova Recover</h3>' +
      '<dl class="nv-rc-sum"><div><dt>COD on these orders</dt><dd>' + esc(rs(total)) + '</dd></div>' +
        (free() ? '<div><dt>Fee</dt><dd>None</dd></div>'
                : '<div><dt>Fee</dt><dd>' + esc(rs(fee())) + ' each, only when recovered</dd></div>' +
                  '<div><dt>Most you could pay</dt><dd>' + esc(rs(pk.length * fee())) + '</dd></div>') + '</dl>' +
      (noNum.length ? '<div class="nv-rc-f nv-rc-nums"><p class="nv-rc-numh"><b>' + (noNum.length === pk.length ? (noNum.length === 1 ? "This order has" : "These orders have") : noNum.length + " of these " + (noNum.length === 1 ? "has" : "have")) +
          ' no phone number saved.</b> ' + (noNum.length === 1 ? "It is an older order" : "They are older orders") + ', from before NovaX kept customer numbers. Type the number so our agent can call.</p>' +
          noNum.map(function(p){ return '<label><span>' + esc(p.consignee || "Customer") + ' · ' + esc(p.awb) + ' · ' + esc(rs(p.cod)) + '</span><input data-rc-phone="' + esc(p.parcel_id) + '" inputmode="tel" autocomplete="off" maxlength="20" placeholder="03xx xxxxxxx" value="' + esc(S.phones[p.parcel_id] || "") + '"></label>'; }).join("") +
          (noNum.length < pk.length ? '<button type="button" class="nv-rc-link" data-rc-leave="1">Leave ' + (noNum.length === 1 ? "this one" : "these " + noNum.length) + ' out and send the other ' + (pk.length - noNum.length) + '</button>' : '') + '</div>' : '') +
      '<div class="nv-rc-f"><label for="nvRcOff">How much may our agent take off, if the customer asks?</label>' +
        '<div class="nv-rc-off"><span>Rs</span><input id="nvRcOff" inputmode="numeric" autocomplete="off" maxlength="6" value="0" aria-describedby="nvRcOffH"></div>' +
        '<div class="nv-rc-offq" role="group" aria-label="Quick amounts">' + [0, 100, 200, 500].map(function(v){
          return '<button type="button" class="nv-rc-q' + (v === 0 ? " is-on" : "") + '" data-rc-off="' + v + '">' + (v ? "Rs " + v : "No discount") + '</button>'; }).join("") + '</div>' +
        '<p class="nv-rc-fine" id="nvRcOffH">Our agent offers it only when the customer will not take the order otherwise. It applies to each order.</p></div>' +
      '<details class="nv-rc-items"><summary>Tell us what each order was <small>(optional, helps us sell it)</small></summary>' +
        pk.map(function(p){ return '<label><span>' + esc(p.consignee || p.awb) + ' · ' + esc(rs(p.cod)) + '</span><input data-rc-item="' + esc(p.parcel_id) + '" maxlength="140" placeholder="e.g. Oud perfume 50ml" autocomplete="off"></label>'; }).join("") +
      '</details>' +
      '<div class="nv-rc-f"><label for="nvRcNote">Note for our agent <small>(optional)</small></label><input id="nvRcNote" maxlength="300" placeholder="e.g. Free delivery on the next order" autocomplete="off"></div>' +
      (nRet ? '<label class="nv-rc-tick"><input type="checkbox" id="nvRcStock"><span class="nv-rc-box" aria-hidden="true"></span><span>' +
                (nRet === pk.length ? (nRet === 1 ? "I still have this item" : "I still have these items")
                                    : "I still have the " + nRet + " returned " + (nRet === 1 ? "item" : "items")) + '</span></label>' +
              (nRet < pk.length ? '<p class="nv-rc-fine">' + (pk.length - nRet) + (pk.length - nRet === 1 ? " parcel is" : " parcels are") + ' still with NovaX, so there is nothing to confirm for ' + (pk.length - nRet === 1 ? "it" : "them") + '.</p>' : '')
            : '<p class="nv-rc-fine">' + (pk.length === 1 ? "This parcel is" : "These parcels are") + ' still with NovaX. If the customer agrees, ' + (pk.length === 1 ? "it goes" : "they go") + ' out again.</p>') +
      '<p class="nv-rc-sh-err" role="alert" hidden></p>' +
      '<div class="nvw-rc-acts"><button type="button" class="nvw-primary" data-nvw="send"' + (nRet ? " disabled" : "") + '>Send to Nova Recover</button>' +
      '<button type="button" class="nvw-sec" data-nvw="close">Back</button></div></div>';
    var sh = B.sheet(inner, function(a, close, b){
      if (a !== "send" || b.disabled || S.busy) return;
      var box = b.closest(".nv-rc-sh"), err = box.querySelector(".nv-rc-sh-err");
      var off = offValue(box);
      if (off == null) { err.textContent = "The discount must be a whole number of rupees."; err.hidden = false; return; }
      var items = {}; Array.prototype.forEach.call(box.querySelectorAll("[data-rc-item]"), function(i){ var v = i.value.trim(); if (v) items[i.getAttribute("data-rc-item")] = v; });
      var phones = {}, firstBad = null;
      Array.prototype.forEach.call(box.querySelectorAll("[data-rc-phone]"), function(i){ if (okPhone(i.value)) phones[i.getAttribute("data-rc-phone")] = i.value.trim(); else if (!firstBad) firstBad = i; });
      if (firstBad) { err.textContent = "Type the customer's phone number, like 0300 1234567."; err.hidden = false; try{ firstBad.focus(); }catch(e0){} return; }
      S.busy = true; b.disabled = true; b.textContent = "Sending…"; err.hidden = true;
      rpc("client_recover_push", { p_parcels:pk.map(function(p){ return p.parcel_id; }), p_max_discount:off, p_in_stock:!!(tick && tick.checked),
                                   p_items:items, p_note:box.querySelector("#nvRcNote").value.trim(), p_key:S.key, p_phones:phones })
        .then(function(r){
          S.busy = false; S.key = null; S.sel = {}; S.phones = {};
          var n = (r && r.pushed) || pk.length;
          box.innerHTML = '<div class="nv-rc-done"><span class="nv-rc-done-tick" aria-hidden="true"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>' +
            '<h3 class="nvw-rc-title nv-rc-sh-t">Sent</h3><p class="nv-rc-sh-l">' + n + (n === 1 ? " parcel is" : " parcels are") + ' with NovaX. We will call within one working day.</p>' +
            '<div class="nvw-rc-acts"><button type="button" class="nvw-primary" data-nvw="close">See them</button></div></div>';
          S.seg = "with"; S.entered = false; S.loaded = true; hideBar(); load();
          var ok = box.querySelector("button"); if (ok) { try{ ok.focus({ preventScroll:true }); }catch(e){} }
        }).catch(function(e){
          S.busy = false; b.disabled = false; b.textContent = "Send to Nova Recover";
          err.textContent = friendly(e); err.hidden = false; drawBar();
        });
    });
    var box = sh.sheet, inp = box.querySelector("#nvRcOff"), go = box.querySelector('[data-nvw="send"]'), tick = box.querySelector("#nvRcStock");
    function offValue(root){ var v = String(root.querySelector("#nvRcOff").value || "").replace(/[,\s]/g, ""); if (v === "") return 0; if (!/^\d{1,6}$/.test(v)) return null; return Number(v); }
    function sync(){
      var v = offValue(box);
      Array.prototype.forEach.call(box.querySelectorAll("[data-rc-off]"), function(q){ q.classList.toggle("is-on", v != null && Number(q.getAttribute("data-rc-off")) === v); });
      var help = box.querySelector("#nvRcOffH");
      help.textContent = v != null && v > 0 && v >= minCod
        ? "That is the whole price of your smallest order (" + rs(minCod) + "). On each order the discount stops at its COD."
        : "Our agent offers it only when the customer will not take the order otherwise. It applies to each order.";
      var numsOk = Array.prototype.every.call(box.querySelectorAll("[data-rc-phone]"), function(i){ return okPhone(i.value); });
      go.disabled = (tick ? !tick.checked : false) || v == null || !numsOk;
      Array.prototype.forEach.call(box.querySelectorAll("[data-rc-off]"), function(q){ q.setAttribute("aria-pressed", q.classList.contains("is-on") ? "true" : "false"); });
    }
    inp.addEventListener("input", function(){ inp.value = inp.value.replace(/[^\d]/g, "").slice(0, 6); sync(); });
    if (tick) tick.addEventListener("change", sync);
    /* A typed number is kept if the sheet is closed and opened again. */
    box.addEventListener("input", function(e){
      var i = e.target; if (!i.matches || !i.matches("[data-rc-phone]")) return;
      i.value = i.value.replace(/[^0-9+ -]/g, "").slice(0, 20); S.phones[i.getAttribute("data-rc-phone")] = i.value; S.key = null; sync();
    });
    sync();
    box.addEventListener("click", function(e){
      var lv = e.target.closest && e.target.closest("[data-rc-leave]");
      if (lv) { noNum.forEach(function(p){ delete S.sel[p.parcel_id]; }); S.key = null; syncRows(); sh.close(); setTimeout(openConfirm, 260); return; }
      var q = e.target.closest && e.target.closest("[data-rc-off]"); if (!q) return;
      inp.value = q.getAttribute("data-rc-off"); sync();
    });
  }

  function takeBack(id){
    if (S.taking) return;
    S.taking = id; draw();
    rpc("client_recover_withdraw", { p_case:id }).then(function(r){
      S.taking = ""; B.toast(((r && r.awb) || "Parcel") + " taken back.", "success"); load();
    }).catch(function(e){ S.taking = ""; B.toast(friendly(e), "error"); load(); });
  }

  function saveNumber(id){
    if (S.saving) return;
    var inp = HOST && HOST.querySelector('[data-rc-casephone="' + id + '"]'), v = inp ? inp.value.trim() : "";
    if (!okPhone(v)) { B.toast("Type the customer's phone number, like 0300 1234567.", "error"); if (inp) { try{ inp.focus(); }catch(e){} } return; }
    S.saving = id; draw();
    rpc("client_recover_add_phone", { p_case:id, p_phone:v }).then(function(){
      S.saving = ""; delete S.casePhones[id]; B.toast("Number saved. We will call within one working day.", "success"); load();
    }).catch(function(e){ S.saving = ""; B.toast(friendly(e), "error"); load(); });
  }

  /* ------------------------------------------------------------ events */
  function onClick(e){
    var t = e.target; if (!t.closest) return;
    var sg = t.closest("[data-rc-seg]");
    if (sg) { S.seg = sg.getAttribute("data-rc-seg"); S.entered = false; draw(); var on = HOST.querySelector(".nv-rc-seg.is-on"); if (on) { try{ on.focus({ preventScroll:true }); }catch(e2){} } return; }
    var q = t.closest("[data-rc-pick]");
    if (q) {
      var how = q.getAttribute("data-rc-pick"), todo = pushable(), cap = maxPush(), next = {};
      if (how === "all") todo.slice(0, cap).forEach(function(p){ next[p.parcel_id] = 1; });
      else if (how === "week") todo.filter(function(p){ return daysAgo(p.came_back_at) <= 30; }).slice(0, cap).forEach(function(p){ next[p.parcel_id] = 1; });
      else if (how === "big") todo.filter(function(p){ return Number(p.cod) >= 2000; }).slice(0, cap).forEach(function(p){ next[p.parcel_id] = 1; });
      S.sel = next; S.key = null; syncRows(); return;
    }
    var tk = t.closest("[data-rc-take]"); if (tk) { takeBack(tk.getAttribute("data-rc-take")); return; }
    var sn = t.closest("[data-rc-savenum]"); if (sn) { saveNumber(sn.getAttribute("data-rc-savenum")); return; }
    var a = t.closest("[data-rc]"); if (!a) return;
    var k = a.getAttribute("data-rc");
    if (k === "how") openLaunch();
    else if (k === "reload") { S.loaded = false; load(); }
    else if (k === "label") B.showTab("awbLabel");
  }
  function onChange(e){
    var c = e.target; if (!c.matches || !c.matches(".nv-rc-check")) return;
    var id = c.getAttribute("data-rc-id");
    if (c.checked) {
      if (picked().length >= maxPush()) { c.checked = false; B.toast("Send at most " + maxPush() + " parcels at a time.", "error"); return; }
      S.sel[id] = 1;
    } else delete S.sel[id];
    S.key = null; syncRows();
  }
  /* A number being typed for a case survives the list being drawn again. */
  function onInput(e){
    var i = e.target; if (!i.matches || !i.matches("[data-rc-casephone]")) return;
    i.value = i.value.replace(/[^0-9+ -]/g, "").slice(0, 20); S.casePhones[i.getAttribute("data-rc-casephone")] = i.value;
  }
  /* Selection changes touch only what changed, so the list does not jump
     and a row's tick can animate. */
  function syncRows(){
    if (!HOST) return;
    Array.prototype.forEach.call(HOST.querySelectorAll(".nv-rc-check"), function(c){
      var on = !!S.sel[c.getAttribute("data-rc-id")];
      c.checked = on; var r = c.closest(".nv-rc-row"); if (r) r.classList.toggle("is-on", on);
    });
    var clr = HOST.querySelector('[data-rc-pick="none"]'); if (clr) clr.hidden = !picked().length;
    drawBar();
  }

  /* -------------------------------------------------------------- style */
  var CSS = [
    '.nv-rc-wrap{display:grid;gap:14px;max-width:860px;color:var(--nvu-ink);padding-bottom:150px}',
    '.nv-rc-eyebrow{margin:0 0 4px;font-size:11.5px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--nvu-accent)}',
    '.nv-rc-head{display:flex;gap:18px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid var(--nvu-line)}',
    '.nv-rc-head h2{margin:0;font-size:clamp(22px,4.6vw,28px);line-height:1.15;letter-spacing:-.01em}',
    '.nv-rc-lede{margin:8px 0 0;max-width:46ch;font-size:14.5px;line-height:1.5;color:var(--nvu-ink-2)}.nv-rc-lede b{color:var(--nvu-ink)}',
    '.nv-rc-price{display:grid;gap:2px;justify-items:start;padding-left:14px;border-left:3px solid var(--nvu-accent)}',
    '.nv-rc-price b{font-size:26px;line-height:1;font-variant-numeric:tabular-nums}.nv-rc-price span{font-size:12.5px;line-height:1.4;color:var(--nvu-ink-2)}',
    '.nv-rc-link{appearance:none;border:0;background:none;padding:6px 0 0;font:inherit;font-size:13px;font-weight:750;color:var(--nvu-accent);cursor:pointer;text-decoration:underline;text-underline-offset:3px}',
    '.nv-rc-banner{margin:0;padding:10px 12px;border-radius:10px;border:1px solid var(--nvu-warn-ln);background:var(--nvu-warn-bg);color:var(--nvu-warn-fg);font-size:13.5px;font-weight:700;line-height:1.4}',
    '.nv-rc-banner.is-demo{border-color:var(--nvu-info-ln);background:var(--nvu-info-bg);color:var(--nvu-info-fg)}',
    '.nv-rc-segs{display:flex;gap:4px;border-bottom:1px solid var(--nvu-line);overflow-x:auto;scrollbar-width:none}.nv-rc-segs::-webkit-scrollbar{display:none}',
    '.nv-rc-seg{appearance:none;border:0;background:none;font:inherit;font-size:14px;font-weight:750;color:var(--nvu-ink-2);min-height:44px;padding:0 12px;margin-bottom:-1px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s}',
    '.nv-rc-seg span{display:inline-block;min-width:20px;margin-left:4px;padding:1px 6px;border-radius:6px;background:var(--nvu-bg-2);font-size:12px;font-variant-numeric:tabular-nums;text-align:center}',
    '.nv-rc-seg.is-on{color:var(--nvu-ink);border-bottom-color:var(--nvu-accent)}.nv-rc-seg.is-on span{background:var(--nvu-accent);color:var(--nvu-accent-ink,#fff)}',
    '.nv-rc-quick{display:flex;gap:8px;flex-wrap:wrap}',
    '.nv-rc-q{appearance:none;min-height:40px;padding:0 12px;border-radius:10px;border:1px solid var(--nvu-line-2);background:var(--nvu-bg);color:var(--nvu-ink);font:inherit;font-size:13.5px;font-weight:750;cursor:pointer;transition:border-color .15s,background .15s,transform .1s}',
    '.nv-rc-q span{margin-left:4px;color:var(--nvu-ink-2);font-variant-numeric:tabular-nums}',
    '.nv-rc-q:hover:not([disabled]){border-color:var(--nvu-accent)}.nv-rc-q:active:not([disabled]){transform:scale(.97)}',
    '.nv-rc-q[disabled]{opacity:.45;cursor:not-allowed}.nv-rc-q.is-clear{border-style:dashed;color:var(--nvu-ink-2)}',
    '.nv-rc-q.is-on{border-color:var(--nvu-accent);background:var(--nvu-accent);color:var(--nvu-accent-ink,#fff)}',
    '.nv-rc-list{list-style:none;margin:0;padding:0;border:1px solid var(--nvu-line);border-radius:14px;overflow:hidden;background:var(--nvu-bg)}',
    '.nv-rc-list>li+li{border-top:1px solid var(--nvu-line)}',
    '.nv-rc-row{position:relative;display:flex;align-items:flex-start;gap:12px;padding:12px 14px;min-height:60px;cursor:pointer;transition:background .15s}',
    '.nv-rc-row.is-case,.nv-rc-row.is-won,.nv-rc-row.is-blocked{cursor:default}',
    'label.nv-rc-row:hover{background:var(--nvu-bg-2)}.nv-rc-row.is-on{background:var(--nvu-good-bg)}',
    '.nv-rc-check{position:absolute;opacity:0;width:44px;height:44px;left:4px;top:8px;margin:0;cursor:pointer}',
    '.nv-rc-box{flex:none;width:22px;height:22px;margin-top:2px;border-radius:6px;border:2px solid var(--nvu-line-2);background:var(--nvu-bg);display:grid;place-items:center;transition:background .15s,border-color .15s}',
    '.nv-rc-box::after{content:"";width:10px;height:6px;border-left:2.5px solid var(--nvu-accent-ink,#fff);border-bottom:2.5px solid var(--nvu-accent-ink,#fff);transform:rotate(-45deg) scale(0);margin-top:-2px;transition:transform .16s cubic-bezier(.3,1.6,.5,1)}',
    '.nv-rc-check:checked+.nv-rc-box,.nv-rc-tick input:checked+.nv-rc-box{background:var(--nvu-accent);border-color:var(--nvu-accent)}',
    '.nv-rc-check:checked+.nv-rc-box::after,.nv-rc-tick input:checked+.nv-rc-box::after{transform:rotate(-45deg) scale(1)}',
    '.nv-rc-check:focus-visible+.nv-rc-box,.nv-rc-tick input:focus-visible+.nv-rc-box{outline:2px solid var(--nvu-accent);outline-offset:2px}',
    '.nv-rc-row.is-blocked .nv-rc-box{border-style:dashed;opacity:.5}.nv-rc-list.is-off{opacity:.78}',
    '.nv-rc-main{flex:1;min-width:0;display:grid;gap:2px;justify-items:start}.nv-rc-main b{font-size:15px;overflow-wrap:anywhere}',
    '.nv-rc-main small{font-size:12.5px;color:var(--nvu-ink-2);overflow-wrap:anywhere}.nv-rc-why{font-style:italic}',
    '.nv-rc-chip{margin-top:4px;padding:2px 8px;border-radius:6px;font-size:11.5px;font-weight:750;border:1px solid var(--nvu-neutral-ln);background:var(--nvu-neutral-bg);color:var(--nvu-neutral-fg)}',
    '.nv-rc-chip.is-here{border-color:var(--nvu-warn-ln);background:var(--nvu-warn-bg);color:var(--nvu-warn-fg)}',
    '.nv-rc-cod{flex:none;font-size:15px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.nv-rc-side{flex:none;display:grid;gap:6px;justify-items:end}.nv-rc-side small{font-size:12px;color:var(--nvu-ink-2)}',
    '.nv-rc-take{appearance:none;min-height:36px;padding:0 12px;border-radius:9px;border:1px solid var(--nvu-line-2);background:var(--nvu-bg);color:var(--nvu-ink);font:inherit;font-size:13px;font-weight:750;cursor:pointer}',
    '.nv-rc-take:hover:not([disabled]){border-color:var(--nvu-bad-ln);color:var(--nvu-bad-fg)}.nv-rc-take[disabled]{opacity:.55}',
    '.nv-rc-dot{flex:none;width:10px;height:10px;margin-top:6px;border-radius:50%;background:var(--nvu-ink-3)}',
    '.nv-rc-dot.is-wait{background:var(--nvu-warn-fg)}.nv-rc-dot.is-live{background:var(--nvu-info-fg)}.nv-rc-dot.is-won{background:var(--nvu-good-fg)}.nv-rc-dot.is-lost{background:var(--nvu-ink-3)}',
    '.nv-rc-state{font-weight:750!important;font-style:normal}.nv-rc-state.is-wait{color:var(--nvu-warn-fg)!important}.nv-rc-state.is-live{color:var(--nvu-info-fg)!important}.nv-rc-state.is-won{color:var(--nvu-good-fg)!important}',
    '.nv-rc-row.is-won{background:var(--nvu-good-bg)}',
    /* an order with no phone number saved */
    '.nv-rc-banner.is-num{border-color:var(--nvu-bad-ln);background:var(--nvu-bad-bg);color:var(--nvu-bad-fg);font-weight:600}.nv-rc-banner.is-num .nv-rc-link{padding:0;color:inherit}',
    '.nv-rc-num{font-style:normal;font-weight:700;color:var(--nvu-bad-fg)!important}',
    '.nv-rc-dot.is-num{background:var(--nvu-bad-fg)}.nv-rc-state.is-num{color:var(--nvu-bad-fg)!important}',
    '.nv-rc-row.is-num{flex-wrap:wrap}.nv-rc-addnum{display:flex;gap:8px;flex-wrap:wrap;flex:1 1 100%;min-width:0;padding-left:22px;box-sizing:border-box}',
    '.nv-rc-addnum input{flex:1 1 150px;min-width:0;box-sizing:border-box;min-height:44px;padding:8px 12px;border-radius:10px;border:1px solid var(--nvu-line-2);background:var(--nvu-bg-2);color:var(--nvu-ink);font:inherit;font-size:16px}',
    '.nv-rc-addnum input:focus-visible,.nv-rc-nums input:focus-visible{outline:2px solid var(--nvu-accent);outline-offset:1px}',
    '.nv-rc-savenum{appearance:none;flex:none;min-height:44px;padding:0 14px;border-radius:10px;border:1px solid var(--nvu-accent);background:var(--nvu-accent);color:var(--nvu-accent-ink,#fff);font:inherit;font-size:13.5px;font-weight:750;cursor:pointer;white-space:nowrap}',
    '.nv-rc-savenum[disabled]{opacity:.55;cursor:default}',
    '.nv-rc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '.nv-rc-nums{padding:12px;border:1px solid var(--nvu-bad-ln);border-radius:12px;background:var(--nvu-bad-bg)}',
    '.nv-rc-numh{margin:0;font-size:13.5px;line-height:1.5;color:var(--nvu-bad-fg)}',
    '.nv-rc-nums label{display:grid;gap:5px}.nv-rc-nums label span{font-size:12.5px;font-weight:650;color:var(--nvu-bad-fg);overflow-wrap:anywhere}',
    '.nv-rc-nums .nv-rc-link{justify-self:start;text-align:left;color:var(--nvu-bad-fg)}',
    '.nv-rc-sub{margin:8px 0 0;font-size:13px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--nvu-ink-2)}',
    '.nv-rc-note{margin:0;font-size:13.5px;color:var(--nvu-ink-2)}',
    '.nv-rc-empty{padding:26px 20px}.nv-rc-empty h3{margin:0 0 6px;font-size:18px}.nv-rc-empty p{margin:0 0 14px;color:var(--nvu-ink-2);line-height:1.5;max-width:52ch}.nv-rc-empty p:last-child{margin-bottom:0}',
    '.nv-rc-sk{display:grid;gap:12px;padding:8px 0}.nv-rc-sk i{display:block;height:16px;border-radius:6px;background:var(--nvu-bg-2)}',
    /* the bar */
    '.nv-rc-bar{position:fixed;left:0;right:0;bottom:var(--nv-rc-bar-b,0px);z-index:60;padding:0 12px calc(10px + env(safe-area-inset-bottom,0px));pointer-events:none;transform:translateY(120%);opacity:0;transition:transform .28s cubic-bezier(.2,.9,.3,1),opacity .2s}',
    '.nv-rc-bar.is-in{transform:none;opacity:1}',
    '.nv-rc-bar-in{pointer-events:auto;max-width:720px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:10px 10px 10px 16px;border-radius:14px;background:var(--nvu-ink);color:var(--nvu-bg);box-shadow:0 14px 36px rgba(0,0,0,.34)}',
    '.nv-rc-bar-t{flex:1;min-width:0;display:grid;gap:1px}.nv-rc-bar-t b{font-size:14.5px;font-variant-numeric:tabular-nums}.nv-rc-bar-t span{font-size:12px;opacity:.78}',
    '.nv-rc-bar .action-btn{flex:none;width:auto;min-height:44px;margin:0;white-space:nowrap}',
    /* While a selection is open the bar owns this corner; the assistant button comes back when it closes. */
    'body.nv-rc-baron #nvautoLauncher{opacity:0;pointer-events:none;transition:opacity .15s}',
    /* sheets */
    '.nv-rc-sh{display:grid;gap:12px;text-align:left}.nv-rc-sh .nv-rc-sh-t{margin:0;font-size:24px;font-weight:800;line-height:1.2;letter-spacing:-.01em;text-align:left;color:var(--nvu-ink)}',
    '.nv-rc-sh-l{margin:0;font-size:15px;line-height:1.5;color:var(--nvu-ink-2)}',
    '.nv-rc-steps{list-style:none;margin:2px 0 0;padding:0;counter-reset:rc;display:grid}',
    '.nv-rc-steps li{counter-increment:rc;position:relative;display:grid;gap:1px;padding:10px 0 10px 40px;border-top:1px solid var(--nvu-line)}',
    '.nv-rc-steps li::before{content:counter(rc);position:absolute;left:0;top:10px;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:var(--nvu-bg-2);border:1px solid var(--nvu-line-2);font-size:13px;font-weight:800;font-variant-numeric:tabular-nums}',
    '.nv-rc-steps b{font-size:15px}.nv-rc-steps span{font-size:13.5px;color:var(--nvu-ink-2);line-height:1.45}',
    '.nv-rc-fine{margin:0;font-size:12.5px;line-height:1.5;color:var(--nvu-ink-2)}',
    '.nv-rc-sh-err{margin:0;padding:9px 11px;border-radius:9px;background:var(--nvu-bad-bg);border:1px solid var(--nvu-bad-ln);color:var(--nvu-bad-fg);font-size:13.5px;font-weight:700}',
    '.nv-rc-sum{margin:0;display:grid;border:1px solid var(--nvu-line);border-radius:12px;overflow:hidden}.nv-rc-sum>div{display:flex;justify-content:space-between;gap:12px;padding:9px 12px;font-size:13.5px}',
    '.nv-rc-sum>div+div{border-top:1px solid var(--nvu-line)}.nv-rc-sum dt{color:var(--nvu-ink-2)}.nv-rc-sum dd{margin:0;font-weight:800;text-align:right;font-variant-numeric:tabular-nums}',
    '.nv-rc-f{display:grid;gap:7px}.nv-rc-f label,.nv-rc-items summary{font-size:13.5px;font-weight:750}.nv-rc-f label small,.nv-rc-items summary small{font-weight:600;color:var(--nvu-ink-2)}',
    '.nv-rc-f input,.nv-rc-items input{width:100%;box-sizing:border-box;min-height:46px;padding:10px 12px;border-radius:11px;border:1px solid var(--nvu-line-2);background:var(--nvu-bg-2);color:var(--nvu-ink);font:inherit;font-size:16px}',
    '.nv-rc-off{display:flex;align-items:center;border:1px solid var(--nvu-line-2);border-radius:11px;background:var(--nvu-bg-2);overflow:hidden}.nv-rc-off:focus-within{border-color:var(--nvu-accent)}',
    '.nv-rc-off span{padding:0 4px 0 14px;font-weight:800;color:var(--nvu-ink-2)}.nv-rc-off input{border:0;background:none;font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;outline:0;padding-left:6px}',
    '.nv-rc-offq{display:flex;gap:6px;flex-wrap:wrap}.nv-rc-offq .nv-rc-q{min-height:36px;font-size:13px}',
    '.nv-rc-items{border:1px solid var(--nvu-line);border-radius:12px;padding:0 12px}.nv-rc-items summary{position:relative;min-height:44px;display:flex;align-items:center;gap:2px 6px;padding:6px 26px 6px 0;cursor:pointer;flex-wrap:wrap;list-style:none}',
    '.nv-rc-items summary::-webkit-details-marker{display:none}.nv-rc-items summary::after{content:"+";position:absolute;right:2px;top:50%;transform:translateY(-50%);font-size:20px;font-weight:700;color:var(--nvu-ink-2)}.nv-rc-items[open] summary::after{content:"\\2212"}',
    '.nv-rc-items label{display:grid;gap:5px;padding:8px 0}.nv-rc-items label span{font-size:12.5px;color:var(--nvu-ink-2)}.nv-rc-items[open]{padding-bottom:8px}',
    '.nv-rc-tick{position:relative;display:flex;align-items:center;gap:10px;min-height:48px;padding:0 12px;border:1px solid var(--nvu-line-2);border-radius:12px;font-size:14.5px;font-weight:750;cursor:pointer}',
    '.nv-rc-tick input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}.nv-rc-tick .nv-rc-box{margin-top:0}',
    '.nv-rc-sh .nvw-primary[disabled]{opacity:.5;cursor:not-allowed}',
    '.nv-rc-done{display:grid;gap:10px;justify-items:start}.nv-rc-done-tick{width:52px;height:52px;border-radius:14px;display:grid;place-items:center;background:var(--nvu-good-bg);border:1px solid var(--nvu-good-ln);color:var(--nvu-good-fg)}',
    '.nv-rc-done .nvw-rc-acts{width:100%}',
    /* motion: only ever added on top of content that is already visible */
    '@keyframes nvRcIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '@keyframes nvRcPop{0%{transform:scale(.6);opacity:0}70%{transform:scale(1.08);opacity:1}100%{transform:none}}',
    '.nv-rc-enter{animation:nvRcIn .26s ease-out both}.nv-rc-done-tick{animation:nvRcPop .34s cubic-bezier(.3,1.5,.5,1) both}',
    '@media (max-width:640px){.nv-rc-head{align-items:flex-start}.nv-rc-price{padding-left:12px}.nv-rc-row{padding:12px}.nv-rc-bar{padding:0 8px 8px}'+
      '.nv-rc-bar-in{flex-wrap:wrap;gap:8px;padding:10px 12px 12px}.nv-rc-bar-t{flex:1 1 100%;display:flex;align-items:baseline;justify-content:space-between;gap:10px}'+
      '.nv-rc-bar .action-btn{flex:1 1 100%;width:100%}}',
    '@media (max-width:430px){.nv-rc-seg{flex:1;padding:0 4px;font-size:13px;text-align:center}.nv-rc-seg span{margin-left:2px;padding:1px 5px}}',
    '@media (prefers-reduced-motion:reduce){.nv-rc-enter,.nv-rc-done-tick{animation:none}.nv-rc-bar,.nv-rc-box,.nv-rc-box::after,.nv-rc-q{transition:none}}'
  ].join("");
  function style(){
    if (document.getElementById("nvRcCss")) return;
    var s = document.createElement("style"); s.id = "nvRcCss"; s.textContent = CSS; document.head.appendChild(s);
  }

  /* --------------------------------------------------------------- api */
  window.NovaXRecover = {
    open: function(host){
      B = window.__nvRcBridge; if (!B || !host) return;
      style();
      if (HOST !== host) {
        HOST = host;
        host.addEventListener("click", onClick);
        host.addEventListener("change", onChange);
        host.addEventListener("input", onInput);
      }
      S.entered = false;
      var pk = B.takePick ? B.takePick() : null; if (pk && pk.length) S.pick = pk;
      var want = B.takeSeg ? B.takeSeg() : "";
      if (want === "todo" || want === "with" || want === "won") S.seg = want;
      if (S.loaded) { draw(); load(); } else load();
    },
    /* The portal calls this when another tab opens, so the bar never floats
       over a different screen. */
    leave: function(){ hideBar(); },
    summary: function(from, to){ B = B || window.__nvRcBridge; return rpc("client_recover_summary", { p_from:from || null, p_to:to || null }); },
    _state: S
  };
})();
