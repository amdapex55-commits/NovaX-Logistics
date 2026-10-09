/* Local-only tool, never published. It measures every piece of text against
   the box it sits in, on the portal's demo started with names, addresses and
   amounts as long as the longest real ones (lengths measured on 9 Oct 2026:
   name 70, address 297, product 237, longest unbroken word 31).

   Written after a sentence ran out of its box in the parcel drawer and none of
   the existing checks could have seen it: they measured whether the page
   scrolled sideways, never whether text fitted its own box.

   Use: sh scripts/dev/make-stress-page.sh, then see that file.              */
(function(){
  var LONG_NAME = "Muhammad Abdul Rehman Chaudhry s/o Haji Ghulam Rasool Chaudhry Sahib";            // 70
  var LONG_ADDR = "House#123/B-Block-7,Street#45-A near Masjid-e-Noor opposite Government Girls Higher Secondary School, Mohallah Islamabad Colony, Chak No. 114 Janoobi, Tehsil Kot Addu, District Muzaffargarh, behind the old vegetable market second gali on the left after the petrol pump, Punjab, Pakistan 34050 call first";
  var LONG_CAT  = "3 x Premium embroidered lawn unstitched three piece suit with chiffon dupatta (maroon, bottle green, navy), 2 x gents wash and wear kameez shalwar fabric, 1 x kids party frock size 24, 6 x pure desi ghee sohan halwa tin 1kg fragile keep upright";
  var LONG_EXC  = "Customer says the parcel is opened and asked for refund";                          // 54
  var STATUSES = ["New booked","Collected by rider","Arrived at warehouse","Parcel now in transit",
    "Parcel received at destination","Parcel out for delivery","Delivered","Refused","Consignee not available",
    "Reattempt","Reassigned","Out of service area","Return to shipper","Ready for return","Return in transit",
    "Return received at origin","Return out for delivery","Parcel returned to consignee","Cancelled by client"];

  window.__stretch = function(D){
    if(!D || !D.tables || D.__stretched) return D; D.__stretched = true;
    var T = D.tables, R = D.rpcs, now = Date.now(), H = 3600000, DAY = 24*H;
    var iso = function(ms){ return new Date(ms).toISOString(); };
    T.clients[0].name = "Rehmatullah & Sons Wholesale Traders (Pvt) Ltd";
    T.clients[0].address = LONG_ADDR.slice(0,140);
    T.clients[0].wallet_balance = 1250000;
    var out = [];
    STATUSES.forEach(function(st, i){
      [0,1].forEach(function(longish){
        var n = 9100000 + i*2 + longish, awb = "N"+n;
        var bad = /Refused|not available|Out of service|Return|returned/.test(st);
        out.push({ id:"demo-p-"+awb, awb:awb, client_id:"demo-client", status:st,
          consignee: longish ? LONG_NAME : "Hina Raza", phone: longish ? "+92 300 0000"+(100+i) : "0300-0000"+(100+i),
          city: longish ? "Rawalpindi" : "Karachi", address: longish ? LONG_ADDR : "Flat 3B, Block 7, Gulshan-e-Iqbal, Karachi",
          cod_amount: longish ? 250000 : 3450, fee: longish ? 1585 : 225,
          exception: bad ? (longish ? LONG_EXC : "Refused at door") : (i%5===0 && longish ? LONG_EXC : null),
          booked_at: iso(now-(i+2)*DAY), updated_at: iso(now-(i%4+1)*30*H), status_since: iso(now-(i%4+1)*30*H),
          delivered_at: st==="Delivered" ? iso(now-6*H) : null,
          invoice_id: st==="Delivered" && !longish ? "demo-inv-1" : null, invoiced_at: st==="Delivered" && !longish ? iso(now-6*H) : null,
          rider_id: i>3 ? "demo-rider" : null, pricing_mode:null, distance_km:null, quoted_fee:null, rate_version:null,
          meta:{ weight: longish ? "12.5 kg" : "0.5 kg", service:"COD Standard", branch: longish ? "Rawalpindi / Islamabad Hub" : "Karachi Hub",
                 paymentMode:"COD", steps:null, risk: longish ? 82 : 0,
                 category: longish ? LONG_CAT : "Lawn suit", orderId: longish ? "#SHOPIFY-1000234567-EXCHANGE-02" : "",
                 referenceNo: longish ? "REF-2026-10-000123456789" : "", comments: longish ? LONG_ADDR.slice(60,260) : "" } });
      });
    });
    T.parcels = out.concat(T.parcels);
    T.wallet_ledger.unshift(
      { id:"demo-l-x1", client_id:"demo-client", entry_type:"admin_adjustment", amount:-1234567, affects_balance:true, status:"Debited",
        created_at:iso(now-2*H), note:"Correction for invoices INV-2610030d292, INV-2610041a7c3 and INV-2610052b9e1: COD collected after the invoice was made, less the return charges already billed, agreed with the merchant on the phone." },
      { id:"demo-l-x2", client_id:"demo-client", entry_type:"invoice_credit", amount:2345678, affects_balance:true, status:"Credited",
        reference_type:"invoice", reference_code:"INV-2610099ffff", created_at:iso(now-3*H), note:"Invoice INV-2610099ffff credited to wallet. Rs 2,345,678 now available to withdraw." });
    T.withdrawals.unshift(
      { id:"demo-wd-x1", client_id:"demo-client", amount:485300, fee:500, net:484800, iban:"PK40MEZN0000001123456702", speed:"instant", status:"Pending", created_at:iso(now-90*60000) },
      { id:"demo-wd-x2", client_id:"demo-client", amount:1250000, fee:100, net:1249900, iban:"PK40MEZN0000001123456702", speed:"12h", status:"Rejected", created_at:iso(now-30*H), note:LONG_EXC });
    T.novax_tickets.unshift(
      { id:"demo-t-x1", client_id:"demo-client", code:"TKT-2610-000123", subject:"Rider marked refused but the customer says nobody came and nobody called, please check the proof and send it again tomorrow before noon", status:"open", priority:"urgent", awb:"N9100015", sla_hours:24, created_at:iso(now-5*H), updated_at:iso(now-4*H) },
      { id:"demo-t-x2", client_id:"demo-client", code:"TKT-2610-000124", subject:"COD", status:"pending", priority:"normal", awb:"", sla_hours:24, created_at:iso(now-50*H), updated_at:iso(now-49*H) });
    T.novax_ticket_replies.push(
      { id:"demo-r-x1", ticket_id:"demo-t-x1", by_side:"client", by_name:T.clients[0].name, body:LONG_ADDR+" https://www.example.com/orders/1000234567/very/long/path/that/does/not/break/anywhere?token=abcdefghijklmnopqrstuvwxyz0123456789", created_at:iso(now-5*H) });
    T.staff_users = [
      { id:"s1", name:LONG_NAME, email:"muhammad.abdul.rehman.chaudhry.accounts@rehmatullah-and-sons-wholesale.com.pk", role:"Accounts", permissions:{}, status:"active", last_active_at:iso(now-2*H) },
      { id:"s2", name:"Ali", email:"a@b.pk", role:"Support", permissions:{}, status:"invited", last_active_at:null },
      { id:"s3", name:"Operations desk night shift", email:"ops.night@rehmatullah-and-sons-wholesale.com.pk", role:"Operations", permissions:{}, status:"disabled", last_active_at:iso(now-40*DAY) } ];
    R.client_wallet_summary = [{ available_balance:1250000, pending_payout:485300, paid_this_month:2345678, lifetime_withdrawn:12345678 }];
    var awbs = function(a, n){ var o = []; for(var k=0;k<n;k++) o.push("N"+(a+k)); return o.join(", "); };
    R.client_smart_insights = [
      { kind:"stuck_parcels", severity:"medium", title:"3 parcel(s) have not moved in 3 days", body:"No status change for over 72 hours: "+awbs(9100004,3)+".", action:"open_ticket" },
      { kind:"overdue", severity:"high", title:"15 parcel(s) are past 3 days with us", body:"Booked over 72 hours ago, still moving and not delivered yet: "+awbs(9100006,15)+". These are being scanned, so they do not show as stuck -- they are simply taking too long.", action:"open_ticket" },
      { kind:"uncollected", severity:"medium", title:"1 booking(s) still waiting for pickup", body:"Booked more than a day ago and not collected: N9100000.", action:"pickup" } ];
    R.client_wallet_incoming = [{ delivered_uninvoiced:1584900, parcels:214 }];
    R.client_pickup_locations_list = [{ id:"demo-loc", label:LONG_ADDR.slice(0,120), city:"Rawalpindi", is_default:true },
                                      { id:"demo-loc2", label:"Shop 14", city:"Karachi", is_default:false }];
    R.client_customer_replies = [
      { awb:"N9100011", choice:"wrong_address", note:LONG_ADDR.slice(0,200), at:iso(now-20*60000), status_then:"Parcel out for delivery" },
      { awb:"N9100015", choice:"call_first", note:null, at:iso(now-50*60000), status_then:"Refused" },
      { awb:"N9100017", choice:"tomorrow", note:null, at:iso(now-3*H), status_then:"Consignee not available" } ];
    try{ localStorage.removeItem; Object.keys(localStorage).forEach(function(k){ if(/^nvCustSeen:/.test(k)) localStorage.removeItem(k); }); }catch(e){}
    return D;
  };
  window.__stress = async function(){
    window.__stretch(window.__nvDemoData);
    if(window.__novaxReloadClientData) await window.__novaxReloadClientData();
    return window.__nvDemoData.tables.parcels.length;
  };
  /* stress.html loads this file before the portal: the sample data is
     stretched the moment the portal creates it, so the first paint has it. */
  if(window.__STRESS_FROM_START && !window.__stressHooked){
    window.__stressHooked = true;
    var store;
    Object.defineProperty(window, "__nvDemoData", { configurable:true,
      get:function(){ return store; }, set:function(v){ store = v; try{ window.__stretch(v); }catch(e){ console.error("stretch", e); } } });
  }

  function desc(el){
    var s = el.tagName.toLowerCase();
    if(el.id) s += "#"+el.id;
    else if(typeof el.className==="string" && el.className.trim()) s += "."+el.className.trim().split(/\s+/).slice(0,2).join(".");
    return s;
  }
  function chain(el){ var a=[], e=el; for(var i=0;i<4&&e&&e!==document.body;i++,e=e.parentElement) a.push(desc(e)); return a.join(" < "); }
  function shown(el){ try{ return el.checkVisibility({ checkOpacity:true, checkVisibilityCSS:true }); }catch(e){ return !!el.getClientRects().length; } }

  window.__scan = function(){
    try{ document.getAnimations().forEach(function(a){ try{ a.finish(); }catch(e){} }); }catch(e){}
    var VW = document.documentElement.clientWidth, VH = window.innerHeight;
    var found = {}, add = function(kind, what, by, box, extra){
      if(/nv-cod-eye/.test(what)) return;        /* hangs 6px into the padding on purpose */
      if(kind === "ELLIPSIS" && !window.__showEllipsis) return;
      var k = kind+"|"+box+"|"+what.slice(0,24);
      if(!found[k]) found[k] = { kind:kind, text:what.slice(0,70), by:Math.round(by), box:box, extra:extra||"" };
    };
    function check(L, R, T, B, start, what, self){
      if(L >= VW - 1 || R <= 1) return;                     /* parked off-screen (a closed drawer) */
      var a = start, cs0 = getComputedStyle(self||start), floating = false;
      while(a && a !== document.documentElement){
        var cs = getComputedStyle(a);
        if(cs.display !== "inline" && cs.display !== "contents"){
          var ar = a.getBoundingClientRect(), ox = cs.overflowX, oy = cs.overflowY;
          var clipsX = ox==="hidden"||ox==="clip", clipsY = oy==="hidden"||oy==="clip";
          var scrollX = ox==="auto"||ox==="scroll", scrollY = oy==="auto"||oy==="scroll";
          /* Wholly outside a clipping box: collapsed or off-canvas, not a bug. */
          if((clipsX||scrollX) && (L >= ar.right-1 || R <= ar.left+1)) return;
          if((clipsY||scrollY) && (T >= ar.bottom-1 || B <= ar.top+1)) return;
          var over = Math.max(R-ar.right, ar.left-L);
          if(over > 1.5 && !scrollX && (clipsX || !floating)){
            var kind = clipsX ? (cs.textOverflow==="ellipsis" || cs0.textOverflow==="ellipsis" ? "ELLIPSIS" : "CUT OFF") : "SPILLS OUT";
            add(kind, what, over, chain(a), "ws:"+cs0.whiteSpace);
            return;
          }
          var overY = Math.max(B-ar.bottom, ar.top-T);
          if(overY > 4 && clipsY && !/^\d/.test(cs.webkitLineClamp||"") && !/^\d/.test(cs0.webkitLineClamp||"")){
            add("CUT OFF (height)", what, overY, chain(a), "h:"+Math.round(ar.height));
            return;
          }
          if(scrollX && scrollY) return;
          if(cs.position === "fixed") break;
          if(cs.position === "absolute"){ floating = true; a = a.offsetParent || document.body; continue; }
        }
        a = a.parentElement;
      }
      if(L >= VW || R <= 0) return;                          /* parked off-screen */
      if(R > VW + 1.5 || L < -1.5) add("OFF THE SCREEN", what, Math.max(R-VW, -L), chain(self||start), "vw:"+VW);
    }
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n, rng = document.createRange(), texts = [];
    while((n = w.nextNode())){
      var t = n.nodeValue.replace(/\s+/g," ").trim(); if(t.length < 2) continue;
      var el = n.parentElement; if(!el || !shown(el)) continue;
      if(el.closest("script,style,noscript,svg,option,select,textarea,.sr-only,.visually-hidden,#nvObDeck")) continue;
      rng.selectNodeContents(n);
      var rs = [].filter.call(rng.getClientRects(), function(r){ return r.width>0.5 && r.height>0.5; }); if(!rs.length) continue;
      var L = Math.min.apply(0, rs.map(function(r){return r.left;})), R = Math.max.apply(0, rs.map(function(r){return r.right;}));
      var T = Math.min.apply(0, rs.map(function(r){return r.top;})), B = Math.max.apply(0, rs.map(function(r){return r.bottom;}));
      check(L, R, T, B, el, t, el);
      /* For the overlap test, only the part of the text that is really drawn. */
      var cl = { L:L, R:R, T:T, B:B };
      for(var c = el; c && c !== document.documentElement; c = c.parentElement){
        var ccs = getComputedStyle(c);
        if(ccs.display === "inline") continue;
        if(ccs.overflowX !== "visible" || ccs.overflowY !== "visible"){
          var cr = c.getBoundingClientRect();
          if(ccs.overflowX !== "visible"){ cl.L = Math.max(cl.L, cr.left); cl.R = Math.min(cl.R, cr.right); }
          if(ccs.overflowY !== "visible"){ cl.T = Math.max(cl.T, cr.top); cl.B = Math.min(cl.B, cr.bottom); }
        }
      }
      /* One entry for each line the text occupies: the box around a wrapped
         sentence covers its neighbours on the first line without touching them. */
      rs.forEach(function(r0){
        var l = Math.max(r0.left, cl.L), r = Math.min(r0.right, cl.R), tp = Math.max(r0.top, cl.T), b = Math.min(r0.bottom, cl.B);
        if(r - l > 1 && b - tp > 1) texts.push({ el:el, t:t, L:l, R:r, T:tp, B:b });
      });
    }
    [].forEach.call(document.querySelectorAll("button,a,input,select,textarea,img,canvas,.chip"), function(el){
      if(!shown(el)) return; var r = el.getBoundingClientRect(); if(r.width < 1 || r.height < 1) return;
      check(r.left, r.right, r.top, r.bottom, el.parentElement, "["+desc(el)+"] "+(el.textContent||el.placeholder||el.alt||"").replace(/\s+/g," ").trim(), el);
    });
    /* Text sitting on top of other text. Only what is on screen right now. */
    var onScreen = texts.filter(function(x){ return x.B>0 && x.T<VH && x.R>0 && x.L<VW; }).filter(function(x){
      var cx = Math.min(VW-1, Math.max(0,(x.L+x.R)/2)), cy = Math.min(VH-1, Math.max(0,(x.T+x.B)/2));
      var top = document.elementFromPoint(cx, cy); return top && (top===x.el || x.el.contains(top) || top.contains(x.el));
    });
    for(var i=0;i<onScreen.length;i++) for(var j=i+1;j<onScreen.length;j++){
      var p = onScreen[i], q = onScreen[j]; if(p.el.contains(q.el) || q.el.contains(p.el)) continue;
      var ix = Math.min(p.R,q.R)-Math.max(p.L,q.L), iy = Math.min(p.B,q.B)-Math.max(p.T,q.T);
      if(ix > 4 && iy > 5) add("TEXT OVER TEXT", p.t+"  ><  "+q.t, Math.min(ix,iy), chain(p.el)+"  ><  "+chain(q.el));
    }
    /* Boxes that scroll sideways. Listed so each can be judged. */
    [].forEach.call(document.querySelectorAll("body *"), function(el){
      if(el.scrollWidth <= el.clientWidth + 2 || !el.clientWidth) return;
      var cs = getComputedStyle(el); if(cs.overflowX!=="auto" && cs.overflowX!=="scroll") return; if(!shown(el)) return;
      add("SCROLLS SIDEWAYS", "", el.scrollWidth-el.clientWidth, chain(el), "w:"+el.clientWidth);
    });
    var de = document.documentElement;
    if(de.scrollWidth > de.clientWidth + 1) add("PAGE SCROLLS SIDEWAYS", "", de.scrollWidth-de.clientWidth, "html", "");
    return Object.keys(found).map(function(k){ return found[k]; });
  };

  /* Scan the page at every scroll stop of the main page and of an open drawer. */
  window.__scanAll = async function(){
    var all = {}, take = function(){ window.__scan().forEach(function(f){ all[f.kind+"|"+f.box+"|"+f.text.slice(0,24)] = f; }); };
    var sc = document.scrollingElement, max = sc.scrollHeight - innerHeight, step = Math.max(300, innerHeight-120);
    for(var y=0; y<=Math.max(0,max)+step-1 && y < 12000; y+=step){ sc.scrollTop = Math.min(y, Math.max(0,max)); void document.body.offsetHeight; take(); if(y>=max) break; }
    sc.scrollTop = 0;
    return Object.keys(all).map(function(k){ return all[k]; });
  };
  window.__fmt = function(list, skip){
    return list.filter(function(f){ return !(skip||[]).some(function(s){ return f.kind.indexOf(s)===0; }); })
      .map(function(f){ return f.kind+" by "+f.by+"px | "+f.text+" | "+f.box+" | "+f.extra; });
  };
  window.__ALL = ["dashboard","newBooking","money","tickets","awbLabel","loadSheet","bulkBooking","swap","recover","reports","integrations","subAccounts","profile","support"];
  var nap = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var deck = function(){ var d = document.getElementById("nvObDeck"); if(d) d.remove(); };
  window.__sweep = async function(tabs){
    var res = {};
    for(var i=0;i<tabs.length;i++){ var t = tabs[i];
      try{ showClientTab(t); }catch(e){ res[t] = ["ERR "+e.message]; continue; }
      await nap(200); deck();
      var f = window.__fmt(await window.__scanAll()); if(f.length) res[t] = f;
      [].forEach.call(document.querySelectorAll("button"), function(b){ if(b.textContent.trim()==="Not now" && b.checkVisibility()) b.click(); });
    }
    return res;
  };
  function scanInside(root, re){
    var all = {}, take = function(){ window.__scan().forEach(function(f){ if(!re || re.test(f.box)) all[f.kind+"|"+f.box+"|"+f.text.slice(0,24)] = f; }); };
    var sc = [].filter.call(root.querySelectorAll("*"), function(e){ var c = getComputedStyle(e); return (c.overflowY==="auto"||c.overflowY==="scroll") && e.scrollHeight > e.clientHeight+4; })[0];
    if(sc){ for(var y=0; y<=sc.scrollHeight; y+=Math.max(200, sc.clientHeight-100)){ sc.scrollTop = y; void sc.offsetHeight; take(); } sc.scrollTop = 0; } else take();
    return window.__fmt(Object.keys(all).map(function(k){ return all[k]; }));
  }
  window.__scanInside = scanInside;
  window.__drawers = async function(){
    var res = {}, T = window.__nvDemoData.tables.parcels.filter(function(p){ return /^N91/.test(p.awb); });
    showClientTab("dashboard"); await nap(150);
    for(var i=0;i<T.length;i++){ var p = T[i];
      try{ openClientParcelJourney(p.awb); }catch(e){ res[p.awb] = ["ERR "+e.message]; continue; }
      await nap(50);
      var d = document.getElementById("nvdrawer"); if(!d){ res[p.awb] = ["no drawer"]; continue; }
      var f = scanInside(d, /nvdr|nvdrawer|nv-exc|review-panel/); if(f.length) res[p.status+(p.consignee.length>20?" (long)":"")] = f;
    }
    try{ window.NovaXUI.closeDrawer(); }catch(e){}
    return res;
  };
  /* Press every button on a screen, one at a time, and scan whatever opens.
     Nothing can be saved in the demo; printing, downloads and new windows are
     switched off first so a press cannot leave the page or save a file. */
  function safe(){
    if(window.__safe) return; window.__safe = true;
    window.print = function(){}; window.open = function(){ return null; };
    try{ URL.createObjectURL = function(){ return "blob:off"; }; }catch(e){}
    HTMLAnchorElement.prototype.click = function(){};
    document.addEventListener("click", function(e){ var a = e.target && e.target.closest ? e.target.closest("a[href]") : null; if(a) e.preventDefault(); }, true);
    try{ navigator.clipboard.writeText = function(){ return Promise.resolve(); }; }catch(e){}
    window.alert = function(){}; window.confirm = function(){ return false; }; window.prompt = function(){ return null; };
  }
  var SKIP = /whatsapp|message customer|call |exit demo|start shipping|sign ?out|log ?out|track on|tracking page|sign in|create account|reload/i;
  function overlays(){
    return [].filter.call(document.querySelectorAll("body *"), function(e){
      if(e.id === "nvautoLauncher" || e.closest("#nvautoLauncher")) return false;
      var c = getComputedStyle(e); if(c.position !== "fixed" || c.display === "none" || c.visibility !== "visible" || parseFloat(c.opacity) < .05) return false;
      if(e.id === "nvdrawer"){ var pn = e.querySelector(".nvdr-panel"); if(!pn || pn.getBoundingClientRect().left >= innerWidth - 10) return false; }
      var r = e.getBoundingClientRect(); return r.width > 120 && r.height > 80 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    }).filter(function(e, i, a){ return !a.some(function(o){ return o !== e && o.contains(e); }); });
  }
  function closeAll(){
    try{ document.dispatchEvent(new KeyboardEvent("keydown", { key:"Escape", bubbles:true })); }catch(e){}
    try{ window.NovaXUI.closeDrawer(); }catch(e){}
    overlays().forEach(function(o){
      var b = [].filter.call(o.querySelectorAll("button"), function(x){ return /^(close|not now|cancel|done|back|×|✕|x|got it|skip|maybe later|no thanks)$/i.test(x.textContent.trim()) || /close/i.test(x.getAttribute("aria-label")||""); })[0];
      if(b) try{ b.click(); }catch(e){}
    });
    /* A hidden pane never finishes a slide-out by itself. */
    try{ document.getAnimations().forEach(function(a){ try{ a.finish(); }catch(e){} }); }catch(e){}
  }
  window.__closeAll = closeAll; window.__overlays = overlays;
  window.__monkey = async function(tab, from, to){
    safe();
    var all = {}, log = [], base, root, n;
    var isSel = /^[#.\[]/.test(tab), home = isSel ? "dashboard" : tab;
    var list = function(){ root = isSel ? document.querySelector(tab) : document.getElementById("client-"+tab); if(!root) return []; return [].filter.call(root.querySelectorAll("button,[role=button],summary,[data-nv-tkopen]"), function(b){ return b.checkVisibility() && !b.disabled && !SKIP.test(b.textContent); }); };
    showClientTab(home); await nap(200); deck(); closeAll(); await nap(60);
    n = list().length; base = overlays().length;
    for(var i = from||0; i < Math.min(n, to||n); i++){
      var bs = list(); if(i >= bs.length) break; var b = bs[i], label = (b.textContent||b.getAttribute("aria-label")||"").replace(/\s+/g," ").trim().slice(0,40);
      try{ b.click(); }catch(e){ log.push(i+" "+label+" ERR "+e.message); continue; }
      await nap(90); deck();
      var ov = overlays(), opened = ov.length > base;
      window.__scan().forEach(function(f){ var k = f.kind+"|"+f.box+"|"+f.text.slice(0,24); if(!all[k]){ f.after = label; all[k] = f; } });
      if(opened){ ov.slice(base).forEach(function(o){ try{ scanInside(o).forEach(function(line){ all["in|"+line] = { kind:"", text:line, by:0, box:"", extra:"", after:label, raw:true }; }); }catch(e){} }); }
      closeAll(); await nap(70); closeAll();
      if(!document.getElementById("client-"+home).checkVisibility()){ showClientTab(home); await nap(150); }
      if(overlays().length > base){ log.push("still open after "+i+" "+label+": "+overlays().slice(base).map(desc).join(",")); overlays().slice(base).forEach(function(o){ if(o.id!=="nvdrawer") o.remove(); }); }
    }
    window.scrollTo(0, 0);
    return { tab:tab, buttons:n, findings:Object.keys(all).map(function(k){ var f = all[k]; return (f.raw ? f.text : f.kind+" by "+f.by+"px | "+f.text+" | "+f.box+" | "+f.extra)+"   <- after pressing: "+f.after; }), log:log };
  };
  return "scanner ready";
})();
