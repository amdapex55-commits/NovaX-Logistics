/* =====================================================================
   NovaX Reports (v2) -- loaded only when the Reports tab opens.

   Answers three questions, top to bottom: how am I doing, where is my
   money, what should I fix. Everything on the page follows ONE period
   (parcels BOOKED in it, Pakistan time), so no figure needs a footnote
   saying it ignores the filters. Wallet and payouts are account-level and
   live on the Money tab.

   It reads the portal through window.__nvRepBridge (client-app.js), so
   "delivered", "settled" and "rated" mean exactly what they mean on every
   other screen, and the numbers can be checked against the classic report
   to the rupee. Read-only: nothing here writes anywhere.
   ===================================================================== */
(function(){
  "use strict";
  if (window.NovaXReports) return;

  var B = null, HOST = null;
  var RM = false; try{ RM = matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){}
  var S = { period:"30d", from:"", to:"", compare:true, city:"", group:"all", q:"", sort:"new", shown:50,
            rows:null, prev:null, key:"", at:0, loading:false, partial:false, err:"", counted:false, exportOpen:false };
  try{
    var saved = JSON.parse(localStorage.getItem("nvRep2") || "{}");
    if (saved.period) S.period = saved.period;
    if (saved.from) { S.from = saved.from; S.to = saved.to || ""; }
    if (typeof saved.compare === "boolean") S.compare = saved.compare;
  }catch(e){}
  function remember(){ try{ localStorage.setItem("nvRep2", JSON.stringify({ period:S.period, from:S.from, to:S.to, compare:S.compare })); }catch(e){} }

  /* ---------------------------------------------------------------- time */
  var TZ = "Asia/Karachi", DAY = 86400000;
  function pktDay(t){ if(!t) return ""; var d = new Date(t); return isFinite(d) ? d.toLocaleDateString("en-CA", { timeZone:TZ }) : ""; }
  function today(){ return pktDay(Date.now()); }
  function addDays(ymd, n){ var d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0,10); }
  function daysBetween(a, b){ return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY); }
  function startIso(ymd){ return new Date(ymd + "T00:00:00+05:00").toISOString(); }
  var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function dLabel(ymd, withYear){
    if(!ymd) return "";
    var p = ymd.split("-"); var s = Number(p[2]) + " " + MON[Number(p[1]) - 1];
    return withYear ? s + " " + p[0] : s;
  }
  function rangeLabel(a, b){
    if(!a) return "All time";
    var sameYear = a.slice(0,4) === b.slice(0,4) && a.slice(0,4) === today().slice(0,4);
    return a === b ? dLabel(a, !sameYear) : dLabel(a, !sameYear) + " – " + dLabel(b, !sameYear);
  }
  function durLabel(h){
    if(h == null || !isFinite(h)) return "—";
    if(h < 1) return Math.max(1, Math.round(h * 60)) + "m";
    if(h < 24) return (Math.round(h * 10) / 10).toString().replace(/\.0$/, "") + "h";
    var d = Math.floor(h / 24), r = Math.round(h % 24);
    return r ? d + "d " + r + "h" : d + "d";
  }

  var PERIODS = [
    ["today","Today"], ["7d","7 days"], ["30d","30 days"], ["month","This month"],
    ["lastmonth","Last month"], ["90d","90 days"], ["all","All time"], ["custom","Custom"]
  ];
  function range(){
    var t = today(), a, b = t, pa = null, pb = null;
    switch(S.period){
      case "today": a = t; break;
      case "7d": a = addDays(t, -6); break;
      case "90d": a = addDays(t, -89); break;
      case "month": a = t.slice(0,8) + "01"; break;
      case "lastmonth":
        b = addDays(t.slice(0,8) + "01", -1); a = b.slice(0,8) + "01"; break;
      case "all": return { a:null, b:t, pa:null, pb:null };
      case "custom":
        a = S.from || addDays(t, -29); b = S.to || t;
        if (b < a) { var x = a; a = b; b = x; }
        break;
      default: a = addDays(t, -29);
    }
    var len = daysBetween(a, b) + 1;
    if (S.period === "month") {                 /* month so far vs the same days last month */
      pa = addDays(a, -1).slice(0,8) + "01"; pb = addDays(pa, len - 1);
      var lastOfPrev = addDays(a, -1); if (pb > lastOfPrev) pb = lastOfPrev;
    } else if (S.period === "lastmonth") {
      pb = addDays(a, -1); pa = pb.slice(0,8) + "01";
    } else { pb = addDays(a, -1); pa = addDays(a, -len); }
    return { a:a, b:b, pa:pa, pb:pb };
  }

  /* ---------------------------------------------------------- groups */
  var MOVING = ["Collected by rider","Arrived at warehouse","Parcel now in transit","Parcel received at destination","Parcel out for delivery","Reattempt","Reassigned"];
  var PROBLEM = ["Refused","Consignee not available","Out of service area"];
  var RETURNED = ["Ready for return","Return in transit","Return received at origin","Return out for delivery","Return to shipper","Parcel returned to consignee"];
  var CANCELLED = ["Cancelled","Cancelled by client"];
  var GROUPS = [
    ["all","All"], ["booked","Booked"], ["moving","Moving"], ["delivered","Delivered"],
    ["problem","Problem"], ["returned","Returned"], ["cancelled","Cancelled"]
  ];
  function group(p){
    if (B.isDelivered(p)) return "delivered";
    var s = String(p.status || "");
    if (s === "New booked") return "booked";
    if (PROBLEM.indexOf(s) > -1) return "problem";
    if (RETURNED.indexOf(s) > -1) return "returned";
    if (CANCELLED.indexOf(s) > -1) return "cancelled";
    return "moving";
  }
  /* the same list the classic report called "pending COD" */
  var COLLECTIBLE = ["Collected by rider","Arrived at warehouse","Parcel now in transit","Parcel received at destination","Parcel out for delivery","Reattempt","Reassigned"];

  /* ------------------------------------------------------------- data */
  var COLS = "id,awb,consignee,phone,address,city,status,cod_amount,fee,booked_at,delivered_at,status_since,exception,invoice_id,steps:meta->steps,orderId:meta->>orderId,destArr:meta->>destinationArrivedAt";
  function mapRow(r){
    var st = B.nvStatus(r.status) || "New booked";
    return {
      _uuid:r.id, awb:r.awb || "", clientId:B.clientId(), consignee:r.consignee || "", phone:r.phone || "",
      address:r.address || "", city:(r.city || "").trim(), status:st, cod:Number(r.cod_amount || 0), fee:Number(r.fee || 0),
      bookedAt:r.booked_at || null, date:pktDay(r.booked_at), deliveredAt:r.delivered_at || null,
      statusSince:r.status_since || r.booked_at || null, exception:r.exception || "", invoiceId:r.invoice_id || null,
      steps:(Array.isArray(r.steps) && r.steps.length) ? r.steps : B.stepsOf(st), processHistory:[], orderId:r.orderId || "",
      _meta:r.destArr ? { destinationArrivedAt:r.destArr } : {}
    };
  }
  async function fetchRange(a, b){
    if (Array.isArray(window.__nvReportDemoRows)) {          /* local demo harness only */
      return window.__nvReportDemoRows.map(mapRow).filter(function(p){ return (!a || p.date >= a) && p.date <= b; });
    }
    var sb = B.sb(), cid = B.clientId();
    if (!sb || !cid || B.demo()) throw new Error("offline");
    var out = [], page = 0, SIZE = 1000;
    while (true) {
      var q = sb.from("parcels").select(COLS).eq("client_id", cid);
      if (a) q = q.gte("booked_at", startIso(a));
      q = q.lt("booked_at", startIso(addDays(b, 1)));
      var r = await q.order("booked_at", { ascending:false }).order("id", { ascending:false }).range(page * SIZE, page * SIZE + SIZE - 1);
      if (r.error) throw new Error(r.error.message);
      var batch = r.data || [];
      out = out.concat(batch);
      if (batch.length < SIZE || out.length >= 20000) break;
      page++;
    }
    return out.map(mapRow);
  }
  function localRange(a, b){
    return B.parcels().filter(function(p){ var d = p.date || pktDay(p.bookedAt); return (!a || d >= a) && d <= b; });
  }
  /* force: the merchant changed something -- dim, refetch, repaint.
     Otherwise a quiet refresh (the portal re-renders often): at most once a
     minute, no dimming, no count-up replay, and no repaint at all unless the
     data actually changed, so the page never jumps under someone reading it. */
  function sig(rows){ return rows.length + ":" + rows.map(function(p){ return p.awb + p.status + p.cod + p.fee; }).join("|"); }
  async function load(force){
    var R = range(), key = S.period + "|" + R.a + "|" + R.b + "|" + (S.compare ? 1 : 0);
    if (!force && S.key === key && S.rows && Date.now() - S.at < 60000) return;
    if (!force && S.loading) return;
    var quiet = !force && S.key === key && !!S.rows;
    S.loading = true; S.err = ""; S.key = key;
    if (!S.rows) paint();                         /* skeleton only on the very first load */
    else if (!quiet) markBusy(true);
    var fromA = (S.compare && R.pa) ? R.pa : R.a, all, partial = false;
    try { all = await fetchRange(fromA, R.b); }
    catch(e){ all = localRange(fromA, R.b); partial = !B.demo(); }
    if (S.key !== key) return;                    /* a newer request superseded this one */
    var rows = all.filter(function(p){ return (!R.a || p.date >= R.a) && p.date <= R.b; });
    var prev = (S.compare && R.pa) ? all.filter(function(p){ return p.date >= R.pa && p.date <= R.pb; }) : null;
    S.loading = false; S.at = Date.now();
    if (quiet && S.rows && sig(rows) === sig(S.rows) && sig(prev || []) === sig(S.prev || []) && partial === S.partial) return;
    S.rows = rows; S.prev = prev; S.partial = partial;
    if (!quiet) { S.counted = false; S.shown = 50; }
    var y = window.scrollY;
    paint();
    if (quiet) window.scrollTo(0, y);
  }

  /* ---------------------------------------------------------- metrics */
  function median(a){ if(!a.length) return null; a = a.slice().sort(function(x,y){ return x-y; }); var m = a.length >> 1; return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2; }
  function hoursToDeliver(p){
    if (!p.deliveredAt || !p.bookedAt) return null;
    var h = (Date.parse(p.deliveredAt) - Date.parse(p.bookedAt)) / 3600000;
    return isFinite(h) && h >= 0 ? h : null;
  }
  function metrics(rows){
    var m = { total:rows.length, g:{ booked:0, moving:0, delivered:0, problem:0, returned:0, cancelled:0 },
              cod:{ delivered:0, moving:0, lost:0, all:0 }, fees:0, deliveredCount:0, settled:0, pendingCod:0, times:[] };
    rows.forEach(function(p){
      var g = group(p); m.g[g]++;
      if (g !== "cancelled") m.cod.all += p.cod;
      if (g === "delivered") { m.cod.delivered += p.cod; m.fees += p.fee; var h = hoursToDeliver(p); if (h != null) m.times.push(h); }
      else if (g === "booked" || g === "moving") m.cod.moving += p.cod;
      else if (g === "problem" || g === "returned") m.cod.lost += p.cod;
      if (String(p.status).indexOf("Delivered") > -1) m.deliveredCount++;
      if (B.settled(p) && B.rated(p)) m.settled++;
      if (COLLECTIBLE.indexOf(String(p.status)) > -1) m.pendingCod += p.cod;
    });
    m.rate = m.settled ? Math.round(m.deliveredCount / m.settled * 100) : null;
    m.median = median(m.times);
    m.net = m.cod.delivered - m.fees;
    return m;
  }

  /* buckets for the trend chart and sparklines */
  function buckets(rows, R){
    var a = R.a, b = R.b;
    if (!a) { a = rows.reduce(function(x, p){ return p.date && p.date < x ? p.date : x; }, b); }
    var span = daysBetween(a, b) + 1, unit = span > 180 ? "month" : span > 62 ? "week" : "day";
    var keys = [], idx = {};
    function keyOf(d){
      if (unit === "day") return d;
      if (unit === "month") return d.slice(0,7) + "-01";
      var wd = new Date(d + "T00:00:00Z").getUTCDay(); return addDays(d, -((wd + 6) % 7));
    }
    for (var d = a; d <= b; d = addDays(d, 1)) { var k = keyOf(d); if (idx[k] == null) { idx[k] = keys.length; keys.push(k); } }
    var list = keys.map(function(k){ return { k:k, booked:0, delivered:0, cod:0, settled:0, dcount:0, times:[] }; });
    rows.forEach(function(p){
      var i = idx[keyOf(p.date)]; if (i != null) {
        list[i].booked++;
        if (B.settled(p) && B.rated(p)) list[i].settled++;
        if (String(p.status).indexOf("Delivered") > -1) list[i].dcount++;
      }
      if (group(p) === "delivered") {
        var dd = pktDay(p.deliveredAt) || p.date, j = idx[keyOf(dd)];
        if (j != null) { list[j].delivered++; list[j].cod += p.cod; var h = hoursToDeliver(p); if (h != null) list[j].times.push(h); }
      }
    });
    list.forEach(function(x){ x.rate = x.settled ? x.dcount / x.settled * 100 : null; x.med = median(x.times); });
    return { unit:unit, list:list };
  }

  /* --------------------------------------------------------- helpers */
  function esc(v){ return B.esc(v); }
  function rs(v){ return B.money(Math.round(Number(v) || 0)); }
  function pct(a, b){ return b ? Math.round(a / b * 100) : 0; }
  function num(v){ return (Number(v) || 0).toLocaleString("en-US"); }
  function delta(cur, prev, kind){
    /* kind: "up" = higher is better, "down" = lower is better, "pts" = percentage points */
    if (!S.compare || prev == null || cur == null) return "";
    var diff, txt, better;
    if (kind === "pts") {
      diff = cur - prev; if (Math.abs(diff) < 1) return '<span class="nvr-d is-flat">same as before</span>';
      txt = (diff > 0 ? "+" : "−") + Math.abs(Math.round(diff)) + " pts"; better = diff > 0;
    } else {
      if (!prev) return cur ? '<span class="nvr-d is-flat">new this period</span>' : "";
      diff = (cur - prev) / prev * 100; if (Math.abs(diff) < 1) return '<span class="nvr-d is-flat">same as before</span>';
      txt = (diff > 0 ? "▲ " : "▼ ") + Math.abs(Math.round(diff)) + "%";
      better = kind === "down" ? diff < 0 : diff > 0;
    }
    return '<span class="nvr-d ' + (better ? "is-good" : "is-bad") + '">' + txt + '</span><span class="nvr-dvs">vs previous</span>';
  }
  function spark(vals){
    var v = vals.map(function(x){ return x == null ? null : Number(x); });
    var real = v.filter(function(x){ return x != null; });
    if (real.length < 4) return "";              /* two or three points read as a stray stroke, not a trend */
    var max = Math.max.apply(null, real), min = Math.min.apply(null, real), W = 96, H = 28, n = v.length;
    var pts = [];
    v.forEach(function(x, i){ if (x == null) return; var X = n > 1 ? i / (n - 1) * W : 0; var Y = H - 3 - (max === min ? (H - 6) / 2 : (x - min) / (max - min) * (H - 6)); pts.push(X.toFixed(1) + "," + Y.toFixed(1)); });
    return '<svg class="nvr-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts.join(" ") + '"/></svg>';
  }
  function phoneFmt(ph){ var d = String(ph || "").replace(/\D/g, ""); if (d.indexOf("92") === 0) d = "0" + d.slice(2); return d.length === 11 ? d.slice(0,4) + " " + d.slice(4) : (ph || ""); }
  function groupLabel(g){ for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i][0] === g) return GROUPS[i][1]; return g; }

  /* ------------------------------------------------------------ view */
  function filtered(){
    var q = S.q.trim().toLowerCase();
    var list = (S.rows || []).filter(function(p){
      if (S.group !== "all" && group(p) !== S.group) return false;
      if (S.city && p.city !== S.city) return false;
      if (q) {
        var hay = (p.awb + " " + p.consignee + " " + p.city + " " + B.statusLabel(p.status) + " " + p.phone + " " + p.orderId).toLowerCase();
        var dq = q.replace(/\D/g, "");
        var phoneHit = dq.length >= 4 && /^[\d\s+()-]+$/.test(q) && String(p.phone || "").replace(/\D/g, "").indexOf(dq.replace(/^(92|0)/, "")) > -1;
        if (hay.indexOf(q) < 0 && !phoneHit) return false;
      }
      return true;
    });
    var by = {
      "new":  function(x, y){ return String(y.bookedAt || "").localeCompare(String(x.bookedAt || "")); },
      "old":  function(x, y){ return String(x.bookedAt || "").localeCompare(String(y.bookedAt || "")); },
      "cod":  function(x, y){ return y.cod - x.cod; },
      "wait": function(x, y){ return (B.agingHours(y) || 0) - (B.agingHours(x) || 0); }
    }[S.sort] || null;
    if (by) list.sort(by);
    return list;
  }

  function insights(m, pm){
    var rows = S.rows || [], out = [];
    var stuck = rows.filter(function(p){ return group(p) === "moving" && (Date.now() - Date.parse(p.statusSince || p.bookedAt)) > 72 * 3600000; });
    if (stuck.length) out.push({ tone:"bad", icon:"!", text:"<b>" + stuck.length + " parcel" + (stuck.length === 1 ? " has" : "s have") + " not moved for over 3 days.</b> Open " + (stuck.length === 1 ? "it" : "them") + " to see where " + (stuck.length === 1 ? "it is" : "they are") + ".", act:{ group:"moving", sort:"wait" } });
    var late = rows.filter(function(p){ return group(p) === "booked" && (Date.now() - Date.parse(p.bookedAt)) > 24 * 3600000; });
    if (late.length) out.push({ tone:"warn", icon:"⏱", text:"<b>" + late.length + " parcel" + (late.length === 1 ? " was" : "s were") + " booked over a day ago and " + (late.length === 1 ? "is" : "are") + " still waiting for pickup.</b> Request a pickup so a rider collects " + (late.length === 1 ? "it" : "them") + ".", act:{ tab:"awbLabel" }, btn:"Request pickup" });
    var byPhone = {};
    rows.concat(S.prev || []).forEach(function(p){
      var g = group(p); if (g !== "problem" && g !== "returned") return;
      var k = String(p.phone || "").replace(/\D/g, "").slice(-10); if (k.length < 10) return;
      (byPhone[k] = byPhone[k] || []).push(p);
    });
    var repeat = Object.keys(byPhone).filter(function(k){ return byPhone[k].length >= 2; });
    if (repeat.length) out.push({ tone:"warn", icon:"↻", text:"<b>" + repeat.length + " customer" + (repeat.length === 1 ? " has" : "s have") + " refused or missed more than one delivery.</b> Check before sending them COD again.", act:{ scroll:"nvrProblems" }, btn:"See who" });
    if (pm) {
      cityStats(S.rows).forEach(function(c){
        var pc = cityStats(S.prev).filter(function(x){ return x.city === c.city; })[0];
        if (pc && c.settled >= 5 && pc.settled >= 5 && c.rate != null && pc.rate != null && pc.rate - c.rate >= 10)
          out.push({ tone:"warn", icon:"↘", text:"<b>" + esc(c.city) + " delivery success fell from " + pc.rate + "% to " + c.rate + "%.</b>", act:{ city:c.city, group:"problem" }, btn:"See " + esc(c.city) });
      });
      if (pm.total >= 10) {
        var ch = Math.round((m.total - pm.total) / pm.total * 100);
        if (Math.abs(ch) >= 20) out.push({ tone:ch > 0 ? "good" : "info", icon:ch > 0 ? "↗" : "↘", text:"You booked <b>" + Math.abs(ch) + "% " + (ch > 0 ? "more" : "fewer") + " parcels</b> than the previous period (" + num(m.total) + " vs " + num(pm.total) + ")." });
      }
    }
    if (m.pendingCod > 0) out.push({ tone:"info", icon:"Rs", text:"<b>" + rs(m.pendingCod) + " of COD is on its way</b> on " + num(m.g.moving) + " parcel" + (m.g.moving === 1 ? "" : "s") + " still moving.", act:{ group:"moving" } });
    var cs = cityStats(S.rows).filter(function(c){ return c.med != null && c.delivered >= 5; });
    if (cs.length >= 2) {
      cs.sort(function(a, b){ return a.med - b.med; });
      out.push({ tone:"info", icon:"⚡", text:"<b>" + esc(cs[0].city) + "</b> parcels arrive in <b>" + durLabel(cs[0].med) + "</b> on average; " + esc(cs[cs.length - 1].city) + " in " + durLabel(cs[cs.length - 1].med) + "." });
    }
    if (!out.length && m.total) out.push({ tone:"good", icon:"✓", text:"<b>Nothing needs you.</b> No stuck parcels, no overdue pickups and no repeat refusals in this period." });
    return out.slice(0, 3);
  }

  function cityStats(rows){
    var map = {};
    (rows || []).forEach(function(p){
      var c = p.city || "Unknown";
      var x = map[c] = map[c] || { city:c, total:0, g:{ booked:0, moving:0, delivered:0, problem:0, returned:0, cancelled:0 }, settled:0, dcount:0, times:[], cod:0 };
      var g = group(p); x.total++; x.g[g]++;
      if (B.settled(p) && B.rated(p)) x.settled++;
      if (String(p.status).indexOf("Delivered") > -1) x.dcount++;
      if (g === "delivered") { x.cod += p.cod; var h = hoursToDeliver(p); if (h != null) x.times.push(h); }
    });
    return Object.keys(map).map(function(k){ var x = map[k]; x.rate = x.settled ? Math.round(x.dcount / x.settled * 100) : null; x.med = median(x.times); x.delivered = x.g.delivered; return x; })
      .sort(function(a, b){ return b.total - a.total; });
  }

  /* ----------------------------------------------------------- paint */
  function skeleton(){
    return '<div class="nvr-kpis">' + [0,1,2,3].map(function(){ return '<div class="nvr-card nvr-kpi"><i class="nvr-sk" style="width:46%"></i><i class="nvr-sk nvr-sk-big"></i><i class="nvr-sk" style="width:62%"></i></div>'; }).join("") + '</div>' +
      '<div class="nvr-card"><i class="nvr-sk" style="width:30%"></i><i class="nvr-sk" style="width:80%;margin-top:14px"></i><i class="nvr-sk" style="width:70%"></i></div>' +
      '<div class="nvr-card"><i class="nvr-sk" style="width:24%"></i><i class="nvr-sk nvr-sk-chart"></i></div>';
  }

  function bar(){
    var R = range();
    var chips = PERIODS.map(function(p){ return '<button type="button" class="nvr-chip' + (S.period === p[0] ? " is-on" : "") + '" data-period="' + p[0] + '" aria-pressed="' + (S.period === p[0]) + '">' + p[1] + '</button>'; }).join("");
    var custom = S.period === "custom"
      ? '<div class="nvr-custom"><label>From<input type="date" id="nvrFrom" value="' + esc(R.a) + '" max="' + today() + '"></label><label>To<input type="date" id="nvrTo" value="' + esc(R.b) + '" max="' + today() + '"></label></div>'
      : "";
    return '<div class="nvr-bar" id="nvrBar">' +
      '<div class="nvr-chips" role="group" aria-label="Report period">' + chips + '</div>' +
      '<div class="nvr-bar-r">' +
        (S.period !== "all" ? '<label class="nvr-toggle"><input type="checkbox" id="nvrCompare"' + (S.compare ? " checked" : "") + '><span></span>Compare</label>' : "") +
        '<div class="nvr-export"><button type="button" class="nvr-btn" id="nvrExportBtn" aria-haspopup="true" aria-expanded="' + S.exportOpen + '">Export<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg></button>' +
          '<div class="nvr-menu" id="nvrExportMenu"' + (S.exportOpen ? "" : " hidden") + '>' +
            '<button type="button" data-export="csv"><b>Spreadsheet (CSV)</b><span>The parcels in the list below</span></button>' +
            '<button type="button" data-export="pdf"><b>PDF report</b><span>Summary, cities and parcels for this period</span></button>' +
          '</div></div>' +
      '</div>' + custom + '</div>';
  }

  function scopeLine(m, R){
    var s = '<b>' + esc(rangeLabel(R.a, R.b)) + '</b> · ' + num(m.total) + ' parcel' + (m.total === 1 ? "" : "s") + ' booked';
    if (S.compare && R.pa) s += ' <span class="nvr-muted">· compared with ' + esc(rangeLabel(R.pa, R.pb)) + '</span>';
    if (S.partial) s += ' <span class="nvr-warn">· offline: showing only the parcels this page already had</span>';
    return '<p class="nvr-scope">' + s + '</p>';
  }

  function kpis(m, pm, bk){
    var L = bk.list;
    function card(label, value, raw, sub, d, sp, fmt){
      return '<div class="nvr-card nvr-kpi"><span class="nvr-kl">' + label + '</span>' +
        '<strong class="nvr-kv" data-count="' + (raw == null ? "" : raw) + '" data-fmt="' + (fmt || "") + '">' + value + '</strong>' +
        '<div class="nvr-kd">' + (d || '<span class="nvr-dvs">' + sub + '</span>') + '</div>' + (sp || "") + '</div>';
    }
    return '<div class="nvr-kpis">' +
      card("Delivered COD", rs(m.cod.delivered), m.cod.delivered, "cash collected", delta(m.cod.delivered, pm && pm.cod.delivered, "up"), spark(L.map(function(x){ return x.cod; })), "rs") +
      card("Delivery success", m.rate == null ? "—" : m.rate + "%", m.rate, m.settled ? num(m.deliveredCount) + " of " + num(m.settled) + " finished" : "no parcel has finished yet", delta(m.rate, pm && pm.rate, "pts"), spark(L.map(function(x){ return x.rate; })), "pct") +
      card("Parcels booked", num(m.total), m.total, "in this period", delta(m.total, pm && pm.total, "up"), spark(L.map(function(x){ return x.booked; })), "n") +
      card("Typical delivery time", durLabel(m.median), null, m.times.length ? "booking to delivery" : (m.g.delivered ? "delivery times not recorded" : "no deliveries yet"), delta(m.median, pm && pm.median, "down"), spark(L.map(function(x){ return x.med; }))) +
    '</div>';
  }

  function insightsHtml(list){
    if (!list.length) return "";
    return '<div class="nvr-ins" aria-label="What changed">' + list.map(function(x, i){
      var a = x.act ? ' data-ins="' + i + '"' : "";
      return '<div class="nvr-in is-' + x.tone + '"><span class="nvr-in-i" aria-hidden="true">' + x.icon + '</span><p>' + x.text + '</p>' +
        (x.act ? '<button type="button" class="nvr-link"' + a + '>' + (x.btn || "Show") + ' →</button>' : "") + '</div>';
    }).join("") + '</div>';
  }

  function moneyFlow(m){
    var c = m.cod, tot = c.all || 0;
    if (!tot) return '<div class="nvr-card"><h4 class="nvr-h">Where your COD is</h4><p class="nvr-empty">No COD parcels in this period.</p></div>';
    function seg(v, cls, label){ var w = v / tot * 100; return w > 0 ? '<span class="nvr-seg ' + cls + '" style="width:' + w.toFixed(2) + '%" title="' + esc(label + ": " + rs(v)) + '"></span>' : ""; }
    var net = Math.max(0, m.net);
    return '<div class="nvr-card nvr-flow"><div class="nvr-hrow"><h4 class="nvr-h">Where your COD is</h4><button type="button" class="nvr-link" data-go="money">Wallet &amp; payouts →</button></div>' +
      '<p class="nvr-sub">' + rs(tot) + ' of COD on parcels booked in this period</p>' +
      '<div class="nvr-stack" role="img" aria-label="' + esc("Collected " + rs(c.delivered) + ", on the way " + rs(c.moving) + ", not collected " + rs(c.lost)) + '">' +
        seg(c.delivered, "is-good", "Collected") + seg(c.moving, "is-info", "On the way") + seg(c.lost, "is-bad", "Not collected") + '</div>' +
      '<div class="nvr-legend">' +
        '<div><i class="is-good"></i><span>Collected</span><b>' + rs(c.delivered) + '</b><em>' + pct(c.delivered, tot) + '%</em></div>' +
        '<div><i class="is-info"></i><span>On the way</span><b>' + rs(c.moving) + '</b><em>' + pct(c.moving, tot) + '%</em></div>' +
        '<div><i class="is-bad"></i><span>Not collected</span><b>' + rs(c.lost) + '</b><em>refused or returned</em></div>' +
      '</div>' +
      '<div class="nvr-sum">' +
        '<div><span>Collected</span><b>' + rs(c.delivered) + '</b></div><span class="nvr-op">−</span>' +
        '<div class="is-minus"><span>NovaX delivery charges</span><b>' + rs(m.fees) + '</b></div><span class="nvr-op">=</span>' +
        '<div class="is-net"><span>Yours</span><b>' + rs(net) + '</b></div>' +
      '</div></div>';
  }

  function trend(bk){
    var L = bk.list;
    if (L.length < 2) return "";
    var any = L.some(function(x){ return x.booked || x.delivered; });
    var unit = bk.unit === "day" ? "per day" : bk.unit === "week" ? "per week" : "per month";
    return '<div class="nvr-card nvr-trend"><div class="nvr-hrow"><h4 class="nvr-h">Bookings and deliveries <span class="nvr-muted">' + unit + '</span></h4>' +
      '<div class="nvr-keys"><span><i class="k-book"></i>Booked</span><span><i class="k-del"></i>Delivered</span></div></div>' +
      (any ? '<div class="nvr-chart" id="nvrChart"></div><div class="nvr-tip" id="nvrTip" hidden></div>' : '<p class="nvr-empty">Nothing booked in this period.</p>') + '</div>';
  }
  function drawChart(bk){
    var host = document.getElementById("nvrChart"); if (!host) return;
    var L = bk.list, W = Math.max(280, host.clientWidth || 600), H = W < 520 ? 170 : 210, pl = 30, pr = 8, pt = 10, pb = 22;
    var max = Math.max(1, Math.max.apply(null, L.map(function(x){ return Math.max(x.booked, x.delivered); })));
    var nice = max <= 5 ? 5 : max <= 10 ? 10 : Math.ceil(max / 5) * 5;
    var iw = W - pl - pr, ih = H - pt - pb, n = L.length, bw = Math.max(2, Math.min(26, iw / n * 0.62));
    function X(i){ return pl + (i + 0.5) * iw / n; }
    function Y(v){ return pt + ih - v / nice * ih; }
    var g = "";
    [0, 0.5, 1].forEach(function(f){ var v = Math.round(nice * f), y = Y(v); g += '<line class="g" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y + '" y2="' + y + '"/><text class="t" x="' + (pl - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + v + '</text>'; });
    var bars = L.map(function(x, i){ var h = Math.max(x.booked ? 2 : 0, ih - (Y(x.booked) - pt)); return '<rect class="b" x="' + (X(i) - bw / 2).toFixed(1) + '" y="' + (pt + ih - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="' + Math.min(4, bw / 3).toFixed(1) + '"/>'; }).join("");
    var line = L.map(function(x, i){ return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(x.delivered).toFixed(1); }).join(" ");
    var area = line + " L" + X(n - 1).toFixed(1) + " " + (pt + ih) + " L" + X(0).toFixed(1) + " " + (pt + ih) + " Z";
    var labIdx = n <= 8 ? L.map(function(_, i){ return i; }) : [0, Math.floor((n - 1) / 2), n - 1];
    var labs = labIdx.map(function(i){ var k = L[i].k; var t = bk.unit === "month" ? MON[Number(k.slice(5,7)) - 1] + " " + k.slice(2,4) : dLabel(k); return '<text class="t" x="' + X(i) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 && n > 8 ? "start" : i === n - 1 && n > 8 ? "end" : "middle") + '">' + t + '</text>'; }).join("");
    host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Bookings and deliveries chart">' + g + bars +
      '<path class="a" d="' + area + '"/><path class="l" d="' + line + '"/><line class="cur" id="nvrCur" x1="0" x2="0" y1="' + pt + '" y2="' + (pt + ih) + '" style="display:none"/>' + labs + '</svg>';
    var svg = host.firstChild, tip = document.getElementById("nvrTip"), cur = document.getElementById("nvrCur");
    function at(ev){
      var r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * W;
      var i = Math.max(0, Math.min(n - 1, Math.floor((x - pl) / iw * n))), d = L[i];
      cur.setAttribute("x1", X(i)); cur.setAttribute("x2", X(i)); cur.style.display = "";
      var when = bk.unit === "day" ? dLabel(d.k, true) : bk.unit === "week" ? "Week of " + dLabel(d.k) : MON[Number(d.k.slice(5,7)) - 1] + " " + d.k.slice(0,4);
      tip.innerHTML = '<b>' + when + '</b><span><i class="k-book"></i>' + d.booked + ' booked</span><span><i class="k-del"></i>' + d.delivered + ' delivered</span>' + (d.cod ? '<span>' + rs(d.cod) + ' collected</span>' : "");
      tip.hidden = false;
      var tx = X(i) / W * r.width, tw = tip.offsetWidth, hw = host.clientWidth;
      tip.style.left = Math.max(0, Math.min(hw - tw, tx - tw / 2)) + "px";
    }
    svg.addEventListener("pointermove", at);
    svg.addEventListener("pointerdown", at);
    svg.addEventListener("pointerleave", function(){ tip.hidden = true; cur.style.display = "none"; });
    if (!window.__nvrTipOff) {                     /* a tap anywhere else closes it on touch screens */
      window.__nvrTipOff = true;
      document.addEventListener("pointerdown", function(e){
        var t = document.getElementById("nvrTip"), c = document.getElementById("nvrChart");
        if (t && !t.hidden && c && !c.contains(e.target)) { t.hidden = true; var k = document.getElementById("nvrCur"); if (k) k.style.display = "none"; }
      }, true);
    }
  }

  function cities(){
    var cs = cityStats(S.rows);
    if (!cs.length) return "";
    return '<div class="nvr-card nvr-cities"><div class="nvr-hrow"><h4 class="nvr-h">Cities</h4><span class="nvr-muted nvr-small">tap a city to see its parcels</span></div>' +
      '<div class="nvr-ct-head"><span>City</span><span>Outcomes</span><span>Success</span><span>Typical time</span><span>Collected</span></div>' +
      cs.map(function(c){
        function seg(k, cls){ var w = c.g[k] / c.total * 100; return w > 0 ? '<span class="nvr-seg ' + cls + '" style="width:' + w.toFixed(2) + '%"></span>' : ""; }
        return '<button type="button" class="nvr-ct' + (S.city === c.city ? " is-on" : "") + '" data-city="' + esc(c.city) + '">' +
          '<span class="nvr-ct-n"><b>' + esc(c.city) + '</b><em>' + num(c.total) + ' parcel' + (c.total === 1 ? "" : "s") + '</em></span>' +
          '<span class="nvr-stack nvr-stack-sm">' + seg("delivered","is-good") + seg("moving","is-info") + seg("booked","is-neutral") + seg("problem","is-warn") + seg("returned","is-bad") + seg("cancelled","is-muted") + '</span>' +
          '<span class="nvr-ct-v"><em>Success</em>' + (c.rate == null ? "—" : c.rate + "%") + '</span>' +
          '<span class="nvr-ct-v"><em>Typical time</em>' + durLabel(c.med) + '</span>' +
          '<span class="nvr-ct-v"><em>Collected</em>' + rs(c.cod) + '</span></button>';
      }).join("") +
      '<div class="nvr-keys nvr-keys-wrap"><span><i class="is-good"></i>Delivered</span><span><i class="is-info"></i>Moving</span><span><i class="is-neutral"></i>Booked</span><span><i class="is-warn"></i>Problem</span><span><i class="is-bad"></i>Returned</span></div></div>';
  }

  function problems(m){
    var rows = S.rows || [];
    var reasons = [["Refused","Customer refused"],["Consignee not available","Customer not available"],["Out of service area","Outside our area"]];
    var counts = reasons.map(function(r){ return { k:r[0], label:r[1], n:rows.filter(function(p){ return p.status === r[0]; }).length }; });
    counts.push({ k:"_ret", label:"Returned to you", n:m.g.returned });
    var totalBad = counts.reduce(function(s, x){ return s + x.n; }, 0);
    var byPhone = {};
    rows.concat(S.prev || []).forEach(function(p){
      var g = group(p); if (g !== "problem" && g !== "returned") return;
      var k = String(p.phone || "").replace(/\D/g, "").slice(-10); if (k.length < 10) return;
      (byPhone[k] = byPhone[k] || { name:p.consignee, phone:p.phone, list:[] }).list.push(p);
    });
    var repeat = Object.keys(byPhone).map(function(k){ return byPhone[k]; }).filter(function(x){ return x.list.length >= 2; })
      .sort(function(a, b){ return b.list.length - a.list.length; }).slice(0, 6);
    var maxN = Math.max(1, Math.max.apply(null, counts.map(function(x){ return x.n; })));
    return '<div class="nvr-card nvr-probs" id="nvrProblems"><div class="nvr-hrow"><h4 class="nvr-h">Problems</h4>' +
      (totalBad ? '<button type="button" class="nvr-link" data-group="problem">See these parcels →</button>' : "") + '</div>' +
      (totalBad
        ? '<div class="nvr-reasons">' + counts.map(function(x){ return '<div class="nvr-rs"><span>' + x.label + '</span><span class="nvr-rs-bar"><i style="width:' + (x.n / maxN * 100).toFixed(1) + '%"></i></span><b>' + x.n + '</b></div>'; }).join("") + '</div>'
        : '<p class="nvr-empty is-good">No refusals or returns in this period.</p>') +
      (repeat.length
        ? '<h5 class="nvr-h5">Customers who refused or missed more than once</h5><div class="nvr-rep">' + repeat.map(function(x){
            return '<button type="button" class="nvr-rep-r" data-search="' + esc(String(x.phone || "").replace(/\D/g, "").slice(-10)) + '"><span><b>' + esc(x.name || "Unnamed") + '</b><em>' + esc(phoneFmt(x.phone)) + '</em></span><span class="nvr-pill is-bad">' + x.list.length + ' times</span></button>';
          }).join("") + '</div><p class="nvr-foot">Counted across this period and the one before it. Consider asking these customers to pay in advance.</p>'
        : "") + '</div>';
  }

  function explorer(){
    var list = filtered(), counts = {}, base = (S.rows || []).filter(function(p){ return !S.city || p.city === S.city; });
    GROUPS.forEach(function(g){ counts[g[0]] = g[0] === "all" ? base.length : base.filter(function(p){ return group(p) === g[0]; }).length; });
    var citiesList = cityStats(S.rows).map(function(c){ return c.city; });
    var tabs = GROUPS.filter(function(g){ return g[0] !== "cancelled" || counts.cancelled; }).map(function(g){
      return '<button type="button" class="nvr-tab' + (S.group === g[0] ? " is-on" : "") + '" data-group="' + g[0] + '" aria-pressed="' + (S.group === g[0]) + '">' + g[1] + '<span>' + counts[g[0]] + '</span></button>';
    }).join("");
    var shown = list.slice(0, S.shown);
    var rowsHtml = shown.map(function(p){
      var g = group(p);
      return '<div class="nvr-r" role="button" tabindex="0" data-awb="' + esc(p.awb) + '">' +
        '<span class="nvr-c c-awb"><b>' + esc(p.awb) + '</b>' + (B.paidPill(p) || "") + '</span>' +
        '<span class="nvr-c c-date">' + esc(dLabel(p.date)) + '</span>' +
        '<span class="nvr-c c-who"><b>' + esc(p.consignee || "—") + '</b><em>' + esc(p.city) + '<i class="c-d2"> · ' + esc(dLabel(p.date)) + '</i></em></span>' +
        '<span class="nvr-c c-st"><span class="nvr-pill is-' + g + '">' + esc(B.statusLabel(p.status)) + '</span></span>' +
        '<span class="nvr-c c-cod">' + (p.cod ? rs(p.cod) : '<em>Prepaid</em>') + '</span>' +
        '<span class="nvr-c c-fee">' + rs(p.fee) + '</span>' +
        '<span class="nvr-c c-time">' + esc(B.ageText(p)) + '</span></div>';
    }).join("");
    var active = S.q || S.city || S.group !== "all";
    return '<div class="nvr-card nvr-exp" id="nvrExplorer"><div class="nvr-hrow"><h4 class="nvr-h">Parcels</h4><span class="nvr-muted nvr-small">' + num(list.length) + ' of ' + num((S.rows || []).length) + '</span></div>' +
      '<div class="nvr-tools"><div class="nvr-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6"/><path d="m14 14 4 4"/></svg><input id="nvrQ" type="search" enterkeyhint="search" autocomplete="off" placeholder="Search AWB, name, phone" value="' + esc(S.q) + '" aria-label="Search parcels"><kbd>/</kbd></div>' +
        '<select id="nvrCity" aria-label="City"><option value="">All cities</option>' + citiesList.map(function(c){ return '<option' + (S.city === c ? " selected" : "") + '>' + esc(c) + '</option>'; }).join("") + '</select>' +
        '<select id="nvrSort" aria-label="Sort"><option value="new"' + (S.sort === "new" ? " selected" : "") + '>Newest first</option><option value="old"' + (S.sort === "old" ? " selected" : "") + '>Oldest first</option><option value="cod"' + (S.sort === "cod" ? " selected" : "") + '>Highest COD</option><option value="wait"' + (S.sort === "wait" ? " selected" : "") + '>Waiting longest</option></select></div>' +
      '<div class="nvr-tabs" role="group" aria-label="Filter by outcome">' + tabs + '</div>' +
      (active ? '<p class="nvr-filt">Filtered' + (S.city ? " to <b>" + esc(S.city) + "</b>" : "") + (S.group !== "all" ? " · <b>" + groupLabel(S.group) + "</b>" : "") + (S.q ? " · “" + esc(S.q) + "”" : "") + ' <button type="button" class="nvr-link" id="nvrClear">Clear</button></p>' : "") +
      '<div class="nvr-list"><div class="nvr-r nvr-head" aria-hidden="true"><span class="nvr-c c-awb">AWB</span><span class="nvr-c c-date">Booked</span><span class="nvr-c c-who">Customer</span><span class="nvr-c c-st">Status</span><span class="nvr-c c-cod">COD</span><span class="nvr-c c-fee">Fee</span><span class="nvr-c c-time">Time</span></div>' +
        (rowsHtml || '<p class="nvr-empty">No parcels match.' + (active ? ' <button type="button" class="nvr-link" id="nvrClear2">Clear filters</button>' : "") + '</p>') + '</div>' +
      (list.length > S.shown ? '<button type="button" class="nvr-more" id="nvrMore">Show ' + Math.min(50, list.length - S.shown) + ' more <span>' + num(list.length - S.shown) + ' left</span></button>' : "") + '</div>';
  }

  var INS = [];
  function paint(){
    if (!HOST) return;
    var focusId = document.activeElement && HOST.contains(document.activeElement) ? document.activeElement.id : "";
    var caret = focusId === "nvrQ" ? document.activeElement.selectionStart : null;
    if (!S.rows) { HOST.innerHTML = bar() + '<div class="nvr-body is-loading">' + skeleton() + '</div>'; return; }
    var R = range(), m = metrics(S.rows), pm = S.prev ? metrics(S.prev) : null, bk = buckets(S.rows, R);
    INS = insights(m, pm);
    var small = m.total < 10;
    HOST.innerHTML = bar() +
      '<div class="nvr-body">' + scopeLine(m, R) +
      (m.total === 0
        ? '<div class="nvr-card nvr-zero"><h4>No parcels booked ' + (S.period === "today" ? "today" : "in this period") + '</h4><p>Pick a longer period above, or book a parcel and it shows up here straight away.</p><div><button type="button" class="nvr-btn" data-period="all">Show all time</button> <button type="button" class="nvr-btn is-primary" data-go="newBooking">Book a parcel</button></div></div>'
        : kpis(m, pm, bk) + insightsHtml(INS) +
          '<div class="nvr-grid">' + moneyFlow(m) + (small ? '<div class="nvr-card nvr-note"><h4 class="nvr-h">Charts</h4><p class="nvr-empty">Charts appear once you have 10 or more parcels in the period. You have ' + m.total + ' so far.</p></div>' : trend(bk)) + '</div>' +
          '<div class="nvr-grid">' + cities() + problems(m) + '</div>' + explorer()) +
      '</div>';
    if (!small) drawChart(bk);
    countUp();
    if (focusId) { var el = document.getElementById(focusId); if (el) { el.focus(); if (caret != null && el.setSelectionRange) try{ el.setSelectionRange(caret, caret); }catch(e){} } }
  }
  /* The bar alone, so a period change shows the new chip at once while the
     old figures stay (dimmed) until the new ones arrive -- never a new date
     label beside old numbers. */
  function updateBar(){ var b = document.getElementById("nvrBar"); if (!b) return; var tmp = document.createElement("div"); tmp.innerHTML = bar(); b.replaceWith(tmp.firstChild); }
  function markBusy(on){ var b = HOST && HOST.querySelector(".nvr-body"); if (b) b.classList.toggle("is-busy", !!on); }
  function paintExplorer(){
    var ex = document.getElementById("nvrExplorer"); if (!ex) { paint(); return; }
    var focusId = document.activeElement ? document.activeElement.id : "", caret = focusId === "nvrQ" ? document.activeElement.selectionStart : null;
    var tmp = document.createElement("div"); tmp.innerHTML = explorer(); ex.replaceWith(tmp.firstChild);
    HOST.querySelectorAll(".nvr-ct").forEach(function(b){ b.classList.toggle("is-on", b.getAttribute("data-city") === S.city); });
    if (focusId) { var el = document.getElementById(focusId); if (el) { el.focus(); if (caret != null) try{ el.setSelectionRange(caret, caret); }catch(e){} } }
  }
  function countUp(){
    if (S.counted || RM || document.hidden) { S.counted = true; return; }
    S.counted = true;
    var els = HOST.querySelectorAll(".nvr-kv[data-count]");
    els.forEach(function(el){
      var target = Number(el.getAttribute("data-count")), fmt = el.getAttribute("data-fmt"), final = el.innerHTML;
      if (!isFinite(target) || el.getAttribute("data-count") === "" || target <= 0) return;
      var t0 = performance.now(), D = 650;
      (function step(t){
        var k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3), v = target * e;
        if (k >= 1 || !el.isConnected) { el.innerHTML = final; return; }
        el.textContent = fmt === "rs" ? rs(v) : fmt === "pct" ? Math.round(v) + "%" : num(Math.round(v));
        requestAnimationFrame(step);
      })(t0);
    });
  }

  /* ---------------------------------------------------------- exports */
  function exportCsv(){
    var list = filtered();
    var head = ["AWB","Booked","Customer","Phone","City","Status","COD","Delivery charge","Delivered at","Time"];
    var lines = [head.map(B.csvCell).join(",")].concat(list.map(function(p){
      return [p.awb, p.date, p.consignee, p.phone, p.city, B.statusLabel(p.status), p.cod, p.fee,
              p.deliveredAt ? new Date(p.deliveredAt).toLocaleString("en-GB", { timeZone:TZ }) : "", B.ageText(p)].map(B.csvCell).join(",");
    }));
    var R = range(), name = "novax-report-" + (R.a || "all") + "-to-" + R.b + ".csv";
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type:"text/csv" })); a.download = name; a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
    B.toast(list.length + " parcel" + (list.length === 1 ? "" : "s") + " exported" + (S.partial ? " — offline, only what this page had loaded." : "."), S.partial ? "error" : "success");
  }
  function exportPdf(){
    var R = range(), m = metrics(S.rows || []), cs = cityStats(S.rows), list = filtered();
    var box = function(l, v){ return '<td style="padding:10px 12px;border:1px solid #ddd"><div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.04em">' + l + '</div><div style="font-size:18px;font-weight:700;margin-top:4px">' + v + '</div></td>'; };
    var html = '<style>#printStage thead{display:table-header-group}#printStage tr{break-inside:avoid;page-break-inside:avoid}</style>' +
      '<div style="font-family:system-ui,sans-serif;color:#000;background:#fff;padding:24px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #0c7c59;padding-bottom:10px;margin-bottom:16px"><div><div style="font-size:20px;font-weight:800">' + esc(B.clientName()) + '</div><div style="color:#555">NovaX delivery report · ' + esc(rangeLabel(R.a, R.b)) + '</div></div><div style="color:#0c7c59;font-weight:800">NovaX Logistics</div></div>' +
      '<table style="width:100%;border-collapse:collapse;margin-bottom:14px"><tr>' + box("Parcels booked", num(m.total)) + box("Delivery success", m.rate == null ? "—" : m.rate + "%") + box("Delivered COD", rs(m.cod.delivered)) + box("Typical delivery time", durLabel(m.median)) + '</tr><tr>' +
        box("Delivery charges", rs(m.fees)) + box("Yours after charges", rs(Math.max(0, m.net))) + box("COD on the way", rs(m.cod.moving)) + box("Not collected", rs(m.cod.lost)) + '</tr></table>' +
      (cs.length ? '<h3 style="margin:16px 0 6px">Cities</h3><table style="width:100%;border-collapse:collapse" border="1" cellpadding="6"><thead><tr><th align="left">City</th><th>Parcels</th><th>Delivered</th><th>Success</th><th>Typical time</th><th align="right">Collected</th></tr></thead>' +
        cs.map(function(c){ return '<tr><td>' + esc(c.city) + '</td><td align="center">' + c.total + '</td><td align="center">' + c.delivered + '</td><td align="center">' + (c.rate == null ? "—" : c.rate + "%") + '</td><td align="center">' + durLabel(c.med) + '</td><td align="right">' + rs(c.cod) + '</td></tr>'; }).join("") + '</table>' : "") +
      '<h3 style="margin:16px 0 6px">Parcels (' + list.length + ')</h3><table style="width:100%;border-collapse:collapse;font-size:12px" border="1" cellpadding="5"><thead><tr><th align="left">AWB</th><th>Booked</th><th align="left">Customer</th><th align="left">City</th><th align="left">Status</th><th align="right">COD</th><th align="right">Fee</th></tr></thead>' +
        list.map(function(p){ return '<tr><td>' + esc(p.awb) + '</td><td>' + esc(dLabel(p.date)) + '</td><td>' + esc(p.consignee) + '</td><td>' + esc(p.city) + '</td><td>' + esc(B.statusLabel(p.status)) + '</td><td align="right">' + rs(p.cod) + '</td><td align="right">' + rs(p.fee) + '</td></tr>'; }).join("") +
        '<tr><td colspan="5"><b>Total</b></td><td align="right"><b>' + rs(list.reduce(function(s, p){ return s + p.cod; }, 0)) + '</b></td><td align="right"><b>' + rs(list.reduce(function(s, p){ return s + p.fee; }, 0)) + '</b></td></tr></table>' +
      '<p style="color:#666;font-size:11px;margin-top:14px">Generated ' + esc(new Date().toLocaleString("en-GB", { timeZone:TZ })) + ' (Pakistan time). Figures cover parcels booked in the period shown.</p></div>';
    if (!B.printHtml(html)) B.toast("Could not open the print view.", "error");
  }

  /* ------------------------------------------------------------ events */
  var qTimer = null;
  function wire(){
    HOST.addEventListener("click", function(e){
      var t = e.target.closest("button, [data-awb]"); if (!t || !HOST.contains(t)) return;
      if (t.id === "nvrExportBtn") { S.exportOpen = !S.exportOpen; var mn = document.getElementById("nvrExportMenu"); if (mn) mn.hidden = !S.exportOpen; t.setAttribute("aria-expanded", S.exportOpen); return; }
      if (t.hasAttribute("data-export")) { S.exportOpen = false; var mm = document.getElementById("nvrExportMenu"); if (mm) mm.hidden = true; if (t.getAttribute("data-export") === "csv") exportCsv(); else exportPdf(); return; }
      if (t.hasAttribute("data-period")) { var p = t.getAttribute("data-period"); if (p === S.period && p !== "custom") return; S.period = p; remember(); updateBar(); load(true); return; }
      if (t.hasAttribute("data-go")) { B.showTab(t.getAttribute("data-go")); return; }
      if (t.hasAttribute("data-city")) { var c = t.getAttribute("data-city"); S.city = S.city === c ? "" : c; S.shown = 50; paintExplorer(); jump(); return; }
      if (t.hasAttribute("data-group")) { S.group = t.getAttribute("data-group"); S.shown = 50; paintExplorer(); if (t.classList.contains("nvr-link")) jump(); return; }
      if (t.hasAttribute("data-search")) { S.q = t.getAttribute("data-search"); S.group = "all"; S.city = ""; paintExplorer(); jump(); return; }
      if (t.hasAttribute("data-ins")) {
        var a = (INS[Number(t.getAttribute("data-ins"))] || {}).act || {};
        if (a.tab) { B.showTab(a.tab); return; }
        if (a.scroll) { var el = document.getElementById(a.scroll); if (el) el.scrollIntoView({ behavior:RM ? "auto" : "smooth", block:"start" }); return; }
        if (a.group) S.group = a.group; if (a.city != null) S.city = a.city; if (a.sort) S.sort = a.sort; S.q = ""; S.shown = 50;
        paintExplorer(); jump(); return;
      }
      if (t.id === "nvrClear" || t.id === "nvrClear2") { S.q = ""; S.city = ""; S.group = "all"; S.shown = 50; paintExplorer(); return; }
      if (t.id === "nvrMore") { S.shown += 50; paintExplorer(); return; }
      if (t.hasAttribute("data-awb")) { openAwb(t.getAttribute("data-awb")); return; }
    });
    HOST.addEventListener("keydown", function(e){
      var r = e.target.closest && e.target.closest(".nvr-r[data-awb]");
      if (r && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openAwb(r.getAttribute("data-awb")); }
    });
    HOST.addEventListener("input", function(e){
      if (e.target.id === "nvrQ") { clearTimeout(qTimer); var v = e.target.value; qTimer = setTimeout(function(){ S.q = v; S.shown = 50; paintExplorer(); }, 140); }
    });
    HOST.addEventListener("change", function(e){
      var id = e.target.id;
      if (id === "nvrCompare") { S.compare = e.target.checked; remember(); load(true); }
      else if (id === "nvrCity") { S.city = e.target.value; S.shown = 50; paintExplorer(); }
      else if (id === "nvrSort") { S.sort = e.target.value; paintExplorer(); }
      else if (id === "nvrFrom" || id === "nvrTo") {
        var f = document.getElementById("nvrFrom"), to = document.getElementById("nvrTo");
        if (f && to && f.value && to.value) { S.from = f.value; S.to = to.value; remember(); load(true); }
      }
    });
    document.addEventListener("click", function(e){
      if (!S.exportOpen) return;
      if (e.target.closest && e.target.closest(".nvr-export")) return;
      S.exportOpen = false; var mn = document.getElementById("nvrExportMenu"); if (mn) mn.hidden = true;
      var b = document.getElementById("nvrExportBtn"); if (b) b.setAttribute("aria-expanded", "false");
    });
    /* Capture phase on window, so on this tab "/" searches the parcels here
       instead of also opening the portal-wide command palette. On every
       other tab the palette keeps "/" exactly as before. */
    window.addEventListener("keydown", function(e){
      if (!visible()) return;
      if (e.key === "Escape" && S.exportOpen) { S.exportOpen = false; var mn = document.getElementById("nvrExportMenu"); if (mn) mn.hidden = true; var eb = document.getElementById("nvrExportBtn"); if (eb) { eb.setAttribute("aria-expanded", "false"); eb.focus(); } return; }
      var t = e.target || {};
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(input|textarea|select)$/i.test(t.tagName || "") && !t.isContentEditable) {
        var q = document.getElementById("nvrQ");
        if (q) { e.preventDefault(); e.stopPropagation(); q.focus(); q.scrollIntoView({ block:"center", behavior:RM ? "auto" : "smooth" }); }
      }
    }, true);
    var rz = null, lastW = window.innerWidth;
    window.addEventListener("resize", function(){
      if (window.innerWidth === lastW) return; lastW = window.innerWidth;
      clearTimeout(rz); rz = setTimeout(function(){ if (visible() && S.rows && S.rows.length >= 10) drawChart(buckets(S.rows, range())); }, 150);
    });
  }
  function jump(){ var ex = document.getElementById("nvrExplorer"); if (ex) ex.scrollIntoView({ behavior:RM ? "auto" : "smooth", block:"start" }); }
  function visible(){ return !!(HOST && HOST.offsetParent); }
  function openAwb(awb){ var p = (S.rows || []).filter(function(x){ return x.awb === awb; })[0]; if (p) B.openParcel(p); }

  /* ------------------------------------------------------------ styles */
  var CSS = [
    '.nvr{--nvr-r:16px;display:block;color:var(--nvu-ink)}',
    '.nvr-bar{position:sticky;top:var(--nvr-top,0px);z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:10px 0 12px;background:var(--nvr-barbg,var(--nvu-bg));border-bottom:1px solid transparent;transition:border-color .2s}',
    '.nvr-bar.is-stuck{border-bottom-color:var(--nvu-line)}',
    '.nvr-chips{display:flex;gap:6px;flex-wrap:wrap;flex:1 1 auto;min-width:0}',
    '.nvr-chip{appearance:none;border:1px solid var(--nvu-line);background:var(--nvu-bg-2);color:var(--nvu-ink-2);font:inherit;font-size:13px;font-weight:650;height:36px;padding:0 14px;border-radius:999px;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s,border-color .15s}',
    '.nvr-chip:hover{color:var(--nvu-ink);border-color:var(--nvu-line-2)}',
    '.nvr-chip.is-on{background:var(--nvu-ink);color:var(--nvu-bg);border-color:var(--nvu-ink)}',
    '.nvr-chip:focus-visible,.nvr-btn:focus-visible,.nvr-tab:focus-visible,.nvr-r:focus-visible,.nvr-ct:focus-visible,.nvr-link:focus-visible{outline:2px solid var(--nvu-accent);outline-offset:2px}',
    '.nvr-bar-r{display:flex;align-items:center;gap:10px;margin-left:auto}',
    '.nvr-toggle{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:650;color:var(--nvu-ink-2);cursor:pointer;user-select:none;min-height:36px}',
    '.nvr-toggle input{position:absolute;opacity:0;width:1px;height:1px}',
    '.nvr-toggle span{width:34px;height:20px;border-radius:999px;background:var(--nvu-track);border:1px solid var(--nvu-line-2);position:relative;transition:background .2s}',
    '.nvr-toggle span::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--nvu-ink-2);transition:transform .2s,background .2s}',
    '.nvr-toggle input:checked+span{background:var(--nvu-accent);border-color:var(--nvu-accent)}',
    '.nvr-toggle input:checked+span::after{transform:translateX(14px);background:var(--nvu-accent-ink)}',
    '.nvr-toggle input:focus-visible+span{outline:2px solid var(--nvu-accent);outline-offset:2px}',
    '.nvr-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--nvu-line-2);background:var(--nvu-bg-2);color:var(--nvu-ink);font:inherit;font-size:13px;font-weight:700;cursor:pointer}',
    '.nvr-btn:hover{border-color:var(--nvu-ink-3)}',
    '.nvr-btn.is-primary{background:var(--nvu-accent);color:var(--nvu-accent-ink);border-color:var(--nvu-accent)}',
    '.nvr-btn svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.6}',
    '.nvr-export{position:relative}',
    '.nvr-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;min-width:260px;background:var(--nvu-bg);border:1px solid var(--nvu-line-2);border-radius:14px;box-shadow:0 18px 40px rgba(0,0,0,.28);padding:6px}',
    '.nvr-menu button{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;appearance:none;border:0;background:transparent;color:var(--nvu-ink);font:inherit;padding:10px 12px;border-radius:10px;cursor:pointer}',
    '.nvr-menu button:hover,.nvr-menu button:focus-visible{background:var(--nvu-bg-2);outline:none}',
    '.nvr-menu b{font-size:13.5px}.nvr-menu span{font-size:12px;color:var(--nvu-ink-2)}',
    '.nvr-custom{display:flex;gap:10px;flex-wrap:wrap;width:100%}',
    '.nvr-custom label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:700;color:var(--nvu-ink-2);text-transform:uppercase;letter-spacing:.04em}',
    '.nvr-custom input{height:38px;border-radius:10px;border:1px solid var(--nvu-line-2);background:var(--nvu-bg-2);color:var(--nvu-ink);padding:0 10px;font:inherit;font-size:16px}',
    '.nvr-body{transition:opacity .2s}.nvr-body.is-busy{opacity:.55;pointer-events:none}',
    '.nvr-scope{margin:4px 0 14px;font-size:13.5px;color:var(--nvu-ink-2)}.nvr-scope b{color:var(--nvu-ink)}',
    '.nvr-muted{color:var(--nvu-ink-3);font-weight:600}.nvr-small{font-size:12px}.nvr-warn{color:var(--nvu-warn-fg);font-weight:700}',
    '.nvr-card{background:var(--nvu-bg-2);border:1px solid var(--nvu-line);border-radius:var(--nvr-r);padding:18px;min-width:0}',
    '.nvr-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px}',
    '.nvr-kpi{position:relative;overflow:hidden;display:flex;flex-direction:column;gap:6px;padding-bottom:40px}',
    '.nvr-kl{font-size:11.5px;font-weight:750;letter-spacing:.06em;text-transform:uppercase;color:var(--nvu-ink-2)}',
    '.nvr-kv{font-size:28px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}',
    '.nvr-kd{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:12.5px}',
    '.nvr-d{font-weight:750;font-variant-numeric:tabular-nums}.nvr-d.is-good{color:var(--nvu-good-fg)}.nvr-d.is-bad{color:var(--nvu-bad-fg)}.nvr-d.is-flat{color:var(--nvu-ink-2)}',
    '.nvr-dvs{color:var(--nvu-ink-3)}',
    '.nvr-spark{position:absolute;left:18px;right:18px;bottom:12px;width:calc(100% - 36px);height:26px;fill:none;stroke:var(--nvu-accent);stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round;opacity:.9;vector-effect:non-scaling-stroke}',
    '.nvr-spark polyline{vector-effect:non-scaling-stroke}',
    '.nvr-ins{display:grid;gap:8px;margin-bottom:12px}',
    '.nvr-in{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;border:1px solid var(--nvu-line);background:var(--nvu-bg-2)}',
    '.nvr-in p{margin:0;flex:1;font-size:13.5px;line-height:1.45;color:var(--nvu-ink-2)}.nvr-in p b{color:var(--nvu-ink)}',
    '.nvr-in-i{flex:0 0 30px;height:30px;border-radius:10px;display:grid;place-items:center;font-size:13px;font-weight:800}',
    '.nvr-in.is-bad{border-color:var(--nvu-bad-ln)}.nvr-in.is-bad .nvr-in-i{background:var(--nvu-bad-bg);color:var(--nvu-bad-fg)}',
    '.nvr-in.is-warn{border-color:var(--nvu-warn-ln)}.nvr-in.is-warn .nvr-in-i{background:var(--nvu-warn-bg);color:var(--nvu-warn-fg)}',
    '.nvr-in.is-good .nvr-in-i{background:var(--nvu-good-bg);color:var(--nvu-good-fg)}.nvr-in.is-info .nvr-in-i{background:var(--nvu-info-bg);color:var(--nvu-info-fg)}',
    '.nvr-link{appearance:none;border:0;background:none;color:var(--nvu-accent);font:inherit;font-size:13px;font-weight:750;cursor:pointer;padding:6px 2px;white-space:nowrap;min-height:32px}',
    '.nvr-link:hover{text-decoration:underline}',
    '.nvr-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:12px;margin-bottom:12px}',
    '.nvr-hrow{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;flex-wrap:wrap}',
    '.nvr-h{margin:0;font-size:15px;font-weight:800;letter-spacing:-.01em}.nvr-h5{margin:18px 0 8px;font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:.05em;color:var(--nvu-ink-2)}',
    '.nvr-sub{margin:0 0 14px;font-size:13px;color:var(--nvu-ink-2)}',
    '.nvr-empty{margin:10px 0 0;font-size:13.5px;color:var(--nvu-ink-2)}.nvr-empty.is-good{color:var(--nvu-good-fg);font-weight:650}',
    '.nvr-stack{display:flex;height:14px;border-radius:999px;overflow:hidden;background:var(--nvu-track);gap:2px}',
    '.nvr-stack-sm{height:10px}',
    '.nvr-seg{display:block;height:100%;min-width:3px}',
    '.is-good.nvr-seg,.nvr-legend i.is-good,.nvr-keys i.is-good{background:var(--nvu-accent)}',
    '.is-info.nvr-seg,.nvr-legend i.is-info,.nvr-keys i.is-info{background:#4bb8e8}',
    '.is-bad.nvr-seg,.nvr-legend i.is-bad,.nvr-keys i.is-bad{background:#e0604b}',
    '.is-warn.nvr-seg,.nvr-keys i.is-warn{background:#e8b64c}',
    '.is-neutral.nvr-seg,.nvr-keys i.is-neutral{background:var(--nvu-ink-3);opacity:.55}',
    '.is-muted.nvr-seg{background:var(--nvu-line-2)}',
    '.nvr-legend{display:grid;gap:8px;margin-top:14px}',
    '.nvr-legend div{display:grid;grid-template-columns:10px 1fr auto 86px;align-items:center;gap:10px;font-size:13.5px}',
    '.nvr-legend i{width:10px;height:10px;border-radius:3px}.nvr-legend b{font-variant-numeric:tabular-nums}.nvr-legend em{font-style:normal;font-size:12px;color:var(--nvu-ink-3);text-align:right}',
    '.nvr-sum{display:flex;align-items:stretch;gap:8px;margin-top:16px;padding-top:14px;border-top:1px dashed var(--nvu-line-2);flex-wrap:wrap}',
    '.nvr-sum div{display:flex;flex-direction:column;gap:2px;flex:1 1 90px}.nvr-sum span{font-size:11.5px;color:var(--nvu-ink-2);font-weight:650}.nvr-sum b{font-size:16px;font-variant-numeric:tabular-nums}',
    '.nvr-sum .nvr-op{flex:0 0 auto;align-self:center;font-size:18px;color:var(--nvu-ink-3);font-weight:700}',
    '.nvr-sum .is-net b{color:var(--nvu-good-fg)}',
    '.nvr-keys{display:flex;gap:12px;font-size:12px;color:var(--nvu-ink-2);font-weight:650}.nvr-keys span{display:inline-flex;align-items:center;gap:6px}',
    '.nvr-keys i{width:10px;height:10px;border-radius:3px;display:inline-block}.nvr-keys-wrap{flex-wrap:wrap;margin-top:12px}',
    'i.k-book{background:var(--nvu-line-2);width:10px;height:10px;border-radius:3px;display:inline-block}i.k-del{background:var(--nvu-accent);width:14px;height:3px;border-radius:2px;display:inline-block}',
    '.nvr-trend{position:relative}.nvr-chart{position:relative;width:100%;margin-top:8px}.nvr-chart svg{display:block;width:100%;height:auto;touch-action:pan-y}',
    '.nvr-chart .g{stroke:var(--nvu-line);stroke-width:1}.nvr-chart .t{fill:var(--nvu-ink-3);font-size:10.5px;font-weight:600}',
    '.nvr-chart .b{fill:var(--nvu-line-2)}.nvr-chart .l{fill:none;stroke:var(--nvu-accent);stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round}',
    '.nvr-chart .a{fill:var(--nvu-accent);opacity:.1}.nvr-chart .cur{stroke:var(--nvu-ink-3);stroke-dasharray:3 3}',
    '.nvr-tip{position:absolute;top:44px;z-index:3;pointer-events:none;background:var(--nvu-bg);border:1px solid var(--nvu-line-2);border-radius:10px;padding:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:3px;box-shadow:0 10px 24px rgba(0,0,0,.2);white-space:nowrap}',
    '.nvr-tip span{display:flex;align-items:center;gap:6px;color:var(--nvu-ink-2)}',
    '.nvr-tip[hidden],.nvr-menu[hidden]{display:none!important}',
    '.nvr-ct-head{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1.4fr) 70px 70px 100px;gap:12px;padding:6px 10px;font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.05em;color:var(--nvu-ink-3)}',
    '.nvr-ct{appearance:none;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1.4fr) 70px 70px 100px;gap:12px;align-items:center;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:inherit;font:inherit;padding:10px;border-radius:12px;cursor:pointer}',
    '.nvr-ct:hover{background:var(--nvu-bg)}.nvr-ct.is-on{background:var(--nvu-bg);border-color:var(--nvu-accent)}',
    '.nvr-ct-n{display:flex;flex-direction:column;min-width:0}.nvr-ct-n b{font-size:14px}.nvr-ct-n em{font-style:normal;font-size:12px;color:var(--nvu-ink-3)}',
    '.nvr-ct-v{font-size:13.5px;font-weight:700;font-variant-numeric:tabular-nums}.nvr-ct-v em{display:none}',
    '.nvr-reasons{display:grid;gap:10px;margin-top:8px}',
    '.nvr-rs{display:grid;grid-template-columns:150px 1fr 32px;align-items:center;gap:10px;font-size:13.5px}',
    '.nvr-rs-bar{height:8px;border-radius:999px;background:var(--nvu-track);overflow:hidden}.nvr-rs-bar i{display:block;height:100%;background:#e0604b;border-radius:999px}',
    '.nvr-rs b{text-align:right;font-variant-numeric:tabular-nums}',
    '.nvr-rep{display:grid;gap:6px}',
    '.nvr-rep-r{appearance:none;display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--nvu-line);background:var(--nvu-bg);color:inherit;font:inherit;text-align:left;padding:10px 12px;border-radius:12px;cursor:pointer}',
    '.nvr-rep-r:hover{border-color:var(--nvu-line-2)}.nvr-rep-r span:first-child{display:flex;flex-direction:column;min-width:0}.nvr-rep-r em{font-style:normal;font-size:12px;color:var(--nvu-ink-3);font-variant-numeric:tabular-nums}',
    '.nvr-foot{margin:8px 0 0;font-size:12px;color:var(--nvu-ink-3)}',
    '.nvr-pill{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap;border:1px solid transparent}',
    '.nvr-pill.is-delivered{background:var(--nvu-good-bg);color:var(--nvu-good-fg);border-color:var(--nvu-good-ln)}',
    '.nvr-pill.is-moving{background:var(--nvu-info-bg);color:var(--nvu-info-fg);border-color:var(--nvu-info-ln)}',
    '.nvr-pill.is-booked{background:var(--nvu-neutral-bg);color:var(--nvu-neutral-fg);border-color:var(--nvu-neutral-ln)}',
    '.nvr-pill.is-problem{background:var(--nvu-warn-bg);color:var(--nvu-warn-fg);border-color:var(--nvu-warn-ln)}',
    '.nvr-pill.is-returned,.nvr-pill.is-bad{background:var(--nvu-bad-bg);color:var(--nvu-bad-fg);border-color:var(--nvu-bad-ln)}',
    '.nvr-pill.is-cancelled{background:transparent;color:var(--nvu-ink-3);border-color:var(--nvu-line-2)}',
    '.nvr-exp{margin-bottom:12px}',
    '.nvr-tools{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 10px}',
    '.nvr-search{position:relative;flex:1 1 260px;min-width:0}',
    '.nvr-search svg{position:absolute;left:12px;top:50%;width:16px;height:16px;transform:translateY(-50%);fill:none;stroke:var(--nvu-ink-3);stroke-width:1.8;stroke-linecap:round}',
    '.nvr-search input{width:100%;box-sizing:border-box;height:42px;border-radius:12px;border:1px solid var(--nvu-line-2);background:var(--nvu-bg);color:var(--nvu-ink);padding:0 40px 0 36px;font:inherit;font-size:16px}',
    '.nvr-search input:focus{outline:none;border-color:var(--nvu-accent);box-shadow:0 0 0 3px var(--nvu-good-bg)}',
    '.nvr-search kbd{position:absolute;right:10px;top:50%;transform:translateY(-50%);font:600 11px/1 ui-monospace,monospace;color:var(--nvu-ink-3);border:1px solid var(--nvu-line-2);border-radius:6px;padding:3px 6px}',
    '.nvr-tools select{height:42px;border-radius:12px;border:1px solid var(--nvu-line-2);background:var(--nvu-bg);color:var(--nvu-ink);padding:0 12px;font:inherit;font-size:16px;flex:0 1 auto}',
    '.nvr-tabs{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px;margin-bottom:8px}.nvr-tabs::-webkit-scrollbar{display:none}',
    '.nvr-tab{appearance:none;flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 12px;border-radius:10px;border:1px solid var(--nvu-line);background:transparent;color:var(--nvu-ink-2);font:inherit;font-size:13px;font-weight:700;cursor:pointer}',
    '.nvr-tab span{font-size:11.5px;font-weight:750;min-width:20px;height:20px;padding:0 6px;border-radius:999px;display:inline-grid;place-items:center;background:var(--nvu-track);color:var(--nvu-ink-2);font-variant-numeric:tabular-nums}',
    '.nvr-tab.is-on{background:var(--nvu-ink);color:var(--nvu-bg);border-color:var(--nvu-ink)}.nvr-tab.is-on span{background:rgba(127,127,127,.28);color:inherit}',
    '.nvr-filt{margin:0 0 8px;font-size:13px;color:var(--nvu-ink-2)}',
    '.nvr-list{display:flex;flex-direction:column}',
    '.nvr-r{display:grid;grid-template-columns:150px 70px minmax(0,1.4fr) minmax(0,1.2fr) 96px 72px minmax(0,1fr);gap:12px;align-items:center;padding:11px 10px;border-top:1px solid var(--nvu-line);font-size:13.5px;cursor:pointer;border-radius:0}',
    '.nvr-r:hover{background:var(--nvu-bg)}',
    '.nvr-head{cursor:default;border-top:0;font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.05em;color:var(--nvu-ink-3);padding-top:4px;padding-bottom:6px}.nvr-head:hover{background:none}',
    '.nvr-c{min-width:0}.c-awb{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.c-awb b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;letter-spacing:.02em}',
    '.c-who{display:flex;flex-direction:column}.c-who b{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.c-who em{font-style:normal;font-size:12px;color:var(--nvu-ink-3)}',
    '.c-cod,.c-fee{font-variant-numeric:tabular-nums;text-align:right}.c-cod em{font-style:normal;color:var(--nvu-ink-3);font-size:12px}',
    '.c-date,.c-time{color:var(--nvu-ink-2);font-size:12.5px}.c-d2{display:none;font-style:normal}',
    '.nvr-head .c-cod,.nvr-head .c-fee{text-align:right}',
    '.nvr-more{appearance:none;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:10px;height:44px;border-radius:12px;border:1px dashed var(--nvu-line-2);background:transparent;color:var(--nvu-ink);font:inherit;font-weight:700;font-size:13.5px;cursor:pointer}',
    '.nvr-more span{color:var(--nvu-ink-3);font-weight:600}',
    '.nvr-zero{text-align:center;padding:36px 18px}.nvr-zero h4{margin:0 0 6px;font-size:17px}.nvr-zero p{margin:0 0 16px;color:var(--nvu-ink-2)}',
    '.nvr-sk{display:block;height:12px;border-radius:6px;background:linear-gradient(90deg,var(--nvu-track),var(--nvu-sheen),var(--nvu-track));background-size:200% 100%;animation:nvrSk 1.3s linear infinite;margin-bottom:8px}',
    '.nvr-sk-big{height:28px;width:70%;margin:6px 0 10px}.nvr-sk-chart{height:170px;margin-top:14px}',
    '@keyframes nvrSk{from{background-position:200% 0}to{background-position:-200% 0}}',
    '@media (max-width:1100px){.nvr-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.nvr-grid{grid-template-columns:minmax(0,1fr)}}',
    '@media (max-width:900px){',
      '.nvr-head{display:none}',
      '.nvr-r{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"awb st" "who cod" "time fee";gap:4px 10px;padding:12px 4px}',
      '.c-awb{grid-area:awb}.c-st{grid-area:st;justify-self:end}.c-who{grid-area:who}.c-cod{grid-area:cod;font-weight:750}.c-fee{grid-area:fee;font-size:12px;color:var(--nvu-ink-3)}.c-fee::before{content:"Fee "}.c-time{grid-area:time}.c-date{display:none}.c-d2{display:inline}',
      '.nvr-ct-head{display:none}',
      '.nvr-ct{grid-template-columns:auto auto auto minmax(0,1fr);grid-template-areas:"n n n n" "bar bar bar bar";gap:8px 26px;padding:12px 8px}',
      '.nvr-ct-n{grid-area:n;flex-direction:row;align-items:baseline;gap:8px}.nvr-ct .nvr-stack{grid-area:bar}',
      '.nvr-ct-v{display:flex;flex-direction:column}.nvr-ct-v em{display:block;font-style:normal;font-size:11px;font-weight:650;color:var(--nvu-ink-3)}',
    '}',
    '@media (max-width:900px){.nvr-chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;flex:1 1 100%;-webkit-mask-image:linear-gradient(90deg,#000 88%,transparent);mask-image:linear-gradient(90deg,#000 88%,transparent);padding-right:24px}.nvr-chips::-webkit-scrollbar{display:none}.nvr-chip{flex:0 0 auto}}',
    '@media (max-width:640px){',
      '.nvr-bar-r{width:100%;justify-content:space-between;margin-left:0}',
      '.nvr-menu{right:0;left:auto;min-width:min(300px,calc(100vw - 32px))}',
      '.nvr-card{padding:15px;border-radius:14px}.nvr-kpis{gap:10px}.nvr-kv{font-size:22px}.nvr-kpi{padding-bottom:36px}',
      '.nvr-kl{font-size:10.5px}.nvr-dvs{display:none}.nvr-kd .nvr-dvs:only-child{display:inline}',
      '.nvr-legend div{grid-template-columns:10px 1fr auto;}.nvr-legend em{display:none}',
      '.nvr-sum{display:grid;gap:8px}.nvr-sum .nvr-op{display:none}.nvr-sum div{flex-direction:row;justify-content:space-between;align-items:baseline}.nvr-sum span{font-size:13px}.nvr-sum .is-minus span::before{content:"\\2212  "}.nvr-sum .is-net{border-top:1px solid var(--nvu-line);padding-top:8px}.nvr-sum .is-net span::before{content:"=  "}',
      '.nvr-rs{grid-template-columns:120px 1fr 28px;font-size:13px}',
      '.nvr-in{align-items:flex-start;flex-wrap:wrap;row-gap:2px}.nvr-in p{flex:1 1 calc(100% - 42px)}.nvr-in .nvr-link{margin-left:42px;padding:2px 0 0;min-height:30px}',
      '.nvr-search kbd{display:none}.nvr-tools select{flex:1 1 40%}',
    '}',
    '@media (prefers-reduced-motion:reduce){.nvr-sk{animation:none}.nvr-body{transition:none}}'
  ].join("\n");

  function stickyTop(){
    /* Sit directly below whatever the portal keeps pinned to the top at this
       width (the sticky app header, and the fixed banner in demo mode).
       A sticky element pins at its CSS top, so its pinned bottom is
       top + height -- measured that way it is right before the page scrolls,
       which is when this runs. */
    var bottom = 0;
    document.querySelectorAll("header, .topbar, .nvd-bar, body > div, body > nav").forEach(function(h){
      if (h.offsetParent === null && getComputedStyle(h).position !== "fixed") return;
      var cs = getComputedStyle(h), ht = h.offsetHeight;
      if (!ht || ht > 180) return;
      if (cs.position === "sticky") bottom = Math.max(bottom, (parseFloat(cs.top) || 0) + ht);
      else if (cs.position === "fixed") { var r = h.getBoundingClientRect(); if (r.top <= 1 && r.width > window.innerWidth * 0.6) bottom = Math.max(bottom, Math.round(r.bottom)); }
    });
    if (HOST) HOST.style.setProperty("--nvr-top", Math.round(bottom) + "px");
    /* the bar is opaque so rows scroll under it cleanly; give it the colour
       of whatever it actually sits on, which differs between the themes */
    if (HOST) {
      var el = HOST.parentElement, bg = "";
      while (el && el !== document.documentElement) {
        var c = getComputedStyle(el).backgroundColor;
        if (c && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c)) { bg = c; break; }
        el = el.parentElement;
      }
      if (!bg) bg = getComputedStyle(document.body).backgroundColor;
      HOST.style.setProperty("--nvr-barbg", bg || "");
    }
  }

  /* ------------------------------------------------------------- api */
  var mounted = false;
  window.NovaXReports = {
    open: function(host){
      B = window.__nvRepBridge; if (!B || !host) return;
      if (!document.getElementById("nvrCss")) { var st = document.createElement("style"); st.id = "nvrCss"; st.textContent = CSS; document.head.appendChild(st); }
      if (!mounted || HOST !== host) { HOST = host; HOST.classList.add("nvr"); wire(); mounted = true; }
      stickyTop();
      if (!S.rows) paint();
      load(false);
      var bar = function(){ var b = document.getElementById("nvrBar"); if (b) b.classList.toggle("is-stuck", b.getBoundingClientRect().top <= parseFloat(getComputedStyle(HOST).getPropertyValue("--nvr-top") || 0) + 1 && window.scrollY > 40); };
      if (!window.__nvrScroll) {
        window.__nvrScroll = true;
        window.addEventListener("scroll", function(){ if (visible()) bar(); }, { passive:true });
        window.addEventListener("resize", stickyTop);
        try{ new MutationObserver(function(){ setTimeout(stickyTop, 60); setTimeout(stickyTop, 700); setTimeout(stickyTop, 1500); }).observe(document.documentElement, { attributes:true, attributeFilter:["data-theme","class"] }); }catch(e){}
      }
    },
    refresh: function(){ return load(true); },
    _state: S
  };
})();
