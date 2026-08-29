/* NovaX client portal — application bundle.
 *
 * Every inline <script> from client.html except three, concatenated in the
 * exact order the browser used to execute them, and loaded with `defer`.
 *
 * WHY: the portal shipped as a single 1.04 MB HTML file, 295 KB gzipped, with
 * 764 KB of JavaScript inlined into it. The parser had to walk all of that
 * before the page was usable, none of it could be cached separately, and every
 * repeat visit re-downloaded the whole thing. On the mid-range Android over 4G
 * that these merchants actually use, that is the difference between a portal
 * that opens and one they close.
 *
 * WHAT STAYED INLINE, and why each one has to:
 *   #1  service worker registration  — must run before anything caches
 *   #2  theme stamping               — must run BEFORE first paint, or every
 *                                      merchant gets a flash of the wrong theme
 *   #4  window.NOVAX_CONFIG          — a literal object every later block reads
 *
 * ORDER IS LOAD-BEARING. These were classic scripts sharing one global scope,
 * so concatenation preserves their semantics exactly -- verified first that no
 * two blocks declare the same top-level const/let/class, which is the one thing
 * that is legal across separate scripts but a SyntaxError inside one file.
 * There is no document.write and no top-level await.
 *
 * `defer` runs this after the document is parsed, so every block now sees MORE
 * of the DOM than it used to, never less. Inline onclick handlers are
 * unaffected -- they resolve at click time, long after this has run.
 */

/* ==== client.html inline block #5 ==== */

  (function(){
    // NovaX fix (auth separation): this is the single, earliest, authoritative
    // access gate for the Client Portal. It runs before any other script on
    // this page and keeps the full-page "Checking account..." screen above
    // (#nvAuthGate) covering the dashboard/menu/cards until a real Supabase
    // session AND a profiles.role === "client" lookup both succeed. It never
    // trusts localStorage novaxSession for access -- that value is UI cache
    // only and is cleared whenever a role/page mismatch is found.
    var AUTH_GATE_VERSION="2026-07-16-auth-flow-v4"; window.NOVAX_AUTH_GATE_VERSION=AUTH_GATE_VERSION;
    var __SB_URL=window.NOVAX_CONFIG.SB_URL;
    var __SB_KEY=window.NOVAX_CONFIG.SB_KEY;
    var __ADMIN_ROLES=["admin","owner","superadmin","ops","ops manager","branch manager","warehouse","warehouse staff","processing","processing staff","staff","rider supervisor"];
    // NovaX fix (admin/client mapping guard): every real admin login email
    // goes in this array, lowercase, one per entry. Checked BEFORE
    // profiles.role is even fetched, so a mismapped database row
    // (profiles.role wrongly stored as "client" for an admin login) can
    // never show that admin the Client Portal. Keep this list in sync with
    // the admin_emails list in Step 3 of novax_role_hard_stop_v2_repair.sql
    // -- both must contain the exact same set of emails. Never deploy this
    // with a placeholder value still in place.
    //
    // WARNING: this denylist is a defense-in-depth check, not the source of
    // truth. If a real admin's login email is missing from this array AND
    // that admin's profiles.role is wrong in the database (e.g. stored as
    // "client"), this guard cannot catch it and that admin can still land
    // in the Client Portal. Add every admin email here, and separately fix
    // the underlying profiles.role via novax_role_hard_stop_v2_repair.sql.
    var __ADMIN_EMAIL_DENYLIST=["admin@novax.pk"];
    var __resolveGate; window.__novaxAuthGateReady=new Promise(function(res){ __resolveGate=res; });

    /* ═══════════════════════════════════════════════════════════════════
       DEMO PORTAL  —  client.html?demo=1
       ───────────────────────────────────────────────────────────────────
       Opens the real merchant portal, fully navigable, with sample data and
       no account. It exists because the portal is the product: 339 of 374
       parcels ever booked came through it, and until now nobody could see it
       without signing up first.

       THE DESIGN DECISION THAT MATTERS: there is no backend.

       No session, no Supabase client, no endpoint. Every read is answered
       from a fixture held in memory; every write is refused. A demo ACCOUNT
       was considered and rejected -- it is a real authenticated session, so
       any write path missed writes a real row, it needs a new RLS policy set
       on the surface PROJECT_HISTORY 3.2 already lists as an open risk, and
       it is an endpoint strangers can hammer from a public homepage link.

       Here, writing is structurally impossible rather than merely blocked.

       Everything below is inert unless ?demo= is in the URL, so a real
       merchant session never touches a line of it.
       ═══════════════════════════════════════════════════════════════════ */
    var NV_DEMO = (function(){
      try{ return new URLSearchParams(location.search).has("demo"); }
      catch(e){ return location.search.indexOf("demo=") > -1; }
    })();
    window.__NOVAX_DEMO = NV_DEMO;

    /* Fixtures are attached in phase 2; the shim reads whatever is here. */
    window.__nvDemoData = window.__nvDemoData || {};

    function nvDemoTables(){ return window.__nvDemoData.tables || {}; }
    function nvDemoRpcs(){ return window.__nvDemoData.rpcs || {}; }

    /* Fired whenever the visitor tries to change something. A blocked write
       is the moment of intent, so it asks for the signup rather than saying
       "disabled" -- see nvDemoPrompt(), attached in phase 3. */
    function nvDemoBlocked(what){
      try{ if(typeof window.nvDemoPrompt === "function") window.nvDemoPrompt(what); }catch(e){}
      return { data:null, error:{ message:"__DEMO__", code:"DEMO_READONLY" } };
    }

    /* A thenable query builder covering exactly the chain this portal uses:
       select/eq/in/is/not/gte/order/limit/single/maybeSingle. Anything not
       modelled still resolves rather than throwing, because a demo that
       breaks on an unmodelled filter is worse than one that shows a little
       too much sample data. */
    function nvDemoQuery(table){
      var rows = (nvDemoTables()[table] || []).slice();
      var one = false;
      var api = {};
      function pass(){ return api; }
      api.select = pass; api.order = pass; api.limit = pass;
      api.range = pass; api.or = pass; api.ilike = pass; api.lte = pass; api.lt = pass; api.gt = pass;
      api.eq = function(col, val){
        rows = rows.filter(function(r){ return String(r[col]) === String(val); }); return api; };
      api.in = function(col, vals){
        var set = (vals||[]).map(String);
        rows = rows.filter(function(r){ return set.indexOf(String(r[col])) > -1; }); return api; };
      api.is = function(col, val){
        rows = rows.filter(function(r){ return val === null ? (r[col] == null) : (r[col] === val); }); return api; };
      api.not = function(col, op, val){
        rows = rows.filter(function(r){ return String(r[col]) !== String(val); }); return api; };
      api.gte = function(col, val){
        rows = rows.filter(function(r){ return String(r[col]) >= String(val); }); return api; };
      api.single = function(){ one = true; return api; };
      api.maybeSingle = function(){ one = true; return api; };
      api.insert = function(){ return Promise.resolve(nvDemoBlocked("save")); };
      api.update = function(){ return Promise.resolve(nvDemoBlocked("save")); };
      api.upsert = function(){ return Promise.resolve(nvDemoBlocked("save")); };
      api.delete = function(){ return Promise.resolve(nvDemoBlocked("delete")); };
      api.then = function(res, rej){
        return Promise.resolve({ data: one ? (rows[0] || null) : rows, error:null }).then(res, rej); };
      api.catch = function(f){ return api.then(function(v){ return v; }).catch(f); };
      return api;
    }

    function nvDemoClient(){
      return {
        __isDemo: true,
        from: function(table){ return nvDemoQuery(table); },
        rpc: function(name, args){
          var map = nvDemoRpcs();
          if (Object.prototype.hasOwnProperty.call(map, name)) {
            var v = map[name];
            return Promise.resolve({ data: (typeof v === "function" ? v(args) : v), error:null });
          }
          /* Anything that books, edits, pays, connects or sets is a write. */
          if (/^(client_(book|edit|set|save|cancel|generate|request)|novax_ticket|ai_action|request_)/.test(name)) {
            return Promise.resolve(nvDemoBlocked("save"));
          }
          return Promise.resolve({ data:null, error:null });
        },
        auth: {
          getSession: function(){ return Promise.resolve({ data:{ session:null }, error:null }); },
          getUser:    function(){ return Promise.resolve({ data:{ user:null }, error:null }); },
          signOut:    function(){ return Promise.resolve({ error:null }); },
          onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; }
        },
        channel: function(){
          var ch = {}; ch.on = function(){ return ch; }; ch.subscribe = function(){ return ch; };
          ch.unsubscribe = function(){ return Promise.resolve(); }; return ch; },
        removeChannel: function(){ return Promise.resolve(); },
        getChannels: function(){ return []; }
      };
    }

    /* ── The fixture ──────────────────────────────────────────────────
       Rows are in DATABASE column shape, not the portal's JS shape, so the
       real mappers, the real loaders and the real render paths all run
       untouched. A demo that reimplements the portal proves nothing about
       the portal.

       The five parcels are chosen to walk the money loop end to end, which
       is the thing a fifty-courier aggregator structurally cannot copy:
       delivered and paid into the wallet, out for delivery, in transit, a
       refusal handled honestly, and one waiting for pickup. Showing the
       refusal is deliberate -- five green rows read as a mockup.

       Every name, address and number here is invented. AWBs use an N9xxxxxx
       block the live sequence does not reach, so a demo AWB can never be
       confused for a real parcel. */
    function nvDemoSeed(){
      var now = Date.now(), H = 3600000, D = 24 * H;
      function iso(ms){ return new Date(ms).toISOString(); }
      var CID = "demo-client";
      function parcel(o){
        return { id:"demo-p-"+o.awb, awb:o.awb, client_id:CID, status:o.status,
          consignee:o.consignee, phone:o.phone, city:"Karachi", address:o.address,
          cod_amount:o.cod, fee:200, exception:o.exception||null,
          booked_at:iso(now-o.age), updated_at:iso(now-o.upd),
          invoice_id:o.invoice||null, invoiced_at:o.invoice?iso(now-6*H):null,
          rider_id:o.rider||null, pricing_mode:null, distance_km:null,
          quoted_fee:null, rate_version:null,
          meta:{ weight:o.kg||"0.5 kg", service:"COD Standard", branch:"Karachi Hub",
                 paymentMode:"COD", steps:o.steps||null, risk:0 } };
      }
      return {
        tables: {
          profiles: [{ id:"demo-user", client_id:CID, role:"client", status:"active" }],
          clients: [{ id:CID, name:"Sana's Closet", code:"SC", phone:"0300-0000000",
                      city:"Karachi", address:"Shop 14, Tariq Road, Karachi",
                      wallet_balance:3450, rate:200, status:"Active",
                      rate_card:{ A:{overnight:200, additionalKg:60}, B:{overnight:200, additionalKg:60} },
                      meta:{ pickupCity:"Karachi" } }],
          parcels: [
            parcel({ awb:"N9000001", status:"Delivered", consignee:"Hina Raza",
                     phone:"0300-0000001", address:"Flat 3B, Block 7, Gulshan-e-Iqbal, Karachi",
                     cod:3450, age:5*D, upd:6*H, invoice:"demo-inv-1", rider:"demo-rider" }),
            parcel({ awb:"N9000002", status:"Parcel out for delivery", consignee:"Bilal Ahmed",
                     phone:"0300-0000002", address:"House 21, Phase 5, DHA, Karachi",
                     cod:1899, age:2*D, upd:2*H, rider:"demo-rider", kg:"1 kg" }),
            parcel({ awb:"N9000003", status:"Parcel now in transit", consignee:"Ayesha Siddiqui",
                     phone:"0300-0000003", address:"Shop 8, Bahadurabad, Karachi",
                     cod:2750, age:1*D, upd:5*H }),
            parcel({ awb:"N9000004", status:"Refused", consignee:"Usman Tariq",
                     phone:"0300-0000004", address:"House 44, North Nazimabad, Karachi",
                     cod:1200, age:3*D, upd:20*H,
                     exception:"Consignee refused at doorstep - asked to reattempt Saturday" }),
            parcel({ awb:"N9000005", status:"New booked", consignee:"Maryam Khan",
                     phone:"0300-0000005", address:"Flat 12, Clifton Block 2, Karachi",
                     cod:4300, age:3*H, upd:3*H, kg:"1.5 kg" })
          ],
          invoices: [{ id:"demo-inv-1", code:"INV-DEMO001", client_id:CID,
            parcel_refs:["N9000001"], cod_total:3450, fee_total:200, net_payable:3250,
            due_to_novax:0, invoice_type:"COD Settlement", status:"Pushed to wallet",
            created_at:iso(now-6*H), wallet_pushed_at:iso(now-5*H), meta:{} }],
          wallet_ledger: [
            { id:"demo-l-1", client_id:CID, entry_type:"invoice_credit", amount:3250,
              affects_balance:true, status:"Credited", reference_type:"invoice",
              reference_code:"INV-DEMO001", created_at:iso(now-5*H),
              note:"Invoice INV-DEMO001 credited to wallet. Rs 3,250 now available to withdraw." },
            { id:"demo-l-2", client_id:CID, entry_type:"admin_adjustment", amount:200,
              affects_balance:true, status:"Credited", created_at:iso(now-4*D),
              note:"Welcome credit" }
          ],
          withdrawals: [], payment_logs: [], pickup_requests: [],
          store_connections: [], staff_users: [],
          novax_tickets: [{ id:"demo-t-1", client_id:CID, code:"TKT-DEMO1",
            subject:"Reattempt for N9000004", status:"resolved", priority:"normal",
            awb:"N9000004", sla_hours:24, created_at:iso(now-22*H),
            first_response_at:iso(now-21*H), updated_at:iso(now-20*H) }],
          novax_ticket_replies: [
            { id:"demo-r-1", ticket_id:"demo-t-1", by_side:"client", by_name:"Sana's Closet",
              body:"Customer refused. Can we try again on Saturday?", created_at:iso(now-22*H) },
            { id:"demo-r-2", ticket_id:"demo-t-1", by_side:"admin", by_name:"NovaX Support",
              body:"Booked for Saturday and the rider will call before arriving. No extra charge for a reattempt.",
              created_at:iso(now-21*H) }
          ]
        },
        /* Read RPCs the portal calls to render. Writes are refused by the
           shim's pattern match, so only the read side needs answers. */
        rpcs: {
          client_wallet_summary: [{ available_balance:3450, pending_payout:0,
            paid_this_month:0, lifetime_withdrawn:0 }],
          client_wallet_incoming: [{ delivered_uninvoiced:5849, parcels:2 }],
          client_bank_details: [],
          client_pickup_locations_list: [{ id:"demo-loc", label:"Shop 14, Tariq Road",
            city:"Karachi", is_default:true }],
          client_pricing_choice_state: { mode:"flat", locked:true },
          client_review_prompt_state: { should_prompt:false },
          client_shopify_status: [{ connected:false }],
          client_get_notification_prefs: { whatsapp:true, email:true },
          ai_quota_status: { used:3, cap:50, remaining:47 }
        }
      };
    }

    /* ═══════════════════════════════════════════════════════════════════
       ONBOARDING DECK — ten swipeable cards
       ───────────────────────────────────────────────────────────────────
       Shown to a brand-new merchant once, and to anyone in the demo. It must
       NEVER appear for an existing merchant, so the gate fails closed: if we
       cannot prove someone is new, nothing renders.

           show  ⇔  demo
                 OR ( workspace created < 15 min ago
                      AND not already completed on this device )

       clients.created_at is the hard guarantee. A merchant who signed up three
       weeks ago cannot satisfy a 15-minute window -- not by clearing storage,
       not by reinstalling, not by signing in on another phone. localStorage is
       only the "don't show it twice" nicety layered on top; if it is missing,
       the window still holds.

       Gating on a clients.meta flag instead was rejected: writing it needs an
       RPC, merchants cannot write to clients directly (the guard triggers
       block it), and a failed write would either loop the deck forever or need
       a silent catch that hides the failure. The window needs no write at all.
       ═══════════════════════════════════════════════════════════════════ */
    var NV_ONBOARD_WINDOW_MS = 15 * 60 * 1000;
    function nvOnboardKey(cid){ return "nvOnboardCards:" + (cid || "anon"); }
    function nvOnboardDone(cid){
      try{ return localStorage.getItem(nvOnboardKey(cid)) === "1"; }catch(e){ return false; }
    }
    function nvOnboardMarkDone(cid){
      try{ localStorage.setItem(nvOnboardKey(cid), "1"); }catch(e){}
    }
    /* Exported so the gate can be exercised directly in tests without
       standing up a whole session. */
    var NV_ONBOARD_SHOWN = false;      // once per page load, demo included
    window.nvOnboardEligible = function(createdAt, clientId, isDemo){
      /* loadAll() runs again on every refresh and realtime nudge, so without
         this the deck rebuilt itself after being dismissed -- permanently in
         demo, where the check below returns true unconditionally. */
      if (NV_ONBOARD_SHOWN) return false;
      if (isDemo) return !nvOnboardDone(clientId);
      if (!createdAt) return false;                 // unknown age -> never show
      var t = Date.parse(createdAt);
      if (!isFinite(t)) return false;               // unparseable -> never show
      if (Date.now() - t > NV_ONBOARD_WINDOW_MS) return false;
      if (Date.now() - t < 0) return false;         // clock skew -> never show
      return !nvOnboardDone(clientId);
    };
    window.nvOnboardMaybeShow = function(createdAt){
      try{
        var cid = (window.__novaxVerifiedProfile || {}).clientId || null;
        if (!window.nvOnboardEligible(createdAt, cid, !!window.__NOVAX_DEMO)) return;
        if (document.getElementById("nvObDeck")) return;
        NV_ONBOARD_SHOWN = true;
        nvOnboardBuild(cid);
      }catch(e){}
    };

    /* The ten cards. Weighted toward the first parcel, because that is the
       measured leak: 216 merchants have signed up and 46 have ever booked.
       Each carries a CSS miniature rather than a screenshot -- ten PNGs would
       add most of a megabyte in front of a merchant on patchy 4G, and a
       screenshot starts lying the next time the UI moves. The landing page
       already uses this technique in section 02. */
    function nvOnboardCards(){
      var m = {
        rows: function(items){ return '<div class="nvob-rows">' + items.map(function(r){
          return '<div class="nvob-row"><span class="nvob-r-l">'+r[0]+'</span><span class="nvob-r-r '+(r[2]||'')+'">'+r[1]+'</span></div>';
        }).join("") + '</div>'; },
        big: function(label, value, sub){ return '<div class="nvob-big"><span>'+label+'</span><b>'+value+'</b>'+(sub?'<i>'+sub+'</i>':'')+'</div>'; },
        form: function(fields){ return '<div class="nvob-form">' + fields.map(function(f){
          return '<label>'+f[0]+'<span>'+(f[1]||'')+'</span></label>'; }).join("") + '</div>'; },
        chip: function(t, cls){ return '<span class="nvob-chip '+(cls||'')+'">'+t+'</span>'; }
      };
      return [
        { t:"Your workspace is live", nav:"dashboard",
          b:"No approval queue, no waiting. You can book a parcel right now and we will collect it.",
          v: m.big("Wallet", "Rs 0", "nothing owed, nothing owing") +
             m.rows([["Account","Active","ok"],["Setup fee","None","ok"],["Contract","None","ok"]]) },
        { t:"Book your first parcel", nav:"newBooking",
          b:"Consignee, address, COD amount. That is the whole form — we generate the tracking number for you.",
          v: m.form([["Consignee","Hina Raza"],["City","Karachi"],["Address","Flat 3B, Gulshan-e-Iqbal"],["COD","Rs 3,450"]]) },
        { t:"Got the order on WhatsApp?", nav:"newBooking",
          b:"Paste the message and Autopilot fills the form for you. No retyping an address off a phone screen.",
          v: '<div class="nvob-paste">"Hina Raza, Flat 3B Gulshan-e-Iqbal Karachi, 0300‑…, COD 3450"</div>' +
             '<div class="nvob-arrow">↓</div>' + m.form([["Consignee","Hina Raza ✓"],["COD","Rs 3,450 ✓"]]) },
        { t:"Print the label", nav:"more",
          b:"Every parcel gets an AWB. Print it, stick it on the box, hand it to the rider.",
          v: '<div class="nvob-awb"><b>N9000001</b><div class="nvob-bars"></div><small>Karachi · COD Rs 3,450</small></div>' },
        { t:"Follow every parcel", nav:"dashboard",
          b:"Real status from our own riders — not a feed scraped from someone else's system.",
          v: m.rows([["Collected","✓","ok"],["In transit","✓","ok"],["Out for delivery","now","live"],["Delivered","—",""]]) },
        { t:"What needs me", nav:"dashboard",
          b:"Refusals and stuck parcels are surfaced before they turn into an angry customer message.",
          v: '<div class="nvob-alert"><b>N9000004</b> · Refused<span>Consignee asked to reattempt Saturday</span></div>' +
             '<div class="nvob-btns">'+m.chip("Re-attempt","go")+m.chip("Open journey")+'</div>' },
        { t:"Your COD wallet", nav:"money",
          b:"Every rupee collected on your behalf, and exactly what it is doing right now.",
          v: m.big("COD balance","Rs 3,450") +
             m.rows([["Available","Rs 3,450","ok"],["In transit","Rs 5,849",""],["Pending payout","Rs 0",""]]) },
        { t:"How charges work", nav:"money",
          b:"COD collected, minus delivery charges, on one invoice. Nothing is taken twice.",
          v: m.rows([["COD collected","Rs 3,450",""],["Delivery charge","− Rs 200",""],["Paid to you","Rs 3,250","ok"]]) },
        { t:"Get paid out", nav:"money",
          b:"Request a withdrawal to your own bank account whenever the balance suits you.",
          v: m.form([["To","PK… · your bank"],["Amount","Rs 3,250"]]) +
             '<div class="nvob-btns">'+m.chip("Request withdrawal","go")+'</div>' },
        { t:"Ask Autopilot anything", nav:"fab",
          b:"“Where is N9000002?” — it answers from your own parcels, in your own words.",
          v: '<div class="nvob-chat"><div class="nvob-q">mera parcel kahan hai?</div>' +
             '<div class="nvob-a">N9000002 is out for delivery in DHA Phase 5 today.</div></div>' }
      ];
    }

    /* "Where do I find this?" -- the half of onboarding that usually gets
       left out. Each card shows the real bottom navigation with the tab that
       owns the feature lit, so the deck teaches the map as well as the
       feature. Built from NV_BOTTOM_TABS rather than a copy, so it cannot
       drift from the navigation it is describing. */
    function nvObWhere(nav){
      var tabs = (typeof NV_BOTTOM_TABS !== "undefined" && NV_BOTTOM_TABS) ? NV_BOTTOM_TABS : [
        { id:"dashboard", label:"Home", ico:"\u2302" }, { id:"newBooking", label:"Book", ico:"\u002B" },
        { id:"money", label:"Money", ico:"\u20A8" }, { id:"tickets", label:"Support", ico:"\u263A" }];
      var items = tabs.map(function(t){ return { id:t.id, label:t.label, ico:t.ico }; });
      items.push({ id:"more", label:"More", ico:"\u2261" });
      if (nav === "fab") {
        return '<div class="nvob-where"><span class="nvob-w-lbl">Find it here</span>' +
          '<div class="nvob-w-nav">' + items.map(function(t){
            return '<span class="nvob-w-i"><i>'+t.ico+'</i>'+t.label+'</span>'; }).join("") +
          '<span class="nvob-w-fab" aria-hidden="true">\u25CF</span></div>' +
          '<span class="nvob-w-note">The floating Autopilot button, on every screen</span></div>';
      }
      return '<div class="nvob-where"><span class="nvob-w-lbl">Find it here</span>' +
        '<div class="nvob-w-nav">' + items.map(function(t){
          return '<span class="nvob-w-i'+(t.id===nav?' on':'')+'"><i>'+t.ico+'</i>'+t.label+'</span>'; }).join("") +
        '</div></div>';
    }

    function nvOnboardBuild(cid){
      var cards = nvOnboardCards(), i = 0, deck, track, dots, done = false;

      var css = document.createElement("style");
      css.textContent = [
        "@keyframes nvobIn{from{opacity:0;transform:translateY(26px) scale(.95)}to{opacity:1;transform:none}}",
        "@keyframes nvobFade{from{opacity:0}to{opacity:1}}",
        ".nvob-ov{position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;",
          "padding:18px;background:rgba(3,10,7,.82);backdrop-filter:blur(5px);animation:nvobFade .3s ease both}",
        ".nvob-wrap{width:100%;max-width:400px;animation:nvobIn .45s cubic-bezier(.2,.9,.25,1) both}",
        ".nvob-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}",
        ".nvob-dots{display:flex;gap:5px;flex:1}",
        ".nvob-dot{height:3px;flex:1;border-radius:2px;background:rgba(255,255,255,.16);transition:background .3s}",
        ".nvob-dot.on{background:#14c77b}",
        ".nvob-skip{background:none;border:0;color:#8fb3a3;font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;padding:4px 2px}",
        ".nvob-skip:hover{color:#dff3e9}",
        ".nvob-stage{position:relative;touch-action:none;perspective:1200px}",
        /* The page scrolled underneath while a card was being dragged: the
           stage allowed pan-y, and the overlay never locked the body. Both
           are closed here -- touch-action:none on the stage so a horizontal
           drag is ours alone, and body.nvob-lock while the deck is open. */
        "body.nvob-lock{overflow:hidden;touch-action:none;overscroll-behavior:none}",
        ".nvob-card{background:linear-gradient(180deg,#11221b,#0b1712);border:1px solid rgba(20,199,123,.3);",
          "touch-action:none;-webkit-user-select:none;user-select:none;cursor:grab;",
          "transform:translate3d(0,0,0);backface-visibility:hidden;",
          "border-radius:20px;padding:20px 20px 22px;color:#eaf7f0;box-shadow:0 34px 90px -30px rgba(0,0,0,.95);",
          "will-change:transform,opacity}",
        ".nvob-card:active{cursor:grabbing}",
        /* enter/exit -- transform+opacity only, so it stays on the compositor */
        "@keyframes nvobEnterR{from{opacity:0;transform:translate3d(46%,0,0) rotate(7deg)}to{opacity:1;transform:none}}",
        "@keyframes nvobEnterL{from{opacity:0;transform:translate3d(-46%,0,0) rotate(-7deg)}to{opacity:1;transform:none}}",
        ".nvob-in-r{animation:nvobEnterR .34s cubic-bezier(.22,.9,.28,1) both}",
        ".nvob-in-l{animation:nvobEnterL .34s cubic-bezier(.22,.9,.28,1) both}",
        "@media (prefers-reduced-motion:reduce){.nvob-in-r,.nvob-in-l{animation:none}}",
        ".nvob-card h3{margin:0 0 7px;font-size:19px;line-height:1.25;color:#fff;letter-spacing:-.012em}",
        ".nvob-card p{margin:0 0 15px;font-size:13.5px;line-height:1.6;color:#a9c7ba}",
        /* miniature */
        ".nvob-vis{background:rgba(255,255,255,.032);border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:13px;min-height:132px}",
        ".nvob-big{display:flex;flex-direction:column;gap:2px;margin-bottom:9px}",
        ".nvob-big span{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#7fa694}",
        ".nvob-big b{font-size:25px;font-weight:800;color:#fff;letter-spacing:-.02em}",
        ".nvob-big i{font-style:normal;font-size:11px;color:#7fa694}",
        ".nvob-rows{display:grid;gap:6px}",
        ".nvob-row{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;",
          "padding:6px 9px;background:rgba(255,255,255,.028);border-radius:8px}",
        ".nvob-r-l{color:#9dbfb0}.nvob-r-r{color:#dff3e9;font-weight:650}",
        ".nvob-r-r.ok{color:#4ee6a5}.nvob-r-r.live{color:#ffd479}",
        ".nvob-form{display:grid;gap:7px}",
        ".nvob-form label{display:flex;flex-direction:column;gap:3px;font-size:9.5px;letter-spacing:.11em;",
          "text-transform:uppercase;color:#7fa694}",
        ".nvob-form label span{font-size:13px;letter-spacing:0;text-transform:none;color:#eaf7f0;font-weight:600;",
          "background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);border-radius:8px;padding:7px 9px}",
        ".nvob-paste{font-size:11.5px;line-height:1.5;color:#cfe6da;background:rgba(255,255,255,.05);",
          "border-radius:9px;padding:9px 10px;font-style:italic}",
        ".nvob-arrow{text-align:center;color:#14c77b;font-size:15px;margin:5px 0}",
        ".nvob-awb{text-align:center}.nvob-awb b{font-size:17px;letter-spacing:.06em;color:#fff}",
        ".nvob-bars{height:38px;margin:9px 0;border-radius:3px;",
          "background:repeating-linear-gradient(90deg,#eaf7f0 0 2px,transparent 2px 4px,#eaf7f0 4px 7px,transparent 7px 10px)}",
        ".nvob-awb small{font-size:11px;color:#9dbfb0}",
        ".nvob-alert{background:rgba(224,96,75,.1);border:1px solid rgba(224,96,75,.34);border-radius:10px;padding:10px}",
        ".nvob-alert b{font-size:13px;color:#fff}",
        ".nvob-alert span{display:block;font-size:11.5px;color:#c9a9a2;margin-top:3px}",
        ".nvob-btns{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap}",
        ".nvob-chip{font-size:11.5px;font-weight:700;padding:6px 11px;border-radius:999px;",
          "border:1px solid rgba(255,255,255,.14);color:#cfe6da}",
        ".nvob-chip.go{background:rgba(20,199,123,.16);border-color:rgba(20,199,123,.45);color:#7fe9b6}",
        ".nvob-chat{display:grid;gap:7px}",
        ".nvob-q{justify-self:end;max-width:82%;background:rgba(255,255,255,.06);border-radius:12px 12px 4px 12px;",
          "padding:8px 11px;font-size:12.5px}",
        ".nvob-a{justify-self:start;max-width:88%;border-left:2px solid #14c77b;padding:2px 0 2px 10px;",
          "font-size:12.5px;color:#cfe6da}",
        /* footer */
        ".nvob-foot{display:flex;align-items:center;gap:10px;margin-top:14px}",
        ".nvob-nav{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);color:#dff3e9;",
          "width:42px;height:42px;border-radius:50%;font-size:17px;cursor:pointer;flex:0 0 auto}",
        ".nvob-nav:disabled{opacity:.3;cursor:default}",
        ".nvob-next{flex:1;background:linear-gradient(135deg,#14c77b,#0fa968);color:#04140c;border:0;",
          "border-radius:13px;padding:13px;font:inherit;font-weight:800;font-size:14.5px;cursor:pointer}",
        ".nvob-hint{text-align:center;font-size:11px;color:#6f9384;margin-top:9px}",
        /* the "find it here" strip */
        ".nvob-where{margin-top:12px;padding-top:11px;border-top:1px solid rgba(255,255,255,.08)}",
        ".nvob-w-lbl{display:block;font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:#6f9384;margin-bottom:7px}",
        ".nvob-w-nav{position:relative;display:flex;gap:3px;background:rgba(255,255,255,.035);",
          "border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:5px}",
        ".nvob-w-i{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:5px 2px;",
          "border-radius:8px;font-size:8.5px;font-weight:650;color:#7fa694;letter-spacing:.02em;transition:none}",
        ".nvob-w-i i{font-style:normal;font-size:14px;line-height:1}",
        ".nvob-w-i.on{background:rgba(20,199,123,.17);color:#7fe9b6;box-shadow:inset 0 0 0 1px rgba(20,199,123,.4)}",
        ".nvob-w-fab{position:absolute;right:-4px;top:-11px;width:19px;height:19px;border-radius:50%;",
          "display:grid;place-items:center;font-size:9px;color:#04140c;",
          "background:linear-gradient(135deg,#14c77b,#0fa968);box-shadow:0 3px 10px rgba(20,199,123,.5)}",
        ".nvob-w-note{display:block;margin-top:6px;font-size:10.5px;color:#7fa694}",
        /* Small phones: the deck must fit 375x812 with the strip added, so the
           card scrolls inside itself rather than pushing the footer off. */
        "@media (max-width:420px){.nvob-card h3{font-size:17px;margin-bottom:5px}",
          ".nvob-card p{font-size:12.5px;margin-bottom:11px}",
          ".nvob-ov{padding:11px}.nvob-card{padding:16px 16px 18px;border-radius:17px}",
          ".nvob-vis{min-height:0;padding:11px}.nvob-hint{font-size:10.5px;margin-top:7px}",
          ".nvob-foot{margin-top:11px}.nvob-next{padding:12px;font-size:14px}",
          ".nvob-nav{width:38px;height:38px}}",
        "@media (max-height:720px){.nvob-card{max-height:calc(100vh - 168px);overflow-y:auto}}",
        "@media (prefers-reduced-motion:reduce){.nvob-ov,.nvob-wrap{animation:none!important}",
          ".nvob-card{transition:none!important}}"
      ].join("");
      document.head.appendChild(css);

      var ov = document.createElement("div");
      ov.className = "nvob-ov"; ov.id = "nvObDeck";
      ov.setAttribute("role","dialog"); ov.setAttribute("aria-modal","true");
      ov.innerHTML =
        '<div class="nvob-wrap">' +
          '<div class="nvob-head"><div class="nvob-dots" id="nvObDots"></div>' +
            '<button class="nvob-skip" type="button" id="nvObSkip">Skip</button></div>' +
          '<div class="nvob-stage" id="nvObStage"></div>' +
          '<div class="nvob-foot">' +
            '<button class="nvob-nav" type="button" id="nvObPrev" aria-label="Previous">‹</button>' +
            '<button class="nvob-next" type="button" id="nvObNext">Next</button>' +
          '</div>' +
          '<div class="nvob-hint">Swipe left or right · or use the arrow keys</div>' +
        '</div>';
      document.body.appendChild(ov);

      document.body.classList.add("nvob-lock");
      deck  = document.getElementById("nvObStage");
      dots  = document.getElementById("nvObDots");
      dots.innerHTML = cards.map(function(){ return '<span class="nvob-dot"></span>'; }).join("");

      function paint(dir){
        var c = cards[i];
        var enter = dir === -1 ? " nvob-in-l" : (dir === 1 ? " nvob-in-r" : "");
        deck.innerHTML = '<div class="nvob-card' + enter + '" id="nvObCard">' +
          '<h3>' + c.t + '</h3><p>' + c.b + '</p><div class="nvob-vis">' + c.v + '</div>' +
          nvObWhere(c.nav) + '</div>';
        Array.prototype.forEach.call(dots.children, function(d, n){
          d.classList.toggle("on", n <= i); });
        document.getElementById("nvObPrev").disabled = (i === 0);
        document.getElementById("nvObNext").textContent =
          (i === cards.length - 1) ? "Book your first parcel" : "Next";
        wireDrag();
      }
      function finish(goBook){
        if (done) return; done = true;
        NV_ONBOARD_SHOWN = true;
        document.body.classList.remove("nvob-lock");
        nvOnboardMarkDone(cid);
        try{ ov.remove(); }catch(e){}
        document.removeEventListener("keydown", onKey);
        /* In demo the signup invitation waits for the deck, so a visitor is
           never shown two overlays at once. */
        try{ if(window.__NOVAX_DEMO && typeof window.__nvDemoArmInvite === "function") window.__nvDemoArmInvite(); }catch(e){}
        if (goBook) { try{ showClientTab("newBooking"); }catch(e){} }
      }
      var animating = false;
      function go(n, dir){
        if (animating) return;
        if (n < 0) { return; }
        if (n >= cards.length) { finish(true); return; }
        var card = document.getElementById("nvObCard");
        var reduce = false;
        try{ reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){}
        if (!card || reduce || !dir) { i = n; paint(dir); return; }
        /* Throw the old card out before the new one arrives, so the deck reads
           as one continuous motion instead of a hard swap. */
        animating = true;
        var away = dir === 1 ? 118 : -118;
        card.style.transition = "transform .24s cubic-bezier(.4,0,1,1),opacity .24s";
        card.style.transform  = "translate3d(" + away + "%,0,0) rotate(" + (dir * 11) + "deg)";
        card.style.opacity    = "0";
        setTimeout(function(){ animating = false; i = n; paint(dir); }, 200);
      }
      function onKey(e){
        if (e.key === "Escape") finish(false);
        else if (e.key === "ArrowRight") go(i + 1, 1);
        else if (e.key === "ArrowLeft") go(i - 1, -1);
      }
      document.addEventListener("keydown", onKey);
      document.getElementById("nvObSkip").addEventListener("click", function(){ finish(false); });
      document.getElementById("nvObNext").addEventListener("click", function(){ go(i + 1, 1); });
      document.getElementById("nvObPrev").addEventListener("click", function(){ go(i - 1, -1); });

      /* Drag: translate + a little rotation, commit past 90px or on a flick.
         Right advances, left goes back -- both directions navigate, because
         there is nothing here to accept or reject and a merchant who swipes
         back expects the previous card. */
      function wireDrag(){
        var card = document.getElementById("nvObCard");
        var x0 = null, t0 = 0, dx = 0, reduce = false;
        try{ reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){}
        card.addEventListener("pointerdown", function(e){
          x0 = e.clientX; t0 = Date.now(); dx = 0;
          card.setPointerCapture && card.setPointerCapture(e.pointerId);
          card.style.transition = "none";
        });
        card.addEventListener("pointermove", function(e){
          if (x0 === null) return;
          if (e.cancelable) e.preventDefault();   // the gesture is ours, not the page's
          dx = e.clientX - x0;
          card.style.transform = reduce
            ? "translateX(" + dx + "px)"
            : "translateX(" + dx + "px) rotate(" + (dx / 26) + "deg)";
          card.style.opacity = String(Math.max(.45, 1 - Math.abs(dx) / 420));
        });
        function release(){
          if (x0 === null) return;
          var fast = (Date.now() - t0) < 260 && Math.abs(dx) > 42;
          var commit = Math.abs(dx) > 90 || fast;
          x0 = null;
          if (commit) { go(dx < 0 ? i + 1 : i - 1, dx < 0 ? 1 : -1); return; }
          card.style.transition = reduce ? "none" : "transform .28s cubic-bezier(.2,.9,.25,1),opacity .28s";
          card.style.transform = ""; card.style.opacity = "";
        }
        card.addEventListener("pointerup", release);
        card.addEventListener("pointercancel", release);
        card.addEventListener("pointerleave", release);
      }

      paint();
    }

    if (NV_DEMO) {
      /* Installed BEFORE the gate reads window.__nvSb, so the gate never
         constructs a real client and never reaches getSession(). */
      window.__nvSb = nvDemoClient();
      window.__nvGuardSb = window.__nvSb;
      window.__nvDemoData = nvDemoSeed();
      window.__novaxVerifiedProfile = { role:"client", status:"active", clientId:"demo-client" };
      /* The data layer reuses the gate's session rather than re-fetching.
         Handing it a demo session makes the real loader run end to end:
         profiles -> client_id -> loadAll() -> the fixture. */
      window.__novaxGateSession = { user:{ id:"demo-user", email:"demo@novaxlogistics.com",
        user_metadata:{ role:"client", name:"Sana's Closet" } } };
      /* Nothing is stale here -- the numbers are the numbers. Suppresses the
         "Reconnecting, showing last known data" banner via its own API. */
      window.__novaxRealDataArrived = true;
      try{ var g=document.getElementById("nvAuthGate"); if(g) g.remove(); }catch(e){}
      document.addEventListener("DOMContentLoaded", function(){
        try{ var g2=document.getElementById("nvAuthGate"); if(g2) g2.remove(); }catch(e){}
      });
      nvDemoInstallUI();
      __resolveGate("demo-client");
      return;
    }

    /* ── Demo chrome: banner, blocked-write prompt, 25s invitation ────────
       Motion discipline is inherited from the landing page: transform and
       opacity only, so everything stays on the compositor and never triggers
       layout. The audience is mid-range Android over patchy 4G, and a demo
       that stutters sells the opposite of what it claims. Everything
       collapses to its finished state under prefers-reduced-motion. */
    function nvDemoInstallUI(){
      var SIGNUP = "index.html?src=demo#signup";
      var css = document.createElement("style");
      css.textContent = [
        "@keyframes nvdIn{from{opacity:0;transform:translateY(-100%)}to{opacity:1;transform:none}}",
        "@keyframes nvdPop{0%{opacity:0;transform:translateY(22px) scale(.94)}",
          "60%{opacity:1;transform:translateY(-4px) scale(1.012)}100%{opacity:1;transform:none}}",
        "@keyframes nvdFade{from{opacity:0}to{opacity:1}}",
        "@keyframes nvdPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}",
        "@keyframes nvdSheen{0%{transform:translateX(-120%)}100%{transform:translateX(220%)}}",
        "@keyframes nvdRise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}",
        /* top banner */
        ".nvd-bar{position:fixed;top:0;left:0;right:0;z-index:100000;display:flex;align-items:center;gap:10px;",
          "padding:calc(8px + env(safe-area-inset-top)) 14px 8px;",
          "background:linear-gradient(90deg,#0e2c1f,#123c2a 55%,#0e2c1f);color:#eaf7f0;",
          "border-bottom:1px solid rgba(20,199,123,.38);font-size:12.5px;font-weight:600;",
          "box-shadow:0 10px 30px -18px rgba(0,0,0,.9);animation:nvdIn .5s cubic-bezier(.2,.9,.25,1) both}",
        ".nvd-dot{width:7px;height:7px;border-radius:50%;background:#14c77b;flex:0 0 auto;",
          "box-shadow:0 0 0 0 rgba(20,199,123,.6);animation:nvdPulse 2.2s ease-in-out infinite}",
        ".nvd-bar b{color:#fff;font-weight:750}",
        ".nvd-bar .nvd-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".nvd-cta{position:relative;overflow:hidden;flex:0 0 auto;background:linear-gradient(135deg,#14c77b,#0fa968);",
          "color:#04140c;border:0;border-radius:999px;padding:7px 15px;font:inherit;font-weight:800;",
          "font-size:12px;cursor:pointer;text-decoration:none;white-space:nowrap;",
          "transition:transform .18s cubic-bezier(.2,.9,.25,1),filter .18s}",
        ".nvd-cta:hover{transform:translateY(-1px);filter:brightness(1.07)}",
        ".nvd-cta:active{transform:translateY(0) scale(.97)}",
        ".nvd-cta::after{content:'';position:absolute;top:0;bottom:0;width:38%;",
          "background:linear-gradient(90deg,transparent,rgba(255,255,255,.42),transparent);",
          "animation:nvdSheen 3.6s ease-in-out infinite}",
        ".nvd-exit{flex:0 0 auto;color:#9fd8bd;text-decoration:none;font-size:11.5px;font-weight:650;opacity:.9}",
        ".nvd-exit:hover{opacity:1;text-decoration:underline}",
        /* push the app down so nothing hides behind the bar */
        "body.nvd-on{padding-top:calc(42px + env(safe-area-inset-top))}",
        /* modal */
        ".nvd-ov{position:fixed;inset:0;z-index:100001;display:none;align-items:center;justify-content:center;",
          "padding:20px;background:rgba(3,10,7,.72);backdrop-filter:blur(4px);animation:nvdFade .28s ease both}",
        ".nvd-ov.on{display:flex}",
        ".nvd-card{width:100%;max-width:392px;background:linear-gradient(180deg,#10201a,#0b1712);",
          "border:1px solid rgba(20,199,123,.34);border-radius:20px;padding:24px 22px 20px;color:#eaf7f0;",
          "box-shadow:0 40px 110px -30px rgba(0,0,0,.95);animation:nvdPop .46s cubic-bezier(.2,.9,.25,1) both}",
        ".nvd-card h3{margin:0 0 8px;font-size:19px;line-height:1.25;color:#fff;letter-spacing:-.01em}",
        ".nvd-card p{margin:0 0 16px;font-size:13.5px;line-height:1.6;color:#a9c7ba}",
        ".nvd-card .nvd-b{animation:nvdRise .4s cubic-bezier(.2,.9,.25,1) both}",
        ".nvd-card .nvd-b:nth-child(2){animation-delay:.06s}",
        ".nvd-card .nvd-b:nth-child(3){animation-delay:.12s}",
        ".nvd-list{margin:0 0 18px;padding:0;list-style:none;display:grid;gap:9px}",
        ".nvd-list li{display:grid;grid-template-columns:18px 1fr;gap:9px;font-size:13px;color:#c8e2d6;",
          "animation:nvdRise .42s cubic-bezier(.2,.9,.25,1) both}",
        ".nvd-list li:nth-child(1){animation-delay:.10s}.nvd-list li:nth-child(2){animation-delay:.17s}",
        ".nvd-list li:nth-child(3){animation-delay:.24s}",
        ".nvd-list li::before{content:'✓';color:#14c77b;font-weight:800}",
        ".nvd-go{display:block;width:100%;text-align:center;background:linear-gradient(135deg,#14c77b,#0fa968);",
          "color:#04140c;border:0;border-radius:13px;padding:14px;font:inherit;font-weight:800;font-size:15px;",
          "cursor:pointer;text-decoration:none;position:relative;overflow:hidden;",
          "transition:transform .18s cubic-bezier(.2,.9,.25,1),filter .18s}",
        ".nvd-go:hover{transform:translateY(-1px);filter:brightness(1.07)}.nvd-go:active{transform:none}",
        ".nvd-go::after{content:'';position:absolute;top:0;bottom:0;width:34%;",
          "background:linear-gradient(90deg,transparent,rgba(255,255,255,.4),transparent);",
          "animation:nvdSheen 3.2s ease-in-out infinite}",
        ".nvd-later{display:block;width:100%;margin-top:10px;background:none;border:0;color:#8fb3a3;",
          "font:inherit;font-size:12.5px;cursor:pointer;padding:8px}",
        ".nvd-later:hover{color:#cfe8dd}",
        "@media (max-width:700px){.nvd-bar{font-size:11.5px;gap:8px;padding-left:11px;padding-right:11px}",
          ".nvd-bar .nvd-exit{display:none}.nvd-cta{padding:7px 13px}",
          /* The long sentence ellipsises at 375px and reads as broken. Swap
             in a short version rather than letting it trail off. */
          ".nvd-txt-long{display:none}.nvd-txt-short{display:inline}",
          /* Body already clears the bottom nav (58px) but not the Autopilot
             FAB above it, so the FAB sits on top of card actions -- audit
             finding 18. Scoped to the demo: this is the surface prospects
             judge, and widening it to every merchant is a separate change. */
          "body.nvd-on{padding-bottom:calc(126px + env(safe-area-inset-bottom))}}",
        "@media (prefers-reduced-motion:reduce){.nvd-bar,.nvd-card,.nvd-list li,.nvd-card .nvd-b{animation:none!important}",
          ".nvd-dot,.nvd-cta::after,.nvd-go::after{animation:none!important}",
          ".nvd-cta,.nvd-go{transition:none!important}}"
      ].join("");
      document.head.appendChild(css);

      function build(){
        document.body.classList.add("nvd-on");

        var bar = document.createElement("div");
        bar.className = "nvd-bar";
        bar.innerHTML =
          '<span class="nvd-dot" aria-hidden="true"></span>' +
          '<span class="nvd-txt">' +
            '<span class="nvd-txt-long">You are exploring a <b>live demo</b> with sample parcels. Nothing here is real.</span>' +
            '<span class="nvd-txt-short" style="display:none"><b>Live demo</b> · sample data</span>' +
          '</span>' +
          '<a class="nvd-cta" href="' + SIGNUP + '">Start shipping free</a>' +
          '<a class="nvd-exit" href="index.html">Exit demo</a>';
        document.body.appendChild(bar);

        var ov = document.createElement("div");
        ov.className = "nvd-ov"; ov.id = "nvdOverlay";
        ov.setAttribute("role","dialog"); ov.setAttribute("aria-modal","true");
        ov.innerHTML =
          '<div class="nvd-card">' +
            '<h3 class="nvd-b" id="nvdTitle">This is the portal you get.</h3>' +
            '<p class="nvd-b" id="nvdBody">Everything you just used is what a NovaX merchant sees on day one — with their own parcels in it.</p>' +
            '<ul class="nvd-list">' +
              '<li>Your COD in a wallet you can reconcile to the rupee</li>' +
              '<li>Real status on every parcel, not a scraped feed</li>' +
              '<li>An assistant that answers from your own data</li>' +
            '</ul>' +
            '<a class="nvd-go" href="' + SIGNUP + '">Sign up as a NovaX merchant</a>' +
            '<button class="nvd-later" type="button" id="nvdLater">Keep looking around</button>' +
          '</div>';
        document.body.appendChild(ov);

        function close(){ ov.classList.remove("on"); }
        ov.addEventListener("click", function(e){ if(e.target === ov) close(); });
        document.getElementById("nvdLater").addEventListener("click", close);
        document.addEventListener("keydown", function(e){ if(e.key === "Escape") close(); });

        /* Shown once, 25s in -- long enough to have actually looked around,
           early enough to catch them while still interested. Dismissing is
           final: a demo that nags is a demo people close. */
        var invited = false;
        window.__nvDemoInvite = function(title, body){
          if (invited) return; invited = true;
          if (title) document.getElementById("nvdTitle").textContent = title;
          if (body)  document.getElementById("nvdBody").textContent  = body;
          ov.classList.add("on");
        };
        /* The onboarding deck also shows in demo, and two stacked overlays
           is a worse first impression than either alone. So the invitation is
           armed by the deck when it finishes rather than started on load. If
           the deck never appears for some reason, this still arms on its own
           so the demo is never left without a way to convert. */
        var armed = false;
        window.__nvDemoArmInvite = function(){
          if (armed) return; armed = true;
          setTimeout(function(){ window.__nvDemoInvite(); }, 25000);
        };
        setTimeout(function(){
          if (!document.getElementById("nvObDeck")) window.__nvDemoArmInvite();
        }, 1200);

        /* A blocked write is the moment of intent, so it asks rather than
           saying "disabled". If the invitation has already been used, fall
           back to a toast so the action still explains itself. */
        window.nvDemoPrompt = function(what){
          var verb = what === "delete" ? "remove this" : "do that";
          if (!invited) {
            window.__nvDemoInvite(
              "Create your account to " + verb + ".",
              "The demo is read-only so nobody can change the sample data. Your own workspace is free and takes about a minute.");
            return;
          }
          try{ if(typeof toast === "function"){
            toast("Demo mode — create your free account to " + verb + "."); return; } }catch(e){}
          ov.classList.add("on");
        };
      }

      if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", build);
      else build();
    }


    function clearLocalSession(){ try{ localStorage.removeItem("novaxSession"); }catch(e){} }
    function redirectAway(url){ clearLocalSession(); window.location.replace(url); }
    var __gsb=null;
    try{ __gsb=window.__nvSb||null; if(!__gsb&&window.supabase&&window.supabase.createClient){ __gsb=window.supabase.createClient(__SB_URL,__SB_KEY); } }catch(__e){}
    // NovaX fix: publish the gate's client so the data layer below reuses this
    // exact instance instead of constructing a second GoTrueClient on the same
    // storage key (which races on token refresh).
    window.__nvGuardSb=__gsb;
    if(__gsb && !window.__nvSb) window.__nvSb=__gsb;
    function denyWithError(){
      // NovaX fix: a profile lookup error (or missing/invalid role) must
      // never let the page silently continue -- sign the session out and
      // bounce to index.html with a clear, inspectable error flag instead.
      try{ if(__gsb&&__gsb.auth) __gsb.auth.signOut(); }catch(e){}
      redirectAway("index.html?authError=1");
    }
    if(!__gsb||!__gsb.auth){ denyWithError(); return; }
    __gsb.auth.getSession().then(function(r){
      try{ window.__novaxGateSession=(r&&r.data&&r.data.session)||null; }catch(e){}
      var session=r&&r.data&&r.data.session;
      if(!session){ redirectAway("index.html"); return; }
      // NovaX fix (auth flow v3): read the auth email and signup metadata
      // role FIRST, before ever fetching profiles. A known admin email or
      // an auth-metadata role of admin/staff/rider routes to the correct
      // portal immediately -- a second, independent line of defense that
      // never depends on a profiles lookup succeeding or being correct.
      var __sessionEmail=String((session.user&&session.user.email)||"").toLowerCase();
      var __signupMeta=(session.user&&session.user.user_metadata)||{};
      var __metaRole=String(__signupMeta.role||"").toLowerCase();
      if(__ADMIN_EMAIL_DENYLIST.indexOf(__sessionEmail)>-1){
        console.warn("NovaX auth gate: this email is a known admin login -- routing to admin.html without trusting profiles.role for the Client Portal. Fix the profiles row (see novax_role_hard_stop_v2_repair.sql) so this override is no longer needed.");
        redirectAway("admin.html");
        return;
      }
      if(__ADMIN_ROLES.indexOf(__metaRole)>-1){ redirectAway("admin.html"); return; }
      if(__metaRole==="rider"){ redirectAway("rider.html"); return; }
      __gsb.from("profiles").select("role,status,client_id").eq("id",session.user.id).single().then(function(p){
        if(p&&p.error){
          console.warn("NovaX auth gate: profile lookup failed",p.error.message);
          // NovaX fix (auth flow v4): a missing/failed profiles row is no
          // longer an automatic hard stop. If this account's own signup
          // metadata proves it came from the public merchant signup form
          // (user_metadata.role === "client", already read above as
          // __metaRole), let the existing one-time workspace recovery below
          // run create_client_workspace instead of denying a verified new
          // merchant who is only stuck because email confirmation delayed
          // their profile row. Any other missing-profile role is still an
          // immediate, safe hard stop -- and admin/rider metadata already
          // redirected above, before this profiles fetch ever ran.
          if(__metaRole==="client"){
            window.__novaxAllowWorkspaceRecovery=true;
            window.__novaxVerifiedProfile={ role:"client", status:"active", clientId:null };
            var __gateElRecover=document.getElementById("nvAuthGate"); if(__gateElRecover) __gateElRecover.style.display="none";
            __resolveGate(null);
            return;
          }
          denyWithError();
          return;
        }
        var role=p&&p.data?String(p.data.role||"").toLowerCase():"";
        var status=p&&p.data?String(p.data.status||"").toLowerCase():"";
        var clientId=p&&p.data?p.data.client_id:null;
        if(!role){ denyWithError(); return; }
        if(status==="blocked"||status==="disabled"){ denyWithError(); return; }
        if(__ADMIN_ROLES.indexOf(role)>-1){ redirectAway("admin.html"); return; }
        if(role==="rider"){ redirectAway("rider.html"); return; }
        if(role!=="client"){
          // Unrecognized/invalid role that isn't admin-like, rider, or
          // client -- treat as an error rather than guessing a portal.
          denyWithError();
          return;
        }
        // Verified: real Supabase session + profiles.role === "client". Only
        // now is it safe to reveal the portal and let client data load.
        // NovaX fix (role hard-stop v2): capture whether this account's own
        // signup metadata proves it came from the public merchant signup
        // form (user_metadata.role === "client"). The one-time workspace
        // recovery below is only ever allowed to run when this is true --
        // otherwise a client-role account with a missing client_id gets a
        // hard "Workspace not linked" stop instead of an invented dashboard.
        window.__novaxAllowWorkspaceRecovery=(__metaRole==="client");
        window.__novaxVerifiedProfile={ role:role, status:status, clientId:clientId||null };
        var gateEl=document.getElementById("nvAuthGate"); if(gateEl) gateEl.style.display="none";
        __resolveGate(clientId||null);
      }).catch(function(e){ console.warn("NovaX auth gate: profile lookup error",e); denyWithError(); });
    }).catch(function(e){ console.warn("NovaX auth gate: session lookup error",e); denyWithError(); });
  })();
  
/* ==== client.html inline block #6 ==== */

    const PKR = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });
    const now = () => new Date();
    const time = () => now().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const STORAGE_KEY = "novaxLogisticsStateV10";
    const SB_URL = window.NOVAX_CONFIG.SB_URL; // shared Supabase base URL (also used by connectStore, shopifyGenerateLink)
    /* NovaX status rename: "Parcel returned to consignee" -> "Return to shipper".
       A return goes back to the SHIPPER (the merchant), never to the consignee
       -- the old label was simply wrong. The string is a STORED value in
       parcels.status, so rows written before the migration still carry the old
       text. nvStatus() normalises on read, which means the portal is correct
       whether or not sql/novax_return_to_shipper_v1.sql has been run yet, and
       old rows arriving from an un-upgraded rider app keep working too. */
    var NV_STATUS_ALIASES = { "Parcel returned to consignee": "Return to shipper" };
    function nvStatus(s){
      s = String(s == null ? "" : s);
      return NV_STATUS_ALIASES[s] || s;
    }
    const STATUS_TAGS = ["New booked","Collected by rider","Arrived at warehouse","Parcel now in transit","Parcel received at destination","Parcel out for delivery","Delivered","Refused","Consignee not available","Reattempt","Reassigned","Out of service area","Ready for return","Return in transit","Return received at origin","Return out for delivery","Return to shipper"];
    // NovaX (client identity leak safeguard): baseState below is DEMO/OFFLINE
    // FALLBACK DATA ONLY. It seeds local UI state before any Supabase session
    // check runs, purely so the page has something to paint on first frame.
    // It is unconditionally overwritten (state.client, state.clients,
    // state.parcels, state.invoices, etc. all reset to empty/"Loading...")
    // a few lines below, before the real Supabase profile/client_id lookup
    // runs and before the first render() call -- so this stale cross-client demo
    // name must never actually reach the screen for a logged-in user. Do not
    // remove the overwrite block below without also removing this data.
    const baseState = {
      selectedAwb:"SAMPLE-AWB-1", activeStatusQueue:"Parcel now in transit", activeRateClient:"", activeSackMode:"create",
      clientDateFrom:"2026-06-01", clientDateTo:"2026-06-24", lastGeneratedAwb:"SAMPLE-AWB-1",
      walletWithdrawals:[], pickupRequests:[], lastBulkAwbs:[], walletWithdrawSpeed:"",
      // NovaX fix (wallet IBAN UX): bank details now live independently of
      // any withdrawal request, so a client can save them at Rs 0 balance.
      clientBankDetails:null, bankDetailsEditing:false,
      // NovaX fix (identity leak hardening): identityVerified starts false and
      // is only ever flipped to true once the real Supabase profile/client
      // lookup resolves (success, not-linked, or record-missing). Every
      // render path that shows a client name must check identityVerified
      // first, so this sample data can never visibly surface even if the
      // reset-on-load code below fails to run or a stale cache is restored.
      identityVerified:false, accountNotLinked:false, clientRecordMissing:false,
      client:{ id:"SAMPLE-OFFLINE", name:"Sample Client (offline demo data - not a real account)", walletTopup:85000, shippingDue:18400, premiumTier:"Gold", subAccounts:6, walletBalance:12090 },
      clients:[
        { id:"SAMPLE-OFFLINE", name:"Sample Client (offline demo data - not a real account)", owner:"Sample Finance Contact", tier:"Gold", city:"Karachi", walletTopup:85000, shippingDue:18400, risk:18, status:"Active", rate:240, rateCard:{overnight:240,additionalKg:80,detainBase:520,detainAdditionalKg:120,overlandBase:900,overlandAdditionalKg:45}, problemsResolved:18, health:91, walletBalance:12090 },
        { id:"SAMPLE-OFFLINE-2", name:"Sample Client B (offline demo data - not a real account)", owner:"Ali Ops", tier:"Silver", city:"Islamabad", walletTopup:52000, shippingDue:9200, risk:24, status:"Active", rate:220, rateCard:{overnight:220,additionalKg:75,detainBase:500,detainAdditionalKg:110,overlandBase:860,overlandAdditionalKg:42}, problemsResolved:9, health:86, walletBalance:0 },
        { id:"SAMPLE-OFFLINE-3", name:"Sample Client C (offline demo data - not a real account)", owner:"Mina Support", tier:"Starter", city:"Rawalpindi", walletTopup:28000, shippingDue:5100, risk:36, status:"Watch", rate:260, rateCard:{overnight:260,additionalKg:90,detainBase:560,detainAdditionalKg:130,overlandBase:940,overlandAdditionalKg:48}, problemsResolved:5, health:73, walletBalance:0 }
      ],
      pendingClients:[],
      users:[
        { id:"USR-001", name:"Sample Finance Contact", role:"Finance", branch:"Karachi Hub", clientId:"SAMPLE-OFFLINE", status:"Active" },
        { id:"USR-002", name:"Ali Ops", role:"Branch Manager", branch:"Islamabad Hub", clientId:"SAMPLE-OFFLINE-2", status:"Active" }
      ],
      branches:[
        { name:"Karachi Hub", scanHealth:94, cashHealth:88, discrepancy:1 },
        { name:"Lahore Hub", scanHealth:91, cashHealth:96, discrepancy:0 },
        { name:"Islamabad Hub", scanHealth:86, cashHealth:72, discrepancy:3 }
      ],
      riders:[
        { id:"R-17", name:"Usman", username:"usman.r17", manager:"Lahore Hub Manager", cashHeld:62500, cashLimit:75000, scans:38, fakeRisk:9, access:"Active", expenses:0 },
        { id:"R-22", name:"Bilal", username:"bilal.r22", manager:"Karachi Hub Manager", cashHeld:103000, cashLimit:90000, scans:44, fakeRisk:22, access:"Blocked", expenses:0 },
        { id:"R-31", name:"Hamza", username:"hamza.r31", manager:"Islamabad Hub Manager", cashHeld:19500, cashLimit:60000, scans:29, fakeRisk:6, access:"Active", expenses:0 }
      ],
      parcels:[
        { awb:"SAMPLE-AWB-1", clientId:"SAMPLE-OFFLINE", date:"2026-06-24", consignee:"Sample Consignee A", city:"Lahore", cod:7200, fee:240, status:"Parcel out for delivery", statusAgeHours:8, stage:6, totalStages:9, rider:"R-17", branch:"Lahore Hub", risk:14, updated:"09:38", exception:"", cashReceived:false, returnProof:"", resolutionRemark:"", phone:"+92 3XX-XXXXXXX", address:"Sample Address, Lahore", service:"COD Standard", weight:"0.8 kg", steps:["New booked","Collected by rider","Arrived at warehouse","Parcel now in transit","Parcel received at destination","Parcel out for delivery"] },
        { awb:"SAMPLE-AWB-2", clientId:"SAMPLE-OFFLINE", date:"2026-06-23", consignee:"Sample Consignee B", city:"Karachi", cod:12400, fee:310, status:"Delivered", statusAgeHours:11, stage:8, totalStages:9, rider:"R-22", branch:"Karachi Hub", risk:32, updated:"10:12", exception:"Cash above rider limit", cashReceived:false, returnProof:"", resolutionRemark:"", phone:"+92 3XX-XXXXXXX", address:"Sample Address, Karachi", service:"COD Express", weight:"1.2 kg", steps:["New booked","Collected by rider","Arrived at warehouse","Parcel now in transit","Parcel received at destination","Parcel out for delivery","Delivered","COD collected","Rider holding cash"] },
        { awb:"SAMPLE-AWB-4", clientId:"SAMPLE-OFFLINE-2", date:"2026-06-22", consignee:"Sample Client B", city:"Islamabad", cod:4500, fee:220, status:"Parcel now in transit", statusAgeHours:76, stage:4, totalStages:9, rider:"R-17", branch:"Islamabad Hub", risk:18, updated:"08:57", exception:"", cashReceived:false, returnProof:"", resolutionRemark:"", phone:"+92 3XX-XXXXXXX", address:"Sample Address, Islamabad", service:"COD Standard", weight:"0.6 kg", steps:["New booked","Collected by rider","Arrived at warehouse","Parcel now in transit"] },
        { awb:"SAMPLE-AWB-5", clientId:"SAMPLE-OFFLINE-3", date:"2026-06-20", consignee:"Sample Client C", city:"Rawalpindi", cod:15800, fee:360, status:"Collected by rider", statusAgeHours:19, stage:2, totalStages:9, rider:"R-17", branch:"Karachi Hub", risk:11, updated:"10:45", exception:"", cashReceived:false, returnProof:"", resolutionRemark:"", phone:"+92 3XX-XXXXXXX", address:"Sample Address, Rawalpindi", service:"COD Standard", weight:"1.0 kg", steps:["New booked","Collected by rider"] },
        { awb:"SAMPLE-AWB-3", clientId:"SAMPLE-OFFLINE", date:"2026-06-19", consignee:"Sample Consignee C", city:"Lahore", cod:9800, fee:280, status:"Refused", statusAgeHours:31, stage:6, totalStages:9, rider:"R-22", branch:"Lahore Hub", risk:78, updated:"07:31", exception:"Consignee denies refusal attempt", cashReceived:false, returnProof:"Return proof pending from rider manager", resolutionRemark:"", phone:"+92 3XX-XXXXXXX", address:"Sample Address, Lahore", service:"COD Standard", weight:"0.9 kg", riderInput:{ attemptTime:"07:31", gps:"31.5204, 74.3587", callProof:"1 call, 18 seconds", riderNote:"Consignee refused delivery at gate", photoProof:"Door photo captured" }, steps:["New booked","Collected by rider","Arrived at warehouse","Parcel now in transit","Parcel received at destination","Parcel out for delivery","Refused"] }
      ],
      expenses:[
        { id:"EXP-001", name:"Fuel", amount:38000, type:"Fuel", owner:"Karachi Hub", status:"Approved" },
        { id:"EXP-002", name:"Branch rent", amount:110000, type:"Branch rent", owner:"Lahore Hub", status:"Approved" }
      ],
      paymentLogs:[
        { id:"PAY-001", clientId:"SAMPLE-OFFLINE", type:"COD collected", amount:12400, status:"Rider holding", ref:"SAMPLE-AWB-2" },
        { id:"PAY-002", clientId:"SAMPLE-OFFLINE", type:"Shipping fee deducted", amount:310, status:"Ledger posted", ref:"SAMPLE-AWB-2" },
        { id:"PAY-003", clientId:"SAMPLE-OFFLINE", type:"Invoice pushed to wallet", amount:12090, status:"Wallet credited", ref:"INV-0001" }
      ],
      invoices:[
        { id:"INV-0001", clientId:"SAMPLE-OFFLINE", parcelRefs:["SAMPLE-AWB-2"], cod:12400, charges:310, payable:12090, status:"Pushed to wallet", createdAt:"2026-06-24 10:30", paidAt:"", walletPushedAt:"2026-06-24 10:31", summary:"1 delivered parcel, payable pushed to wallet" }
      ],
      transit:[
        { id:"SACK-KHI-LHE-44", from:"Karachi Hub", to:"Lahore Hub", expected:1000, scanned:998, demanifested:991, health:88, status:"Active", type:"parcel sack" }
      ],
      completedSacks:[],
      operationsIssues:[
        { id:"OPS-001", branch:"Lahore Hub", urgency:"super urgent", problem:"Transit aging over 3 days", awb:"SAMPLE-AWB-4", openedHours:6, resolved:false }
      ],
      resolvedAlerts:[]
    };
    /* Above cleanStartState() on purpose: that function runs at top level on a
       first load with no cached state. Declared further down the file it was
       still undefined at that point and the blank workspace seeded an
       undefined rate -- the same trap already fixed in admin.html. */
    var NV_ZONE_A_BASE=200;
    function cleanStartState(){
      const blankClient={ id:"CL-0000", name:"New Merchant Workspace", owner:"", city:"", walletTopup:0, shippingDue:0, risk:0, status:"Draft", rate:NV_ZONE_A_BASE, rateCard:defaultRateCard(NV_ZONE_A_BASE), problemsResolved:0, health:0, walletBalance:0 };
      return {
        _cleanStartV2:true,
        selectedAwb:"", activeStatusQueue:STATUS_TAGS[0], activeRateClient:"", activeSackMode:"create",
        clientDateFrom:new Date().toISOString().slice(0,10), clientDateTo:new Date().toISOString().slice(0,10), lastGeneratedAwb:"",
        walletWithdrawals:[], pickupRequests:[], lastBulkAwbs:[], walletWithdrawSpeed:"", clientBankDetails:null, bankDetailsEditing:false,
        client:{ id:"CL-0000", name:"New Merchant Workspace", walletTopup:0, shippingDue:0, subAccounts:0, walletBalance:0 },
        clients:[blankClient], pendingClients:[], users:[], branches:[], riders:[], parcels:[], expenses:[], paymentLogs:[], invoices:[], transit:[], completedSacks:[], operationsIssues:[], resolvedAlerts:[],
        activeClientTab:"dashboard"
      };
    }
    let state = loadState();
    if (!state._cleanStartV2) {
      state = cleanStartState();
      localStorage.setItem(STORAGE_KEY, persistStateJson());
    }
    normalizeStateAwbs(state);
    state.activeClientTab = (typeof normalizeClientTab==="function")
      ? normalizeClientTab(state.activeClientTab)
      : (state.activeClientTab || "dashboard");
    (function(){
      try{
        var qp=new URLSearchParams(location.search);
        var cachedMine=(state.parcels||[]).filter(function(p){ return p && state.client && p.clientId===state.client.id; });
        if((qp.get("welcome")==="1"||qp.get("firstBooking")==="1") && !localStorage.getItem("novaxFirstBookingSeen") && cachedMine.length===0){
          state.activeClientTab="newBooking";
          localStorage.setItem("novaxFirstBookingSeen","1");
        }
      }catch(e){}
    })();
    state.activeStatusQueue = state.activeStatusQueue || STATUS_TAGS[0];
    state.walletWithdrawals = Array.isArray(state.walletWithdrawals) ? state.walletWithdrawals : [];
    state.pickupRequests = Array.isArray(state.pickupRequests) ? state.pickupRequests : [];
    state.lastBulkAwbs = Array.isArray(state.lastBulkAwbs) ? state.lastBulkAwbs : [];
    state.storeConnections = Array.isArray(state.storeConnections) ? state.storeConnections : [];
    state.walletWithdrawSpeed = state.walletWithdrawSpeed || "";
    state.clients.forEach(c => { c.walletBalance = Number(c.walletBalance || 0); });
    (state.parcels || []).forEach(p => { if (!p.statusSince) p.statusSince = new Date(Date.now() - Number(p.statusAgeHours || 0) * 3600000).toISOString(); });
    state._walletSeeded = true;

    /* NovaX fix (blank portal on older phones): loadState() called
   structuredClone() inside try AND again inside catch. structuredClone needs
   Chrome 98+ / Safari 15.4+, so on an older browser the first call threw, the
   catch threw the same ReferenceError, and nothing caught it — the portal
   loaded blank with no error the merchant could act on. nvClone falls back to
   a JSON round-trip; baseState is plain JSON-safe data so nothing is lost. */
function nvClone(o){
  try{ if(typeof structuredClone==="function") return structuredClone(o); }catch(e){}
  try{ return JSON.parse(JSON.stringify(o)); }catch(e){ return {}; }
}
function loadState(){ try{ const s=localStorage.getItem(STORAGE_KEY); return s?JSON.parse(s):nvClone(baseState); }catch(e){ return nvClone(baseState); } }
    // NovaX fix (PII leak through localStorage): the portal used to serialise
    // the whole state object, including the unmasked IBAN + bank holder name
    // and every consignee's phone/address. Those fields are now kept in the
    // in-memory state object only and stripped out on the way to storage.
    // clientBankDetails is re-fetched from Supabase by the existing bank
    // details routine, and parcel phone/address are re-hydrated by loadAll().
    const NOVAX_NEVER_PERSIST_KEYS = ["clientBankDetails"];
    /* AUDIT FIX (low): trackingToken added. Each one is a customer-facing
       secret that exposes COD amount and consignee name; persisting the
       merchant's entire parcel history of them to localStorage made every
       token readable by any XSS anywhere on this origin. They are re-read
       from the server on load, so nothing is lost by not storing them. */
    const NOVAX_PARCEL_PII_KEYS = ["phone","address","trackingToken"];
    function persistableState(){
      try{
        const copy = {};
        Object.keys(state).forEach(function(k){ if(NOVAX_NEVER_PERSIST_KEYS.indexOf(k)===-1) copy[k]=state[k]; });
        if(Array.isArray(copy.parcels)){
          copy.parcels = copy.parcels.map(function(p){
            if(!p || typeof p!=="object") return p;
            const clean={};
            Object.keys(p).forEach(function(k){ if(NOVAX_PARCEL_PII_KEYS.indexOf(k)===-1) clean[k]=p[k]; });
            return clean;
          });
        }
        return copy;
      }catch(e){ return { _persistError:true }; }
    }
    function persistStateJson(){ return JSON.stringify(persistableState()); }
    /* NovaX fix (portal lag): saveState() used to run a synchronous
       JSON.stringify(state) + localStorage.setItem on EVERY call, and it is
       called 22 times -- after each status change, invoice action, wallet push,
       assignment, etc. With thousands of parcels/invoices/ledger rows loaded,
       that is megabytes of JSON serialised on the main thread per click, which
       is what made generating an invoice and pushing to wallet feel frozen.

       The write is now coalesced: many calls in the same burst produce ONE
       write ~400ms later. Correctness is unaffected because this cache is only
       an optimisation -- Supabase is the source of truth -- and the pending
       write is flushed synchronously on pagehide/tab-hide so nothing is lost
       on refresh, navigation or close. nvSaveStateNow() forces an immediate
       write if a caller ever needs one. */
    var _nvSaveT = null, _nvSaveWarned = false;
    function nvWriteStateNow(){
      if(_nvSaveT){ clearTimeout(_nvSaveT); _nvSaveT = null; }
      try{ localStorage.setItem(STORAGE_KEY, persistStateJson()); }
      catch(e){
        if(!_nvSaveWarned){
          _nvSaveWarned = true;
          console.warn("NovaX: local cache write failed (" + ((e&&e.name)||"error") +
            "). The portal still works -- data is loaded from Supabase.");
        }
      }
    }
    function saveState(){
      if(_nvSaveT) clearTimeout(_nvSaveT);
      _nvSaveT = setTimeout(nvWriteStateNow, 400);
    }
    window.nvSaveStateNow = nvWriteStateNow;
    window.addEventListener("pagehide", function(){ if(_nvSaveT) nvWriteStateNow(); });
    document.addEventListener("visibilitychange", function(){
      if(document.visibilityState === "hidden" && _nvSaveT) nvWriteStateNow();
    });
    // NovaX fix (Medium #5): emptyParcel() is the canonical "No parcel
    // selected" placeholder. It never guesses a clientId either -- with no
    // linked client there is nothing valid to attach a placeholder parcel to.
    function emptyParcel(){ return { awb:"", clientId:(state.client&&state.client.id)||null, date:new Date().toISOString().slice(0,10), consignee:"No parcel selected", city:"", cod:0, fee:0, status:"New booked", statusAgeHours:0, stage:0, totalStages:STATUS_TAGS.length, rider:"", branch:"", risk:0, updated:"", exception:"", cashReceived:false, phone:"", address:"", service:"COD Standard", weight:"", steps:[] }; }
    // NovaX fix (Medium #5): removed the `|| state.parcels[0]` fallback. If
    // the selected AWB doesn't match a real parcel, show emptyParcel()'s
    // "No parcel selected" state directly instead of guessing the first
    // parcel in the list.
    function selectedParcel(){ return state.parcels.find(p=>p.awb===state.selectedAwb) || emptyParcel(); }
    function inClientDateRange(p){ const d=p.date||"2026-06-24"; const f=state.clientDateFrom||"2026-06-01"; const t=state.clientDateTo||"2026-06-24"; return d>=f && d<=t; }
    // NovaX fix (High #2): clientScopedParcels() must never fall back to the
    // demo/default placeholder client id. With no confirmed client identity, the
    // correct answer is an empty list, not another client's parcels.
    function clientScopedParcels(){ const id=state.client&&state.client.id; if(!id) return []; return state.parcels.filter(p=>p.clientId===id && inClientDateRange(p)); }
    const ZONE_CITY_MAP={ karachi:"A", lahore:"B", islamabad:"B", rawalpindi:"B" };
    function zoneForCity(city){ return ZONE_CITY_MAP[String(city||"").trim().toLowerCase()]||"B"; }
    function zoneLabel(zone){ return zone==="A"?"Zone A (Karachi)":"Zone B (Lahore / Islamabad / Rawalpindi)"; }
    /* NovaX Zone A base. This is the LAST-RESORT fallback used only when a
   client row has no rate and no rate card at all. It was 250 while the
   real Zone A rate in the database was 100, so a client with a missing
   rate card silently priced at a third number nobody chose. Kept in step
   with the DB rate (now 200) so the two cannot disagree. */
    function defaultRateCard(rate){ rate=rate||NV_ZONE_A_BASE; return { overnight:rate, additionalKg:85, detainBase:540, detainAdditionalKg:125, overlandBase:900, overlandAdditionalKg:45 }; }
    function normalizeRateCard(raw, rate){
      const fallback=defaultRateCard(rate);
      if(raw && raw.A && raw.B && typeof raw.A.overnight==="number" && typeof raw.B.overnight==="number"){
        return { A:Object.assign({},fallback,raw.A), B:Object.assign({},fallback,raw.B) };
      }
      const legacy=(raw && typeof raw.overnight==="number" && !isNaN(raw.overnight))?raw:fallback;
      return { A:legacy, B:Object.assign({},legacy) };
    }
    // NovaX (Booking Charge Accuracy): parse weight strings like "0.8 kg", "1kg", "2.5", "5 KG".
    function parseWeightKg(w){
      var s=String(w===undefined||w===null?"":w).trim().toLowerCase().replace(/kg/g,"").trim();
      var n=parseFloat(s);
      if(!s||isNaN(n)||n<=0) return 0.8;
      return n;
    }
    // charge = baseRate + ceil(max(0, weightKg-1)) * additionalKgRate, capped at the 5kg normal slab.
    function bookingChargeBreakdown(rateCard, zone, weightInput){
      var z=zone==="A"?"A":"B";
      var card=(rateCard&&rateCard[z])||(rateCard&&typeof rateCard.overnight==="number"?rateCard:defaultRateCard(NV_ZONE_A_BASE));
      var base=Number(card.overnight)||NV_ZONE_A_BASE;
      var addlRate=Number(card.additionalKg)||85;
      var weightKg=parseWeightKg(weightInput);
      var cappedKg=Math.min(weightKg,5);
      var extraKg=Math.ceil(Math.max(0,cappedKg-1));
      var additional=extraKg*addlRate;
      var total=base+additional;
      return { zone:z, weightKg:weightKg, base:base, addlRate:addlRate, extraKg:extraKg, additional:additional, total:total, overCap:weightKg>5 };
    }
    // NovaX fix (Medium #4): clientById() must never fall back to
    // state.clients[0]. That silently attached the first client's name/rate
    // card to AWB labels, invoices, reports, and wallet views whenever the
    // real client id didn't match. Return a clearly-labeled "unknown client"
    // placeholder instead so a mismatch is visible, not silently wrong.
    function unknownClientPlaceholder(){ return { id:null, name:"Unknown client", city:"", rate:0, rateCard:{}, walletBalance:0, walletTopup:0, shippingDue:0, risk:0, subAccounts:0, status:"" }; }
    function clientById(id){ if(!id) return unknownClientPlaceholder(); const found=state.clients.find(c=>c.id===id); if(found) return found; if(state.client && state.client.id===id) return state.client; return unknownClientPlaceholder(); }
    function clientCode(id){ const digits=String(id||"1").replace(/\D/g,""); return digits.slice(-3).padStart(3,"0"); }
    function shortAwbFor(clientId,counter){ return `N${clientCode(clientId)}${String(counter).padStart(4,"0")}`; }
    function nextAwbForClient(clientId){
      const prefix=`N${clientCode(clientId)}`;
      const max=state.parcels.filter(p=>String(p.awb||"").startsWith(prefix)).reduce((n,p)=>Math.max(n,Number(String(p.awb).slice(4))||0),0);
      return shortAwbFor(clientId,max+1);
    }
    function replaceAwbRefs(value,map){
      if(typeof value==="string") return map[value]||value;
      if(Array.isArray(value)) return value.map(v=>replaceAwbRefs(v,map));
      if(value&&typeof value==="object"){ Object.keys(value).forEach(k=>{ value[k]=replaceAwbRefs(value[k],map); }); }
      return value;
    }
    function normalizeStateAwbs(appState){
      const map={}, counts={};
      (appState.parcels||[]).forEach(p=>{
        if(!/^NX-/i.test(String(p.awb||""))) return;
        const code=clientCode(p.clientId);
        counts[code]=(counts[code]||0)+1;
        map[p.awb]=shortAwbFor(p.clientId,counts[code]);
      });
      if(Object.keys(map).length) replaceAwbRefs(appState,map);
    }
    /* NovaX fix: rider.html already guarded this as (p.steps||[]) after hitting
       the crash there, but the same guard was never propagated here or to admin.
       isDeliveredLedgerParcel() feeds clientMetrics() which feeds render(), so a
       single parcel arriving without steps (stale localStorage cache, legacy row)
       blanked the entire dashboard. */
    function isDeliveredLedgerParcel(p){ return p.status==="Delivered" || (p.steps||[]).includes("COD collected"); }
    // NovaX fix (dashboard/invoices/wallet desync): one canonical definition
    // of "this invoice is fully closed out -- nothing more is owed to or by
    // the client on it". Four different admin actions land an invoice here
    // (bank payout marked Paid, Pushed to wallet, delivery-charges Paid to
    // NovaX, or Settled), and every tile/chip/payable estimate across both
    // portals must agree on the same list or they drift, which is exactly
    // what happened: paidParcelRefs() below was frozen at "Paid"/"Pushed to
    // wallet" from an earlier fix, so a parcel whose invoice had gone all
    // the way to Settled still read as "unpaid" here -- Dashboard's Total
    // COD Payable tile kept counting it even though Payments showed the
    // invoice Settled and Wallet showed the payout already made. Every call
    // site that used to hardcode its own status list now reads this.
    /* Terminal parcel states. Once a parcel reaches one of these nothing
       about it can change, so it never needs to be in the live working set.
       "Parcel returned to consignee" is the legacy alias nvStatus() maps to
       "Return to shipper"; both are listed because the DB still holds rows
       written under the old name. */
    const NV_CLOSED_STATUSES=["Delivered","Return to shipper","Parcel returned to consignee","Cancelled"];
    const NV_INVOICE_CLOSED_STATUSES=["Paid","Pushed to wallet","Settled","Paid to NovaX"];
    function isInvoiceClosed(status){ return NV_INVOICE_CLOSED_STATUSES.indexOf(status)>-1; }
    function paidParcelRefs(){ return new Set(state.invoices.filter(i=>isInvoiceClosed(i.status)).flatMap(i=>i.parcelRefs||[])); }
    function isUnpaidDeliveredParcel(p){ return isDeliveredLedgerParcel(p) && !paidParcelRefs().has(p.awb); }
    /* ═══ What counts as a delivery attempt ═══════════════════════════════
       A delivery rate of delivered/ALL parcels punished the merchant for
       booking. A parcel booked five minutes ago that no rider has touched
       cannot have been delivered OR failed -- NovaX has not had its chance at
       it yet -- so counting it as a miss meant a good morning's booking run
       dragged the rate down, and the dashboard paints this metric amber below
       40%. Volume was literally turning the merchant's own scorecard orange.

       ratedTotal is the honest denominator: parcels NovaX has actually taken
       responsibility for. Excluded:
         - "New booked"        -- not collected yet, no attempt has happened
         - "Cancelled by client" -- the merchant pulled it; not a failed delivery
       Parcels in transit stay IN the denominator. They are live commitments,
       and hiding them would flatter the number.

       cm.total is untouched, so "My Parcels" still counts everything. */
    function nvIsRatedParcel(p){
      if(!p) return false;
      var st=String(p.status||"").trim();
      if(!st) return false;
      if(st==="New booked") return false;
      if(st==="Cancelled by client") return false;
      return true;
    }
    function clientMetrics(){
      const parcels=clientScopedParcels();
      const delivered=parcels.filter(p=>p.status.includes("Delivered")).length;
      const ratedTotal=parcels.filter(nvIsRatedParcel).length;
      const deliveredParcels=parcels.filter(isDeliveredLedgerParcel);
      const unpaid=parcels.filter(isUnpaidDeliveredParcel);
      const codCollected=deliveredParcels.reduce((s,p)=>s+p.cod,0);
      const deliveryCharges=deliveredParcels.reduce((s,p)=>s+p.fee,0);
      const payable=Math.max(0,unpaid.reduce((s,p)=>s+p.cod-p.fee,0));
      const avgProgress=parcels.length?parcels.reduce((s,p)=>s+(p.stage/p.totalStages),0)/parcels.length:0;
      return { parcels, delivered, total:parcels.length, ratedTotal, codCollected, deliveryCharges, payable, avgProgress };
    }
    function isRiderCashHolding(p){
      if(!p) return false;
      var exc=String(p.exception||"");
      if(p.status==="Delivered" && p.cashReceived===false) return true;
      if(/cash/i.test(exc) && !/collected/i.test(exc)) return true;
      if(/rider holding cash/i.test(exc)) return true;
      if(p.steps && p.steps.some(function(s){ return /rider holding cash/i.test(s); })) return true;
      return false;
    }
    function isUnprintedLabel(p){
      if(!p || p.status!=="New booked") return false;
      var printed=p.awbPrinted||p.labelPrinted;
      var printedAt=p.awbPrintedAt||p.printedAt;
      return !printed && !printedAt;
    }
    /* ONE definition of "does this parcel need the merchant".
       Before this there were two, rendered about 200px apart on the same
       dashboard: the command strip counted dailyCommandData().issues while the
       cockpit header counted nvTodayBuckets().needs, which reads the NEEDS_ME
       list. With the production status mix that was 6 against 2, both labelled
       "need attention", both on screen at once.

       The whole disagreement was one status: this set counts Return to
       shipper, NEEDS_ME did not. A parcel coming back IS the merchant's
       problem -- they have to receive it and it is revenue they did not earn --
       so the wider set is the honest one and it is now the only one.

       Kept separate from dailyCommandData() so the cockpit, which re-renders
       every 2.5s, does not have to call clientMetrics() to get a count. */
    function nvAttentionParcels(){
      var myId=(state.client&&state.client.id)||null;
      var all=(state.parcels||[]).filter(function(p){ return p.clientId===myId; });
      var set={};
      all.forEach(function(p){
        if(!p||!p.awb) return;
        var st=String(p.status||"");
        var late=(typeof isDelayed==="function")
          ? isDelayed(p)
          : (st!=="Delivered" && typeof agingHours==="function" && agingHours(p)>24);
        var cash=(typeof isRiderCashHolding==="function") && isRiderCashHolding(p);
        if(late || st==="Refused" || /return/i.test(st) ||
           (p.exception && String(p.exception).trim()) || cash){
          set[p.awb]=p;
        }
      });
      return Object.keys(set).map(function(k){ return set[k]; });
    }
    window.nvAttentionParcels=nvAttentionParcels;

    function dailyCommandData(){
      var myId=(state.client&&state.client.id)||null;
      var all=(state.parcels||[]).filter(function(p){ return p.clientId===myId; });
      var closedStatuses=["Delivered","Return to shipper","Refused","Cancelled by client"];
      var active=all.filter(function(p){ return closedStatuses.indexOf(p.status)===-1; });
      var delayed=all.filter(function(p){ return typeof isDelayed==="function"?isDelayed(p):(p.status!=="Delivered"&&agingHours(p)>24); });
      var refused=all.filter(function(p){ return p.status==="Refused"; });
      var returned=all.filter(function(p){ return /return/i.test(p.status||""); });
      var withException=all.filter(function(p){ return p.exception && String(p.exception).trim(); });
      var cashHolding=all.filter(isRiderCashHolding);
      var issues=nvAttentionParcels();
      var unprinted=all.filter(isUnprintedLabel);
      // NovaX fix: always source "payable" from the same COD-payable metric the
      // dashboard uses (clientMetrics().payable) so Daily Command Center never
      // contradicts the dashboard metrics with a stale/zero wallet balance.
      var payable=clientMetrics().payable;
      var briefingText;
      if(!all.length){
        briefingText="Everything is ready. Book today's first order.";
      } else if(!issues.length && !unprinted.length && payable<=0){
        briefingText="Everything looks clear. Book today's orders when ready.";
      } else {
        briefingText="Today: "+active.length+" active parcel"+(active.length===1?"":"s")+", "+issues.length+" need"+(issues.length===1?"s":"")+" attention, "+money(payable)+" payable, "+unprinted.length+" label"+(unprinted.length===1?"":"s")+" not printed.";
      }
      var nextAction;
      if(issues.length){ nextAction={ text:"Next best action: Review "+issues.length+" parcel"+(issues.length===1?"":"s")+" needing attention.", type:"issues" }; }
      else if(unprinted.length){ nextAction={ text:"Next best action: Print "+unprinted.length+" AWB label"+(unprinted.length===1?"":"s")+" before pickup.", type:"print" }; }
      else if(payable>0){ nextAction={ text:"Next best action: Withdraw "+money(payable)+" from your wallet.", type:"wallet" }; }
      else { nextAction={ text:"Next best action: Book today's orders.", type:"book" }; }
      return { all:all, active:active, issues:issues, delayed:delayed, refused:refused, returned:returned, withException:withException, cashHolding:cashHolding, unprinted:unprinted, payable:payable, briefingText:briefingText, nextAction:nextAction };
    }
    function getCurrentClientParcels(){
      try{
        if(typeof state==="undefined" || !state || !state.client || !state.client.id) return [];
        var id=state.client.id;
        return (state.parcels||[]).filter(function(p){ return p && p.clientId===id; });
      }catch(e){ return []; }
    }
    function isClientDataReady(){
      try{
        if(typeof state==="undefined" || !state) return false;
        if(!state.client || !state.client.id) return false;
        if(!Array.isArray(state.parcels)) return false;
        return !!window.__novaxClientDataReady;
      }catch(e){ return false; }
    }
    /* ===== NovaX Context Guard: single source of truth for parcel/account context ===== */
    function getNextBestAction(ctx){
      try{
        var issueCount=(ctx&&ctx.issueCount)||0;
        var unprintedCount=(ctx&&ctx.unprintedCount)||0;
        var payableBalance=(ctx&&ctx.payableBalance)||0;
        var walletBalance=(ctx&&ctx.walletBalance)||0;
        var totalAllTime=(ctx&&ctx.totalAllTime)||0;
        var firstIssueAwb=(ctx&&ctx.firstIssueAwb)||null;
        if(issueCount>0) return { key:"issues", label:"Review Issues", detail:issueCount+" parcel"+(issueCount===1?"":"s")+" need"+(issueCount===1?"s":"")+" attention.", tab:"dashboard", awb:firstIssueAwb };
        if(unprintedCount>0) return { key:"print", label:"Print Pending AWBs", detail:unprintedCount+" label"+(unprintedCount===1?"":"s")+" not printed yet.", tab:"awbLabel" };
        // NovaX fix: only the real wallet balance can be withdrawn -- the
        // invoice-payable-pending amount is not yet in the wallet.
        if(walletBalance>0) return { key:"wallet", label:"Withdraw Wallet", detail:"Rs "+fmt(walletBalance)+" ready to withdraw.", tab:"wallet" };
        if(totalAllTime===0) return { key:"first_book", label:"Book First Parcel", detail:"Create your first booking to get started.", tab:"newBooking" };
        return { key:"book", label:"Book Today's Orders", detail:"Everything looks clear. Book today's orders when ready.", tab:"newBooking" };
      }catch(e){ return { key:"book", label:"Book Today's Orders", detail:"", tab:"newBooking" }; }
    }
    function getClientContext(){
      try{
        var ready=typeof isClientDataReady==="function"?isClientDataReady():false;
        var clientId=(typeof state!=="undefined"&&state.client&&state.client.id)||null;
        var clientName=(typeof state!=="undefined"&&state.client&&state.client.name)||"";
        var allTime=typeof getCurrentClientParcels==="function"?getCurrentClientParcels():[];
        var inRange=typeof clientScopedParcels==="function"?clientScopedParcels():[];
        var data=typeof dailyCommandData==="function"?dailyCommandData():{active:[],delayed:[],refused:[],returned:[],issues:[],unprinted:[],payable:0};
        var delivered=allTime.filter(function(p){ return p.status==="Delivered"; }).length;
        var payable=data.payable||0;
        var totalAllTime=allTime.length;
        var totalInRange=inRange.length;
        var issueCount=data.issues.length;
        var firstIssueAwb=data.issues[0]?data.issues[0].awb:null;
        // NovaX fix: wallet balance must always read from clients.wallet_balance
        // (the real ledger), not the recalculated invoice-payable-pending
        // amount -- only real wallet money can actually be withdrawn.
        var walletBal=Number((typeof state!=="undefined"&&state.client&&state.client.walletBalance)||0);
        var nba=getNextBestAction({ issueCount:issueCount, unprintedCount:data.unprinted.length, payableBalance:payable, walletBalance:walletBal, totalAllTime:totalAllTime, firstIssueAwb:firstIssueAwb });
        return {
          ready:ready,
          clientId:clientId,
          clientName:clientName,
          parcelsAllTime:allTime,
          parcelsInRange:inRange,
          totalAllTime:totalAllTime,
          totalInRange:totalInRange,
          activeCount:data.active.length,
          deliveredCount:delivered,
          refusedCount:data.refused.length,
          returnedCount:data.returned.length,
          issueCount:issueCount,
          delayedCount:data.delayed.length,
          unprintedCount:data.unprinted.length,
          payableBalance:payable,
          walletBalance:walletBal,
          hasParcels:totalAllTime>0,
          hasParcelsInRange:totalInRange>0,
          isFirstBookingClient:totalAllTime===0,
          firstIssueAwb:firstIssueAwb,
          nextBestAction:nba
        };
      }catch(e){
        return { ready:false, clientId:null, clientName:"", parcelsAllTime:[], parcelsInRange:[], totalAllTime:0, totalInRange:0, activeCount:0, deliveredCount:0, refusedCount:0, returnedCount:0, issueCount:0, delayedCount:0, unprintedCount:0, payableBalance:0, walletBalance:0, hasParcels:false, hasParcelsInRange:false, isFirstBookingClient:true, firstIssueAwb:null, nextBestAction:{ key:"book", label:"Book Today's Orders", detail:"", tab:"newBooking" } };
      }
    }
    function canShowEmptyDashboard(ctx){
      try{ ctx=ctx||getClientContext(); return !!ctx.ready && ctx.totalAllTime===0; }catch(e){ return false; }
    }
    function canShowDailyCommandCenter(ctx){
      try{ ctx=ctx||getClientContext(); return !!ctx.ready; }catch(e){ return false; }
    }
    /* =====================================================================
       NovaX new (Smart Portal B + D): wallet intelligence.

       DESIGN RULE THAT MUST NOT BE BROKEN: every rupee figure below is
       computed by a SECURITY DEFINER RPC on the server. This code only
       formats what the server returned. It never adds, subtracts or
       projects money in the browser, because a client-side number that
       disagrees with the real balance destroys exactly the trust these
       panels exist to build.

       HONESTY NOTE ON CLEARANCE DATES: COD does not reach a wallet on a
       fixed timer -- it lands when an invoice is generated. There is no
       reliable data basis for "lands tomorrow", so no date is promised
       anywhere here. Amounts and counts only.
       ===================================================================== */
    /* NovaX new (Smart Portal E2): customer memory at booking time.
       Turns this merchant's OWN delivery history into a risk signal before
       the parcel is booked, which is the cheapest possible way to prevent a
       failed first attempt. Scoped server-side to the caller's own parcels
       only -- one merchant can never see another's customer history. */
    var NV_CONSIGNEE_T=null, NV_CONSIGNEE_LAST="";
    function nvConsigneeBadge(){
      var input=document.getElementById("bookingPhone");
      var host=document.getElementById("consigneeHistoryBadge");
      if(!input||!host) return;
      var raw=String(input.value||"").replace(/[^0-9]/g,"");
      if(raw.length<10){ host.style.display="none"; host.innerHTML=""; NV_CONSIGNEE_LAST=""; return; }
      if(raw===NV_CONSIGNEE_LAST) return;
      NV_CONSIGNEE_LAST=raw;
      var sb=window.__nvSb;
      if(!sb||!sb.rpc) return;
      try{
        /* Three separate contract mismatches, all failing silently into the
           hide-the-badge branch, so this refusal-history warning has never
           once appeared since it shipped:
             - the RPC is ai_tool_consignee_history, not consignee_history
             - it returns a jsonb OBJECT, so the old r.data.length check was
               undefined and always fell through
             - the fields are delivered/refused, not delivered_count/refused_count
           Verified against sql_novax_ai_tools_v2.sql, which also grants
           execute on it to authenticated. */
        sb.rpc("ai_tool_consignee_history",{ p_phone: raw }).then(function(r){
          if(!r||r.error||!r.data){ host.style.display="none"; host.innerHTML=""; return; }
          var d=Array.isArray(r.data)?r.data[0]:r.data;
          if(!d||d.error){ host.style.display="none"; host.innerHTML=""; return; }
          var total=Number(d.total_parcels||0);
          var del=Number(d.delivered||0);
          var ref=Number(d.refused||0);
          if(total<=0){ host.style.display="none"; host.innerHTML=""; return; }
          var html;
          if(ref>0){
            html='<span class="chip warn" style="font-size:11.5px">&#9888; '+ref+' refusal'+(ref===1?"":"s")+
                 ' before &middot; '+del+'/'+total+' delivered &mdash; consider confirming by call</span>';
          }else{
            html='<span class="chip good" style="font-size:11.5px">&#10003; '+del+'/'+total+
                 ' delivered to this customer</span>';
          }
          host.innerHTML=html;
          host.style.display="block";
        }).catch(function(){});
      }catch(e){}
    }
    document.addEventListener("input",function(e){
      if(!e||!e.target||e.target.id!=="bookingPhone") return;
      if(NV_CONSIGNEE_T) clearTimeout(NV_CONSIGNEE_T);
      NV_CONSIGNEE_T=setTimeout(nvConsigneeBadge,450);
    });

    /* =====================================================================
       NovaX new (Smart Portal E): Autopilot proactive intelligence UI.

       WHY THIS FETCHES ONCE, NOT ON THE COMMAND-CENTER LOOP:
       renderDailyCommandCenter() re-runs every 3 seconds. Calling these two
       RPCs from there would mean ~1,200 database round trips per hour per
       open tab, per merchant. These fetch once per session and re-render
       from the cached result. Refreshed only on an explicit user action.

       Both paths fail silent: if an RPC errors, the container stays hidden
       and the dashboard behaves exactly as it did before.
       ===================================================================== */
    var NV_INSIGHTS={ list:null, digest:null, fetched:false };
    function nvLoadInsights(force){
      var sb=window.__nvSb;
      if(!sb||!sb.rpc) return;
      if(NV_INSIGHTS.fetched&&!force) return;
      NV_INSIGHTS.fetched=true;
      try{
        sb.rpc("client_smart_insights").then(function(r){
          if(r&&!r.error){
            var d=r.data;
            if(typeof d==="string"){ try{ d=JSON.parse(d); }catch(e){ d=[]; } }
            NV_INSIGHTS.list=Array.isArray(d)?d:[];
            try{ renderInsightCards(); }catch(e){}
          }
        }).catch(function(){});
      }catch(e){}
      /* Latest unread digest. Read directly through RLS (own rows only) --
         no RPC needed for a plain scoped select. */
      try{
        sb.from("client_digests").select("*").is("read_at",null)
          .order("week_start",{ascending:false}).limit(1)
          .then(function(r){
            if(r&&!r.error&&r.data&&r.data.length){
              NV_INSIGHTS.digest=r.data[0];
              try{ renderInsightCards(); }catch(e){}
            }
          },function(){});
      }catch(e){}
    }
    function nvDismissDigest(id){
      var sb=window.__nvSb;
      NV_INSIGHTS.digest=null;
      try{ renderInsightCards(); }catch(e){}
      if(!sb||!sb.rpc||!id) return;
      try{ sb.rpc("mark_digest_read",{ p_digest_id:id }).then(function(){},function(){}); }catch(e){}
    }
    function renderInsightCards(){
      var host=document.getElementById("nvInsightCards");
      if(!host) return;
      var html="";

      var dg=NV_INSIGHTS.digest;
      if(dg){
        var wk="";
        try{
          var d0=new Date(dg.week_start);
          if(!isNaN(d0.getTime())) wk=d0.toLocaleDateString("en-PK",{day:"numeric",month:"short"});
        }catch(e){}
        html+='<div class="nv-ins digest">'+
          '<div class="nv-ins-top">'+
            '<div class="nv-ins-title">Your week in review'+(wk?(' &middot; week of '+escLabelText(wk)):"")+'</div>'+
            '<button class="ghost-btn" style="padding:4px 9px;font-size:11.5px" onclick="nvDismissDigest(\''+escLabelText(dg.id)+'\')">Dismiss</button>'+
          '</div>'+
          (dg.headline?'<div class="nv-ins-body">'+escLabelText(dg.headline)+'</div>':"")+
          '<div class="nv-ins-stats">'+
            '<div class="nv-ins-stat"><span>Delivered</span><strong>'+escLabelText(String(dg.delivered_count||0))+'</strong></div>'+
            '<div class="nv-ins-stat"><span>COD collected</span><strong>'+escLabelText(money(Number(dg.cod_collected||0)))+'</strong></div>'+
            '<div class="nv-ins-stat"><span>Fees paid</span><strong>'+escLabelText(money(Number(dg.fees_paid||0)))+'</strong></div>'+
            (dg.best_city?'<div class="nv-ins-stat"><span>Best city</span><strong>'+escLabelText(dg.best_city)+'</strong></div>':"")+
            (dg.worst_city?'<div class="nv-ins-stat"><span>Most issues</span><strong>'+escLabelText(dg.worst_city)+'</strong></div>':"")+
          '</div>'+
        '</div>';
      }

      /* NovaX fix (false "not moved in 3 days" alarm): client_smart_insights
         measures staleness purely as time-since-last-status-change, so a
         parcel sitting at "New booked" because the merchant has not handed it
         to a rider yet gets reported as stuck -- NovaX blaming the merchant
         for NovaX not having collected, and worse, burying the real stuck
         parcels in noise. A parcel we have never picked up is not stuck in
         our network; the correct prompt there is "request a pickup", which
         the dashboard already surfaces separately.

         The RPC lives server-side (not in this repo), so this filters its
         output against live local parcel state: any AWB named in an insight
         that is still "New booked" is dropped from that insight, and an
         insight left with no qualifying parcels is suppressed entirely.
         Purely subtractive -- it can hide a false alarm, never invent one. */
      var list=(NV_INSIGHTS.list||[]).map(function(it){
        try{
          if(!it||!it.body) return it;
          var awbs=String(it.body).match(/\b[A-Z0-9][A-Z0-9-]{4,23}\b/g);
          if(!awbs||!awbs.length) return it;
          var mine=(state.parcels||[]);
          var known=awbs.filter(function(a){ return mine.some(function(p){ return p&&p.awb===a; }); });
          if(!known.length) return it;
          var stillStuck=known.filter(function(a){
            var p=mine.find(function(x){ return x&&x.awb===a; });
            return p && String(p.status||"")!=="New booked";
          });
          if(!stillStuck.length) return null;
          if(stillStuck.length===known.length) return it;
          var body=String(it.body);
          known.forEach(function(a){ if(stillStuck.indexOf(a)<0) body=body.replace(new RegExp("[,;]?\\s*"+a.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"g"),""); });
          body=body.replace(/:\s*,/,":").replace(/\s{2,}/g," ").trim();
          var title=String(it.title||"").replace(/^\d+/,String(stillStuck.length));
          return Object.assign({},it,{ title:title, body:body });
        }catch(e){ return it; }
      }).filter(Boolean);
      list.slice(0,4).forEach(function(it){
        if(!it||!it.title) return;
        var sev=(it.severity==="high")?"high":(it.severity==="medium"?"medium":"");
        html+='<div class="nv-ins'+(sev?" "+sev:"")+'">'+
          '<div class="nv-ins-top"><div class="nv-ins-title">'+escLabelText(it.title)+'</div></div>'+
          (it.body?'<div class="nv-ins-body">'+escLabelText(it.body)+'</div>':"")+
        '</div>';
      });

      if(!html){ host.style.display="none"; host.innerHTML=""; return; }
      host.innerHTML=html;
      host.style.display="block";
    }

    var NV_WALLET_INTEL={ incoming:null, fees:null, loaded:false };
    function nvLoadWalletIntelligence(force){
      var sb=window.__nvSb;
      if(!sb||!sb.rpc) return;
      /* AUDIT FIX (high): this had NO guard, and its only call site is
         inside renderClientWallet() -- which is bound directly to the
         "input" event on both #withdrawAmount and #withdrawIbanInput, and
         also re-runs on every realtime parcel event and tab switch. Typing
         a 5-digit amount fired 10 SECURITY DEFINER RPCs; pasting a 24-char
         IBAN fired ~48, each one a full aggregate scan over parcels,
         withdrawals and wallet_ledger. Now fetched once per session, with
         an explicit force flag for real refresh points. */
      if(NV_WALLET_INTEL.loaded&&!force) return;
      NV_WALLET_INTEL.loaded=true;
      try{
        sb.rpc("client_wallet_incoming").then(function(r){
          if(r&&!r.error&&r.data){
            NV_WALLET_INTEL.incoming=Array.isArray(r.data)?r.data[0]:r.data;
            try{ renderWalletIncoming(); }catch(e){}
          }
        }).catch(function(){});
      }catch(e){}
      try{
        sb.rpc("client_fee_insights").then(function(r){
          if(r&&!r.error&&r.data){
            NV_WALLET_INTEL.fees=Array.isArray(r.data)?r.data[0]:r.data;
            try{ renderFeeInsights(); }catch(e){}
          }
        }).catch(function(){});
      }catch(e){}
    }
    function renderWalletIncoming(){
      var host=document.getElementById("walletIncomingPanel");
      if(!host) return;
      var d=NV_WALLET_INTEL.incoming;
      if(!d){ host.style.display="none"; return; }

      var transit=Number(d.in_transit_amount||0);
      var transitN=Number(d.in_transit_count||0);
      var clearing=Number(d.delivered_uncleared||0);
      var clearingN=Number(d.delivered_uncleared_count||0);
      var avail=Number(d.available_balance||0);
      /* AUDIT FIX (medium): this used to be `transit + clearing` -- a
         browser-side addition of two PostgreSQL numerics, which is exactly
         what the rule at the top of this block forbids. The server now
         returns the sum as on_the_way_amount. Fallback kept only so an
         un-migrated server does not blank the panel. */
      var onWay=(d.on_the_way_amount!=null)?Number(d.on_the_way_amount):(transit+clearing);

      /* Brand-new merchant with nothing moving: show the honest empty
         state rather than a row of zeros. */
      if(onWay<=0&&avail<=0){
        host.style.display="block";
        host.innerHTML='<div class="nv-inc"><div class="nv-inc-lbl">Incoming money</div>'+
          '<div class="nv-inc-amt">'+escLabelText(money(0))+'</div>'+
          '<div class="nv-inc-sub">Your incoming COD will appear here after your first booking.</div></div>';
        return;
      }

      var inFlow=[], outFlow=[];
      try{ inFlow=Array.isArray(d.inflow_4w)?d.inflow_4w:JSON.parse(d.inflow_4w||"[]"); }catch(e){ inFlow=[]; }
      try{ outFlow=Array.isArray(d.outflow_4w)?d.outflow_4w:JSON.parse(d.outflow_4w||"[]"); }catch(e){ outFlow=[]; }

      var chips='<span class="nv-inc-chip">In transit <b>'+escLabelText(money(transit))+'</b>'+(transitN?(' &middot; '+transitN+' parcel'+(transitN===1?"":"s")):"")+'</span>'+
                '<span class="nv-inc-chip">Delivered, clearing <b>'+escLabelText(money(clearing))+'</b>'+(clearingN?(' &middot; '+clearingN+' parcel'+(clearingN===1?"":"s")):"")+'</span>'+
                '<span class="nv-inc-chip">Available now <b>'+escLabelText(money(avail))+'</b></span>';

      host.style.display="block";
      host.innerHTML='<div class="nv-inc">'+
        '<div class="nv-inc-lbl">On its way to you</div>'+
        '<div class="nv-inc-amt">'+escLabelText(money(onWay))+'</div>'+
        '<div class="nv-inc-sub">COD collected or in transit that has not reached your wallet yet.</div>'+
        '<div class="nv-inc-chips">'+chips+'</div>'+
        nvFlowChartHtml(inFlow,outFlow)+
      '</div>';
    }
    /* Pure-CSS 4-week in/out bars. No chart library, no external request. */
    function nvFlowChartHtml(inFlow,outFlow){
      var weeks=[], i, now=new Date();
      for(i=3;i>=0;i--){
        var dte=new Date(now.getTime()-i*7*86400000);
        var day=(dte.getUTCDay()+6)%7;
        var ws=new Date(dte.getTime()-day*86400000).toISOString().slice(0,10);
        weeks.push(ws);
      }
      function amtFor(arr,ws){
        var hit=(arr||[]).find(function(x){ return String(x&&x.week_start||"").slice(0,10)===ws; });
        return hit?Number(hit.amount||0):0;
      }
      var rows=weeks.map(function(ws){ return { ws:ws, inA:amtFor(inFlow,ws), outA:amtFor(outFlow,ws) }; });
      var max=Math.max.apply(null,rows.map(function(r){ return Math.max(r.inA,r.outA); }).concat([1]));
      if(max<=0) return "";
      var any=rows.some(function(r){ return r.inA>0||r.outA>0; });
      if(!any) return "";
      var cols=rows.map(function(r){
        /* AUDIT FIX (low): Math.max(2,...) drew a 2px stub for a week with
           zero movement, implying money moved when none did. Zero means
           zero on a money chart. */
        var hIn=r.inA>0?Math.max(2,Math.round((r.inA/max)*44)):0;
        var hOut=r.outA>0?Math.max(2,Math.round((r.outA/max)*44)):0;
        var lbl=r.ws.slice(5).replace("-","/");
        return '<div class="nv-flow-col">'+
                 '<div class="nv-flow-bars">'+
                   '<i class="in" style="height:'+hIn+'px" title="In"></i>'+
                   '<i class="out" style="height:'+hOut+'px" title="Out"></i>'+
                 '</div><span>'+escLabelText(lbl)+'</span></div>';
      }).join("");
      return '<div class="nv-flow">'+cols+'</div>'+
             '<div class="nv-inc-sub" style="margin-top:6px">Last 4 weeks &middot; '+
             '<span style="color:#4f46e5;font-weight:800">&#9632;</span> into wallet &nbsp; '+
             '<span style="color:#c7d2fe;font-weight:800">&#9632;</span> withdrawn</div>';
    }
    function renderFeeInsights(){
      var host=document.getElementById("walletFeeInsights");
      if(!host) return;
      var d=NV_WALLET_INTEL.fees;
      if(!d){ host.style.display="none"; return; }
      var payout=Number(d.payout_fees_month||0);
      var delivery=Number(d.delivery_fees_month||0);
      var total=Number(d.total_fees_month||0);
      var withdrawn=Number(d.withdrawn_month||0);
      var std=Number(d.cost_if_all_standard||0);
      var best=d.best_speed||null;

      if(total<=0&&withdrawn<=0){ host.style.display="none"; return; }

      /* Honest nudge, both directions -- if they are already on the
         cheapest option we say so instead of inventing a saving. */
      /* AUDIT FIX (medium): the rupee saving was `payout-std`, computed in
         the browser. Server now returns potential_saving. */
      var saving=(d.potential_saving!=null)?Number(d.potential_saving):null;
      var nudge="";
      if(best==="standard"&&saving!==null&&saving>0){
        nudge='<p class="footer-note" style="margin-top:8px">Using <strong>Standard (24h)</strong> payouts for the same amount this month would have cost '+
              escLabelText(money(std))+' instead of '+escLabelText(money(payout))+' &mdash; a saving of <strong>'+escLabelText(money(saving))+'</strong>.</p>';
      }else if(best==="already_optimal"){
        nudge='<p class="footer-note" style="margin-top:8px">You are already on the lowest-fee payout option for this month. Nothing to change.</p>';
      }

      host.style.display="block";
      host.innerHTML='<div class="panel" style="margin-top:14px">'+
        '<div class="section-head"><div><h3>Fees this month</h3><p>Exactly what NovaX charged you, and whether a cheaper option existed.</p></div></div>'+
        '<div class="money-grid">'+
          moneyBox("Total fees",money(total),"this calendar month")+
          moneyBox("Payout fees",money(payout),"on "+money(withdrawn)+" withdrawn")+
          moneyBox("Delivery charges",money(delivery),"posted this month")+
        '</div>'+nudge+'</div>';
    }
    /* =====================================================================
       AUDIT FIX -- two controls in the markup called functions that were
       never written. Both threw ReferenceError on click, so the feature
       behind each was completely unreachable.
       ===================================================================== */

    /* The 🌙 button (#nvThemeToggleBtn) called toggleNovaxTheme(). The dark
       theme CSS exists (html[data-theme="dark"], ~line 240) and the boot
       script at the top of <head> already restores a saved preference from
       localStorage -- only the toggle itself was missing, so dark mode
       could never be switched on in the first place. */
    /* NovaX (theme): delegates to the shared NovaXTheme controller so the 🌙
       button, the boot script and the UI primitives all agree on one stored
       value. Cycles System -> Light -> Dark rather than a two-way flip, so
       "follow my phone" is reachable, which is what most merchants actually
       want. Falls back to the old two-way behaviour if the controller is
       somehow absent. */
    /* Two states now, not three -- "follows your device" was retired when dark
       became the portal default (see the NovaXTheme controller). The icon shows
       what tapping will GIVE you, not what you are currently on: on dark it
       offers the sun, on light it offers the moon. */
    function nvSyncThemeButton(){
      try{
        /* This runs ~10,000 lines BEFORE the NovaXTheme controller is defined,
           so the fallback is not decoration -- it is the path taken on first
           paint. Read the attribute the boot script already stamped rather
           than assuming dark, or a merchant who chose Light gets the wrong
           icon until they next tap it. */
        var mode=(window.NovaXTheme&&window.NovaXTheme.get)?window.NovaXTheme.get()
                 :(document.documentElement.getAttribute("data-theme")==="light"?"light":"dark");
        var btn=document.getElementById("nvThemeToggleBtn");
        if(!btn) return;
        var isLight=(mode==="light");
        var label=isLight?"Theme: light \u2014 tap for dark":"Theme: dark \u2014 tap for light";
        btn.textContent=isLight?"\u{1F319}":"\u2600\uFE0F";
        btn.setAttribute("aria-label",label);
        btn.setAttribute("title",label);
      }catch(e){}
    }
    function toggleNovaxTheme(){
      try{
        if(window.NovaXTheme&&window.NovaXTheme.cycle){ window.NovaXTheme.cycle(); nvSyncThemeButton(); return; }
        var root=document.documentElement;
        var dark=root.getAttribute("data-theme")==="dark";
        root.setAttribute("data-theme", dark?"light":"dark");
        try{ localStorage.setItem("novaxTheme", dark?"light":"dark"); }catch(e){}
        nvSyncThemeButton();
      }catch(e){}
    }
    /* Keep the icon in sync with a preference restored before this script ran. */
    (function(){ try{ nvSyncThemeButton(); }catch(e){} })();

    /* The Account History header (#accountHistoryHead) is styled as a
       clickable row and literally says "Tap to change the range", but
       toggleAccountHistoryFilters() did not exist -- so #accountHistoryBody
       stayed display:none forever and the date-range filter was
       permanently unreachable. */
    function toggleAccountHistoryFilters(){
      try{
        var body=document.getElementById("accountHistoryBody");
        var chev=document.getElementById("accountHistoryChevron");
        var head=document.getElementById("accountHistoryHead");
        if(!body) return;
        var open=body.style.display!=="none";
        body.style.display=open?"none":"";
        if(chev) chev.textContent=open?"▸":"▾";
        if(head) head.setAttribute("aria-expanded", open?"false":"true");
      }catch(e){}
    }

    function nextId(prefix, items){ const max=(items||[]).reduce((v,it)=>{ const n=Number(String(it.id||"").replace(prefix+"-","")); return Number.isFinite(n)?Math.max(v,n):v; },0); return `${prefix}-${String(max+1).padStart(4,"0")}`; }
    function agingHours(p){ if(p&&p.statusSince){ const ms=Date.now()-new Date(p.statusSince).getTime(); if(Number.isFinite(ms)) return Math.max(0,ms/3600000); } return Number((p&&p.statusAgeHours)||0); }
    function agingLabel(h=0){ if(h<1) return "just now"; if(h<24) return `${Math.max(0,Math.round(h))}h`; const d=Math.floor(h/24); const r=Math.round(h%24); return r?`${d}d ${r}h`:`${d}d`; }
    function alertForParcel(p){
      const h=agingHours(p);
      if(p.status==="Parcel now in transit"){ if(h>=72) return {level:"critical",label:"Red alert: transit over 3 days",due:"AI + support must act now"}; if(h>=48) return {level:"warning",label:"Transit aging",due:"Escalate before 3 days"}; return {level:"ok",label:"In transit",due:"Transit clock running"}; }
      if(p.status==="Cancelled by client") return {level:"ok",label:"Cancelled",due:"You cancelled this booking"};
      if(["Delivered","Return to shipper"].includes(p.status)) return {level:"ok",label:"Closed",due:"No open alert"};
      if(h>=24) return {level:"critical",label:"24h status breach",due:"AI + support must act now"};
      return {level:"ok",label:"Within SLA",due:`${24-Math.round(h)}h left`};
    }
    function urgencyClass(l){ if(l==="critical"||l==="super urgent") return "bad"; if(l==="warning"||l==="urgent") return "warn"; return "good"; }
    function setParcelStatus(p,status){ p.status=status; p.statusAgeHours=0; p.statusSince=new Date().toISOString(); p.updated=time(); p.stage=Math.max(0,STATUS_TAGS.indexOf(status)); if(!Array.isArray(p.steps)) p.steps=[]; if(!p.steps.includes(status)) p.steps.push(status); }
    /* ═══ Parcel progress ══════════════════════════════════════════════════
       STATUS_TAGS is not a linear pipeline. Indices 0-6 are the delivery path;
       7-11 are exceptions that happen AT the delivery attempt; 12-16 are the
       return leg. Measuring progress as stage/16 therefore reported a
       DELIVERED parcel -- the successful end state -- as 38% complete, and a
       returned one as 100%. Progress is now measured along the path the parcel
       is actually on. */
    var NV_DELIVERY_PATH=["New booked","Collected by rider","Arrived at warehouse",
                          "Parcel now in transit","Parcel received at destination",
                          "Parcel out for delivery","Delivered"];
    var NV_EXCEPTION_AT_DOOR=["Refused","Consignee not available","Reattempt",
                              "Reassigned","Out of service area"];
    var NV_RETURN_PATH=["Ready for return","Return in transit","Return received at origin",
                        "Return out for delivery","Return to shipper"];
    function nvProgressPct(status){
      var st=(typeof nvStatus==="function"?nvStatus(status):status)||"";
      if(st==="Delivered") return 100;
      var d=NV_DELIVERY_PATH.indexOf(st);
      if(d>-1) return Math.round((d/(NV_DELIVERY_PATH.length-1))*100);
      if(NV_EXCEPTION_AT_DOOR.indexOf(st)>-1) return 83;   // reached the door
      var r=NV_RETURN_PATH.indexOf(st);
      if(r>-1) return 85+Math.round((r/(NV_RETURN_PATH.length-1))*15);
      return 0;
    }
    /* "5 of 7" along whichever path applies, instead of "6/16". */
    function nvProgressStep(status){
      var st=(typeof nvStatus==="function"?nvStatus(status):status)||"";
      var d=NV_DELIVERY_PATH.indexOf(st);
      if(d>-1) return (d+1)+"/"+NV_DELIVERY_PATH.length;
      if(NV_EXCEPTION_AT_DOOR.indexOf(st)>-1) return "6/7";
      var r=NV_RETURN_PATH.indexOf(st);
      if(r>-1) return "R"+(r+1)+"/"+NV_RETURN_PATH.length;
      return "1/"+NV_DELIVERY_PATH.length;
    }

    /* ═══ Idempotent repaints ══════════════════════════════════════════════
       Three timers rewrote dashboard sections every 3 seconds whether or not
       anything had changed -- innerHTML on a live container drops and rebuilds
       its subtree, so the merchant saw the panels blink and relayout twice a
       second between them. nvPaint() writes only when the HTML actually
       differs, which makes an unchanged tick free and invisible. */
    var __nvPaintSig={};
    function nvPaint(id, html){
      var el=document.getElementById(id);
      if(!el) return false;
      if(__nvPaintSig[id]===html) return false;   // nothing moved -- do not touch the DOM
      __nvPaintSig[id]=html;
      el.innerHTML=html;
      return true;
    }
    window.nvPaint=nvPaint;

    function percent(v,m){ if(!m) return 0; return Math.max(0,Math.min(100,Math.round((v/m)*100))); }
    // NovaX fix (duplicate formatters): fmt() here and fmtRs() further down
    // the file were byte-identical implementations in two different script
    // blocks. There is now a single number formatter, with fmt()/fmtRs() kept
    // as thin aliases and money() remaining the currency-prefixed variant.
    // Output strings are unchanged, so wallet fee and payout formatting is
    // byte-for-byte identical to before.
    function nvFormatNumber(v){ try{ return Number(v||0).toLocaleString('en-US'); }catch(e){ return String(v); } }
    window.nvFormatNumber=nvFormatNumber;
    /* PKR.format(NaN) yields "RsNaN". No live row produces that today, but it
       is one bad value away -- a missing fee, a half-written invoice -- and
       "RsNaN" where a merchant expects their money is the kind of thing that
       ends in a support ticket rather than a bug report. Anything that is not
       a finite number reads as Rs 0. */
    function money(v){
      var n = typeof v === "number" ? v : Number(v);
      if (!isFinite(n)) n = 0;
      return PKR.format(n).replace("PKR","Rs");
    }
    function fmt(v){ return nvFormatNumber(v); }
    /* Kept deliberately in step with admin.html's statusClass(). The
       "Cancelled by client" early-return was present there and missing here,
       so a cancelled parcel fell through to the stage-based branches and
       rendered as info/warn/good in the merchant portal while showing as
       neutral in admin -- the same parcel, two different colours, depending
       on who was looking at it. */
    function statusClass(p){ const a=alertForParcel(p); if(a.level==="critical"||p.risk>=65||p.exception) return "bad"; if(a.level==="warning") return "warn"; if(p.status==="Cancelled by client") return ""; if(["Delivered","Return to shipper"].includes(p.status)) return "good"; if(p.stage<5) return "info"; if(p.stage<8) return "warn"; return "good"; }
    function isRefusalReview(p){ return /refus|attempt disputed|consignee denies|not available/i.test(`${p.status} ${p.exception||""} ${(p.steps||[]).join(" ")}`); }
    function meterClass(v){ if(v>=75) return "red"; if(v>=45) return "amber"; return "blue"; }
    /* hidePct: an eighth, optional argument, defaulted so every existing
       caller is untouched. It exists for the "nothing picked up yet" state of
       the delivery-rate cards, where the value is an em dash -- printing
       "\u2014 ... 0%" beside it would put back exactly the false zero the
       card is trying to avoid. */
    function metricCard(label,value,fill,caption,kind="",icon="",action="",hidePct=false){
      const iconHtml = icon ? `<span class="metric-icon">${icon}</span>` : "";
      // NovaX fix (inline handler with interpolated data): the action is now a
      // data attribute picked up by one delegated listener, so nothing
      // user-derived is ever concatenated into executable onclick JavaScript.
      const clickAttrs = action ? ` data-metric-action="${escLabelText(action)}" role="button" tabindex="0" style="cursor:pointer"` : "";
      return `<article class="metric"${clickAttrs}>${iconHtml}<label>${label}</label><strong>${value}</strong><div class="meter ${kind}"><span style="width:${fill}%"></span></div><div class="meter-caption"><span>${caption}</span><span>${hidePct?"":`${fill}%`}</span></div></article>`;
    }
    // NovaX dashboard refresh: metric cards are clickable shortcuts into the
    // matching filtered view -- purely additive UI sugar, no data logic changes.
    function handleMetricCardClick(action){
      try{
        if(action==="clear"){
          if(typeof showClientTab==="function") showClientTab("dashboard");
          const el=document.getElementById("clientSearch"); if(el){ el.value=""; if(typeof renderClientParcels==="function") renderClientParcels(); }
          const t=document.getElementById("clientDashboardMainGrid"); if(t) t.scrollIntoView({behavior:"smooth",block:"start"});
          return;
        }
        if(action.indexOf("filter:")===0){
          const term=action.slice(7);
          if(typeof showClientTab==="function") showClientTab("dashboard");
          const el=document.getElementById("clientSearch"); if(el){ el.value=term; if(typeof renderClientParcels==="function") renderClientParcels(); }
          const t=document.getElementById("clientDashboardMainGrid"); if(t) t.scrollIntoView({behavior:"smooth",block:"start"});
          return;
        }
        if(action.indexOf("tab:")===0){
          const tab=action.slice(4);
          if(typeof showClientTab==="function") showClientTab(tab);
          return;
        }
      }catch(e){}
    }
    function moneyBox(label,value,note){ return `<div class="money-box"><span>${label}</span><strong>${value}</strong><div class="footer-note">${note}</div></div>`; }
    // NovaX fix: once an invoice is "Pushed to wallet" the money is already
    // sitting in the client's wallet balance (ready to withdraw - any delay
    // from there on is the client's own withdrawal request, not NovaX owing
    // them). Once "Paid" it is fully settled. Neither state should still be
    // labelled/shown as an outstanding "Payable" amount -- only a invoice
    // that has not yet been pushed to wallet is genuinely payable/pending.
    // NovaX new (Negative/Delivery-Charges Invoices): delivery-charge-only
    // invoices are money the client owes NovaX -- never wallet-payable.
    function isNonCodParcel(parcel){ return /non\s*cod|prepaid/i.test(String((parcel&&(parcel.paymentMode||parcel.payment_mode))||"").trim()); }
    function invoiceMoneyBox(inv){
      const due=Number(inv.dueToNovax||0);
      // NovaX (Branded Invoice wording): spec requires the exact phrases
      // "Payable to you" for COD settlement and "Amount due to NovaX" for
      // non-COD/delivery-charge-only invoices.
      // NovaX fix (dashboard/invoices/wallet desync): a due-to-NovaX invoice
      // is settled via status "Paid to NovaX", never literally "Paid" -- so
      // checking only "Paid" meant a delivery-charges invoice the client had
      // already paid still showed "Amount due to NovaX" forever. Likewise a
      // COD-settlement invoice that reaches "Settled" (bank payout marked
      // paid) fell through every check here to "Payable to you", looking
      // outstanding even after the client had actually been paid.
      if(due>0){
        if(isInvoiceClosed(inv.status)) return moneyBox("Paid in full",money(due),"Settled - nothing owed");
        return moneyBox("Amount due to NovaX",money(due),"you owe this to NovaX");
      }
      if(inv.status==="Pushed to wallet") return moneyBox("In wallet",money(inv.payable),"Ready for you - withdraw anytime");
      if(isInvoiceClosed(inv.status)) return moneyBox("Paid in full",money(inv.payable),"Settled - nothing owed");
      return moneyBox("Payable to you",money(inv.payable),"COD settlement");
    }
    // NovaX fix (dashboard/invoices/wallet desync): "Settled" and "Paid to
    // NovaX" fell through to the default "warn" (pending/amber) chip, so a
    // fully settled invoice still displayed with the same look as one still
    // awaiting payment in Payment History / the invoice list.
    function invoiceChipClass(status){ if(status==="Cancelled") return "bad"; if(isInvoiceClosed(status)) return "good"; return "warn"; }
    function invoiceTypeChipClass(invType){ return invType==="Delivery Charges"?"bad":(invType==="Mixed"?"warn":"info"); }
    function trackingUrl(awb){ try{ return location.origin+"/tracking.html?awb="+encodeURIComponent(awb); }catch(e){ return "https://novaxlogistics.com/tracking.html?awb="+encodeURIComponent(awb); } }
    // NovaX (Part 7): WhatsApp customer message templates. Shared list of
    // event kinds, next-step copy per kind, and a status->kind guess so the
    // UI can preselect a sensible template for the parcel's current status.
    const WA_MESSAGE_KINDS=["Booked","Out for delivery","Delivered","Refused","Consignee not available","Reattempt","Return to origin","Address/phone issue"];
    const WA_NEXT_STEP={
      "Booked":"We will collect and dispatch your parcel soon.",
      "Out for delivery":"Your parcel is out for delivery today. Please keep your phone reachable.",
      "Delivered":"Your parcel has been delivered. Thank you for shopping with us.",
      "Refused":"Your parcel was refused at delivery. Please contact us if this was a mistake.",
      "Consignee not available":"Our rider could not reach you. We will attempt delivery again soon.",
      "Reattempt":"We will re-attempt delivery soon. Please stay available on this number.",
      "Return to origin":"Your parcel is being returned to the sender.",
      "Address/phone issue":"We could not deliver due to an address or phone issue. Please reply with the correct details."
    };
    function waKindForStatus(status){
      const map={"New booked":"Booked","Parcel out for delivery":"Out for delivery","Delivered":"Delivered","Refused":"Refused","Consignee not available":"Consignee not available","Reattempt":"Reattempt","Ready for return":"Return to origin","Return in transit":"Return to origin","Return received at origin":"Return to origin","Return out for delivery":"Return to origin","Return to shipper":"Return to origin"};
      return map[status]||"Booked";
    }
    // Normalizes any saved phone format to Pakistani country-code digits
    // (92xxxxxxxxxx) required by wa.me links. Returns "" if it can't produce
    // a plausible number, so callers can show a clear error instead of
    // opening a broken WhatsApp link.
    function waPhoneDigits(phone){
      let d=String(phone||"").replace(/\D/g,"");
      if(d.length===11&&d.startsWith("03")) d="92"+d.slice(1);
      else if(d.length===10&&d.startsWith("3")) d="92"+d;
      else if(d.length===12&&d.startsWith("92")){}
      else return "";
      return /^92\d{10}$/.test(d)?d:"";
    }
    /* NovaX new (Smart Portal A): tokenised customer tracking link.
       trackingUrl(awb) above is kept exactly as-is because the QR codes on
       AWB labels already printed and stuck to parcels in the field encode
       that AWB-based URL -- changing it would brick every label already in
       circulation. This is the richer, unguessable-token link a merchant
       shares directly with one customer; it is the only path that exposes
       the COD amount and consignee first name. */
    function customerTrackUrl(p){
      var tok=(p&&p.trackingToken)||"";
      if(!tok) return "";
      /* Was "/track.html" -- a file that has never existed in this repo. Every
         customer tracking link a merchant shared 404'd. The page is
         tracking.html, and its ?t= branch is the one that returns the full
         journey via public_track_parcel(). */
      try{ return location.origin+"/tracking.html?t="+encodeURIComponent(tok); }
      catch(e){ return "https://novaxlogistics.com/tracking.html?t="+encodeURIComponent(tok); }
    }
    function customerTrackMessage(p){
      var url=customerTrackUrl(p);
      if(!url) return "";
      var name=(p&&p.consignee)?String(p.consignee).split(" ")[0]:"";
      return "Assalam o Alaikum"+(name?(" "+name):"")+", aapka parcel NovaX se bhaija gaya hai.\n"+
             "AWB: "+(p.awb||"")+
             ((p&&Number(p.cod)>0)?("\nCOD: Rs "+Number(p.cod).toLocaleString("en-PK")+" (cash tayyar rakhein)"):"")+
             "\n\nLive tracking: "+url;
    }
    function shareTrackingLink(awb){
      var p=(state.parcels||[]).find(function(x){ return x.awb===awb; });
      if(!p){ toast("Parcel not found."); return; }
      var url=customerTrackUrl(p);
      if(!url){
        toast("This parcel has no tracking link yet. Refresh the page once the parcel has synced.");
        return;
      }
      try{
        if(navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(url).then(function(){ toast("Tracking link copied. Send it to your customer."); },
                                                  function(){ toast("Tracking link: "+url); });
        }else{ toast("Tracking link: "+url); }
      }catch(e){ toast("Tracking link: "+url); }
    }
    function whatsappTrackingLink(awb){
      var p=(state.parcels||[]).find(function(x){ return x.awb===awb; });
      if(!p){ toast("Parcel not found."); return; }
      var msg=customerTrackMessage(p);
      if(!msg){ toast("This parcel has no tracking link yet."); return; }
      var phone=String((p.phone||"")).replace(/[^0-9]/g,"");
      if(phone.length===11&&phone.charAt(0)==="0") phone="92"+phone.slice(1);
      var base=phone.length>=11?("https://wa.me/"+phone+"?text="):"https://wa.me/?text=";
      try{ window.open(base+encodeURIComponent(msg),"_blank","noopener"); }
      catch(e){ toast("Could not open WhatsApp."); }
    }
    function whatsappMessageText(p, kind){
      const step=WA_NEXT_STEP[kind]||"Please check the latest status using the tracking link below.";
      return `Hello ${escLabelText(p.consignee||"")}, this is NovaX Logistics.
AWB: ${p.awb}
Status: ${kind}
${step}
Track your parcel: ${trackingUrl(p.awb)}`;
    }
    function waSelectHtml(awb, selectedKind){
      return `<select id="waKind_${awb}" class="wa-kind-select" onclick="event.stopPropagation()" style="padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:inherit">${WA_MESSAGE_KINDS.map(k=>`<option value="${k}" ${k===selectedKind?"selected":""}>${k}</option>`).join("")}</select>`;
    }
    function waActionsHtml(awb, selectedKind){
      return `<div class="wa-actions" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center" onclick="event.stopPropagation()">${waSelectHtml(awb,selectedKind)}<button class="ghost-btn" onclick="event.stopPropagation();copyWhatsappMessage('${awb}', document.getElementById('waKind_${awb}').value)">Copy WhatsApp Message</button><button class="ghost-btn" onclick="event.stopPropagation();messageCustomer('${awb}', document.getElementById('waKind_${awb}').value)">Message Customer</button><button class="ghost-btn" onclick="event.stopPropagation();shareTrackingLink('${awb}')">Copy tracking link</button></div>`;
    }
    function copyWhatsappMessage(awb, kind){
      const p=state.parcels.find(x=>x.awb===awb);
      if(!p){ toast("Parcel not found.","error"); return; }
      const text=whatsappMessageText(p, kind||waKindForStatus(p.status));
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(()=>toast("WhatsApp message copied. Paste it to send.")).catch(()=>toast("Could not copy the message.","error"));
      } else { toast("Clipboard isn't available in this browser.","error"); }
    }
    function messageCustomer(awb, kind){
      const p=state.parcels.find(x=>x.awb===awb);
      if(!p){ toast("Parcel not found.","error"); return; }
      if(!p.phone){ toast("No consignee phone saved for this parcel. Add a phone number before messaging.","error"); return; }
      const digits=waPhoneDigits(p.phone);
      if(!digits){ toast(`Consignee phone "${p.phone}" doesn't look like a valid Pakistani number.`,"error"); return; }
      const text=whatsappMessageText(p, kind||waKindForStatus(p.status));
      window.open("https://wa.me/"+digits+"?text="+encodeURIComponent(text), "_blank");
    }
    /* ===== NovaX fix (offline QR + Code128 generation) =====
       Every AWB used to be sent to api.qrserver.com and barcode.tec-it.com
       just to draw a shipping label, leaking the AWB / tracking URL of every
       parcel to two third parties on every print. Both codes are now built
       locally as inline SVG data URLs: no CDN, no network request, works
       fully offline. qrUrl(awb) and barcodeUrl(awb) keep their names and
       still return a string that can be dropped straight into an <img src>,
       so awbLabelHtml(), the print flows and the modals are unchanged. */
    (function(){
      /* ---- GF(256) tables + Reed-Solomon (QR error correction) ---- */
      var EXP=new Array(512), LOG=new Array(256);
      (function(){ var x=1; for(var i=0;i<255;i++){ EXP[i]=x; LOG[x]=i; x<<=1; if(x&0x100) x^=0x11d; } for(var j=255;j<512;j++) EXP[j]=EXP[j-255]; })();
      function gmul(a,b){ if(a===0||b===0) return 0; return EXP[LOG[a]+LOG[b]]; }
      function rsGenerator(deg){
        var poly=[1];
        for(var i=0;i<deg;i++){
          var next=new Array(poly.length+1); for(var z=0;z<next.length;z++) next[z]=0;
          for(var j=0;j<poly.length;j++){ next[j]^=poly[j]; next[j+1]^=gmul(poly[j],EXP[i]); }
          poly=next;
        }
        return poly;
      }
      function rsEncode(data,ecLen){
        var gen=rsGenerator(ecLen);
        var res=new Array(data.length+ecLen); for(var z=0;z<res.length;z++) res[z]=0;
        for(var i=0;i<data.length;i++) res[i]=data[i];
        for(var i2=0;i2<data.length;i2++){
          var coef=res[i2];
          if(coef!==0){ for(var j=0;j<gen.length;j++) res[i2+j]^=gmul(gen[j],coef); }
        }
        return res.slice(data.length);
      }
      /* Error correction level M, versions 1-6 (all blocks equal size). */
      var QR_M=[null,
        {total:26,ec:10,blocks:1},
        {total:44,ec:16,blocks:1},
        {total:70,ec:26,blocks:1},
        {total:100,ec:18,blocks:2},
        {total:134,ec:24,blocks:2},
        {total:172,ec:16,blocks:4}
      ];
      function utf8Bytes(text){
        var out=[], s=String(text===undefined||text===null?"":text);
        for(var i=0;i<s.length;i++){
          var c=s.charCodeAt(i);
          if(c<0x80) out.push(c);
          else if(c<0x800){ out.push(0xc0|(c>>6),0x80|(c&63)); }
          else { out.push(0xe0|(c>>12),0x80|((c>>6)&63),0x80|(c&63)); }
        }
        return out;
      }
      function bitLen(n){ var l=0; while(n!==0){ n>>>=1; l++; } return l; }
      function formatBits(mask){
        var data=(0<<3)|mask; /* EC level M == 0b00 */
        var d=data<<10, rem=d;
        while(bitLen(rem)>=11) rem^=0x537<<(bitLen(rem)-11);
        return ((d|rem)^0x5412)&0x7fff;
      }
      function maskFn(m,r,c){
        switch(m){
          case 0: return ((r+c)%2)===0;
          case 1: return (r%2)===0;
          case 2: return (c%3)===0;
          case 3: return ((r+c)%3)===0;
          case 4: return ((Math.floor(r/2)+Math.floor(c/3))%2)===0;
          case 5: return (((r*c)%2)+((r*c)%3))===0;
          case 6: return (((((r*c)%2)+((r*c)%3))%2))===0;
          default: return (((((r+c)%2)+((r*c)%3))%2))===0;
        }
      }
      function qrMatrix(text){
        var bytes=utf8Bytes(text), version=0, v;
        for(v=1;v<=6;v++){ var cap=QR_M[v].total-QR_M[v].ec*QR_M[v].blocks; if(bytes.length<=cap-2){ version=v; break; } }
        if(!version) return null;
        var spec=QR_M[version], dataCw=spec.total-spec.ec*spec.blocks;
        var bits=[];
        function push(val,len){ for(var b=len-1;b>=0;b--) bits.push((val>>b)&1); }
        push(4,4); push(bytes.length,8);
        for(var i=0;i<bytes.length;i++) push(bytes[i],8);
        var capBits=dataCw*8, term=Math.min(4,capBits-bits.length);
        if(term>0) push(0,term);
        while(bits.length%8!==0) bits.push(0);
        var pad=[0xEC,0x11], pi=0;
        while(bits.length<capBits) push(pad[(pi++)%2],8);
        var cw=[];
        for(var k=0;k<bits.length;k+=8){ var byte=0; for(var b2=0;b2<8;b2++) byte=(byte<<1)|bits[k+b2]; cw.push(byte); }
        var perBlock=dataCw/spec.blocks, dBlocks=[], eBlocks=[];
        for(var b3=0;b3<spec.blocks;b3++){ var blk=cw.slice(b3*perBlock,(b3+1)*perBlock); dBlocks.push(blk); eBlocks.push(rsEncode(blk,spec.ec)); }
        var finalCw=[];
        for(var q=0;q<perBlock;q++) for(var b4=0;b4<spec.blocks;b4++) finalCw.push(dBlocks[b4][q]);
        for(var q2=0;q2<spec.ec;q2++) for(var b5=0;b5<spec.blocks;b5++) finalCw.push(eBlocks[b5][q2]);
        var size=17+4*version, mod=[], fn=[], r, c;
        for(r=0;r<size;r++){ var mr=[], fr=[]; for(c=0;c<size;c++){ mr.push(0); fr.push(false); } mod.push(mr); fn.push(fr); }
        function setFn(rr,cc,dark){ if(rr<0||cc<0||rr>=size||cc>=size) return; mod[rr][cc]=dark?1:0; fn[rr][cc]=true; }
        function finder(r0,c0){
          for(var dr=-1;dr<=7;dr++) for(var dc=-1;dc<=7;dc++){
            var rr=r0+dr, cc=c0+dc;
            if(rr<0||cc<0||rr>=size||cc>=size) continue;
            var inner=(dr>=0&&dr<=6&&dc>=0&&dc<=6), dark=false;
            if(inner){ var d=Math.max(Math.abs(dr-3),Math.abs(dc-3)); dark=(d!==2); }
            setFn(rr,cc,dark);
          }
        }
        finder(0,0); finder(0,size-7); finder(size-7,0);
        for(var t=8;t<size-8;t++){ setFn(6,t,(t%2)===0); setFn(t,6,(t%2)===0); }
        if(version>=2){
          var a=size-7;
          for(var ar=-2;ar<=2;ar++) for(var ac=-2;ac<=2;ac++) setFn(a+ar,a+ac,Math.max(Math.abs(ar),Math.abs(ac))!==1);
        }
        for(var f=0;f<9;f++){ if(!fn[8][f]) setFn(8,f,false); if(!fn[f][8]) setFn(f,8,false); }
        for(var f2=0;f2<8;f2++){ if(!fn[8][size-1-f2]) setFn(8,size-1-f2,false); if(!fn[size-1-f2][8]) setFn(size-1-f2,8,false); }
        setFn(size-8,8,true);
        var allBits=[];
        for(var i3=0;i3<finalCw.length;i3++) for(var b6=7;b6>=0;b6--) allBits.push((finalCw[i3]>>b6)&1);
        var bitIdx=0, up=true;
        for(var col=size-1;col>0;col-=2){
          if(col===6) col--;
          for(var step=0;step<size;step++){
            var row=up?(size-1-step):step;
            for(var off=0;off<2;off++){
              var cc2=col-off;
              if(fn[row][cc2]) continue;
              mod[row][cc2]=(bitIdx<allBits.length)?allBits[bitIdx]:0;
              bitIdx++;
            }
          }
          up=!up;
        }
        function placeFormat(m,mask){
          var f3=formatBits(mask), i4, bit;
          for(i4=0;i4<15;i4++){
            bit=(f3>>>i4)&1;
            if(i4<6) m[8][i4]=bit;
            else if(i4===6) m[8][7]=bit;
            else if(i4===7) m[8][8]=bit;
            else if(i4===8) m[7][8]=bit;
            else m[14-i4][8]=bit;
            if(i4<8) m[size-1-i4][8]=bit;
            else m[8][size-15+i4]=bit;
          }
          m[size-8][8]=1;
        }
        function penalty(m){
          var score=0, rr, cc, run, dark=0;
          for(rr=0;rr<size;rr++){ run=1; for(cc=1;cc<size;cc++){ if(m[rr][cc]===m[rr][cc-1]) run++; else { if(run>=5) score+=3+(run-5); run=1; } } if(run>=5) score+=3+(run-5); }
          for(cc=0;cc<size;cc++){ run=1; for(rr=1;rr<size;rr++){ if(m[rr][cc]===m[rr-1][cc]) run++; else { if(run>=5) score+=3+(run-5); run=1; } } if(run>=5) score+=3+(run-5); }
          for(rr=0;rr<size-1;rr++) for(cc=0;cc<size-1;cc++){ var vv=m[rr][cc]; if(vv===m[rr][cc+1]&&vv===m[rr+1][cc]&&vv===m[rr+1][cc+1]) score+=3; }
          var pat=[1,0,1,1,1,0,1];
          function look(r0,c0,dr,dc){
            for(var i5=0;i5<7;i5++){ var rr2=r0+dr*i5, cc3=c0+dc*i5; if(rr2<0||cc3<0||rr2>=size||cc3>=size||m[rr2][cc3]!==pat[i5]) return false; }
            var before=true, after=true, j;
            for(j=1;j<=4;j++){ var rb=r0-dr*j, cb=c0-dc*j; if(rb<0||cb<0||rb>=size||cb>=size||m[rb][cb]!==0){ before=false; break; } }
            for(j=7;j<11;j++){ var ra=r0+dr*j, ca=c0+dc*j; if(ra<0||ca<0||ra>=size||ca>=size||m[ra][ca]!==0){ after=false; break; } }
            return before||after;
          }
          for(rr=0;rr<size;rr++) for(cc=0;cc<size;cc++){ if(look(rr,cc,0,1)) score+=40; if(look(rr,cc,1,0)) score+=40; }
          for(rr=0;rr<size;rr++) for(cc=0;cc<size;cc++) if(m[rr][cc]) dark++;
          score+=Math.floor(Math.abs((dark*100/(size*size))-50)/5)*10;
          return score;
        }
        var best=null, bestScore=Infinity;
        for(var mk=0;mk<8;mk++){
          var cand=[];
          for(r=0;r<size;r++) cand.push(mod[r].slice());
          for(r=0;r<size;r++) for(c=0;c<size;c++) if(!fn[r][c]&&maskFn(mk,r,c)) cand[r][c]^=1;
          placeFormat(cand,mk);
          var sc=penalty(cand);
          if(sc<bestScore){ bestScore=sc; best=cand; }
        }
        return best;
      }
      function qrSvgDataUrl(text,px){
        var m=null;
        try{ m=qrMatrix(text); }catch(e){ m=null; }
        if(!m) return null;
        var n=m.length, quiet=4, total=n+quiet*2, rects="", r, c;
        for(r=0;r<n;r++){
          c=0;
          while(c<n){
            if(m[r][c]){ var start=c; while(c<n&&m[r][c]) c++; rects+='<rect x="'+(start+quiet)+'" y="'+(r+quiet)+'" width="'+(c-start)+'" height="1"/>'; }
            else c++;
          }
        }
        var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+px+'" height="'+px+'" viewBox="0 0 '+total+' '+total+'" shape-rendering="crispEdges"><rect width="'+total+'" height="'+total+'" fill="#ffffff"/><g fill="#000000">'+rects+'</g></svg>';
        return "data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
      }
      /* ---- Code128 (code set B) ---- */
      var C128=["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321","112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121","313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111","314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212","124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112"];
      function code128SvgDataUrl(value,widthPx,heightPx){
        var s=String(value===undefined||value===null?"":value).replace(/[^ -~]/g,"");
        if(!s) s=" ";
        var codes=[104], sum=104, i;
        for(i=0;i<s.length;i++){ var v=s.charCodeAt(i)-32; codes.push(v); sum+=v*(i+1); }
        codes.push(sum%103);
        codes.push(106);
        var pattern="";
        for(i=0;i<codes.length;i++) pattern+=C128[codes[i]];
        var units=20, k;
        for(k=0;k<pattern.length;k++) units+=Number(pattern.charAt(k));
        var x=10, bars="", isBar=true;
        for(k=0;k<pattern.length;k++){
          var w=Number(pattern.charAt(k));
          if(isBar) bars+='<rect x="'+x+'" y="0" width="'+w+'" height="100"/>';
          x+=w; isBar=!isBar;
        }
        var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+widthPx+'" height="'+heightPx+'" viewBox="0 0 '+units+' 100" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="'+units+'" height="100" fill="#ffffff"/><g fill="#000000">'+bars+'</g></svg>';
        return "data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
      }
      window.__novaxQrSvg=qrSvgDataUrl;
      window.__novaxCode128Svg=code128SvgDataUrl;
    })();
    function qrUrl(awb){
      var target="";
      try{ target=trackingUrl(awb); }catch(e){ target=String(awb||""); }
      /* Falls back to encoding just the AWB if a very long tracking URL will
         not fit in a locally generated (version 1-6) symbol. */
      return window.__novaxQrSvg(target,220)||window.__novaxQrSvg(String(awb||""),220)||"";
    }
    function barcodeUrl(awb){ return window.__novaxCode128Svg(String(awb||""),320,96)||""; }

    function renderMetrics(){
      const cm=clientMetrics();
      /* Denominator is ratedTotal, not total -- see nvIsRatedParcel(). With
         nothing picked up yet the rate is UNDEFINED, not 0%: percent(x,0)
         returns 0, which would show a brand-new merchant "0/0, 0%" in amber
         on their first morning. Show an em dash and stay neutral instead. */
      const rated=cm.ratedTotal;
      const rate=rated?percent(cm.delivered,rated):0;
      const rateKnown=rated>0;
      const ops=Math.round(cm.avgProgress*100);
      const nvMetricsEl0=document.getElementById("clientMetrics");
      const wasExpanded=nvMetricsEl0 && nvMetricsEl0.classList.contains("nv-show-all");
      document.getElementById("clientMetrics").innerHTML=[
        metricCard("My Parcels",cm.total,ops,"in selected range","blue","📦","clear"),
        metricCard("Delivered",
          rateKnown?`${cm.delivered}/${rated}`:"\u2014",
          rate,
          rateKnown?`of ${rated} picked up`:"nothing picked up yet",
          (rateKnown&&rate<40)?"amber":"","✅","filter:Delivered",!rateKnown),
        metricCard("Delivery Charges",money(cm.deliveryCharges),percent(cm.deliveryCharges,3000),"courier charges","amber","💳","filter:Delivered"),
        metricCard("Invoice Payable Pending",money(cm.payable),percent(cm.payable,60000),"delivered, not yet in wallet","good","🧾","tab:payments"),
        metricCard("Wallet Balance",money(Number((state.client&&state.client.walletBalance)||0)),percent(Number((state.client&&state.client.walletBalance)||0),60000),"ready to withdraw","blue","💰","tab:wallet"),
        '<button type="button" id="nvMetricsToggle" class="ghost-btn nv-metrics-toggle" style="display:none" onclick="var g=document.getElementById(&quot;clientMetrics&quot;); g.classList.toggle(&quot;nv-show-all&quot;); this.textContent=g.classList.contains(&quot;nv-show-all&quot;)?&quot;Show fewer metrics&quot;:&quot;Show all metrics&quot;;">Show all metrics</button>'
      ].join("");
      if(wasExpanded){ document.getElementById("clientMetrics").classList.add("nv-show-all"); var nvT=document.getElementById("nvMetricsToggle"); if(nvT) nvT.textContent="Show fewer metrics"; }
    }
    function filteredParcels(){ const t=(document.getElementById("clientSearch")?.value||"").trim().toLowerCase(); return clientScopedParcels().filter(p=>`${p.awb} ${p.consignee} ${p.city} ${p.status}`.toLowerCase().includes(t)); }
    /* NovaX (detail drawer): clicking a parcel used to force a tab change back
       to Dashboard, a full render() and a scroll -- losing the merchant's place
       in whatever list they were reading. It now opens a right-hand drawer over
       the current view. state.selectedAwb is still set and the dashboard
       journey panel still works, so nothing that depended on the old behaviour
       breaks; the drawer is simply the fast path. Falls back to the original
       navigation if the UI module is unavailable. */
    function nvParcelDrawerHtml(p){
      const U=window.NovaXUI;
      const FLOW=["New booked","Collected by rider","Arrived at warehouse","Parcel now in transit","Parcel received at destination","Parcel out for delivery","Delivered"];
      const recorded=Array.isArray(p.steps)?p.steps:[];
      const cur=p.status;
      // Build the journey from the forward flow, marking what has happened.
      // A parcel in a return/exception state is off the flow, so its own state
      // is appended rather than pretending it sits on the delivery path.
      const idx=FLOW.indexOf(cur);
      let rows=[];
      if(idx>=0){
        rows=FLOW.slice(0,Math.max(idx+1,1)).map((s,i)=>({status:s,label:U.statusMeta(s).short,
          state:i===idx?"now":"done"}));
        FLOW.slice(idx+1).forEach(s=>rows.push({status:s,label:U.statusMeta(s).short,state:"todo"}));
      } else {
        rows=recorded.filter(s=>FLOW.indexOf(s)>-1).map(s=>({status:s,label:U.statusMeta(s).short,state:"done"}));
        rows.push({status:cur,label:U.statusMeta(cur).short,state:"now",note:p.exception||""});
      }
      const tel=String(p.phone||"").replace(/[^0-9+]/g,"");
      const paid=nvIsPaidParcel(p);
      return ''+
      '<div class="nvdr-sec">'+
        '<div class="nvdr-money">'+(Number(p.cod)>0?escLabelText(money(p.cod)):"Prepaid")+
          '<small>'+(Number(p.cod)>0?"COD to collect":"no cash due")+'</small></div>'+
        '<div style="margin-top:8px">'+U.statusPill(p.status)+(paid?' <span class="nv-paid-tape">PAID</span>':'')+'</div>'+
        (p.exception?'<div class="nvdr-why"><span>'+
            (/return|refus|cancel/i.test(String(p.status||"")) ? "Why it came back" : "What happened")+
          '</span>'+escLabelText(p.exception)+'</div>':'')+
      '</div>'+
      '<div class="nvdr-sec"><h4>Shipment</h4><dl class="nvdr-kv">'+
        '<dt>Consignee</dt><dd>'+escLabelText(p.consignee||"—")+'</dd>'+
        '<dt>City</dt><dd>'+escLabelText(p.city||"—")+'</dd>'+
        '<dt>Address</dt><dd>'+escLabelText(p.address||"Not provided")+'</dd>'+
        '<dt>Phone</dt><dd>'+escLabelText(p.phone||"Not provided")+'</dd>'+
        '<dt>Delivery charge</dt><dd>'+escLabelText(money(p.fee||0))+'</dd>'+
        (p.orderId?'<dt>Your order</dt><dd>'+escLabelText(p.orderId)+'</dd>':'')+
        '<dt>Booked</dt><dd>'+escLabelText(p.date||"—")+'</dd>'+
      '</dl></div>'+
      '<div class="nvdr-sec"><h4>Journey</h4>'+nvJourneyHtml(p,rows)+'</div>'+
      '<div class="nvdr-actions">'+
        (tel?'<a href="tel:'+escLabelText(tel)+'">Call consignee</a>':'')+
        '<button type="button" class="nvdr-primary" data-nv-drawer-act="print" data-awb="'+escLabelText(p.awb)+'">Print AWB</button>'+
        '<button type="button" data-nv-drawer-act="track" data-awb="'+escLabelText(p.awb)+'">Open tracking</button>'+
        '<button type="button" data-nv-drawer-act="copytrack" data-awb="'+escLabelText(p.awb)+'">Copy link</button>'+
        '<button type="button" data-nv-drawer-act="sharetrack" data-awb="'+escLabelText(p.awb)+'">Share</button>'+
        /* Desktop has no parcel card, so the drawer is the ONLY place these
           two reach a merchant on a laptop. Same gates as the mobile card. */
        (isEditableBooking(p)
          ? '<button type="button" data-nv-drawer-act="edit" data-awb="'+escLabelText(p.awb)+'">Edit booking</button>' : '')+
        (nvCanRaiseTicket(p) && (typeof nvCanUseTab!=="function" || nvCanUseTab("tickets"))
          ? '<button type="button" data-nv-drawer-act="ticket" data-awb="'+escLabelText(p.awb)+'">Report an issue</button>' : '')+
      '</div>';
    }
    /* ═══ Journey timestamps, Pakistan Standard Time ══════════════════════
       Admin already records a processHistory entry per status change into
       parcel meta ({status, at, processor}); the client portal simply never
       read it, so the drawer showed the sequence of steps with no idea WHEN
       any of it happened. Everything renders in Asia/Karachi regardless of
       the device's own timezone -- a merchant checking from Dubai must see
       the same clock as their warehouse. */
    function nvPkt(v){
      if(!v) return null;
      var raw = String(v);
      /* BUG: a bare "2026-08-25" became "2026-08-25+05:00" -- a date with an
         offset but no time, which is not valid ISO, so every date-only value
         in the portal parsed to Invalid Date and this returned null. Parcels
         store exactly that in .date, so anything asking "when was this
         booked" silently got nothing. Give a date-only value a midnight PKT
         time before the offset. */
      if(/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw = raw + "T00:00:00+05:00";
      else if(raw.indexOf("T") === -1) raw = raw.replace(" ", "T") + (raw.length <= 16 ? "+05:00" : "");
      var d = new Date(raw);
      return isNaN(d) ? null : d;
    }
    /* THE one definition of a Pakistani mobile number in this file.
       Accepts every way a person or a spreadsheet writes one --
       03001234567 / 0300 123 4567 / 0300-123-4567 / +92 300 1234567 /
       +923001234567 / 00923001234567 / 3001234567 -- and returns the single
       canonical local form 03XXXXXXXXX, or "" if it is not a valid mobile.

       Booking, bulk import, edit-parcel and the WhatsApp paste parser each
       had their own rules and disagreed; this is what they should all call. */
    function nvNormalizePkPhone(raw){
      var d=String(raw==null?"":raw).replace(/[^\d]/g,"");
      if(!d) return "";
      if(d.length===14 && d.slice(0,4)==="0092") d=d.slice(4);
      else if(d.length===13 && d.slice(0,3)==="092") d=d.slice(3);
      else if(d.length===12 && d.slice(0,2)==="92") d=d.slice(2);
      else if(d.length===11 && d.charAt(0)==="0")  d=d.slice(1);
      return /^3\d{9}$/.test(d) ? ("0"+d) : "";
    }
    try{ window.nvNormalizePkPhone=nvNormalizePkPhone; }catch(e){}

    /* ── Delivery promise ────────────────────────────────────────────────
       The service standard NovaX commits to, set by the business -- NOT a
       prediction from history. Aisha set these on 30 Aug 2026.

       For the record, because the gap matters operationally: measured over
       the last 120 days, Karachi's p80 was 3.6 days (n=226) and Lahore's
       median was 8.7 days (n=55). These targets are therefore a commitment
       ops has to hit, not a description of what happens today. If they slip,
       merchants see a missed promise on every parcel -- so this is the one
       constant in the portal worth revisiting when TAT changes.

       client_delivery_estimate() in sql_novax_client_portal_v4.sql returns
       the real observed figures if you ever want to compare the two. */
    var NV_DELIVERY_PROMISE = {
      "karachi":    { min: 1, max: 1, label: "Next day" },
      "lahore":     { min: 3, max: 4, label: "3\u20134 days" },
      "islamabad":  { min: 3, max: 4, label: "3\u20134 days" },
      "rawalpindi": { min: 3, max: 4, label: "3\u20134 days" }
    };
    var NV_DELIVERY_DEFAULT = { min: 3, max: 4, label: "3\u20134 days" };

    function nvDeliveryPromise(city){
      var k = String(city == null ? "" : city).trim().toLowerCase();
      return NV_DELIVERY_PROMISE[k] || NV_DELIVERY_DEFAULT;
    }

    /* "by Tue 2 Sep" -- the upper bound of the promise, counted from booking,
       so a merchant can repeat one date to their customer. Sundays are not
       skipped: NovaX delivers seven days a week, and inventing a working-day
       rule the operation does not follow would make the date wrong. */
    function nvExpectedBy(parcel){
      try{
        var pr = nvDeliveryPromise(parcel && parcel.city);
        var base = nvPkt(parcel && (parcel.bookedAt || parcel.booked_at || parcel.date));
        if(!base) return null;
        var d = new Date(base.getTime() + pr.max * 86400000);
        return { date: d, label: pr.label,
                 text: d.toLocaleDateString("en-GB", { timeZone:"Asia/Karachi", weekday:"short", day:"numeric", month:"short" }) };
      }catch(e){ return null; }
    }

    function nvPktLabel(v){
      var d=nvPkt(v);
      if(!d) return "";
      try{
        return d.toLocaleString("en-GB",{ timeZone:"Asia/Karachi", day:"numeric", month:"short",
                                          hour:"2-digit", minute:"2-digit", hour12:true });
      }catch(e){ return String(v).slice(0,16).replace("T"," "); }
    }
    /* "2d 4h" / "5h 20m" / "18m" -- how long the parcel sat at that step. */
    function nvGapLabel(from,to){
      var a=nvPkt(from), b=nvPkt(to);
      if(!a||!b) return "";
      var ms=b-a; if(!(ms>0)) return "";
      var m=Math.round(ms/60000), h=Math.floor(m/60), d=Math.floor(h/24);
      if(d>0) return d+"d "+(h%24)+"h";
      if(h>0) return h+"h "+(m%60)+"m";
      return m+"m";
    }
    /* Maps each timeline row to its recorded time, and the gap since the step
       before it. Falls back cleanly when a parcel predates processHistory. */
    function nvStampRows(p, rows){
      var hist=Array.isArray(p&&p.processHistory)?p.processHistory:[];
      var byStatus={};
      hist.forEach(function(h){
        if(!h||!h.status) return;
        var when=h.at||h.time||"";
        if(when && !byStatus[h.status]) byStatus[h.status]=when;
      });
      var prev=null;
      return rows.map(function(r){
        var when=byStatus[r.status]||"";
        if(!when && r.status==="New booked" && p.date) when=p.date;
        var out=Object.assign({},r);
        if(when){
          out.at=nvPktLabel(when);
          out.gap=prev?nvGapLabel(prev,when):"";
          prev=when;
        }
        return out;
      });
    }

    /* The timeline with its times. Keeps the existing dot/line vocabulary so
       nothing about the look changes -- it just stops being silent about when. */
    function nvJourneyHtml(p, rows){
      var stamped=nvStampRows(p,rows);
      return '<div class="nv-jt">'+stamped.map(function(r){
        var cls = r.state==="now" ? "is-now" : (r.state==="todo" ? "is-todo" : "is-done");
        return '<div class="nv-jt-row '+cls+'">'+
                 '<span class="nv-jt-dot"></span>'+
                 '<div class="nv-jt-body">'+
                   '<div class="nv-jt-label">'+escLabelText(r.label||r.status||"")+
                     (r.gap?'<span class="nv-jt-gap">+'+escLabelText(r.gap)+'</span>':'')+
                   '</div>'+
                   (r.at?'<div class="nv-jt-at">'+escLabelText(r.at)+' PKT</div>':
                         (r.state==="todo"?'':'<div class="nv-jt-at nv-jt-none">time not recorded</div>'))+
                   (r.note?'<div class="nv-jt-note">'+escLabelText(r.note)+'</div>':'')+
                 '</div>'+
               '</div>';
      }).join("")+'</div>';
    }

    function openClientParcelJourney(awb){
      state.selectedAwb=awb; saveState();
      const p=(state.parcels||[]).find(x=>x&&x.awb===awb);
      const U=window.NovaXUI;
      if(!p||!U||!U.openDrawer){
        state.activeClientTab="dashboard"; render();
        const j=document.getElementById("clientJourney"); if(j) j.scrollIntoView({behavior:"smooth",block:"center"});
        return;
      }
      try{
        U.openDrawer('<span>'+escLabelText(p.awb)+'</span><small>'+escLabelText(p.consignee||"")+
          (p.city?" · "+escLabelText(p.city):"")+'</small>', nvParcelDrawerHtml(p));
      }catch(e){
        state.activeClientTab="dashboard"; render();
      }
    }
    /* Empty-state CTAs route through the same delegated pattern as the rest. */
    document.addEventListener("click",function(e){
      const b=e.target&&e.target.closest?e.target.closest("[data-nv-empty-action]"):null;
      if(!b) return;
      const act=b.getAttribute("data-nv-empty-action");
      if(act && typeof showClientTab==="function") showClientTab(act);
    });
    /* NovaX (detail drawer): one delegated listener for the drawer's action
       buttons -- nothing merchant-derived is ever concatenated into an inline
       onclick, matching the pattern already used for metric-card actions. */
    document.addEventListener("click",function(e){
      const b=e.target&&e.target.closest?e.target.closest("[data-nv-drawer-act]"):null;
      if(!b) return;
      const act=b.getAttribute("data-nv-drawer-act");
      const awb=b.getAttribute("data-awb")||"";
      if(act==="print"){
        try{ window.NovaXUI.closeDrawer(); }catch(_){}
        state.selectedAwb=awb; saveState();
        if(typeof showClientTab==="function") showClientTab("awbLabel");
      } else if(act==="edit"){
        nvOpenEditParcel(awb, e);
      } else if(act==="ticket"){
        nvRaiseTicketFor(awb, e);
      } else if(act==="track" || act==="copytrack" || act==="sharetrack"){
        /* Prefer the tokenised link: it resolves to the FULL journey via
           public_track_parcel(). The ?awb= form only ever returns a status
           summary and tells the reader to "open the link your seller sent" --
           nonsense when the seller is the one holding it. */
        const p=(state.parcels||[]).find(x=>x&&x.awb===awb);
        const url=(typeof customerTrackUrl==="function" && customerTrackUrl(p))
                  || ((typeof trackingUrl==="function")?trackingUrl(awb)
                     :("https://novaxlogistics.com/tracking.html?awb="+encodeURIComponent(awb)));
        if(act==="track"){ try{ window.open(url,"_blank","noopener"); }catch(_){ toast(url); } return; }
        if(act==="sharetrack"){
          const msg=(typeof customerTrackMessage==="function" && customerTrackMessage(p)) || url;
          if(navigator.share){
            navigator.share({ title:"NovaX tracking "+awb, text:msg, url:url }).catch(function(){});
            return;
          }
          try{ window.open("https://wa.me/?text="+encodeURIComponent(msg),"_blank","noopener"); }
          catch(_){ toast(url); }
          return;
        }
        if(navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(url).then(function(){ toast("Tracking link copied.","success"); },function(){ toast(url); });
        } else toast(url);
      }
    });
    function selectParcel(awb){ state.selectedAwb=awb; saveState(); render(); }
    function pickupNotice(p){ if(p && p.status==='New booked' && (p.rider||p.riderId)){ var r=p.rider||p.riderId; var from=p.pickupCity||(state.client&&state.client.name)||'pickup point'; return `<div class="footer-note" style="color:#0c7c59;font-weight:800;margin-top:4px">Rider ${escLabelText(r)} assigned - will collect parcel from ${escLabelText(from)}</div>`; } return ''; }
    /* A parcel is "paid" the moment admin_generate_invoice_v2 stamps
       invoice_id on it. Returns are covered by the same test: a returned or
       refused parcel is only given an invoice_id once its delivery charge has
       been deducted on that invoice. */
    function nvIsPaidParcel(p){ return !!(p && p.invoiceId); }
    function nvPaidPill(p){ return nvIsPaidParcel(p) ? '<span class="nv-paid-tape" title="Invoiced &mdash; payment settled">PAID</span>' : ""; }
    function nvPaidRibbon(p){ return nvIsPaidParcel(p) ? '<span class="nv-paid-ribbon">PAID</span>' : ""; }

    /* ═══ Change-driven motion ══════════════════════════════════════════
       Remembers a signature per AWB and, on the next render, animates ONLY
       the rows whose signature actually moved. First paint of a list gets a
       one-time staggered entry instead, and seeding happens without
       animating so a tab switch or a search keystroke never looks like a
       status change. Purely presentational: it reads rendered rows and adds
       a class, never touches parcel data. */
    const NV_ROW_SIG = Object.create(null);   // listKey -> { awb: signature }
    function nvRowSignature(p){
      return [p.status, p.cod, p.fee, p.exception||"", p.stage, p.updated||""].join("|");
    }
    function nvMarkChanged(containerId, parcels, listKey){
      try{
        if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const host=document.getElementById(containerId);
        if(!host) return;
        const seen=NV_ROW_SIG[listKey];
        const next=Object.create(null);
        parcels.forEach(p=>{ if(p&&p.awb) next[p.awb]=nvRowSignature(p); });
        NV_ROW_SIG[listKey]=next;
        if(!seen){
          // First paint of this list: stagger everything in once, silently.
          Array.prototype.forEach.call(host.children,el=>el.classList.add("nv-enter"));
          return;
        }
        Array.prototype.forEach.call(host.children,el=>{
          const awb=el.getAttribute&&el.getAttribute("data-awb");
          if(!awb) return;
          if(!(awb in seen)) el.classList.add("nv-enter");            // newly booked
          else if(seen[awb]!==next[awb]) el.classList.add("nv-changed"); // moved
        });
      }catch(e){ /* cosmetic only */ }
    }

    /* Only the list that is actually on screen is built.

       The table and the card list are two renderings of the same parcels, and
       exactly one of them is display:none at every width -- cards at 760px and
       below, the table above it. Building both meant roughly 4,400 DOM nodes
       per render that nobody could see, about a quarter of the whole page, plus
       the string work to produce them. Measured with 220 active parcels: 4,451
       nodes for the hidden card list on desktop, 4,401 for the hidden table on
       a phone.

       The off-screen host is emptied rather than left holding stale markup, so
       it can never paint the previous render's parcels for a frame after the
       breakpoint is crossed. The matchMedia listener below is what makes that
       safe -- without it, a rotating phone would reveal an empty list. */
    const NV_CARDS_MQ = window.matchMedia("(max-width:760px)");
    /* One place that decides which per-parcel buttons exist, so the mobile
       card and the desktop table cannot drift apart on who is allowed to do
       what. The gates are deliberately mutually exclusive: edit/cancel while
       "New booked", raise a ticket once it has moved.

       BUG this fixes: only the mobile card ever called this. The desktop
       table rendered five columns and no actions, so a merchant on a laptop
       had no way to cancel a booking at all -- the feature existed only if
       you happened to be on a phone. The table now carries an Actions column
       fed by this same function, so the two views cannot diverge again. */
    function nvParcelCardActions(p){
      var btns=[];
      var a=escLabelText(p.awb);
      if(isEditableBooking(p)){
        btns.push('<button class="ghost-btn" type="button" onclick="nvOpenEditParcel(\''+a+'\',event)">Edit</button>');
      }
      if(isCancellableBooking(p)){
        btns.push('<button class="ghost-btn nv-cancel-booking" type="button" onclick="cancelClientBooking(\''+a+'\',event)">Cancel booking</button>');
      }
      if(nvCanRaiseTicket(p) && (typeof nvCanUseTab!=="function" || nvCanUseTab("tickets"))){
        btns.push('<button class="ghost-btn" type="button" onclick="nvRaiseTicketFor(\''+a+'\',event)">Report an issue</button>');
      }
      if(!btns.length) return "";
      return '<div class="inline-actions" style="margin-top:10px;flex-wrap:wrap;gap:6px">'+btns.join("")+'</div>';
    }

    function renderClientParcels(){ return nvKeepPlace(function(){ return __renderClientParcels(); }); }
    function __renderClientParcels(){
      const parcels=filteredParcels();
      const cardsOnScreen=NV_CARDS_MQ.matches;
      const rowsHost=document.getElementById("clientParcelRows");
      const cardsHost=document.getElementById("clientParcelCards");
      if(rowsHost) rowsHost.innerHTML = cardsOnScreen ? "" : (parcels.map(p=>{ const pr=nvProgressPct(p.status); return `<tr data-awb="${escLabelText(p.awb)}" class="clickable-row ${p.awb===state.selectedAwb?"selected":""}" onclick="openClientParcelJourney('${p.awb}')"><td><strong>${escLabelText(p.awb)}</strong> ${nvPaidPill(p)}<br><span class="footer-note">${escLabelText(p.city)} | ${escLabelText(p.updated)}</span></td><td>${escLabelText(p.consignee)}<br><span class="footer-note">${escLabelText(p.branch)}</span></td><td>${money(p.cod)}</td><td><span class="status ${statusClass(p)}"><span class="mini-dot"></span>${escLabelText(p.status)}</span>${pickupNotice(p)}</td><td><div class="meter ${statusClass(p)==="bad"?"red":"blue"}"><span style="width:${pr}%"></span></div><div class="meter-caption"><span>${nvProgressStep(p.status)}</span><span>${pr}%</span></div>${nvEtaHtml(p)}</td><td onclick="event.stopPropagation()">${nvPickupChipHtml(p)}${nvParcelCardActions(p)||''}${(!nvPickupChipHtml(p)&&!nvParcelCardActions(p))?'<span class="footer-note">&mdash;</span>':''}</td></tr>`; }).join("")||`<tr><td colspan="6">No parcels in range.</td></tr>`);
      if(cardsHost) cardsHost.innerHTML = cardsOnScreen ? (parcels.map(p=>{ const pr=nvProgressPct(p.status); return `<article data-awb="${escLabelText(p.awb)}" class="parcel-card ${p.awb===state.selectedAwb?"selected":""}" onclick="openClientParcelJourney('${p.awb}')">${nvPaidRibbon(p)}<div class="top"><strong>${escLabelText(p.awb)}</strong><span class="status ${statusClass(p)}"><span class="mini-dot"></span>${escLabelText(p.status)}</span></div>${pickupNotice(p)}<dl><div><dt>Consignee</dt><dd>${escLabelText(p.consignee)}</dd></div><div><dt>City</dt><dd>${escLabelText(p.city)}</dd></div><div><dt>COD</dt><dd>${money(p.cod)}</dd></div><div><dt>Updated</dt><dd>${escLabelText(p.updated)}</dd></div></dl><div class="meter ${statusClass(p)==="bad"?"red":"blue"}" style="margin-top:12px"><span style="width:${pr}%"></span></div>${nvEtaHtml(p)}${nvPickupChipHtml(p)}${nvParcelCardActions(p)}</article>`; }).join("")) : "";
      if(cardsOnScreen) nvMarkChanged("clientParcelCards",parcels,"cards");
      else nvMarkChanged("clientParcelRows",parcels,"rows");
    }
    try{
      var nvSwapParcelLists=function(){ try{ renderClientParcels(); }catch(e){} };
      if(NV_CARDS_MQ.addEventListener) NV_CARDS_MQ.addEventListener("change", nvSwapParcelLists);
      else if(NV_CARDS_MQ.addListener) NV_CARDS_MQ.addListener(nvSwapParcelLists);
    }catch(e){}

    function toggleStatusBoard(){ state.statusBoardOpen=!state.statusBoardOpen; renderClientStatusBoard(); }
    function renderClientStatusBoard(){
      const el=document.getElementById("clientStatusBoard"); if(!el) return;
      const parcels=clientScopedParcels(); const groups={};
      parcels.forEach(p=>{ (groups[p.status]=groups[p.status]||[]).push(p); });
      const order=STATUS_TAGS.filter(s=>groups[s]);
      const open=!!state.statusBoardOpen;
      const sum=document.getElementById("statusBoardSummary"); if(sum) sum.textContent=parcels.length?`${parcels.length} parcel(s) in ${order.length} status group(s) — tap to ${open?"collapse":"expand"}.`:"No parcels in the selected range.";
      const chev=document.getElementById("statusBoardChevron"); if(chev) chev.textContent=open?"▾":"▸";
      el.style.display=open?"flex":"none";
      if(!open){ el.innerHTML=""; return; }
      el.innerHTML=order.map(s=>`<div class="status-col"><div class="status-col-head"><strong>${s}</strong><span class="chip info">${groups[s].length}</span></div>${groups[s].map(p=>`<div class="sb-parcel" onclick="openClientParcelJourney('${escLabelText(p.awb)}')"><span class="sb-awb">${escLabelText(p.awb)}</span><span class="sb-meta">${escLabelText(p.consignee)} &middot; ${escLabelText(p.city)}</span><span class="sb-meta">${money(p.cod)} &middot; ${alertForParcel(p).label} &middot; ${agingLabel(agingHours(p))} old</span></div>`).join("")}</div>`).join("") || `<div class="ops-card"><strong>No parcels in range</strong><p>Adjust the date range or book a parcel to populate the board.</p></div>`;
    }
    /* ===== AI Exception Resolution Center: deterministic problem/cause/action card ===== */
    function classifyParcelException(p){
      try{
        var status=String((p&&p.status)||"");
        var exc=String((p&&p.exception)||"");
        var text=(status+" "+exc).toLowerCase();
        if(/disputed|denies/.test(text)){
          return { key:"disputed", problem:"Consignee disputes the delivery attempt.", cause:"Mismatch between the rider's attempt log and what the consignee says happened.", action:"Review the rider's proof below, message the consignee to clarify, then Reattempt or Return." };
        }
        if(/refus/.test(text)){
          return { key:"refused", problem:"Consignee refused the parcel.", cause:"Consignee may have changed their mind, disagreed on price, or expected a different item.", action:"Message the consignee to confirm intent, then Reattempt if they still want it or Return it to origin." };
        }
        if(/not available/.test(text)){
          return { key:"not_available", problem:"Consignee was not available for delivery.", cause:"Consignee may be unreachable, at work, or the address/time did not match.", action:"Message the consignee to confirm a better time, then Reattempt." };
        }
        if(typeof isRiderCashHolding==="function" && isRiderCashHolding(p)){
          return { key:"cash", problem:"Rider is holding COD cash for this parcel.", cause:"Cash has not yet been marked as collected or deposited.", action:"Confirm cash status with operations before closing this parcel." };
        }
        if(/return/.test(text)){
          return { key:"return", problem:"Parcel is moving through the return flow.", cause:"Consignee declined delivery or it was marked for return.", action:"Confirm the return reaches origin and follow up if it stalls." };
        }
        if(typeof isDelayed==="function" && isDelayed(p) && status!=="Delivered"){
          return { key:"delayed", problem:"This parcel has been stuck for over 24 hours.", cause:"Possible transit delay, warehouse backlog, or rider availability issue.", action:"Follow up with operations if it doesn't move soon, or message the consignee for an update." };
        }
        return { key:"generic", problem: exc?exc:"This parcel is flagged for review.", cause:"Marked as needing attention based on its current status.", action:"Check the parcel journey and contact the consignee if needed." };
      }catch(e){
        return { key:"generic", problem:"This parcel needs review.", cause:"Unable to read exception details.", action:"Follow up with operations if the issue continues." };
      }
    }
    function hasResolvableException(p){
      try{
        if(!p) return false;
        if(typeof isRefusalReview==="function" && isRefusalReview(p)) return true;
        if(typeof isRiderCashHolding==="function" && isRiderCashHolding(p)) return true;
        if(p.exception && String(p.exception).trim() && p.status!=="Delivered") return true;
        if(typeof isDelayed==="function" && isDelayed(p) && p.status!=="Delivered") return true;
        return false;
      }catch(e){ return false; }
    }
    function exceptionMessageText(p,cls){
      var c=cls||classifyParcelException(p);
      return "Hi "+(p.consignee||"there")+", this is about your order "+p.awb+". "+c.problem+" "+c.action+" Please let us know how you'd like to proceed.";
    }
    function renderExceptionCard(p){
      try{
        var cls=classifyParcelException(p);
        var hideDeliveryActions=(cls.key==="cash"||cls.key==="delayed"||cls.key==="return");
        var btns="";
        btns+=`<button class="ghost-btn" type="button" onclick="copyExceptionMessage('${p.awb}')">Copy Message</button>`;
        if(!hideDeliveryActions) btns+=`<button class="action-btn" type="button" onclick="requestRedelivery('${p.awb}')">Reattempt</button><button class="ghost-btn" type="button" onclick="requestReturnToOrigin('${p.awb}')">Return</button>`;
        btns+=`<button class="ghost-btn" type="button" onclick="messageCustomerException('${p.awb}')">Message Customer</button>`;
        /* Admin can correct a mis-typed city on a booked parcel; a merchant
           previously had to phone support. This gives them the same route
           without letting them re-zone their own parcel unilaterally --
           changing the destination city changes the zone and therefore the
           price, so it goes to ops as a request rather than a direct edit. */
        btns+=`<button class="ghost-btn" type="button" onclick="requestAddressFix('${p.awb}')">Wrong address / city</button>`;
        return `<div class="review-panel" id="clientExceptionCard"><div class="section-head" style="margin-bottom:8px"><div><h3>AI Exception Resolution</h3><p>Deterministic read of this parcel's issue and the fastest next step.</p></div><span class="chip warn">review needed</span></div><div class="money-grid">${moneyBox("Problem",cls.problem,"")}${moneyBox("Likely cause",cls.cause,"")}${moneyBox("Recommended action",cls.action,"")}</div><div class="inline-actions" style="margin-top:10px;flex-wrap:wrap">${btns}</div></div>`;
      }catch(e){ return ""; }
    }
    function copyExceptionMessage(awb){
      try{
        var p=state.parcels.find(function(x){ return x.awb===awb; }); if(!p){ toast("Parcel not found."); return; }
        var msg=exceptionMessageText(p);
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(msg).then(function(){ toast("Message copied."); }).catch(function(){ toast("Could not copy message."); });
        } else { toast("Copy not supported on this device."); }
      }catch(e){}
    }
    function requestReturnToOrigin(awb){
      // NovaX fix (item 2): this used to only ever push to the local
      // operationsIssues array, which client sync never uploads -- admin
      // never actually received these. This now calls a real, RLS-safe RPC
      // and only marks the parcel / shows "sent" once Supabase actually
      // accepts the request. If it fails, the parcel status is left alone
      // and a clear error is shown instead of a false success toast.
      // NovaX fix (item 3 follow-up): returns the underlying promise so
      // callers (like Autopilot) can wait for the real result instead of
      // announcing success before the RPC resolves.
      try{
        var p=state.parcels.find(function(x){ return x.awb===awb; }); if(!p) return Promise.reject(new Error("Parcel not found."));
        if(!window.__nvSb){ toast("Cloud connection not ready yet, please try again in a moment."); return Promise.reject(new Error("Cloud connection not ready.")); }
        var __done = nvBusy("Sending\u2026");
        toast(`Sending return request for ${awb}...`);
        /* A return is a REQUEST, not something a merchant performs. The old
           code set the status to "Ready for return" in the browser -- moving
           a parcel through the operational pipeline from the merchant's
           laptop. It opens a ticket now and ops moves the parcel. */
        return nvOpsRequestTicket(awb,
          "Return to origin requested for " + awb,
          "The merchant has asked for this parcel to be returned to origin.",
          "high"
        ).then(function(){
          toast(`${awb}: return requested. Operations will confirm in your ticket.`,"success");
        }).catch(function(e){ toast(`Could not send the return request: ${(e&&e.message)||e}`,"error"); throw e; })
          .finally(function(){ __done(); });
      }catch(e){ return Promise.reject(e); }
    }
    /* AUDIT FIX (shadowed function): this used to be a SECOND
       `function messageCustomer(awb)`. Function declarations hoist, so this
       one silently replaced the richer messageCustomer(awb, kind) defined
       earlier -- and it ignores the `kind` argument entirely. The result:
       the "Message Customer" button next to the message-type dropdown sent
       the generic exception text no matter which message the merchant
       picked, and the phone-number validation in the real version never
       ran. Renamed to what it actually is; the exception cards call this
       one explicitly, everything else keeps the kind-aware version. */
    function messageCustomerException(awb){
      try{
        var p=state.parcels.find(function(x){ return x.awb===awb; }); if(!p){ toast("Parcel not found."); return; }
        var msg=exceptionMessageText(p);
        var digits=String(p.phone||"").replace(/[^0-9]/g,"");
        if(digits){ window.open("https://wa.me/"+digits+"?text="+encodeURIComponent(msg),"_blank"); }
        else { toast("No phone number on file for this consignee."); }
      }catch(e){}
    }
    function renderJourney(){
      // NovaX fix (Medium #5): removed the `|| state.parcels[0]` fallback --
      // show the "No parcel selected" placeholder directly instead of
      // guessing the first parcel in the list.
      const p=state.parcels.find(x=>x.awb===state.selectedAwb)||emptyParcel();
      document.getElementById("selectedParcelText").textContent=`${p.awb} for ${p.consignee}. Current status: ${p.status}.`;
      // NovaX (Client Tracking Timeline Polish): friendly client-facing
      // sentence per status -- never a staff name, only status/branch/city/time.
      const FRIENDLY_STEP_NOTE={
        "New booked":"Your parcel has been booked and is waiting for pickup.",
        "Collected by rider":"Your parcel has been picked up.",
        "Arrived at warehouse":"Your parcel checked in at a NovaX hub.",
        "Parcel now in transit":"Your parcel is in transit to the destination city.",
        "Parcel received at destination":"Your parcel has arrived at the destination city.",
        "Parcel out for delivery":"Your parcel is out for delivery.",
        "Delivered":"Your parcel was delivered.",
        "Refused":"Delivery attempt was refused.",
        "Consignee not available":"The consignee was not available for delivery.",
        "Reattempt":"A redelivery attempt is scheduled.",
        "Ready for return":"Return is being sent back to origin.",
        "Return to shipper":"Your return was completed at origin."
      };
      const important=[
        ["New booked","Booked"],
        ["Collected by rider","Picked up"],
        ["Parcel now in transit","In transit"],
        ["Parcel received at destination","Arrived at destination"],
        ["Parcel out for delivery","Out for delivery"],
        ["Delivered","Delivered"],
        ["Refused","Refused"],
        ["Consignee not available","Consignee not available"],
        ["Reattempt","Reattempt"],
        ["Ready for return","Returned"],
        ["Return to shipper","Returned"]
      ];
      const rows=important
        .filter(([status])=>(p.steps||[]).includes(status)||p.status===status||(["Refused","Consignee not available","Reattempt"].includes(status)&&isRefusalReview(p)))
        .map(([status,label],i)=>{
          const current=p.status===status;
          const problem=current && (p.exception||/Refused|not available/i.test(status));
          const place=p.branch||p.city||"";
          const when=current?(p.updated||""):"verified";
          const whenNote=[place,when].filter(Boolean).join(" | ");
          const friendly=FRIENDLY_STEP_NOTE[status]||label;
          const note=problem?(p.exception||"Needs client review"):`${friendly}${whenNote?(" — "+whenNote):""}`;
          return `<div class="seller-step ${current?"current":""} ${problem?"problem":""}"><div class="step-dot">${i+1}</div><div><strong>${escLabelText(label)}</strong><span>${escLabelText(note)}</span></div><span class="chip ${problem?"bad":current?"info":"good"}">${problem?"review":current?"current":"done"}</span></div>`;
        });
      document.getElementById("clientJourney").innerHTML=`<div class="seller-journey-card">${rows.join("")}${p.resolutionRemark?`<div class="seller-step"><div class="step-dot">OK</div><div><strong>Admin remarks</strong><span>${escLabelText(p.resolutionRemark)}</span></div><span class="chip good">resolved</span></div>`:""}${p.proofPhoto?`<div class="seller-step problem"><div class="step-dot">📷</div><div><strong>Rider remark + proof</strong><span>${escLabelText(p.exception||p.returnProof||"Photo proof attached by rider")}</span></div><span class="chip bad">live</span></div><div style="padding:0 14px 14px"><img src="${escLabelText(p.proofPhoto)}" alt="rider proof" loading="lazy" style="width:100%;max-height:240px;object-fit:cover;border-radius:12px;border:1px solid var(--line)"></div>`:""}</div>`;
      const review=document.getElementById("refusalReview"); if(!review) return;
      if(!hasResolvableException(p)){ review.innerHTML=""; return; }
      review.innerHTML=typeof renderExceptionCard==="function"?renderExceptionCard(p):"";
    }
    // NovaX fix (medium audit #4): renderWallets() targeted a "clientWallet"
    // element that no longer exists -- the Wallet tab's payable/available
    // figures are now rendered by walletSummaryCards (Wallet tab) and
    // paymentSummary (Payments tab), so this dead duplicate was removed
    // rather than left as a silent no-op DOM lookup.
    function renderAwbLabel(){ const p=state.parcels.find(x=>x.awb===(state.lastGeneratedAwb||state.selectedAwb))||selectedParcel(); document.getElementById("awbLabelPreview").innerHTML=awbCompleteBadge(p)+awbLabelHtml(p); }
    function renderClientTabs(){
      document.querySelectorAll(".client-tab").forEach(b=>b.classList.toggle("active",b.dataset.clientTab===state.activeClientTab));
      document.querySelectorAll(".client-module").forEach(m=>m.classList.toggle("active",m.id===`client-${state.activeClientTab}`));
    }
    function cityReport(parcels){ const g={}; parcels.forEach(p=>{ g[p.city]=g[p.city]||{city:p.city,parcels:0,cod:0,revenue:0,delivered:0}; g[p.city].parcels++; g[p.city].cod+=p.cod; if(isDeliveredLedgerParcel(p)){ g[p.city].revenue+=p.fee; g[p.city].delivered++; } }); return Object.values(g); }
    // NovaX fix (client identity leak, findings #1 and #3): a single source
    // of truth for what name/label the portal is allowed to show for the
    // logged-in client. This never falls through to a cached/sample client
    // name -- until identityVerified is true it always shows "Verifying
    // account...", and the terminal error states (not linked / record
    // missing) always win over whatever text happens to be in state.client.
    function clientDisplayState(){
      if(state.accountNotLinked) return { label:"We're preparing your workspace. Refresh or sign in again.", showWorkspaceSuffix:false };
      if(state.clientRecordMissing) return { label:"We're preparing your workspace. Refresh or sign in again.", showWorkspaceSuffix:false };
      if(!state.identityVerified) return { label:"Verifying account...", showWorkspaceSuffix:false };
      return { label:(state.client&&state.client.name)||"Client", showWorkspaceSuffix:true };
    }
    function renderClientModules(){
      renderClientTabs(); renderAwbLabel();
      // NovaX fix (client identity leak): always read the header account name
      // from clientDisplayState(), the same source used by the sidebar/wallet/
      // reports, so it can never show a stale/demo/first-client name.
      const _acc=document.getElementById("topAccountName"); if(_acc) _acc.textContent=clientDisplayState().label;
      const cm=clientMetrics();
      const deliveredCod=cm.parcels.filter(isDeliveredLedgerParcel).reduce((s,p)=>s+p.cod,0);
      /* "Pending COD" used to be every parcel that was not delivered, which
         swept in bookings a rider had not even collected yet and presented
         their face value as money the merchant was owed. Nothing is owed on a
         parcel nobody has picked up -- there is no cash anywhere in the system
         for it. Split into money that is genuinely in flight, and a plain
         COUNT of what is still sitting waiting for a rider.

         The second figure is deliberately a count, not a rupee amount: the
         whole complaint about this screen was rupee amounts that do not
         correspond to any real cash. */
      const inFlight=cm.parcels.filter(p=>!isDeliveredLedgerParcel(p) && nvIsRatedParcel(p));
      const pendingCod=inFlight.reduce((s,p)=>s+p.cod,0);
      const awaitingPickup=cm.parcels.filter(p=>String(p.status||"").trim()==="New booked").length;
      /* Same denominator as the dashboard card -- these two screens used to
         compute the rate independently and would have drifted apart. */
      const rated=cm.ratedTotal;
      const rateKnown=rated>0;
      const rate=rateKnown?percent(cm.delivered,rated):0;
      const open=Math.max(0,cm.total-cm.delivered);
      const fromI=document.getElementById("clientDateFrom"), toI=document.getElementById("clientDateTo");
      if(fromI && fromI.value!==state.clientDateFrom) fromI.value=state.clientDateFrom||"";
      if(toI && toI.value!==state.clientDateTo) toI.value=state.clientDateTo||"";
      /* NovaX fix (fabricated validation figures): this panel rendered a
         hardcoded array -- "2 need review", "97% valid", "0 duplicates" --
         on every load, regardless of whether the merchant had uploaded
         anything at all. Those were invented numbers presented as a real
         validation result for the merchant's own data, which is exactly the
         credibility problem the landing-page ops console was relabelled for.
         The real validator (validateBulkRows) already produces per-row
         problems on upload and renders them elsewhere, so before an upload
         this panel now says what it actually knows: nothing yet. */
      const bvl=document.getElementById("bulkValidationList");
      if(bvl){
        const U=window.NovaXUI;
        bvl.innerHTML=(U&&U.emptyState)
          ? U.emptyState({icon:"\u21E7",title:"NO FILE CHECKED YET",
              body:"Upload a CSV and every row is checked for city, phone, COD, weight and duplicate order IDs before anything is booked.",
              actionLabel:"Go to Bulk Booking",action:"bulkBooking"})
          : `<div class="ops-card"><strong>No file checked yet</strong><p>Upload a CSV to see per-row validation.</p></div>`;
      }
      document.getElementById("clientReportMetrics").innerHTML=[
        metricCard("Delivery Rate",
          rateKnown?`${rate}%`:"\u2014",
          rate,
          rateKnown?`${cm.delivered} of ${rated} picked up`:"nothing picked up yet",
          (rateKnown&&rate<45)?"amber":"","","",!rateKnown),
        metricCard("Delivered COD",money(deliveredCod),percent(deliveredCod,deliveredCod+pendingCod),"cash collected","good"),
        metricCard("Pending COD",money(pendingCod),percent(pendingCod,deliveredCod+pendingCod),"picked up, not delivered yet","amber"),
        metricCard("Awaiting Pickup",awaitingPickup,percent(awaitingPickup,Math.max(1,cm.total)),"no COD due until collected",awaitingPickup?"blue":"good"),
        metricCard("Open Parcels",open,percent(open,Math.max(1,cm.total)),"not delivered yet",open?"blue":"good")
      ].join("");
      /* BUG: with no rows this emitted "", so a brand-new account saw five
         bare column headers over nothing at all -- height 0, no explanation.
         The parcel cards next to it already handle their empty day one; this
         table did not. */
      document.getElementById("clientReportRows").innerHTML=cityReport(cm.parcels).map(r=>`<tr><td><strong>${escLabelText(r.city)}</strong></td><td>${r.parcels}</td><td>${money(r.cod)}</td><td>${money(r.revenue)}</td><td><span class="chip ${r.delivered?"good":"info"}">${r.delivered}/${r.parcels}</span></td></tr>`).join("")
        || '<tr><td colspan="5" class="footer-note" style="padding:14px 8px">No parcels in this date range yet. Book your first parcel and this breaks down by city as they move.</td></tr>';
      // NovaX fix (High #2): never fall back to the demo/default placeholder client id
      // id -- with no confirmed client identity, show zero invoices instead
      // of another client's invoices.
      const myId=state.client&&state.client.id;
      const invoices=myId?state.invoices.filter(i=>i.clientId===myId&&i.status!=="Deleted"):[];
      // If the wallet is currently negative, the next settlement absorbs that
      // shortfall automatically -- wallet_balance + payable is simple addition,
      // so -1,760 + 21,120 lands at 19,360. The merchant should be told that
      // before it happens, otherwise the balance appears to jump and Rs 1,760
      // appears to vanish. Computed once here and shown per pending invoice.
      let __nvShortfall = 0;
      try{ __nvShortfall = nvMoneyFigures().shortfall || 0; }catch(e){}
      /* Removed 25 Aug 2026: wrote into #paymentSummary, #paymentTimeline and
         #clientPaymentHistory. None of those three ids exists anywhere in this
         file -- not in markup, not in a template literal, not assigned via
         element.id. They are leftovers from a payments panel that was replaced.
         Every lookup was guarded with ||{} so nothing ever threw; this was work
         done on every render that no one could see. #clientInvoiceList below IS
         real and is untouched. */
      (document.getElementById("clientInvoiceList")||{}).innerHTML=invoices.map((inv,idx)=>{
        const invType=inv.invoiceType||"COD Settlement";
        const owed=Number(inv.dueToNovax||0);
        const n=(inv.parcelRefs||[]).length;
        // One readable sentence per invoice: what was collected, what we
        // charged, what is left for the merchant. The subtraction is shown
        // rather than left for them to do across separate tiles.
        const sum = owed>0
          ? `${n} prepaid parcel(s) &middot; <strong>${money(inv.charges)}</strong> delivery charges &rarr; <strong>${money(owed)}</strong> to pay NovaX`
          : `${n} parcel(s) &middot; ${money(inv.cod)} collected &minus; ${money(inv.charges)} charges = <strong>${money(inv.payable)}</strong> to you`;
        // Only on an invoice that has not reached the wallet yet, and only
        // while a shortfall actually exists.
        const notYetInWallet = !isInvoiceClosed(inv.status) && inv.status!=="Cancelled" && inv.status!=="Pushed to wallet";
        const clears = (owed<=0 && notYetInWallet && __nvShortfall>0)
          ? Math.min(__nvShortfall, Number(inv.payable||0))
          : 0;
        const absorbLine = clears>0
          ? `<p class="nv-inv-absorb">${money(clears)} of this clears the charges already on your account &mdash; <strong>${money(Math.max(0, Number(inv.payable||0)-clears))}</strong> reaches your wallet.</p>`
          : "";
        return `<div class="invoice-card nv-inv-row" style="animation-delay:${Math.min(idx*70,560)}ms"><div class="ops-card-head"><strong>${escLabelText(inv.id)}</strong><span class="chip ${invoiceTypeChipClass(invType)}">${escLabelText(invType)}</span><span class="footer-note" style="margin-left:auto">${escLabelText(inv.createdAt)}</span></div><p style="margin:6px 0 0">${sum}</p>${absorbLine}${nvInvoiceSteps(inv.status)}<div class="inline-actions" style="margin-top:10px"><button class="ghost-btn" onclick="viewInvoice('${inv.id}')">View</button><button class="ghost-btn" onclick="printInvoice('${inv.id}')">Statement PDF</button><button class="ghost-btn" onclick="downloadInvoiceCsv('${inv.id}')">CSV</button></div></div>`;
      }).join("")||`<div class="ops-card"><strong>No invoices yet</strong><p>Once a delivered parcel is invoiced it appears here with a full statement.</p></div>`;
      // NovaX (Shopify Final Test Visibility): "View imported orders" sets
      // state.orderLogSourceFilter="shopify" so this feed narrows to source=shopify.
      const orderLogFilterBar=document.getElementById("orderLogFilterBar");
      if(orderLogFilterBar) orderLogFilterBar.style.display=state.orderLogSourceFilter?"flex":"none";
      const orderLogParcels=state.orderLogSourceFilter?cm.parcels.filter(p=>(p.source||"")===state.orderLogSourceFilter):cm.parcels;
      document.getElementById("orderLogFeed").innerHTML=orderLogParcels.map(p=>{ const alert=alertForParcel(p); return `<div class="order-log-card clickable-row" onclick="openClientParcelJourney('${escLabelText(p.awb)}')"><div><strong>${escLabelText(p.awb)}</strong><div class="footer-note">${escLabelText(p.consignee)} | ${escLabelText(p.city)}</div></div><div><strong>${escLabelText(p.status)}</strong><div class="footer-note">Last update ${escLabelText(p.updated)} | ${escLabelText(alert.label)}</div>${waActionsHtml(p.awb, waKindForStatus(p.status))}</div></div>`; }).join("")||`<div class="ops-card"><strong>No order logs</strong></div>`;
      // NovaX fix: the four hardcoded role cards that used to live here were
      // not real users. Sub accounts now come from public.staff_users.
      try{ renderSubAccounts(); }catch(e){}
      try{ nvApplyRolePermissions(); }catch(e){}
      try{ renderMoneyHero(); }catch(e){ console.warn("NovaX money hero", e); }
      try{ nvGuardWalletRender(); }catch(e){}
      /* Removed 25 Aug 2026: #supportEscalations does not exist in this file. */
    }
    /* renderAi() removed 25 Aug 2026: its host #clientAi and the composer it
       focused (#clientAiInput) do not exist. The live assistant is the NovaX AI
       console (#nvAiShell) plus the Autopilot panel. */

    /* ===== Added: AWB label, print, modals, bulk preview, report, invoice download, wallet ===== */
    function awbCompleteBadge(p){ return p.awbPrinted ? `<div class="chip good" style="display:inline-flex;align-items:center;gap:6px;margin-bottom:10px;font-weight:700">✅ AWB printed — booking complete${p.awbPrintedAt?" · "+p.awbPrintedAt:""}</div>` : `<div class="chip warn" style="display:inline-flex;align-items:center;gap:6px;margin-bottom:10px;font-weight:700">⏳ AWB not printed yet</div>`; }
    // NovaX fix (CSV injection + quote breaking): every exported CSV cell goes
    // through this helper. Embedded quotes are doubled, the value is always
    // wrapped in quotes so commas/newlines cannot break the column layout, and
    // anything a spreadsheet could evaluate as a formula is prefixed with a
    // single quote so it stays inert text.
    function csvCell(v){
      var s=(v===undefined||v===null)?"":String(v);
      if(/^[=+\-@\t\r]/.test(s)) s="'"+s;
      return '"'+s.replace(/"/g,'""')+'"';
    }
    /* AUDIT FIX (low): the single quote was missing from this map, while
       several call sites interpolate the result into single-quoted inline
       handlers, e.g. onclick="shareTrackingLink('...')". Not exploitable
       today (AWBs and uuids are server-generated), but one schema change
       away from being XSS.
       NOTE: '/' is deliberately NOT escaped -- this same function is used
       on URLs (e.g. <img src="${escLabelText(p.proofPhoto)}">), and
       encoding the slashes would break every proof photo. */
    function escLabelText(v){ return String(v===undefined||v===null?"":v).replace(/[&<>"']/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }
    function labelText(value,fallback){ var v=(value===undefined||value===null)?"":String(value).trim(); var out=v?v:((fallback!==undefined&&fallback!==null&&fallback!=="")?fallback:"-"); return escLabelText(out); }
    function labelDate(p){ var d=p&&(p.date||p.statusSince||p.updated); var out=d?String(d).slice(0,10):new Date().toISOString().slice(0,10); return escLabelText(out); }
    function parcelItemDetails(p){ return labelText(p&&(p.category||p.itemDetails||p.product),"General merchandise"); }
    function parcelPaymentMode(p){ return labelText(p&&(p.paymentMode||p.payment_mode),"COD"); }
    function parcelOrderId(p){ return labelText(p&&(p.orderId||p.order_id||p.orderNo),"-"); }
    function parcelReferenceNo(p){ return labelText(p&&(p.referenceNo||p.reference||p.ref||p.customerRef),"-"); }
    /* NovaX distance pricing: only rendered for parcels actually priced by
       distance. Every older parcel has pricingMode null and prints exactly
       as before -- no layout shift, no blank field. */
    function nvAwbDistanceField(p){
      return "";                     // per-km retired; labels carry no km
    }

    function nvAwbDistanceField__retired(p){
      if(!p || p.pricingMode!=="distance" || p.distanceKm==null) return "";
      return '<div class="awb-field"><span>Distance</span><strong>'+escLabelText(p.distanceKm)+' km</strong></div>';
    }
    /* ═══ Printing is always light ════════════════════════════════════════
       A courier label is INK ON PAPER. The print stylesheet paints the page
       with var(--nvu-bg), and every label/document body uses the same theme
       tokens -- so with the portal defaulting to dark, every print came out
       on a dark ground, burning toner and producing a label a scanner
       struggles with.

       The document is therefore forced to the light theme for the duration of
       the print, then put back exactly as it was. `prev` is captured rather
       than assumed, so a merchant who deliberately chose Light is restored to
       Light and never silently flipped to dark.

       `active` is a separate flag from `prev` on purpose: prev===null is a
       legitimate value (no attribute at all), so it cannot double as "not
       currently forcing". Re-entrancy is guarded because two print paths can
       overlap if a merchant hits print twice quickly -- the second call must
       not capture "light" as the value to restore. */
    var NV_PRINT_THEME={ active:false, prev:null };
    /* ═══ Haptics ═════════════════════════════════════════════════════════
       A courier app is used one-handed, outdoors, often without looking
       closely at the screen. A confirmation the merchant can FEEL is worth
       more than one they have to read.

       Deliberately tiny. Android only -- iOS Safari does not implement
       navigator.vibrate at all, so this is silently inert on iPhone. That is
       stated here so a future reader does not spend an afternoon debugging
       "haptics don't work" on their own phone.

       Honours prefers-reduced-motion: some people set it precisely because
       motion and buzzing make them unwell. */
    function nvHaptic(kind){
      try{
        if(!navigator.vibrate) return;
        if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        if(!kind) return;                       /* neutral toast: no buzz */
        if(kind === "error")   { navigator.vibrate([30,20,30]); return; }
        if(kind === "warning") { navigator.vibrate(20); return; }
        navigator.vibrate(10);
      }catch(e){}
    }

    /* ═══ Rebuilds that do not throw the merchant out of their place ═══════
       138 innerHTML assignments and 29 full render() calls, several driven by
       timers and realtime. Every one replaces a whole section, which resets
       scroll, drops focus, closes an open dropdown and wipes a caret.

       The ticket list already carries hand-rolled draft-and-caret preservation
       for exactly this reason -- merchants' typing was being wiped every 3
       seconds. That fix is a symptom of the pattern, not a cure for it.

       True DOM diffing across 138 call sites is a large, risky refactor.
       nvKeepPlace() is the contained version that removes what the merchant
       actually feels: it snapshots the focused element, its caret and every
       scroll position, runs the rebuild, then puts them back. The element is
       re-found by id, so it survives being replaced rather than merely moved.

       If nothing is focused and nothing is scrolled, it costs one function
       call and does nothing. */
    function nvKeepPlace(fn){
      var active = document.activeElement;
      var id = active && active.id ? active.id : null;
      var selStart = null, selEnd = null;
      if(id){
        try{ selStart = active.selectionStart; selEnd = active.selectionEnd; }catch(e){}
      }
      var pageY = window.scrollY || document.documentElement.scrollTop || 0;
      /* Any inner scroller that is not at the top -- lists, drawers, modals. */
      var scrollers = [];
      try{
        document.querySelectorAll("[id]").forEach(function(el){
          if(el.scrollTop > 0) scrollers.push({ id: el.id, top: el.scrollTop, left: el.scrollLeft });
        });
      }catch(e){}

      try{ fn(); }
      finally{
        try{
          scrollers.forEach(function(rec){
            var el = document.getElementById(rec.id);
            if(el){ el.scrollTop = rec.top; el.scrollLeft = rec.left; }
          });
          if(pageY) window.scrollTo(0, pageY);
          if(id){
            var back = document.getElementById(id);
            /* Only restore if it actually left -- refocusing something that
               never lost focus can dismiss a native picker on Android. */
            if(back && document.activeElement !== back){
              back.focus({ preventScroll: true });
              if(selStart !== null && back.setSelectionRange){
                try{ back.setSelectionRange(selStart, selEnd); }catch(e){}
              }
            }
          }
        }catch(e){}
      }
    }

    /* ═══ Say so when the connection drops ════════════════════════════════
       navigator.onLine was checked zero times in this file and there was no
       offline listener, so a merchant who walked into a lift got silent
       failures and no explanation -- every action just appeared not to work.

       onLine alone lies: it reports true for a captive portal or a dead
       upstream. So a failed fetch also trips the banner, and a successful one
       clears it, which makes it reflect reality rather than the OS's opinion. */
    (function nvConnectionBanner(){
      var el = null, offline = false;

      function ensure(){
        if(el) return el;
        el = document.createElement("div");
        el.id = "nvOfflineBanner";
        el.setAttribute("role","status");
        el.innerHTML = '<span class="nvoff-dot"></span>' +
          '<span>No connection. You can still read what is already loaded \u2014 ' +
          'anything you send will fail until it is back.</span>';
        document.body.appendChild(el);
        return el;
      }
      function show(){ if(offline) return; offline = true; ensure().classList.add("show"); }
      function hide(){ if(!offline) return; offline = false; if(el) el.classList.remove("show"); }

      window.addEventListener("offline", show);
      window.addEventListener("online", function(){
        hide();
        try{ if(typeof window.nvQuietRefresh === "function") window.nvQuietRefresh(); }catch(e){}
      });

      /* A failed fetch is better evidence than navigator.onLine. */
      if(window.fetch){
        var orig = window.fetch;
        window.fetch = function(){
          return orig.apply(this, arguments).then(function(r){ hide(); return r; })
                     .catch(function(e){ if(!navigator.onLine) show(); throw e; });
        };
      }
      if(!navigator.onLine) show();
    })();

    /* ═══ Bottom navigation ════════════════════════════════════════════════
       Same source of truth as the side menu -- nvRoleTabs() -- so the two can
       never disagree about what a role may open. Rendered rather than
       hardcoded for exactly that reason.

       Four slots plus More. The four are the hourly destinations; More opens
       the existing side menu so nothing becomes unreachable. */
    var NV_BOTTOM_TABS = [
      { id:"dashboard",  label:"Home",    ico:"\u2302" },
      { id:"newBooking", label:"Book",    ico:"\u002B" },
      { id:"money",      label:"Money",   ico:"\u20A8" },
      { id:"tickets",    label:"Support", ico:"\u263A" }
    ];

    function nvRenderBottomNav(){
      var host = document.getElementById("nvBottomNav");
      if(!host) return;
      var allowed = NV_BOTTOM_TABS.filter(function(t){
        return (typeof nvCanUseTab !== "function") || nvCanUseTab(t.id);
      });
      var active = state.activeClientTab || "dashboard";
      host.innerHTML = allowed.map(function(t){
        return '<button type="button" data-nvbn="' + t.id + '"' +
               (t.id === active ? ' class="is-active" aria-current="page"' : '') + '>' +
               '<span class="nvbn-ico" aria-hidden="true">' + t.ico + '</span>' +
               '<span>' + t.label + '</span></button>';
      }).join("") +
      '<button type="button" data-nvbn="__more"><span class="nvbn-ico" aria-hidden="true">\u2261</span><span>More</span></button>';
    }

    (function(){
      function boot(){ try{ nvRenderBottomNav(); }catch(e){} }
      if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
      else boot();
      /* role arrives with the profile, after boot -- re-render a few times */
      var n=0, iv=setInterval(function(){ boot(); if(++n>6) clearInterval(iv); }, 700);
    })();

    document.addEventListener("click", function(e){
      var b = e.target && e.target.closest ? e.target.closest("[data-nvbn]") : null;
      if(!b) return;
      var id = b.getAttribute("data-nvbn");
      if(id === "__more"){
        var menu = document.getElementById("clientMenu");
        var tgl  = document.getElementById("clientMenuToggle");
        if(menu){
          var open = menu.classList.toggle("open");
          if(tgl) tgl.setAttribute("aria-expanded", String(open));
        }
        return;
      }
      try{ nvHaptic("success"); }catch(err){}
      if(typeof showClientTab === "function") showClientTab(id);
    });

    /* ═══ Feedback on the control you actually pressed ════════════════════
       Booking, cancel, reattempt, return and address-fix each fired an RPC and
       left the screen unchanged until it came back. On mobile data that is
       several seconds of "did that work?", and the only feedback was a toast
       at the opposite end of the screen from the thumb that pressed it.

       The five are invoked from inline onclick attributes, so the handler
       never receives its own button. Rather than rewrite five sets of markup,
       a capture-phase listener records the button BEFORE the inline handler
       runs -- capture is the detail that makes this work, since the inline
       onclick fires at target.

       nvBusy() returns a release function. Every exit path must call it,
       including the early returns, or the merchant is left with a permanently
       dead button -- which is worse than the silence it replaced. */
    var NV_LAST_BTN = null;
    document.addEventListener("click", function(e){
      try{ NV_LAST_BTN = (e.target && e.target.closest) ? e.target.closest("button") : null; }
      catch(err){ NV_LAST_BTN = null; }
    }, true);

    function nvBusy(label){
      var b = NV_LAST_BTN;
      if(!b || b.disabled) return function(){};
      var prevHTML = b.innerHTML, prevW = b.style.minWidth;
      /* Pin the width first, or the button shrinks to fit "Sending..." and the
         row reflows under the merchant's thumb mid-press. */
      try{ b.style.minWidth = b.getBoundingClientRect().width + "px"; }catch(e){}
      b.disabled = true;
      b.setAttribute("aria-busy","true");
      if(label) b.innerHTML = '<span class="nvbusy-dot"></span>' + label;
      var released = false;
      return function release(){
        if(released) return; released = true;
        b.disabled = false;
        b.removeAttribute("aria-busy");
        b.innerHTML = prevHTML;
        b.style.minWidth = prevW;
      };
    }

    /* ═══ Pull to refresh ═════════════════════════════════════════════════
       The gesture every phone user reaches for first did nothing here, so
       merchants either hunted for a refresh control or reloaded the page --
       which on this portal is a 276 KB download.

       Deliberately conservative: it only engages when the page is genuinely
       at the top, only on a downward drag, and it hands off to the same
       nvQuietRefresh() the focus and visibility handlers already use, so
       there is one refresh path rather than two.

       overscroll-behavior-y is set on the document so iOS rubber-banding does
       not fight the gesture. Needs checking on a real iPhone -- Safari's
       native bounce is not fully reproducible in a desktop browser. */
    (function nvPullToRefresh(){
      var THRESHOLD = 70, MAX = 110;
      var startY = null, pulling = false, bar = null;

      function reduced(){
        try{ return matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){ return false; }
      }
      function ensureBar(){
        if(bar) return bar;
        bar = document.createElement("div");
        bar.id = "nvPullBar";
        bar.setAttribute("aria-hidden","true");
        bar.innerHTML = '<span class="nvpull-dot"></span><span class="nvpull-txt">Pull to refresh</span>';
        document.body.appendChild(bar);
        return bar;
      }
      function setPull(dy, label){
        var b = ensureBar();
        b.style.transform = "translateY(" + Math.min(dy, MAX) + "px)";
        b.style.opacity = Math.min(1, dy / THRESHOLD);
        var t = b.querySelector(".nvpull-txt");
        if(t && label) t.textContent = label;
      }
      function reset(){
        if(!bar) return;
        bar.style.transition = "transform .22s ease, opacity .22s ease";
        bar.style.transform = "translateY(0)";
        bar.style.opacity = "0";
        setTimeout(function(){ if(bar) bar.style.transition = ""; }, 240);
      }

      document.addEventListener("touchstart", function(e){
        if(e.touches.length !== 1) return;
        /* only from a true top-of-page, and never while an overlay is up */
        if((window.scrollY || document.documentElement.scrollTop || 0) > 0) return;
        if(NV_OVERLAY_STACK.length) return;
        startY = e.touches[0].clientY;
        pulling = false;
      }, { passive: true });

      document.addEventListener("touchmove", function(e){
        if(startY === null) return;
        var dy = e.touches[0].clientY - startY;
        if(dy <= 0){ startY = null; return; }
        if((window.scrollY || 0) > 0){ startY = null; return; }
        pulling = true;
        if(!reduced()) setPull(dy * 0.5, dy * 0.5 >= THRESHOLD ? "Release to refresh" : "Pull to refresh");
      }, { passive: true });

      document.addEventListener("touchend", function(e){
        if(startY === null || !pulling){ startY = null; return; }
        var dy = ((e.changedTouches && e.changedTouches[0].clientY) || startY) - startY;
        startY = null; pulling = false;
        if(dy * 0.5 < THRESHOLD){ reset(); return; }
        setPull(THRESHOLD, "Refreshing\u2026");
        try{ nvHaptic("success"); }catch(err){}
        try{
          if(typeof window.nvQuietRefresh === "function") window.nvQuietRefresh();
          else if(typeof loadAll === "function") loadAll();
        }catch(err){}
        setTimeout(reset, 900);
      }, { passive: true });
    })();

    /* ═══ The Android back button closes overlays instead of leaving ══════
       history.pushState appeared zero times in this file, against 12 places
       that open a modal or drawer. So on Android, back from an open AWB modal
       or the parcel drawer left the portal entirely -- and with no offline
       cache that is a full re-download to get back in.

       Rather than patch 12 call sites, one MutationObserver watches for the
       class flip that makes an overlay visible. Anything added later is
       covered for free.

       The tricky part is closing by button or backdrop instead of by back:
       that must unwind the history entry too, or the stack fills with dead
       entries and the merchant taps back several times with nothing moving.
       So a manual close calls history.back(), and NV_POPPING stops that
       round-tripping into a second close. */
    var NV_OVERLAY_STACK = [];
    var NV_POPPING = false;

    function nvOverlayIsOpen(el){
      return el.classList.contains("show") || el.classList.contains("open");
    }

    function nvCloseTopOverlay(){
      var top = NV_OVERLAY_STACK[NV_OVERLAY_STACK.length - 1];
      if(!top) return false;
      try{
        if(top.el.id === "nvDrawer" && window.NovaXUI && window.NovaXUI.closeDrawer){
          window.NovaXUI.closeDrawer();
        } else {
          top.el.classList.remove("show","open");
        }
      }catch(e){}
      return true;
    }

    window.addEventListener("popstate", function(){
      if(!NV_OVERLAY_STACK.length) return;
      NV_POPPING = true;
      nvCloseTopOverlay();
      /* the observer pops the stack when the class actually disappears */
      setTimeout(function(){ NV_POPPING = false; }, 0);
    });

    (function nvWatchOverlays(){
      function track(el){
        if(el.__nvTracked) return;
        el.__nvTracked = true;
        var wasOpen = nvOverlayIsOpen(el);
        new MutationObserver(function(){
          var isOpen = nvOverlayIsOpen(el);
          if(isOpen === wasOpen) return;
          wasOpen = isOpen;
          if(isOpen){
            NV_OVERLAY_STACK.push({ el: el });
            try{ history.pushState({ nvOverlay: el.id || true }, ""); }catch(e){}
          } else {
            var i = NV_OVERLAY_STACK.map(function(o){ return o.el; }).lastIndexOf(el);
            if(i > -1) NV_OVERLAY_STACK.splice(i, 1);
            /* closed by button or backdrop -- unwind the entry we pushed */
            if(!NV_POPPING){ try{ history.back(); }catch(e){} }
          }
        }).observe(el, { attributes:true, attributeFilter:["class"] });
      }

      function scan(){
        document.querySelectorAll(".modal-overlay, #nvDrawer, .nvdr-wrap").forEach(track);
      }
      if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
      else scan();
      /* the drawer is created lazily by the UI module, so re-scan a few times */
      var n = 0, iv = setInterval(function(){ scan(); if(++n > 10) clearInterval(iv); }, 500);

      /* Escape was handled on only 2 of the 12. Now all of them. */
      document.addEventListener("keydown", function(e){
        if(e.key !== "Escape" || !NV_OVERLAY_STACK.length) return;
        nvCloseTopOverlay();
      });
    })();

    /* ═══ The booking form survives an app switch ═════════════════════════
       Merchants copy consignee addresses out of WhatsApp. Switching apps
       mid-booking is the normal flow here, not an edge case -- and on a phone
       with little memory the tab is discarded, so the merchant came back to
       an empty form and retyped everything.

       Saved to localStorage, debounced, and deliberately short-lived: a
       24-hour expiry. A merchant who abandoned a booking on purpose should
       not be handed it back days later.

       No beforeunload prompt: mobile browsers ignore it, and on desktop it is
       an irritation that does not prevent the loss it warns about. */
    var NV_DRAFT_KEY   = "novaxBookingDraft";
    var NV_DRAFT_FIELDS = ["bookingName","bookingPhone","bookingCity","bookingCod",
                           "bookingService","bookingCategory","bookingFragile","bookingWeight",
                           "bookingPaymentMode","bookingOrderId","bookingAllowOpen","bookingAddress"];
    var NV_DRAFT_T = null;

    function nvSaveBookingDraft(){
      try{
        var d = {}, any = false;
        NV_DRAFT_FIELDS.forEach(function(id){
          var el = document.getElementById(id);
          if(!el) return;
          d[id] = el.value;
          /* Selects carry a default from markup; only a text field with real
             content means the merchant actually started something. */
          if(String(el.value||"").trim() && el.tagName !== "SELECT") any = true;
        });
        if(!any){ try{ localStorage.removeItem(NV_DRAFT_KEY); }catch(e){} return; }
        d.__savedAt = Date.now();
        localStorage.setItem(NV_DRAFT_KEY, JSON.stringify(d));
      }catch(e){}
    }

    function nvClearBookingDraft(){
      try{ localStorage.removeItem(NV_DRAFT_KEY); }catch(e){}
      var n = document.getElementById("nvDraftNote");
      if(n && n.remove) n.remove();
    }

    function nvRestoreBookingDraft(){
      try{
        var raw = localStorage.getItem(NV_DRAFT_KEY);
        if(!raw) return;
        var d = JSON.parse(raw);
        if(!d || !d.__savedAt || (Date.now() - d.__savedAt) > 86400000){ nvClearBookingDraft(); return; }
        var restored = 0;
        NV_DRAFT_FIELDS.forEach(function(id){
          var el = document.getElementById(id);
          if(!el || d[id] === undefined) return;
          /* Never overwrite what the merchant has already typed this session.
             The draft is a fallback, not an authority. */
          if(String(el.value||"").trim()) return;
          el.value = d[id];
          if(String(d[id]||"").trim()) restored++;
        });
        if(!restored) return;
        var host = document.getElementById("bookingName");
        host = host && host.closest(".form-grid");
        if(host && !document.getElementById("nvDraftNote")){
          var mins = Math.max(1, Math.round((Date.now() - d.__savedAt)/60000));
          var when = mins < 60 ? (mins + " min ago") : (Math.round(mins/60) + "h ago");
          var note = document.createElement("div");
          note.id = "nvDraftNote";
          note.className = "footer-note";
          note.style.cssText = "grid-column:1/-1;display:flex;align-items:center;gap:10px;flex-wrap:wrap";
          note.innerHTML = '<span>Restored the booking you started ' + when + '.</span>' +
            '<button type="button" class="ghost-btn" style="padding:4px 10px;font-size:12px" ' +
            'onclick="nvDiscardBookingDraft()">Start fresh</button>';
          host.insertBefore(note, host.firstChild);
        }
      }catch(e){}
    }

    function nvDiscardBookingDraft(){
      NV_DRAFT_FIELDS.forEach(function(id){
        var el = document.getElementById(id);
        if(el && el.tagName !== "SELECT") el.value = "";
      });
      nvClearBookingDraft();
      try{ toast("Cleared. Starting fresh."); }catch(e){}
    }
    window.nvDiscardBookingDraft = nvDiscardBookingDraft;

    document.addEventListener("input", function(e){
      if(!e || !e.target || NV_DRAFT_FIELDS.indexOf(e.target.id) === -1) return;
      clearTimeout(NV_DRAFT_T);
      NV_DRAFT_T = setTimeout(nvSaveBookingDraft, 400);
    });
    document.addEventListener("change", function(e){
      if(!e || !e.target || NV_DRAFT_FIELDS.indexOf(e.target.id) === -1) return;
      nvSaveBookingDraft();
    });

    /* ═══ Timers that stop when nobody is looking ══════════════════════════
       There were 17 setInterval calls in this file. Six had no visibility
       guard at all -- a 1s clock repaint, nvP3Tick at 2.5s, a 3s tick,
       checkMoments at 4s, a 5s badge refresh -- and four more hand-rolled
       their own `if(document.hidden) return;` check.

       None of them make network calls, so this was never a data cost. It is
       CPU and repaint: a backgrounded tab on a phone waking up several times
       a second to redraw a clock nobody can see.

       nvInterval() registers centrally and suspends the whole set on
       visibilitychange. On resume it fires each callback ONCE immediately so
       clocks and badges are correct straight away rather than stale until the
       next tick -- which is the bug you get from naive pausing. */
    var NV_TIMERS = [];
    function nvInterval(fn, ms, opts){
      var rec = { fn:fn, ms:ms, id:null, always:!!(opts&&opts.always) };
      /* The suspension below listens for visibilitychange. A tab opened in the
         background -- cmd-click, or a restored session with many tabs -- is
         already hidden and never fires that event, so every timer registered
         here used to start ticking and keep ticking until the tab was first
         focused. Observed directly during the UI audit: document.hidden true
         with 13 timers running. Checking the current state once at
         registration closes that gap; resume() starts them on first focus. */
      if(rec.always || !document.hidden) rec.id = setInterval(fn, ms);
      NV_TIMERS.push(rec);
      return rec.id;
    }
    /* clearInterval() IS NOT ENOUGH FOR AN nvInterval TIMER.
       suspend()/resume() below tear timers down on blur and rebuild them on
       focus with a NEW id. Anything that stopped itself with
       clearInterval(theIdWeWereGiven) therefore only stopped the instance
       alive at that moment: the record stayed in NV_TIMERS, the next focus
       resumed it under a new id, and the callback ran forever.

       That is how the Autopilot intro came back after being closed -- a
       merchant switched apps, came back, and the "open the intro" timer had
       been resurrected. Use this to stop one for good. */
    window.nvClearInterval = function(id){
      if(id == null) return;
      try{ clearInterval(id); }catch(e){}
      for(var i = NV_TIMERS.length - 1; i >= 0; i--){
        if(NV_TIMERS[i].id === id){
          NV_TIMERS[i].id = null;
          NV_TIMERS[i].dead = true;
          NV_TIMERS.splice(i, 1);
        }
      }
    };
    (function nvWireTimerSuspension(){
      function suspend(){
        NV_TIMERS.forEach(function(r){
          if(r.always || r.id === null) return;
          clearInterval(r.id); r.id = null;
        });
      }
      function resume(){
        NV_TIMERS.forEach(function(r){
          if(r.dead) return;                 // stopped on purpose, stays stopped
          if(r.always || r.id !== null) return;
          try{ r.fn(); }catch(e){}          /* catch up immediately */
          r.id = setInterval(r.fn, r.ms);
        });
      }
      document.addEventListener("visibilitychange", function(){
        if(document.hidden) suspend(); else resume();
      });
    })();

    function nvPrintThemeLight(){
      try{
        if(NV_PRINT_THEME.active) return;
        NV_PRINT_THEME.active=true;
        NV_PRINT_THEME.prev=document.documentElement.getAttribute("data-theme");
        document.documentElement.setAttribute("data-theme","light");
      }catch(e){}
    }
    function nvPrintThemeRestore(){
      try{
        if(!NV_PRINT_THEME.active) return;
        NV_PRINT_THEME.active=false;
        var prev=NV_PRINT_THEME.prev; NV_PRINT_THEME.prev=null;
        if(prev===null) document.documentElement.removeAttribute("data-theme");
        else document.documentElement.setAttribute("data-theme",prev);
      }catch(e){}
    }

    function awbLabelHtml(p){
      const client=clientById(p.clientId);
      const origin=labelText(p.pickupCity||p.origin,"Karachi");
      const destination=labelText(p.city);
      const clientLabel=labelText(client&&client.name,"NovaX Client");
      const consignee=labelText(p.consignee);
      const phone=labelText(p.phone,"phone pending");
      const address=labelText(p.address,"Address attached in portal");
      const cod=money(p.cod);
      const paymentMode=parcelPaymentMode(p);
      const service=labelText(p.service,"COD Standard");
      const weight=labelText(p.weight,"0.8 kg");
      const itemDetails=parcelItemDetails(p);
      const handling=p.fragile==="Yes"?"Fragile":"Standard";
      const bookedDate=labelDate(p);
      const orderId=parcelOrderId(p);
      /* Allow to Open — a rider-facing instruction, so it must be unambiguous
         and present on EVERY label, not only when it is Yes. A missing line
         would read as "nobody decided"; an explicit NOT ALLOWED is what stops
         a customer arguing at the door. Defaults to No for any parcel booked
         before this field existed. */
      const allowOpen=(p&&p.allowOpen==="Yes")?"Yes":"No";
      const referenceNo=parcelReferenceNo(p);
      return `<div class="awb-label"><section class="awb-zone awb-left"><div class="awb-zone-title">NovaX Logistics AWB</div><div class="awb-no">${p.awb}</div><div class="awb-route">${escLabelText(origin)} &rarr; ${escLabelText(destination)}</div><div class="awb-mini-grid"><div class="awb-field"><span>Booking Date</span><strong>${bookedDate}</strong></div><div class="awb-field"><span>Service / Payment</span><strong>${service} / ${paymentMode}</strong></div><div class="awb-field"><span>Order ID</span><strong>${escLabelText(orderId)}</strong></div><div class="awb-field"><span>Reference No</span><strong>${escLabelText(referenceNo)}</strong></div>${nvAwbDistanceField(p)}</div></section><section class="awb-zone awb-center"><div class="awb-zone-title">Receiver / Parcel</div><div class="awb-mini-grid"><div class="awb-field"><span>Consignee</span><strong>${escLabelText(consignee)}</strong></div><div class="awb-field"><span>Phone</span><strong>${escLabelText(phone)}</strong></div><div class="awb-field awb-cod"><span>COD</span><strong>${cod}</strong></div><div class="awb-field"><span>Weight</span><strong>${weight}</strong></div><div class="awb-field"><span>Handling</span><strong>${handling}</strong></div><div class="awb-field awb-openflag ${allowOpen==="Yes"?"is-yes":"is-no"}"><span>Allow to Open</span><strong>${allowOpen==="Yes"?"YES &mdash; customer may open":"NO &mdash; do not open"}</strong></div><div class="awb-field"><span>Client / Shipper</span><strong>${clientLabel}</strong></div></div><div class="awb-field awb-address"><span>Address</span><strong>${escLabelText(address)}</strong></div><div class="awb-field awb-item"><span>Item / Product Details</span><strong>${itemDetails}</strong></div></section><section class="awb-zone awb-scan"><img class="qr-img" src="${qrUrl(p.awb)}" alt="QR ${p.awb}"><img class="barcode-img" src="${barcodeUrl(p.awb)}" alt="Barcode ${p.awb}"><span class="chip info">${p.awb}</span></section></div>`;
    }
    /* NovaX: AWB print mode -- "thermal" (real 4x6in courier label, one per
       page, portrait) or "a4" (3-up on a landscape office sheet). Thermal
       is the default because it's what actually matches a real parcel;
       #nvPrintThermal/#nvPrintA4 are the two toggleable <style> tags added
       in <head>. Persisted per-browser so a seller's choice sticks. */
    /* Default is now the A4 sheet (3-up). Most Pakistani sellers print on an
       ordinary office/laser printer, not a thermal one -- and in thermal
       mode an A4 printer wastes an entire sheet on a single 4x6 label
       stranded in the middle of the page. Sellers who do own a thermal
       printer switch once and the choice is remembered. */
    function nvPrintMode(){
      try{ return localStorage.getItem("novaxAwbPrintMode")==="thermal" ? "thermal" : "a4"; }
      catch(e){ return "a4"; }
    }
    function nvSetPrintMode(mode){
      mode = mode==="a4" ? "a4" : "thermal";
      try{ localStorage.setItem("novaxAwbPrintMode", mode); }catch(e){}
      nvApplyPrintMode();
      try{ renderAwbPrintModeToggle(); }catch(e){}
    }
    function nvApplyPrintMode(){
      const mode=nvPrintMode();
      const th=document.getElementById("nvPrintThermal"), a4=document.getElementById("nvPrintA4");
      if(th) th.disabled = mode!=="thermal";
      if(a4) a4.disabled = mode!=="a4";
    }
    function renderAwbPrintModeToggle(){
      const host=document.getElementById("awbPrintModeToggle");
      if(!host) return;
      const mode=nvPrintMode();
      host.innerHTML =
        '<button type="button" class="'+(mode==="a4"?"action-btn":"ghost-btn")+
        '" style="padding:5px 10px;font-size:12px" onclick="nvSetPrintMode(\'a4\')">A4 Sheet &middot; 3 per page</button>'+
        '<button type="button" class="'+(mode==="thermal"?"action-btn":"ghost-btn")+
        '" style="padding:5px 10px;font-size:12px" onclick="nvSetPrintMode(\'thermal\')">Thermal Roll &middot; 4&times;6"</button>'+
        '<span class="footer-note" style="width:100%;margin-top:4px">'+
        (mode==="a4"
          ? "For a normal office / laser printer. Three labels per A4 sheet, cut along the dashed lines."
          : "For a thermal label printer only. On an office printer this wastes a whole sheet per label.")+
        '</span>';
    }
    function printLabels(awbs){
      const stage=document.getElementById("printStage");
      // NovaX fix (Autopilot AWB printing v1): printLabels now always
      // returns a result object so callers (Autopilot's safePrintAwbs in
      // particular) know exactly what happened instead of guessing from a
      // toast. Manual print buttons elsewhere in the portal keep working
      // exactly as before -- they just ignore the return value.
      if(!stage) return { ok:false, count:0, awbs:[], error:"Print area not available." };
      const valid=(awbs||[]).map(a=>state.parcels.find(p=>p.awb===a)).filter(Boolean);
      if(!valid.length){ toast("No AWB available to print."); return { ok:false, count:0, awbs:[], error:"No AWB available to print." }; }
      nvApplyPrintMode();
      const mode=nvPrintMode();
      // NovaX fix (real AWB print sizing v2): thermal mode prints one real
      // 4x6in label per physical page -- batching 3 onto a page only makes
      // sense for the A4 sheet-and-scissors workflow, not a label roll.
      const perPage = mode==="thermal" ? 1 : 3;
      stage.classList.add("bulk-print");
      stage.classList.toggle("mode-thermal", mode==="thermal");
      stage.classList.toggle("mode-a4", mode==="a4");
      let html="";
      for(let i=0;i<valid.length;i+=perPage){
        const page=valid.slice(i,i+perPage);
        html+=`<div class="print-page">`+page.map(p=>`<div class="print-label-wrap">${awbLabelHtml(p)}</div>`).join("")+`</div>`;
      }
      stage.innerHTML=html;
      // NovaX fix (Autopilot AWB printing v1): never call window.print() on
      // an empty/blank stage -- this is what caused the occasional blank
      // print screen when a race condition left printStage without any
      // rendered .print-page in it.
      if(!stage.innerHTML.trim() || !stage.querySelector(".print-page")){
        stage.style.display="none"; stage.innerHTML=""; stage.classList.remove("bulk-print");
        return { ok:false, count:0, awbs:[], error:"Label content did not render." };
      }
      stage.style.display="block";
      const imgs=Array.from(stage.querySelectorAll("img"));
      const waitAll=Promise.all(imgs.map(img=>new Promise(resolve=>{
        if(img.complete){ resolve(); return; }
        const done=()=>{ img.removeEventListener("load",done); img.removeEventListener("error",done); resolve(); };
        img.addEventListener("load",done);
        img.addEventListener("error",done);
      })));
      const timeout=new Promise(resolve=>setTimeout(resolve,2500));
      Promise.race([waitAll,timeout]).then(()=>{
        // NovaX fix (Autopilot AWB printing v1): re-check right before the
        // print dialog opens -- if the stage was cleared/replaced by
        // something else while we were waiting on images, bail out instead
        // of printing a blank page.
        if(!stage.isConnected || !stage.querySelector(".print-page")){
          stage.style.display="none"; stage.classList.remove("bulk-print");
          return;
        }
        nvPrintThemeLight();
        window.print();
        // NovaX fix (Autopilot AWB printing v1): the old fixed 500ms
        // cleanup could fire before the browser's print dialog actually
        // finished reading the stage on slower devices, which is what
        // sometimes produced a blank print. Cleanup now happens on the
        // real window.afterprint event, with this 1500ms timer only as a
        // fallback for browsers that never fire afterprint reliably.
        let cleaned=false;
        function cleanupPrintStage(){
          if(cleaned) return; cleaned=true;
          nvPrintThemeRestore();
          stage.style.display="none"; stage.innerHTML=""; stage.classList.remove("bulk-print");
          if(window.onafterprint===cleanupPrintStage) window.onafterprint=null;
        }
        window.onafterprint=cleanupPrintStage;
        setTimeout(cleanupPrintStage,1500);
        valid.forEach(p=>{ p.awbPrinted=true; p.awbPrintedAt=time(); });
        saveState();
        try{ if(document.getElementById("awbLabelPreview")) renderAwbLabel(); }catch(e){}
        try{ if(valid.length===1 && document.getElementById("awbModal").classList.contains("show")) document.getElementById("awbModalBody").innerHTML=awbCompleteBadge(valid[0])+awbLabelHtml(valid[0]); }catch(e){}
        try{ renderNewBookedList(); }catch(e){}
      });
      return { ok:true, count:valid.length, awbs:valid.map(p=>p.awb), error:null };
    }
    function printAwb(){ printLabels([state.lastGeneratedAwb||state.selectedAwb]); }
    function openAwbModal(awb){ const p=state.parcels.find(x=>x.awb===awb)||selectedParcel(); state.lastGeneratedAwb=p.awb; saveState(); document.getElementById("awbModalBody").innerHTML=awbCompleteBadge(p)+awbLabelHtml(p); nvApplyPrintMode(); try{ renderAwbPrintModeToggle(); }catch(e){} try{ renderAwbShareActions(p); }catch(e){} document.getElementById("awbModal").classList.add("show"); }
    /* NovaX new (Smart Portal A): share the customer tracking link straight
       from the AWB modal, right where the merchant already is after booking. */
    function renderAwbShareActions(p){
      var host=document.getElementById("awbShareActions");
      if(!host) return;
      if(!p||!p.trackingToken){ host.innerHTML=""; return; }
      var a=escLabelText(p.awb||"");
      host.innerHTML='<button type="button" class="ghost-btn" style="padding:6px 11px;font-size:12px" onclick="shareTrackingLink(\''+a+'\')">Copy tracking link</button>'+
                     '<button type="button" class="ghost-btn" style="padding:6px 11px;font-size:12px" onclick="whatsappTrackingLink(\''+a+'\')">Send to customer on WhatsApp</button>';
    }
    function closeAwbModal(){ document.getElementById("awbModal").classList.remove("show"); }

    function renderBulkPreview(){
      const panel=document.getElementById("bulkPreviewPanel"), list=document.getElementById("bulkPreviewList");
      if(!panel||!list) return;
      const awbs=(state.lastBulkAwbs||[]).filter(a=>state.parcels.some(p=>p.awb===a));
      if(!awbs.length){ panel.style.display="none"; return; }
      panel.style.display="block";
      const nvCompact=window.innerWidth<=760;
      list.innerHTML=awbs.map(a=>{
        const p=state.parcels.find(x=>x.awb===a);
        if(nvCompact){
          return `<div class="nv-awb-compact-card"><div class="nv-awb-compact-top"><strong>${escLabelText(a)}</strong><span class="chip">${escLabelText(p.city||"")}</span></div><div class="nv-awb-compact-mid">${escLabelText(p.consignee||"")}${p.cod?(" \u00b7 COD "+money(p.cod)):""}</div><button class="action-btn" style="width:100%" onclick="printLabels(['${escLabelText(a)}'])">Print ${escLabelText(a)}</button></div>`;
        }
        return `<div style="margin-bottom:14px">${awbLabelHtml(p)}<div class="inline-actions" style="margin-top:8px"><button class="ghost-btn" onclick="printLabels(['${escLabelText(a)}'])">Print ${escLabelText(a)}</button></div></div>`;
      }).join("");
    }
    window.addEventListener("resize",function(){ try{ var nvPp=document.getElementById("bulkPreviewPanel"); if(nvPp && nvPp.style.display!=="none") renderBulkPreview(); }catch(e){} });

    function renderClientReportFull(){
      const tbody=document.getElementById("clientReportFullRows"); if(!tbody) return;
      const sel=document.getElementById("repStatus");
      if(sel && !sel.dataset.filled){ sel.innerHTML=`<option value="">All statuses</option>`+STATUS_TAGS.map(s=>`<option value="${s}">${s}</option>`).join(""); sel.dataset.filled="1"; }
      const search=(document.getElementById("repSearch")?.value||"").toLowerCase();
      const status=document.getElementById("repStatus")?.value||"";
      const from=document.getElementById("repFrom")?.value||"";
      const to=document.getElementById("repTo")?.value||"";
      const rows=state.parcels.filter(p=>p.clientId===state.client.id).filter(p=>{ const d=p.date||""; return (!from||d>=from)&&(!to||d<=to)&&(!status||p.status===status)&&`${p.awb} ${p.consignee} ${p.city} ${p.status}`.toLowerCase().includes(search); });
      tbody.innerHTML=rows.map(p=>`<tr class="clickable-row" onclick="openClientParcelJourney('${escLabelText(p.awb)}')"><td><strong>${escLabelText(p.awb)}</strong> ${nvPaidPill(p)}</td><td>${escLabelText(p.date||"-")}</td><td>${escLabelText(p.consignee)}<br><span class="footer-note">${escLabelText(p.city)}</span></td><td><span class="status ${statusClass(p)}">${escLabelText(p.status)}</span></td><td>${money(p.cod)}</td><td>${money(p.fee)}</td><td>${agingLabel(agingHours(p))}</td></tr>`).join("")||`<tr><td colspan="7">No parcels match these filters.</td></tr>`;
    }

    /* renderLatestInvoice() removed 25 Aug 2026: #clientLatestInvoice does not
       exist. The live invoice list is #clientInvoiceList in renderClientModules. */

    // NovaX new (Negative/Delivery-Charges Invoices): per-line breakdown
    // shared by CSV export, View Invoice modal, and the print/PDF template.
    /* =====================================================================
       NovaX new (invoice outcome column)

       WHY: merchants could not tell which parcels on an invoice were actually
       DELIVERED and which came back. A "Mixed" invoice legitimately contains
       both -- delivered parcels the merchant is owed COD for, and returned
       parcels they still owe the delivery charge on -- and nothing on the
       line told them apart.

       Worse, the COD column showed the parcel's FULL cod_amount regardless of
       outcome. On a returned parcel no cash was ever collected, so the line
       claimed money that does not exist and the lines stopped summing to the
       server-calculated header totals. That mismatch is most of the
       confusion.

       nvInvoiceOutcome() is the single place that decides "was cash actually
       collected on this parcel", reusing isDeliveredLedgerParcel() -- the
       predicate the rest of the portal already uses -- so this can never
       drift from the wallet/ledger view.

       The header totals are NOT touched. They come from the server
       (cod_total / fee_total / net_payable) and stay authoritative; if the
       lines still disagree, the invoice now says so out loud rather than
       quietly showing a different number. */
    function nvInvoiceOutcome(p){
      const st = nvStatus(p && p.status) || "";
      if (isDeliveredLedgerParcel(p)) return { key:"delivered", label:"Delivered",  collected:true,  tone:"good" };
      if (st === "Return to shipper")  return { key:"returned",  label:"Returned",   collected:false, tone:"bad"  };
      if (st === "Refused")            return { key:"refused",   label:"Refused",    collected:false, tone:"bad"  };
      if (st === "Cancelled by client")return { key:"cancelled", label:"Cancelled",  collected:false, tone:"bad"  };
      if (/^Return /.test(st))         return { key:"returning", label:"In return",  collected:false, tone:"warn" };
      return { key:"open", label:st || "In progress", collected:false, tone:"warn" };
    }
    function clientInvoiceLineItems(inv){
      return (inv.parcelRefs||[]).map(awb=>{
        const p=state.parcels.find(x=>x.awb===awb);
        if(!p) return { awb, bookingDate:"-", destinationCity:"-", consignee:"-", paymentMode:"-", codAmount:0, deliveryCharge:0, netLineAmount:0, outcome:"Not on this account", outcomeKey:"unknown", outcomeTone:"warn", collected:false, prepaid:false };
        const nonCod=isNonCodParcel(p);
        const oc=nvInvoiceOutcome(p);
        // COD counts only when the parcel actually delivered AND is not prepaid.
        const codAmount=(nonCod||!oc.collected)?0:Number(p.cod||0);
        const deliveryCharge=Number(p.fee||0);
        const netLineAmount=codAmount-deliveryCharge;
        return { awb:p.awb, bookingDate:labelDate(p), destinationCity:labelText(p.city), consignee:labelText(p.consignee), paymentMode:parcelPaymentMode(p), codAmount, deliveryCharge, netLineAmount,
                 outcome:oc.label, outcomeKey:oc.key, outcomeTone:oc.tone, collected:oc.collected, prepaid:nonCod,
                 distanceKm:(p.pricingMode==="distance" ? p.distanceKm : null) };
      });
    }
    /* =====================================================================
       NovaX new -- WALLET RECEIPTS & STATEMENTS

       A merchant can now download proof of every payout and a full wallet
       statement, to show an accountant or a supplier.

       Everything here is built from data ALREADY loaded into state by
       loadAll() (withdrawals + wallet ledger + server wallet summary). No
       new RPC, no new query, nothing written back — these are read-only
       documents, so they cannot affect a balance.

       PRINTING: documents use their own #docPrintStage and nvPrintDoc()
       temporarily disables the two AWB label style tags, because those
       carry @page{size:100mm 150mm} / A4-3-up rules that would otherwise
       shrink a receipt onto a thermal label. The previous print mode is
       always restored afterwards.
       ===================================================================== */
    var NV_DOC={ csv:null, name:"" };

    function nvPrintDoc(html){
      var stage=document.getElementById("docPrintStage");
      if(!stage){ toast("Print area not ready."); return; }
      var th=document.getElementById("nvPrintThermal"), a4=document.getElementById("nvPrintA4");
      var prevTh=th?th.disabled:null, prevA4=a4?a4.disabled:null;
      if(th) th.disabled=true;
      if(a4) a4.disabled=true;
      stage.innerHTML=html;
      stage.style.display="block";
      function restore(){
        nvPrintThemeRestore();
        stage.style.display="none"; stage.innerHTML="";
        if(th&&prevTh!==null) th.disabled=prevTh;
        if(a4&&prevA4!==null) a4.disabled=prevA4;
        window.removeEventListener("afterprint",restore);
      }
      window.addEventListener("afterprint",restore);
      setTimeout(function(){ nvPrintThemeLight(); try{ window.print(); }catch(e){ restore(); } },60);
      /* Safety net: some browsers never fire afterprint. */
      setTimeout(restore,8000);
    }

    function nvDocHead(title,sub,metaLines){
      var c=(state.client&&state.client.name)||"Merchant";
      return '<div class="nv-doc"><div class="nv-doc-head">'+
        '<div class="nv-doc-brand">NovaX Logistics<small>KARACHI · PAKISTAN</small></div>'+
        '<div class="nv-doc-meta">'+(metaLines||[]).map(function(l){ return escLabelText(l); }).join("<br>")+'</div>'+
        '</div><h2>'+escLabelText(title)+'</h2>'+
        '<div class="nv-doc-sub">'+escLabelText(sub||"")+' &middot; Account: <strong>'+escLabelText(c)+'</strong></div>';
    }
    function nvDocFoot(note){
      return '<div class="nv-doc-foot">'+escLabelText(note||"")+
        '<br>This document was generated from the NovaX wallet ledger and reflects the account state at the time of download.'+
        '<br>novaxlogistics.com</div></div>';
    }
    function nvCsvCell(v){ return '"'+String(v==null?"":v).replace(/"/g,'""')+'"'; }
    function nvDownloadCsv(rows,name){
      try{
        var csv=rows.map(function(r){ return r.map(nvCsvCell).join(","); }).join("\n");
        var a=document.createElement("a");
        a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
        a.download=name; a.click();
        setTimeout(function(){ URL.revokeObjectURL(a.href); },2000);
        toast(name+" downloaded.","success");
      }catch(e){ toast("Could not download: "+((e&&e.message)||e),"error"); }
    }
    function nvOpenDoc(title,html,csvRows,csvName){
      var m=document.getElementById("nvDocModal");
      if(!m) return;
      document.getElementById("nvDocTitle").textContent=title;
      document.getElementById("nvDocBody").innerHTML=html;
      NV_DOC.csv=csvRows||null; NV_DOC.name=csvName||"novax.csv";
      var pb=document.getElementById("nvDocPrintBtn");
      if(pb) pb.onclick=function(){ nvPrintDoc(html); };
      var cb=document.getElementById("nvDocCsvBtn");
      if(cb){
        cb.style.display=csvRows?"":"none";
        cb.onclick=function(){ if(NV_DOC.csv) nvDownloadCsv(NV_DOC.csv,NV_DOC.name); };
      }
      m.classList.add("show");
    }
    function nvCloseDoc(){ var m=document.getElementById("nvDocModal"); if(m) m.classList.remove("show"); }

    /* ---- payout receipt for one withdrawal ---- */
    function nvWithdrawalReceipt(wdId){
      var w=(state.walletWithdrawals||[]).find(function(x){ return String(x.id)===String(wdId) || String(x._uuid)===String(wdId); });
      if(!w){ toast("Withdrawal not found. Refresh and try again.","error"); return; }
      var paid=w.status==="Paid";
      var meta=["Receipt no: "+(w.id||""),"Issued: "+new Date().toLocaleDateString(),"Status: "+(paid?"Paid":"Being verified by finance")];
      var html=nvDocHead("Payout Receipt","Wallet withdrawal",meta)+
        '<div class="nv-doc-grid">'+
          '<div class="nv-doc-box big"><span>Amount received</span><strong>'+escLabelText(money(w.net))+'</strong></div>'+
          '<div class="nv-doc-box"><span>Paid to</span><strong>'+escLabelText(maskIban(w.iban))+'</strong></div>'+
          '<div class="nv-doc-box"><span>Requested on</span><strong>'+escLabelText(w.createdAt||"-")+'</strong></div>'+
          '<div class="nv-doc-box"><span>Paid on</span><strong>'+escLabelText(w.paidAt?nvNiceDate(w.paidAt):(paid?"-":"pending"))+'</strong></div>'+
        '</div>'+
        '<table><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead><tbody>'+
          '<tr><td>Withdrawal requested</td><td class="num">'+escLabelText(money(w.amount))+'</td></tr>'+
          '<tr><td>NovaX payout fee ('+escLabelText(walletSpeedLabel(w.speed))+')</td><td class="num">-'+escLabelText(money(w.fee))+'</td></tr>'+
        '</tbody></table>'+
        '<div class="nv-doc-total"><span>Net transferred</span><span>'+escLabelText(money(w.net))+'</span></div>'+
        (w.paidTxnId?'<p style="font-size:11px;margin-top:10px">Bank reference: <strong>'+escLabelText(w.paidTxnId)+'</strong></p>':'')+
        nvDocFoot(paid?"Payment completed.":"This payout is still being verified by NovaX finance. The bank reference appears here once paid.");
      var csv=[["receipt_no","status","requested_on","paid_on","iban_masked","speed","amount","fee","net","bank_reference"],
               [w.id,w.status,w.createdAt,w.paidAt||"",maskIban(w.iban),walletSpeedLabel(w.speed),w.amount,w.fee,w.net,w.paidTxnId||""]];
      nvOpenDoc("Payout receipt "+(w.id||""),html,csv,"NovaX-receipt-"+String(w.id||"payout").replace(/[^A-Za-z0-9_-]/g,"")+".csv");
    }

    /* ---- full wallet statement ---- */
    function nvWalletStatement(){
      var led=(state.walletLedger||[]).filter(function(l){ return l.clientId===(state.client&&state.client.id); });
      if(!led.length){ toast("No wallet activity to put on a statement yet."); return; }
      var labels={ invoice_credit:"COD settlement credited", withdrawal_requested:"Withdrawal requested",
                   payout_fee:"Payout fee", payout_paid:"Payout paid", payout_rejected:"Payout rejected/refunded",
                   admin_adjustment:"Adjustment by NovaX", delivery_charge_due:"Delivery charge" };
      var rows=led.slice(0,300);
      var credits=rows.reduce(function(n,l){ return n+(Number(l.amount)>0?Number(l.amount):0); },0);
      var debits =rows.reduce(function(n,l){ return n+(Number(l.amount)<0?Math.abs(Number(l.amount)):0); },0);
      var bal=Number((state.serverWalletSummary&&state.serverWalletSummary.available_balance)!=null
                ? state.serverWalletSummary.available_balance
                : ((state.client&&state.client.walletBalance)||0));
      var meta=["Statement date: "+new Date().toLocaleDateString(),"Entries shown: "+rows.length];
      var html=nvDocHead("Wallet Statement","All wallet activity",meta)+
        '<div class="nv-doc-grid">'+
          '<div class="nv-doc-box big"><span>Closing balance</span><strong>'+escLabelText(money(bal))+'</strong></div>'+
          '<div class="nv-doc-box"><span>Total credited</span><strong>'+escLabelText(money(credits))+'</strong></div>'+
          '<div class="nv-doc-box"><span>Total debited</span><strong>'+escLabelText(money(debits))+'</strong></div>'+
          '<div class="nv-doc-box"><span>Entries</span><strong>'+rows.length+'</strong></div>'+
        '</div>'+
        '<table><thead><tr><th>Date</th><th>Description</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>'+
        rows.map(function(l){
          return '<tr><td>'+escLabelText(l.createdAt||"")+'</td>'+
                 '<td>'+escLabelText(labels[l.entryType]||l.entryType||"")+'</td>'+
                 '<td>'+escLabelText(l.referenceCode||l.note||"")+'</td>'+
                 '<td class="num">'+escLabelText(money(l.amount))+'</td></tr>';
        }).join("")+
        '</tbody></table>'+
        '<div class="nv-doc-total"><span>Closing balance</span><span>'+escLabelText(money(bal))+'</span></div>'+
        nvDocFoot("Every line above corresponds to a real parcel settlement, payout or adjustment on your account.");
      var csv=[["date","type","description","reference","amount"]].concat(rows.map(function(l){
        return [l.createdAt||"",l.entryType||"",labels[l.entryType]||l.entryType||"",l.referenceCode||l.note||"",l.amount];
      }));
      nvOpenDoc("Wallet statement",html,csv,"NovaX-wallet-statement.csv");
    }

    function downloadInvoiceCsv(id){
      const inv=state.invoices.find(i=>i.id===id); if(!inv) return;
      const c=clientById(inv.clientId);
      const lines=clientInvoiceLineItems(inv);
      // parcel_outcome / cod_collected added so a merchant reconciling in
      // Excel can filter delivered vs returned without opening the portal.
      const header=["invoice_id","invoice_type","client_name","status","awb","booking_date","destination_city","consignee","parcel_outcome","cod_collected","payment_mode","cod_amount","delivery_charge","net_line_amount","invoice_cod_total","invoice_delivery_charges","payable_to_client","due_to_novax","final_balance"];
      const rows=lines.map(line=>[inv.id,inv.invoiceType||"COD Settlement",c.name,inv.status,line.awb,line.bookingDate,line.destinationCity,line.consignee,line.outcome,line.collected?"yes":"no",line.paymentMode,line.codAmount,line.deliveryCharge,line.netLineAmount,inv.cod,inv.charges,inv.payable,inv.dueToNovax||0,inv.finalBalance||0]);
      const csv=[header,...rows].map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n");
      const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download=`${inv.id}.csv`; a.click(); toast(`${inv.id} CSV downloaded.`);
    }
    // NovaX fix: replaced the old plain unbranded table (which just looked
    // like "random numbers" to a client) with a professional branded NovaX
    // invoice -- tracking number(s) with origin/delivered city per parcel,
    // how long after delivery the payment was processed, the delivery
    // charge deduction, an explicit tax/surcharge breakdown (GST, COD tax
    // 1%, fuel surcharge -- all shown even when they are Rs 0), and a clear
    // grand total.
    // NovaX fix (dashboard/invoices/wallet desync): checked only "Paid", so a
    // Settled or Paid-to-NovaX invoice printed/downloaded by the client still
    // said "Pending - not yet pushed to wallet" on the invoice document itself.
    function invoiceSettlementNote(inv){
      if(inv.status==="Pushed to wallet") return "Credited to wallet - ready for you to withdraw";
      if(isInvoiceClosed(inv.status)) return "Paid in full - settled, nothing owed";
      return "Pending - not yet pushed to wallet";
    }
    // NovaX new (Negative/Delivery-Charges Invoices): the branded template is
    // now type-aware -- COD Settlement, Delivery Charges, or Mixed -- and is
    // shared between the print/PDF flow and the in-app View Invoice modal.

    /* ═══════════════ MONEY TAB ═══════════════════════════════════════════
       One surface for every rupee. The three hero figures partition the whole
       balance: being counted -> ready to withdraw -> paid to you. Everything
       here is display only; the amounts come from the same server-computed
       fields the old Payments and Wallet tabs read, and no arithmetic that
       decides money happens in this browser. */

    /* Merchant-facing wording. The stored status strings are money-critical
       and shared with admin.html and the RPCs (isInvoiceClosed,
       admin_push_invoice_to_wallet), so they are never rewritten -- only
       relabelled at the display boundary. */
    function nvMoneyLabel(status){
      var m = {
        "Generated":"Being counted",
        "Pushed to wallet":"Ready to withdraw",
        "Settled":"Paid to you",
        "Paid":"Paid to you",
        "Paid to NovaX":"You've paid this",
        "Cancelled":"Cancelled"
      };
      return m[status] || status || "Being counted";
    }
    function nvMoneyStage(status){
      if(status === "Cancelled") return 0;
      if(isInvoiceClosed(status)) return 3;
      if(status === "Pushed to wallet") return 2;
      return 1;
    }

    /* Animation 1 -- odometer. Fires only when the figure actually moved, so a
       routine re-render never replays it. */
    var NV_MH_LAST = {};
    function nvCountTo(el, to, key){
      if(!el) return;
      var from = Number(NV_MH_LAST[key]);
      if(!isFinite(from)) from = 0;
      NV_MH_LAST[key] = to;
      var reduce = false;
      try{ reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){}
      if(reduce || from === to){ el.textContent = money(to); return; }
      var t0 = performance.now(), dur = 850;
      (function step(now){
        var k = Math.min(1, (now - t0) / dur);
        var e = 1 - Math.pow(1 - k, 3);
        el.textContent = money(Math.round(from + (to - from) * e));
        if(k < 1) requestAnimationFrame(step);
      })(t0);
    }

    function nvMoneyFigures(){
      var myId = state.client && state.client.id;
      var invoices = myId ? (state.invoices||[]).filter(function(i){
        return i.clientId === myId && i.status !== "Deleted";
      }) : [];
      var c = myId ? clientById(myId) : null;
      var counting = invoices.filter(function(i){
        return !isInvoiceClosed(i.status) && i.status !== "Cancelled" && i.status !== "Pushed to wallet";
      }).reduce(function(s,i){ return s + Number(i.payable||0); }, 0);
      // A wallet can legitimately go negative when delivery charges on prepaid
      // parcels exceed COD collected. "Ready to withdraw -Rs 1,760 / yours
      // right now" is nonsense and looks broken to a merchant, so a negative
      // balance is reported as nothing withdrawable, and the shortfall is
      // surfaced through the charges-to-pay block instead where it belongs.
      var rawBalance = Number((c && c.walletBalance) || 0);
      var ready = Math.max(0, rawBalance);
      var shortfall = rawBalance < 0 ? Math.abs(rawBalance) : 0;
      /* "Paid to you -- lifetime, into your bank" counted CLOSED INVOICES,
         and NV_INVOICE_CLOSED_STATUSES includes "Pushed to wallet". So the
         moment an invoice was pushed, this tile told the merchant the money
         had reached their bank -- while it was still sitting in their wallet,
         unwithdrawn, being counted a second time by `ready` two tiles to the
         left. The comment above these three tiles says they "partition every
         rupee"; they did not, they double-counted the same money.

         Money reaches a bank when a withdrawal is PAID, and nothing else.
         client_wallet_summary().lifetime_withdrawn is the server's own answer
         and was already being fetched for the Wallet screen -- this tile just
         never read it. The local fallback mirrors renderClientWallet()
         exactly, so the two screens cannot disagree.

         With this, the three tiles genuinely do partition: invoiced but not
         pushed -> counting; in the wallet -> ready; withdrawn -> paid. */
      var paid = 0;
      try{
        var sv = state.serverWalletSummary;
        paid = sv
          ? Number(sv.lifetime_withdrawn || 0)
          : (state.walletWithdrawals || [])
              .filter(function(w){ return w.clientId === myId && w.status === "Paid"; })
              .reduce(function(s,w){ return s + Number(w.net || 0); }, 0);
      }catch(e){ paid = 0; }
      var owed  = invoices.filter(function(i){ return i.status !== "Paid to NovaX" && i.status !== "Cancelled"; })
                          .reduce(function(s,i){ return s + Number(i.dueToNovax||0); }, 0);
      return { invoices:invoices, counting:counting, ready:ready, paid:paid,
               owed:owed, shortfall:shortfall, rawBalance:rawBalance };
    }

    /* Hero Withdraw scrolls to the payout form rather than opening another
       screen -- everything now lives on one surface. */
    (function nvWireHeroWithdraw(){
      function bind(){
        var b=document.getElementById("nvMhWithdrawBtn");
        if(!b||b._nvWired) return;
        b._nvWired=true;
        b.addEventListener("click",function(){
          var f=document.getElementById("withdrawAmount");
          if(!f){ try{ toast("Withdrawals are Owner-only on this account."); }catch(e){} return; }
          try{
            var fig=nvMoneyFigures();
            if(!f.value) f.value=String(Math.round(fig.ready));
          }catch(e){}
          f.scrollIntoView({behavior:"smooth",block:"center"});
          setTimeout(function(){ try{ f.focus(); }catch(e){} },320);
        });
      }
      if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",bind);
      else bind();
    })();

    function renderMoneyHero(){
      var hero = document.getElementById("nvMoneyHero");
      if(!hero) return;
      var f = nvMoneyFigures();

      nvCountTo(document.getElementById("nvMhCounting"), f.counting, "counting");
      nvCountTo(document.getElementById("nvMhReady"),    f.ready,    "ready");
      nvCountTo(document.getElementById("nvMhPaid"),     f.paid,     "paid");

      // Animations 2 and 4: the live state only exists while money is actually
      // withdrawable. No money, no glow, no shimmer.
      var live = f.ready > 0;
      var cell = hero.querySelector(".nv-mh-cell.is-ready");
      if(cell) cell.classList.toggle("nv-live", live);
      var btn = document.getElementById("nvMhWithdrawBtn");
      if(btn){
        btn.disabled = !live;
        btn.classList.toggle("nv-live", live);
        btn.textContent = live ? ("Withdraw " + money(f.ready)) : "Nothing to withdraw yet";
      }
      var note = document.getElementById("nvMhNote");
      if(note){
        note.textContent = live
          ? "Paid to your IBAN, usually within 15 minutes."
          : (f.shortfall > 0
              ? "Your wallet is " + money(f.shortfall) + " short. New COD clears that first, then the rest is yours to withdraw."
              : (f.counting > 0
                  ? money(f.counting) + " is still being counted — it moves here once released."
                  : "Delivered parcels turn into invoices, then into withdrawable balance."));
      }

      // Money owed to NovaX: separate block, never mixed with money owed to them.
      var owedPanel = document.getElementById("nvOwedPanel");
      if(owedPanel){
        var owedTotal = f.owed + f.shortfall;
        owedPanel.style.display = owedTotal > 0 ? "" : "none";
        var amt = document.getElementById("nvOwedAmount");
        if(amt) amt.textContent = money(owedTotal);
        var list = document.getElementById("nvOwedList");
        if(list){
          list.innerHTML = f.invoices.filter(function(i){
            return Number(i.dueToNovax||0) > 0 && i.status !== "Paid to NovaX" && i.status !== "Cancelled";
          }).map(function(i){
            return '<div class="log-item"><strong>' + escLabelText(i.id) + '</strong>' +
                   '<div><strong>' + money(i.dueToNovax) + '</strong>' +
                   '<div class="footer-note" style="margin-top:2px">' + escLabelText(i.createdAt) +
                   ' &middot; ' + ((i.parcelRefs||[]).length) + ' parcel(s)</div></div>' +
                   '<button class="ghost-btn" onclick="printInvoice(&quot;' + i.id + '&quot;)">Statement PDF</button></div>';
          }).join("");
        }
      }
    }


    /* ═══ Withdrawal receipt drawer ═══════════════════════════════════════
       Opens only from the success branch of request_wallet_withdrawal, so it
       can only ever describe a withdrawal the server actually created. The
       figures come from the RPC response (d.fee / d.net) when present -- the
       browser's own fee calculation is a preview, never the record. */
    function nvShowWithdrawDrawer(o){
      try{
        var ov = document.getElementById("nvWdOverlay");
        if(!ov) return;
        var set = function(id, v){ var e=document.getElementById(id); if(e) e.textContent=v; };
        set("nvWdAmount", money(o.net));
        set("nvWdGross",  money(o.gross));
        set("nvWdFee",    o.fee > 0 ? "\u2212 " + money(o.fee) + " (" + o.pct + ")" : "None");
        set("nvWdNet",    money(o.net));
        set("nvWdSpeed",  o.speedLabel);
        set("nvWdIban",   o.iban);
        var sub = document.getElementById("nvWdSub");
        if(sub) sub.textContent = "NovaX is sending this to your bank \u2014 " + o.eta + ".";

        ov.classList.add("open");
        requestAnimationFrame(function(){ requestAnimationFrame(function(){ ov.classList.add("in"); }); });
        try{ document.body.style.overflow="hidden"; }catch(e){}
      }catch(e){ console.warn("NovaX withdraw drawer", e); }
    }
    function nvCloseWithdrawDrawer(){
      var ov = document.getElementById("nvWdOverlay");
      if(!ov) return;
      ov.classList.remove("in"); ov.classList.add("out");
      setTimeout(function(){
        ov.classList.remove("open","out");
        try{ document.body.style.overflow=""; }catch(e){}
      }, 360);
    }
    (function nvWireWdDrawer(){
      function bind(){
        var b=document.getElementById("nvWdClose"), ov=document.getElementById("nvWdOverlay");
        if(b && !b._nvWired){ b._nvWired=true; b.addEventListener("click", nvCloseWithdrawDrawer); }
        // A receipt may be dismissed: backdrop click and Escape both close it.
        if(ov && !ov._nvWired){
          ov._nvWired=true;
          ov.addEventListener("click", function(ev){ if(ev.target===ov) nvCloseWithdrawDrawer(); });
          document.addEventListener("keydown", function(ev){
            if(ev.key==="Escape" && ov.classList.contains("open")) nvCloseWithdrawDrawer();
          });
        }
      }
      if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",bind);
      else bind();
    })();

    /* Animations 5 and 6 -- the hand-off. The amount lifts out of the Ready
       figure and a ripple crosses the panel, but only after the withdrawal RPC
       has actually confirmed. It is a receipt, not a promise. */
    function nvMoneySentAnimation(amount){
      try{
        if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        var src = document.getElementById("nvMhReady");
        var hero = document.getElementById("nvMoneyHero");
        if(src){
          var r = src.getBoundingClientRect();
          var fly = document.createElement("div");
          fly.className = "nv-mh-fly";
          fly.textContent = "− " + money(amount);
          fly.style.left = r.left + "px";
          fly.style.top  = r.top + "px";
          document.body.appendChild(fly);
          setTimeout(function(){ fly.remove(); }, 1100);
        }
        if(hero){
          hero.classList.remove("nv-sent"); void hero.offsetWidth;
          hero.classList.add("nv-sent");
          setTimeout(function(){ hero.classList.remove("nv-sent"); }, 1200);
        }
      }catch(e){}
    }

    /* Animations 7, 8, 9 -- the invoice list. */
    function nvInvoiceSteps(status){
      var st = nvMoneyStage(status);
      var d = function(n){ return '<span class="nv-inv-dot' + (st >= n ? " on" : "") + '"></span>'; };
      var b = function(n){ return '<span class="nv-inv-bar' + (st >  n ? " on" : "") + '"></span>'; };
      return '<div class="nv-inv-steps">' + d(1) + b(1) + d(2) + b(2) + d(3) +
             '<span class="nv-inv-stage">' + escLabelText(nvMoneyLabel(status)) + "</span></div>";
    }

    /* Raw Postgres timestamps were being printed straight onto merchant-facing
       documents -- "Settled on 2026-07-20T07:19:51.373934+00:00". */
    function nvNiceDate(v){
      if(!v) return "";
      var d=new Date(v);
      if(isNaN(d)) return String(v).slice(0,16).replace("T"," ");
      return d.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}) +
             ", " + d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});
    }

    function clientInvoiceHtml(inv){
      const c=clientById(inv.clientId);
      const lines=clientInvoiceLineItems(inv);
      const due=Number(inv.dueToNovax||0);
      const invType=inv.invoiceType||"COD Settlement";
      const deliveredAt=(state.parcels.find(p=>p.awb===(inv.parcelRefs||[])[0])||{}).updated||inv.createdAt;
      // NovaX fix (dashboard/invoices/wallet desync): paidAt is populated from
      // settled_at for every closed status, not just literal "Paid" -- a
      // Settled or Paid-to-NovaX invoice was showing no paid date at all.
      const paidEvent=inv.status==="Pushed to wallet"?inv.walletPushedAt:(isInvoiceClosed(inv.status)?inv.paidAt:"");
      // NovaX security fix: display-only escaping of every text cell on the
      // invoice. Amounts still come from money() on the same numbers, so the
      // invoice math, totals and settlement logic are byte-identical.
      // Outcome pill colours are inline because this HTML is also used for
      // print and for the PDF path, where the portal stylesheet is not applied.
      const TONE={ good:"background:var(--nvu-good-bg);color:var(--nvu-accent);border:1px solid var(--nvu-good-ln)",
                   bad:"background:var(--nvu-bad-bg);color:var(--nvu-bad-fg);border:1px solid var(--nvu-bad-ln)",
                   warn:"background:var(--nvu-warn-bg);color:var(--nvu-warn-fg);border:1px solid var(--nvu-warn-ln)" };
      const rows=lines.map(line=>{
        const pill=`<span style="display:inline-block;padding:2px 8px;border-radius:var(--r-pill);font-size:11px;font-weight:800;white-space:nowrap;${TONE[line.outcomeTone]||TONE.warn}">${escLabelText(line.outcome)}</span>`;
        /* Three distinct cases, because "Rs 0" with no reason is exactly the
           ambiguity this column exists to remove:
             prepaid delivered -> cash was never due, the customer paid online
             not delivered     -> cash was due but never collected
             delivered COD     -> the real amount */
        const codCell=line.prepaid
          ? `${money(0)}<div style="font-size:10px;color:#8a8a8a;font-weight:600">prepaid &mdash; no cash due</div>`
          : (line.collected
              ? money(line.codAmount)
              : `${money(0)}<div style="font-size:10px;color:#8a8a8a;font-weight:600">not collected</div>`);
        return `<tr><td>${escLabelText(line.awb)}</td><td>${escLabelText(line.bookingDate)}</td><td>${escLabelText(line.destinationCity)}</td><td>${escLabelText(line.consignee)}</td><td>${pill}</td><td>${escLabelText(line.paymentMode)}</td><td style="text-align:right">${codCell}</td><td style="text-align:right">${money(line.deliveryCharge)}${line.distanceKm!=null?`<div style="font-size:10px;color:#8a8a8a;font-weight:600">${escLabelText(line.distanceKm)} km</div>`:""}</td><td style="text-align:right">${money(line.netLineAmount)}</td></tr>`;
      }).join("");
      const nDelivered=lines.filter(l=>l.outcomeKey==="delivered").length;
      const nReturned=lines.filter(l=>l.outcomeKey==="returned"||l.outcomeKey==="refused"||l.outcomeKey==="cancelled").length;
      const nOther=lines.length-nDelivered-nReturned;
      const outcomeStrip=`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;font-size:12px">
        <span style="padding:5px 11px;border-radius:var(--r-md);${TONE.good}"><b>${nDelivered}</b> delivered &middot; COD collected</span>
        <span style="padding:5px 11px;border-radius:var(--r-md);${TONE.bad}"><b>${nReturned}</b> returned / refused &middot; charge only</span>
        ${nOther?`<span style="padding:5px 11px;border-radius:var(--r-md);${TONE.warn}"><b>${nOther}</b> still in progress</span>`:""}
      </div>`;
      /* Reconciliation guard. The header figures are the server's
         (cod_total / fee_total / net_payable) and are what actually settles.
         If the per-line view disagrees, say so plainly instead of showing two
         different numbers on one page and letting the merchant find it. */
      const lineCod=lines.reduce((s,l)=>s+Number(l.codAmount||0),0);
      const lineFee=lines.reduce((s,l)=>s+Number(l.deliveryCharge||0),0);
      const drift=(Math.abs(lineCod-Number(inv.cod||0))>1)||(Math.abs(lineFee-Number(inv.charges||0))>1);
      const driftNote=drift?`<div style="background:var(--nvu-warn-bg);border:1px solid var(--nvu-warn-ln);color:var(--nvu-warn-fg);border-radius:var(--r-md);padding:10px 12px;margin-bottom:14px;font-size:12px;line-height:1.5">
        <b>Note:</b> the per-parcel rows below add up to ${escLabelText(money(lineCod))} COD and ${escLabelText(money(lineFee))} in charges, which differs from the invoice totals shown in the summary. The <b>summary totals are the ones that settle</b> &mdash; they are calculated by NovaX at the moment the invoice is generated. A difference here usually means a parcel's status changed after invoicing. Please contact support if the gap looks wrong.
      </div>`:"";
      const balanceLabel=due>0?"Amount Due to NovaX":"Grand Total Payable";
      const balanceValue=due>0?money(due):money(inv.payable||0);
      return `<div class="nv-doc-paper" style="font-family:Arial,Helvetica,sans-serif;color:#0b1f16;background:var(--nvu-bg);padding:26px;max-width:820px;margin:0 auto;border-radius:var(--r-lg)">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:4px solid var(--nvu-accent);padding-bottom:14px;margin-bottom:18px">
          <div><div style="font-size:24px;font-weight:800;color:var(--nvu-accent);letter-spacing:.5px">NovaX Logistics</div><div style="font-size:11px;color:#5b6b64">Courier &amp; COD Operating Account | novaxlogistics.com</div></div>
          <div style="text-align:right"><div style="font-size:18px;font-weight:800">INVOICE</div><div style="font-size:13px">${escLabelText(inv.id)}</div></div>
        </div>
        <div style="display:flex;justify-content:space-between;gap:20px;margin-bottom:16px;flex-wrap:wrap">
          <div><div style="font-size:11px;color:#5b6b64;text-transform:uppercase">Billed to</div><div style="font-weight:700">${labelText(c&&c.name,inv.clientId)}</div><div style="font-size:12px">${labelText(c&&c.city)} ${labelText(c&&c.email,"")}</div></div>
          <div><div style="font-size:11px;color:#5b6b64;text-transform:uppercase">Invoice date</div><div style="font-weight:700">${escLabelText(inv.createdAt)}</div></div>
          <div><div style="font-size:11px;color:#5b6b64;text-transform:uppercase">Invoice type</div><div style="font-weight:700">${escLabelText(invType)}</div></div>
          <div><div style="font-size:11px;color:#5b6b64;text-transform:uppercase">Status</div><div style="font-weight:700">${escLabelText(inv.status)}</div><div style="font-size:11px;color:#5b6b64">${escLabelText(invoiceSettlementNote(inv))}</div></div>
        </div>
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#5b6b64;margin-bottom:6px">Tracking &amp; delivery charge breakdown</div>
        ${outcomeStrip}
        ${driftNote}
        <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:16px"><table style="width:100%;min-width:640px;border-collapse:collapse;font-size:12px"><thead><tr style="background:#eef7f2"><th style="text-align:left;padding:7px;border:1px solid var(--nvu-line-2)">Tracking ID / AWB</th><th style="text-align:left;padding:7px;border:1px solid var(--nvu-line-2)">Booking Date</th><th style="text-align:left;padding:7px;border:1px solid var(--nvu-line-2)">Destination City</th><th style="text-align:left;padding:7px;border:1px solid var(--nvu-line-2)">Consignee</th><th style="text-align:left;padding:7px;border:1px solid var(--nvu-line-2)">Outcome</th><th style="text-align:left;padding:7px;border:1px solid var(--nvu-line-2)">Payment Mode</th><th style="text-align:right;padding:7px;border:1px solid var(--nvu-line-2)">COD Amount</th><th style="text-align:right;padding:7px;border:1px solid var(--nvu-line-2)">Delivery Charge</th><th style="text-align:right;padding:7px;border:1px solid var(--nvu-line-2)">Net Line Amount</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${paidEvent?`<div style="background:var(--nvu-bg-2);border:1px solid var(--nvu-line-2);border-radius:var(--r-md);padding:10px 12px;margin-bottom:16px;font-size:13px">Settled on <b>${escLabelText(nvNiceDate(paidEvent))}</b></div>`:""}
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#5b6b64;margin-bottom:6px">Summary</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td colspan="2" style="padding:12px 8px 4px;font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--nvu-accent)">What we collected</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid var(--nvu-line)">COD collected on your behalf</td><td style="padding:8px;border-bottom:1px solid var(--nvu-line);text-align:right">${money(inv.cod||0)}</td></tr>
          <tr><td colspan="2" style="padding:12px 8px 4px;font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--nvu-bad-fg)">What we deducted</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid var(--nvu-line)">Delivery charges &mdash; ${lines.filter(l=>l.outcomeKey==="delivered").length} delivered parcel(s)</td><td style="padding:8px;border-bottom:1px solid var(--nvu-line);text-align:right">&minus; ${money(lines.filter(l=>l.outcomeKey==="delivered").reduce((a,l)=>a+Number(l.deliveryCharge||0),0))}</td></tr>
          ${(function(){ const rl=lines.filter(l=>l.outcomeKey==="returned"||l.outcomeKey==="refused"||l.outcomeKey==="cancelled"); const rc=rl.reduce((a,l)=>a+Number(l.deliveryCharge||0),0); return rc>0?`<tr><td style="padding:8px;border-bottom:1px solid var(--nvu-line)">Return charges &mdash; ${rl.length} returned / refused parcel(s), no COD collected</td><td style="padding:8px;border-bottom:1px solid var(--nvu-line);text-align:right">&minus; ${money(rc)}</td></tr>`:""; })()}
          <tr><td style="padding:8px;border-bottom:1px solid var(--nvu-line)">Total Parcels</td><td style="padding:8px;border-bottom:1px solid var(--nvu-line);text-align:right">${lines.length}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid var(--nvu-line)">COD Subtotal</td><td style="padding:8px;border-bottom:1px solid var(--nvu-line);text-align:right">${money(inv.cod||0)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid var(--nvu-line)">Delivery Charges Subtotal</td><td style="padding:8px;border-bottom:1px solid var(--nvu-line);text-align:right">${money(inv.charges||0)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid var(--nvu-line)">Payable to Client</td><td style="padding:8px;border-bottom:1px solid var(--nvu-line);text-align:right">${money(inv.payable||0)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid var(--nvu-line)">Amount Due to NovaX</td><td style="padding:8px;border-bottom:1px solid var(--nvu-line);text-align:right">${money(due)}</td></tr>
          <tr><td style="padding:12px 8px;font-weight:800;font-size:16px;background:#eef7f2">${balanceLabel}</td><td style="padding:12px 8px;font-weight:800;font-size:16px;background:#eef7f2;text-align:right">${balanceValue}</td></tr>
        </table>
        <div style="margin-top:22px;font-size:11px;color:#5b6b64;border-top:1px solid var(--nvu-line);padding-top:12px">Generated by NovaX Logistics. This is a system-generated invoice, no tax/GST applied unless shown above. For questions, ask the in-app AI assistant. Parcels: ${escLabelText(inv.parcelRefs.join(", "))}.</div>
      </div>`;
    }
    /* Shared print tail for the two plain-#printStage documents (invoice and
       report). Both used to do:

           stage.style.display="block"; window.print();
           setTimeout(()=>{ stage.style.display="none"; },500);

       which is the SAME fixed-500ms cleanup that was already diagnosed and
       removed from printLabels(): on a slower device the stage could be
       hidden before the browser had finished reading it, producing a blank
       printout. Cleanup now hangs off the real afterprint event, with a long
       timer only as a fallback for browsers that never fire it. It also
       restores the theme, so these two documents print on paper-white like
       the labels do. */
    function nvPrintStageNow(){
      var stage=document.getElementById("printStage");
      if(!stage) return;
      stage.style.display="block";
      var cleaned=false;
      function done(){
        if(cleaned) return; cleaned=true;
        nvPrintThemeRestore();
        stage.style.display="none"; stage.innerHTML="";
        window.removeEventListener("afterprint",done);
      }
      window.addEventListener("afterprint",done);
      setTimeout(done,8000);
      nvPrintThemeLight();
      try{ window.print(); }catch(e){ done(); }
    }

    function printInvoice(id){
      const inv=state.invoices.find(i=>i.id===id); if(!inv) return;
      const stage=document.getElementById("printStage"); if(!stage) return;
      stage.innerHTML=clientInvoiceHtml(inv);
      nvPrintStageNow();
    }
    function viewInvoice(id){
      const inv=state.invoices.find(i=>i.id===id); if(!inv){ toast("Invoice not found."); return; }
      const modal=document.getElementById("invoiceViewModal");
      const body=document.getElementById("invoiceViewBody");
      if(!modal||!body) return;
      body.innerHTML=clientInvoiceHtml(inv);
      const printBtn=document.getElementById("invoiceViewPrintBtn"); if(printBtn) printBtn.setAttribute("onclick",`printInvoice('${inv.id}')`);
      const csvBtn=document.getElementById("invoiceViewCsvBtn"); if(csvBtn) csvBtn.setAttribute("onclick",`downloadInvoiceCsv('${inv.id}')`);
      modal.classList.add("show");
    }
    function closeInvoiceModal(){ const modal=document.getElementById("invoiceViewModal"); if(modal) modal.classList.remove("show"); }
    function exportReportCsv(){
      const rows=state.parcels.filter(p=>p.clientId===state.client.id);
      const head=["AWB","Date","Consignee","City","Status","COD","Fee","AgingHours"];
      const csv=[head.map(csvCell).join(",")].concat(rows.map(p=>[p.awb,p.date,p.consignee,p.city,p.status,p.cod,p.fee,Math.round(agingHours(p))].map(csvCell).join(","))).join("\n");
      const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download="novax-report.csv"; a.click(); toast("Report CSV downloaded.");
    }
    function exportReportPdf(){
      const rows=state.parcels.filter(p=>p.clientId===state.client.id);
      const stage=document.getElementById("printStage");
      stage.innerHTML=`<div style="font-family:sans-serif;color:#000;background:var(--nvu-bg);padding:24px"><h2>NovaX Full Report — ${escLabelText(state.client.name)}</h2><table style="width:100%;border-collapse:collapse" border="1" cellpadding="6"><tr><th>AWB</th><th>Date</th><th>Consignee</th><th>Status</th><th>COD</th></tr>${rows.map(p=>`<tr><td>${escLabelText(p.awb)}</td><td>${escLabelText(p.date)}</td><td>${escLabelText(p.consignee)}</td><td>${escLabelText(p.status)}</td><td>${money(p.cod)}</td></tr>`).join("")}</table></div>`;
      nvPrintStageNow();
    }

    /* Wallet */
    const WALLET_FEE={ "24h":0.001, "12h":0.003, "instant":0.007 };
    function walletFeeRate(s){ return WALLET_FEE[s] ?? 0.001; }
    function walletFeePct(s){ return s==="instant"?"0.7%":s==="12h"?"0.3%":"0.1%"; }
    /* The payout fee is computed server-side by request_wallet_withdrawal as
         v_rate := case p_speed when 'instant' then 0.007 when '12h' then 0.003 else 0.001 end;
         v_fee  := round(p_amount * v_rate, 2);
       -- to two decimals, i.e. paisa. The browser previewed it with
       Math.round(), i.e. whole rupees, so the figure a merchant confirmed
       could differ from the figure actually recorded by up to 50 paisa (on
       Rs 21,120 at 0.3%: preview Rs 63, recorded Rs 63.36). The rates
       themselves always agreed; only the rounding drifted. This mirrors the
       server exactly so the preview and the receipt can never disagree.
       The server remains authoritative -- wherever the RPC returns fee/net,
       those values are used in preference to this. */
    function nvPayoutFee(amount, speed){
      return Math.round(Number(amount||0) * walletFeeRate(speed) * 100) / 100;
    }

    function walletSpeedLabel(s){ return s==="instant"?"Instant 2-3 hours":s==="12h"?"12 hours":"24 hours"; }
    function walletBalance(id){ return Number(clientById(id).walletBalance||0); }
    function selectWalletSpeed(s){ state.walletWithdrawSpeed=s; saveState(); renderClientWallet(); }
    // NovaX fix (wallet IBAN UX): shared IBAN validation + masking so bank
    // details, withdraw confirmation, and history all agree on the same
    // rule (required, must start with PK, minimum 15 characters) and never
    // show a full IBAN once it's saved.
    function validateIbanValue(iban){
      const s=String(iban||"").replace(/\s+/g,"").toUpperCase();
      if(!s) return "IBAN is required.";
      if(!s.startsWith("PK")) return "IBAN must start with PK.";
      if(s.length<15) return "IBAN must be at least 15 characters.";
      return "";
    }
    function maskIban(iban){
      const s=String(iban||"").replace(/\s+/g,"").toUpperCase();
      if(!s) return "No IBAN saved";
      if(s.length<=8) return s.slice(0,2)+"****";
      return s.slice(0,4)+"****"+s.slice(-4);
    }
    function editBankDetails(){ state.bankDetailsEditing=true; saveState(); renderBankDetailsSection(); }
    function cancelBankDetailsEdit(){ state.bankDetailsEditing=false; saveState(); renderBankDetailsSection(); }
    // NovaX fix (withdrawal UX v2): bank details are now a real server-side
    // record (clients.meta.bank via the save_client_bank_details /
    // client_bank_details RPCs) instead of only living in localStorage.
    // fetchClientBankDetails() pulls the saved row once per session so it
    // survives a refresh or a new device; saveBankDetails() below waits for
    // the server to confirm before showing "saved".
    let __bankDetailsFetchedOnce=false;
    let __bankDetailsFetchInFlight=false;
    // NovaX fix (withdrawal UX v3): only mark bank details as "fetched" once
    // the RPC has actually succeeded -- previously the flag was set the
    // instant the call started, so a network blip or a not-yet-deployed RPC
    // would permanently block retries for the rest of the session. Now a
    // failed attempt leaves the flag false so the next renderClientWallet()
    // call retries automatically, and an in-flight guard stops duplicate
    // concurrent calls while one is already pending.
    function fetchClientBankDetails(){
      if(!window.__nvSb || __bankDetailsFetchedOnce || __bankDetailsFetchInFlight) return;
      __bankDetailsFetchInFlight=true;
      window.__nvSb.rpc("client_bank_details",{}).then(function(r){
        __bankDetailsFetchInFlight=false;
        if(r&&r.error){ console.warn("NovaX bank details fetch failed:",r.error.message); return; }
        __bankDetailsFetchedOnce=true;
        const row=Array.isArray(r.data)?r.data[0]:r.data;
        if(row && row.iban){
          state.clientBankDetails={ holderName:row.holder_name||"", iban:row.iban||"", bankName:row.bank_name||"", updatedAt:row.updated_at||"" };
          saveState(); renderBankDetailsSection(); renderClientWallet();
        }
      }).catch(function(e){ __bankDetailsFetchInFlight=false; console.warn("NovaX bank details fetch error:",e&&e.message); });
    }
    function renderBankDetailsSection(){
      const el=document.getElementById("bankDetailsSection"); if(!el) return;
      const bd=state.clientBankDetails;
      if(bd && !state.bankDetailsEditing){
        el.innerHTML=`<div class="ops-card bank-saved-pulse"><div class="ops-card-head"><strong>${escLabelText(bd.holderName||"Saved bank account")}</strong><span class="chip good">&#10003; Bank details saved</span></div><p>${escLabelText(maskIban(bd.iban))}${bd.bankName?(" &middot; "+escLabelText(bd.bankName)):""}</p><button class="action-btn" style="margin-top:10px" onclick="editBankDetails()">Edit Bank Details</button></div>`;
        return;
      }
      el.innerHTML=`<div class="field" style="max-width:380px"><label>Account holder name</label><input id="bankHolderName" value="${bd?escLabelText(bd.holderName||""):""}"></div>
        <div class="field" style="max-width:380px;margin-top:10px"><label>IBAN</label><input id="bankIbanInput" placeholder="PK00 BANK 0000 0000 0000 0000" value="${bd?escLabelText(bd.iban||""):""}"></div>
        <div class="field" style="max-width:380px;margin-top:10px"><label>Bank name (optional)</label><input id="bankNameInput" value="${bd?escLabelText(bd.bankName||""):""}"></div>
        <div id="bankDetailsError" class="footer-note" style="display:none;background:#fff2f0;border:1px solid #f3b7ad;color:#a3271b;margin-top:10px"></div>
        <button class="action-btn" id="saveBankDetailsBtn" style="margin-top:12px" onclick="saveBankDetails()">Save Bank Details</button>
        ${bd?`<button class="action-btn" style="margin-top:12px;margin-left:8px;background:#eef2f5;color:#333" onclick="cancelBankDetailsEdit()">Cancel</button>`:""}`;
    }
    /* NovaX new (deferred bank details): offer to remember the IBAN the
       merchant just paid out to, so the next withdrawal is one tap. Uses
       the existing save_client_bank_details RPC -- no new endpoint. Silent
       if it is already the saved account, or if they decline. */
    function nvOfferSaveIban(iban){
      var clean=String(iban||"").trim().toUpperCase();
      if(!clean) return;
      if(typeof validateIbanValue==="function" && validateIbanValue(clean)) return;
      var bd=state.clientBankDetails;
      if(bd&&bd.iban&&String(bd.iban).trim().toUpperCase()===clean) return;   // already saved
      var sb=window.__nvSb;
      if(!sb||!sb.rpc) return;
      setTimeout(function(){
        var holder=(bd&&bd.holderName)||(state.client&&state.client.name)||"";
        if(!window.confirm("Save "+maskIban(clean)+" as your payout account so you don't have to type it next time?")) return;
        var name=holder||window.prompt("Account holder name (as printed on the bank account):","")||"";
        name=String(name).trim();
        if(!name){ toast("Not saved — an account holder name is required."); return; }
        sb.rpc("save_client_bank_details",{ p_holder_name:name, p_iban:clean, p_bank_name:(bd&&bd.bankName)||"" })
          .then(function(r){
            if(r&&r.error){ toast("Could not save the account: "+r.error.message,"error"); return; }
            state.clientBankDetails={ holderName:name, iban:clean, bankName:(bd&&bd.bankName)||"" };
            saveState();
            try{ renderBankDetailsSection(); }catch(e){}
            toast("Payout account saved for next time.","success");
          }).catch(function(e){ toast("Could not save the account: "+((e&&e.message)||e),"error"); });
      },1200);
    }

    function saveBankDetails(){
      const err=document.getElementById("bankDetailsError");
      const btn=document.getElementById("saveBankDetailsBtn");
      const holderName=(document.getElementById("bankHolderName")?.value||"").trim();
      const iban=(document.getElementById("bankIbanInput")?.value||"").trim().toUpperCase();
      const bankName=(document.getElementById("bankNameInput")?.value||"").trim();
      if(!holderName){ err.style.display="block"; err.textContent="Account holder name is required."; return; }
      const ibanErr=validateIbanValue(iban);
      if(ibanErr){ err.style.display="block"; err.textContent=ibanErr; return; }
      err.style.display="none";
      // NovaX fix (withdrawal UX v2): save now goes through the
      // save_client_bank_details RPC and only shows "saved" once Supabase
      // actually confirms it -- never a silent local-only save again.
      const sbClient=window.__nvSb;
      if(!sbClient){ err.style.display="block"; err.textContent="Cloud connection not ready yet, please try again in a moment."; toast("Bank details not saved: cloud connection not ready yet.","error"); return; }
      if(btn){ btn.disabled=true; btn.textContent="Saving..."; }
      sbClient.rpc("save_client_bank_details",{ p_holder_name:holderName, p_iban:iban, p_bank_name:bankName }).then(function(r){
        if(btn){ btn.disabled=false; btn.textContent="Save Bank Details"; }
        if(r&&r.error){
          err.style.display="block"; err.textContent=r.error.message||"Could not save bank details.";
          toast("Bank details not saved: "+(r.error.message||"server declined the request."),"error");
          return;
        }
        const row=Array.isArray(r.data)?r.data[0]:r.data;
        state.clientBankDetails={ holderName:(row&&row.holder_name)||holderName, iban:(row&&row.iban)||iban, bankName:(row&&row.bank_name)||bankName, updatedAt:(row&&row.updated_at)||new Date().toISOString() };
        state.bankDetailsEditing=false;
        saveState(); renderClientWallet();
        toast("Bank details saved.","success");
      }).catch(function(e){
        if(btn){ btn.disabled=false; btn.textContent="Save Bank Details"; }
        err.style.display="block"; err.textContent=(e&&e.message)||"Network error, please try again.";
        toast("Bank details not saved: "+((e&&e.message)||"network error, please try again."),"error");
      });
    }
    /* NovaX (COD front and centre): the money panel that opens the dashboard.
       Every figure is read from what the Wallet tab already computed
       server-side (state.walletSummary if present, else the same fallbacks
       renderClientWallet uses) so the two screens can never disagree -- the
       desync class of bug this portal has been bitten by repeatedly. */
    /* NovaX new (per-client pickup city): the field and its note were fixed
       text reading "Karachi", so a Lahore merchant saw the wrong origin on
       every booking and on every printed AWB. Both now follow the client
       record. Still readonly -- only NovaX can move a merchant's pickup city,
       from the admin Clients tab. */
    function applyPickupCity(){
      try{
        var city=(state.client&&state.client.pickupCity)||"Karachi";
        var el=document.getElementById("bookingPickupCity");
        if(el && el.value!==city) el.value=city;
        var note=document.getElementById("bookingPickupNote");
        if(note) note.textContent="All your pickups run from our "+city+" hub.";
      }catch(e){}
    }
    function renderCodHero(){
      const host=document.getElementById("nvCodHero");
      if(!host) return;
      const U=window.NovaXUI;
      try{
        const c=(typeof clientById==="function"&&state.client)?clientById(state.client.id):null;
        if(!c||!state.client||!state.client.id){ host.innerHTML=""; return; }
        /* BUG: this read state.walletSummary, a key that is never assigned
           anywhere in this file -- the server summary lives on
           state.serverWalletSummary, which is what the Money tab and the
           wallet statement both use. So `sv` was always null here, the
           dashboard silently fell through to local arithmetic, and it
           disagreed with the Money tab about the merchant's own balance.

           It also subtracted pending payouts a second time:
           client_wallet_summary.available_balance is ALREADY net of them, so
           balance-minus-pending double-counted an open withdrawal. Available
           now comes straight from the server, exactly as Money reads it. */
        const sv=state.serverWalletSummary||null;
        const myWds=(state.walletWithdrawals||[]).filter(w=>w&&w.clientId===state.client.id);
        const localPending=myWds.filter(w=>w.status==="Pending admin payout")
                                .reduce((s2,w)=>s2+Number(w.net||0),0);
        const pending=sv?Number(sv.pending_payout||0):localPending;
        const available=sv?Number(sv.available_balance||0)
                          :Math.max(0,Number(c.walletBalance||0)-localPending);
        const balance=available+pending;
        // "In flight" is COD not yet settled -- delivered parcels whose
        // invoice has not closed. Labelled as an estimate because it is
        // derived locally, unlike balance/pending which are server truth.
        const inflight=clientMetrics().payable;
        const paidRows=myWds.filter(w=>w.status==="Paid")
          .sort((a,b)=>String(b.paidAt||b.createdAt).localeCompare(String(a.paidAt||a.createdAt))).slice(0,3);
        const spark=(function(){
          const days={};
          (state.parcels||[]).filter(p=>p&&p.clientId===state.client.id&&isDeliveredLedgerParcel(p))
            .forEach(p=>{ const d=String(p.date||"").slice(0,10); if(d) days[d]=(days[d]||0)+Number(p.cod||0); });
          const keys=Object.keys(days).sort().slice(-10);
          return keys.map(k=>days[k]);
        })();
        /* When no payout is pending the headline and the "Available" box are
           the same number, so the CSS collapses the box and folds its label
           into the headline instead. They only ever both appear when they
           genuinely differ. */
        const sameFigure = Math.round(Number(balance||0)) === Math.round(Number(available||0));
        host.innerHTML=
          '<div class="nv-cod-hero"'+(sameFigure?' data-same="1"':'')+'>'+
            '<div class="nv-cod-main">'+
              '<span class="nv-cod-l">COD balance</span>'+
              '<div class="nv-cod-v">'+escLabelText(money(balance))+'</div>'+
              (spark.length>1?'<div class="nv-cod-spark">'+U.sparkline(spark,{w:220,h:30})+'</div>':'')+
            '</div>'+
            '<div class="nv-cod-grid">'+
              '<div class="nv-cod-b nv-cod-avail"><span>Available</span><strong>'+escLabelText(money(available))+'</strong></div>'+
              '<div class="nv-cod-b"><span>Pending payout</span><strong>'+escLabelText(money(pending))+'</strong></div>'+
              /* "COD in flight" was a number with the word "estimate" under it
                 and no way to find out what it meant. It is the merchant's own
                 money, so it should say which parcels it is waiting on and let
                 them look. */
              '<div class="nv-cod-b nv-cod-flight'+(inflight>0?' tap':'')+'"'+
                (inflight>0?' role="button" tabindex="0" onclick="nvShowInFlight()" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();nvShowInFlight();}"':'')+
                '><span>COD in flight</span><strong>'+escLabelText(money(inflight))+'</strong>'+
                '<i>'+(inflight>0?nvInFlightCount()+' delivered, awaiting invoice \u2014 tap':'nothing waiting')+'</i></div>'+
            '</div>'+
            '<div class="nv-cod-act">'+
              '<button type="button" class="nv-cod-cta" data-client-tab="wallet">Withdraw</button>'+
              (paidRows.length?'<div class="nv-cod-recent"><span>Recent settlements</span>'+
                paidRows.map(w=>'<div class="nv-cod-r"><b>'+escLabelText(money(w.net))+'</b>'+
                  '<em>'+escLabelText(String(w.paidAt||w.createdAt||"").slice(0,10))+'</em>'+
                  '<span class="nvst nvst-good"><i>\u2713</i>Paid</span></div>').join("")+
              '</div>':'')+
            '</div>'+
          '</div>';
      }catch(e){ try{ host.innerHTML=""; }catch(_){} }
    }
    function renderClientWallet(){
      const bt=document.getElementById("walletBalanceText"); if(!bt) return;
      const c=clientById(state.client.id); const balance=Number(c.walletBalance||0);
      /* NovaX motion: money arriving is the moment the merchant is here for.
         The balance used to snap and replay a generic pop on every render.
         Now it counts from the previously shown figure to the new one only
         when it has actually moved, and the ledger row responsible is
         highlighted so the merchant can see WHERE it came from. The final
         frame always writes the exact value via money(). */
      const __prevBal = (typeof window.__nvShownBalance==="number") ? window.__nvShownBalance : null;
      const __balMoved = __prevBal!==null && __prevBal!==balance;
      window.__nvShownBalance = balance;
      if(__balMoved && !matchMedia("(prefers-reduced-motion: reduce)").matches){
        (function(){
          const t0=performance.now(), dur=700, from=__prevBal, to=balance;
          (function step(ts){
            if(!bt.isConnected) return;
            const k=Math.min(1,((ts||performance.now())-t0)/dur), e=1-Math.pow(1-k,3);
            bt.textContent = k<1 ? money(Math.round(from+(to-from)*e)) : money(to);
            if(k<1) requestAnimationFrame(step);
          })(t0);
        })();
        bt.classList.remove("count-up"); void bt.offsetWidth; bt.classList.add("count-up");
      } else {
        bt.textContent=money(balance);
        if(__prevBal===null){ bt.classList.remove("count-up"); void bt.offsetWidth; bt.classList.add("count-up"); }
      }
      // NovaX fix (withdrawal UX v2): pull the server-saved bank details once
      // per session so Save Bank Details survives a refresh/new device.
      fetchClientBankDetails();
      /* NovaX new (Smart Portal B+D): kick off the two server-computed
         wallet intelligence reads. Both are fire-and-forget and fail
         silently -- neither may ever block or break the wallet page. */
      nvLoadWalletIntelligence();
      // NovaX fix (wallet IBAN UX): bank details render independently of
      // balance/speed/amount so they're always available to add or edit.
      renderBankDetailsSection();
      const push=state.lastWalletPush;
      document.getElementById("walletPushNote").textContent=push?`Last credited ${money(push.amount)} from admin (${push.invoice}) at ${push.at}`:"No admin credit yet";
      // NovaX new (Finance Control Room v2): the client never sees
      // "mismatch"/"locked" language. If their own ledger math doesn't add
      // up to their wallet balance, we just say finance is reviewing their
      // statement -- no numbers, no alarm.
      const myWds=(state.walletWithdrawals||[]).filter(w=>w.clientId===c.id);
      const myLedger=(state.walletLedger||[]).filter(l=>l.clientId===c.id);
      const expectedRaw=myLedger.filter(l=>l.affectsBalance).reduce((s,l)=>s+Number(l.amount||0),0);
      // NovaX fix (non-COD delivery charge): negative wallet balances are
      // now a legitimate state (a client owes NovaX for delivery charges),
      // so "expected" must not be clamped to 0 -- doing so would falsely
      // flag every client who legitimately owes money as "under review".
      const expected=Math.round(expectedRaw*100)/100;
      const walletUnderReview=Math.abs(Math.round((balance-expected)*100)/100)>=1;
      const reviewNote=document.getElementById("walletReviewNote");
      if(reviewNote) reviewNote.style.display=walletUnderReview?"block":"none";
      const monthKey=new Date().toISOString().slice(0,7);
      const sv=state.serverWalletSummary;
      const pendingPayout=sv?Number(sv.pending_payout||0):myWds.filter(w=>w.status==="Pending admin payout").reduce((s,w)=>s+Number(w.net||0),0);
      const paidThisMonth=sv?Number(sv.paid_this_month||0):myWds.filter(w=>w.status==="Paid"&&String(w.paidAt||w.createdAt).slice(0,7)===monthKey).reduce((s,w)=>s+Number(w.net||0),0);
      const lifetimeWithdrawn=sv?Number(sv.lifetime_withdrawn||0):myWds.filter(w=>w.status==="Paid").reduce((s,w)=>s+Number(w.net||0),0);
      const serverBalance=sv?Number(sv.available_balance||0):balance;
      try{ renderWalletIncoming(); }catch(e){}
      try{ renderFeeInsights(); }catch(e){}
      const summaryCards=document.getElementById("walletSummaryCards");
      if(summaryCards){
        summaryCards.innerHTML=[
          moneyBox("Available",money(serverBalance),"ready to withdraw"),
          moneyBox("Pending payout",money(pendingPayout),"being verified by finance"),
          moneyBox("Paid this month",money(paidThisMonth),"settled to your bank"),
          moneyBox("Lifetime withdrawn",money(lifetimeWithdrawn),"all-time total")
        ].join("");
      }
      // NovaX rebuild (wallet+invoice v1): client_wallet_summary() is the
      // server-side source of truth for these four numbers (never browser-
      // cached money movement). Fetch it in the background and re-render
      // once it resolves; throttled so it only runs once every few seconds
      // even though renderClientWallet can be called often.
      if(window.__nvSb && (!state.__walletSummaryFetchedAt || (Date.now()-state.__walletSummaryFetchedAt)>4000)){
        state.__walletSummaryFetchedAt=Date.now();
        window.__nvSb.rpc("client_wallet_summary",{}).then(function(r){
          if(r&&r.error){ console.warn("NovaX wallet summary fetch failed:",r.error.message); return; }
          const row=Array.isArray(r.data)?r.data[0]:r.data;
          if(row){ state.serverWalletSummary=row; renderClientWallet(); }
        }).catch(function(e){ console.warn("NovaX wallet summary fetch error:",e&&e.message); });
      }
      const entryLabels={ invoice_credit:"Invoice credited", withdrawal_requested:"Withdrawal requested", payout_fee:"Payout fee deducted", payout_paid:"Payout paid", admin_adjustment:"Admin adjustment", delivery_charge_due:"Delivery charge collected" };
      const ledgerList=document.getElementById("walletLedgerList");
      if(ledgerList){
        ledgerList.innerHTML=myLedger.slice(0,50).map(l=>`<div class="ops-card"><div class="ops-card-head"><strong>${escLabelText(entryLabels[l.entryType]||l.entryType)}</strong><span class="chip ${l.amount>=0?"good":"warn"}">${money(l.amount)}</span></div><p>${escLabelText(l.note||l.referenceCode||"")}</p><div class="footer-note">${escLabelText(nvNiceDate(l.createdAt))}</div></div>`).join("")||`<div class="ops-card"><strong>No wallet activity yet</strong></div>`;
        /* NovaX motion: when the balance actually moved this render, flag the
           newest ledger row so the merchant can see what caused it, rather
           than just noticing a different total. Same .nv-changed sweep the
           parcel list uses, so the vocabulary is consistent. */
        if(__balMoved && !matchMedia("(prefers-reduced-motion: reduce)").matches){
          const firstRow=ledgerList.firstElementChild;
          if(firstRow) firstRow.classList.add("nv-changed");
        }
      }
      /* BUG: this refilled the box with the full balance the instant it went
         empty, so you could not clear it to type a smaller number, and it
         silently snapped an over-balance amount back down with no message --
         which is also why the "cannot be more than your balance" error below
         was unreachable: rawAmt was read AFTER the clamp, so amountTooHigh
         could never be true.

         Seed it once when it has never been touched; after that the merchant
         owns the field and an invalid amount is explained rather than
         rewritten. */
      const amtInput=document.getElementById("withdrawAmount");
      if(amtInput && !amtInput.dataset.nvTouched && !amtInput.value){
        amtInput.value=serverBalance||"";
      }
      if(amtInput && !amtInput.dataset.nvBound){
        amtInput.dataset.nvBound="1";
        amtInput.addEventListener("input",function(){ amtInput.dataset.nvTouched="1"; });
      }
      // NovaX fix (withdrawal UX v2): default to the 24h speed the first time
      // this tab renders so a payout card is always selected and the fee/net
      // preview is visible immediately, without forcing a click first.
      if(!state.walletWithdrawSpeed) state.walletWithdrawSpeed="24h";
      const speed=state.walletWithdrawSpeed||"24h";
      document.querySelectorAll(".tier-card").forEach(t=>t.classList.toggle("active",t.dataset.speed===speed));
      const summary=document.getElementById("withdrawSummary");
      // NovaX fix (withdrawal UX v2): the Withdraw Funds card must always show
      // the fee/net preview, saved bank preview, and a "Request Withdrawal"
      // button -- never hidden, only disabled with an exact visible reason.
      const rawAmt=Number(amtInput?.value||0);
      const amountTooHigh=rawAmt>serverBalance;
      const useAmt=Math.min(rawAmt||0,serverBalance)||0;
      // NovaX fix (wallet IBAN UX): withdrawal no longer collects its own IBAN
      // input -- it only ever uses whatever is saved in the Bank Account /
      // IBAN section above, and Request Withdrawal is disabled until that
      // saved IBAN passes validation.
      const bd=state.clientBankDetails;
      // NovaX fix (withdrawal UX v3): the payout IBAN is now a real editable
      // field on this card, not locked to whatever is saved in Bank Account /
      // IBAN above. It's prefilled from the saved IBAN once (as a
      // convenience default) but only while the field is untouched and
      // empty, so a client can freely overwrite it with a different IBAN for
      // this withdrawal without anything forcing it back.
      const ibanInput=document.getElementById("withdrawIbanInput");
      if(ibanInput && !ibanInput.dataset.touched && !ibanInput.value && bd && bd.iban) ibanInput.value=bd.iban;
      const typedIban=(ibanInput&&ibanInput.value||"").trim().toUpperCase();
      const typedIbanErr=validateIbanValue(typedIban);
      const fee=nvPayoutFee(useAmt,speed); const net=useAmt-fee;
      let blockReason="";
      if(state.__withdrawInFlight) blockReason="Submitting your withdrawal request...";
      else if(typedIbanErr) blockReason=typedIban?typedIbanErr:"Enter the IBAN this payout should go to.";
      else if(serverBalance<0) blockReason=`You owe ${money(Math.abs(serverBalance))} in delivery charges -- clear this before withdrawing.`;
      else if(serverBalance<=0) blockReason="You have Rs 0 available to withdraw right now.";
      else if(!(rawAmt>0)) blockReason="Enter an amount greater than 0.";
      else if(amountTooHigh) blockReason="Amount cannot be more than your available balance ("+money(serverBalance)+").";
      const canConfirm=!blockReason;
      summary.style.display="block";
      summary.innerHTML=`<div class="money-grid">${moneyBox("Withdraw amount",money(useAmt),"selected")}${moneyBox("Fee "+walletFeePct(speed),money(fee),walletSpeedLabel(speed))}${moneyBox("You receive",money(net),"net to your bank")}</div>`+
        `<div class="footer-note" style="margin-top:12px">${(!typedIbanErr&&typedIban)?("Payout goes to <b>"+escLabelText(maskIban(typedIban))+"</b>"+(bd&&bd.holderName?(" for "+escLabelText(bd.holderName)):"")+". "):""}${canConfirm?"":("<b>"+escLabelText(blockReason)+"</b>")}</div>`+
        `<button class="action-btn" id="confirmWithdrawBtn" style="margin-top:12px" onclick="requestWalletWithdrawal()" ${canConfirm?"":"disabled"} title="${canConfirm?"Request Withdrawal":escLabelText(blockReason)}">${state.__withdrawInFlight?"Submitting...":"Request Withdrawal"}</button>`;
      document.getElementById("withdrawHistory").innerHTML=myWds.map(w=>{
        // NovaX new (Finance Control Room v2): friendly status wording only --
        // no mention of admin review queues, locks, or risk.
        const friendlyStatus=w.status==="Paid"?"Paid":"Being verified by finance";
        const paidRef=(w.status==="Paid"&&w.paidTxnId)?` &middot; Paid with reference ${w.paidTxnId}`:"";
        // NovaX fix (wallet IBAN UX, item #10): history now shows a masked
        // IBAN (e.g. PK24****3344) instead of the full account number.
        return `<div class="ops-card"><div class="ops-card-head"><strong>${escLabelText(w.id)}</strong><span class="chip ${w.status==="Paid"?"good":"warn"}">${friendlyStatus}</span></div><p>${money(w.net)} to ${escLabelText(maskIban(w.iban))} &middot; ${walletSpeedLabel(w.speed)} &middot; fee ${money(w.fee)}</p><div class="footer-note">Requested ${w.createdAt}${w.paidAt?(" &middot; Paid "+w.paidAt):""}${paidRef}</div><div class="inline-actions" style="margin-top:8px"><button class="ghost-btn" style="padding:5px 11px;font-size:12px" onclick="nvWithdrawalReceipt('${escLabelText(w.id)}')">Receipt</button></div></div>`;
      }).join("")||`<div class="ops-card"><strong>No withdrawals yet</strong><p>Pick a payout speed above to withdraw.</p></div>`;
    }
    let __withdrawInFlight=false;
    // NovaX fix (withdrawal UX v2): renamed from confirmWalletWithdraw to
    // requestWalletWithdrawal to match the button label and the required
    // client-side entry point; confirmWalletWithdraw is kept below as a thin
    // backward-compatible alias.
    function requestWalletWithdrawal(){
      // Guard against a double click / rapid repeat firing two requests
      // before the button has even finished disabling -- this is in addition
      // to the server-side 15-second duplicate guard inside
      // request_wallet_withdrawal itself.
      if(__withdrawInFlight||state.__withdrawInFlight) return;
      const c=clientById(state.client.id);
      const sv=state.serverWalletSummary;
      const balance=sv?Number(sv.available_balance||0):Number(c.walletBalance||0);
      const amt=Math.min(Number(document.getElementById("withdrawAmount").value||0),balance);
      const speed=state.walletWithdrawSpeed||"24h";
      // NovaX fix (withdrawal UX v3): the payout IBAN always comes from the
      // editable Payout IBAN field on this card now -- prefilled from saved
      // bank details as a convenience default only, never locked to it. A
      // client can type or paste any valid PK IBAN here and it's sent
      // straight to request_wallet_withdrawal, which validates/normalizes it
      // server-side independently of whatever is saved.
      const ibanInput=document.getElementById("withdrawIbanInput");
      const iban=(ibanInput&&ibanInput.value||"").trim().toUpperCase();
      if(!amt||amt<1){ toast("Enter a valid amount.","error"); return; }
      if(amt>balance){ toast("Amount cannot be more than your available balance.","error"); return; }
      if(!speed){ toast("Select a payout speed.","error"); return; }
      const ibanErr=validateIbanValue(iban);
      if(ibanErr){ toast(ibanErr,"error"); return; }
      const btn=document.getElementById("confirmWithdrawBtn");
      // NovaX fix: this was calling a bare "sb" variable that only exists
      // inside the separate cloud-sync IIFE further down this file -- it is
      // NOT in scope here, so every click threw an immediate, uncaught
      // "sb is not defined" error right after the button was disabled and
      // set to "Submitting...", before the code ever reached .then()/.catch()
      // to reset it. That's why the button looked permanently stuck. The real
      // live client is window.__nvSb (set via `window.__nvSb=sb;` in that
      // cloud-sync block), so use that instead, and bail out cleanly with the
      // button re-enabled if it isn't ready yet instead of throwing.
      const sbClient=window.__nvSb;
      if(!sbClient){ toast("Cloud connection not ready yet, please try again in a moment.","error"); return; }
      __withdrawInFlight=true; state.__withdrawInFlight=true;
      if(btn){ btn.disabled=true; btn.textContent="Submitting..."; }
      // Calls the server first and only shows success (and only
      // records/refreshes locally) once the server has actually accepted and
      // created the withdrawal row -- never a false local-only "success".
      sbClient.rpc("request_wallet_withdrawal",{ p_amount:amt, p_iban:iban, p_speed:speed }).then(function(r){
        __withdrawInFlight=false; state.__withdrawInFlight=false;
        if(btn){ btn.disabled=false; btn.textContent="Request Withdrawal"; }
        if(r&&r.error){
          toast("Withdrawal request rejected: "+(r.error.message||"Server declined the request."),"error");
          renderClientWallet();
          return;
        }
        // Animations 5 + 6: the hand-off plays only here, after the server
        // has actually created the withdrawal row. It is a receipt for money
        // that has moved, never an optimistic flourish.
        try{ nvMoneySentAnimation(amt); }catch(e){}
        const d=r&&r.data;
        const fee=Number(d&&d.fee!=null?d.fee:nvPayoutFee(amt,speed));
        const net=Number(d&&d.net!=null?d.net:amt-fee);
        // Receipt drawer. Uses the server's fee/net when the RPC returned them
        // so the merchant is shown the figures that were actually recorded,
        // not the browser's preview of them.
        try{
          nvShowWithdrawDrawer({
            gross: amt, fee: fee, net: net,
            pct: walletFeePct(speed),
            speedLabel: walletSpeedLabel(speed),
            iban: (typeof maskIban==="function" ? maskIban(iban) : String(iban||"").slice(-6).padStart(10,"\u2022")),
            eta: (speed==="instant" ? "usually within 2-3 hours"
                 : speed==="12h" ? "within 12 hours" : "within 24 hours")
          });
        }catch(e){ console.warn("NovaX withdraw drawer", e); }
        // NovaX fix (rebuild integration mismatch): wallet_balance must never
        // be mutated in the browser -- request_wallet_withdrawal already
        // reserved this amount atomically on the server the moment it
        // succeeded above. We only record the withdrawal/payment-log entries
        // locally for instant UI feedback; the actual balance is always
        // re-read from the server truth immediately below (and again via
        // client_wallet_summary on next render), so a stale/duplicate local
        // subtraction can never happen.
        state.walletWithdrawals.unshift({ id:nextId("WDR",state.walletWithdrawals), _uuid:d&&d.id, clientId:c.id, amount:amt, fee, net, iban, speed, status:(d&&d.status)||"Pending admin payout", createdAt:`${new Date().toISOString().slice(0,10)} ${time()}` });
        state.paymentLogs.unshift({ id:nextId("PAY",state.paymentLogs), clientId:c.id, type:"Wallet withdrawal requested", amount:amt, status:`${money(net)} net after ${money(fee)} fee`, ref:walletSpeedLabel(speed) });
        // NovaX fix (withdrawal UX v2): clear the amount instead of leaving the
        // old (now stale) value in the box -- the next render refills it from
        // the fresh, reduced server balance once that arrives.
        const amtInputEl=document.getElementById("withdrawAmount"); if(amtInputEl) amtInputEl.value="";
        saveState();
        document.getElementById("walletDoneText").textContent=`${money(net)} will reach ${maskIban(iban)} via ${walletSpeedLabel(speed)} payout. NovaX fee ${money(fee)}. Status: Pending admin payout.`;
        /* A withdrawal just changed the real balance -- this is one of the
           few genuine reasons to re-read the wallet intelligence RPCs. */
        try{ nvLoadWalletIntelligence(true); }catch(e){}
        /* NovaX new (deferred bank details): signup never asks for an IBAN,
           and nothing blocks on it -- the merchant types it here, at the
           moment they actually want money. The only friction left was
           having to retype it every time, so offer to remember it once the
           payout has actually gone through. Never auto-saves: a one-off
           payout to someone else's account must stay a one-off. */
        try{ nvOfferSaveIban(iban); }catch(e){}
        // NovaX fix (confidence messaging): the modal already explains the
        // payout math, but a quick toast confirms what just happened and what
        // to expect next, matching the same pattern used elsewhere (booking,
        // store connect).
        toast(`Payout requested. Status: Pending admin payout.`,"success");
        // NovaX fix (rebuild integration mismatch): force the throttled
        // client_wallet_summary fetch to run again immediately (instead of
        // waiting out its normal throttle window) so the wallet card shows
        // the real server-reserved balance right away.
        state.__walletSummaryFetchedAt=0;
        openWalletDone(); render();
        // Pull the authoritative client row + wallet summary back from
        // Supabase right after so the UI reflects exactly what the atomic
        // RPC reserved server-side -- never a local guess.
        if(window.__novaxReloadClientData) window.__novaxReloadClientData();
      }).catch(function(e){
        __withdrawInFlight=false; state.__withdrawInFlight=false;
        if(btn){ btn.disabled=false; btn.textContent="Request Withdrawal"; }
        toast("Withdrawal request failed: "+(e&&e.message?e.message:"network error, please try again."),"error");
        renderClientWallet();
      });
    }
    // Backward-compatible alias in case anything else still calls the old name.
    function confirmWalletWithdraw(){ return requestWalletWithdrawal(); }
    function openWalletDone(){ const m=document.getElementById("walletDoneModal"); m.classList.add("show"); const t=m.querySelector(".tick"); if(t){ t.style.animation="none"; void t.offsetWidth; t.style.animation=""; } }
    function closeWalletDone(){ document.getElementById("walletDoneModal").classList.remove("show"); }

    /* Same marker table admin.html uses for its parcel-edit warning. Ported
       here because catching a wrong city BEFORE the AWB exists is worth far
       more than correcting it afterwards: the city sets the zone, the zone
       sets the price, and a Karachi address filed as Lahore is exactly how
       N3690090 went out mispriced and misrouted.

       "Johar Town" is Lahore and "Gulistan-e-Johar" is Karachi, one word
       apart, so matches resolve by earliest position then longest marker
       rather than list order. Spelling in real addresses is loose, hence the
       variants. It warns; it never blocks or overrides. */
    var NV_CITY_MARKERS_C = {
      Karachi: ["gulistan-e-jauhar","gulistan-e-johar","gulistan e johar","gulistan e jauhar",
                "gulstan-e-johar","gulstan e johar","gulishtan-e-johar","gulshan-e-johar",
                "johar block","jauhar block","gulshan-e-iqbal","gulshan e iqbal","gulshan block",
                "korangi","nazimabad","malir","landhi","orangi","liaquatabad","shah faisal","lyari",
                "saddar karachi","defence karachi","dha karachi","clifton","baldia","gadap","surjani",
                "north karachi","federal b area","f.b area","saadabad","karachi"],
      Lahore:   ["johar town","model town","gulberg lahore","dha lahore","defence lahore","iqbal town",
                 "wapda town","faisal town","garden town","township lahore","cantt lahore","lahore"],
      Islamabad:["islamabad","f-6","f-7","f-8","f-10","f-11","g-9","g-10","g-11","i-8","blue area"],
      Rawalpindi:["rawalpindi","satellite town","chaklala","westridge","pindi"]
    };
    function nvCityFromAddressC(addr){
      var a=String(addr||"").toLowerCase();
      if(!a.trim()) return null;
      var best=null,bestAt=Infinity,bestLen=0;
      Object.keys(NV_CITY_MARKERS_C).forEach(function(city){
        NV_CITY_MARKERS_C[city].forEach(function(m){
          var at=a.indexOf(m);
          if(at===-1) return;
          if(at<bestAt || (at===bestAt && m.length>bestLen)){ best=city; bestAt=at; bestLen=m.length; }
        });
      });
      return best;
    }
    function nvCheckBookingCity(){
      var warn=document.getElementById("bookingCityWarn");
      var citySel=document.getElementById("bookingCity");
      var addr=document.getElementById("bookingAddress");
      if(!warn||!citySel||!addr) return;
      var chosen=String(citySel.value||"").trim();
      var looks=nvCityFromAddressC(addr.value);
      if(looks && chosen && looks.toLowerCase()!==chosen.toLowerCase()){
        warn.style.display="";
        warn.innerHTML="<b>This address looks like "+escLabelText(looks)+", not "+escLabelText(chosen)+".</b> "+
          "The city sets the delivery zone and the price. Change it if the address is right \u2014 nothing is blocked.";
      } else {
        warn.style.display="none"; warn.innerHTML="";
      }
    }

    /* Booking */
    function updateZoneRateHint(){
      const el=document.getElementById("bookingCity");
      const hint=document.getElementById("bookingZoneHint");
      if(!el||!hint) return;
      const client=clientById(state.client&&state.client.id);
      const rc=normalizeRateCard(client&&client.rateCard, client&&client.rate);
      /* No placeholder used to exist here, so an untouched dropdown submitted
         "Lahore" and zoneForCity() happily priced it. With a real empty option
         the hint must say nothing rather than quietly quoting Zone B. */
      if(!String(el.value||"").trim()){ hint.textContent="Pick the destination city to see the rate."; return; }
      const zone=zoneForCity(el.value);
      const weightEl=document.getElementById("bookingWeight");
      const breakdown=bookingChargeBreakdown(rc, zone, weightEl?weightEl.value:"0.8 kg");
      hint.textContent=zoneLabel(zone)+" · base Rs "+fmt(breakdown.base)+" + additional Rs "+fmt(breakdown.additional)+" ("+breakdown.extraKg+" extra kg) = estimated total Rs "+fmt(breakdown.total)+(breakdown.overCap?" (over 5kg normal slab, confirm manually)":"");
    }
    /* ==================================================================
       NovaX distance pricing -- merchant side.

       Everything here is inert until the server says distance pricing is
       enabled (novax_pricing_config.distance_enabled). Until then the area
       picker stays hidden and updateZoneRateHint() shows the same flat
       estimate it always has, so a merchant sees no change whatsoever.

       Old parcels are never touched -- pricing only applies at booking.
       ================================================================== */
    var NV_GEO = { ready:false, enabled:false, areas:[], pickup:null, cfg:null, lastQuote:null };

    function nvGeoBoot(){
      var sb = window.__nvSb;
      if(!sb) return;
      Promise.resolve(sb.rpc("novax_pricing_config_get", {})).then(function(r){
        if(r && r.error){ return; }                       // migration not applied yet
        var cfg = Array.isArray(r.data) ? r.data[0] : r.data;
        if(!cfg) return;
        NV_GEO.cfg = cfg;
        NV_GEO.enabled = !!cfg.distance_enabled;
        return Promise.all([
          sb.rpc("novax_areas_list", { p_city:"Karachi" }),
          sb.rpc("client_pickup_locations_list", {})
        ]).then(function(res){
          NV_GEO.areas  = (res[0] && res[0].data) || [];
          var picks     = (res[1] && res[1].data) || [];
          NV_GEO.pickup = picks.filter(function(p){ return p.is_default; })[0] || picks[0] || null;
          NV_GEO.ready  = true;
          try{ nvAreaWire(); nvGeoRenderAreas(); nvGeoRenderPickup(); updateZoneRateHint(); }catch(e){}
        });
      }).catch(function(){ /* stays disabled; flat pricing unaffected */ });
    }

    /* ==================================================================
       Area picker: a search box that FILTERS a real <select>.

       The select is the control. It is always in the DOM and always
       openable, so a merchant can ignore the search entirely and just pick
       from the list -- which is what a native control on a phone does best.
       The search only narrows it, matching the area NAME and every ALIAS
       stored in novax_areas, so "dha 5", "defence phase 5" and "phase v"
       all find DHA Phase 5.

       Deliberately NOT a custom absolutely-positioned dropdown. The
       previous attempt was one, and its input carried id="nvAreaSearch"
       while a function of the same name existed -- element ids become
       properties of window, so the two collided.
       ================================================================== */

    /* ═══ 1. Derive the delivery area from the address already typed ═══════
       Delivery Address is mandatory, and novax_areas already carries the
       aliases that make "dha 5", "defence phase 5" and "phase v" all mean DHA
       Phase 5. So the 60-option picker does not need to be the merchant's
       first move -- it becomes the correction path when the address is
       ambiguous. Matching is deliberately conservative: a wrong auto-match
       prices a parcel wrongly, which is worse than asking.

       Scoring, longest wins:
         - the matched token must sit on a word boundary in the address
         - it must be at least 4 characters, so "5" or "dha" alone never wins
         - if two different areas tie on the best score it is ambiguous and we
           do NOT choose; the picker opens instead                            */
    function nvNormAddr(t){
      return " " + String(t||"").toLowerCase()
        .replace(/[^a-z0-9\s]/g," ")
        .replace(/\s+/g," ").trim() + " ";
    }
    function nvDetectArea(addressText){
      if(!addressText || !NV_GEO.areas || !NV_GEO.areas.length) return null;
      var hay = nvNormAddr(addressText);
      var best = null, bestLen = 0, tied = false;
      NV_GEO.areas.forEach(function(a){
        var cands = [String(a.name||"")].concat(a.aliases||[]);
        cands.forEach(function(c){
          var t = nvNormAddr(c).trim();
          if(t.length < 4) return;                       // too short to trust
          if(hay.indexOf(" " + t + " ") === -1) return;  // word-boundary only
          if(t.length > bestLen){ best = a; bestLen = t.length; tied = false; }
          else if(t.length === bestLen && best && best.id !== a.id){ tied = true; }
        });
      });
      if(!best || tied) return null;
      return { area: best, matchedLength: bestLen };
    }

    /* The confirm chip. Shows what we decided and makes changing it one tap,
       so the merchant is never quietly priced against an area they did not
       choose. */
    function nvRenderAreaChip(area, autoPicked){
      var host = document.getElementById("nvAreaAutoChip");
      if(!host) return;
      if(!area){ host.innerHTML=""; host.style.display="none"; return; }
      host.style.display="";
      host.innerHTML =
        '<span class="nv-areachip-dot"></span>' +
        '<span>Delivering to <b>' + escLabelText(area.name) + '</b>' +
        (autoPicked ? ' <i>&mdash; read from your address</i>' : '') + '</span>' +
        '<button type="button" class="nv-areachip-btn" id="nvAreaChipChange">Change</button>';
      var btn = document.getElementById("nvAreaChipChange");
      if(btn) btn.addEventListener("click", function(){
        var f = document.getElementById("bookingDestAreaField");
        if(f){ f.dataset.forceOpen="1"; f.style.display=""; }
        var q = document.getElementById("nvAreaFilter");
        if(q){ q.focus(); }
      });
    }

    /* Runs on address input. Never overwrites a choice the merchant made by
       hand -- only a slot that is empty or that we filled ourselves. */
    function nvAutoAreaFromAddress(){
      try{
        if(!nvGeoActive()) return;
        var sel = document.getElementById("bookingDestArea");
        var addr = (document.getElementById("bookingAddress")||{}).value || "";
        if(!sel) return;
        if(sel.value && sel.dataset.auto !== "1"){
          // Merchant chose it by hand -- authoritative. Keep the picker
          // reachable rather than leaving it collapsed from a previous
          // auto-detect.
          var fh=document.getElementById("bookingDestAreaField");
          if(fh && fh.dataset.forceOpen!=="1") fh.style.display="";
          return;
        }
        var hit = nvDetectArea(addr);
        var field = document.getElementById("bookingDestAreaField");
        if(hit){
          sel.value = hit.area.id;
          sel.dataset.auto = "1";
          nvRenderAreaChip(hit.area, true);
          // Collapse the picker unless the merchant asked to see it.
          if(field && field.dataset.forceOpen !== "1") field.style.display = "none";
          try{ nvRefreshQuote(); }catch(e){}
        } else {
          if(sel.dataset.auto === "1"){ sel.value=""; sel.dataset.auto=""; }
          nvRenderAreaChip(null,false);
          if(field) field.style.display = "";
        }
      }catch(e){ console.warn("NovaX area detect", e); }
    }


    /* ═══ Weight quick chips ═══════════════════════════════════════════════
       Weight is a price input -- it feeds bookingChargeBreakdown -- so the
       chips only ever FILL the field, never hide it. Whatever is typed still
       wins, and the active chip reflects the field rather than the other way
       round. */
    var NV_WEIGHT_CHIPS=["0.5 kg","0.8 kg","1 kg","1.5 kg","2 kg","3 kg"];
    function nvWeightNorm(v){
      var n=parseFloat(String(v||"").replace(/[^0-9.]/g,""));
      return isFinite(n)? n : null;
    }
    function nvBuildWeightChips(){
      var host=document.getElementById("nvWeightChips");
      if(!host || host.children.length) return;
      host.innerHTML=NV_WEIGHT_CHIPS.map(function(w){
        return '<button type="button" class="nv-wchip" data-w="'+w+'">'+w+'</button>';
      }).join("");
      host.addEventListener("click",function(ev){
        var b=ev.target.closest?ev.target.closest(".nv-wchip"):null;
        if(!b) return;
        var f=document.getElementById("bookingWeight");
        if(!f) return;
        f.value=b.dataset.w;
        nvSyncWeightChips();
        try{ updateZoneRateHint(); }catch(e){}
        try{ nvRefreshQuote(); }catch(e){}
      });
      nvSyncWeightChips();
    }
    /* ── 10 + 11: a booked parcel that is not moving ─────────────────────
       "New booked" reads like success, so a parcel can sit for days without
       anyone noticing. 29 were waiting when this was written, 10 of them past
       72 hours, and 26 of the 29 had no pickup request against them -- the
       pickup feature works, merchants were simply never prompted.

       So an uncollected parcel now ages visibly, and once it is old enough to
       matter it offers the one action that fixes it. */
    function nvHoursSinceBooked(p){
      try{
        var b = nvPkt(p && (p.bookedAt || p.booked_at || p.date));
        if(!b) return 0;
        return Math.max(0, (Date.now() - b.getTime()) / 3600000);
      }catch(e){ return 0; }
    }
    function nvAwaitingPickup(p){
      return !!p && String(p.status) === "New booked";
    }
    function nvPickupAgeState(p){
      if(!nvAwaitingPickup(p)) return null;
      var h = nvHoursSinceBooked(p);
      if(h < 18) return null;                       // normal same-day turnaround
      if(h < 48) return { level:"warn", label:"Waiting " + Math.round(h) + "h for pickup" };
      var d = Math.floor(h / 24);
      return { level:"bad", label:"Not collected in " + d + " day" + (d===1?"":"s") };
    }
    function nvHasPickupRequest(awb){
      try{ return activePickupAwbs().has(awb); }catch(e){ return false; }
    }
    /* The chip, plus a direct action when there is no request outstanding.
       Deliberately silent under 18 hours: a parcel booked this afternoon has
       not gone wrong, and crying wolf on every booking would train merchants
       to ignore the one that matters. */
    function nvPickupChipHtml(p){
      var st = nvPickupAgeState(p);
      if(!st) return "";
      var has = nvHasPickupRequest(p.awb);
      var a = escLabelText(p.awb);
      return '<div class="nv-age ' + st.level + '">' +
             '<span class="nv-age-t">' + escLabelText(st.label) + '</span>' +
             (has
               ? '<span class="nv-age-ok">Pickup requested</span>'
               : '<button type="button" class="nv-age-act" onclick="event.stopPropagation();nvQuickPickup(\'' + a + '\')">Request pickup</button>') +
             '</div>';
    }
    /* Sends the merchant to the pickup panel with this parcel already ticked,
       rather than asking them to find it in a list. It never submits on their
       behalf -- the address and time are theirs to confirm. */
    /* Finds the tab the pickup panel actually lives in rather than naming it.
       I hardcoded "newBooking" and it is in "awbLabel", so the button landed
       merchants on the booking form with nothing selected. Deriving it from
       the DOM means moving the panel between sections cannot break this
       again. */
    function nvPickupTabId(){
      try{
        var host=document.getElementById("pickupEligibleList");
        var view=host&&host.closest('[id^="client-"]');
        if(view) return view.id.replace(/^client-/,"");
      }catch(e){}
      return "awbLabel";
    }
    function nvQuickPickup(awb){
      try{
        showClientTab(nvPickupTabId());
        setTimeout(function(){
          var host = document.getElementById("pickupEligibleList");
          if(!host){ toast("Open Bulk Booking to request a pickup."); return; }
          var box = host.querySelector('.pickup-check[value="' + String(awb).replace(/"/g,'\\"') + '"]');
          if(box){ box.checked = true; }
          var card = box ? box.closest(".ops-card") : host;
          if(card && card.scrollIntoView) card.scrollIntoView({ behavior:"smooth", block:"center" });
          var addr = document.getElementById("pickupAddress");
          if(addr && !addr.value){
            try{ addr.value = (state.client && (state.client.address || "")) || ""; }catch(e){}
          }
          if(addr) addr.focus();
          toast(box ? (awb + " selected \u2014 confirm your pickup address below.")
                    : "Open Request Pickup under AWB Label to book a collection.");
        }, 420);
      }catch(e){ toast("Could not open the pickup form.", "error"); }
    }

    /* ── 12: one date the merchant can repeat to their customer ─────────── */
    function nvEtaHtml(p){
      if(!p) return "";
      var st = String(p.status || "");
      if(st === "Delivered" || st === "Return to shipper" || st === "Cancelled by client") return "";
      var e = nvExpectedBy(p);
      if(!e) return "";
      var overdueMs = Date.now() - e.date.getTime();
      var late = overdueMs > 0;
      /* Past a week, the promised date stops being useful and starts reading
         as an old receipt -- a parcel stuck since May printed "Was expected by
         Sat 2 May", which tells a merchant nothing they can act on. Say how
         far behind it is instead, which is the thing they would ask support. */
      if (overdueMs > 7 * 86400000) {
        var d = Math.floor(overdueMs / 86400000);
        return '<div class="nv-eta late">' + d + ' days past its expected delivery</div>';
      }
      return '<div class="nv-eta' + (late ? " late" : "") + '">' +
             (late ? "Was expected by " : "Expected by ") + escLabelText(e.text) + "</div>";
    }

    /* The parcels that make up "COD in flight": delivered, their COD not yet
       settled into an invoice. Same source the tile totals from, so the list
       and the number can never disagree. */
    function nvInFlightParcels(){
      try{
        return (state.parcels||[]).filter(function(p){
          return p && p.clientId===state.client.id && isDeliveredLedgerParcel(p) && !p.invoiceId;
        });
      }catch(e){ return []; }
    }
    function nvInFlightCount(){
      var n=nvInFlightParcels().length;
      return n+' parcel'+(n===1?'':'s');
    }
    function nvShowInFlight(){
      var rows=nvInFlightParcels();
      if(!rows.length){ toast("Nothing is waiting to be invoiced right now."); return; }
      var cod=rows.reduce(function(t,p){ return t+Number(p.cod||0); },0);
      var fee=rows.reduce(function(t,p){ return t+Number(p.fee||0); },0);
      var body=rows.slice(0,40).map(function(p){
        return '<tr><td><strong>'+escLabelText(p.awb)+'</strong><br><span class="footer-note">'+
               escLabelText(p.consignee||'')+' &middot; '+escLabelText(p.city||'')+'</span></td>'+
               '<td style="text-align:right">'+escLabelText(money(p.cod))+'</td>'+
               '<td style="text-align:right" class="footer-note">&minus;'+escLabelText(money(p.fee))+'</td></tr>';
      }).join("");
      nvOpenSheet("COD in flight",
        '<p class="footer-note" style="margin-top:0">These parcels are delivered and the cash is collected. '+
        'It reaches your wallet as soon as the invoice for them closes.</p>'+
        '<div class="wide-scroll"><table class="nv-sheet-tbl"><thead><tr><th>Parcel</th>'+
        '<th style="text-align:right">COD</th><th style="text-align:right">Charge</th></tr></thead>'+
        '<tbody>'+body+'</tbody></table></div>'+
        (rows.length>40?'<p class="footer-note">Showing the first 40 of '+rows.length+'.</p>':'')+
        '<div class="nv-sheet-sum"><span>'+rows.length+' parcel'+(rows.length===1?'':'s')+'</span>'+
        '<b>'+escLabelText(money(cod))+' collected &minus; '+escLabelText(money(fee))+
        ' charges = '+escLabelText(money(Math.max(0,cod-fee)))+' to you</b></div>');
    }

    /* A plain bottom sheet, reused by anything that needs to show a list
       without navigating away. Escape and the backdrop both close it, and
       focus returns to where it was. */
    function nvOpenSheet(title, html){
      nvCloseSheet();
      var prev=document.activeElement;
      var wrap=document.createElement("div");
      wrap.className="nv-sheet-ov"; wrap.id="nvSheet";
      wrap.innerHTML='<div class="nv-sheet" role="dialog" aria-modal="true" aria-label="'+escLabelText(title)+'">'+
        '<div class="nv-sheet-h"><b>'+escLabelText(title)+'</b>'+
        '<button type="button" class="nv-sheet-x" aria-label="Close">\u00d7</button></div>'+
        '<div class="nv-sheet-b">'+html+'</div></div>';
      document.body.appendChild(wrap);
      var close=function(){ nvCloseSheet(); try{ prev&&prev.focus&&prev.focus(); }catch(e){} };
      wrap.querySelector(".nv-sheet-x").addEventListener("click",close);
      wrap.addEventListener("click",function(e){ if(e.target===wrap) close(); });
      document.addEventListener("keydown",function esc(e){
        if(e.key==="Escape"){ close(); document.removeEventListener("keydown",esc); }
      });
      try{ wrap.querySelector(".nv-sheet-x").focus(); }catch(e){}
    }
    function nvCloseSheet(){ var el=document.getElementById("nvSheet"); if(el){ try{ el.remove(); }catch(e){} } }

    function nvSyncWeightChips(){
      var host=document.getElementById("nvWeightChips");
      var f=document.getElementById("bookingWeight");
      if(!host||!f) return;
      var cur=nvWeightNorm(f.value);
      [].forEach.call(host.children,function(b){
        b.classList.toggle("on", cur!==null && nvWeightNorm(b.dataset.w)===cur);
      });
    }

    /* ═══ COD drives payment mode ══════════════════════════════════════════
       A parcel with no cash to collect IS prepaid -- asking it as a separate
       question invited a mismatch between "COD 0" and "payment mode COD",
       which then flows into invoicing as a COD parcel that can never settle.
       The inference is applied on every COD edit and always STATED, never
       silent. The select stays fully editable for the replacement/free-
       delivery case. */
    function nvSyncPaymentMode(){
      try{
        var cod=document.getElementById("bookingCod");
        var mode=document.getElementById("bookingPaymentMode");
        var note=document.getElementById("nvPayModeNote");
        if(!cod||!mode) return;
        var raw=String(cod.value||"").trim();
        if(raw===""){ if(note){ note.style.display="none"; } return; }
        var n=Number(raw);
        if(!isFinite(n)) return;
        var wantPrepaid = n===0;
        var target = wantPrepaid ? "Non COD Prepaid" : "COD";
        /* The Payment question is gone from the form -- it was asking again
           for something the COD amount already decided, and two fields that
           can disagree is a rider collecting nothing on a Rs 2,500 parcel.
           This paints the derived answer where the select used to be; the
           select itself stays hidden and in sync, so every existing reader of
           #bookingPaymentMode is untouched. */
        var derived = document.getElementById("bookingPayMode");
        if(derived){
          derived.textContent = wantPrepaid ? "Prepaid \u2014 collect nothing" : "Cash on delivery";
          derived.setAttribute("data-mode", wantPrepaid ? "prepaid" : "cod");
        }
        if(mode.value!==target){
          mode.value=target;
          try{ mode.dispatchEvent(new Event("change")); }catch(e){}
        }
        if(note){
          note.style.display="";
          note.textContent = wantPrepaid
            ? "No cash to collect \u2014 set to Non COD Prepaid. Delivery charges will be billed to you."
            : "Cash on delivery \u2014 we collect " + money(n) + " from your customer.";
          note.classList.toggle("is-prepaid", wantPrepaid);
        }
        try{ updateZoneRateHint(); }catch(e){}
        try{ nvRefreshQuote(); }catch(e){}
      }catch(e){ console.warn("NovaX payment mode", e); }
    }
    window.nvSyncWeightChips=nvSyncWeightChips;
    window.nvSyncPaymentMode=nvSyncPaymentMode;

    function nvAreaMatches(area, q){
      if(!q) return true;
      var cands=[String(area.name||"")].concat(area.aliases||[]).map(function(x){ return String(x).toLowerCase(); });
      var words=q.split(/\s+/).filter(Boolean);
      return cands.some(function(c){
        if(c.indexOf(q)>-1) return true;
        return words.length>1 && words.every(function(w){ return c.indexOf(w)>-1; });
      });
    }
    function nvGeoRenderAreas(){
      var sel=document.getElementById("bookingDestArea");
      if(!sel) return;
      var filterEl=document.getElementById("nvAreaFilter");
      var q=String((filterEl&&filterEl.value)||"").trim().toLowerCase();
      var keep=sel.value;                       // preserve the current choice
      var list=NV_GEO.areas.filter(function(a){ return nvAreaMatches(a,q); });
      // Never strand the selected area outside the filtered list.
      if(keep && !list.some(function(a){ return a.id===keep; })){
        var cur=NV_GEO.areas.filter(function(a){ return a.id===keep; });
        list=cur.concat(list);
      }
      sel.innerHTML='<option value="">'+(list.length?"Select the area...":"No area matches that search")+'</option>'+
        list.map(function(a){
          var alias=(a.aliases||[]).filter(function(x){ return String(x).toLowerCase()!==String(a.name).toLowerCase(); }).slice(0,2).join(", ");
          return '<option value="'+escLabelText(a.id)+'">'+escLabelText(a.name)+(alias?" \u00b7 "+escLabelText(alias):"")+'</option>';
        }).join("");
      if(keep) sel.value=keep;
      var hint=document.getElementById("nvAreaHint");
      if(hint) hint.textContent = q
        ? (list.length+" area"+(list.length===1?"":"s")+" match \u201c"+q+"\u201d")
        : "Type to narrow the list, or just open it and choose.";
      nvGeoToggleAreaField();
    }
    (function nvWireWeightChips(){
      function go(){ try{ nvBuildWeightChips(); }catch(e){} }
      if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",go);
      else go();
    })();

    function nvAreaWire(){
      var filterEl=document.getElementById("nvAreaFilter");
      var sel=document.getElementById("bookingDestArea");
      if(sel && !sel.dataset.wired){
        sel.dataset.wired="1";
        sel.addEventListener("change", function(){
          // A hand-picked area is authoritative from then on.
          sel.dataset.auto="";
          var a=(NV_GEO.areas||[]).filter(function(x){ return x.id===sel.value; })[0];
          nvRenderAreaChip(a||null,false);
          nvRefreshQuote();
        });
      }
      var addrEl=document.getElementById("bookingAddress");
      if(addrEl && !addrEl.dataset.nvAreaWired){
        addrEl.dataset.nvAreaWired="1";
        var t=null;
        var run=function(){
          clearTimeout(t);
          t=setTimeout(function(){
            try{ nvAutoAreaFromAddress(); }catch(e){}
            /* Runs regardless of whether distance pricing is on --
               nvAutoAreaFromAddress() bails early for non-Karachi merchants,
               but a wrong city is a wrong city in every zone. */
            try{ nvCheckBookingCity(); }catch(e){}
          },320);
        };
        addrEl.addEventListener("input", run);
        addrEl.addEventListener("blur", function(){
          try{ nvAutoAreaFromAddress(); }catch(e){}
          try{ nvCheckBookingCity(); }catch(e){}
        });
        addrEl.addEventListener("paste", function(){ setTimeout(nvAutoAreaFromAddress,60); });
      }
      if(filterEl && !filterEl.dataset.wired){
        filterEl.dataset.wired="1";
        filterEl.addEventListener("input", function(){ nvGeoRenderAreas(); });
        // Enter picks the only remaining match -- the fast path for someone
        // who typed enough to be unambiguous.
        filterEl.addEventListener("keydown", function(e){
          if(e.key!=="Enter") return;
          e.preventDefault();
          var s2=document.getElementById("bookingDestArea");
          if(s2 && s2.options.length===2){ s2.selectedIndex=1; nvRefreshQuote(); }
          else if(s2){ s2.focus(); }
        });
      }
    }

    /* The picker only makes sense for Karachi with distance pricing on AND a
       pickup point mapped -- without an origin there is no distance to
       measure, so showing the field would just be a dead end. */
    /* PER-KILOMETRE PRICING IS RETIRED (2026-08-24). Every parcel is flat
       Rs 200, in every city, for every merchant.

       These two gates are the chokepoint the whole distance feature hangs off:
       the delivery-area picker, the pickup-area block, the live quote, the
       destAreaId argument that routes a booking to client_book_parcel_geo,
       and the separate area lookup in the bulk CSV importer all ask one of
       them first. Returning false and "flat" here makes every one of those
       paths dormant in a single place, which is a far smaller change to a
       live 18k-line file than deleting them one by one -- and it cannot leave
       one caller behind still sending area ids.

       The dead code below is deliberately left in place for now, unreachable.
       Same reasoning as the SQL side: nothing is dropped while bookings are
       live. */
    function nvGeoActive(){ return false; }

    function nvGeoActive__retired(){
      var cityEl = document.getElementById("bookingCity");
      var isKhi  = cityEl && String(cityEl.value||"").toLowerCase()==="karachi";
      /* NovaX fix (per-client pickup city): distance pricing measures road
         distance from the merchant's Karachi pickup point across the Karachi
         area map. For a merchant collecting from Lahore that origin does not
         exist, so the area picker must not appear and the quote must not run
         -- it would price a Lahore parcel off a Karachi pickup point. */
      var pickFrom = String((state.client&&state.client.pickupCity)||"Karachi").toLowerCase();
      /* The merchant's own choice is now the first gate. Distance pricing used
         to switch itself on the moment a pickup point existed, which is how the
         same route could quote two different prices on two different days. */
      if(nvPricingMode() !== "distance") return false;
      return !!(NV_GEO.ready && NV_GEO.enabled && isKhi && pickFrom==="karachi"
                && NV_GEO.pickup && NV_GEO.pickup.area_id);
    }

    /* 'flat' until the merchant says otherwise -- matches the column default,
       so an unanswered prompt bills exactly what it billed yesterday. */
    function nvPricingMode(){ return "flat"; }
    function nvGeoToggleAreaField(){
      var f = document.getElementById("bookingDestAreaField");
      if(!f) return;
      if(!nvGeoActive()){ f.style.display="none"; return; }
      // Stay collapsed while an auto-detected area is standing, unless the
      // merchant explicitly opened it via Change.
      var sel=document.getElementById("bookingDestArea");
      var autoStanding = sel && sel.dataset.auto==="1" && sel.value;
      f.style.display = (autoStanding && f.dataset.forceOpen!=="1") ? "none" : "";
    }

    function nvGeoRenderPickup(){
      var host = document.getElementById("nvPickupBanner");
      if(!host) return;
      if(!NV_GEO.ready || !NV_GEO.enabled){ host.innerHTML=""; return; }
      /* A merchant on flat CHOSE flat. The old banner told them they were
         "being charged the flat rate" as though it were a mistake, which is
         the exact confusion this feature exists to end. Say nothing. */
      if(nvPricingMode() !== "distance"){ host.innerHTML=""; return; }
      /* A merchant with no pickup point mapped fails the nvGeoActive() gate
         and is quietly charged the flat zone rate forever, with nothing on
         screen to say so. They are not choosing the fallback -- they do not
         know it exists. Say it plainly, and make fixing it one tap. */
      var pickFrom = String((state.client&&state.client.pickupCity)||"Karachi").toLowerCase();
      if(pickFrom==="karachi" && !(NV_GEO.pickup && NV_GEO.pickup.area_id)){
        /* They picked per-km, so we do not quietly hand them the flat rate --
           that silent substitution is the whole bug. Say the quote is blocked
           and make fixing it one tap. */
        host.innerHTML =
          '<div class="nv-nopickup">' +
            '<div class="nv-nopickup-h">We cannot price your parcels yet</div>' +
            '<p>You chose per-kilometre pricing, which measures the real road distance from where we collect. We do not have your pickup point yet, so there is no distance to price from &mdash; and we will not put you on the flat rate without asking. Set it once and your quotes start working.</p>' +
            '<button type="button" class="action-btn" id="nvSetPickupNow">Set my pickup point</button>' +
          '</div>';
        var b=document.getElementById("nvSetPickupNow");
        if(b) b.addEventListener("click", function(){
          try{ nvOpenPickupSetup(); }catch(e){ console.warn("NovaX pickup setup", e); }
        });
        return;
      }
      if(NV_GEO.pickup && NV_GEO.pickup.area_id){
        host.innerHTML = '<div class="footer-note" style="background:#eafff5;border:1px solid #cfeee0;border-radius:var(--r-md);padding:8px 11px;margin-bottom:10px">'+
          'Pricing distance from your pickup point: <b>'+escLabelText(NV_GEO.pickup.area_name||NV_GEO.pickup.label)+'</b>'+
          ' &middot; <a href="#" onclick="nvOpenPickupSetup();return false;" style="color:var(--nvu-accent);font-weight:700">change</a></div>';
      } else {
        host.innerHTML = '<div class="footer-note" style="background:var(--nvu-warn-bg);border:1px solid var(--nvu-warn-ln);color:var(--nvu-warn-fg);border-radius:var(--r-md);padding:9px 12px;margin-bottom:10px">'+
          '<b>Set your pickup area</b> to unlock per-kilometre pricing &mdash; you will only pay for the distance actually covered. '+
          '<a href="#" onclick="nvOpenPickupSetup();return false;" style="color:var(--nvu-warn-fg);font-weight:800;text-decoration:underline">Set it now</a></div>';
      }
    }

    function nvOpenPickupSetup(){
      var m = document.getElementById("nvPickupModal");
      if(!m) return;
      var sel = document.getElementById("nvPickupArea");
      if(sel){
        sel.innerHTML = '<option value="">Select your pickup area...</option>' +
          NV_GEO.areas.map(function(a){
            var on = NV_GEO.pickup && NV_GEO.pickup.area_id===a.id ? " selected" : "";
            return '<option value="'+escLabelText(a.id)+'"'+on+'>'+escLabelText(a.name)+'</option>';
          }).join("");
      }
      var lbl = document.getElementById("nvPickupLabel");
      var adr = document.getElementById("nvPickupAddress");
      if(lbl) lbl.value = (NV_GEO.pickup && NV_GEO.pickup.label) || "Main pickup";
      if(adr) adr.value = (NV_GEO.pickup && NV_GEO.pickup.address) || "";
      m.classList.add("show");
    }
    function nvClosePickupSetup(){
      var m=document.getElementById("nvPickupModal"); if(m) m.classList.remove("show");
    }
    function nvSavePickupSetup(){
      var sb=window.__nvSb; if(!sb){ toast("Not connected.","error"); return; }
      var areaId=(document.getElementById("nvPickupArea")||{}).value||"";
      if(!areaId){ toast("Choose your pickup area first.","error"); return; }
      var btn=document.getElementById("nvPickupSaveBtn");
      if(btn){ btn.disabled=true; btn.textContent="Saving..."; }
      sb.rpc("client_pickup_location_save",{
        p_id: (NV_GEO.pickup && NV_GEO.pickup.id) || null,
        p_label: ((document.getElementById("nvPickupLabel")||{}).value||"Main pickup"),
        p_address: ((document.getElementById("nvPickupAddress")||{}).value||""),
        p_city: "Karachi", p_area_id: areaId, p_lat: null, p_lng: null, p_default: true
      }).then(function(r){
        if(btn){ btn.disabled=false; btn.textContent="Save pickup point"; }
        if(r && r.error){ toast("Could not save: "+r.error.message,"error"); return; }
        nvClosePickupSetup();
        toast("Pickup point saved. Distance pricing is now active on your bookings.","success");
        nvGeoBoot();
      }).catch(function(){ if(btn){ btn.disabled=false; btn.textContent="Save pickup point"; } toast("Could not save pickup point.","error"); });
    }

    /* Live quote. Debounced -- this fires on every keystroke in the weight
       field. Failure is silent and simply leaves the flat estimate showing. */
    var _nvQuoteT=null;
    function nvRefreshQuote(){
      nvGeoToggleAreaField();
      if(_nvQuoteT) clearTimeout(_nvQuoteT);
      _nvQuoteT=setTimeout(nvDoQuote, 250);
    }
    /* NovaX motion: count a money figure up to its new value. Always lands
       on the exact target in the final frame, and bails out entirely under
       prefers-reduced-motion or if the element vanishes mid-tween (a
       re-render can replace the hint while this is running). */
    /* ═══ AWB print reveal ══════════════════════════════════════════════
       index.html already had the best animation in this codebase: at signup
       it prints a thermal AWB label out of a slot, types the details on,
       draws the barcode and lands a READY stamp -- for a label that is
       entirely fake. The real emotional peak of this product is the moment a
       merchant's parcel actually becomes real and gets its AWB, and that
       moment had no motion at all beyond a toast.

       Same idea, real data: the merchant's real AWB, real consignee, real
       destination, and a real Code128 barcode from nv-codegen.js (the same
       generator the printed label uses, so what animates is what prints).

       Deliberately non-blocking: it is an overlay that dismisses on click or
       after ~3.4s, the booking has ALREADY succeeded before this runs, and
       every part is wrapped so a failure here can never affect the booking.
       Skipped entirely under prefers-reduced-motion. */
    /* onDone fires when the label animation has finished and cleared the
       screen. Everything that used to render on top of it -- the what-next
       card, the autopilot nudge -- now waits for this instead of covering it.
       Called on EVERY booking, not just the first. */
    function nvAwbReveal(awb, consignee, city, cod, onDone){
      var done=false;
      function finish(){ if(done) return; done=true; try{ if(onDone) onDone(); }catch(e){} }
      try{
        if(!awb){ finish(); return; }
        if(matchMedia("(prefers-reduced-motion: reduce)").matches){ finish(); return; }
        // A second booking while one reveal is still on screen: retire the old
        // one immediately so the new parcel gets its own animation rather than
        // being silently skipped.
        var prev=document.getElementById("nvAwbReveal");
        if(prev){
          // Settle the outgoing reveal's callback before discarding it,
          // otherwise a merchant who books twice quickly never sees the first
          // parcel's next-step card -- it would wait on a promise nothing ever
          // keeps.
          try{ if(typeof window.__nvRevealFinish==="function") window.__nvRevealFinish(); }catch(e){}
          if(prev.parentNode) prev.parentNode.removeChild(prev);
        }
        window.__nvRevealFinish=finish;
        var bar=""; try{ bar=barcodeUrl(awb)||""; }catch(e){}
        var ov=document.createElement("div");
        ov.id="nvAwbReveal";
        ov.innerHTML=
          '<div class="nvar-stage">'+
            '<div class="nvar-slot"><i></i></div>'+
            '<div class="nvar-label">'+
              '<div class="nvar-top"><b>NovaX</b><span>COD</span></div>'+
              '<div class="nvar-k">TRACKING / AWB</div>'+
              '<div class="nvar-awb"></div>'+
              '<div class="nvar-row">'+
                '<div><div class="nvar-k">TO</div><div class="nvar-v nvar-to"></div></div>'+
                '<div><div class="nvar-k">CITY</div><div class="nvar-v nvar-city"></div></div>'+
              '</div>'+
              '<div class="nvar-k" style="margin-top:9px">COD TO COLLECT</div>'+
              '<div class="nvar-cod"></div>'+
              (bar?'<img class="nvar-bar" alt="" src="'+bar+'">':'')+
              '<div class="nvar-stamp">BOOKED</div>'+
            '</div>'+
            '<div class="nvar-cap">Printing your AWB…</div>'+
          '</div>';
        document.body.appendChild(ov);
        var lab=ov.querySelector(".nvar-label");
        var cap=ov.querySelector(".nvar-cap");
        var slot=ov.querySelector(".nvar-slot");
        var timers=[];
        function at(fn,ms){ timers.push(setTimeout(fn,ms)); }
        function type(el,txt,speed){
          if(!el) return; var i=0; el.textContent="";
          (function tick(){ el.textContent=String(txt).slice(0,++i); if(i<String(txt).length) at(tick,speed); })();
        }
        function close(){
          timers.forEach(clearTimeout);
          ov.classList.add("out");
          setTimeout(function(){ if(ov.parentNode) ov.parentNode.removeChild(ov); finish(); },320);
        }
        ov.addEventListener("click",close);
        requestAnimationFrame(function(){ ov.classList.add("on"); });
        at(function(){ if(slot) slot.classList.add("hot"); if(lab) lab.classList.add("out-of-slot"); },120);
        at(function(){ type(ov.querySelector(".nvar-awb"),awb,34); },560);
        at(function(){
          var t=ov.querySelector(".nvar-to"); if(t) t.textContent=String(consignee||"").slice(0,22);
          var c=ov.querySelector(".nvar-city"); if(c) c.textContent=String(city||"").slice(0,18);
        },1020);
        at(function(){
          var m=ov.querySelector(".nvar-cod");
          if(m) m.textContent=(Number(cod)>0?money(Number(cod)):"Prepaid");
        },1240);
        at(function(){ var b=ov.querySelector(".nvar-bar"); if(b) b.classList.add("drawn"); if(cap) cap.textContent="Ready to print"; },1450);
        at(function(){ if(slot) slot.classList.remove("hot"); var st=ov.querySelector(".nvar-stamp"); if(st) st.classList.add("on"); },1900);
        at(close,3400);
      }catch(e){ /* never let a flourish break a completed booking */ finish(); }
    }

    function nvTweenFee(el, from, to){
      if(!el) return;
      var target=Number(to)||0;
      if(matchMedia("(prefers-reduced-motion: reduce)").matches){ el.textContent=fmt(target); return; }
      var start=Number(from)||0;
      if(start===target){ el.textContent=fmt(target); return; }
      var t0=null, dur=420;
      function step(ts){
        if(!el.isConnected) return;
        if(t0===null) t0=ts;
        var k=Math.min(1,(ts-t0)/dur);
        var e=1-Math.pow(1-k,3);
        el.textContent = k<1 ? fmt(Math.round(start+(target-start)*e)) : fmt(target);
        if(k<1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    function nvDoQuote(){
      var sb=window.__nvSb;
      var hint=document.getElementById("bookingZoneHint");
      if(!sb || !hint) return;
      if(!nvGeoActive()){ try{ updateZoneRateHint(); }catch(e){} return; }
      var destId=(document.getElementById("bookingDestArea")||{}).value||"";
      if(!destId){ try{ updateZoneRateHint(); }catch(e){} return; }
      var weight=((document.getElementById("bookingWeight")||{}).value||"0.8 kg");
      sb.rpc("novax_quote_booking",{
        p_dest_city:"Karachi", p_weight:weight,
        p_origin_area_id: NV_GEO.pickup.area_id, p_dest_area_id: destId
      }).then(function(r){
        if(r && r.error){ try{ updateZoneRateHint(); }catch(e){} return; }
        var q=r.data; if(!q){ return; }
        NV_GEO.lastQuote=q;
        if(String(q.mode)!=="distance"){ try{ updateZoneRateHint(); }catch(e){} return; }
        var flat=Number(q.flat_fee||0), fee=Number(q.fee||0), save=flat-fee;
        /* NovaX motion: the quote used to snap straight to its final number,
           which reads as a guess. Counting it up over ~420ms makes the
           distance calculation feel like it is actually happening. The final
           frame always writes the exact fee, so the displayed number can
           never end up rounded or stale. */
        var __prevFee = Number(NV_GEO.__shownFee||0);
        NV_GEO.__shownFee = fee;
        hint.innerHTML =
          '<span style="display:inline-block;background:#eafff5;border:1px solid #cfeee0;border-radius:var(--r-md);padding:7px 11px;margin-top:4px;color:var(--nvu-accent);font-weight:700">'+
            escLabelText(q.distance_km)+' km &middot; Rs <span data-nv-fee>'+fmt(fee)+'</span>'+
          '</span>'+
          '<div style="margin-top:5px;font-size:11.5px;color:#6b7d74">'+
            'Rs '+fmt(q.base)+' base (first '+escLabelText(q.included_km)+' km) + '+
            escLabelText(q.billable_km)+' km &times; Rs '+fmt(q.per_km)+
            (Number(q.weight_charge)>0 ? ' + Rs '+fmt(q.weight_charge)+' weight' : '')+
            (q.capped ? ' &middot; capped' : '')+
            (save>0 ? ' &middot; <b style="color:var(--nvu-accent)">Rs '+fmt(save)+' less than flat rate</b>' : '')+
          '</div>';
        try{ nvTweenFee(hint.querySelector("[data-nv-fee]"), __prevFee, fee); }catch(e){}
      }).catch(function(){ try{ updateZoneRateHint(); }catch(e){} });
    }

    function bookParcel(o={}){
      // NovaX fix (High #2): never fall back to the demo/default placeholder client id
      // id. If the account isn't linked/verified yet, stop and surface an
      // error instead of silently booking against the demo client.
      const clientId=o.clientId||(state.client&&state.client.id);
      if(!clientId||state.accountNotLinked||state.clientRecordMissing){ toast("We're preparing your workspace. Refresh or sign in again.","error"); return null; }
      const cod=o.cod!==undefined?Number(o.cod):3500+Math.round(Math.random()*11000);
      const client=clientById(clientId);
      const awb=nextAwbForClient(clientId);
      const bookedCity=o.city||["Lahore","Karachi","Islamabad","Rawalpindi"][Math.floor(Math.random()*4)];
      const bookedRc=normalizeRateCard(client&&client.rateCard, client&&client.rate);
      const bookedZone=zoneForCity(bookedCity);
      const bookedWeight=o.weight||"0.8 kg";
      const bookedCharge=bookingChargeBreakdown(bookedRc, bookedZone, bookedWeight);
      const bookedFee=(o.fee!==undefined&&o.fee!==null&&o.fee!=="")?Number(o.fee):bookedCharge.total;
      state.parcels.unshift({ awb, clientId, date:o.date||new Date().toISOString().slice(0,10), consignee:o.consignee||"New COD Order", city:bookedCity, cod, fee:bookedFee, phone:o.phone||"", pickupCity:o.pickupCity||"Karachi", service:o.service||"COD Standard", category:o.category||"", fragile:o.fragile||"No", weight:bookedWeight, paymentMode:o.paymentMode||"COD", orderId:o.orderId||"", referenceNo:o.referenceNo||o.reference||o.ref||"", address:o.address||"Address pending", status:"New booked", statusAgeHours:0, statusSince:new Date().toISOString(), stage:0, totalStages:STATUS_TAGS.length-1, rider:o.rider||"", branch:"Karachi Hub", risk:8, updated:time(), exception:"", source:o.source||"", steps:["New booked"], _syncPending:true, _syncFailed:false });
      state.paymentLogs.unshift({ id:nextId("PAY",state.paymentLogs), clientId, type:"COD expected", amount:cod, status:"Awaiting delivery", ref:awb });
      state.selectedAwb=awb; state.lastGeneratedAwb=awb; saveState();
      try{ render(); }catch(e){ console.error("Post-booking render failed", e); }
      return awb;
    }
    let __bookingInFlight=false;
    // NovaX fix: Create Booking now goes straight through the same
    // window.__novaxBookParcel Supabase RPC path bulk import already uses.
    // No local AWB/parcel row is created until Supabase actually confirms
    // the booking -- the old local bookParcel()+pollBookingConfirmation()
    // flow used to create a "reserved locally" AWB before the server had
    // accepted anything, which could desync from what Supabase actually has.
    async function quickBooking(){
      if(__bookingInFlight) return;
      /* bookingPaymentMode dropped from the required list: it is derived from
         the COD amount now, so it can never be blank and can never disagree
         with it. */
      const required=["bookingName","bookingPhone","bookingPickupCity","bookingCity","bookingCod","bookingService","bookingCategory","bookingFragile","bookingWeight","bookingAddress"];
      if(required.some(id=>!String(document.getElementById(id).value||"").trim())){ toast("All booking fields are mandatory before AWB creation.","error"); return; }
      let phone=document.getElementById("bookingPhone").value.replace(/\D/g,"");
      if(phone.length===10&&phone.startsWith("3")) phone="0"+phone;
      const consignee=document.getElementById("bookingName").value.trim();
      const cod=Number(document.getElementById("bookingCod").value || 0);
      const address=document.getElementById("bookingAddress").value.trim();
      // NovaX fix (High #2): never fall back to the demo/default placeholder client id
      // id. If the account isn't linked/verified yet, stop and surface an
      // error instead of silently booking against the demo client.
      const clientId=state.client&&state.client.id;
      if(!clientId||state.accountNotLinked||state.clientRecordMissing){ toast("We're preparing your workspace. Refresh or sign in again.","error"); return; }
      const preBookingCount=(state.parcels||[]).filter(p=>p.clientId===clientId).length;
      const dupeWindowMs=15000;
      const now=Date.now();
      const possibleDupe=(state.parcels||[]).find(p=>p.clientId===clientId && p.consignee===consignee && Number(p.cod)===cod && p.address===address && p.phone===phone && p.statusSince && (now-new Date(p.statusSince).getTime())<dupeWindowMs);
      if(possibleDupe){ toast(`Looks like a duplicate \u2014 ${possibleDupe.awb} was just booked for ${consignee} with the same details. Check the AWB tab before booking again.`,"error"); return; }

      const riskWarnEl=document.getElementById("nvRiskWarning");
      const riskInput={ phone:phone, address, cod:document.getElementById("bookingCod").value, city:document.getElementById("bookingCity").value, product:document.getElementById("bookingCategory").value.trim(), weight:document.getElementById("bookingWeight").value.trim(), recentDuplicate:false };
      const risk=checkBookingRisk(riskInput);
      if(risk.serious.length){
        if(riskWarnEl){ riskWarnEl.style.display="block"; riskWarnEl.style.color="#a1230e"; riskWarnEl.style.background="var(--nvu-bad-bg)"; riskWarnEl.style.borderColor="#f0b4ac"; riskWarnEl.textContent=risk.serious[0]; }
        toast(risk.serious[0],"error");
        return;
      }
      if(risk.minor.length){
        if(riskWarnEl){ riskWarnEl.style.display="block"; riskWarnEl.style.color="#a15c00"; riskWarnEl.style.background="var(--nvu-warn-bg)"; riskWarnEl.style.borderColor="#f0d6a0"; riskWarnEl.textContent=risk.minor[0]; }
      } else if(riskWarnEl){ riskWarnEl.style.display="none"; }

      __bookingInFlight=true;
      const btn=document.getElementById("quickBookingBtn");
      const oldBtnText=btn?btn.textContent:"";
      if(btn){ btn.disabled=true; btn.textContent="Creating booking..."; }
      const confirmLine=document.getElementById("bookingConfirmLine");
      if(confirmLine){ confirmLine.textContent="Sending booking to NovaX server..."; confirmLine.style.display="block"; confirmLine.style.color=""; }
      try{
        if(!window.__novaxBookParcel){ throw new Error("Booking service is unavailable. Please refresh and try again."); }
        const mapped=await window.__novaxBookParcel({ consignee, city:document.getElementById("bookingCity").value, cod, phone:phone, pickupCity:document.getElementById("bookingPickupCity").value, service:document.getElementById("bookingService").value, category:document.getElementById("bookingCategory").value, fragile:document.getElementById("bookingFragile").value, weight:document.getElementById("bookingWeight").value.trim(), paymentMode:document.getElementById("bookingPaymentMode").value, address, orderId:(document.getElementById("bookingOrderId")||{}).value||"", allowOpen:((document.getElementById("bookingAllowOpen")||{}).value==="Yes"?"Yes":"No"),
          /* Only ever send an area when distance pricing is genuinely active
             for this parcel. The select keeps its value when the field hides,
             so switching Karachi -> Lahore after choosing an area would
             otherwise post a Karachi area id on a Lahore booking. Pre-existing
             hole; auto-detection would have made it far easier to hit. */
          destAreaId:((typeof nvGeoActive==="function" && nvGeoActive())
            ? ((document.getElementById("bookingDestArea")||{}).value||null)
            : null) });
        const awb=mapped&&mapped.awb;
        /* Captured BEFORE resetBookingForm() runs. That function sets every
           select back to index 0 -- which used to land on "Lahore" but now
           lands on the blank "Select destination city..." placeholder added
           to stop the dropdown silently defaulting. Reading the city AFTER
           the reset (as this used to) fed the just-booked parcel's own AWB
           reveal an empty city instead of the one it was actually booked to. */
        const revealCity=document.getElementById("bookingCity").value;
        resetBookingForm();
        if(riskWarnEl){ riskWarnEl.style.display="none"; }
        if(confirmLine){ confirmLine.textContent=`Synced to NovaX. AWB ${awb} is ready to print.`; confirmLine.style.color=""; confirmLine.style.display="block"; }
        // NovaX fix (confidence messaging): explicit "synced" + "ready to
        // print" pairing matches the two things the client actually needs to
        // know once the server has confirmed the booking.
        nvClearBookingDraft(); toast(`${awb} synced to NovaX. AWB ready to print.`,"success");
        /* NovaX motion: the parcel just became real -- print its label. Runs
           after the booking has already succeeded and cannot affect it. */
        // The label animation owns the screen first; the what-next card and
        // the autopilot nudge queue behind it instead of landing on top.
        var __afterReveal=function(){
          if(preBookingCount===0 && localStorage.getItem("novaxFirstBookingCompleted")!=="1"){
            try{ localStorage.setItem("novaxFirstBookingCompleted","1"); }catch(e){}
            if(window.novaxShowFirstBookingSuccess) window.novaxShowFirstBookingSuccess(awb);
            if(window.novaxAutopilotSay) window.novaxAutopilotSay("Great. Your first parcel is booked. I\u2019ll watch it from pickup to delivery and tell you if anything needs attention.",[
              { label:"Track Journey", kind:"local", type:"show_journey_awb", awb:awb },
              { label:"Print AWB", kind:"local", type:"go_awb_label" }
            ]);
          } else if(window.innerWidth<=760 && window.novaxShowFirstBookingSuccess){
            window.novaxShowFirstBookingSuccess(awb);
          }
        };
        try{
          nvAwbReveal(awb, consignee, revealCity, cod, __afterReveal);
        }catch(e){ __afterReveal(); }
      }catch(e){
        console.error("Booking failed", e);
        const msg=(e&&e.message)?e.message:"Booking could not be completed. Please try again.";
        toast(msg,"error");
        if(confirmLine){ confirmLine.textContent=msg; confirmLine.style.color="#c0392b"; confirmLine.style.display="block"; }
      }finally{
        __bookingInFlight=false; if(btn){ btn.disabled=false; btn.textContent=oldBtnText||"Create Booking"; }
      }
    }
    function pollBookingConfirmation(awb, isFirstParcel, tries){
      tries=tries||0;
      const p=(state.parcels||[]).find(x=>x.awb===awb);
      const confirmLine=document.getElementById("bookingConfirmLine");
      if(!p) return;
      if(p._syncFailed){
        toast("Booking was not accepted. Please fix the highlighted issue and try again.","error");
        if(confirmLine){ confirmLine.textContent="Booking was not accepted. Please fix the highlighted issue and try again."; confirmLine.style.color="#c0392b"; confirmLine.style.display="block"; }
        return;
      }
      if(p._uuid){
        if(confirmLine){ confirmLine.textContent="Synced to NovaX."; confirmLine.style.color=""; confirmLine.style.display="block"; }
        setTimeout(()=>{ if(confirmLine) confirmLine.textContent=`Synced to NovaX. AWB ${awb} is ready to print.`; },500);
        // NovaX fix (confidence messaging): explicit "synced" + "ready to
        // print" pairing matches the two things the client actually needs to
        // know once the server has confirmed the booking.
        nvClearBookingDraft(); toast(`${awb} synced to NovaX. AWB ready to print.`,"success");
        if(isFirstParcel && localStorage.getItem("novaxFirstBookingCompleted")!=="1"){
          try{ localStorage.setItem("novaxFirstBookingCompleted","1"); }catch(e){}
          if(window.novaxShowFirstBookingSuccess) window.novaxShowFirstBookingSuccess(awb);
          if(window.novaxAutopilotSay) window.novaxAutopilotSay("Great. Your first parcel is booked. I\u2019ll watch it from pickup to delivery and tell you if anything needs attention.",[
            { label:"Track Journey", kind:"local", type:"show_journey_awb", awb:awb },
            { label:"Print AWB", kind:"local", type:"go_awb_label" }
          ]);
        } else if(window.innerWidth<=760 && window.novaxShowFirstBookingSuccess){
          window.novaxShowFirstBookingSuccess(awb);
        }
        return;
      }
      if(tries<20){ setTimeout(()=>{ pollBookingConfirmation(awb, isFirstParcel, tries+1); },700); }
      else if(isFirstParcel){
        if(confirmLine){ confirmLine.textContent=`Still syncing ${awb} with the server. I\u2019ll keep watching in the background.`; }
        setTimeout(()=>{ pollBookingConfirmation(awb, isFirstParcel, tries+1); },5000);
      }
      else if(confirmLine){ confirmLine.textContent=`Still syncing ${awb} with the server. Check the AWB tab shortly.`; }
    }

    function resetBookingForm(){
      ["bookingName","bookingPhone","bookingCod","bookingCategory","bookingAddress"].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=""; });
      // COD was just cleared, so the payment-mode note no longer describes
      // anything; hide it and re-sync the weight chips to the reset value.
      try{
        const pn=document.getElementById("nvPayModeNote"); if(pn) pn.style.display="none";
        nvSyncWeightChips();
      }catch(e){}
      // Clear the detected area with the form, otherwise parcel two is priced
      // against parcel one's neighbourhood.
      try{
        // Clear the area ALWAYS, not only when we auto-detected it. The
        // address has just been wiped, so no area -- however it was chosen --
        // is still valid. Leaving a hand-picked one behind priced the next
        // parcel against the previous customer's neighbourhood.
        const da=document.getElementById("bookingDestArea");
        if(da){ da.value=""; da.dataset.auto=""; }
        const fld=document.getElementById("bookingDestAreaField");
        if(fld) fld.dataset.forceOpen="";
        if(typeof nvRenderAreaChip==="function") nvRenderAreaChip(null,false);
        if(typeof nvGeoToggleAreaField==="function") nvGeoToggleAreaField();
      }catch(e){}
      const weightEl=document.getElementById("bookingWeight"); if(weightEl) weightEl.value="0.8 kg";
      ["bookingPickupCity","bookingCity","bookingService","bookingCategory","bookingFragile","bookingPaymentMode"].forEach(id=>{ const el=document.getElementById(id); if(el&&el.tagName==="SELECT") el.selectedIndex=0; });
      try{ applyPickupCity(); }catch(e){}   // keep the merchant's real pickup city after a reset
      document.querySelectorAll("#client-newBooking .field.nvfield-missing").forEach(f=>f.classList.remove("nvfield-missing"));
      try{ updateZoneRateHint(); }catch(e){}
      try{ var cw=document.getElementById("bookingCityWarn"); if(cw){ cw.style.display="none"; cw.innerHTML=""; } }catch(e){}
    }

    /* ===== Paste Order To Book (item 3) ===== */
    var NV_CITY_LIST=["lahore","karachi","islamabad","rawalpindi"];
    function nvFindCity(text){
      var low=text.toLowerCase();
      for(var i=0;i<NV_CITY_LIST.length;i++){ if(low.indexOf(NV_CITY_LIST[i])>-1) return NV_CITY_LIST[i][0].toUpperCase()+NV_CITY_LIST[i].slice(1); }
      return "";
    }
    function parsePastedOrder(raw){
      var text=String(raw||"").replace(/\r/g," ").trim();
      var out={ name:"", phone:"", city:"", cod:"", product:"", address:"" };
      if(!text) return out;

      /* BUG: the old pattern was /(\+?92[\s-]?)?0?3\d{2}[\s-]?\d{7}/ -- it
         allowed ONE separator after the operator code and then demanded seven
         contiguous digits, so "0311 332 3923", the way people actually write
         a number, matched nothing at all and the field came back blank. And
         digits.slice(-11) truncated from the wrong end, so "+923113323923"
         became "23113323923". Six of seven real formats failed.

         Now: pull every plausible run of digits and separators out of the
         message and hand each to nvNormalizePkPhone, which is the one place
         in this file that knows what a Pakistani mobile looks like. */
      var phoneCandidates=text.match(/(?:\+|00)?[\d][\d\s\-().]{7,22}\d/g)||[];
      for(var pi=0;pi<phoneCandidates.length;pi++){
        var norm=nvNormalizePkPhone(phoneCandidates[pi]);
        if(norm){ out.phone=norm; break; }
      }

      out.city=nvFindCity(text);

      var codMatch=text.match(/(?:cod|amount|rs\.?|price)\D{0,4}(\d{2,6})/i);
      if(codMatch){ out.cod=codMatch[1]; }
      else{
        var loneNum=text.match(/\b(\d{3,6})\b/);
        if(loneNum && loneNum[1]!==out.phone) out.cod=loneNum[1];
      }

      var nameLabel=text.match(/name\s*[:\-]\s*([A-Za-z ]{2,30})/i);
      if(nameLabel){ out.name=nameLabel[1].trim(); }
      else{
        var leadWords=text.match(/^([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,2})/);
        if(leadWords) out.name=leadWords[1].trim();
      }

      var addrLabel=text.match(/address\s*[:\-]\s*([^,]{4,80})/i);
      if(addrLabel){ out.address=addrLabel[1].trim(); }
      else{
        var addrClue=text.match(/([A-Za-z0-9 ]{0,20}(?:house|block|phase|street|sector|road|colony|town|society)[A-Za-z0-9 ]{0,25})/i);
        if(addrClue) out.address=addrClue[1].trim();
      }

      var prodLabel=text.match(/product\s*[:\-]\s*([^,]{2,60})/i);
      if(prodLabel){ out.product=prodLabel[1].trim(); }
      else{
        var leftover=text;
        [out.name,out.phone,out.city,out.cod,out.address].forEach(function(v){ if(v) leftover=leftover.replace(v," "); });
        leftover=leftover.replace(/\b(cod|amount|rs\.?|price|name|phone|city|address|product)\b/gi," ").replace(/[:,]/g," ").replace(/\s+/g," ").trim();
        if(leftover.length>2 && leftover.length<60) out.product=leftover;
      }
      return out;
    }
    function applyPastedOrder(){
      var input=document.getElementById("nvPasteInput");
      var summary=document.getElementById("nvPasteSummary");
      if(!input||!summary) return;
      var parsed=parsePastedOrder(input.value);
      var filled=[], missing=[];
      document.querySelectorAll("#client-newBooking .field.nvfield-missing").forEach(function(f){ f.classList.remove("nvfield-missing"); });

      function setField(id,val,label){
        var el=document.getElementById(id);
        if(!el) return;
        if(val){ el.value=val; filled.push(label); }
        else{ missing.push(label); var field=el.closest(".field"); if(field) field.classList.add("nvfield-missing"); }
      }
      setField("bookingName",parsed.name,"name");
      setField("bookingPhone",parsed.phone,"phone");
      setField("bookingCod",parsed.cod,"COD amount");
      setField("bookingCategory",parsed.product,"product");
      setField("bookingAddress",parsed.address,"address");

      if(parsed.city){
        var citySel=document.getElementById("bookingCity");
        if(citySel){
          for(var i=0;i<citySel.options.length;i++){ if(citySel.options[i].text.toLowerCase()===parsed.city.toLowerCase()){ citySel.selectedIndex=i; break; } }
        }
        filled.push("city");
        try{ updateZoneRateHint(); }catch(e){}
      } else { missing.push("city"); }

      summary.style.display="block";
      var msg="I filled "+filled.length+" field"+(filled.length===1?"":"s")+".";
      if(missing.length){ msg+=" Please confirm "+missing.join(", ")+" before booking."; }
      else{ msg+=" Please double-check everything before booking."; }
      summary.textContent=msg;

      if(missing.length){
        var nvIdMap={name:"bookingName",phone:"bookingPhone","COD amount":"bookingCod",product:"bookingCategory",address:"bookingAddress",city:"bookingCity"};
        var nvFirstMissingId=null;
        for(var nvMi=0;nvMi<missing.length;nvMi++){ if(nvIdMap[missing[nvMi]]){ nvFirstMissingId=nvIdMap[missing[nvMi]]; break; } }
        if(nvFirstMissingId){
          setTimeout(function(){
            try{
              var nvEl=document.getElementById(nvFirstMissingId);
              if(nvEl){ nvEl.scrollIntoView({behavior:"smooth",block:"center"}); nvEl.focus({preventScroll:true}); }
            }catch(e){}
          },250);
        }
      }
    }

    /* ===== Booking Risk Check (item 4) ===== */
    function checkBookingRisk(o){
      var serious=[], minor=[];
      var phoneDigits=String(o.phone||"").replace(/\D/g,"");
      /* Normalise first, then validate. Booking used to demand a bare
         ^03\d{9}$, so "0311 332 3923", "+92 311 332 3923" and a pasted
         "+923113323923" -- all the same number, all how people actually write
         it -- were rejected outright. nvNormalizePkPhone is the one definition
         of a Pakistani mobile in this file; every entry point should agree
         with it, and now booking does. */
      var phoneNorm = nvNormalizePkPhone(phoneDigits);
      if(!phoneNorm){ serious.push("Phone number looks incomplete. Use 03XXXXXXXXX."); }
      else { phoneDigits = phoneNorm; }

      /* NovaX: address FORMAT checking removed entirely.
         It second-guessed the merchant about their own customer's address and
         blocked real bookings — Pakistani addresses legitimately come in forms
         no keyword list can cover. The address is still REQUIRED (the
         mandatory-fields check in quickBooking() rejects an empty one), it is
         simply no longer judged on length, wording or content. */

      var cod=Number(o.cod);
      if(o.cod===""||o.cod===null||o.cod===undefined||isNaN(cod)){ serious.push("COD amount is missing. Enter the amount to collect (or 0 for prepaid)."); }
      else if(cod>100000){ minor.push("COD amount looks unusually high. Please confirm this is correct."); }

      if(!nvFindCity(String(o.city||""))){ minor.push("City is not one of the recognized service cities. Please confirm delivery is available there."); }

      if(!String(o.product||"").trim()){ serious.push("Product details are missing. Add what is being shipped."); }

      var weight=String(o.weight||"").trim();
      if(!weight || !/\d/.test(weight)){ serious.push("Package weight looks invalid. Enter a weight like 0.8 kg."); }

      if(o.recentDuplicate){ minor.push("This looks similar to a booking made in the last few minutes. Please confirm it is not a duplicate."); }

      return { serious: serious, minor: minor };
    }

    // NovaX fix (CSV injection): csvEscape() only quoted values that already
    // contained a comma/quote/newline, so a leading = + - @ passed straight
    // through. It is now a thin alias over the single hardened csvCell()
    // helper, which every export path in this file shares.
    function csvEscape(value){ return csvCell(value); }
    function downloadBulkTemplate(){
      const rows=[
        ["consignee","phone","city","address","cod","weight","order_id","product","payment_mode"],
        ["Ahmed Customer","03113323923","Lahore","House 21 Main Market Lahore","2500","0.8 kg","ORDER-1001","Black hoodie size medium","COD"],
        ["Sara Customer","03112223344","Karachi","Block 6 PECHS Karachi","0","1 kg","ORDER-1002","Prepaid skincare parcel","Non COD Prepaid"]
      ];
      const csv="\ufeff"+rows.map(row=>row.map(csvEscape).join(",")).join("\r\n")+"\r\n";
      const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
      const a=document.createElement("a");
      a.href=url;
      a.download="NovaX-bulk-booking-template.csv";
      document.body.appendChild(a);
      a.click();
      setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },1000);
      toast("CSV format downloaded. Open it with Numbers, Excel, or Google Sheets.");
    }
    function parseCsv(text){
      const rows=[]; let row=[], cell="", q=false;
      for(let i=0;i<text.length;i++){
        const ch=text[i], next=text[i+1];
        if(ch==='"' && q && next==='"'){ cell+='"'; i++; continue; }
        if(ch==='"'){ q=!q; continue; }
        if(ch==="," && !q){ row.push(cell.trim()); cell=""; continue; }
        if((ch==="\n"||ch==="\r") && !q){ if(ch==="\r"&&next==="\n") i++; row.push(cell.trim()); if(row.some(Boolean)) rows.push(row); row=[]; cell=""; continue; }
        cell+=ch;
      }
      row.push(cell.trim()); if(row.some(Boolean)) rows.push(row);
      return rows;
    }
    // NovaX (Part 6, Client Order Import Polish): row-level CSV validation.
    // Every row gets its own ok/problems list (code + message + suggested
    // fix) instead of one flat error array, so the UI can show exactly which
    // rows are blocking the import and which are clean -- and "Import valid
    // rows only" can safely skip just the bad ones.
    function validateBulkRows(rows){
      const headers=(rows[0]||[]).map(h=>h.toLowerCase().trim());
      const required=["consignee","phone","city","address","cod","weight","order_id","product","payment_mode"];
      const missing=required.filter(h=>!headers.includes(h));
      if(missing.length) return { totalRows:0, missingColumns:missing, results:[] };
      const idx=name=>headers.indexOf(name);
      const get=(row,name)=>{ const j=idx(name); return j>-1?String(row[j]||"").trim():""; };
      const validCities=["Karachi","Lahore","Islamabad","Rawalpindi"];
      const existingOrderIds=new Set((state.parcels||[]).map(p=>p.orderId).filter(Boolean));
      const existingRefs=new Set((state.parcels||[]).map(p=>p.referenceNo).filter(Boolean));
      const dupeWindowMs=24*60*60*1000;
      const now=Date.now();
      const myClientId=state.client&&state.client.id;
      const orderIdSeen=new Map(), refSeen=new Map(), sigSeen=new Map();
      const dataRows=rows.slice(1).filter(row=>row.some(cell=>String(cell||"").trim()));
      const results=dataRows.map((row,i)=>{
        const line=i+2;
        const problems=[];
        const addProblem=(code,message,fix)=>problems.push({code,message,fix});
        const consignee=get(row,"consignee");
        const phoneRaw=get(row,"phone");
        const cityRaw=get(row,"city");
        const address=get(row,"address");
        const codRaw=get(row,"cod");
        const weightRaw=get(row,"weight");
        const orderId=get(row,"order_id");
        const product=get(row,"product");
        const paymentModeRaw=get(row,"payment_mode");
        const referenceNo=get(row,"reference")||get(row,"reference_no")||get(row,"customer_ref");
        const fragileRaw=get(row,"fragile");
        if(!consignee) addProblem("consignee","Consignee name is missing.","Add the receiver's full name.");
        // Normalize phone to 03xxxxxxxxx.
        let phone=phoneRaw.replace(/\D/g,"");
        if(phone.length===10&&phone.startsWith("3")) phone="0"+phone;
        if(phone.length===12&&phone.startsWith("92")) phone="0"+phone.slice(2);
        if(phone.length===11&&phone.startsWith("92")) phone="0"+phone.slice(2);
        const phoneValid=!!nvNormalizePkPhone(phone);
        if(!phoneRaw) addProblem("phone","Phone number is missing.","Add the consignee phone as 03xxxxxxxxx.");
        else if(!phoneValid) addProblem("phone",`Phone "${phoneRaw}" is not a valid Pakistani number.`,"Use format 03xxxxxxxxx (11 digits).");
        // Normalize city capitalization.
        const cityTrim=cityRaw.trim().replace(/\s+/g," ");
        const cityCap=cityTrim?cityTrim[0].toUpperCase()+cityTrim.slice(1).toLowerCase():"";
        const cityValid=validCities.includes(cityCap);
        if(!cityRaw) addProblem("city","City is missing.","Add one of: Karachi, Lahore, Islamabad, Rawalpindi.");
        else if(!cityValid) addProblem("city",`City "${cityRaw}" is not serviceable yet.`,"Use Karachi, Lahore, Islamabad, or Rawalpindi.");
        if(!address) addProblem("address","Delivery address is missing.","Add the full delivery address where the parcel is going.");
        if(!product) addProblem("product","Product/item details are missing.","Add a short item description.");
        // COD to number.
        const cod=codRaw===""?NaN:Number(codRaw);
        if(codRaw===""||Number.isNaN(cod)||cod<0) addProblem("cod",`COD "${codRaw}" is invalid.`,"Use a number 0 or higher (0 for prepaid).");
        // Weight to kg -- missing defaults to 0.8kg (matches booking-charge
        // default), only genuinely invalid text blocks the row.
        let weightKg=0.8;
        if(weightRaw){
          const wnum=parseFloat(String(weightRaw).toLowerCase().replace(/kg/g,"").trim());
          if(!isFinite(wnum)||wnum<=0) addProblem("weight",`Weight "${weightRaw}" is invalid.`,"Use a number like 0.8, 1kg, or 2.5 kg.");
          else weightKg=wnum;
        }
        const paymentMode=["COD","Non COD Prepaid"].includes(paymentModeRaw)?paymentModeRaw:(paymentModeRaw?paymentModeRaw:"COD");
        if(paymentModeRaw&&!(["COD","Non COD Prepaid"].includes(paymentModeRaw))) addProblem("payment_mode",`payment_mode "${paymentModeRaw}" is not recognized.`,"Use COD or Non COD Prepaid.");
        if(!orderId) addProblem("order_id","Order ID is missing.","Add a unique order_id for this row.");
        else {
          if(orderIdSeen.has(orderId)) addProblem("dup_order",`Duplicate order_id "${orderId}", also on row ${orderIdSeen.get(orderId)}.`,"Make sure every row has a unique order_id.");
          else if(existingOrderIds.has(orderId)) addProblem("dup_order",`order_id "${orderId}" was already booked previously.`,"This sheet may already be uploaded. Remove or change this row.");
          orderIdSeen.set(orderId,line);
        }
        if(referenceNo){
          if(refSeen.has(referenceNo)) addProblem("dup_ref",`Duplicate reference "${referenceNo}", also on row ${refSeen.get(referenceNo)}.`,"Reference numbers should be unique per order.");
          else if(existingRefs.has(referenceNo)) addProblem("dup_ref",`Reference "${referenceNo}" was already used previously.`,"This looks like a re-upload. Remove or change this row.");
          refSeen.set(referenceNo,line);
        }
        const sig=`${consignee}|${phone}|${address}|${cod}`;
        const dupeLineOfSig=sigSeen.get(sig);
        if(dupeLineOfSig) addProblem("dup_row",`Same consignee, phone, address and COD as row ${dupeLineOfSig} in this file.`,"Check for an accidental copy-pasted duplicate row.");
        sigSeen.set(sig,line);
        const possibleDupe=(state.parcels||[]).find(p=>p.clientId===myClientId&&p.consignee===consignee&&p.phone===(phoneValid?phone:phoneRaw)&&p.address===address&&Number(p.cod)===cod&&p.statusSince&&(now-new Date(p.statusSince).getTime())<dupeWindowMs);
        if(possibleDupe) addProblem("dup_row",`Already booked as ${possibleDupe.awb} recently with the same consignee/phone/address/COD.`,"This sheet may have already been uploaded.");
        const fragile=/^(yes|y|true|1)$/i.test(fragileRaw)?"Yes":"No";
        /* Distance pricing on bulk. Until now the CSV had no area column at
           all and client_book_parcel needs p_dest_area_id, so EVERY bulk row
           fell back to the flat zone rate by construction -- on the exact path
           merchants use for 10-20 parcels at a time.
           An optional "area" column wins if present; otherwise the area is read
           from the address with the same conservative matcher the single
           booking form uses. Karachi only, and only while the merchant's
           pickup point is mapped -- outside that there is no distance to
           measure and the flat rate is correct, not a fallback. */
        let destAreaId=null, areaName="", areaSource="";
        try{
          if(typeof nvGeoActive==="function" && nvGeoActive()
             && String(cityValid?cityCap:cityRaw).toLowerCase()==="karachi"){
            const explicit=(idx("area")>-1 ? String(get(row,"area")||"").trim() : "");
            if(explicit){
              const hit=(NV_GEO.areas||[]).filter(function(a){
                return typeof nvAreaMatches==="function" && nvAreaMatches(a, explicit.toLowerCase());
              })[0];
              if(hit){ destAreaId=hit.id; areaName=hit.name; areaSource="column"; }
            }
            if(!destAreaId){
              const det=(typeof nvDetectArea==="function") ? nvDetectArea(address) : null;
              if(det){ destAreaId=det.area.id; areaName=det.area.name; areaSource="address"; }
            }
          }
        }catch(e){ /* pricing never blocks an import */ }
        const record={ consignee, phone:phoneValid?phone:phoneRaw, city:cityValid?cityCap:cityRaw, address, cod:Number.isFinite(cod)?cod:0, weight:weightKg+" kg", orderId, product, paymentMode, referenceNo, fragile, destAreaId, areaName, areaSource };
        return { line, ok:problems.length===0, problems, record };
      });
      return { totalRows:results.length, results };
    }
    function bulkProblemCount(parsed,code){ return (parsed.results||[]).reduce((n,r)=>n+(r.problems.some(p=>p.code===code)?1:0),0); }
    function renderBulkValidation(parsed){
      const el=document.getElementById("bulkValidationList");
      if(!el) return;
      if(!parsed){ el.innerHTML=`<div class="ops-card"><strong>Waiting for CSV</strong><p>Download the template, fill it, and upload it here.</p></div>`; return; }
      if(parsed.missingColumns&&parsed.missingColumns.length){
        el.innerHTML=`<div class="ops-card alert-row"><strong>Blocked</strong><p>Missing required column(s): ${escLabelText(parsed.missingColumns.join(", "))}.</p></div>`;
        return;
      }
      const results=parsed.results||[];
      const validRows=results.filter(r=>r.ok);
      const invalidRows=results.filter(r=>!r.ok);
      const summary=[
        ["Total rows",results.length,""],
        ["Valid rows",validRows.length,"good"],
        ["Rejected rows",invalidRows.length,invalidRows.length?"bad":"good"],
        ["Duplicate order IDs",bulkProblemCount(parsed,"dup_order"),bulkProblemCount(parsed,"dup_order")?"warn":"good"],
        ["Duplicate reference numbers",bulkProblemCount(parsed,"dup_ref"),bulkProblemCount(parsed,"dup_ref")?"warn":"good"],
        ["Invalid phone numbers",bulkProblemCount(parsed,"phone"),bulkProblemCount(parsed,"phone")?"warn":"good"],
        ["Invalid/unsupported cities",bulkProblemCount(parsed,"city"),bulkProblemCount(parsed,"city")?"warn":"good"],
        ["Missing address",bulkProblemCount(parsed,"address"),bulkProblemCount(parsed,"address")?"warn":"good"],
        ["Missing product details",bulkProblemCount(parsed,"product"),bulkProblemCount(parsed,"product")?"warn":"good"],
        ["Invalid COD",bulkProblemCount(parsed,"cod"),bulkProblemCount(parsed,"cod")?"warn":"good"],
        ["Invalid/missing weight",bulkProblemCount(parsed,"weight"),bulkProblemCount(parsed,"weight")?"warn":"good"]
      ];
      /* Distance pricing coverage. Nothing here rejects a row -- a row with no
         area still books at the flat rate exactly as before. It just makes
         visible how many parcels are getting the cheaper distance price, and
         how many are not, which is the difference between "the price looks
         wrong" and "I can see why". */
      try{
        if(typeof nvGeoActive==="function" && nvGeoActive()){
          var khi=validRows.filter(function(r){
            return String((r.record&&r.record.city)||"").toLowerCase()==="karachi"; });
          var priced=khi.filter(function(r){ return r.record && r.record.destAreaId; });
          if(khi.length){
            summary.push(["Karachi rows priced by distance", priced.length+"/"+khi.length,
                          priced.length===khi.length ? "good" : "warn"]);
          }
        }
      }catch(e){}
      let html=`<div class="grid metrics" style="margin-bottom:12px">${summary.map(s=>`<div class="ops-card"><div class="ops-card-head"><strong>${escLabelText(s[0])}</strong><span class="chip ${s[2]}">${s[1]}</span></div></div>`).join("")}</div>`;
      try{
        if(typeof nvGeoActive==="function" && nvGeoActive()){
          var unpriced=validRows.filter(function(r){
            return r.record && String(r.record.city||"").toLowerCase()==="karachi" && !r.record.destAreaId; });
          if(unpriced.length){
            html+='<div class="ops-card" style="margin-bottom:12px">'+
              '<div class="ops-card-head"><strong>'+unpriced.length+' Karachi row(s) will book at the flat rate</strong>'+
              '<span class="chip warn">no area matched</span></div>'+
              '<p>These import fine &mdash; we just could not read a delivery area from the address, so they are priced flat instead of by distance. '+
              'Add an <b>area</b> column to your sheet, or write the area into the address (for example &ldquo;DHA Phase 5&rdquo;), and they will price by the kilometres actually covered.</p>'+
              '<div class="footer-note" style="margin-top:6px">'+
              unpriced.slice(0,6).map(function(r){
                return "Row "+r.line+": "+escLabelText(String(r.record.address||"").slice(0,60));
              }).join("<br>")+
              (unpriced.length>6 ? "<br>&hellip; and "+(unpriced.length-6)+" more" : "")+
              '</div></div>';
          }
        }
      }catch(e){}
      if(invalidRows.length){
        /* NovaX new (bulk CSV fix-in-place): rejected rows used to be a
           read-only list, so a 50-row sheet with 3 bad cells meant going
           back to Excel, re-exporting and re-uploading. Each bad row is now
           editable right here. "Re-check" writes the edits back into the
           ORIGINAL parsed CSV rows and re-runs the same validateBulkRows()
           used everywhere else -- there is deliberately no second copy of
           the validation rules, so the grid can never disagree with what
           actually gets imported. */
        html+=`<div class="ops-card" style="margin-bottom:10px;background:var(--nvu-warn-bg);border-color:#f0d6a0"><strong>${invalidRows.length} row(s) need a fix</strong><p class="footer-note">Correct the highlighted fields below and press Re-check. Nothing is uploaded until you import.</p></div>`;
        html+=invalidRows.map(r=>{
          const bad=new Set(r.problems.map(p=>p.code));
          const f=(key,label,val,ph)=>{
            const isBad=bad.has(key)||(key==="order_id"&&bad.has("dup_order"))||(key==="reference"&&bad.has("dup_ref"));
            return `<div class="field" style="margin:0"><label style="font-size:10.5px">${escLabelText(label)}</label>`+
              `<input data-bulkfix="${r.line}" data-col="${escLabelText(key)}" value="${escLabelText(val==null?"":val)}" placeholder="${escLabelText(ph||"")}"`+
              ` style="${isBad?"border-color:#e0604b;background:#fff5f4":""}"></div>`;
          };
          const rec=r.record||{};
          return `<div class="ops-card alert-row" style="margin-bottom:10px">
            <div class="ops-card-head"><strong>Row ${r.line}</strong><span class="chip bad">${r.problems.length} issue(s)</span></div>
            ${r.problems.map(p=>`<p class="footer-note" style="color:#a1230e">${escLabelText(p.message)} <em>Fix: ${escLabelText(p.fix)}</em></p>`).join("")}
            <div class="form-grid" style="margin-top:10px;gap:8px">
              ${f("consignee","Consignee",rec.consignee,"Full name")}
              ${f("phone","Phone",rec.phone,"03001234567")}
              ${f("city","City",rec.city,"Karachi / Lahore / Islamabad / Rawalpindi")}
              ${f("cod","COD",rec.cod,"0 for prepaid")}
              ${f("product","Product",rec.product,"Item details")}
              ${f("weight","Weight",rec.weight,"0.8 kg")}
              ${f("order_id","Order ID",rec.orderId,"Unique per row")}
              ${f("payment_mode","Payment mode",rec.paymentMode,"COD")}
              ${f("address","Delivery address",rec.address,"Full address")}
              ${f("reference","Reference (optional)",rec.referenceNo,"")}
            </div>
            <div class="inline-actions" style="margin-top:10px"><button class="ghost-btn" onclick="nvRecheckBulkRow(${r.line})">Re-check row ${r.line}</button></div>
          </div>`;
        }).join("");
        html+=`<div class="inline-actions" style="margin-top:10px;flex-wrap:wrap;gap:8px"><button class="action-btn" onclick="nvRecheckAllBulk()">Re-check all rows</button>${validRows.length?`<button class="ghost-btn" id="importValidOnlyBtn" onclick="importValidBulkRowsOnly()">Import ${validRows.length} valid row(s) only</button>`:`<span class="footer-note">No valid rows to import yet.</span>`}</div>`;
      } else if(results.length){
        /* Import button matters here now: after fixing rows in place the
           user needs a way to book them, since the auto-import only runs on
           the original upload. */
        html+=`<div class="ops-card"><strong>${validRows.length} clean row(s) ready</strong><p>All phones, cities, addresses, product details, COD values, weights, order IDs, and references passed validation.</p><div class="inline-actions" style="margin-top:10px"><button class="action-btn" onclick="nvImportFixedBulk()">Import ${validRows.length} row(s)</button></div></div>`;
      }
      el.innerHTML=html;
    }
    // NovaX (Part 6): CSV rows are never booked directly from a flat
    // records list anymore -- validateBulkRows() now returns per-row
    // ok/problems, and importBulkRows() is the single place that actually
    // calls bookParcel(), used both by the all-valid path here and by
    // "Import valid rows only".
    /* NovaX new (bulk CSV fix-in-place): the raw parsed CSV is kept so edits
       can be written back into it and re-validated by the SAME
       validateBulkRows() the upload path uses. Held in a module variable
       rather than state, because state is persisted to localStorage and a
       whole CSV does not belong there. */
    var NV_BULK_RAW=null;

    function nvApplyBulkEdits(){
      if(!NV_BULK_RAW||!NV_BULK_RAW.length) return false;
      const headers=(NV_BULK_RAW[0]||[]).map(h=>String(h||"").toLowerCase().trim());
      /* One input may map to several accepted header spellings. */
      const alias={ reference:["reference","reference_no","customer_ref"] };
      let touched=false;
      document.querySelectorAll('[data-bulkfix]').forEach(function(inp){
        const line=Number(inp.getAttribute("data-bulkfix"));
        const col=inp.getAttribute("data-col");
        const rowIdx=line-1;                 // line 2 = NV_BULK_RAW[1]
        if(!(rowIdx>0)||!NV_BULK_RAW[rowIdx]) return;
        const names=alias[col]||[col];
        let j=-1;
        for(const n of names){ const k=headers.indexOf(n); if(k>-1){ j=k; break; } }
        if(j<0) return;                       // column not present in this CSV
        const val=String(inp.value||"").trim();
        if(String(NV_BULK_RAW[rowIdx][j]||"")!==val){ NV_BULK_RAW[rowIdx][j]=val; touched=true; }
      });
      return touched;
    }
    function nvRevalidateBulk(msgIfClean){
      if(!NV_BULK_RAW){ toast("Upload a CSV first."); return; }
      nvApplyBulkEdits();
      const parsed=validateBulkRows(NV_BULK_RAW);
      state.lastBulkValidation=parsed;
      renderBulkValidation(parsed);
      const bad=(parsed.results||[]).filter(r=>!r.ok).length;
      const good=(parsed.results||[]).length-bad;
      if(!bad) toast(msgIfClean||`All ${good} row(s) valid now. Ready to import.`,"success");
      else toast(`${good} valid, ${bad} still need a fix.`, bad?"error":"success");
    }
    function nvRecheckBulkRow(){ nvRevalidateBulk(); }
    function nvRecheckAllBulk(){ nvRevalidateBulk(); }
    /* Once every row is clean, let the normal import path run. */
    function nvImportFixedBulk(){
      const parsed=state.lastBulkValidation;
      if(!parsed||!parsed.results||!parsed.results.length){ toast("Upload a CSV first."); return; }
      if(parsed.results.some(r=>!r.ok)){ toast("Some rows are still invalid.","error"); return; }
      importBulkRows(parsed.results.map(r=>r.record), parsed.results.length);
    }

    async function uploadBulkCsv(){
      const file=document.getElementById("bulkCsvInput")?.files?.[0];
      if(!file){ toast("Select a CSV file first."); return; }
      NV_BULK_RAW=parseCsv(await file.text());
      const parsed=validateBulkRows(NV_BULK_RAW);
      state.lastBulkValidation=parsed;
      renderBulkValidation(parsed);
      if(parsed.missingColumns&&parsed.missingColumns.length){ toast("CSV blocked: missing required column(s).","error"); return; }
      if(!parsed.results.length){ toast("No data rows found in this CSV.","error"); return; }
      const invalidCount=parsed.results.filter(r=>!r.ok).length;
      if(invalidCount>0){ toast(`${invalidCount} row(s) blocked. Fix them or use "Import valid rows only".`,"error"); return; }
      importBulkRows(parsed.results.map(r=>r.record), parsed.results.length);
    }
    function importValidBulkRowsOnly(){
      const parsed=state.lastBulkValidation;
      if(!parsed||!parsed.results){ toast("Upload a CSV first."); return; }
      const validRecords=parsed.results.filter(r=>r.ok).map(r=>r.record);
      const rejected=parsed.results.length-validRecords.length;
      if(!validRecords.length){ toast("No valid rows to import.","error"); return; }
      if(!window.confirm(`Import ${validRecords.length} valid row(s) and skip ${rejected} rejected row(s)? Rejected rows will not get an AWB.`)) return;
      importBulkRows(validRecords, parsed.results.length);
    }
    async function importBulkRows(records, totalRowsSeen){
      // NovaX fix (URGENT order booking/processing spec): bulk import used
      // to call the same local-only bookParcel() as quick booking, with the
      // same risk of a parcel existing only in this browser if the later
      // direct insert got blocked by RLS. Each row now goes through the same
      // client_book_parcel RPC as a normal booking, one row at a time, so a
      // row only ever counts as imported once Supabase has actually
      // accepted it.
      const awbs=[]; const failed=[];
      for(const r of records){
        try{
          const mapped=window.__novaxBookParcel?await window.__novaxBookParcel({ consignee:r.consignee, city:r.city, cod:r.cod, phone:r.phone, weight:r.weight, orderId:r.orderId, referenceNo:r.referenceNo, category:r.product, paymentMode:r.paymentMode, address:r.address, fragile:r.fragile, destAreaId:r.destAreaId||null }):null;
          if(mapped&&mapped.awb) awbs.push(mapped.awb);
          else failed.push({ row:r, error:"Booking service is not ready yet." });
        }catch(e){
          const msg=(e&&e.message)?e.message:"Server rejected this row.";
          console.error("NovaX bulk booking row failed:", msg, r, e);
          failed.push({ row:r, error:msg });
        }
      }
      state.lastBulkAwbs=awbs; saveState(); renderBulkPreview();
      const skipped=Math.max(0,(totalRowsSeen||records.length)-awbs.length);
      const el=document.getElementById("bulkValidationList");
      if(el) el.insertAdjacentHTML("afterbegin", `<div class="ops-card" style="margin-bottom:10px"><strong>Import complete: ${awbs.length} AWB(s) created${skipped?`, ${skipped} row(s) skipped`:""}</strong><p>Booked rows are saved on the server now. New AWBs appear in "New Booked AWBs" for printing.</p></div>`);
      if(failed.length){
        /* Bulk import is deliberately NOT transactional -- a rejected row must
           never undo parcels the server already accepted. But the merchant was
           only told how many failed and shown the FIRST error, which on a
           50-row sheet is not enough to fix anything. List every failure with
           its consignee and the server's own reason, and offer the failures
           back as a CSV so they can be corrected and re-uploaded on their own. */
        try{
          const rows=failed.map(function(f,i){
            const r=f.row||{};
            return '<div class="log-item"><strong>'+escLabelText(r.consignee||("Row "+(i+1)))+'</strong>'+
              '<div><span class="chip bad">not booked</span>'+
              '<div class="footer-note" style="margin-top:2px">'+escLabelText(f.error||"Server rejected this row.")+'</div></div></div>';
          }).join("");
          if(el) el.insertAdjacentHTML("afterbegin",
            '<div class="ops-card alert-row" style="margin-bottom:10px">'+
            '<div class="ops-card-head"><strong>'+failed.length+' row(s) were not booked</strong>'+
            '<span class="chip bad">action needed</span></div>'+
            '<p>Everything else imported and is already live. These rows were rejected by the server and no AWB was created for them &mdash; fix and re-upload just these.</p>'+
            '<div class="inline-actions" style="margin:8px 0 10px"><button class="ghost-btn" onclick="nvDownloadFailedBulk()">Download failed rows as CSV</button></div>'+
            '<div class="log-feed">'+rows+'</div></div>');
          window.__nvBulkFailed=failed;
        }catch(e){ console.warn("NovaX bulk failure report", e); }
        toast(`${awbs.length} AWB(s) booked. ${failed.length} row(s) failed \u2014 see the list above.`,"error");
      } else {
        nvClearBookingDraft(); toast(`${awbs.length} AWB(s) booked and synced to NovaX.`,"success");
      }
    }
    /* Re-exports only the rejected rows, in the same column order as the
       upload template, so the merchant fixes a short sheet rather than hunting
       through the original. */
    function nvDownloadFailedBulk(){
      try{
        const failed=window.__nvBulkFailed||[];
        if(!failed.length){ toast("No failed rows to download."); return; }
        const head=["consignee","phone","city","address","cod","weight","order_id","product","payment_mode","area","why_it_failed"];
        const lines=[head.map(csvCell).join(",")].concat(failed.map(function(f){
          const r=f.row||{};
          return [r.consignee,r.phone,r.city,r.address,r.cod,r.weight,r.orderId,r.product,
                  r.paymentMode,r.areaName||"",f.error||""].map(csvCell).join(",");
        }));
        const a=document.createElement("a");
        a.href=URL.createObjectURL(new Blob([lines.join("\n")],{type:"text/csv"}));
        a.download="novax-failed-rows.csv"; a.click();
        toast("Failed rows downloaded.","success");
      }catch(e){ toast("Could not build that file: "+((e&&e.message)||e),"error"); }
    }
    window.nvDownloadFailedBulk=nvDownloadFailedBulk;

    /* ═══ Operations requests from the merchant ═══════════════════════════
       Reattempt, return-to-origin and address correction all called
       client_create_ops_request(p_awb, p_kind, p_note). That function does
       not exist in the database and never has -- a comment in this file even
       asserts that it "already exists". Every one of these three buttons has
       been failing with "Could not find the function" since the day it
       shipped, so a merchant with a refused parcel has had no working way to
       ask for anything.

       Rather than invent a new RPC and a table and an admin screen to read
       it, these now use what is already deployed and already has a human
       workflow behind it:

         reattempt  -> ai_action_request_reattempt(p_awb, p_note), the same
                       function the AI assistant already calls for this. One
                       action, one path, instead of the button and the AI
                       doing different things.
         everything -> novax_ticket_open(), which opens a real support ticket
         else          the merchant can follow and reply to, and that ops
                       already works through in the ticket hub.

       If the specific action RPC is missing or refuses, it falls back to a
       ticket rather than failing. A merchant asking for help must never hit
       a dead end -- worst case a person reads it. */
    function nvOpsRequestTicket(awb, subject, body, priority){
      var sb = window.__nvSb;
      if(!sb || !sb.rpc) return Promise.reject(new Error("Cloud connection not ready."));
      var p = (state.parcels||[]).find(function(x){ return x && x.awb===awb; }) || {};
      /* Ops needs the parcel's state to act on this without going and looking
         it up, so it goes in the body rather than being left implied. */
      var ctx = "\n\n--- parcel details ---" +
                "\nAWB: " + awb +
                "\nStatus: " + (p.status || "unknown") +
                "\nConsignee: " + (p.consignee || "-") +
                "\nCity: " + (p.city || "-") +
                "\nAddress: " + (p.address || "-") +
                "\nPhone: " + (p.phone || "-") +
                "\nCOD: " + (Number(p.cod)||0);
      return Promise.resolve(
        sb.rpc("novax_ticket_open", {
          p_subject: subject,
          p_body: String(body||"") + ctx,
          p_awb: String(awb||"").toUpperCase(),
          p_priority: priority || "normal"
        })
      ).catch(function(e){ return { error:{ message:String((e&&e.message)||e) } }; })
       .then(function(r){
        if(r && r.error) throw new Error(r.error.message || "Could not send that request.");
        try{ if(typeof nvTkLoad==="function") nvTkLoad(); }catch(e){}
        return r;
      });
    }

    function requestRedelivery(awb){
      // NovaX fix (item 2): this once "called the real
      // client_create_ops_request RPC" -- a function that has never existed
      // in the database. Now calls ai_action_request_reattempt, which does,
      // and falls back to a ticket when it cannot.
      // NovaX fix (item 3 follow-up): returns the underlying promise so
      // callers (like Autopilot) can wait for the real result instead of
      // announcing success before the RPC resolves.
      const p=state.parcels.find(x=>x.awb===awb); if(!p) return Promise.reject(new Error("Parcel not found."));
      const fb=document.getElementById("redeliveryFeedback")?.value.trim()||"Client requested redelivery.";
      if(!window.__nvSb){ toast("Cloud connection not ready yet, please try again in a moment."); return Promise.reject(new Error("Cloud connection not ready.")); }
      var __done = nvBusy("Sending\u2026");
      toast(`Sending reattempt request for ${awb}...`);
      /* ai_action_request_reattempt is the same RPC the AI assistant uses for
         this, so the button and the AI now do one thing rather than two. The
         status is NOT set locally: whatever that function decides is the
         truth, and loadAll() reads it back. If it is missing or refuses, the
         request becomes a ticket instead of dying. */
      return Promise.resolve(
        window.__nvSb.rpc("ai_action_request_reattempt", { p_awb: awb, p_note: fb })
      ).catch(function(e){ return { error:{ message:String((e&&e.message)||e) } }; })
       .then(function(r){
        if(r && r.error){
          return nvOpsRequestTicket(awb,
            "Reattempt requested for " + awb,
            fb || "Client requested redelivery after review.",
            "high"
          ).then(function(){
            toast(`${awb}: reattempt requested. Operations will confirm in your ticket.`,"success");
          });
        }
        p.clientFeedback = fb;
        saveState();
        try{ if(typeof loadAll==="function") loadAll(); }catch(e2){}
        toast(`${awb} sent to operations for redelivery.`,"success");
      }).catch(function(e){ toast(`Could not send the reattempt request: ${(e&&e.message)||e}`,"error"); throw e; })
        .finally(function(){ __done(); });
    }
    /* Merchant-side correction request for an already-booked parcel.

       Deliberately a request, not an edit. The city sets the delivery zone
       and therefore the fee, so letting a merchant silently re-zone a parcel
       after booking would be a pricing hole. Ops reviews and applies it with
       the admin parcel editor, which already has the same mismatch warning.

       This comment used to claim client_create_ops_request "already exists".
       It never has. Opens a support ticket instead -- a real deployed RPC
       with a human workflow behind it. */
    function requestAddressFix(awb){
      const p=state.parcels.find(x=>x.awb===awb);
      if(!p){ toast("Parcel not found."); return Promise.reject(new Error("Parcel not found.")); }
      if(!window.__nvSb){ toast("Cloud connection not ready yet, please try again in a moment."); return Promise.reject(new Error("Cloud connection not ready.")); }

      /* Pre-fill with what we can already see is wrong, so ops gets a
         specific, actionable note instead of "address is wrong". */
      let hint="";
      try{
        const looks=nvCityFromAddressC(p.address);
        if(looks && p.city && looks.toLowerCase()!==String(p.city).toLowerCase()){
          hint="The address looks like "+looks+" but the parcel is filed as "+p.city+". ";
        }
      }catch(e){}

      const note=window.prompt(
        "What needs correcting on "+awb+"?\n\n" +
        "Currently filed as: "+(p.city||"(no city)")+"\n"+(p.address||"(no address)")+"\n\n" +
        "Operations will review and apply the change.",
        hint);
      if(note===null) return Promise.resolve();
      const body=String(note||"").trim();
      if(!body){ toast("Describe what needs correcting so operations can act on it.","error"); return Promise.resolve(); }

      var __done = nvBusy("Sending\u2026");
      toast(`Sending correction request for ${awb}...`);
      /* ai_action_fix_address() exists but takes (p_awb, p_address, p_phone)
         -- structured fields, not the free-text note this flow collects. A
         ticket carries the merchant's own words to a person, which is what
         "what needs correcting?" actually needs. */
      return nvOpsRequestTicket(awb,
        "Address correction for " + awb,
        body,
        "normal"
      ).then(function(){
        toast(`${awb} sent to operations. They will confirm in your ticket once corrected.`,"success");
      }).catch(function(e){ toast(`Could not send that request: ${(e&&e.message)||e}`,"error"); throw e; })
        .finally(function(){ __done(); });
    }
    window.requestAddressFix=requestAddressFix;

    /* ===================================================================
       Cancel a booking (merchant self-service)

       Only offered while the parcel is still nothing more than a booking.
       The REAL guard is server-side in delete_new_booked_parcel(): it re-checks
       ownership and refuses once the parcel has left "New booked" or has been
       invoiced. This function only decides whether to SHOW the button -- it is
       not the security boundary.

       It is a soft cancel: the row and the AWB survive, so history stays
       intact and the number can never be reissued to a different parcel.
       =================================================================== */
    function isCancellableBooking(p){
      if(!p) return false;
      if(String(p.status||"") !== "New booked") return false;
      if(p.invoiceId) return false;                       // already billed
      if(p.rider || p.riderId) return false;              // a rider is already assigned
      return true;
    }

    /* ===================================================================
       Raise a support ticket about one specific parcel

       The mirror image of the cancel gate: cancelling is for a parcel that
       has NOT moved, a ticket is for one that HAS. While a booking is still
       "New booked" nothing has happened to complain about -- the merchant can
       still edit it or cancel it themselves, so offering a ticket there would
       just route self-service work through support.

       No new SQL. novax_ticket_open() already accepts p_awb; this only fills
       the form the merchant would otherwise have to fill by hand, which is
       the whole point -- an AWB typed from memory into a support ticket is
       how tickets end up attached to the wrong parcel.
       =================================================================== */
    /* ═══ Edit a booking that has not moved ═══════════════════════════════
       Same three conditions as the Cancel button (isCancellableBooking), for
       the same reason: once a rider has the parcel, or it has been invoiced,
       the merchant is no longer the only party who knows what is in it.

       The REAL boundary is client_edit_new_booked_parcel() on the server,
       which re-checks ownership, status, invoicing and rider assignment, and
       which has no fee parameter at all. This decides what button to show.

       There is no optimistic local write. If the server rejects the edit --
       because the parcel moved between the modal opening and Save being
       pressed, which is a real race on a busy morning -- the merchant must
       not be left looking at a number that was never stored. Reload wins. */
    function isEditableBooking(p){ return isCancellableBooking(p); }

    var NV_EDIT_AWB="";

    function nvEditParcelError(msg){
      var el=document.getElementById("nvEditParcelError");
      if(!el) return;
      if(!msg){ el.style.display="none"; el.textContent=""; return; }
      el.textContent=msg; el.style.display="block";
    }

    function nvSetVal(id,v){ var el=document.getElementById(id); if(el) el.value=(v==null?"":String(v)); }
    function nvGetVal(id){ var el=document.getElementById(id); return el?String(el.value||"").trim():""; }

    function nvOpenEditParcel(awb, ev){
      try{ if(ev && ev.stopPropagation) ev.stopPropagation(); }catch(e){}
      var p=(state.parcels||[]).find(function(x){ return x && x.awb===awb; });
      if(!p){ toast("That booking is no longer on your account.","error"); return; }
      if(!isEditableBooking(p)){
        toast("This parcel has already moved, so it can no longer be edited.","error");
        return;
      }
      try{ if(window.NovaXUI && window.NovaXUI.closeDrawer) window.NovaXUI.closeDrawer(); }catch(e){}
      NV_EDIT_AWB=awb;
      nvEditParcelError("");
      var sub=document.getElementById("nvEditParcelSub");
      if(sub) sub.textContent=awb+" \u00b7 still New booked, so everything except the delivery charge can be changed.";
      nvSetVal("nvEdName",p.consignee);
      nvSetVal("nvEdPhone",p.phone);
      nvSetVal("nvEdCity",p.city);
      nvSetVal("nvEdCod",Number(p.cod||0));
      nvSetVal("nvEdCategory",p.category);
      nvSetVal("nvEdWeight",p.weight);
      nvSetVal("nvEdService",p.service||"COD Standard");
      nvSetVal("nvEdPaymentMode",p.paymentMode||"COD");
      nvSetVal("nvEdFragile",(p.fragile==="Yes")?"Yes":"No");
      nvSetVal("nvEdAllowOpen",(p.allowOpen==="Yes")?"Yes":"No");
      nvSetVal("nvEdOrderId",p.orderId);
      nvSetVal("nvEdAddress",p.address);
      nvSetVal("nvEdFee",money(Number(p.fee||0)));
      var m=document.getElementById("nvEditParcelModal");
      if(m) m.classList.add("show");
      setTimeout(function(){ var f=document.getElementById("nvEdName"); if(f){ try{ f.focus(); }catch(e){} } },0);
    }

    function nvCloseEditParcel(){
      var m=document.getElementById("nvEditParcelModal");
      if(m) m.classList.remove("show");
      NV_EDIT_AWB="";
      nvEditParcelError("");
    }

    function nvSaveEditParcel(){
      var awb=NV_EDIT_AWB;
      if(!awb){ nvCloseEditParcel(); return; }
      var p=(state.parcels||[]).find(function(x){ return x && x.awb===awb; });
      if(!p || !isEditableBooking(p)){
        nvEditParcelError("This parcel has moved since you opened this form, so it can no longer be edited.");
        return;
      }

      var name=nvGetVal("nvEdName"), phone=nvGetVal("nvEdPhone"),
          city=nvGetVal("nvEdCity"), addr=nvGetVal("nvEdAddress"),
          cat=nvGetVal("nvEdCategory"), codRaw=nvGetVal("nvEdCod");

      /* Checked here only so the merchant gets an answer without a round
         trip. The server re-checks every one of these. */
      if(!name){ nvEditParcelError("Consignee name cannot be empty."); return; }
      if(!phone){ nvEditParcelError("Consignee phone cannot be empty."); return; }
      if(!/^0[0-9]{10}$/.test(phone.replace(/[^0-9]/g,""))){
        nvEditParcelError("Phone must be 11 digits starting with 0, e.g. 03001234567."); return;
      }
      if(!city){ nvEditParcelError("Pick a destination city."); return; }
      if(!addr){ nvEditParcelError("Delivery address cannot be empty."); return; }
      if(!cat){ nvEditParcelError("Product details cannot be empty."); return; }
      var cod=Number(codRaw);
      if(!Number.isFinite(cod) || cod<0){ nvEditParcelError("COD amount must be zero or more."); return; }

      var sb=window.__nvSb;
      if(!sb || !sb.rpc){ nvEditParcelError("Cloud connection not ready yet, please try again in a moment."); return; }

      var btn=document.getElementById("nvEditParcelSave");
      if(btn){ btn.disabled=true; btn.textContent="Saving..."; }
      nvEditParcelError("");

      /* supabase.rpc() is a thenable WITHOUT .catch(), so wrap before chaining
         -- the same pattern cancelClientBooking() uses. */
      Promise.resolve(
        sb.rpc("client_edit_new_booked_parcel",{
          p_awb: awb,
          p_consignee: name,
          p_phone: phone.replace(/[^0-9]/g,""),
          p_address: addr,
          p_city: city,
          p_cod: cod,
          p_weight: nvGetVal("nvEdWeight"),
          p_category: cat,
          p_fragile: nvGetVal("nvEdFragile"),
          p_service: nvGetVal("nvEdService"),
          p_payment_mode: nvGetVal("nvEdPaymentMode"),
          p_allow_open: nvGetVal("nvEdAllowOpen"),
          p_order_id: nvGetVal("nvEdOrderId")
        })
      ).catch(function(e){
        return { error:{ message:String((e&&e.message)||e||"network error") } };
      }).then(function(r){
        if(btn){ btn.disabled=false; btn.textContent="Save changes"; }
        if(r && r.error){
          var m=String(r.error.message||"");
          nvEditParcelError(/does not exist|schema cache/i.test(m)
            ? "Editing is not enabled on the server yet (run sql_novax_client_edit_parcel.sql)."
            : m);
          return;
        }
        nvCloseEditParcel();
        toast(awb+" updated.","success");
        /* Re-read from the server rather than patching local state: the
           server is what decides what was actually stored. */
        try{ if(typeof loadAll==="function") loadAll(); }catch(e){}
      });
    }

    function nvCanRaiseTicket(p){
      if(!p) return false;
      var st=String(p.status||"").trim();
      if(!st) return false;
      if(st==="New booked") return false;
      return true;
    }

    function nvRaiseTicketFor(awb, ev){
      try{ if(ev && ev.stopPropagation) ev.stopPropagation(); }catch(e){}
      if(typeof nvCanUseTab==="function" && !nvCanUseTab("tickets")){
        toast("Your role does not have access to Support Tickets.","error");
        return;
      }
      var p=(state.parcels||[]).find(function(x){ return x && x.awb===awb; });
      try{ if(window.NovaXUI && window.NovaXUI.closeDrawer) window.NovaXUI.closeDrawer(); }catch(e){}
      if(typeof showClientTab==="function") showClientTab("tickets");
      /* Next tick: showClientTab() flips module visibility, and focusing a
         field that is still display:none silently does nothing. */
      setTimeout(function(){
        var awbEl=document.getElementById("nvTkAwb");
        var subEl=document.getElementById("nvTkSubject");
        if(awbEl) awbEl.value=String(awb||"").toUpperCase();
        /* Never overwrite a subject the merchant is already typing. */
        if(subEl && !String(subEl.value||"").trim()){
          var st=p?String(p.status||"").trim():"";
          subEl.value="Issue with "+awb+(st?(" \u2014 "+st):"");
        }
        try{
          var pane=document.getElementById("client-tickets");
          if(pane && pane.scrollIntoView) pane.scrollIntoView({behavior:"smooth",block:"start"});
        }catch(e){}
        if(subEl){
          try{ subEl.focus(); subEl.setSelectionRange(subEl.value.length,subEl.value.length); }catch(e){}
        }
      },0);
    }

    function cancelClientBooking(awb, ev){
      try{ if(ev && ev.stopPropagation) ev.stopPropagation(); }catch(e){}
      var p=(state.parcels||[]).find(function(x){ return x.awb===awb; });
      if(!p){ toast("That booking is no longer on your account.","error"); return Promise.resolve(); }
      if(!isCancellableBooking(p)){
        toast("This parcel can no longer be cancelled - it has already moved.","error");
        return Promise.resolve();
      }
      var label=awb+(p.consignee?(" for "+p.consignee):"")+(Number(p.cod)?(" \u00b7 COD "+money(p.cod)):"");
      if(!window.confirm("Cancel booking "+label+"?\n\nThe booking is removed completely. Only possible before a rider collects it. This cannot be undone.")) return Promise.resolve();
      if(!window.__nvSb || !window.__nvSb.rpc){ toast("Cloud connection not ready yet, please try again in a moment.","error"); return Promise.resolve(); }

      var __done = nvBusy("Cancelling\u2026");
      toast("Cancelling "+awb+"...");
      // Uses delete_new_booked_parcel, which is ALREADY DEPLOYED -- admin calls
      // the same RPC today. deleteNewBooking() below has wrapped it since it was
      // written, but no button ever called it. Reusing it means this feature
      // works the moment the HTML is uploaded: no new SQL, and no status
      // transition to authorise, because deleting a row never fires
      // enforce_parcel_status_transition() at all.
      // supabase.rpc() is a thenable WITHOUT .catch(), so wrap before chaining.
      return Promise.resolve(
        window.__nvSb.rpc("delete_new_booked_parcel", { p_awb: awb })
      ).catch(function(e){
        return { error:{ message:String((e&&e.message)||e||"network error") } };
      }).then(function(r){
        if(r && r.error){ toast("Could not cancel: "+String(r.error.message||""),"error"); return; }
        state.parcels=(state.parcels||[]).filter(function(x){ return x.awb!==awb; });
        if(state.selectedAwb===awb) state.selectedAwb="";
        if(state.lastGeneratedAwb===awb) state.lastGeneratedAwb="";
        try{ saveState(); }catch(e){}
        try{ render(); }catch(e){}
        try{ if(typeof loadAll==="function") loadAll(); }catch(e){}
        toast(awb+" cancelled.","success");
      }).finally(function(){ __done(); });
    }

    /* ===================================================================
       Support tickets v2 (client side) -- MANUAL ONLY

       Nothing here creates a ticket except the merchant pressing "Open
       Ticket". There is no auto-ticketing, no sourceKey dedupe and no
       background writer -- those were exactly what produced ~1,800 junk
       tickets and the 409 insert storm in v1.

       Reads come straight from novax_tickets/novax_ticket_replies (RLS
       scopes them to this merchant); writes go through the SECURITY DEFINER
       RPCs so the rules live in the database, not the browser.
       =================================================================== */
    var NV_TK = { list: [], replies: {}, replyError: {}, filter: "open", openId: null, loading: false };

    function nvTkEsc(v){
      return String(v == null ? "" : v).replace(/[&<>"']/g, function(c){
        return ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c];
      });
    }
    function nvTkHrs(n){
      n = Number(n || 0);
      if (n < 1) return Math.max(1, Math.round(n * 60)) + "m";
      return (n < 24 ? Math.round(n) + "h" : Math.round(n / 24) + "d");
    }
    /* SLA is DERIVED, never stored as a countdown. created_at and
       first_response_at come from the server, so every viewer computes the
       same answer and nothing has to tick to keep it true. */
    function nvTkSla(t){
      var created = new Date(String(t.created_at || "").replace(" ", "T"));
      if (isNaN(created.getTime())) return { state: "unknown", text: "" };
      var limitMs = (Number(t.sla_hours || 24)) * 3600e3;
      if (t.first_response_at){
        var fr = new Date(String(t.first_response_at).replace(" ", "T"));
        var took = (fr - created) / 3600e3;
        return { state: (fr - created) <= limitMs ? "met" : "missed",
                 text: "First reply in " + nvTkHrs(took) };
      }
      if (t.status === "resolved") return { state: "met", text: "Resolved" };
      var age = Date.now() - created.getTime();
      if (age > limitMs) return { state: "breached",
        text: "No reply for " + nvTkHrs(age / 3600e3) + " — past the " + (t.sla_hours || 24) + "h target" };
      return { state: "running",
        text: nvTkHrs((limitMs - age) / 3600e3) + " left for first reply" };
    }

    function nvTkLoad(){
      var sb = window.__nvSb;
      if (!sb || NV_TK.loading) return Promise.resolve();
      NV_TK.loading = true;
      return Promise.resolve(
        sb.from("novax_tickets").select("*").order("created_at", { ascending: false }).limit(200)
      ).catch(function(e){ return { error: { message: String((e && e.message) || e) } }; })
       .then(function(r){
        NV_TK.loading = false;
        if (r && r.error){
          if (/does not exist|schema cache|relation/i.test(String(r.error.message || ""))){
            var host = document.getElementById("nvTkList");
            if (host) host.innerHTML = '<div class="ops-card"><strong>Ticketing is not enabled yet</strong>' +
              '<p class="footer-note">Ask NovaX to run novax_tickets_v2.sql.</p></div>';
            return;
          }
          /* BUG: every non-missing-table error fell through to a bare
             console.warn and return, leaving the list showing "No tickets
             yet." A merchant chasing a lost parcel read that as "my ticket
             was never created" and opened a duplicate. Say what actually
             happened, and offer a retry. */
          console.warn("NovaX tickets load", r.error.message);
          NV_TK.loadError = String(r.error.message || "unknown error");
          var eHost = document.getElementById("nvTkList");
          if (eHost) eHost.innerHTML = '<div class="ops-card"><strong>We could not load your tickets</strong>' +
            '<p class="footer-note">This is a connection problem, not a sign your tickets are gone. ' +
            'Your existing tickets are safe.</p>' +
            '<button class="ghost-btn" type="button" style="margin-top:8px" onclick="nvTkLoad()">Try again</button></div>';
          return;
        }
        NV_TK.loadError = null;
        NV_TK.list = (r && r.data) || [];
        nvTkRender();
      });
    }

    function nvTkLoadReplies(id){
      var sb = window.__nvSb;
      if (!sb || !id) return Promise.resolve();
      return Promise.resolve(
        sb.from("novax_ticket_replies").select("*").eq("ticket_id", id).order("created_at", { ascending: true })
      ).catch(function(e){ return { error: { message: String((e && e.message) || e) } }; })
       .then(function(r){
         /* A failed load used to become an empty array, which on screen is
            indistinguishable from "NovaX has not replied yet". Keep whatever
            was already loaded and record why, so the thread can say so. */
         if (r && r.error){
           NV_TK.replyError[id] = r.error.message;
           console.warn("NovaX tickets: could not load replies", r.error.message);
         } else {
           delete NV_TK.replyError[id];
           NV_TK.replies[id] = (r && r.data) || [];
         }
         nvTkRender();
       });
    }

    function nvTkCard(t){
      var sla = nvTkSla(t);
      var open = NV_TK.openId === t.id;
      var stChip = t.status === "resolved" ? "good" : t.status === "pending_client" ? "warn" : "info";
      var stText = t.status === "resolved" ? "resolved" : t.status === "pending_client" ? "needs your reply" : "open";
      var prChip = t.priority === "high" ? "bad" : t.priority === "low" ? "info" : "warn";
      var slaChip = sla.state === "breached" ? "bad" : sla.state === "missed" ? "warn" : "good";
      var reps = NV_TK.replies[t.id] || [];

      var thread = "";
      if (open){
        thread = '<div class="nv-tk-thread">' +
          (!reps.length && NV_TK.replyError[t.id]
            ? '<p class="footer-note">Could not load the replies just now \u2014 ' +
              nvTkEsc(NV_TK.replyError[t.id]) + '</p>'
            : "") +
          (reps.length ? reps.map(function(r){
            return '<div class="nv-tk-msg ' + (r.by_side === "client" ? "mine" : "") + '">' +
              '<div class="nv-tk-meta">' + nvTkEsc(r.by_name || (r.by_side === "client" ? "You" : "NovaX Support")) +
              ' · ' + nvTkEsc(String(r.created_at || "").replace("T", " ").slice(0, 16)) + '</div>' +
              '<div>' + nvTkEsc(r.body) + '</div></div>';
          }).join("") : '<p class="footer-note">No replies yet.</p>') +
          (t.status !== "resolved"
            ? '<div class="inline-actions" style="margin-top:10px;gap:6px">' +
              '<input class="nv-tk-reply" id="nvTkReply-' + nvTkEsc(t.id) + '" placeholder="Write a reply...">' +
              '<button class="action-btn" data-nv-tkreply="' + nvTkEsc(t.id) + '">Send</button></div>'
            : '') +
          '</div>';
      }

      return '<div class="ops-card nv-tk-card' + (sla.state === "breached" ? " nv-tk-breach" : "") + '">' +
        '<div class="ops-card-head" data-nv-tkopen="' + nvTkEsc(t.id) + '" style="cursor:pointer">' +
          '<strong>' + nvTkEsc(t.code || "Ticket") + ' · ' + nvTkEsc(t.subject) + '</strong>' +
          '<span class="chip ' + stChip + '">' + stText + '</span>' +
        '</div>' +
        '<div class="inline-actions" style="flex-wrap:wrap;gap:6px;margin:6px 0">' +
          '<span class="chip ' + prChip + '">' + nvTkEsc(t.priority) + '</span>' +
          (t.awb ? '<span class="chip info">' + nvTkEsc(t.awb) + '</span>' : "") +
          (sla.text ? '<span class="chip ' + slaChip + '">' + nvTkEsc(sla.text) + '</span>' : "") +
          '<span class="chip info">Opened ' + nvTkEsc(String(t.created_at || "").replace("T", " ").slice(0, 16)) + '</span>' +
        '</div>' +
        (t.body ? '<p style="font-size:13px;margin:6px 0">' + nvTkEsc(t.body) + '</p>' : "") +
        thread +
      '</div>';
    }

    function nvTkRender(){
      var host = document.getElementById("nvTkList");
      if (!host) return;
      var all = NV_TK.list || [];
      var openOnes = all.filter(function(t){ return t.status !== "resolved"; });
      var badge = document.getElementById("nvTkOpenCount");
      if (badge){
        var breached = openOnes.filter(function(t){ return nvTkSla(t).state === "breached"; }).length;
        badge.textContent = openOnes.length + " open" + (breached ? " · " + breached + " overdue" : "");
        badge.className = "chip " + (breached ? "bad" : openOnes.length ? "warn" : "good");
      }
      Array.prototype.forEach.call(document.querySelectorAll("[data-nv-tkf]"), function(b){
        b.className = "ghost-btn nv-tkf" + (b.getAttribute("data-nv-tkf") === NV_TK.filter ? " action-btn" : "");
      });
      var rows = NV_TK.filter === "open" ? openOnes
               : NV_TK.filter === "resolved" ? all.filter(function(t){ return t.status === "resolved"; })
               : all;
      /* This rebuild fires on a 3-second tick, and nvTkCard() emits a brand
         new EMPTY reply input each time -- so a merchant typing a reply to
         support had their text wiped roughly every three seconds. There was
         no draft handling here at all. Carry the drafts, the focus and the
         caret across the rebuild. */
      var drafts = {}, activeId = null, selStart = null, selEnd = null;
      Array.prototype.forEach.call(host.querySelectorAll("input.nv-tk-reply"), function(el){
        if (el.value) drafts[el.id] = el.value;
        if (document.activeElement === el){
          activeId = el.id;
          try{ selStart = el.selectionStart; selEnd = el.selectionEnd; }catch(e){}
        }
      });

      host.innerHTML = rows.map(nvTkCard).join("");

      Object.keys(drafts).forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.value = drafts[id];
      });
      if (activeId){
        var back = document.getElementById(activeId);
        if (back){
          try{
            back.focus();
            if (selStart !== null) back.setSelectionRange(selStart, selEnd);
          }catch(e){}
        }
      }
    }

    function nvTkSubmit(){
      var sb = window.__nvSb;
      var subj = (document.getElementById("nvTkSubject") || {}).value || "";
      var body = (document.getElementById("nvTkBody") || {}).value || "";
      var awb  = (document.getElementById("nvTkAwb") || {}).value || "";
      var pri  = (document.getElementById("nvTkPriority") || {}).value || "normal";
      if (!subj.trim()){ toast("Please describe the issue in one line.", "error"); return; }
      if (!sb){ toast("Cloud connection not ready yet, please try again in a moment.", "error"); return; }
      var btn = document.getElementById("nvTkSubmit");
      if (btn){ btn.disabled = true; btn.textContent = "Opening..."; }
      Promise.resolve(
        sb.rpc("novax_ticket_open", { p_subject: subj.trim(), p_body: body.trim(),
                                      p_awb: awb.trim().toUpperCase(), p_priority: pri })
      ).catch(function(e){ return { error: { message: String((e && e.message) || e) } }; })
       .then(function(r){
        if (btn){ btn.disabled = false; btn.textContent = "Open Ticket"; }
        if (r && r.error){
          var m = String(r.error.message || "");
          toast(/does not exist|schema cache/i.test(m)
            ? "Ticketing is not enabled on the server yet (run novax_tickets_v2.sql)."
            : "Could not open the ticket: " + m, "error");
          return;
        }
        ["nvTkSubject","nvTkBody","nvTkAwb"].forEach(function(id){
          var el = document.getElementById(id); if (el) el.value = "";
        });
        NV_TK.filter = "open";
        toast("Ticket opened. We will reply here.", "success");
        nvTkLoad();
      });
    }

    function nvTkSendReply(id){
      var sb = window.__nvSb;
      var el = document.getElementById("nvTkReply-" + id);
      var body = el ? el.value : "";
      if (!body.trim()) return;
      if (!sb){ toast("Cloud connection not ready yet.", "error"); return; }
      Promise.resolve(sb.rpc("novax_ticket_client_reply", { p_ticket_id: id, p_body: body.trim() }))
        .catch(function(e){ return { error: { message: String((e && e.message) || e) } }; })
        .then(function(r){
          if (r && r.error){ toast("Could not send the reply: " + r.error.message, "error"); return; }
          if (el) el.value = "";
          nvTkLoadReplies(id);
          nvTkLoad();
        });
    }

    function nvTkWire(){
      var sub = document.getElementById("nvTkSubmit");
      if (sub && !sub._nvWired){ sub._nvWired = true; sub.addEventListener("click", nvTkSubmit); }
      var pane = document.getElementById("client-tickets");
      if (pane && !pane._nvWired){
        pane._nvWired = true;
        pane.addEventListener("click", function(ev){
          var f = ev.target.closest("[data-nv-tkf]");
          if (f){ NV_TK.filter = f.getAttribute("data-nv-tkf"); nvTkRender(); return; }
          var o = ev.target.closest("[data-nv-tkopen]");
          if (o){
            var id = o.getAttribute("data-nv-tkopen");
            NV_TK.openId = (NV_TK.openId === id) ? null : id;
            nvTkRender();
            if (NV_TK.openId) nvTkLoadReplies(id);
            return;
          }
          var rp = ev.target.closest("[data-nv-tkreply]");
          if (rp){ nvTkSendReply(rp.getAttribute("data-nv-tkreply")); return; }
        });
      }
    }

    /* Wire + load. Deliberately NOT part of render(): tickets are their own
       island, so a ticket failure can never take the dashboard down with it,
       and the dashboard re-rendering does not re-fetch tickets. */
    (function nvTkBoot(){
      function tick(){
        try{ nvTkWire(); }catch(e){}
        var pane=document.getElementById("client-tickets");
        if(pane && pane.classList.contains("active")){
          try{ nvTkRender(); }catch(e){}
        }
      }
      setTimeout(function(){ tick(); try{ nvTkLoad(); }catch(e){} }, 900);
      nvInterval(tick, 3000);
      // Refresh from the server only while the merchant is actually looking
      // at the tickets tab, and only once a minute -- v1 polled constantly.
      nvInterval(function(){
        var pane=document.getElementById("client-tickets");
        if(pane && pane.classList.contains("active") && document.visibilityState!=="hidden"){
          try{ nvTkLoad(); }catch(e){}
          /* The open thread too. nvTkLoad() only refreshes the ticket LIST,
             so without this a reply arriving while the merchant is reading
             the thread stays invisible until they collapse and reopen it. */
          if (NV_TK.openId){ try{ nvTkLoadReplies(NV_TK.openId); }catch(e){} }
        }
      }, 60000);
    })();

    function applyClientDateRange(){ state.clientDateFrom=document.getElementById("clientDateFrom").value||state.clientDateFrom; state.clientDateTo=document.getElementById("clientDateTo").value||state.clientDateTo; saveState(); render(); toast(`History filtered ${state.clientDateFrom} to ${state.clientDateTo}.`); }
    // NovaX fix: this used to create a fake "Payout requested" payment-log
    // entry entirely in the browser, with no Supabase call at all -- it
    // could show a "success" toast without ever creating a real withdrawal,
    // and it used the invoice-payable-pending figure instead of the actual
    // wallet balance. All real withdrawals must now go through the Wallet
    // tab's request_wallet_withdrawal RPC, so this just opens Wallet and
    // guides the user there instead of faking a request.
    function requestPayout(){ showClientTab("money"); toast("Choose an amount, payout speed, and IBAN in Wallet to request your withdrawal."); }
    // NovaX note: requestPayout() is a manual admin-review payout only (no amount/IBAN
    // validation). The real bank withdrawal flow is confirmWalletWithdraw() + the
    // request_wallet_withdrawal RPC below, which requires amount + IBAN + speed. NovaX
    // Autopilot must never call requestPayout() on the client's behalf and must never
    // claim a withdrawal was sent \u2014 it should only open Wallet for the client to submit it.

    /* ===== Store Integrations + New Booked bulk print ===== */
    // NovaX fix (High #2): activeClientId() must never fall back to the
    // demo/default placeholder client id -- callers (storeConn, etc.) should treat a
    // missing id as "no store connections / no client-scoped data", not as
    // the demo client's data.
    function activeClientId(){ return (state.client&&state.client.id)||null; }
    function storeConn(platform){ return (state.storeConnections||[]).find(c=>c.clientId===activeClientId()&&c.platform===platform); }
    function platformLabel(p){ return p==="shopify"?"Shopify":p==="woocommerce"?"WooCommerce":"Custom Web/API"; }

    // NovaX Shopify Link Integration: no NovaX Shopify app, no OAuth, no
    // Partner app Client ID, and nothing to install. The client generates a
    // unique webhook URL below, adds ONE webhook in their own Shopify Admin,
    // and pastes back the signing secret Shopify shows them. Every inbound
    // order is verified against that secret before anything is imported --
    // the link is never marked "Connected"/"Live" just because it was generated.
    function shopifyGenerateLink(){
      if(!window.__nvSb){ toast("Cloud connection not ready yet, please try again in a moment."); return; }
      toast("Generating your Shopify link...");
      window.__nvSb.rpc("client_generate_shopify_link", { p_store_domain: null }).then(function(r){
        if(r && r.error){ toast("Failed to generate link: "+r.error.message); return; }
        const row = r && r.data && r.data[0];
        if(!row){ toast("Failed to generate link."); return; }
        const intakeUrl = SB_URL.replace(/\/$/, "") + "/functions/v1/shopify-order-intake/" + row.intake_token;
        const urlEl=document.getElementById("shopifyIntakeUrlOut"); if(urlEl) urlEl.value=intakeUrl;
        document.getElementById("shopifyLinkBox").style.display="block";
        document.getElementById("shopifyStep2Box").style.display="block";
        document.getElementById("shopifyStep3Box").style.display="block";
        toast(row.has_secret ? "Shopify link ready." : "Shopify link ready. Now add the webhook in Shopify and paste the signing secret below.");
        shopifyCheckStatus();
      }).catch(function(e){ toast("Failed to generate link: "+e); });
    }
    /* =====================================================================
       NovaX new (Shopify bulk import).
       A webhook only fires for orders created AFTER it is registered, so a
       merchant's existing unfulfilled orders must be PULLED via the Shopify
       Admin API. That happens in the shopify-bulk-import Edge Function --
       the Admin API token never touches this browser.
       ===================================================================== */
    function shopifySaveDomain(){
      var d=(document.getElementById("shopifyDomainInput")||{}).value||"";
      d=String(d).trim();
      if(!d){ toast("Enter your Shopify store domain first."); return; }
      if(!window.__nvSb){ toast("Cloud connection not ready yet."); return; }
      window.__nvSb.rpc("client_set_shopify_domain",{ p_domain:d }).then(function(r){
        if(r&&r.error){
          /* client_shopify_bulk_state already detects a missing RPC and
             disables the whole Shopify panel. This one did not, so a
             merchant on a database without the Shopify functions got
             "Could not save domain: Could not find the function..." and no
             explanation, while the rest of the section quietly greyed out.
             Same detection, same outcome. */
          if(typeof nvRpcMissing==="function" && nvRpcMissing(r.error)){
            NV_RPC_DEAD.client_set_shopify_domain = true;
            try{ nvShopifyDisable(r.error.message); }catch(e){}
            toast("Shopify integration is not enabled on this account yet.","error");
            return;
          }
          toast("Could not save domain: "+r.error.message,"error"); return;
        }
        var el=document.getElementById("shopifyDomainInput");
        if(el&&r&&r.data) el.value=r.data;
        toast("Store domain saved.");
        shopifyLoadBulkState();
      }).catch(function(e){ toast("Could not save domain: "+((e&&e.message)||e)); });
    }
    function shopifySaveAdminToken(){
      var t=(document.getElementById("shopifyAdminTokenInput")||{}).value||"";
      t=String(t).trim();
      if(!t){ toast("Paste your Shopify Admin API access token first."); return; }
      if(!window.__nvSb){ toast("Cloud connection not ready yet."); return; }
      window.__nvSb.rpc("client_set_shopify_admin_token",{ p_token:t }).then(function(r){
        if(r&&r.error){ toast("Could not save token: "+r.error.message); return; }
        var el=document.getElementById("shopifyAdminTokenInput"); if(el) el.value="";
        toast("Admin API token saved. You can now import existing orders.");
        shopifyLoadBulkState();
      }).catch(function(e){ toast("Could not save token: "+((e&&e.message)||e)); });
    }
    /* Missing-RPC latch. Supabase returns PGRST202 / "Could not find the
       function ... in the schema cache" when a function has not been deployed.
       Retrying that on a timer is pure noise: it will not start existing on its
       own. One attempt, then the feature is marked unavailable for this page
       load. Nothing else is affected -- this only gates the Shopify panel. */
    var NV_RPC_DEAD = Object.create(null);
    function nvRpcMissing(err){
      if(!err) return false;
      var m = String(err.message || err.hint || "");
      return err.code === "PGRST202" ||
             /could not find the function|does not exist|schema cache/i.test(m);
    }
    function nvShopifyDisable(reason){
      var chip = document.getElementById("shopifyBulkChip");
      var out  = document.getElementById("shopifyBulkStatus");
      var sc   = document.getElementById("shopifyStatusChip");
      if(chip){ chip.textContent = "not enabled"; chip.className = "chip"; }
      if(sc){ sc.textContent = "not enabled"; sc.className = "chip"; }
      if(out && !out.dataset.nvDisabled){
        out.dataset.nvDisabled = "1";
        out.innerHTML = '<span class="footer-note">Shopify import is not switched on for this account yet. '
                      + 'Ask NovaX to enable it &mdash; nothing is wrong on your side.</span>';
      }
      /* client_set_shopify_domain and client_shopify_bulk_state are not
         deployed on this database. The panel degraded honestly but was still
         rendered in full -- two inputs, a token walkthrough and an Import
         button -- advertising a feature no merchant here can use. Collapse the
         whole box to the one honest sentence instead of dressing it up. */
      var box = document.getElementById("shopifyBulkBox");
      if(box && !box.dataset.nvCollapsed){
        box.dataset.nvCollapsed = "1";
        Array.prototype.forEach.call(box.children, function(el){
          if(el !== out && el.id !== "shopifyBulkChip") el.style.display = "none";
        });
        var head = box.querySelector(".ops-card-head");
        if(head) head.style.display = "";
        if(out) out.style.display = "";
      }
      if(reason) console.warn("NovaX: Shopify RPCs are not deployed (" + reason + "). Polling stopped.");
    }

    function shopifyLoadBulkState(){
      if(!window.__nvSb) return;
      if(NV_RPC_DEAD.client_shopify_bulk_state) return;
      window.__nvSb.rpc("client_shopify_bulk_state",{}).then(function(r){
        if(r&&r.error){
          if(nvRpcMissing(r.error)){
            NV_RPC_DEAD.client_shopify_bulk_state = true;
            nvShopifyDisable(r.error.message);
          }
          return;
        }
        var d=(r&&r.data&&r.data[0])||null;
        var chip=document.getElementById("shopifyBulkChip");
        var out=document.getElementById("shopifyBulkStatus");
        var dom=document.getElementById("shopifyDomainInput");
        if(!d){ if(chip){ chip.textContent="optional"; chip.className="chip"; } return; }
        if(dom && !dom.value && d.store_url) dom.value=d.store_url;
        if(chip){
          chip.textContent = d.has_admin_token ? "ready" : "token needed";
          chip.className = d.has_admin_token ? "chip good" : "chip";
        }
        if(out){
          var bits=[];
          if(d.bulk_total_imported) bits.push("<b>"+escLabelText(String(d.bulk_total_imported))+"</b> order(s) imported in total");
          if(d.bulk_last_run_at){
            var when=""; try{ when=new Date(d.bulk_last_run_at).toLocaleString(); }catch(e){}
            bits.push("last run "+escLabelText(when)+" &middot; "+escLabelText(String(d.bulk_last_count||0))+" new, "+escLabelText(String(d.bulk_last_skipped||0))+" already there");
          }
          if(d.bulk_last_error) bits.push('<span style="color:#b45309">'+escLabelText(d.bulk_last_error)+"</span>");
          out.innerHTML=bits.join("<br>");
        }
      }).catch(function(){});
    }
    function shopifyBulkImport(){
      var btn=document.getElementById("shopifyBulkBtn");
      var out=document.getElementById("shopifyBulkStatus");
      if(!window.__nvSb){ toast("Cloud connection not ready yet."); return; }
      var CFGX=window.NOVAX_CONFIG||{};
      var base=String(CFGX.SB_URL||"").replace(/\/$/,"");
      if(!base){ toast("Cloud connection not configured."); return; }
      var old=btn?btn.textContent:"";
      if(btn){ btn.disabled=true; btn.textContent="Importing…"; }
      if(out) out.textContent="Contacting Shopify…";
      window.__nvSb.auth.getSession().then(function(s){
        var tok=s&&s.data&&s.data.session&&s.data.session.access_token;
        if(!tok){ throw new Error("Your session expired. Please sign in again."); }
        return fetch(base+"/functions/v1/shopify-bulk-import",{
          method:"POST",
          headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+tok },
          body:"{}"
        });
      }).then(function(res){
        return res.text().then(function(t){
          var j=null; try{ j=JSON.parse(t); }catch(e){}
          return { ok:res.ok, status:res.status, body:j, raw:t };
        });
      }).then(function(r){
        if(btn){ btn.disabled=false; btn.textContent=old; }
        if(r.status===401 && /missing authorization header/i.test(r.raw||"")){
          if(out) out.innerHTML='<span style="color:#b91c1c">The bulk import function was deployed without --no-verify-jwt. Ask NovaX support to redeploy it.</span>';
          return;
        }
        if(!r.ok || (r.body&&r.body.error)){
          var m=(r.body&&r.body.error)||("Import failed ("+r.status+")");
          if(out) out.innerHTML='<span style="color:#b91c1c">'+escLabelText(m)+"</span>";
          toast(m);
          return;
        }
        var b=r.body||{};
        var msg="Imported "+(b.imported||0)+" order(s)"+(b.skipped?(", "+b.skipped+" already in NovaX"):"")+".";
        if(out) out.innerHTML=escLabelText(msg)+(b.failed?('<br><span style="color:#b45309">'+escLabelText(String(b.failed))+" order(s) could not be imported.</span>"):"");
        toast(msg);
        shopifyLoadBulkState();
        try{ if(typeof loadAll==="function") loadAll(); }catch(e){}
      }).catch(function(e){
        if(btn){ btn.disabled=false; btn.textContent=old; }
        var m=(e&&e.message)||String(e);
        if(out) out.innerHTML='<span style="color:#b91c1c">'+escLabelText(m)+"</span>";
        toast(m);
      });
    }

    function shopifySaveSecret(){
      const secret=(document.getElementById("shopifySecretInput")?.value||"").trim();
      if(!secret){ toast("Paste the Shopify signing secret first."); return; }
      if(!window.__nvSb){ toast("Cloud connection not ready yet, please try again in a moment."); return; }
      window.__nvSb.rpc("client_set_shopify_secret", { p_secret: secret }).then(function(r){
        if(r && r.error){ toast("Failed to save secret: "+r.error.message); return; }
        const el=document.getElementById("shopifySecretInput"); if(el) el.value="";
        const successBox=document.getElementById("shopifySecretSuccessBox"); if(successBox) successBox.style.display="block";
        toast("Secret saved. Now create one test order in Shopify.");
        shopifyCheckStatus();
        try{ shopifyLoadBulkState(); }catch(e){}
      }).catch(function(e){ toast("Failed to save secret: "+e); });
    }
    // NovaX (Shopify Setup UX): maps the precise backend connection_status
    // into the 4-step tracker so a client can see exactly which step they're
    // on and what to do next, instead of guessing whether anything is broken.
    function shopifyRenderStepTracker(row){
      const done="\u25CF ", pending="\u25CB ";
      const c1=document.getElementById("shopifyStepChip1"), c2=document.getElementById("shopifyStepChip2"),
            c3=document.getElementById("shopifyStepChip3"), c4=document.getElementById("shopifyStepChip4"),
            nextNote=document.getElementById("shopifyNextActionNote");
      const hasLink=!!(row && row.intake_token);
      const hasSecret=!!(row && row.has_secret);
      const isLive=!!(row && row.imported_count>0);
      if(c1){ c1.textContent=(hasLink?done:pending)+"1. Link generated"; c1.style.color=hasLink?"#1a7a3f":""; }
      if(c2){ c2.textContent=(hasSecret?done:pending)+"2. Webhook added in Shopify"; c2.style.color=hasSecret?"#1a7a3f":""; }
      if(c3){ c3.textContent=(hasSecret?done:pending)+"3. Signing secret saved"; c3.style.color=hasSecret?"#1a7a3f":""; }
      if(c4){ c4.textContent=(isLive?done:pending)+"4. First order received"; c4.style.color=isLive?"#1a7a3f":""; }
      if(nextNote){
        if(!row || !hasLink) nextNote.textContent="Next: generate your NovaX Shopify link below.";
        else if(!hasSecret) nextNote.textContent="Next: add the webhook in Shopify (Order creation, JSON), then paste the signing secret below.";
        else if(row.connection_status==="Signature failed") nextNote.textContent="Next: the signing secret doesn't match -- copy it again from Shopify exactly and re-save it below.";
        else if(row.connection_status==="Import failed") nextNote.textContent="Next: the last order failed to import for a reason other than the signature -- open the troubleshooting list below.";
        else if(!isLive) nextNote.textContent="Next: create one test order in Shopify, then press \u201cI created a test order -- check again\u201d.";
        else nextNote.textContent="All steps complete. Shopify orders are importing automatically.";
      }
    }
    /* The earlier duplicate definition of shopifySaveAdminToken() that used
       to live here was removed: function declarations hoist, so it silently
       overrode the bulk-import-aware version defined above and the bulk
       panel never refreshed after saving a token. One definition only. */
    function shopifyCheckStatus(){
      if(!window.__nvSb) return;
      try{ shopifyLoadBulkState(); }catch(e){}
      if(NV_RPC_DEAD.client_shopify_status) return;
      window.__nvSb.rpc("client_shopify_status", {}).then(function(r){
        if(r && r.error){
          if(nvRpcMissing(r.error)){
            NV_RPC_DEAD.client_shopify_status = true;
            nvShopifyDisable(r.error.message);
          }
          return;
        }
        const row = r && r.data && r.data[0];
        const chip=document.getElementById("shopifyStatusChip");
        const detail=document.getElementById("shopifyStatusDetail");
        shopifyRenderStepTracker(row);
        if(!row){ if(chip) chip.textContent="Setup pending"; return; }
        // NovaX (Shopify Setup UX): connection_status now comes straight from
        // the backend as one of Setup pending / Webhook URL ready / Waiting
        // for first order / Live / Signature failed / Import failed /
        // Disabled -- never shown as "Connected" before imported_count > 0.
        if(chip) chip.textContent=row.connection_status;
        if(detail){
          if(row.disabled) detail.textContent="This integration was disabled by NovaX admin.";
          else if(row.connection_status==="Signature failed") detail.textContent="Signature failed -- the signing secret NovaX has doesn't match what Shopify is sending. Re-copy it from Shopify exactly and save it again.";
          else if(row.connection_status==="Import failed") detail.textContent="The last order's signature verified fine, but the import still failed: "+(row.last_error||"unknown error")+". Open the troubleshooting list below.";
          else if(row.imported_count>0) detail.textContent="Live. Last order received "+new Date(row.last_order_at).toLocaleString()+". "+row.imported_count+" order(s) imported so far.";
          else if(row.has_secret) detail.textContent="Webhook ready / waiting for first order -- create one test order in Shopify and NovaX will import it automatically.";
          else detail.textContent="Your NovaX webhook URL is ready. Add it in Shopify, then paste the Shopify signing secret below.";
        }
        const successBox=document.getElementById("shopifySecretSuccessBox");
        if(successBox) successBox.style.display=(row.has_secret && !(row.imported_count>0))?"block":"none";
        const troubleshootBox=document.getElementById("shopifyTroubleshootBox");
        if(troubleshootBox) troubleshootBox.open = (row.connection_status==="Signature failed" || row.connection_status==="Import failed");
        // NovaX (Shopify Final Test Visibility): once Live / first order is
        // in, surface imported count, last order time, and last AWB with a
        // shortcut into Order Logs filtered to this source.
        const summaryBox=document.getElementById("shopifyImportSummary");
        if(summaryBox){
          if(row.imported_count>0){
            summaryBox.style.display="block";
            const cEl=document.getElementById("shopifyImportedCount"); if(cEl) cEl.textContent=row.imported_count;
            const tEl=document.getElementById("shopifyLastOrderAt"); if(tEl) tEl.textContent=row.last_order_at?new Date(row.last_order_at).toLocaleString():"-";
            const aEl=document.getElementById("shopifyLastAwb"); if(aEl) aEl.textContent=row.last_order_awb||"-";
          } else {
            summaryBox.style.display="none";
          }
        }
        if(row.intake_token){
          const urlEl=document.getElementById("shopifyIntakeUrlOut");
          if(urlEl && !urlEl.value) urlEl.value = SB_URL.replace(/\/$/, "") + "/functions/v1/shopify-order-intake/" + row.intake_token;
          document.getElementById("shopifyLinkBox").style.display="block";
          document.getElementById("shopifyStep2Box").style.display="block";
          document.getElementById("shopifyStep3Box").style.display="block";
        }
      }).catch(function(){});
    }
    function viewShopifyImportedOrders(){
      state.orderLogSourceFilter="shopify";
      showClientTab("logs");
      toast("Showing Shopify-imported orders in Order Logs.");
    }
    function clearOrderLogFilter(){
      state.orderLogSourceFilter="";
      renderClientReportFull();
    }
    function shopifyCopySetupInstructions(){
      const url=(document.getElementById("shopifyIntakeUrlOut")?.value||"").trim();
      if(!url){ toast("Generate the Shopify link first."); return; }
      const msg="NovaX Shopify setup:\n"
        +"1) Shopify Admin > Settings > Notifications > Webhooks > Create webhook\n"
        +"2) Event: Order creation\n"
        +"3) Format: JSON\n"
        +"4) URL: "+url+" (must match exactly)\n"
        +"5) Copy the \"Signing secret\" Shopify shows you and paste it back into NovaX (Store Integrations > Shopify Link Integration > Save Secret)\n"
        +"6) Create one test order in Shopify, then press \"I created a test order -- check again\" in NovaX\n\n"
        +"If it still doesn't show Live, check:\n"
        +"- Event must be Order creation\n"
        +"- Format must be JSON\n"
        +"- URL must match the NovaX webhook URL exactly\n"
        +"- Signing secret must be copied exactly from Shopify\n"
        +"- JWT verification must be OFF on the Supabase Edge Function";
      let ok=false;
      try{ if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(msg); ok=true; } }catch(e){}
      toast(ok?"Setup instructions copied -- paste them into WhatsApp/email.":"Copy failed -- select and copy manually.");
    }

    function connectStore(platform){
      if(!Array.isArray(state.storeConnections)) state.storeConnections=[];
      const map={
                woocommerce:{url:"wooStoreUrl",fields:{key:"wooKey",secret:"wooSecret"},intakeFn:"woo-order-intake",requireSecret:true,label:"WooCommerce"},
        web:{url:"webEndpoint",fields:{key:"webKey"},intakeFn:"web-order-intake",requireSecret:false,label:"Custom Web/API"}
      };
      const cfg=map[platform]; if(!cfg) return;
      const storeUrl=(document.getElementById(cfg.url).value||"").trim();
      if(!storeUrl){ toast(platform==="web" ? "Enter your status update URL first." : "Enter your store URL first."); return; }

      // Real, live connection for both platforms: calls the NovaX backend
      // and actually wires up automated order intake + status sync. Credentials
      // are stored securely server-side (never in browser state/localStorage).
      const consumerKey=(document.getElementById(cfg.fields.key).value||"").trim();
      const consumerSecret=cfg.fields.secret ? (document.getElementById(cfg.fields.secret).value||"").trim() : "";
      if(platform!=="web" && !consumerKey){ toast("Enter your Consumer Key first."); return; }
      if(cfg.requireSecret && !consumerSecret){ toast("Enter your Consumer Secret first."); return; }
      if(!window.__nvSb){ toast("Cloud connection not ready yet, please try again in a moment."); return; }
      toast("Connecting to "+cfg.label+"...");
      window.__nvSb.rpc("client_set_store_credentials", {
        p_platform: platform,
        p_store_url: storeUrl,
        p_consumer_key: consumerKey,
        p_consumer_secret: consumerSecret
      }).then(function(r){
        if(r && r.error){ toast("Connection failed: "+r.error.message); return; }
        const row = r && r.data && r.data[0];
        Object.keys(cfg.fields).forEach(k=>{ const el=document.getElementById(cfg.fields[k]); if(el) el.value=""; });
        let conn=storeConn(platform);
        if(!conn){ conn={ clientId:activeClientId(), platform }; state.storeConnections.push(conn); }
        conn.storeUrl=storeUrl; conn.hasCreds=true; conn.connected=true; conn.connectedAt=time();
        saveState(); renderIntegrations();
        if(row){
          const intakeUrl=SB_URL.replace(/\/$/,"")+"/functions/v1/"+cfg.intakeFn+"/"+row.intake_token;
          if(platform==="woocommerce"){
            showWooWebhookResult(intakeUrl, row.webhook_secret);
            toast("WooCommerce connected. Copy the webhook details below into your store.");
          } else {
            const urlEl=document.getElementById("webIntakeUrlOut"); if(urlEl) urlEl.value=intakeUrl;
            const secretEl=document.getElementById("webSecretOut"); if(secretEl) secretEl.value=row.webhook_secret;
            const box=document.getElementById("webWebhookResult"); if(box) box.style.display="block";
            toast("Custom Web/API connected. Send the details below to your developer.");
          }
        } else {
          // NovaX fix (confidence messaging): plain "connected" left it unclear
          // whether orders would start flowing immediately. Distinguish
          // "connected" (credentials saved, live) from "pending configuration"
          // (still needs the webhook/URL step) so the client knows what to do.
          toast(cfg.label+" connected. Store is pending configuration -- finish the webhook setup below to start receiving orders.");
        }
      }).catch(function(e){ toast("Connection failed: "+e); });
    }

    function showWooWebhookResult(intakeUrl, secret){
      const box=document.getElementById("wooWebhookResult");
      if(!box){ alert("Webhook Delivery URL:\n"+intakeUrl+"\n\nSecret:\n"+secret); return; }
      const urlEl=document.getElementById("wooIntakeUrlOut"); if(urlEl) urlEl.value=intakeUrl;
      const secretEl=document.getElementById("wooSecretOut"); if(secretEl) secretEl.value=secret;
      box.style.display="block";
    }

    function copyFieldValue(elId){
      const el=document.getElementById(elId); if(!el) return;
      el.removeAttribute("readonly"); el.select(); el.setSelectionRange(0,99999); el.setAttribute("readonly","readonly");
      let ok=false;
      try{ if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(el.value); ok=true; } }catch(e){}
      if(!ok){ try{ document.execCommand("copy"); ok=true; }catch(e){} }
      toast(ok?"Copied.":"Select the text and copy manually.");
    }
    function syncStoreOrders(platform){
      // NovaX fix (item 6): this used to create 2-4 fake random orders with
      // made-up names/cities/COD amounts every click -- a live "Sync Now"
      // button that could inject fictional bookings straight into the live
      // portal. Real orders only ever arrive through the store's own webhook
      // calling the order-intake edge function automatically; there is no
      // manual pull, so this no longer creates any parcels.
      const conn=storeConn(platform);
      if(!conn||!conn.connected){ toast("Save the "+platformLabel(platform)+" connection first."); return; }
      toast(platformLabel(platform)+" orders sync automatically via your store's webhook -- there is no manual import. Last sync: "+(conn.lastSync||"never yet")+".");
    }
    function renderIntegrations(){
      // NovaX fix: Shopify no longer lives in the generic storeConnections
      // chip logic (that reads local/legacy `store_connections` state) --
      // it has its own backend-verified status via client_shopify_status(),
      // so it must never be overwritten to "Not connected" by this generic
      // loop. Only WooCommerce and Custom Web/API still use the chip() path.
      const chip=(p,id)=>{ const c=storeConn(p); const el=document.getElementById(id); if(!el) return; const on=c&&c.connected; el.textContent=on?("Connected"+(c.importedCount?(" &middot; "+c.importedCount+" imported"):"")):"Not connected"; el.className="chip "+(on?"good":""); };
      chip("woocommerce","wooStatusChip"); chip("web","webStatusChip");
      const prefill={woocommerce:"wooStoreUrl",web:"webEndpoint"};
      Object.keys(prefill).forEach(p=>{ const c=storeConn(p); const el=document.getElementById(prefill[p]); if(c&&el&&!el.value) el.value=c.storeUrl||""; });
      if(typeof shopifyCheckStatus==="function") shopifyCheckStatus();
    }
    function newBookedParcels(){ return (state.parcels||[]).filter(p=>p.clientId===activeClientId()&&p.status==="New booked"); }
    function renderNewBookedList(){
      const list=document.getElementById("newBookedList"); if(!list) return;
      const items=newBookedParcels();
      if(!items.length){ list.innerHTML=`<div class="ops-card"><strong>No new booked parcels yet</strong><p class="footer-note">Printable AWB labels appear here the moment a parcel is booked.</p><div class="inline-actions" style="margin-top:8px;flex-wrap:wrap;gap:6px"><button class="action-btn" data-nv-cock="tab" data-tab="newBooking">Book a parcel</button><button class="ghost-btn" data-nv-cock="tab" data-tab="bulkBooking">Upload bulk CSV</button><button class="ghost-btn" data-nv-cock="tab" data-tab="integrations">Sync your store</button></div></div>`; return; }
      list.innerHTML=items.map(p=>`<label class="ops-card" style="display:flex;align-items:center;gap:10px;margin-bottom:8px;cursor:pointer"><input type="checkbox" class="newbooked-check" value="${escLabelText(p.awb)}" checked><span style="flex:1"><strong>${escLabelText(p.awb)}</strong> &middot; ${escLabelText(p.consignee)} &middot; ${escLabelText(p.city)} &middot; ${money(p.cod)}${p.source?` &middot; <span class="chip info">${escLabelText(p.source)}</span>`:""}</span><button class="ghost-btn" onclick="printLabels(['${p.awb}'])">Print</button><button class="ghost-btn" title="Delete this booking" onclick="event.preventDefault();event.stopPropagation();deleteNewBooking('${escLabelText(p.awb)}')" style="color:#b91c1c;border-color:#f0b4ac">Delete</button></label>`).join("");
    }
    /* NovaX new: delete a parcel booked with wrong details (wrong COD,
       wrong number, wrong address). Server-side this is only permitted
       while the parcel is still "New booked" and un-invoiced -- once a
       rider has collected it a physical parcel exists and it has to be
       tracked to an end state instead. The RPC also re-checks ownership,
       so this button can never delete someone else's parcel. */
    function deleteNewBooking(awb){
      if(!awb) return;
      var p=(state.parcels||[]).find(function(x){ return x.awb===awb; });
      var label=p?(awb+" for "+(p.consignee||"")+(Number(p.cod)?(" · COD "+money(p.cod)):"")):awb;
      if(!confirm("Delete booking "+label+"?\n\nThis removes the parcel completely. Only possible before a rider collects it.")) return;
      if(!window.__nvSb||!window.__nvSb.rpc){ toast("Cloud connection not ready.","error"); return; }
      window.__nvSb.rpc("delete_new_booked_parcel",{ p_awb:awb }).then(function(r){
        if(r&&r.error){ toast("Could not delete: "+r.error.message,"error"); return; }
        state.parcels=(state.parcels||[]).filter(function(x){ return x.awb!==awb; });
        if(state.selectedAwb===awb) state.selectedAwb="";
        if(state.lastGeneratedAwb===awb) state.lastGeneratedAwb="";
        saveState();
        toast(awb+" deleted.","success");
        try{ render(); }catch(e){}
        try{ loadAll(); }catch(e){}
      }).catch(function(e){ toast("Could not delete: "+((e&&e.message)||e),"error"); });
    }
    function selectAllNewBooked(){ const boxes=document.querySelectorAll(".newbooked-check"); const allOn=Array.from(boxes).every(b=>b.checked); boxes.forEach(b=>{ b.checked=!allOn; }); }
    function printNewBookedSelected(){ const awbs=Array.from(document.querySelectorAll(".newbooked-check")).filter(b=>b.checked).map(b=>b.value); if(!awbs.length){ toast("Select at least one new booked AWB."); return; } printLabels(awbs); }
    // NovaX (Part 4, pickup request flow): an AWB has an "active" pickup
    // request if some prior request that still includes it has not reached
    // a terminal Picked Up state yet -- used both to block duplicate
    // requests and to grey out already-requested AWBs in the picker.
    function activePickupAwbs(){
      const set=new Set();
      // NovaX (Pickup Request Flow): Picked Up and Cancelled are terminal --
      // an AWB frees up for a new pickup request once its last request lands
      // in either state.
      const terminal=["Picked Up","Cancelled"];
      (state.pickupRequests||[]).forEach(function(pr){ if(!terminal.includes(pr.status)){ (pr.awbs||[]).forEach(function(a){ set.add(a); }); } });
      return set;
    }
    function pickupEligibleParcels(){
      const active=activePickupAwbs();
      return newBookedParcels().filter(function(p){ return !active.has(p.awb); });
    }
    function renderPickupEligibleList(){
      const list=document.getElementById("pickupEligibleList"); if(!list) return;
      const items=pickupEligibleParcels();
      if(!items.length){ list.innerHTML=`<p class="footer-note">No New booked AWBs are available for pickup right now.</p>`; return; }
      list.innerHTML=items.map(p=>`<label class="ops-card" style="display:flex;align-items:center;gap:10px;margin-bottom:8px;cursor:pointer"><input type="checkbox" class="pickup-check" value="${escLabelText(p.awb)}"><span style="flex:1"><strong>${escLabelText(p.awb)}</strong> &middot; ${labelText(p.consignee)} &middot; ${labelText(p.city)} &middot; ${money(p.cod)}</span></label>`).join("");
    }
    function renderPickupRequestList(){
      const list=document.getElementById("pickupRequestList"); if(!list) return;
      const items=(state.pickupRequests||[]).slice().sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
      if(!items.length){ list.innerHTML=`<p class="footer-note">No pickup requests yet.</p>`; return; }
      // NovaX (Pickup Request Flow): full status vocabulary --
      // Requested -> Assigned -> Rider dispatched -> Picked Up, or Cancelled.
      // "Scheduled" is kept mapped for any older requests saved before this update.
      const chipClass={ Requested:"warn", Assigned:"info", "Rider dispatched":"info", Scheduled:"info", "Picked Up":"good", Cancelled:"bad" };
      list.innerHTML=items.map(pr=>{
        const cls=chipClass[pr.status]||"warn";
        const awbList=(pr.awbs||[]).map(a=>escLabelText(a)).join(", ");
        return `<div class="ops-card" style="margin-bottom:8px"><div class="ops-card-head"><strong>${(pr.awbs||[]).length} AWB(s)</strong><span class="chip ${cls}">${escLabelText(pr.status)}</span></div><p class="footer-note">${awbList}</p><p class="footer-note">Pickup: ${labelText(pr.pickupAddress,"-")}${pr.requestedFor?(" &middot; "+labelText(pr.requestedFor)):""}</p></div>`;
      }).join("");
    }
    function requestPickup(){
      const boxes=Array.from(document.querySelectorAll(".pickup-check")).filter(b=>b.checked);
      const awbs=boxes.map(b=>b.value);
      if(!awbs.length){ toast("Select at least one AWB before requesting pickup."); return; }
      const active=activePickupAwbs();
      const dupes=awbs.filter(a=>active.has(a));
      if(dupes.length){ toast("These AWBs already have an active pickup request: "+dupes.join(", "),"error"); return; }
      const address=(document.getElementById("pickupAddress")?.value||"").trim();
      if(!address){ toast("Enter a pickup address before requesting pickup."); return; }
      const requestedFor=(document.getElementById("pickupRequestedFor")?.value||"").trim();
      const note=(document.getElementById("pickupNote")?.value||"").trim();
      const id="PR-"+Date.now().toString(36).toUpperCase();
      state.pickupRequests=state.pickupRequests||[];
      state.pickupRequests.unshift({ id:id, clientId:activeClientId(), awbs:awbs, pickupAddress:address, requestedFor:requestedFor, note:note, status:"Requested", riderId:"", createdAt:new Date().toISOString() });
      saveState();
      const addressEl=document.getElementById("pickupAddress"); if(addressEl) addressEl.value="";
      const notedEl=document.getElementById("pickupNote"); if(notedEl) notedEl.value="";
      const forEl=document.getElementById("pickupRequestedFor"); if(forEl) forEl.value="";
      renderPickupEligibleList(); renderPickupRequestList();
      toast(`Pickup requested for ${awbs.length} AWB(s). We will confirm scheduling shortly.`);
    }
    /* Runs each renderer in isolation. A thrown error is reported once per
       renderer per session -- repeating it on every render would flood the
       console and bury the first, most useful trace. */
    var NV_RENDER_FAILED = Object.create(null);
    function nvSafeRender(pairs){
      for (var i = 0; i < pairs.length; i++) {
        var name = pairs[i][0], fn = pairs[i][1];
        if (typeof fn !== "function") continue;
        try {
          fn();
        } catch (e) {
          if (!NV_RENDER_FAILED[name]) {
            NV_RENDER_FAILED[name] = true;
            console.warn("NovaX: the " + name + " panel failed to render.", e);
            try {
              if (window.__nvSb && window.__nvSb.rpc) {
                window.__nvSb.rpc("log_portal_error", {
                  p_source: "client", p_rpc_name: "render:" + name, p_page: "portal",
                  p_message: String((e && e.message) || e).slice(0, 400), p_severity: "error",
                });
              }
            } catch (e2) { /* reporting must never break rendering */ }
          }
        }
      }
    }

    function render(){
      try{ applyPickupCity(); }catch(e){}
      try{ renderCodHero(); }catch(e){}
      /* Fourteen renderers ran bare on one line. Any one of them throwing --
         a null parcel, an unexpected shape from the server, a missing element
         after a markup change -- aborted the whole chain, so everything after
         it never painted and the merchant saw a half-drawn portal with no
         error. This is the cheapest structural change in the file: the same
         failure now costs one missing panel instead of the page.

         The name is passed so the console says WHICH renderer failed rather
         than leaving a stack trace to be matched up by hand. */
      nvSafeRender([
        ["metrics", renderMetrics], ["statusBoard", renderClientStatusBoard],
        ["parcels", renderClientParcels], ["journey", renderJourney],
        ["modules", renderClientModules], ["reportFull", renderClientReportFull],
        ["wallet", renderClientWallet], ["bulkPreview", renderBulkPreview],
        ["integrations", renderIntegrations], ["newBooked", renderNewBookedList],
        ["pickupEligible", renderPickupEligibleList], ["pickupRequests", renderPickupRequestList],
        ["zoneRateHint", updateZoneRateHint],
      ]);
      // NovaX fix (client identity leak): the Client Menu workspace label used
      // to be a hard-coded demo workspace name string in the HTML, so it
      // never reflected the actual logged-in client. Always derive it from
      // clientDisplayLabel(), which never falls through to a cached/demo
      // client name -- it shows a clear "Verifying account...", "Account not
      // linked", or "Client record missing" state instead whenever the real
      // identity isn't confirmed.
      try{ if(typeof window.nvFillBusinessName === "function") window.nvFillBusinessName(state.client && state.client.name); }catch(e){}
      const workspaceName = document.getElementById("clientWorkspaceName");
      if (workspaceName) { const cds=clientDisplayState(); workspaceName.textContent = cds.showWorkspaceSuffix ? `${cds.label} workspace` : cds.label; }
      try{ if(typeof renderDashboardEmptyState==="function") renderDashboardEmptyState(); }catch(e){}
      try{ if(typeof renderDailyCommandCenter==="function") renderDailyCommandCenter(); }catch(e){}
      /* NovaX new (Smart Portal E): once-per-session insight fetch. Guarded
         internally by NV_INSIGHTS.fetched, so calling it from a render path
         that runs repeatedly is safe. */
      try{ if(typeof nvLoadInsights==="function") nvLoadInsights(); }catch(e){}
      tickMeters();
    }
    function tickMeters(){ requestAnimationFrame(()=>{ document.querySelectorAll(".meter>span").forEach(s=>{ const w=s.style.width; s.style.width="0"; requestAnimationFrame(()=>{ s.style.width=w; }); }); }); }
    /* ═══ Tab identity ═══════════════════════════════════════════════════
       Payments and Wallet merged into one "Money" tab. state.activeClientTab
       is persisted to localStorage and was only ever defaulted with
       `|| "dashboard"` -- which catches falsy, never an UNKNOWN id. Any
       merchant whose last session ended on Payments or Wallet would restore a
       tab id matching no .client-module and get a blank portal with no error.
       Every legacy id is aliased here, so the ~12 existing
       showClientTab("wallet") / data-client-tab="payments" call sites across
       the cockpit, AI panel, command palette, coach tips and onboarding tour
       keep working untouched. */
    /* Both tables live INSIDE the function on purpose. They were module-level
       `var`s, and normalizeClientTab() is called during state restore near the
       top of the file -- long before that assignment runs. `var` hoists the
       declaration but not the value, so NV_TAB_ALIASES was undefined at call
       time and the whole portal died on
         TypeError: Cannot read properties of undefined (reading 'wallet')
       A function declaration is fully hoisted, so keeping the data inside it
       makes the call safe from any point in the file. */
    function normalizeClientTab(id){
      var TABS = ["dashboard","newBooking","awbLabel","bulkBooking","integrations",
                  "reports","money","logs","subAccounts","tickets","support"];
      var ALIASES = { wallet:"money", payments:"money", payment:"money", invoices:"money" };
      var v = String(id || "").trim();
      if(ALIASES[v]) v = ALIASES[v];
      return TABS.indexOf(v) > -1 ? v : "dashboard";
    }

    function showClientTab(id){ id=(typeof normalizeClientTab==="function")?normalizeClientTab(id):id; if(typeof nvCanUseTab==="function" && !nvCanUseTab(id)){ try{ toast("Your role does not have access to that section."); }catch(e){} id="dashboard"; } state.activeClientTab=id; saveState(); renderClientModules(); if(id==="newBooking"){ try{ nvRestoreBookingDraft(); }catch(e){} } try{ nvRenderBottomNav(); }catch(e){} renderClientReportFull();  renderClientWallet(); renderBulkPreview(); renderIntegrations(); renderNewBookedList(); renderPickupEligibleList(); renderPickupRequestList(); tickMeters(); try{ renderClientActionNeeded(); }catch(e){} if(id==="support"){ try{ loadClientNotificationPrefs(); }catch(e){} } if(window.innerWidth<760){ document.getElementById("clientMenu").classList.remove("open"); document.getElementById("clientMenuToggle").setAttribute("aria-expanded","false"); } }
    function toast(msg,type){ const el=document.getElementById("toast"); el.textContent=msg; el.classList.remove("success","error"); const kind=type||(/reject|error|fail|invalid|required|not found|denied|declined|unable to|cannot|exceeds|locked|missing|expired|wrong|incorrect/i.test(msg)?"error":/success|updated|saved|added|created|removed|deleted|sent|completed|confirmed|assigned|cleared|credited|approved|connected|synced|scheduled|logged|generated|marked|reset|unlocked|linked|merged|archived|restored|paid|printed|exported|imported|will reach/i.test(msg)?"success":""); if(kind) el.classList.add(kind); el.classList.add("show"); /* One hook here rather than at 21 call sites: every existing success and error toast now carries a haptic, and any future one does automatically. */ try{ nvHaptic(kind==="error"?"error":(kind==="success"?"success":null)); }catch(e){} clearTimeout(window.toastTimer); window.toastTimer=setTimeout(()=>el.classList.remove("show"),2800); }

    /* Events */
    document.querySelectorAll(".client-tab").forEach(b=>b.addEventListener("click",()=>showClientTab(b.dataset.clientTab)));
    document.querySelectorAll("[data-client-tab]:not(.client-tab)").forEach(b=>b.addEventListener("click",()=>showClientTab(b.dataset.clientTab)));
    document.getElementById("clientMenuToggle").addEventListener("click",()=>{ const m=document.getElementById("clientMenu"); const o=m.classList.toggle("open"); document.getElementById("clientMenuToggle").setAttribute("aria-expanded",String(o)); });

    /* ═══ Value-change motion ═══════════════════════════════════════════
       When a figure changes, pulse it and tint it green (up) or amber
       (down) for a moment. Purely cosmetic and strictly observational:
       it reads textContent and adds a CSS class. It NEVER writes a value,
       so a displayed number can never be altered or delayed by this.
       Whole thing is wrapped in try/catch — if it fails the portal is
       exactly as it was before. */
    (function nvValueMotion(){
      try{
        if(window.__nvValueMotion) return; window.__nvValueMotion=true;
        if(!("MutationObserver" in window)) return;
        if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;

        var SEL=".money-box strong,.metric strong,.nv-inc-amt,.nv-ins-stat strong";
        var num=function(t){
          var m=String(t==null?"":t).replace(/[^0-9.\-]/g,"");
          var n=parseFloat(m); return isFinite(n)?n:null;
        };
        var last=new WeakMap();

        function watch(el){
          if(!el||last.has(el)) return;
          last.set(el,num(el.textContent));
        }
        function check(el){
          if(!el) return;
          var now=num(el.textContent);
          if(now===null){ return; }
          if(!last.has(el)){ last.set(el,now); return; }
          var was=last.get(el);
          last.set(el,now);
          if(was===null||was===now) return;
          var dir=now>was?"nv-bump-up":"nv-bump-down";
          el.classList.remove("nv-bump","nv-bump-up","nv-bump-down");
          void el.offsetWidth;                    // restart the animation
          el.classList.add("nv-bump",dir);
          setTimeout(function(){ el.classList.remove("nv-bump-up","nv-bump-down"); },1000);
          setTimeout(function(){ el.classList.remove("nv-bump"); },600);
        }

        document.querySelectorAll(SEL).forEach(watch);

        var pending=false;
        var mo=new MutationObserver(function(){
          if(pending) return; pending=true;
          requestAnimationFrame(function(){
            pending=false;
            try{ document.querySelectorAll(SEL).forEach(check); }catch(e){}
          });
        });
        mo.observe(document.body,{childList:true,subtree:true,characterData:true});
      }catch(e){ /* cosmetic only — never surface */ }
    })();
    document.getElementById("clientSearch").addEventListener("input",renderClientParcels);
    document.getElementById("applyDateRangeBtn").addEventListener("click",applyClientDateRange);
    document.getElementById("bookParcelBtn").addEventListener("click",()=>showClientTab("newBooking"));
    document.getElementById("quickBookingBtn").addEventListener("click",quickBooking);
    /* BUG FIX: the desktop "+ Book Parcel" floating button (#nvDesktopQuickBook,
       visible at >=901px, bottom-right) had NO event listener at all. It is the
       largest, greenest, most prominent control on the page, so merchants who
       had just filled in the whole booking form clicked it to submit -- and
       nothing happened, with no error, because nothing was ever bound to it.
       The mobile sticky bar proxies to #quickBookingBtn; desktop never did.

       Behaviour now matches what the label implies in each context:
         * already on New Booking with details entered -> submit the booking
           (delegates to the real button so all validation, duplicate checks,
           in-flight guard and error surfacing run exactly once)
         * anywhere else, or an empty form -> jump to the New Booking form */
    (function(){
      var fab=document.getElementById("nvDesktopQuickBook");
      if(!fab) return;
      fab.addEventListener("click",function(){
        var real=document.getElementById("quickBookingBtn");
        var pane=document.getElementById("client-newBooking");
        var onBookingTab=!!(pane && pane.offsetParent!==null);
        /* Checked directly against the DOM rather than via
           bookingFormPercent(), which is declared much further down in a
           different scope -- depending on it here would silently fall back
           to "empty" and the button would navigate instead of submitting. */
        var filled=false;
        try{
          filled=["bookingName","bookingPhone","bookingCod","bookingAddress","bookingCategory"]
            .some(function(id){
              var el=document.getElementById(id);
              return !!(el && String(el.value||"").trim());
            });
        }catch(e){ filled=false; }
        if(onBookingTab && real && !real.disabled && filled){ real.click(); return; }
        try{ showClientTab("newBooking"); }catch(e){}
        try{
          var first=document.getElementById("bookingName");
          if(first) setTimeout(function(){ try{ first.focus(); }catch(e){} },220);
        }catch(e){}
      });
    })();
    (function(){ var b=document.getElementById("nvPasteFillBtn"); if(b) b.addEventListener("click",applyPastedOrder); })();
    document.getElementById("downloadBulkTemplateBtn").addEventListener("click",downloadBulkTemplate);
    /* BUG: this bound Upload with no disable, and importBulkRows walks the
       rows one RPC at a time with no in-flight flag. On Karachi mobile data a
       merchant sees nothing happen for 30 seconds, clicks again, and books
       every row twice -- real, billable parcels. quickBooking already guards
       itself; bulk did not. */
    document.getElementById("bulkUploadBtn").addEventListener("click",function(){
      var btn=this;
      if(btn.disabled || window.__nvBulkUploadInFlight) return;
      window.__nvBulkUploadInFlight=true;
      var label=btn.textContent;
      btn.disabled=true; btn.textContent="Uploading\u2026";
      Promise.resolve()
        .then(function(){ return uploadBulkCsv(); })
        .catch(function(e){ console.warn("NovaX bulk upload",e); })
        .then(function(){
          window.__nvBulkUploadInFlight=false;
          btn.disabled=false; btn.textContent=label;
        });
    });
    document.getElementById("bulkPrintAllBtn").addEventListener("click",()=>printLabels(state.lastBulkAwbs||[]));
    document.getElementById("printAwbBtn").addEventListener("click",printAwb);
    document.getElementById("newBookedSelectAllBtn")?.addEventListener("click",selectAllNewBooked);
    document.getElementById("newBookedPrintBtn")?.addEventListener("click",printNewBookedSelected);
    document.getElementById("requestPickupBtn")?.addEventListener("click",requestPickup);
    document.getElementById("awbModalPrint").addEventListener("click",()=>printLabels([state.lastGeneratedAwb]));
    nvApplyPrintMode();
    document.getElementById("reportCsvBtn").addEventListener("click",exportReportCsv);
    document.getElementById("reportPdfBtn").addEventListener("click",exportReportPdf);
    document.getElementById("repClearBtn").addEventListener("click",()=>{ ["repSearch","repFrom","repTo"].forEach(i=>{const e=document.getElementById(i);if(e)e.value="";}); const s=document.getElementById("repStatus"); if(s)s.value=""; renderClientReportFull(); });
    ["repSearch","repStatus","repFrom","repTo"].forEach(id=>{ const e=document.getElementById(id); if(e) e.addEventListener(e.tagName==="SELECT"?"change":"input",renderClientReportFull); });
    document.querySelectorAll(".tier-card").forEach(t=>t.addEventListener("click",()=>{ t.classList.remove("just-picked"); void t.offsetWidth; t.classList.add("just-picked"); selectWalletSpeed(t.dataset.speed); }));
    document.getElementById("withdrawAmount").addEventListener("input",renderClientWallet);
    // NovaX fix (withdrawal UX v3): mark the IBAN field "touched" the moment
    // a client edits it, so the auto-prefill-from-saved-bank-details logic
    // in renderClientWallet never overwrites what they just typed/pasted.
    document.getElementById("withdrawIbanInput")?.addEventListener("input",function(){ this.dataset.touched="1"; renderClientWallet(); });
    // NovaX fix (AI tab XSS): bot replies are engine/server text, so nothing
    // reaching this bubble is trusted any more. Everything is escaped first
    // and only a tiny whitelist (<b>, <br>) is re-enabled afterwards, matching
    // the floating Autopilot widget's textContent-level safety.
    function novaxAiSafeHtml(text){
      var esc=String(text===undefined||text===null?"":text).replace(/[&<>"]/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; });
      return esc.replace(/&lt;(\/?)(b|br)\s*\/?&gt;/gi,function(m,slash,tag){ return "<"+slash+tag.toLowerCase()+">"; });
    }
    function clientAiTabBubble(html,isBot){ const box=document.getElementById("clientAi"); if(!box) return; const d=document.createElement("div"); d.className="bubble"+(isBot?" ai":""); d.innerHTML=novaxAiSafeHtml(html); box.appendChild(d); box.scrollTop=box.scrollHeight; }
    function sendClientAiTabMessage(){
      const el=document.getElementById("clientAiInput"); if(!el) return;
      const v=(el.value||"").trim(); if(!v) return;
      const escFn=window.novaxAiEsc||(s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])));
      // NovaX fix: no pre-escaping here any more -- clientAiTabBubble() now
      // escapes everything itself, so escaping twice would show entities.
      clientAiTabBubble(v,false);
      el.value="";
      // NovaX fix: the AI tab used to give up permanently with "AI is still
      // loading" the instant window.novaxAiEngine was not yet set on that
      // very first check. Since the engine is set synchronously right at
      // page load, this should be near-instant -- but to make the assistant
      // reliable (it is pitched as a full customer-support replacement) we
      // now retry a few times over ~1.5s before giving up, instead of
      // failing on the first check.
      let attempts=0;
      const tryAnswer=()=>{
        attempts++;
        if(!window.novaxAiEngine){
          if(attempts<6){ setTimeout(tryAnswer,250); return; }
          clientAiTabBubble("AI is still loading, please try again in a moment.",true);
          return;
        }
        try{
          const r=window.novaxAiEngine(v);
          clientAiTabBubble(r.text,true);
        }catch(e){ clientAiTabBubble("Sorry, something went wrong reading the data. Please try again.",true); }
      };
      setTimeout(tryAnswer,150);
    }
    /* Removed 25 Aug 2026: bound #clientAiSendBtn and #clientAiInput, neither of
       which exists. The real composer binds in the nvAi module below. */
    /* Both "Ask AI" entry points now open the NovaX AI console and focus
       its composer. #askAiBtn2 was removed with the old panel, so it is
       bound defensively. */
    (function(){
      function openNovaAi(){
        try{ showClientTab("support"); }catch(e){}
        setTimeout(function(){
          var el=document.getElementById("nvAiInput");
          if(el) el.focus();
        },120);
      }
      var a1=document.getElementById("askAiBtn");  if(a1) a1.addEventListener("click",openNovaAi);
      var a2=document.getElementById("askAiBtn2"); if(a2) a2.addEventListener("click",openNovaAi);
    })();
    /* ===== NovaX fix (fake invite flow + fake sub accounts + real roles) =====
       Deleted from this spot: a global document.querySelectorAll("button")
       listener that attached a click handler to EVERY button on the page and
       faked an "Invite user flow opened" toast for anything whose label text
       happened to read "Invite User".

       Sub accounts are now read from the RLS-scoped public.staff_users table
       and invites/revokes go through real server calls that report failure
       honestly instead of faking success.

       Server contract this UI expects (RLS: a row is visible only when
       client_id matches the caller's client):
         table public.staff_users(
           id uuid primary key, client_id uuid not null,
           name text, email text,
           role text check (role in ('Owner','Finance','Warehouse','Support')),
           permissions jsonb, status text default 'active',
           last_active_at timestamptz, invited_at timestamptz)
         rpc invite_staff_user(p_name text, p_email text, p_role text)
         rpc revoke_staff_user(p_staff_id uuid)
       If a table/RPC is missing, the UI says exactly what is missing. */
    var NOVAX_ROLE_TABS = {
      // "money" replaces the old payments + wallet pair. Finance keeps access
      // to it, because withdrawal is now guarded at SECTION level by
      // nvGuardWalletRender() rather than by which tab a role can open --
      // the old split was quietly acting as the permission boundary, so
      // merging the tabs without this change would have handed every Finance
      // sub-account the ability to withdraw to any IBAN they typed.
      Owner:     ["dashboard","newBooking","awbLabel","bulkBooking","integrations","reports","money","logs","subAccounts","tickets","support"],
      Finance:   ["dashboard","reports","money","logs","tickets","support"],
      Warehouse: ["dashboard","newBooking","bulkBooking","awbLabel","support"],
      Support:   ["dashboard","logs","tickets","support"]
    };
    function nvClientRole(){ var r=window.__novaxClientRole; return NOVAX_ROLE_TABS[r]?r:"Owner"; }
    function nvRoleTabs(){ return NOVAX_ROLE_TABS[nvClientRole()]; }
    function nvCanUseTab(id){ return nvRoleTabs().indexOf(id)>-1; }
    function nvIsOwnerSeat(){ return nvClientRole()==="Owner"; }
    function nvRolePermissionSummary(role){
      if(role==="Finance") return "Invoices, payments and reports. No booking, no withdrawals.";
      if(role==="Warehouse") return "New booking, bulk booking, AWB labels and pickups only.";
      if(role==="Support") return "Tracking, order logs and WhatsApp replies only.";
      return "Full access, including the Wallet and withdrawals.";
    }
    var __nvRoleApplying=false;
    function nvApplyRolePermissions(){
      if(__nvRoleApplying) return;
      __nvRoleApplying=true;
      try{
        var allowed=nvRoleTabs();
        document.querySelectorAll(".client-tab").forEach(function(b){
          var ok=allowed.indexOf(b.dataset.clientTab)>-1;
          b.style.display=ok?"":"none";
          b.disabled=!ok;
        });
        if(!nvCanUseTab(state.activeClientTab)) showClientTab("dashboard");
        nvGuardWalletRender();
      }catch(e){}
      __nvRoleApplying=false;
    }
    // Wallet is Owner-only at the RENDER level, not just by hiding the tab:
    // the wallet panel body is replaced for every non-Owner seat, so a hidden
    // tab or a devtools CSS tweak cannot expose balances. renderClientWallet()
    // itself is untouched.
    function nvGuardWalletRender(){
      try{
        if(nvIsOwnerSeat()) return;
        // Was #client-wallet -- i.e. the whole tab. Now only the payout
        // controls are restricted, so a Finance seat can still read invoices,
        // balances and the ledger inside Money while remaining unable to move
        // money out. This is what makes the tab merge safe.
        var el=document.getElementById("nvWithdrawZone");
        if(el) el.innerHTML='<div class="ops-card"><div class="ops-card-head"><strong>Wallet is Owner-only</strong><span class="chip warn">restricted</span></div><p>Balances, withdrawal requests and bank details are visible only to the account Owner.</p></div>';
      }catch(e){}
    }
    var __nvStaffRows=null, __nvStaffError=null, __nvStaffLoading=false;
    function nvStaffRoleOptions(sel){ return ["Owner","Finance","Warehouse","Support"].map(function(r){ return '<option value="'+r+'"'+(r===sel?" selected":"")+">"+r+"</option>"; }).join(""); }
    function renderSubAccounts(){
      var host=document.getElementById("subAccountList");
      if(!host) return;
      if(__nvStaffLoading && !__nvStaffRows){ host.innerHTML='<div class="ops-card"><strong>Loading your team…</strong></div>'; return; }
      if(__nvStaffError){
        host.innerHTML='<div class="ops-card"><div class="ops-card-head"><strong>Could not load your team</strong><span class="chip bad">not available</span></div><p>'+escLabelText(__nvStaffError)+'</p><p class="footer-note">Needs table public.staff_users (client_id, name, email, role, permissions, status, last_active_at) with RLS scoped to your client id.</p></div>';
        return;
      }
      var rows=__nvStaffRows||[];
      if(!rows.length){
        host.innerHTML='<div class="ops-card"><div class="ops-card-head"><strong>No sub accounts yet</strong><span class="chip">empty</span></div><p>Invite your finance, warehouse or support staff so each person logs in with their own limited permissions instead of sharing your password.</p><div class="inline-actions" style="margin-top:8px"><button class="action-btn" id="subAccountEmptyInvite">Invite user</button></div></div>';
        var b0=document.getElementById("subAccountEmptyInvite");
        if(b0) b0.addEventListener("click",openInviteUserModal);
        return;
      }
      host.innerHTML=rows.map(function(r){
        var role=NOVAX_ROLE_TABS[r.role]?r.role:"Support";
        var st=String(r.status||"active").toLowerCase();
        var chip=(st==="active")?"good":((st==="revoked")?"bad":"warn");
        var last=r.last_active_at?String(r.last_active_at).slice(0,16).replace("T"," "):"never";
        return '<div class="ops-card"><div class="ops-card-head"><strong>'+escLabelText(r.name||r.email||"Team member")+'</strong><span class="chip '+chip+'">'+escLabelText(st)+'</span></div>'
          +'<p class="footer-note">'+escLabelText(r.email||"-")+'</p>'
          +'<p><strong>'+escLabelText(role)+'</strong> — '+escLabelText(nvRolePermissionSummary(role))+'</p>'
          +'<p class="footer-note">Last active '+escLabelText(last)+'</p>'
          +((st==="revoked")?"":'<div class="inline-actions" style="margin-top:6px"><button class="ghost-btn" data-nv-revoke="'+escLabelText(r.id)+'">Revoke</button></div>')
          +'</div>';
      }).join("");
      host.querySelectorAll("[data-nv-revoke]").forEach(function(b){
        b.addEventListener("click",function(){ revokeSubAccountUser(b.getAttribute("data-nv-revoke")); });
      });
    }
    function nvResolveMyRole(){
      try{
        var email=String(window.__novaxSessionEmail||"").toLowerCase();
        if(!email||!__nvStaffRows) return;
        var mine=__nvStaffRows.filter(function(r){ return String(r.email||"").toLowerCase()===email; })[0];
        window.__novaxClientRole=(mine&&NOVAX_ROLE_TABS[mine.role])?mine.role:"Owner";
        nvApplyRolePermissions();
      }catch(e){}
    }
    function loadSubAccounts(){
      var sb=window.__nvSb;
      if(!sb||!sb.from){ __nvStaffError="Not connected to the server yet — refresh once you are back online."; renderSubAccounts(); return; }
      __nvStaffLoading=true; renderSubAccounts();
      try{
        if(sb.auth&&sb.auth.getUser){
          sb.auth.getUser().then(function(u){
            try{ window.__novaxSessionEmail=(u&&u.data&&u.data.user&&u.data.user.email)||""; nvResolveMyRole(); }catch(e){}
          });
        }
      }catch(e){}
      // RLS scopes this to the caller's own client_id -- no client filter is
      // sent from the browser, exactly like the other per-seller reads.
      sb.from("staff_users").select("id,name,email,role,permissions,status,last_active_at").then(function(res){
        __nvStaffLoading=false;
        if(res&&res.error){ __nvStaffError=res.error.message||"public.staff_users is not available."; __nvStaffRows=null; }
        else { __nvStaffError=null; __nvStaffRows=(res&&res.data)||[]; nvResolveMyRole(); }
        renderSubAccounts();
      }).catch(function(e){ __nvStaffLoading=false; __nvStaffError=String((e&&e.message)||e); renderSubAccounts(); });
    }
    function openInviteUserModal(){
      if(!nvIsOwnerSeat()){ toast("Only the account Owner can invite users."); return; }
      var wrap=document.getElementById("nvInviteModal");
      if(!wrap){
        wrap=document.createElement("div");
        wrap.id="nvInviteModal";
        wrap.style.cssText="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(6,20,16,.55);padding:18px";
        wrap.innerHTML='<div class="ops-card" style="max-width:430px;width:100%;background:var(--card,var(--nvu-bg))">'
          +'<div class="ops-card-head"><strong>Invite a user</strong><button class="ghost-btn" id="nvInviteClose">Close</button></div>'
          +'<label class="footer-note" for="nvInviteName">Full name</label><input id="nvInviteName" type="text" placeholder="Ayesha Khan" style="width:100%;margin-bottom:8px">'
          +'<label class="footer-note" for="nvInviteEmail">Work email</label><input id="nvInviteEmail" type="email" placeholder="name@company.com" style="width:100%;margin-bottom:8px">'
          +'<label class="footer-note" for="nvInviteRole">Role</label><select id="nvInviteRole" style="width:100%;margin-bottom:8px">'+nvStaffRoleOptions("Support")+'</select>'
          +'<p class="footer-note" id="nvInviteHint"></p>'
          +'<div class="inline-actions" style="margin-top:8px"><button class="action-btn" id="nvInviteSend">Send invite</button></div></div>';
        document.body.appendChild(wrap);
        document.getElementById("nvInviteClose").addEventListener("click",closeInviteUserModal);
        document.getElementById("nvInviteSend").addEventListener("click",submitInviteUser);
        document.getElementById("nvInviteRole").addEventListener("change",function(){
          var h=document.getElementById("nvInviteHint"); if(h) h.textContent=nvRolePermissionSummary(this.value);
        });
        wrap.addEventListener("click",function(e){ if(e.target===wrap) closeInviteUserModal(); });
      }
      wrap.style.display="flex";
      var sel=document.getElementById("nvInviteRole"), h2=document.getElementById("nvInviteHint");
      if(sel&&h2) h2.textContent=nvRolePermissionSummary(sel.value);
      var n=document.getElementById("nvInviteName"); if(n) n.focus();
    }
    function closeInviteUserModal(){ var w=document.getElementById("nvInviteModal"); if(w) w.style.display="none"; }
    function submitInviteUser(){
      var name=String((document.getElementById("nvInviteName")||{}).value||"").trim();
      var email=String((document.getElementById("nvInviteEmail")||{}).value||"").trim();
      var role=String((document.getElementById("nvInviteRole")||{}).value||"Support");
      if(!name){ toast("Enter the person's full name."); return; }
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ toast("Enter a valid work email address."); return; }
      if(!NOVAX_ROLE_TABS[role]){ toast("Pick a valid role."); return; }
      sendStaffInvite(name,email,role);
    }
    // Single, clearly named seam for the server side of an invite. If the RPC
    // is not deployed the user is told precisely what is missing -- this never
    // fakes a success toast.
    function sendStaffInvite(name,email,role){
      var sb=window.__nvSb;
      if(!sb||!sb.rpc){ toast("Invite not sent: no server connection right now."); return; }
      toast("Sending invite…");
      sb.rpc("invite_staff_user",{ p_name:name, p_email:email, p_role:role }).then(function(res){
        if(res&&res.error){ toast("Invite not sent: "+(res.error.message||"invite_staff_user(p_name text, p_email text, p_role text) is not deployed yet.")); return; }
        toast(email+" invited as "+role+".");
        closeInviteUserModal();
        loadSubAccounts();
      }).catch(function(e){ toast("Invite not sent: "+String((e&&e.message)||e)); });
    }
    function revokeSubAccountUser(id){
      if(!id) return;
      if(!nvIsOwnerSeat()){ toast("Only the account Owner can revoke access."); return; }
      if(!window.confirm("Revoke this user's access to your portal?")) return;
      var sb=window.__nvSb;
      if(!sb||!sb.rpc){ toast("Not revoked: no server connection right now."); return; }
      sb.rpc("revoke_staff_user",{ p_staff_id:id }).then(function(res){
        if(res&&res.error){ toast("Not revoked: "+(res.error.message||"revoke_staff_user(p_staff_id uuid) is not deployed yet.")); return; }
        toast("Access revoked.");
        loadSubAccounts();
      }).catch(function(e){ toast("Not revoked: "+String((e&&e.message)||e)); });
    }
    var __nvInviteBtn=document.getElementById("inviteUserBtn");
    if(__nvInviteBtn) __nvInviteBtn.addEventListener("click",openInviteUserModal);
    setTimeout(function(){ try{ loadSubAccounts(); }catch(e){} },1200);

    /* NovaX fix (inline onclick on metric cards): metric cards now carry a
       data-metric-action attribute and these two delegated listeners handle
       every card in every grid, including re-rendered ones. */
    document.addEventListener("click",function(e){
      var el=(e.target&&e.target.closest)?e.target.closest("[data-metric-action]"):null;
      if(!el) return;
      handleMetricCardClick(el.getAttribute("data-metric-action"));
    });
    document.addEventListener("keydown",function(e){
      if(e.key!=="Enter"&&e.key!==" ") return;
      var el=(e.target&&e.target.closest)?e.target.closest("[data-metric-action]"):null;
      if(!el) return;
      e.preventDefault();
      handleMetricCardClick(el.getAttribute("data-metric-action"));
    });

    /* NovaX fix (silent stale data): a persistent, dismissible banner that
       tells the user the numbers on screen may be stale, instead of silently
       presenting cached data as live. Cleared automatically the moment real
       server data lands. */
    function nvShowStaleBanner(){
      if(window.__novaxRealDataArrived) return;
      if(document.getElementById("nvStaleBanner")) return;
      var b=document.createElement("div");
      b.id="nvStaleBanner";
      b.setAttribute("role","status");
      b.style.cssText="position:fixed;left:0;right:0;bottom:0;z-index:121;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;padding:10px 14px;background:var(--nvu-warn-fg);color:#fff;font-weight:700;font-size:13px";
      b.innerHTML='<span>Reconnecting — showing last known data, so numbers may be out of date.</span>'
        +'<button class="ghost-btn" id="nvStaleRetry" style="color:#fff;border:1px solid rgba(255,255,255,.55)">Retry now</button>'
        +'<button class="ghost-btn" id="nvStaleDismiss" style="color:#fff;border:1px solid rgba(255,255,255,.55)">Dismiss</button>';
      document.body.appendChild(b);
      var r=document.getElementById("nvStaleRetry");
      if(r) r.addEventListener("click",function(){ try{ if(window.__novaxReloadClientData) window.__novaxReloadClientData(); }catch(e){} });
      var d=document.getElementById("nvStaleDismiss");
      if(d) d.addEventListener("click",nvHideStaleBanner);
    }
    function nvHideStaleBanner(){ var b=document.getElementById("nvStaleBanner"); if(b&&b.parentNode) b.parentNode.removeChild(b); }
    window.__novaxMarkDataFresh=function(){ window.__novaxRealDataArrived=true; nvHideStaleBanner(); };
    nvInterval(()=>{ const el=document.getElementById("clockB"); if(el) el.textContent=`Live ${time()}`; },1000);

    // NovaX fix (withdrawal UX v3): saveBankDetails/editBankDetails/
    // cancelBankDetailsEdit/requestWalletWithdrawal were missing from this
    // export list, so their onclick="...()" attributes could silently fail
    // to resolve depending on scope timing -- explicitly exporting them
    // alongside the other wallet/bank functions guarantees they're callable.
    /* nvTkLoad is referenced from an inline onclick in the ticket-load
       error card, so it has to be reachable from the global scope -- a
       function that only exists inside this closure is not. */
    Object.assign(window,{ nvShowInFlight, nvQuickPickup, nvTkLoad, cancelClientBooking, isCancellableBooking, openClientParcelJourney, selectParcel, requestRedelivery, openAwbModal, closeAwbModal, downloadInvoiceCsv, printInvoice, viewInvoice, closeInvoiceModal, printLabels, confirmWalletWithdraw, requestWalletWithdrawal, selectWalletSpeed, closeWalletDone, saveBankDetails, editBankDetails, cancelBankDetailsEdit });
    window.addEventListener("storage", e => { if(e.key === STORAGE_KEY){ state = loadState(); render(); } });
    /* ===== NovaX data-ready safety net: guarantees isClientDataReady() eventually flips true even if a cloud sync path is missed ===== */
    window.__novaxClientDataReady = window.__novaxClientDataReady || false;
    // NovaX fix: this used to silently flip the data-ready flag after 4s, so
    // stale cached numbers were presented exactly as if they were live. The
    // flag still flips (the UI is never permanently blocked) but if no real
    // server data has arrived the user now sees a "Reconnecting" banner.
    setTimeout(function(){
      window.__novaxClientDataReady=true;
      if(!window.__novaxRealDataArrived){ try{ nvShowStaleBanner(); }catch(e){} }
    },4000);
    /* ===== NovaX secure per-seller data layer (RLS-scoped tables) ===== */
    (function(){
      var SB_URL=window.NOVAX_CONFIG.SB_URL;
      var SB_KEY=window.NOVAX_CONFIG.SB_KEY;
      /* The demo supplies its own client and never touches the network, so
         the CDN library is irrelevant to it. Without this exemption the whole
         data layer returns here and the demo renders an empty portal -- which
         is exactly what happened on the deployed site, where the Supabase CDN
         script is not available, while localhost (where it loads) worked. */
      if(!window.__NOVAX_DEMO && (!window.supabase||!window.supabase.createClient)){ console.warn("NovaX: cloud library not loaded, local only."); window.__novaxClientDataReady=true; return; }
      // NovaX fix ("Multiple GoTrueClient instances detected"): reuse the
      // client the auth gate already created instead of making a second one on
      // the same storage key.
      var sb; try{ sb=window.__nvSb||window.__nvGuardSb||window.supabase.createClient(SB_URL,SB_KEY); }catch(e){ console.warn("NovaX: cloud init failed, local only.",e); window.__novaxClientDataReady=true; return; }
      if(!sb){ console.warn("NovaX: cloud init failed, local only."); window.__novaxClientDataReady=true; return; }
      window.__nvSb=sb;
      // NovaX fix: expose a real reload so wallet-changing UI (withdrawal
      // requests) can pull the authoritative server state back down after
      // an RPC succeeds, instead of only trusting a local mirror forever.
      window.__novaxReloadClientData=function(){ try{ return loadAll(); }catch(e){} };
      // NovaX fix (URGENT order booking/processing spec): booking used to
      // write straight into local state and rely on a later direct browser
      // insert into public.parcels (see the now-disabled loop in syncNew()
      // below), which RLS could silently block -- leaving a parcel that only
      // ever existed on this one device. Every booking now goes through the
      // SECURITY DEFINER client_book_parcel RPC: the AWB/fee/row only exist
      // once Supabase has actually accepted them, and the exact Supabase
      // error is surfaced to the caller (console + toast) instead of a fake
      // local "reserved" parcel.
      /* A merchant should never be shown a Postgres error.

         The booking form used to print `r.error.message` straight onto the
         page, so a function-overload collision filled the screen with two
         full SQL signatures -- unreadable to the shopkeeper trying to book,
         and it puts the schema in front of anyone who asks for it. The raw
         error still goes to the console for us; the merchant gets a sentence
         telling them whether to retry, fix something, or call support. */
      function nvBookingError(err){
        var msg = String((err && err.message) || "");
        if (/could not choose the best candidate|is not unique/i.test(msg)) {
          return "Booking is temporarily unavailable while we finish a server update. " +
                 "Nothing was charged and no parcel was created. Please try again shortly, " +
                 "or send this parcel to support and we will book it for you.";
        }
        if (/row-level security|permission denied|not authorized/i.test(msg)) {
          return "Your account does not have permission to book this parcel. " +
                 "Please sign out and back in, or contact support if it keeps happening.";
        }
        if (/duplicate key|already exists/i.test(msg)) {
          return "This parcel looks like it has already been booked. " +
                 "Check your parcel list before booking it again.";
        }
        if (/violates check constraint|invalid input syntax|numeric/i.test(msg)) {
          return "One of the parcel details was not accepted — most often the COD amount " +
                 "or the weight. Please check those two fields and try again.";
        }
        if (/timeout|fetch|network|Failed to fetch/i.test(msg)) {
          return "We could not reach the server. Your parcel has NOT been booked — " +
                 "check your connection and try again.";
        }
        return msg || "Server rejected this booking.";
      }

      window.__novaxBookParcel=function(o){
        o=o||{};
        if(!sb||!MY) return Promise.reject(new Error("We're preparing your workspace. Refresh or sign in again."));
        var args={
          p_consignee:o.consignee||"",
          p_phone:o.phone||"",
          p_pickup_city:o.pickupCity||"Karachi",
          p_city:o.city||"",
          p_address:o.address||"",
          p_cod:Number(o.cod||0),
          p_weight:o.weight||"0.8 kg",
          p_service:o.service||"COD Standard",
          p_category:o.category||"",
          p_fragile:o.fragile||"No",
          p_payment_mode:o.paymentMode||"COD",
          p_order_id:o.orderId||"",
          p_reference_no:o.referenceNo||o.reference||o.ref||""
        };
        /* p_allow_open is only accepted once novax_allow_open_v1.sql has been
           run. Send it, and if the database has not been migrated yet, retry
           WITHOUT it rather than failing the booking. So the toggle simply has
           no effect until the migration lands — a booking is never blocked. */
        var argsWithOpen = Object.assign({}, args, { p_allow_open: (o.allowOpen==="Yes" ? "Yes" : "No") });

        /* NovaX distance pricing: when the merchant picked a delivery area we
           call client_book_parcel_geo(), which calls the ORIGINAL
           client_book_parcel() unchanged and then applies the distance fee.
           No area, or the RPC not deployed -> we fall through to exactly the
           call that has always been made. Flat pricing is never routed
           through the new code, and no existing parcel is affected. */
        /* NO SILENT FALLBACK.

           This block used to drop to flat pricing in two places: when no
           delivery area was picked, and when the geo RPC was missing. For a
           merchant who explicitly chose per-kilometre that means being charged
           a rate they did not agree to, with nothing on screen saying so --
           the exact behaviour this whole feature removes. A merchant on
           per-km now gets a refused booking and a reason instead of a
           surprise price. Flat merchants are untouched and never enter here. */
        var wantsDistance = (typeof nvPricingMode === "function") && nvPricingMode() === "distance";
        var isKarachiDest = String(o.city || "").trim().toLowerCase() === "karachi";

        if (wantsDistance && isKarachiDest && !o.destAreaId) {
          return Promise.reject(new Error(
            "You are on per-kilometre pricing and we do not have a delivery area for this parcel yet, so there is no distance to price it on. Pick the delivery area (or the nearest one) and book again — we will not put this parcel on the flat rate without asking."
          ));
        }

        if (o.destAreaId) {
          var geoArgs = Object.assign({}, argsWithOpen, {
            p_origin_area_id: null,            // server resolves the default pickup
            p_dest_area_id:  o.destAreaId
          });
          return Promise.resolve(sb.rpc("client_book_parcel_geo", geoArgs)).then(function(rg){
            var mg = (rg && rg.error && rg.error.message) || "";
            if (mg && /client_book_parcel_geo|does not exist|not find|schema cache|no function matches/i.test(mg)) {
              if (wantsDistance) {
                // Flat-pricing them here would be the silent substitution again.
                throw new Error("Per-kilometre pricing is not available on the server right now. Your parcel has not been booked, because we will not charge you the flat rate instead without asking. Please try again shortly or contact support.");
              }
              console.warn("NovaX: client_book_parcel_geo not deployed - booking on flat pricing.");
              return sb.rpc("client_book_parcel", argsWithOpen);
            }
            return rg;
          }).then(function(r){ return r; });
        }

        return Promise.resolve(sb.rpc("client_book_parcel", argsWithOpen)).then(function(r0){
          var m0 = (r0 && r0.error && r0.error.message) || "";
          /* Retrying without p_allow_open only helps when the 14-argument
             function is MISSING. If the database holds both overloads the
             13-argument call is ambiguous too, so retrying would just produce
             the same failure twice -- check for that first. */
          if (m0 && /could not choose the best candidate|is not unique/i.test(m0)) {
            return r0;
          }
          if (m0 && /p_allow_open|does not exist|not find|schema cache|without function|no function matches/i.test(m0)) {
            console.warn("NovaX: p_allow_open not deployed yet — booking without it. Run sql/novax_allow_open_v1.sql to enable the toggle.");
            return sb.rpc("client_book_parcel", args);
          }
          return r0;
        }).then(function(r){
          if(r&&r.error){
            console.error("NovaX client_book_parcel RPC failed:", r.error.message||r.error, r.error);
            throw new Error(nvBookingError(r.error));
          }
          var row=r&&r.data;
          if(!row||!row.id){
            console.error("NovaX client_book_parcel returned no row", r);
            throw new Error("Server did not confirm this booking. Please try again.");
          }
          var mapped=mapParcel(row);
          state.parcels.unshift(mapped);
          state.paymentLogs.unshift({ id:nextId("PAY",state.paymentLogs), clientId:MY, type:"COD expected", amount:Number(row.cod_amount||0), status:"Awaiting delivery", ref:row.awb });
          state.selectedAwb=row.awb; state.lastGeneratedAwb=row.awb; saveState();
          if(mapped._uuid) shadow[mapped._uuid]=(mapped.status||"")+"|"+(mapped.exception||"")+"|"+(mapped.awbPrinted?"1":"0")+"|"+(mapped.awbPrintedAt||"");
          try{ render(); }catch(e){ console.error("Post-booking render failed", e); }
          return mapped;
        });
      };
      var MY=null, loaded=false, shadow={}, subscribed=false;
      var TAGS=(typeof STATUS_TAGS!=="undefined"&&STATUS_TAGS&&STATUS_TAGS.length)?STATUS_TAGS:["New booked"];
      function stageOf(s){ var i=TAGS.indexOf(s); return i<0?0:i; }
      function stepsOf(s){ var i=stageOf(s); return i<=0?[TAGS[0]]:TAGS.slice(0,i+1); }
      function hrs(t){ if(!t) return 0; var ms=Date.now()-new Date(t).getTime(); return Number.isFinite(ms)?Math.max(0,ms/3600000):0; }
      /* BUG: these three were raw string slices of a timestamptz, so they
         printed the UTC clock -- five hours behind Karachi, and a full day out
         for anything booked after 7pm local, which is exactly when merchants
         book. It reached parcel rows, parcel cards, the Order Log, the wallet
         ledger, printed receipts, and the date-range filters that read dpart.

         The file already knew better: nvPktLabel a few thousand lines up pins
         Asia/Karachi and its comment says "a merchant checking from Dubai must
         see the same clock as their warehouse." These now do the same, so
         there is one timezone in the portal and it is the warehouse's.

         en-CA is used for the date because it formats as YYYY-MM-DD, which is
         what every caller compares and sorts on. */
      function nvKarachiParts(t){
        var d = t ? new Date(t) : new Date();
        if(isNaN(d.getTime())) return null;
        try{
          return {
            date: d.toLocaleDateString("en-CA",{ timeZone:"Asia/Karachi" }),
            time: d.toLocaleTimeString("en-GB",{ timeZone:"Asia/Karachi", hour:"2-digit", minute:"2-digit", hour12:false })
          };
        }catch(e){ return null; }
      }
      function dpart(t){
        var k=nvKarachiParts(t);
        if(k) return k.date;
        return t?String(t).slice(0,10):new Date().toISOString().slice(0,10);
      }
      function tpart(t){
        if(!t) return "";
        var k=nvKarachiParts(t);
        return k?k.time:String(t).replace("T"," ").slice(11,16);
      }
      function dtpart(t){
        if(!t) return "";
        var k=nvKarachiParts(t);
        return k?(k.date+" "+k.time):String(t).replace("T"," ").slice(0,16);
      }
      function pmeta(p){ return { service:p.service, weight:p.weight, pickupCity:p.pickupCity, category:p.category, fragile:p.fragile, paymentMode:p.paymentMode, orderId:p.orderId, referenceNo:p.referenceNo||p.reference||p.ref||"", source:p.source, branch:p.branch, risk:p.risk, steps:p.steps, clientFeedback:p.clientFeedback, returnProof:p.returnProof, proofPhoto:p.proofPhoto, signature:p.signature, signedAt:p.signedAt, callRecord:p.callRecord, awbPrinted:!!p.awbPrinted, awbPrintedAt:p.awbPrintedAt||"" }; }
      // Admin used to fill blank consignee details with invented values --
      // address = "<consignee> delivery address, <city>", phone = 0311 + row
      // index -- and sync those to Supabase. That is why this drawer showed the
      // consignee's name where the delivery address belongs. The generator is
      // gone, but rows written before the fix can still be in the table, so we
      // refuse to display them: an empty address reads as "Not provided", which
      // is true, while the invented string reads as a real address, which is not.
      function nvRealAddress(addr, consignee, city){
        var a=String(addr||"").trim();
        if(!a) return "";
        if(a===String(consignee||"").trim()+" delivery address, "+String(city||"").trim()) return "";
        return a;
      }
      function nvRealPhone(phone){
        var v=String(phone||"").trim();
        return /^0311000[0-9]{4}$/.test(v) ? "" : v;
      }
      /* Pulls only the closed parcels that loaded invoices point at, skipping
         any already in memory, and merges them in. Runs after the main load so
         it never delays first paint. */
      /* Both closed-parcel follow-ups can land within milliseconds of each
         other, and render() walks the whole dashboard. Coalesce them into one
         repaint instead of three. */
      var __nvRenderTimer=null;
      function nvRenderSoon(){
        clearTimeout(__nvRenderTimer);
        __nvRenderTimer=setTimeout(function(){ try{ render(); }catch(e){} }, 120);
      }
      var __nvInvoicedFetched={}, __nvClosedWindowAt=0;
      function nvLoadInvoicedParcels(){
        var want={};
        (state.invoices||[]).forEach(function(inv){
          (inv.parcelRefs||[]).forEach(function(awb){ if(awb) want[awb]=1; });
        });
        var have={};
        (state.parcels||[]).forEach(function(p){ if(p&&p.awb) have[p.awb]=1; });
        /* Also keep a RECENT window of closed parcels. Dropping every closed
           parcel would empty the Delivered counters, the Live Status Board's
           delivered group and the city report -- a merchant expects to see
           what was delivered today and this month. 45 days, capped, so the
           working set stays flat as the account ages instead of growing
           without limit. */
        /* Was a once-per-page boolean. A parcel that reaches Delivered leaves
           the active query, and its cached row still carries the OLD active
           status, so the merge above cannot recognise it as closed -- without
           a periodic refetch it would disappear until the next full reload.
           At most once a minute, so this stays cheap. */
        var __now=Date.now();
        if(__now - __nvClosedWindowAt > 60000){
          __nvClosedWindowAt=__now;
          var since=new Date(Date.now()-45*24*3600*1000).toISOString();
          sb.from("parcels").select("*").eq("client_id",MY)
            .in("status",NV_CLOSED_STATUSES)
            .gte("booked_at",since)
            .order("booked_at",{ascending:false}).limit(400)
            .then(function(r){
              if(!r||r.error||!r.data||!r.data.length) return;
              var seen={};
              (state.parcels||[]).forEach(function(p){ if(p&&p.awb) seen[p.awb]=1; });
              var add=r.data.map(mapParcel).filter(function(p){ return p&&p.awb&&!seen[p.awb]; });
              if(!add.length) return;
              state.parcels=(state.parcels||[]).concat(add);
              nvRenderSoon();
            });
        }
        var need=Object.keys(want).filter(function(a){ return !have[a] && !__nvInvoicedFetched[a]; });
        if(!need.length) return;
        need.forEach(function(a){ __nvInvoicedFetched[a]=1; });
        // Chunked so a merchant with hundreds of invoiced parcels cannot build
        // a URL long enough to be rejected.
        var CH=120, chunks=[];
        for(var i=0;i<need.length;i+=CH) chunks.push(need.slice(i,i+CH));
        chunks.forEach(function(ch){
          sb.from("parcels").select("*").eq("client_id",MY).in("awb",ch).then(function(r){
            if(!r||r.error||!r.data||!r.data.length) return;
            var seen={};
            (state.parcels||[]).forEach(function(p){ if(p&&p.awb) seen[p.awb]=1; });
            var add=r.data.map(mapParcel).filter(function(p){ return p&&p.awb&&!seen[p.awb]; });
            if(!add.length) return;
            state.parcels=(state.parcels||[]).concat(add);
            nvRenderSoon();
          });
        });
      }

      function mapParcel(r){ var m=r.meta||{}; return { _uuid:r.id, awb:r.awb, invoiceId:r.invoice_id||null, invoicedAt:r.invoiced_at||null, clientId:MY, consignee:r.consignee||"", city:r.city||"", address:nvRealAddress(r.address,r.consignee,r.city), phone:nvRealPhone(r.phone), cod:Number(r.cod_amount||0), fee:Number(r.fee||0), status:nvStatus(r.status)||"New booked", exception:r.exception||"", date:dpart(r.booked_at), updated:tpart(r.updated_at)||tpart(r.booked_at), statusSince:r.updated_at||r.booked_at||new Date().toISOString(), statusAgeHours:hrs(r.updated_at||r.booked_at), stage:stageOf(r.status), totalStages:TAGS.length-1, steps:(m.steps&&m.steps.length?m.steps:stepsOf(r.status)), processHistory:(Array.isArray(m.processHistory)?m.processHistory:[]), risk:Number(m.risk||0), rider:r.rider_id||"", branch:m.branch||"", service:m.service||"COD Standard", weight:m.weight||"", pickupCity:m.pickupCity||"", category:m.category||"", fragile:m.fragile||"", allowOpen:(m.allowOpen==="Yes"?"Yes":"No"), paymentMode:m.paymentMode||"COD", orderId:m.orderId||"", referenceNo:m.referenceNo||m.reference||m.ref||m.customerRef||"", source:m.source||"", returnProof:m.returnProof||"", clientFeedback:m.clientFeedback||"", proofPhoto:m.proofPhoto||"", signature:m.signature||"", signedAt:m.signedAt||"", callRecord:m.callRecord||"", awbPrinted:!!m.awbPrinted, awbPrintedAt:m.awbPrintedAt||"", trackingToken:r.tracking_token||"",
        // NovaX distance pricing. Null on every parcel booked before it existed,
        // which is exactly how the label and invoice detect "flat, show nothing".
        pricingMode:r.pricing_mode||"", distanceKm:(r.distance_km!=null?Number(r.distance_km):null),
        rateVersion:r.rate_version||"", quotedFee:(r.quoted_fee!=null?Number(r.quoted_fee):null),
        quote:(m.quote||null) }; }
      function invoiceSummaryFallback(invoiceType, cod, charges, payable, due){
        if(invoiceType==="Delivery Charges") return `Delivery charges due to NovaX ${money(due)}`;
        if(invoiceType==="Mixed") return `COD ${money(cod)} \u00b7 Charges ${money(charges)} \u00b7 Payable ${money(payable)}`;
        return `COD collected ${money(cod)} \u00b7 Payable to client ${money(payable)}`;
      }
      // NovaX fix (rebuild integration mismatch): invoices are RPC-owned and
      // admin_generate_invoice/admin_push_invoice_to_wallet/etc write real
      // columns (invoice_type, due_to_novax, wallet_pushed_at, settled_at)
      // directly. mapInvoice() must read those real columns first and only
      // fall back to legacy meta.* fields for rows from before the rebuild
      // migration backfilled them.
      function mapInvoice(r){
        var m=r.meta||{};
        var invoiceType=r.invoice_type||m.invoiceType||"COD Settlement";
        var dueToNovax=Number(r.due_to_novax!=null?r.due_to_novax:(m.dueToNovax||0));
        var walletPushedAt=r.wallet_pushed_at||m.walletPushedAt||"";
        var paidAt=r.settled_at||m.paidAt||"";
        var cod=Number(r.cod_total||0);
        var charges=Number(r.fee_total||0);
        var payable=Number(r.net_payable||0);
        var summary=m.summary||invoiceSummaryFallback(invoiceType,cod,charges,payable,dueToNovax);
        return { _uuid:r.id, id:r.code||r.id, clientId:MY, parcelRefs:Array.isArray(r.parcel_refs)?r.parcel_refs:[], cod:cod, charges:charges, payable:payable, status:r.status||"", createdAt:dtpart(r.created_at), paidAt:paidAt, walletPushedAt:walletPushedAt, summary:summary, invoiceType:invoiceType, dueToNovax:dueToNovax, finalBalance:Number(m.finalBalance!=null?m.finalBalance:payable) };
      }
      function mapWd(r){
        // NovaX fix (mobile UX audit, raw-UUID leak): withdrawals has no
        // human-readable code column like invoices, so this used to
        // show the raw database UUID as the card title. Derive a stable
        // short code from the UUID itself (not a position-based counter,
        // so it never changes when sort order changes on reload).
        var shortCode="WDR-"+String(r.id||"").replace(/-/g,"").slice(0,6).toUpperCase();
        return { _uuid:r.id, id:shortCode, clientId:MY, amount:Number(r.amount||0), fee:Number(r.fee||0), net:Number(r.net||0), iban:r.iban||"", speed:r.speed||"", status:r.status||"", createdAt:dtpart(r.created_at), paidAt:r.paid_at?dtpart(r.paid_at):"", balanceBefore:Number(r.balance_before||0), paidTxnId:r.paid_txn_id||"", paidBy:r.paid_by||"", paidProof:r.paid_proof||"" };
      }
      function mapLedger(r){ return { _uuid:r.id, id:r.id, clientId:MY, entryType:r.entry_type||"", amount:Number(r.amount||0), affectsBalance:!!r.affects_balance, status:r.status||"", referenceType:r.reference_type||"", referenceId:r.reference_id||"", referenceCode:r.reference_code||"", note:r.note||"", createdAt:dtpart(r.created_at) }; }
      function mapPl(r){ return { _uuid:r.id, id:r.id, clientId:MY, type:r.type||"", amount:Number(r.amount||0), status:r.status||"", ref:r.reference||"", createdAt:dtpart(r.created_at) }; }
      function mapSc(r){ var m=r.meta||{}; return { _uuid:r.id, clientId:MY, platform:r.platform, storeUrl:r.store_url||"", connected:!!r.connected, importedCount:Number(r.imported_count||0), hasCreds:!!m.hasCreds, connectedAt:m.connectedAt||"", lastSync:m.lastSync||"" }; }
      function mapPickup(r){ var awbs=r.awbs; if(typeof awbs==="string"){ try{ awbs=JSON.parse(awbs); }catch(e){ awbs=[]; } } if(!Array.isArray(awbs)) awbs=[]; return { _uuid:r.id, id:r.id, clientId:MY, awbs:awbs, pickupAddress:r.pickup_address||"", requestedFor:r.requested_for||"", note:r.note||"", status:r.status||"Requested", riderId:r.rider_id||"", createdAt:dtpart(r.created_at) }; }
      /* NovaX motion: skeleton rows while the very first load is in flight.
         Only ever fills a container that is currently EMPTY, and only on the
         first load -- so it can never blank out data the merchant is already
         reading, and a realtime refetch never flashes skeletons over a
         populated list. Cleared implicitly: render() overwrites innerHTML. */
      var __nvFirstLoadDone=false;
      function nvShowSkeletons(){
        if(__nvFirstLoadDone) return;
        try{
          var row='<div class="nv-skel-row"><div class="nv-skel-line" style="width:45%"></div>'+
                  '<div class="nv-skel-line" style="width:80%"></div>'+
                  '<div class="nv-skel-line" style="width:60%"></div></div>';
          ["clientParcelCards","clientInvoiceList","walletLedgerList","clientPaymentHistory"].forEach(function(id){
            var el=document.getElementById(id);
            if(el && !el.children.length) el.innerHTML=row+row+row;
          });
        }catch(e){}
      }

      function loadAll(){
        nvShowSkeletons();
        // NovaX fix (high risk #3, defense in depth): these used to rely
        // entirely on RLS to scope rows to this seller. If any RLS policy
        // were ever loose or misconfigured, this client would map another
        // client's parcels, invoices, withdrawals, payment logs, or
        // store connections straight into its own account view. Explicit
        // client_id filters are added here so the frontend never trusts RLS
        // alone.
        return Promise.all([
          sb.from("clients").select("*").eq("id",MY).maybeSingle(),
          /* Only parcels that are still MOVING. Delivered and Return to
             shipper are terminal -- nothing about them can change again, so
             re-pulling a merchant's entire history on every load was pure
             waste that grew forever. The closed parcels an invoice actually
             references are fetched separately below, by AWB, so invoice
             statements stay complete. */
          sb.from("parcels").select("*").eq("client_id",MY)
            .not("status","in","("+NV_CLOSED_STATUSES.map(function(x){return '"'+x+'"';}).join(",")+")")
            .order("booked_at",{ascending:false}),
          /* These four were unbounded and are re-issued on every debounced
             realtime change, so a long-tenured merchant re-pulled their entire
             invoice/payout/payment history from scratch on every tick. Capped
             to match wallet_ledger, which was already sensibly limited. Newest
             first, so the cap only ever drops old history the dashboard does
             not surface anyway. */
          sb.from("invoices").select("*").eq("client_id",MY).order("created_at",{ascending:false}).limit(500),
          sb.from("withdrawals").select("*").eq("client_id",MY).order("created_at",{ascending:false}).limit(500),
          sb.from("payment_logs").select("*").eq("client_id",MY).order("created_at",{ascending:false}).limit(500),
          sb.from("store_connections").select("*").eq("client_id",MY),
          sb.from("wallet_ledger").select("*").eq("client_id",MY).order("created_at",{ascending:false}).limit(500),
          sb.from("pickup_requests").select("*").eq("client_id",MY).order("created_at",{ascending:false}).limit(500)
        ]).then(function(res){
          /* BUG: this read only .data. res[0] is {data:null,error} on a 401 or
             any transport failure, so `!c` below fired and the account was
             blanked, persisted, and marked ready. Check the error FIRST. */
          var cErr=res[0]&&res[0].error;
          if(cErr){
            if(nvIsAuthError(cErr)){ nvSessionExpired("loadAll/clients"); return; }
            /* A non-auth failure (offline, 5xx) must not rewrite the account
               either. Keep whatever is already cached and let the caller
               retry; blanking is never the right answer to "we could not
               reach the server". */
            console.warn("NovaX: clients lookup failed --",cErr.message||cErr);
            state.identityVerified=true;
            loaded=true;
            __nvFirstLoadDone=true;
            try{ render(); }catch(e){ console.warn("NovaX render",e); }
            window.__novaxClientDataReady=true;
            toast("Could not refresh your account just now. Showing your last saved view.","error");
            return;
          }
          var c=res[0]&&res[0].data;
          // NovaX fix (High #3 - "My Store" fallback): a client_id can exist on
          // the profile while the matching row in `clients` is missing (bad
          // migration, deleted row, etc). Previously this silently named the
          // account "My Store" and kept going as if everything was fine. Now
          // it stops, flags clientRecordMissing, and shows a clear error --
          // it never guesses a name and never loads parcel/invoice/wallet data
          // for an account that has no confirmed client record.
          if(!c){
            console.warn("NovaX: profile.client_id "+MY+" has no matching row in clients.");
            state.identityVerified=true;
            state.clientRecordMissing=true;
            state.accountNotLinked=false;
            state.client={ id:MY, name:"We're preparing your workspace. Refresh or sign in again.", walletBalance:0, rate:NV_ZONE_A_BASE, rateCard:defaultRateCard(NV_ZONE_A_BASE), premiumTier:"", walletTopup:0, shippingDue:0, subAccounts:0 };
            state.clients=[state.client];
            state.parcels=[]; state.invoices=[]; state.walletWithdrawals=[]; state.paymentLogs=[]; state.storeConnections=[]; state.walletLedger=[]; state.pickupRequests=[];
            state.clientBankDetails=null;
            loaded=true;
            try{ localStorage.setItem(STORAGE_KEY,persistStateJson()); }catch(e){}
            __nvFirstLoadDone=true;
            try{ render(); }catch(e){ console.warn("NovaX render",e); }
            window.__novaxClientDataReady=true;
            try{ window.__novaxMarkDataFresh(); }catch(e){}
            return;
          }
          state.identityVerified=true;
          state.clientRecordMissing=false;
          // NovaX fix (wallet IBAN UX): pull previously-saved bank details
          // down from the client row if that column exists; best-effort
          // only, so a missing column never breaks the rest of the load.
          try{ state.clientBankDetails=(c&&c.bank_details)?c.bank_details:(state.clientBankDetails||null); }catch(e){ state.clientBankDetails=state.clientBankDetails||null; }
          var name=c.name||"Client";
          var rate=Number((c&&c.rate)||NV_ZONE_A_BASE), bal=Number((c&&c.wallet_balance)||0), rc=normalizeRateCard((c&&c.rate_card), rate);
          /* NovaX new (per-client pickup city): admin sets this on the client
             record (clients.meta.pickupCity). Defaults to Karachi, which is
             what every existing merchant already has, so nothing changes for
             them. Read-only here -- a merchant cannot move their own pickup
             city, only NovaX can. */
          var pickupCity=(c&&c.meta&&c.meta.pickupCity)||"Karachi";
          state.client={ id:MY, name:name, walletBalance:bal, rate:rate, rateCard:rc, premiumTier:(c&&c.status)||"", walletTopup:0, shippingDue:0, subAccounts:0, pickupCity:pickupCity, createdAt:(c&&c.created_at)||null };
          /* Onboarding deck gate. Carried here because clients.created_at is
             the ONLY thing that can prove a merchant is brand new, and the
             deck must never appear for an existing one. */
          try{ if(typeof window.nvOnboardMaybeShow==="function") window.nvOnboardMaybeShow(state.client.createdAt); }catch(e){}
          state.clients=[{ id:MY, name:name, owner:(c&&c.owner)||"", city:(c&&c.city)||"", status:(c&&c.status)||"Active", tier:(c&&c.status)||"", rate:rate, rateCard:rc, walletBalance:bal, risk:Number((c&&c.risk_score)||0), health:90, problemsResolved:0 }];
          /* MERGE, do not replace. res[1] is the ACTIVE-only query, so
             assigning it straight to state.parcels wiped every Delivered /
             Return-to-shipper parcel that was already in memory -- which is
             why the dashboard showed data on first paint and then blanked it
             a moment later, and flashed on every refresh. Closed parcels
             already loaded are carried across; the active set is replaced. */
          (function(){
            var freshActive=((res[1]&&res[1].data)||[]).map(mapParcel);
            var activeAwbs={};
            freshActive.forEach(function(p){ if(p&&p.awb) activeAwbs[p.awb]=1; });
            var keptClosed=(state.parcels||[]).filter(function(p){
              return p && p.awb && !activeAwbs[p.awb]
                     && NV_CLOSED_STATUSES.indexOf(p.status)>-1;
            });
            state.parcels=freshActive.concat(keptClosed);
          })();
          state.invoices=((res[2]&&res[2].data)||[]).map(mapInvoice);
          /* Closed parcels are no longer in the main pull, but an invoice
             statement resolves every line by finding the parcel in
             state.parcels -- and every invoiced parcel is Delivered or Return
             to shipper. Without this the statements would silently degrade to
             "Not on this account" with Rs 0 lines. Fetch exactly the AWBs the
             loaded invoices reference: typically a few dozen rows, once,
             instead of the merchant's entire history on every load. */
          try{ nvLoadInvoicedParcels(); }catch(e){ console.warn("NovaX invoiced parcels", e); }
          state.walletWithdrawals=((res[3]&&res[3].data)||[]).map(mapWd);
          state.paymentLogs=((res[4]&&res[4].data)||[]).map(mapPl);
          state.storeConnections=((res[5]&&res[5].data)||[]).map(mapSc);
          state.walletLedger=((res[6]&&res[6].data)||[]).map(mapLedger);
          shadow={}; state.parcels.forEach(function(p){ if(p._uuid) shadow[p._uuid]=(p.status||"")+"|"+(p.exception||"")+"|"+(p.awbPrinted?"1":"0")+"|"+(p.awbPrintedAt||""); });
          loaded=true;
          try{ localStorage.setItem(STORAGE_KEY,persistStateJson()); }catch(e){}
          try{ render(); }catch(e){ console.warn("NovaX render",e); }
          window.__novaxClientDataReady=true;
          try{ window.__novaxMarkDataFresh(); }catch(e){}
        }).catch(function(e){ console.warn("NovaX load failed",e); window.__novaxClientDataReady=true; });
      }
      function syncNew(){
        if(!loaded||!MY) return;
        // NovaX fix (URGENT order booking/processing spec): parcels are no
        // longer created via a direct browser insert into public.parcels --
        // every new booking now goes through the client_book_parcel RPC (see
        // window.__novaxBookParcel above), which already attaches a real
        // _uuid the moment Supabase confirms it. This loop is intentionally
        // disabled so a parcel can never again exist only in local state; it
        // only logs a warning if it ever finds one (e.g. from an old cached
        // session), it never tries to insert it.
        (state.parcels||[]).forEach(function(p){ if(p._uuid||!p._syncPending) return; console.warn("NovaX: found a legacy local-only parcel with no _uuid; direct browser insert into parcels is disabled, it will not be sent to the server.", p.awb); });
        (state.parcels||[]).forEach(function(p){ if(!p._uuid) return; var sig=(p.status||"")+"|"+(p.exception||"")+"|"+(p.awbPrinted?"1":"0")+"|"+(p.awbPrintedAt||""); if(shadow[p._uuid]===sig) return; var prevSig=shadow[p._uuid]; shadow[p._uuid]=sig; sb.from("parcels").update({ status:p.status||"", exception:p.exception||"", updated_at:new Date().toISOString(), meta:pmeta(p) }).eq("id",p._uuid).then(function(r){ if(r&&r.error){ console.warn("NovaX parcel update",r.error.message); if(shadow[p._uuid]===sig) shadow[p._uuid]=prevSig; } }); });
        // NovaX fix (medium risk #5): confirmWalletWithdraw() now always calls
        // request_wallet_withdrawal itself and only ever adds a withdrawal to
        // state with its server _uuid already attached. A withdrawal reaching
        // here with no _uuid can now only be stale/legacy cached browser
        // state from before that fix -- silently re-firing the RPC for it
        // could create a duplicate withdrawal request. Drop it instead of
        // replaying it.
        (state.walletWithdrawals||[]).forEach(function(w){ if(w._uuid||w._pending) return; console.warn("NovaX: dropping stale local withdrawal with no server id (not replayed):",w.id); });
        state.walletWithdrawals=(state.walletWithdrawals||[]).filter(function(w){ return !!w._uuid; });
        (state.paymentLogs||[]).forEach(function(pl){ if(pl._uuid||pl._pending) return; pl._pending=true; sb.from("payment_logs").insert({ client_id:MY, type:pl.type||"", amount:Number(pl.amount||0), status:pl.status||"", reference:pl.ref||"" }).select("id").maybeSingle().then(function(r){ pl._pending=false; if(r&&r.data) pl._uuid=r.data.id; else if(r&&r.error) console.warn("NovaX paylog insert",r.error.message); }); });
        (state.storeConnections||[]).forEach(function(c){ if(c._pending) return; var row={ client_id:MY, platform:c.platform, store_url:c.storeUrl||"", connected:!!c.connected, imported_count:Number(c.importedCount||0), meta:{ hasCreds:!!c.hasCreds, connectedAt:c.connectedAt||"", lastSync:c.lastSync||"" }, updated_at:new Date().toISOString() }; var sig=JSON.stringify(row); if(c._sig===sig) return; var prevSig=c._sig; c._sig=sig; if(c._uuid){ sb.from("store_connections").update(row).eq("id",c._uuid).then(function(r){ if(r&&r.error){ console.warn("NovaX store update",r.error.message); if(c._sig===sig) c._sig=prevSig; } }); } else { c._pending=true; sb.from("store_connections").insert(row).select("id").maybeSingle().then(function(r){ c._pending=false; if(r&&r.data) c._uuid=r.data.id; else if(r&&r.error){ console.warn("NovaX store insert",r.error.message); if(c._sig===sig) c._sig=prevSig; } }); } });
        // NovaX fix (Part 4, pickup request flow): a pickup request created
        // locally only ever needs an insert once -- admins own status/rider
        // updates from their side (synced back down via loadAll/realtime),
        // so this client never re-writes a request it already sent.
        (state.pickupRequests||[]).forEach(function(pr){ if(pr._uuid||pr._pending) return; pr._pending=true; sb.from("pickup_requests").insert({ client_id:MY, awbs:pr.awbs||[], pickup_address:pr.pickupAddress||"", requested_for:pr.requestedFor||"", note:pr.note||"", status:pr.status||"Requested", meta:{} }).select("id").maybeSingle().then(function(r){ pr._pending=false; if(r&&r.data){ pr._uuid=r.data.id; } else if(r&&r.error){ console.warn("NovaX pickup insert",r.error.message); pr._syncFailed=true; try{ toast("Pickup request could not be saved: "+r.error.message,"error"); render(); }catch(e){} } }); });
      }
      var _save=saveState; saveState=function(){ try{ _save.apply(this,arguments); }catch(e){} try{ syncNew(); }catch(e){} };
      state.parcels=[]; state.invoices=[]; state.walletWithdrawals=[]; state.paymentLogs=[]; state.storeConnections=[]; state.pickupRequests=[];
      state.client={ id:null, name:"Verifying account...", walletBalance:0, rate:NV_ZONE_A_BASE, rateCard:{}, subAccounts:0 };
      state.clients=[state.client];
      // NovaX fix (client identity leak): accountNotLinked/clientRecordMissing
      // are the only signals the UI uses to show their respective error
      // states. They must never be paired with any demo/fallback client name
      // (e.g. a different demo client name) -- client.id is set to the non-colliding
      // sentinel "UNLINKED" so no client-scoped fallback (`state.client.id||
      // demo/default placeholder id`) can ever match a real or demo client's data. identityVerified
      // stays false until one of the terminal branches below runs, and every
      // name-rendering code path must treat "not yet verified" as its own
      // state rather than falling through to a cached/demo name.
      state.accountNotLinked=false;
      state.clientRecordMissing=false;
      state.identityVerified=false;
      state.clientDateFrom="2000-01-01"; state.clientDateTo=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
      if(sb.auth){
        // NovaX fix (auth separation): this client-data/session flow must
        // never start before the page-level auth gate (injected right after
        // <body>) has confirmed the signed-in profile's role is really
        // "client". Waiting on that gate here also guarantees the workspace
        // recovery path below can only ever run for a confirmed client
        // session, never for an admin/rider session sharing this browser.
        (window.__novaxAuthGateReady||Promise.resolve()).then(function(){
        /* The auth gate has ALREADY fetched and validated this session a
           moment ago. Calling getSession() again added a third serial round
           trip before the first data query could even start -- and this
           database is in Sydney while the merchants are in Karachi, so every
           avoidable hop costs ~300ms of staring at an empty dashboard.
           Reuse the gate's result and only fall back to a fetch if it is
           somehow absent. */
        (window.__novaxGateSession
           ? Promise.resolve({ data:{ session: window.__novaxGateSession } })
           : sb.auth.getSession()
        ).then(function(r){
          var session=r&&r.data&&r.data.session; if(!session){ window.__novaxClientDataReady=true; return; }
          function subscribeClientChannel(){
            if(!subscribed){
              subscribed=true;
              try{
                // Coalesce bursts: admin pushing five invoices should cause one
                // reload, not five.
                var __rtTimer=null;
                function rtReload(){
                  clearTimeout(__rtTimer);
                  __rtTimer=setTimeout(function(){ try{ loadAll(); }catch(e){} }, 350);
                }
                sb.channel("novax_client_"+MY)
                  .on("postgres_changes",{event:"*",schema:"public",table:"parcels",filter:"client_id=eq."+MY},rtReload)
                  .on("postgres_changes",{event:"*",schema:"public",table:"invoices",filter:"client_id=eq."+MY},rtReload)
                  .on("postgres_changes",{event:"*",schema:"public",table:"withdrawals",filter:"client_id=eq."+MY},rtReload)
                  // clients was missing: wallet_balance changes when admin pushes
                  // an invoice or marks a payout paid, and none of that reached
                  // the merchant until they reloaded the page by hand.
                  .on("postgres_changes",{event:"*",schema:"public",table:"clients",filter:"id=eq."+MY},rtReload)
                  .subscribe(function(status,err){
                    if(err) console.warn("NovaX client realtime",status,err.message||err);
                    if(status==="SUBSCRIBED") window.__nvRealtimeLive=true;
                  });

                /* Realtime only delivers if the table is in the
                   supabase_realtime publication. If it is not -- or the socket
                   drops on a phone that slept, changed network, or was
                   backgrounded -- the merchant simply never sees new data and
                   has to reload by hand. These three fallbacks make the portal
                   keep itself current either way, and cost one query each. */
                function nvQuietRefresh(){
                  if(document.hidden) return;
                  try{ loadAll(); }catch(e){}
                }
                /* Exposed so pull-to-refresh can reach it: loadAll() and this
                   both live inside the Supabase closure, and the gesture
                   handler is defined outside it. */
                window.nvQuietRefresh = nvQuietRefresh;
                /* 1. A SAFETY NET, not the primary channel. Realtime is the
                   primary channel; polling exists only for the case where the
                   publication is missing a table or the socket died. Polling
                   unconditionally every 30s cost 8 queries x 2/min per open
                   client tab (23 x 2 on admin) and dominated the project's
                   entire request volume with a single merchant online. It now
                   runs only while realtime is NOT connected, and at 3 minutes. */
                if(!window.__nvPollTimer){
                  window.__nvPollTimer=nvInterval(function(){
                    if(window.__nvRealtimeLive) return;   // realtime has it covered
                    nvQuietRefresh();
                  }, 180000);
                }
                // 2. the moment the merchant comes back to the tab
                if(!window.__nvVisBound){
                  window.__nvVisBound=true;
                  document.addEventListener("visibilitychange",function(){
                    if(!document.hidden) nvQuietRefresh();
                  });
                  window.addEventListener("focus", nvQuietRefresh);
                  // 3. and when the phone/laptop regains a connection
                  window.addEventListener("online", nvQuietRefresh);
                }
              }catch(e){ console.warn("NovaX client realtime",e); }
            }
          }
          // NovaX fix (role hard-stop v2): a signed-in "client" profile with
          // no client_id is no longer handed a fake dashboard (a client
          // object with a placeholder name and a real wallet/parcel UI
          // wrapped around it). It now gets a genuine full-page stop screen,
          // reusing the same #nvAuthGate overlay the page-load auth gate
          // uses, and loadAll()/render() are never called with invented data.
          /* There was no 401 handler anywhere in this file. supabase-js does not
             reject on an auth failure -- it RESOLVES with {data:null,error},
             so every `if(!data)` branch in here treated an expired token as
             "this account has no data". A merchant who left the tab open over
             lunch came back to an empty account, and loadAll() then wrote that
             emptiness to localStorage so it survived a reload.

             These two helpers are the difference between "your session ended"
             and "your business has no parcels". */
          function nvIsAuthError(err){
            if(!err) return false;
            var code=String(err.code||"");
            var msg=String(err.message||"").toLowerCase();
            var st=Number(err.status||err.statusCode||0);
            return st===401 || st===403 ||
                   code==="PGRST301" || code==="PGRST302" || code==="401" ||
                   /jwt|token|expired|not authenticated|invalid claim|unauthorized/.test(msg);
          }
          /* A reachable-but-failing backend is not an unlinked workspace, and
             not a signed-out session. Offer a retry instead of a dead end. */
          function nvTransientLoadFailure(msg){
            var gateEl=document.getElementById("nvAuthGate");
            if(gateEl){
              gateEl.innerHTML='<div style="max-width:400px;text-align:center;font-size:15px;font-weight:700;line-height:1.6;">'+
                (msg||"We could not load your workspace.")+
                '<br><span style="font-weight:500;opacity:.85">This is usually a connection problem, not your account.</span></div>'+
                '<button type="button" onclick="location.reload()" style="margin-top:14px;background:var(--nvu-accent,#14c77b);color:#04140d;padding:11px 20px;border-radius:12px;font-weight:700;border:0;font-size:14px;cursor:pointer;">Try again</button>';
              gateEl.style.display="flex";
            }
          }

          function nvSessionExpired(where){
            if(window.__nvSessionExpiredShown) return;
            window.__nvSessionExpiredShown=true;
            console.warn("NovaX: auth error at "+(where||"unknown")+" -- session expired.");
            /* Deliberately does NOT touch state or localStorage. The cached
               account stays exactly as it was; the merchant signs in and finds
               it intact. */
            var gateEl=document.getElementById("nvAuthGate");
            if(gateEl){
              gateEl.innerHTML='<div style="max-width:400px;text-align:center;font-size:15px;font-weight:700;line-height:1.6;">Your session expired.<br><span style="font-weight:500;opacity:.85">Your account and parcels are safe &mdash; please sign in again.</span></div>'+
                '<a href="index.html#login" style="margin-top:14px;display:inline-block;background:var(--nvu-accent,#14c77b);color:#04140d;padding:11px 20px;border-radius:12px;font-weight:700;text-decoration:none;font-size:14px;">Sign in again</a>';
              gateEl.style.display="flex";
            }
            try{ if(window.__nvSb&&window.__nvSb.auth) window.__nvSb.auth.signOut(); }catch(e){}
          }

          function showWorkspaceNotLinked(){
            state.accountNotLinked=true;
            state.clientRecordMissing=false;
            state.identityVerified=true;
            var gateEl=document.getElementById("nvAuthGate");
            if(gateEl){
              gateEl.innerHTML='<div style="max-width:380px;text-align:center;font-size:15px;font-weight:700;line-height:1.6;">Workspace not linked.<br>Please contact NovaX support.</div><a href="index.html" style="margin-top:4px;color:var(--nvu-accent);font-weight:600;text-decoration:underline;font-size:14px;">Return to homepage</a>';
              gateEl.style.display="flex";
            }
            window.__novaxClientDataReady=true;
          }
          // NovaX fix (instant merchant workspace, tightened by role
          // hard-stop v2): a signed-in user with no client_id yet only ever
          // self-heals through this recovery RPC when the account's own
          // signup metadata proves it came from the public merchant signup
          // form (window.__novaxAllowWorkspaceRecovery, set by the page auth
          // gate from user_metadata.role === "client"). Any other client-role
          // account with no client_id (created by an admin, imported, etc.)
          // goes straight to the hard-stop screen instead -- recovery is
          // never attempted for it, and it is never attempted for
          // admin/staff/rider sessions because this whole flow only runs
          // after the page auth gate has already confirmed the session's
          // role is "client".
          function attemptWorkspaceRecovery(){
            var meta=(session.user&&session.user.user_metadata)||{};
            sb.rpc("create_client_workspace",{
              p_name: meta.business_name||meta.full_name||"",
              p_owner: meta.owner_name||meta.full_name||"",
              p_phone: meta.phone||"",
              p_city: meta.city||"",
              p_address: meta.address||"",
              p_business_type: meta.business_type||"",
              p_website: meta.website||""
            }).then(function(rpcRes){
              if(!rpcRes||rpcRes.error||!rpcRes.data){
                console.warn("NovaX workspace recovery failed:",rpcRes&&rpcRes.error&&rpcRes.error.message);
                showWorkspaceNotLinked();
                return;
              }
              MY=rpcRes.data;
              state.accountNotLinked=false;
              loadAll();
              subscribeClientChannel();
            }).catch(function(e){
              console.warn("NovaX workspace recovery failed:",e);
              showWorkspaceNotLinked();
            });
          }
          function recoverOrStop(){
            if(window.__novaxAllowWorkspaceRecovery){ attemptWorkspaceRecovery(); }
            else { console.warn("NovaX: client_id missing and this account did not sign up through merchant signup -- showing hard stop instead of running workspace recovery."); showWorkspaceNotLinked(); }
          }
          sb.from("profiles").select("client_id").eq("id",session.user.id).single().then(function(p){
            if(p&&p.error){
              console.warn("NovaX profile",p.error.message);
              /* BUG: ANY error here -- a 401, a dropped connection, a slow
                 request -- put up the permanent "Workspace not linked, contact
                 support" wall. Only a genuinely absent row means unlinked;
                 PGRST116 is .single() finding no row, which is that case. */
              if(nvIsAuthError(p.error)){ nvSessionExpired("profiles"); return; }
              var code=String(p.error.code||"");
              if(code!=="PGRST116"){
                nvTransientLoadFailure("We could not reach your workspace just now.");
                return;
              }
              recoverOrStop();
              return;
            }
            MY=p&&p.data?p.data.client_id:null;
            if(!MY){
              console.warn("NovaX: this seller has no client_id linked yet.");
              recoverOrStop();
              return;
            }
            state.accountNotLinked=false;
            loadAll();
            subscribeClientChannel();
          });
        });
        });
      }
    })();
    // NovaX fix (auth separation): defer the very first render() the same
    // way -- the dashboard/menu/cards must never paint before the auth gate
    // has confirmed this session's role.
    (window.__novaxAuthGateReady||Promise.resolve()).then(function(){
      render();
      window.scrollTo({ top:0, left:0 });
      // Distance pricing config + areas. Entirely optional: if the RPCs are
      // not deployed this resolves to nothing and the portal is unchanged.
      try{ nvGeoBoot(); }catch(e){ console.warn("NovaX geo boot", e); }
    });
    /* ===== NovaX AI Assistant (rule-based, live data, client scope) ===== */
    (function(){
      try{
        if(window.__novaxAiLoaded) return; window.__novaxAiLoaded=true;
        var esc=function(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); };
        var fmt=function(n){ return Number(n||0).toLocaleString('en-US'); };
        // NovaX fix (High #2): never fall back to the demo/default placeholder client id
        // id -- with no confirmed client identity, the AI's data queries
        // below should match nothing rather than another client's data.
        var cid=function(){ return (state.client&&state.client.id)||null; };
        var cname=function(){ return (state.client&&state.client.name)||'Seller'; };
        var myParcels=function(){ return (state.parcels||[]).filter(function(p){return p.clientId===cid();}); };
        var myInvoices=function(){ return (state.invoices||[]).filter(function(i){return i.clientId===cid()&&i.status!=='Deleted';}); };
        var myWithdrawals=function(){ return (state.walletWithdrawals||[]).filter(function(w){return w.clientId===cid();}); };
        function invLine(iv){ return 'Invoice <b>'+esc(iv.id)+'</b> - status <b>'+esc(iv.status)+'</b><br>Payable <b>Rs '+fmt(iv.payable)+'</b> (COD Rs '+fmt(iv.cod)+' - charges Rs '+fmt(iv.charges)+') · '+((iv.parcelRefs||[]).length)+' parcel(s)'; }
        function pLine(p){ return '<b>'+esc(p.awb)+'</b> - <b>'+esc(p.status)+'</b><br>'+esc(p.consignee||'')+(p.city?' · '+esc(p.city):'')+(p.updated?' · updated '+esc(p.updated):'')+(p.exception?'<br>⚠️ '+esc(p.exception):''); }
        function engine(raw){
          var q=String(raw||'').trim(); if(!q) return {text:'Ask me about a parcel (e.g. <b>SAMPLE-AWB-1</b>), your invoice, wallet balance, or any delivery issue.'};
          var low=q.toLowerCase();
          if(/^(hi|hey|hello|salam|assalam|aoa|yo)\b/.test(low)||/how are you/.test(low)) return {text:'Hi '+esc(cname())+'! I read your live NovaX data. Try: <i>where is SAMPLE-AWB-1</i>, <i>my invoice</i>, <i>wallet balance</i>, or report an issue.'};
          if(/^(thanks|thank you|shukria|great|ok|okay|cool)\b/.test(low)) return {text:'Anytime. 🚚'};
          var awb=(q.match(/N\d{7}/i)||[])[0];
          if(awb){ var p=myParcels().find(function(x){return String(x.awb||'').toUpperCase()===awb.toUpperCase();}); if(p) return {text:pLine(p)+(p.steps&&p.steps.length?'<br><span class=nvai-dim>Journey: '+esc(p.steps.join(' to '))+'</span>':'')}; return {text:'I could not find <b>'+esc(awb.toUpperCase())+'</b> under your account.'}; }
          var invId=(q.match(/INV-\d+/i)||[])[0];
          if(invId){ var iv=myInvoices().find(function(i){return String(i.id||'').toUpperCase()===invId.toUpperCase();}); if(iv) return {text:invLine(iv)}; return {text:'I could not find invoice <b>'+esc(invId.toUpperCase())+'</b> on your account.'}; }
          if(/wallet|balance|payout|withdraw|cash ?out|money|payment/.test(low)){ var bal=walletBalance(cid()); var w=myWithdrawals(); var pend=w.filter(function(x){return /pending|process/i.test(x.status||'');}); if(/last|recent|history|withdraw/.test(low)&&w.length){ var lw=w[0]; return {text:'Your wallet balance is <b>Rs '+fmt(bal)+'</b>.<br>Last withdrawal <b>'+esc(lw.id||'')+'</b>: Rs '+fmt(lw.net||lw.amount)+' - <b>'+esc(lw.status||'')+'</b>.'+(pend.length?'<br>'+pend.length+' still in progress.':'')}; } return {text:'Your wallet balance is <b>Rs '+fmt(bal)+'</b>.'+(pend.length?' '+pend.length+' withdrawal(s) in progress.':' No withdrawals in progress.')}; }
          if(/invoice|payable|bill|statement/.test(low)){ var ivs=myInvoices(); if(!ivs.length) return {text:'You have no invoices yet. Invoices are generated once parcels are delivered.'}; return {text:invLine(ivs[0])+(ivs.length>1?'<br><span class=nvai-dim>'+(ivs.length-1)+' older invoice(s) on file.</span>':'')}; }
          if(/exception|refus|delay|stuck|problem|fail|issue|return/.test(low)){ var ex=myParcels().filter(function(p){return p.exception||/refus|return|not available|reattempt/i.test(p.status||'');}); if(!ex.length) return {text:'Good news - no parcels with exceptions right now. ✅'}; return {text:'You have <b>'+ex.length+'</b> parcel(s) needing attention:<br>'+ex.slice(0,5).map(pLine).join('<br><br>')}; }
          if(/how many|count|summary|overview|total|delivered|status of my/.test(low)){ var ps=myParcels(); var del=ps.filter(function(p){return /delivered/i.test(p.status);}).length; var exn=ps.filter(function(p){return p.exception;}).length; var tr=ps.length-del-exn; return {text:'You have <b>'+ps.length+'</b> parcels - <b>'+del+'</b> delivered, <b>'+tr+'</b> in progress, <b>'+exn+'</b> with issues.'}; }
          if(/list|show|recent|latest|all my|my parcels|my orders/.test(low)){ var ps3=myParcels(); if(!ps3.length) return {text:'You have no parcels yet.'}; return {text:'Your recent parcels:<br>'+ps3.slice(0,8).map(pLine).join('<br><br>')+(ps3.length>8?'<br><span class=nvai-dim>+'+(ps3.length-8)+' more.</span>':'')}; }
          if(/rate|price|pricing|cost|tariff|fee|per parcel|per shipment|how much/.test(low)){ var c=clientById(cid()); var rc=normalizeRateCard(c&&c.rateCard, c&&c.rate); return {text:'Your delivery rate depends on destination: <b>Zone A (Karachi) Rs '+fmt(rc.A.overnight)+'</b> and <b>Zone B (Lahore / Islamabad / Rawalpindi) Rs '+fmt(rc.B.overnight)+'</b> per shipment (COD standard). Charges are deducted from COD before your wallet payout.'}; }
          if(/book|create|new parcel|new order|how.*(book|ship|send)|pickup|schedule/.test(low)) return {text:'To book a parcel, tap <b>Book New Parcel</b> on your dashboard, then add the consignee, city, COD and weight. Once a rider collects it I can track it live - just give me the AWB.'};
          if(/help|what can you|capabilit|how.*(use|work)|guide|menu|options|commands|what do you do/.test(low)) return {text:'I can track parcels (give an AWB like <b>SAMPLE-AWB-1</b>), show invoices and payable, wallet balance and withdrawals, exceptions and delays, your rate, and a full summary. Ask in plain words.'};
          if(/track|where|status|location/.test(low)) return {text:'Share the tracking ID (e.g. <b>SAMPLE-AWB-1</b>) and I will give you the exact live status.'};
          return {text:'I want to get this right. Ask me anything about <b>your</b> account - try <i>where is SAMPLE-AWB-1</i>, <i>my invoices</i>, <i>wallet balance</i>, <i>any delays?</i>, <i>my summary</i>, or <i>my rate</i>.'};
        }
        // Expose the engine to the "Full AI in Web" tab immediately, before any
        // floating-widget DOM setup below. That widget is a secondary UI --
        // if its DOM creation ever fails for any reason, it must not be able to
        // block the main AI tab from working (previously a single try/catch
        // wrapped both, so a floating-widget error silently prevented
        // window.novaxAiEngine from ever being set, breaking the AI tab too).
        window.novaxAiEngine = engine;
        window.novaxAiName = cname;
        window.novaxAiEsc = esc;
      }catch(e){ console.warn('NovaX AI engine init failed', e); }
    })();

    /* ===== NovaX First-Booking Welcome Strip + Empty Dashboard + Autopilot Welcome ===== */
    (function(){
      try{
        var qp0=new URLSearchParams(location.search);
        var isWelcome0 = qp0.get("welcome")==="1" || qp0.get("firstBooking")==="1";
        if(!isWelcome0) return;

        var STRIP_HIDE_KEY="novaxFirstBookingWelcomeHidden";
        var AUTOPILOT_WELCOME_KEY="novaxFirstBookingAutopilotSeen";

        function injectStripStyles(){
          if(document.getElementById("nvfbStripStyle")) return;
          var css=".nvfb-strip{background:linear-gradient(135deg,var(--nvu-accent),#13a36f);color:#fff;border-radius:var(--r-xl);padding:14px 16px;margin:0 0 16px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;box-shadow:var(--glow-1)}"
            +".nvfb-strip .nvfb-text{flex:1;min-width:200px;font-size:13.5px;font-weight:600}"
            +".nvfb-strip .nvfb-actions{display:flex;gap:8px;flex-wrap:wrap}"
            +".nvfb-strip button{border:none;border-radius:var(--r-md);padding:8px 12px;font-size:12.5px;font-weight:700;cursor:pointer}"
            +".nvfb-strip .nvfb-primary{background:var(--nvu-bg);color:var(--nvu-accent)}"
            +".nvfb-strip .nvfb-ghost{background:rgba(255,255,255,.18);color:#fff}"
            +".nvfb-strip .nvfb-x{background:transparent;color:rgba(255,255,255,.8);font-size:18px;padding:2px 6px}"
            +"@media(max-width:480px){.nvfb-strip{flex-direction:column;align-items:stretch}.nvfb-strip .nvfb-actions{justify-content:stretch}.nvfb-strip button{flex:1}}";
          var st=document.createElement("style"); st.id="nvfbStripStyle"; st.textContent=css; document.head.appendChild(st);
        }

        function hideWelcomeStrip(){
          try{ localStorage.setItem(STRIP_HIDE_KEY,"1"); }catch(e){}
          var el=document.getElementById("nvfbStrip"); if(el) el.remove();
        }

        function mountWelcomeStrip(){
          try{
            if(localStorage.getItem(STRIP_HIDE_KEY)==="1") return;
            if((typeof state==="undefined") || state.activeClientTab!=="newBooking") return;
            var ctx0=typeof getClientContext==="function"?getClientContext():null;
            if(ctx0){ if(!ctx0.ready) return; if(ctx0.hasParcels) return; }
            else { if(typeof isClientDataReady==="function" && !isClientDataReady()) return; if(typeof getCurrentClientParcels==="function" && getCurrentClientParcels().length>0) return; }
            var host=document.getElementById("client-newBooking");
            if(!host || document.getElementById("nvfbStrip")) return;
            injectStripStyles();
            var strip=document.createElement("div");
            strip.id="nvfbStrip"; strip.className="nvfb-strip";
            strip.innerHTML='<div class="nvfb-text">Let us get your first parcel booked \u2014 takes under a minute.</div>'
              +'<div class="nvfb-actions">'
              +'<button class="nvfb-primary" id="nvfbPaste">Paste WhatsApp Order</button>'
              +'<button class="nvfb-ghost" id="nvfbManual">Fill Manually</button>'
              +'<button class="nvfb-ghost" id="nvfbTour">Take 30-sec Tour</button>'
              +'<button class="nvfb-x" id="nvfbClose" aria-label="Dismiss">\u00d7</button>'
              +'</div>';
            host.insertBefore(strip, host.firstChild);
            document.getElementById("nvfbClose").addEventListener("click",hideWelcomeStrip);
            document.getElementById("nvfbManual").addEventListener("click",function(){ hideWelcomeStrip(); if(window.novaxFocusFirstBookingField) window.novaxFocusFirstBookingField(); });
            document.getElementById("nvfbTour").addEventListener("click",function(){
              hideWelcomeStrip();
              try{ var u=new URL(location.href); u.searchParams.set("onboarding","1"); location.href=u.toString(); }
              catch(e){ location.search=(location.search?location.search+"&":"?")+"onboarding=1"; }
            });
            document.getElementById("nvfbPaste").addEventListener("click",function(){
              hideWelcomeStrip();
              try{ if(typeof showClientTab==="function") showClientTab("newBooking"); setTimeout(function(){ var el=document.getElementById("nvPasteInput"); if(el) el.focus(); },150); }catch(e){}
            });
          }catch(e){}
        }

        window.novaxFocusFirstBookingField=function(){
          try{
            if(typeof showClientTab==="function") showClientTab("newBooking");
            setTimeout(function(){ var el=document.getElementById("bookingName"); if(el) el.focus(); },150);
          }catch(e){}
        };

        function showFirstBookingAutopilotWelcome(){
          if(localStorage.getItem(AUTOPILOT_WELCOME_KEY)==="1") return;
          var tries=0;
          function decide(){
            tries++;
            var ctxD=typeof getClientContext==="function"?getClientContext():null;
            var ready=ctxD?ctxD.ready:(typeof isClientDataReady==="function"?isClientDataReady():true);
            if(!ready && tries<20){ setTimeout(decide,300); return; }
            localStorage.setItem(AUTOPILOT_WELCOME_KEY,"1");
            var mine=ctxD?(ctxD.hasParcels?[1]:[]):(typeof getCurrentClientParcels==="function"?getCurrentClientParcels():[]);
            if(mine.length>0){
              if(window.novaxAutopilotSay) window.novaxAutopilotSay("Welcome back. Your workspace is ready.",[
                { label:"Review Issues", kind:"local", type:"nv_review_issues" },
                { label:"Print Pending AWBs", kind:"local", type:"go_awb_label" },
                { label:"Book Orders", kind:"local", type:"go_booking" }
              ]);
              return;
            }
            if(window.novaxAutopilotSay) window.novaxAutopilotSay("Welcome to your NovaX workspace. I\u2019ll help you book your first parcel, print the AWB, track delivery, and warn you if anything gets stuck.",[
              { label:"Paste WhatsApp Order", kind:"local", type:"paste_whatsapp_order" },
              { label:"Start Manual Booking", kind:"local", type:"focus_manual_booking" },
              { label:"Take 30-sec Tour", kind:"local", type:"start_tour" }
            ]);
          }
          setTimeout(decide,1600);
        }

        function cleanWelcomeUrl(){
          try{
            var u=new URL(location.href);
            u.searchParams.delete("welcome");
            u.searchParams.delete("firstBooking");
            var clean=u.pathname+(u.search?u.search:"")+u.hash;
            history.replaceState({}, "", clean);
          }catch(e){}
        }

        nvInterval(function(){ if(document.hidden) return; mountWelcomeStrip(); renderDashboardEmptyState(); },15000);
        setTimeout(function(){ mountWelcomeStrip(); renderDashboardEmptyState(); if(window.novaxFocusFirstBookingField) window.novaxFocusFirstBookingField(); },300);
        showFirstBookingAutopilotWelcome();
        cleanWelcomeUrl();
      }catch(e){}
    })();

    /* ===== Smart Empty Dashboard (always active, not limited to the welcome-redirect session) ===== */
    function renderDashboardEmptyState(){
      try{
        if(typeof state==="undefined" || state.activeClientTab!=="dashboard") return;
        var ctx=typeof getClientContext==="function"?getClientContext():null;
        var hasParcels=ctx?ctx.hasParcels:((typeof getCurrentClientParcels==="function"?getCurrentClientParcels():[]).length>0);
        var ready=ctx?ctx.ready:(typeof isClientDataReady==="function"?isClientDataReady():false);
        var existingBox=document.getElementById("nvfbEmptyState");
        if(hasParcels){
          if(existingBox) existingBox.remove();
          var loadingBox0=document.getElementById("nvfbLoadingState"); if(loadingBox0) loadingBox0.remove();
          return;
        }
        if(!ready){
          if(existingBox) existingBox.remove();
          var host0=document.getElementById("client-dashboard");
          if(host0 && !document.getElementById("nvfbLoadingState")){
            var loading=document.createElement("div");
            loading.id="nvfbLoadingState";
            loading.style.cssText="background:var(--nvu-neutral-bg);border:1px dashed #bfe8d7;border-radius:var(--r-xl);padding:16px;text-align:center;margin-bottom:16px;color:#3a6b5a;font-size:13px;font-weight:700";
            loading.textContent="Loading workspace...";
            host0.insertBefore(loading,host0.firstChild);
          }
          return;
        }
        if(ctx && typeof canShowEmptyDashboard==="function" && !canShowEmptyDashboard(ctx)){
          if(existingBox) existingBox.remove();
          return;
        }
        var loadingBox=document.getElementById("nvfbLoadingState"); if(loadingBox) loadingBox.remove();
        var host=document.getElementById("client-dashboard");
        if(!host || document.getElementById("nvfbEmptyState")) return;
        var box=document.createElement("div");
        box.id="nvfbEmptyState";
        box.style.cssText="background:var(--nvu-neutral-bg);border:1px dashed #bfe8d7;border-radius:var(--r-xl);padding:22px 18px;text-align:center;margin-bottom:16px";
        box.innerHTML='<div style="font-weight:800;color:var(--nvu-accent);margin-bottom:6px">No parcels yet</div>'
          +'<div style="font-size:13px;color:#3a6b5a;margin-bottom:14px">Book your first parcel and NovaX will track it end to end.</div>'
          +'<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">'
          +'<button id="nvfbEmptyBtn" style="border:none;border-radius:var(--r-lg);background:var(--nvu-accent);color:var(--nvu-accent-ink);padding:10px 16px;font-weight:700;font-size:13px;cursor:pointer">Book First Parcel</button>'
          +'<button id="nvfbEmptyPaste" style="border:1px solid #bfe8d7;border-radius:var(--r-lg);background:var(--nvu-bg);color:var(--nvu-accent);padding:10px 16px;font-weight:700;font-size:13px;cursor:pointer">Paste WhatsApp Order</button>'
          +'<button id="nvfbEmptyCsv" style="border:1px solid #bfe8d7;border-radius:var(--r-lg);background:var(--nvu-bg);color:var(--nvu-accent);padding:10px 16px;font-weight:700;font-size:13px;cursor:pointer">Upload Bulk CSV</button>'
          +'<button id="nvfbEmptyStore" style="border:1px solid #bfe8d7;border-radius:var(--r-lg);background:var(--nvu-bg);color:var(--nvu-accent);padding:10px 16px;font-weight:700;font-size:13px;cursor:pointer">Connect Store</button>'
          +'<button id="nvfbEmptyAsk" style="border:1px solid #bfe8d7;border-radius:var(--r-lg);background:var(--nvu-bg);color:var(--nvu-accent);padding:10px 16px;font-weight:700;font-size:13px;cursor:pointer">Ask Autopilot</button>'
          +'</div>';
        host.insertBefore(box, host.firstChild);
        document.getElementById("nvfbEmptyBtn").addEventListener("click",function(){ if(window.novaxFocusFirstBookingField) window.novaxFocusFirstBookingField(); else if(typeof showClientTab==="function") showClientTab("newBooking"); });
        document.getElementById("nvfbEmptyPaste").addEventListener("click",function(){
          try{ if(typeof showClientTab==="function") showClientTab("newBooking"); setTimeout(function(){ var el=document.getElementById("nvPasteInput"); if(el) el.focus(); },150); }catch(e){}
        });
        document.getElementById("nvfbEmptyCsv").addEventListener("click",function(){
          try{ if(typeof showClientTab==="function") showClientTab("bulkBooking"); }catch(e){}
        });
        document.getElementById("nvfbEmptyStore").addEventListener("click",function(){
          try{ if(typeof showClientTab==="function") showClientTab("integrations"); }catch(e){}
        });
        document.getElementById("nvfbEmptyAsk").addEventListener("click",function(){
          try{ if(window.novaxOpenAutopilot) window.novaxOpenAutopilot(); }catch(e){}
        });
      }catch(e){}
    }
    (function(){
      /* Removed: a second 15s interval calling renderDashboardEmptyState().
         Another one already does exactly this (alongside mountWelcomeStrip),
         so the two together re-ran the same DOM work every ~7.5s for the
         lifetime of the tab. */
      setTimeout(renderDashboardEmptyState,400);
      document.addEventListener("DOMContentLoaded",renderDashboardEmptyState);
    })();

    /* ===== Daily Command Center: dashboard strip render + wiring ===== */
    var NOTIF_EVENT_LABELS={ booked:"Booked", picked_up:"Picked up", in_transit:"In transit", out_for_delivery:"Out for delivery", delivered:"Delivered", refused:"Refused", returned:"Returned", invoice_pushed:"Invoice pushed", wallet_paid:"Wallet payout paid" };

    async function logClientError(rpcName, message, severity){
      try{ if(window.__nvSb) await window.__nvSb.rpc("log_portal_error",{ p_source:"client", p_rpc_name:rpcName||null, p_page:(state.activeClientTab||"client"), p_message:String(message||"").slice(0,300), p_severity:severity||"warning" }); }
      catch(e){ /* never let error-logging break the page */ }
    }

    async function loadClientNotificationPrefs(){
      try{
        const r=await window.__nvSb.rpc("client_get_notification_prefs",{});
        if(r.error) throw new Error(r.error.message);
        const p=r.data||{};
        const wa=document.getElementById("notifPrefWhatsapp"); if(wa) wa.checked=!!p.whatsapp_enabled;
        const sms=document.getElementById("notifPrefSms"); if(sms) sms.checked=!!p.sms_enabled;
        const em=document.getElementById("notifPrefEmail"); if(em) em.checked=!!p.email_enabled;
        const events=Array.isArray(p.events)?p.events:Object.keys(NOTIF_EVENT_LABELS);
        const grid=document.getElementById("notifPrefEventsGrid");
        if(grid) grid.innerHTML=Object.keys(NOTIF_EVENT_LABELS).map(function(ev){ return `<label class="footer-note" style="display:flex;align-items:center;gap:8px"><input type="checkbox" class="notifPrefEventBox" value="${ev}" ${events.indexOf(ev)>-1?"checked":""}> ${NOTIF_EVENT_LABELS[ev]}</label>`; }).join("");
      }catch(e){ logClientError("client_get_notification_prefs", e.message||e, "warning"); }
    }

    /* The business name prints under CLIENT / SHIPPER on every label. Until
       now a merchant whose workspace was created with their personal name
       could only get it changed by messaging support -- which is exactly how
       the GenZee Creation case reached us. */
    window.saveClientBusinessName = async function(){
      var input = document.getElementById("clientBizName");
      var hint  = document.getElementById("clientBizNameHint");
      if(!input) return;
      var val = String(input.value || "").trim();
      if(val.length < 2){ toast("Enter your business name first.", "error"); input.focus(); return; }
      var sb = window.__nvSb;
      if(!sb){ toast("Still connecting \u2014 try again in a moment.", "error"); return; }
      try{
        var r = await sb.rpc("client_set_business_name", { p_name: val });
        if(r && r.error){ toast("Could not save: " + r.error.message, "error"); return; }
        toast("Business name saved. New labels will show \u201C" + (r.data || val) + "\u201D.");
        if(hint) hint.textContent = "Saved. Labels printed from now on will show this name.";
        try{ if(typeof loadAll === "function") loadAll(); }catch(e){}
      }catch(e){
        toast("Could not save: " + ((e && e.message) || e), "error");
      }
    };

    /* Prefill from the workspace so the merchant sees what is on their labels
       today, not an empty box that invites a blank save.

       render() runs several times before the real client row lands, and the
       early passes carry placeholder names ("Verifying account...", "We're
       preparing your workspace..."). Filling from one of those would offer
       the merchant a placeholder to save as their company name, so those are
       skipped and the field keeps syncing until a real name arrives -- but
       never while they are typing in it. */
    var NV_BIZ_PLACEHOLDERS = ["verifying", "preparing your workspace",
                               "loading workspace", "unknown client", "merchant"];
    window.nvFillBusinessName = function(name){
      var input = document.getElementById("clientBizName");
      if(!input || !name) return;
      if(input === document.activeElement) return;          // they are typing
      if(input.dataset.touched === "1") return;             // they edited it
      var low = String(name).toLowerCase();
      for(var i = 0; i < NV_BIZ_PLACEHOLDERS.length; i++){
        if(low.indexOf(NV_BIZ_PLACEHOLDERS[i]) > -1) return;
      }
      if(input.value !== name) input.value = name;
    };
    document.addEventListener("input", function(e){
      if(e.target && e.target.id === "clientBizName") e.target.dataset.touched = "1";
    });

    async function saveClientNotificationPrefs(){
      try{
        const wa=document.getElementById("notifPrefWhatsapp")?.checked||false;
        const sms=document.getElementById("notifPrefSms")?.checked||false;
        const em=document.getElementById("notifPrefEmail")?.checked||false;
        const events=Array.from(document.querySelectorAll(".notifPrefEventBox:checked")).map(function(el){ return el.value; });
        const r=await window.__nvSb.rpc("client_set_notification_prefs",{ p_whatsapp:wa, p_sms:sms, p_email:em, p_events:events });
        if(r.error) throw new Error(r.error.message);
        toast("Notification preferences saved");
      }catch(e){ toast("Could not save preferences: "+(e.message||e), "error"); logClientError("client_set_notification_prefs", e.message||e, "warning"); }
    }

    function renderClientActionNeeded(){
      const host=document.getElementById("clientActionNeededCard"); if(!host) return;
      let pool=[]; try{ pool=(typeof clientScopedParcels==="function")?clientScopedParcels():((state.parcels)||[]); }catch(e){ pool=state.parcels||[]; }
      const parcelItems=pool.filter(function(p){ return ["Refused","Consignee not available","Ready for return"].indexOf(p.status)>-1 || (typeof isDelayed==="function" && isDelayed(p) && p.status!=="Delivered"); });
      const missingInfoItems=pool.filter(function(p){ return p.status!=="Delivered" && p.status!=="Return to shipper" && p.status!=="Cancelled by client" && (!p.address || !p.phone); });
      let payable=0; try{ payable=(typeof clientMetrics==="function")?clientMetrics().payable:0; }catch(e){}
      const totalItems=parcelItems.length+missingInfoItems.length+(payable>0?1:0);
      if(!totalItems){ host.innerHTML=""; host.style.display="none"; return; }
      host.style.display="block";
      const parcelCards=parcelItems.slice(0,6).map(function(p){
        const isRefused=p.status==="Refused"; const isReturn=p.status==="Ready for return";
        const label=isRefused?"We need your decision":isReturn?"Return to shipper -- confirm":p.status==="Consignee not available"?"Approve reattempt":"Delayed -- update available";
        const eAwb=escLabelText(p.awb);
        return `<div class="ops-card"><div class="ops-card-head"><strong>${eAwb}</strong><span class="chip warn">${escLabelText(label)}</span></div><p class="footer-note">${escLabelText(p.consignee||"")} &middot; ${escLabelText(p.city||"")}</p><div class="inline-actions" style="margin-top:6px;flex-wrap:wrap;gap:6px"><button class="action-btn ghost" onclick="clientActionNeededReattempt('${eAwb}')">Approve reattempt</button><button class="action-btn ghost" onclick="clientActionNeededReturn('${eAwb}')">Return to shipper</button><button class="action-btn ghost" onclick="openClientParcelJourney('${eAwb}')">View journey</button><button class="action-btn ghost" onclick="clientActionNeededAskAi('${eAwb}')">Ask AI</button>${nvCanRaiseTicket(p)&&(typeof nvCanUseTab!=="function"||nvCanUseTab("tickets"))?`<button class="action-btn ghost" onclick="nvRaiseTicketFor('${eAwb}',event)">Report an issue</button>`:""}</div></div>`;
      });
      const missingInfoCards=missingInfoItems.slice(0,4).map(function(p){
        const eAwb=escLabelText(p.awb);
        return `<div class="ops-card"><div class="ops-card-head"><strong>${eAwb}</strong><span class="chip warn">Missing address or phone</span></div><p class="footer-note">${escLabelText(p.city||"")}</p><div class="inline-actions" style="margin-top:6px;flex-wrap:wrap;gap:6px"><button class="action-btn ghost" onclick="openClientParcelJourney('${eAwb}')">View journey</button></div></div>`;
      });
      const walletCard=payable>0 ? [`<div class="ops-card"><div class="ops-card-head"><strong>Wallet</strong><span class="chip warn">Payable balance ready</span></div><p class="footer-note">You have a payable balance waiting -- review it in your wallet.</p><div class="inline-actions" style="margin-top:6px;flex-wrap:wrap;gap:6px"><button class="action-btn ghost" onclick="typeof showClientTab==='function'&&showClientTab('wallet')">View wallet</button></div></div>`] : [];
      host.innerHTML=`<div class="panel nv-notice-warm"><div class="section-head"><div><h3>Action needed</h3><p>${totalItems} item(s) are waiting on a quick decision from you -- nothing urgent, just pick an option below.</p></div></div><div class="ops-list">`+parcelCards.concat(missingInfoCards).concat(walletCard).join("")+`</div></div>`;
    }

    function clientActionNeededReattempt(awb){
      if(typeof requestRedelivery==="function"){ requestRedelivery(awb); return; }
      toast("Could not send this request right now.","error");
    }
    function clientActionNeededReturn(awb){
      if(typeof requestReturnToOrigin==="function"){ requestReturnToOrigin(awb); return; }
      toast("Could not send this request right now.","error");
    }
    function clientActionNeededAskAi(awb){
      try{
        if(typeof window.novaxOpenAutopilot==="function") window.novaxOpenAutopilot();
        if(typeof window.novaxAutopilotSay==="function"){
          if(typeof state!=="undefined") state.selectedAwb=awb;
          window.novaxAutopilotSay("Why was this refused, or what's the next step for "+awb+"?",[
            { label:"Reattempt", kind:"local", type:"confirm_action", awb:awb },
            { label:"Return to shipper", kind:"local", type:"nv_review_issues" },
            { label:"Track Journey", kind:"local", type:"show_journey_awb", awb:awb }
          ]);
        }
      }catch(e){}
    }

    function nvReviewIssues(){
      try{
        if(typeof showClientTab==="function") showClientTab("dashboard");
        var ctx=typeof getClientContext==="function"?getClientContext():null;
        var firstIssueAwb=ctx&&ctx.firstIssueAwb;
        if(firstIssueAwb && typeof openClientParcelJourney==="function"){
          openClientParcelJourney(firstIssueAwb);
          return;
        }
        var board=document.getElementById("clientStatusBoard");
        if(board && board.style.display==="none" && typeof toggleStatusBoard==="function") toggleStatusBoard();
        setTimeout(function(){ var el=document.getElementById("clientStatusBoard"); if(el) el.scrollIntoView({behavior:"smooth",block:"start"}); },150);
      }catch(e){}
    }
    function wireCommandStripButtons(){
      try{
        var bIssues=document.getElementById("nvCsIssues");
        var bPrint=document.getElementById("nvCsPrint");
        var bWallet=document.getElementById("nvCsWallet");
        var bBook=document.getElementById("nvCsBook");
        if(bIssues && !bIssues._nvWired){ bIssues._nvWired=true; bIssues.addEventListener("click",nvReviewIssues); }
        if(bPrint && !bPrint._nvWired){ bPrint._nvWired=true; bPrint.addEventListener("click",function(){ if(typeof showClientTab==="function") showClientTab("awbLabel"); }); }
        if(bWallet && !bWallet._nvWired){ bWallet._nvWired=true; bWallet.addEventListener("click",function(){ if(typeof showClientTab==="function") showClientTab("wallet"); }); }
        if(bBook && !bBook._nvWired){ bBook._nvWired=true; bBook.addEventListener("click",function(){ if(window.novaxFocusFirstBookingField) window.novaxFocusFirstBookingField(); else if(typeof showClientTab==="function") showClientTab("newBooking"); }); }
      }catch(e){}
    }
    function renderDailyCommandCenter(){ return nvKeepPlace(function(){ return __renderDailyCommandCenter(); }); }
    function __renderDailyCommandCenter(){
      try{
        if(typeof state==="undefined" || !state.client) return;
        var strip=document.getElementById("nvCommandStrip");
        if(!strip) return;
        var ctx=typeof getClientContext==="function"?getClientContext():null;
        if(ctx && typeof canShowDailyCommandCenter==="function" && !canShowDailyCommandCenter(ctx)){ strip.style.display="none"; return; }
        strip.style.display="";
        var data=dailyCommandData();
        var briefEl=document.getElementById("nvCsBrief");
        var nextEl=document.getElementById("nvCsNext");
        if(briefEl) briefEl.textContent=data.briefingText;
        if(nextEl) nextEl.textContent=(ctx&&ctx.nextBestAction&&ctx.nextBestAction.detail)?ctx.nextBestAction.detail:data.nextAction.text;
        var bIssues=document.getElementById("nvCsIssues");
        var bPrint=document.getElementById("nvCsPrint");
        var bWallet=document.getElementById("nvCsWallet");
        var issueCount=ctx?ctx.issueCount:data.issues.length;
        var unprintedCount=ctx?ctx.unprintedCount:data.unprinted.length;
        // NovaX fix: the wallet quick-action must reflect real withdrawable
        // wallet money (clients.wallet_balance), not invoice-payable-pending.
        var walletBalanceForStrip=ctx?ctx.walletBalance:Number((state.client&&state.client.walletBalance)||0);
        if(bIssues) bIssues.style.display=issueCount>0?"":"none";
        if(bPrint) bPrint.style.display=unprintedCount>0?"":"none";
        if(bWallet) bWallet.style.display=walletBalanceForStrip>0?"":"none";
        wireCommandStripButtons();
      }catch(e){}
    }
    (function(){
      nvInterval(function(){ if(!document.hidden) renderDailyCommandCenter(); },20000);
      setTimeout(renderDailyCommandCenter,400);
      document.addEventListener("DOMContentLoaded",renderDailyCommandCenter);
    })();

    /* ===== NovaX AI Onboarding Tour (post-signup welcome + guided walkthrough) ===== */
    (function(){
      try{
        if(window.__novaxTourLoaded) return; window.__novaxTourLoaded=true;
        var qp=new URLSearchParams(location.search);
        var shouldRun = qp.get("onboarding")==="1";
        if(!shouldRun) return;

        var STEPS=[
          { tab:"dashboard", title:"Your Dashboard", text:"Everything starts here: live parcel counts, COD totals, and delivery health at a glance." },
          { tab:"newBooking", title:"New Booking", text:"Tap Create AWB here to book a single parcel. Add the consignee, city, and COD amount, and you are done." },
          { tab:"awbLabel", title:"AWB Label", text:"Every booking instantly generates a printable AWB with QR and barcode. Hand it to your rider or print it." },
          { tab:"bulkBooking", title:"Bulk Booking", text:"Shipping many orders at once? Download the CSV format, fill it in, and upload it here to create AWBs in bulk." },
          { tab:"integrations", title:"Store Integrations", text:"Connect Shopify, WooCommerce, or your own website here so new orders import automatically." },
          { tab:"reports", title:"Full Report", text:"See every parcel with filters and export it as CSV or PDF." },
          { tab:"payments", title:"Payments", text:"Delivered parcels turn into payable invoices here. Download them any time." },
          { tab:"wallet", title:"Wallet", text:"Track your balance and request a payout in a few taps whenever you are ready." },
          { tab:"logs", title:"Order Logs", text:"A clean audit trail of every status change for every parcel you have booked." },
          { tab:"subAccounts", title:"Sub Accounts", text:"Invite your team, finance, warehouse, or support, with their own scoped logins." },
          { tab:"support", title:"Talk To Your AI", text:"Tap the Autopilot button in the corner anytime. I read your live data and answer instantly." }
        ];
        var idx=-1;

        var style=document.createElement("style");
        style.textContent=".nvtour-overlay{position:fixed;inset:0;z-index:999999;background:rgba(4,12,9,.55);display:flex;align-items:center;justify-content:center;padding:18px;opacity:0;transition:opacity .3s ease;-webkit-tap-highlight-color:transparent;}.nvtour-overlay.show{opacity:1;}.nvtour-overlay.closing{opacity:0;}.nvtour-card{position:relative;box-sizing:border-box;width:min(94vw,410px);max-height:82vh;overflow:auto;background:#0b1f18;color:#eafff5;border:1px solid rgba(24,199,122,.35);border-radius:20px;padding:28px 22px 22px;box-shadow:var(--sh-1);text-align:center;-webkit-overflow-scrolling:touch;}.nvtour-x{position:absolute;top:8px;right:10px;background:transparent;border:none;color:#8fd8b9;font-size:22px;line-height:1;cursor:pointer;padding:6px 9px;}.nvtour-avatar{width:64px;height:64px;border-radius:50%;background:linear-gradient(145deg,#0d6b4d,#18c77a);display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto 14px;box-shadow:var(--glow-1);animation:nvtourFloat 2.6s ease-in-out infinite,nvtourPopIn .4s cubic-bezier(.34,1.56,.64,1);}.nvtour-avatar.sm{width:38px;height:38px;font-size:18px;margin:0;flex-shrink:0;}.nvtour-card h3{margin:0 0 8px;font-size:20px;animation:nvtourRise .3s ease both;}.nvtour-card p{margin:0 0 18px;color:#bfe9d8;font-size:15px;line-height:1.5;animation:nvtourRise .3s ease .05s both;}.nvtour-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}.nvtour-actions .nvtour-btn{animation:nvtourBtnIn .32s ease both;}.nvtour-actions .nvtour-btn:nth-child(2){animation-delay:.07s;}.nvtour-btn{box-sizing:border-box;min-height:46px;padding:0 18px;border-radius:var(--r-xl);font-weight:700;font-size:15px;border:none;cursor:pointer;flex:1;min-width:120px;transition:transform .15s ease;}.nvtour-btn:active{transform:scale(.96);}.nvtour-btn.primary{background:linear-gradient(145deg,#0d6b4d,#18c77a);color:#04130d;}.nvtour-btn.ghost{background:rgba(255,255,255,.08);color:#eafff5;}.nvtour-stephead{display:flex;align-items:center;gap:10px;text-align:left;margin-bottom:14px;animation:nvtourSlideL .3s ease both;}.nvtour-stephead b{font-size:13px;color:#8fd8b9;display:block;}.nvtour-dots{display:flex;gap:5px;margin-top:4px;}.nvtour-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.25);transition:all .2s ease;}.nvtour-dot.on{background:#18c77a;width:16px;border-radius:4px;animation:nvtourDotPop .3s ease;}.nvtour-glow{position:relative;z-index:2;border-radius:var(--r-lg);animation:nvtourGlowPulse 1s ease-in-out 2;}.nvtour-check{width:66px;height:66px;border-radius:50%;background:#18c77a;color:#04130d;font-size:32px;font-weight:900;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;box-shadow:var(--glow-1);animation:nvtourCheckPop .45s cubic-bezier(.34,1.56,.64,1);}@keyframes nvtourPop{0%{transform:scale(.9);}60%{transform:scale(1.03);}100%{transform:scale(1);}}@keyframes nvtourFloat{0%,100%{transform:translateY(0);}50%{transform:translateY(-5px);}}@keyframes nvtourPopIn{0%{transform:scale(.5);opacity:0;}100%{transform:scale(1);opacity:1;}}@keyframes nvtourRise{0%{opacity:0;transform:translateY(6px);}100%{opacity:1;transform:translateY(0);}}@keyframes nvtourBtnIn{0%{opacity:0;transform:translateY(8px);}100%{opacity:1;transform:translateY(0);}}@keyframes nvtourSlideL{0%{opacity:0;transform:translateX(-10px);}100%{opacity:1;transform:translateX(0);}}@keyframes nvtourDotPop{0%{transform:scale(.4);}70%{transform:scale(1.3);}100%{transform:scale(1);}}@keyframes nvtourGlowPulse{0%,100%{box-shadow:var(--ring);}50%{box-shadow:var(--ring);}}@keyframes nvtourCheckPop{0%{transform:scale(0);opacity:0;}60%{transform:scale(1.15);opacity:1;}100%{transform:scale(1);opacity:1;}}@media (max-width:760px){.nvtour-overlay{align-items:flex-end;padding:0;background:rgba(6,18,13,.4);}.nvtour-card{width:100%;max-width:100%;max-height:64vh;border-radius:20px 20px 0 0;box-shadow:var(--sh-1);}}@media (max-width:480px){.nvtour-card{padding:22px 16px 16px;}.nvtour-btn{min-width:0;}}@media (prefers-reduced-motion:reduce){.nvtour-avatar,.nvtour-card h3,.nvtour-card p,.nvtour-actions .nvtour-btn,.nvtour-stephead,.nvtour-glow,.nvtour-check,.nvtour-dot.on{animation:none!important;}}";
        document.head.appendChild(style);

        var overlay=document.createElement("div"); overlay.className="nvtour-overlay";
        overlay.innerHTML='<div class="nvtour-card" id="nvtourCard"></div>';
        document.body.appendChild(overlay);
        var card=overlay.querySelector("#nvtourCard");

        function paint(html, dir){
          var fx = dir===1 ? 22 : (dir===-1 ? -22 : 0);
          var fy = dir ? 0 : 14;
          card.style.transition="none"; card.style.opacity="0"; card.style.transform="translate("+fx+"px,"+fy+"px) scale(.95)";
          card.innerHTML=html;
          void card.offsetWidth;
          card.style.transition="opacity .3s ease, transform .38s cubic-bezier(.34,1.56,.64,1)";
          card.style.opacity="1"; card.style.transform="translate(0,0) scale(1)";
        }
        function xBtn(){ return '<button class="nvtour-x" id="nvtourX" aria-label="Close">\u00d7</button>'; }
        function bindX(){ var b=document.getElementById("nvtourX"); if(b) b.addEventListener("click",finish); }
        function clearGlow(){ document.querySelectorAll(".nvtour-glow").forEach(function(el){ el.classList.remove("nvtour-glow"); }); }

        function renderIntro(){
          clearGlow();
          paint(xBtn()+'<div class="nvtour-avatar">\ud83e\udd16</div><h3>Hi, I am Nova</h3><p>Your NovaX AI assistant. I can walk you through your new workspace, or you can dive in yourself.</p><div class="nvtour-actions"><button class="nvtour-btn primary" id="nvtourStart">Take the Tour</button><button class="nvtour-btn ghost" id="nvtourSkip">I will Surf Myself</button></div>', 0);
          bindX();
          document.getElementById("nvtourStart").addEventListener("click",startTour);
          document.getElementById("nvtourSkip").addEventListener("click",renderSurf);
        }

        function renderSurf(){
          clearGlow();
          paint(xBtn()+'<div class="nvtour-avatar">\ud83e\udd16</div><h3>All yours</h3><p>Feel free to explore. You can reach me anytime from the green AI bubble in the corner.</p><div class="nvtour-actions"><button class="nvtour-btn primary" id="nvtourExit">Exit</button></div>', 0);
          bindX();
          document.getElementById("nvtourExit").addEventListener("click",finish);
        }

        function openMobileMenuForTour(){
          try{
            if(window.innerWidth<=760){
              var menuEl=document.getElementById("clientMenu");
              var toggleBtn=document.getElementById("clientMenuToggle");
              if(menuEl) menuEl.classList.add("open");
              if(toggleBtn) toggleBtn.setAttribute("aria-expanded","true");
            }
          }catch(e){}
        }
        function closeMobileMenuForTour(){
          try{
            if(window.innerWidth<=760){
              var menuEl=document.getElementById("clientMenu");
              var toggleBtn=document.getElementById("clientMenuToggle");
              if(menuEl) menuEl.classList.remove("open");
              if(toggleBtn) toggleBtn.setAttribute("aria-expanded","false");
            }
          }catch(e){}
        }
        function renderStep(dir){
          var s=STEPS[idx];
          try{ if(typeof showClientTab==="function") showClientTab(s.tab); }catch(e){}
          openMobileMenuForTour();
          try{ window.scrollTo({top:0,behavior:"smooth"}); }catch(e){ window.scrollTo(0,0); }
          clearGlow();
          var navBtn=document.querySelector('[data-client-tab="'+s.tab+'"]');
          if(navBtn){
            void navBtn.offsetWidth;
            navBtn.classList.add("nvtour-glow");
            if(window.innerWidth<=760){
              try{ navBtn.scrollIntoView({behavior:"smooth",block:"center"}); }catch(e){}
            }
          }
          var dots=STEPS.map(function(_,i){ return '<span class="nvtour-dot'+(i===idx?" on":"")+'"></span>'; }).join("");
          var backHtml = idx>0 ? '<button class="nvtour-btn ghost" id="nvtourBack">Back</button>' : "";
          var nextLabel = idx===STEPS.length-1 ? "Finish" : "Next";
          paint(xBtn()+'<div class="nvtour-stephead"><span class="nvtour-avatar sm">\ud83e\udd16</span><div><b>Step '+(idx+1)+' of '+STEPS.length+'</b><div class="nvtour-dots">'+dots+'</div></div></div><h3>'+s.title+'</h3><p>'+s.text+'</p><div class="nvtour-actions">'+backHtml+'<button class="nvtour-btn primary" id="nvtourNext">'+nextLabel+'</button></div>', dir);
          bindX();
          var backBtn=document.getElementById("nvtourBack"); if(backBtn) backBtn.addEventListener("click",function(){ idx--; renderStep(-1); });
          document.getElementById("nvtourNext").addEventListener("click",function(){ if(idx===STEPS.length-1){ renderDone(); return; } idx++; renderStep(1); });
        }

        function renderDone(){
          clearGlow();
          paint(xBtn()+'<div class="nvtour-check">\u2713</div><h3>You are all set</h3><p>Explore freely, and tap the green AI bubble anytime you need help.</p>', 0);
          bindX();
          setTimeout(finish,1300);
        }

        function startTour(){ idx=0; renderStep(1); }

        function finish(){
          clearGlow();
          closeMobileMenuForTour();
          overlay.classList.add("closing");
          setTimeout(function(){ try{ overlay.remove(); }catch(e){} },300);
          try{ var u=new URL(window.location.href); u.searchParams.delete("onboarding"); history.replaceState(null,"",u.pathname+(u.search||"")); }catch(e){}
        }

        requestAnimationFrame(function(){ overlay.classList.add("show"); renderIntro(); });
      }catch(e){ console.warn("NovaX tour init failed",e); }
    })();
    /* ================= NovaX PHASE 3 (Tasks 13-19) =================
       Additive UX layer only: "Today" cockpit, inline bulk-upload error
       editing, header omni-search, bulk multi-select + sticky action bar,
       provider-agnostic address autocomplete, actionable empty states and a
       notification centre.
       HARD CONSTRAINT COMPLIANCE: nothing here reads, writes, recomputes or
       re-formats wallet balances, withdrawal fees, payouts, bank details or
       invoices. Money surfaces are only ever deep-linked (showClientTab), and
       no wallet/invoice/withdrawal RPC is called from this block. */
    (function nvPhase3(){
      function nvEsc(v){
        try{ return escLabelText(v==null?"":String(v)); }
        catch(e){ return String(v==null?"":v).replace(/[&<>"']/g,function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
      }
      function nvSafeCall(fn){ try{ return fn(); }catch(e){ return undefined; } }
      function nvMyParcels(){
        var list=nvSafeCall(function(){ return (state&&state.parcels)||[]; })||[];
        var mine=nvSafeCall(function(){
          if(typeof myClientId!=="undefined" && myClientId) return list.filter(function(p){ return p&&p.clientId===myClientId; });
          return null;
        });
        return mine&&mine.length?mine:list;
      }
      function nvAging(p){ var h=nvSafeCall(function(){ return agingHours(p); }); return typeof h==="number"?h:0; }
      function nvIsOwner(){ var r=nvSafeCall(function(){ return nvIsOwnerSeat(); }); return r===undefined?true:!!r; }
      function nvTab(id){ nvSafeCall(function(){ showClientTab(id); }); }
      var NEEDS_ME=["Refused","Consignee not available","Out of service area","Ready for return"];
      var MOVING=["Collected by rider","Arrived at warehouse","Parcel now in transit","Parcel received at destination","Parcel out for delivery"];

      /* ---------- Task 13: "Today" cockpit (dashboard landing view) ---------- */
      function nvTodayBuckets(){
        var ps=nvMyParcels();
        var needs=[], moving=[], next=[], stuck=[], missing=[];
        ps.forEach(function(p){
          if(!p||!p.awb) return;
          var st=String(p.status||"");
          if(NEEDS_ME.indexOf(st)>=0) needs.push(p);
          else if(MOVING.indexOf(st)>=0){
            moving.push(p);
            if(nvAging(p)>48) stuck.push(p);
          }
          else if(st==="New booked") next.push(p);
          var addr=String(p.address||"").trim();
          if(!addr || /^address pending$/i.test(addr) || !String(p.phone||"").replace(/\D/g,"").length) missing.push(p);
        });
        return { all:ps, needs:needs, moving:moving, next:next, stuck:stuck, missing:missing,
          delivered:ps.filter(function(p){ return String(p.status||"")==="Delivered"; }) };
      }
      window.__novaxTodayContext=function(){
        var b=nvTodayBuckets();
        function slim(p){ return { awb:p.awb, status:p.status, city:p.city, consignee:p.consignee, address:p.address, phone:p.phone, ageHours:Math.round(nvAging(p)) }; }
        return { needsMe:b.needs.map(slim), stuck:b.stuck.map(slim), missingAddress:b.missing.map(slim),
          outForDelivery:b.moving.filter(function(p){ return p.status==="Parcel out for delivery"; }).map(slim),
          newBooked:b.next.map(slim), delivered:b.delivered.map(slim), total:b.all.length };
      };
      function nvCockpitCss(){
        if(document.getElementById("nvP3Css")) return;
        var s=document.createElement("style"); s.id="nvP3Css";
        s.textContent=".nv-cockpit{background:var(--nvu-bg);border:1px solid #d7ede1;border-radius:14px;padding:14px 16px;margin-bottom:16px;box-shadow:var(--sh-1)}"
          +".nv-cockpit-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}"
          +".nv-cockpit-head b{font-size:15px;color:var(--nvu-ink)}"
          +".nv-cockpit-head .nv-c-sub{font-size:11.5px;color:var(--nvu-ink-2);font-weight:600}"
          +".nv-cockpit-cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}"
          +".nv-c-col{background:var(--nvu-bg-2);border:1px solid var(--nvu-good-bg);border-radius:var(--r-xl);padding:10px 12px;min-width:0}"
          +".nv-c-col h4{margin:0 0 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--nvu-accent)}"
          +".nv-c-item{background:var(--nvu-bg);border:1px solid var(--nvu-good-bg);border-radius:var(--r-lg);padding:8px 10px;margin-bottom:7px}"
          +".nv-c-item strong{font-size:12.5px;color:var(--nvu-ink);display:block}"
          +".nv-c-item span{font-size:11px;color:var(--nvu-ink-2);display:block;margin-top:1px}"
          +".nv-c-item .nv-c-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}"
          +".nv-c-btn{border:1px solid #bfe8d7;background:var(--nvu-bg);color:var(--nvu-accent);border-radius:var(--r-md);font-size:11px;font-weight:700;padding:5px 9px;cursor:pointer;min-height:30px}"
          +".nv-c-btn.solid{background:var(--nvu-accent);color:var(--nvu-accent-ink);border-color:var(--nvu-accent)}"
          +".nv-c-empty{font-size:11.5px;color:var(--nvu-ink-2)}"
          +".nv-more-wrap{position:relative;display:inline-block}"
          +".nv-more-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:60;background:var(--nvu-bg);border:1px solid #d7ede1;border-radius:var(--r-lg);box-shadow:var(--glow-1);padding:6px;display:none;min-width:190px}"
          +".nv-more-wrap.open .nv-more-menu{display:block}"
          +".nv-more-menu .client-tab{display:block!important;width:100%;text-align:left;margin:2px 0}"
          +".nv-omni{position:fixed;z-index:99990;background:var(--nvu-bg);border:1px solid #d7ede1;border-radius:var(--r-xl);box-shadow:var(--glow-1);max-height:340px;overflow:auto;display:none;padding:6px}"
          +".nv-omni.open{display:block}"
          +".nv-omni-g{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#7fa596;padding:6px 8px 2px;font-weight:800}"
          +".nv-omni-i{padding:7px 9px;border-radius:var(--r-md);cursor:pointer;font-size:12.5px;color:var(--nvu-ink)}"
          +".nv-omni-i span{display:block;font-size:11px;color:var(--nvu-ink-2)}"
          +".nv-omni-i.active,.nv-omni-i:hover{background:#eafff5}"
          +".nv-bulkbar{position:fixed;left:0;right:0;bottom:0;z-index:99991;background:var(--nvu-ink);color:#fff;padding:10px 14px;padding-bottom:calc(10px + env(safe-area-inset-bottom));display:none;gap:8px;align-items:center;flex-wrap:wrap;box-shadow:var(--sh-1)}"
          +".nv-bulkbar.open{display:flex}"
          +".nv-bulkbar b{font-size:13px;margin-right:6px}"
          +".nv-bulkbar button{border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.1);color:#fff;border-radius:var(--r-lg);font-size:12px;font-weight:700;padding:8px 11px;min-height:38px;cursor:pointer}"
          +".nv-bulkbar button.solid{background:#14c77b;border-color:#14c77b;color:#06231a}"
          +".nv-bell{position:relative;border:1px solid #bfe8d7;background:var(--nvu-bg);color:var(--nvu-accent);border-radius:var(--r-lg);min-height:38px;padding:0 11px;font-size:15px;cursor:pointer}"
          +".nv-bell-badge{position:absolute;top:-6px;right:-6px;min-width:17px;height:17px;padding:0 4px;border-radius:var(--r-lg);background:#b03a2e;color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center}"
          +".nv-notif{position:fixed;z-index:99992;width:330px;max-width:calc(100vw - 24px);max-height:60vh;overflow:auto;background:var(--nvu-bg);border:1px solid #d7ede1;border-radius:var(--r-xl);box-shadow:var(--glow-1);display:none;padding:8px}"
          +".nv-notif.open{display:block}"
          +".nv-notif-i{border-bottom:1px solid var(--nvu-neutral-bg);padding:8px 8px;font-size:12.5px;color:var(--nvu-ink);cursor:pointer}"
          +".nv-notif-i:last-child{border-bottom:0}"
          +".nv-notif-i.unread{background:var(--nvu-bg-2)}"
          +".nv-notif-i span{display:block;font-size:11px;color:var(--nvu-ink-2);margin-top:2px}"
          +".nv-bulkfix{width:100%;box-sizing:border-box;border:1px solid #cfe3d9;border-radius:var(--r-sm);padding:6px 8px;font:inherit;font-size:12px;min-height:34px}"
          +".nv-bulkfix.bad{border-color:#e0857a;background:#fff6f4}"
          +".nv-bulkgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:8px}"
          +".nv-bulkgrid label{font-size:10.5px;font-weight:800;color:var(--nvu-ink-2);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:3px}"
          +"@media (max-width:900px){.nv-cockpit-cols{grid-template-columns:1fr}}";
        document.head.appendChild(s);
      }
      function nvItem(p,acts){
        return '<div class="nv-c-item"><strong>'+nvEsc(p.awb)+'</strong><span>'+nvEsc(p.status||"")+(p.city?" \u00b7 "+nvEsc(p.city):"")+(p.consignee?" \u00b7 "+nvEsc(p.consignee):"")+'</span><div class="nv-c-acts">'+acts+"</div></div>";
      }
      function nvRenderCockpit(){
        var anchor=document.getElementById("clientActionNeededCard");
        if(!anchor||!anchor.parentNode) return;
        nvCockpitCss();
        var box=document.getElementById("nvCockpit");
        if(!box){
          box=document.createElement("div"); box.id="nvCockpit"; box.className="nv-cockpit";
          anchor.parentNode.insertBefore(box,anchor);
        }
        if(document.activeElement && box.contains(document.activeElement)) return;
        var b=nvTodayBuckets();
        /* Same predicate the command strip uses, so the two cannot disagree.
           Falls back to the old bucket if the helper is somehow out of scope,
           which keeps a stale cached page rendering rather than blank. */
        var attn=(typeof nvAttentionParcels==="function") ? nvAttentionParcels() : b.needs;
        var needsList=attn.concat(b.stuck.filter(function(p){ return attn.indexOf(p)<0; })).slice(0,4);
        var needsHtml=needsList.length?needsList.map(function(p){
          return nvItem(p,'<button class="nv-c-btn" data-nv-cock="journey" data-awb="'+nvEsc(p.awb)+'">Journey</button>'
            +'<button class="nv-c-btn" data-nv-cock="reattempt" data-awb="'+nvEsc(p.awb)+'">Re-attempt</button>');
        }).join(""):'<p class="nv-c-empty">Nothing needs you right now. Exceptions and parcels stuck over 48 hours appear here.</p>';
        var movingCounts={};
        b.moving.forEach(function(p){ movingCounts[p.status]=(movingCounts[p.status]||0)+1; });
        var movingHtml=Object.keys(movingCounts).length?Object.keys(movingCounts).map(function(k){
          return '<div class="nv-c-item"><strong>'+movingCounts[k]+" parcel(s)</strong><span>"+nvEsc(k)+"</span></div>";
        }).join("")+(b.stuck.length?'<p class="nv-c-empty">'+b.stuck.length+" moving parcel(s) have not changed status in over 48 hours.</p>":"")
          :'<p class="nv-c-empty">No parcels in transit yet. Booked parcels show here once a rider collects them.</p>';
        var nextHtml="";
        if(b.next.length){
          nextHtml+='<div class="nv-c-item"><strong>'+b.next.length+' new booked parcel(s)</strong><span>Labels not printed yet</span><div class="nv-c-acts"><button class="nv-c-btn solid" data-nv-cock="printnew">Print labels</button><button class="nv-c-btn" data-nv-cock="tab" data-tab="awbLabel">AWB tab</button></div></div>';
        }
        if(b.missing.length){
          nextHtml+='<div class="nv-c-item"><strong>'+b.missing.length+' parcel(s) missing address or phone</strong><span>Fix before the rider attempts delivery</span><div class="nv-c-acts"><button class="nv-c-btn" data-nv-cock="journey" data-awb="'+nvEsc(b.missing[0].awb)+'">Open first</button></div></div>';
        }
        nextHtml+='<div class="nv-c-item"><strong>Book more</strong><span>Single, pasted WhatsApp order, or bulk CSV</span><div class="nv-c-acts"><button class="nv-c-btn solid" data-nv-cock="tab" data-tab="newBooking">New booking</button><button class="nv-c-btn" data-nv-cock="tab" data-tab="bulkBooking">Bulk upload</button></div></div>';
        if(b.delivered.length){
          nextHtml+='<div class="nv-c-item"><strong>'+b.delivered.length+' delivered parcel(s)</strong><span>Check payment status in Payments</span><div class="nv-c-acts"><button class="nv-c-btn" data-nv-cock="tab" data-tab="payments">Open Payments</button>'
            +(nvIsOwner()?'<button class="nv-c-btn" data-nv-cock="tab" data-tab="wallet">Open Wallet</button>':"")+"</div></div>";
        }
        box.innerHTML='<div class="nv-cockpit-head"><b>Today</b><span class="nv-c-sub">'+b.all.length+' parcel(s) \u00b7 '+attn.length+' need attention \u00b7 '+b.moving.length+' moving</span></div>'
          +'<div class="nv-cockpit-cols">'
          +'<div class="nv-c-col"><h4>What needs me</h4>'+needsHtml+"</div>"
          +'<div class="nv-c-col"><h4>What\u2019s moving</h4>'+movingHtml+"</div>"
          +'<div class="nv-c-col"><h4>What\u2019s next</h4>'+nextHtml+"</div>"
          +"</div>";
      }
      document.addEventListener("click",function(ev){
        var t=ev.target.closest?ev.target.closest("[data-nv-cock]"):null;
        if(!t) return;
        var kind=t.getAttribute("data-nv-cock"), awb=t.getAttribute("data-awb");
        if(kind==="journey") nvSafeCall(function(){ openClientParcelJourney(awb); });
        else if(kind==="reattempt") nvSafeCall(function(){ requestRedelivery(awb); });
        else if(kind==="tab") nvTab(t.getAttribute("data-tab"));
        else if(kind==="printnew"){
          var list=nvTodayBuckets().next.map(function(p){ return p.awb; });
          if(!list.length){ nvSafeCall(function(){ toast("No new booked parcels to print."); }); return; }
          nvSafeCall(function(){ printLabels(list); });
        }
      });

      /* Demote rarely used tabs behind a "More" menu (all 11 tabs stay available). */
      var RARE_TABS=["integrations","logs","subAccounts","support"];
      function nvGroupRareTabs(){
        var tabs=document.querySelectorAll("[data-client-tab]");
        if(!tabs.length || document.getElementById("nvMoreWrap")) return;
        var bar=tabs[0].parentNode; if(!bar) return;
        var wrap=document.createElement("div"); wrap.className="nv-more-wrap"; wrap.id="nvMoreWrap";
        var btn=document.createElement("button");
        btn.type="button"; btn.className="client-tab"; btn.id="nvMoreBtn"; btn.setAttribute("aria-expanded","false");
        btn.textContent="More \u25be";
        var menu=document.createElement("div"); menu.className="nv-more-menu"; menu.id="nvMoreMenu";
        wrap.appendChild(btn); wrap.appendChild(menu); bar.appendChild(wrap);
        RARE_TABS.forEach(function(id){
          var el=bar.querySelector('[data-client-tab="'+id+'"]');
          if(el) menu.appendChild(el);
        });
        btn.addEventListener("click",function(e){
          e.stopPropagation();
          var open=wrap.classList.toggle("open");
          btn.setAttribute("aria-expanded",open?"true":"false");
        });
        document.addEventListener("click",function(e){ if(!wrap.contains(e.target)){ wrap.classList.remove("open"); btn.setAttribute("aria-expanded","false"); } });
        menu.addEventListener("click",function(){ wrap.classList.remove("open"); });
      }

      /* ---------- Task 15: header omni-search ---------- */
      var omniBox=null, omniItems=[], omniIdx=-1, omniTimer=null;
      function nvOmniEl(){
        if(!omniBox){ omniBox=document.createElement("div"); omniBox.className="nv-omni"; omniBox.id="nvOmni"; document.body.appendChild(omniBox); }
        return omniBox;
      }
      function nvOmniClose(){ if(omniBox){ omniBox.classList.remove("open"); } omniIdx=-1; omniItems=[]; }
      function nvOmniPosition(input){
        var r=input.getBoundingClientRect(), el=nvOmniEl();
        el.style.top=(r.bottom+6)+"px";
        el.style.left=Math.max(8,Math.min(r.left,window.innerWidth-330))+"px";
        el.style.width=Math.max(260,Math.min(r.width,420))+"px";
      }
      function nvOmniSearch(q){
        q=String(q||"").trim().toLowerCase();
        if(q.length<2) return [];
        var digits=q.replace(/\D/g,"");
        var out=[];
        nvMyParcels().forEach(function(p){
          if(!p||!p.awb) return;
          var group=null;
          if(String(p.awb).toLowerCase().indexOf(q)>=0) group="AWB";
          else if(String(p.consignee||"").toLowerCase().indexOf(q)>=0) group="Consignee";
          else if(digits.length>=3 && String(p.phone||"").replace(/\D/g,"").indexOf(digits)>=0) group="Phone";
          else if(String(p.orderId||"").toLowerCase().indexOf(q)>=0) group="Order ID";
          else if(String(p.city||"").toLowerCase().indexOf(q)>=0) group="City";
          if(group) out.push({ group:group, awb:p.awb, line1:p.awb, line2:[p.consignee,p.city,p.status].filter(Boolean).join(" \u00b7 ") });
        });
        var order=["AWB","Consignee","Phone","Order ID","City"];
        out.sort(function(a,b){ return order.indexOf(a.group)-order.indexOf(b.group); });
        return out.slice(0,12);
      }
      function nvOmniRender(input){
        var el=nvOmniEl();
        if(!omniItems.length){ nvOmniClose(); return; }
        var html="", last=null;
        omniItems.forEach(function(it,i){
          if(it.group!==last){ html+='<div class="nv-omni-g">'+nvEsc(it.group)+"</div>"; last=it.group; }
          html+='<div class="nv-omni-i'+(i===omniIdx?" active":"")+'" role="option" data-nv-omni="'+nvEsc(it.awb)+'">'+nvEsc(it.line1)+"<span>"+nvEsc(it.line2)+"</span></div>";
        });
        el.innerHTML=html; nvOmniPosition(input); el.classList.add("open");
      }
      function nvOmniOpen(awb,input){
        nvOmniClose();
        if(input) input.blur();
        nvSafeCall(function(){ openClientParcelJourney(awb); });
      }
      function nvWireOmni(){
        var input=document.getElementById("clientSearch");
        if(!input||input.getAttribute("data-nv-omni-wired")) return;
        input.setAttribute("data-nv-omni-wired","1");
        input.setAttribute("role","combobox");
        input.setAttribute("aria-autocomplete","list");
        input.setAttribute("autocomplete","off");
        try{ input.placeholder="Search AWB, consignee, phone, order ID, city"; }catch(e){}
        input.addEventListener("input",function(){
          clearTimeout(omniTimer);
          omniTimer=setTimeout(function(){ omniItems=nvOmniSearch(input.value); omniIdx=-1; nvOmniRender(input); },170);
        });
        input.addEventListener("keydown",function(e){
          if(!omniItems.length) return;
          if(e.key==="ArrowDown"){ e.preventDefault(); omniIdx=(omniIdx+1)%omniItems.length; nvOmniRender(input); }
          else if(e.key==="ArrowUp"){ e.preventDefault(); omniIdx=(omniIdx-1+omniItems.length)%omniItems.length; nvOmniRender(input); }
          else if(e.key==="Enter"){
            var pick=omniIdx>=0?omniItems[omniIdx]:omniItems[0];
            if(pick){ e.preventDefault(); nvOmniOpen(pick.awb,input); }
          }
          else if(e.key==="Escape") nvOmniClose();
        });
        input.addEventListener("blur",function(){ setTimeout(nvOmniClose,180); });
        nvOmniEl().addEventListener("mousedown",function(e){
          var it=e.target.closest?e.target.closest("[data-nv-omni]"):null;
          if(it){ e.preventDefault(); nvOmniOpen(it.getAttribute("data-nv-omni"),input); }
        });
        window.addEventListener("resize",function(){ if(omniBox&&omniBox.classList.contains("open")) nvOmniPosition(input); });
      }

      /* ---------- Task 16: bulk multi-select + sticky action bar ---------- */
      var nvSel=Object.create(null);
      function nvSelList(){ return Object.keys(nvSel).filter(function(k){ return nvSel[k]; }); }
      function nvBar(){
        var bar=document.getElementById("nvBulkBar");
        if(!bar){
          bar=document.createElement("div"); bar.id="nvBulkBar"; bar.className="nv-bulkbar";
          bar.innerHTML='<b id="nvBulkCount">0 selected</b>'
            +'<button class="solid" data-nv-bulk="print">Print labels</button>'
            +'<button data-nv-bulk="reattempt">Request re-attempt</button>'
            +'<button data-nv-bulk="message">Message customers</button>'
            +'<button data-nv-bulk="export">Export selected</button>'
            +'<button data-nv-bulk="clear">Clear</button>';
          document.body.appendChild(bar);
        }
        return bar;
      }
      function nvBarSync(){
        var bar=nvBar(), n=nvSelList().length;
        bar.querySelector("#nvBulkCount").textContent=n+" selected";
        bar.classList.toggle("open",n>0);
        var ab=document.querySelector(".nvauto-btn");
        if(ab) ab.classList.toggle("nv-above-stickybar",n>0);
      }
      function nvDecorateParcelRows(){
        var tbody=document.getElementById("clientParcelRows");
        if(!tbody) return;
        var thead=tbody.parentNode?tbody.parentNode.querySelector("thead tr"):null;
        if(thead && !thead.querySelector("[data-nv-selall]")){
          var th=document.createElement("th");
          th.style.width="34px";
          th.innerHTML='<input type="checkbox" data-nv-selall="1" aria-label="Select all parcels">';
          thead.insertBefore(th,thead.firstChild);
        }
        Array.prototype.forEach.call(tbody.querySelectorAll("tr"),function(tr){
          if(tr.querySelector("[data-nv-sel]")) return;
          var m=/openClientParcelJourney\('([^']+)'\)/.exec(tr.getAttribute("onclick")||"");
          if(!m){ if(tr.cells.length===1){ tr.cells[0].colSpan=(tr.cells[0].colSpan||1)+1; } return; }
          var awb=m[1];
          var td=tr.insertCell(0);
          td.style.width="34px";
          td.innerHTML='<input type="checkbox" data-nv-sel="'+nvEsc(awb)+'" aria-label="Select '+nvEsc(awb)+'"'+(nvSel[awb]?" checked":"")+">";
          td.addEventListener("click",function(e){ e.stopPropagation(); });
        });
      }
      document.addEventListener("change",function(e){
        var t=e.target;
        if(t&&t.getAttribute&&t.getAttribute("data-nv-sel")){
          nvSel[t.getAttribute("data-nv-sel")]=t.checked; nvBarSync();
        } else if(t&&t.getAttribute&&t.getAttribute("data-nv-selall")){
          var boxes=document.querySelectorAll("[data-nv-sel]");
          Array.prototype.forEach.call(boxes,function(b){ b.checked=t.checked; nvSel[b.getAttribute("data-nv-sel")]=t.checked; });
          nvBarSync();
        }
      });
      document.addEventListener("click",function(e){
        var b=e.target.closest?e.target.closest("[data-nv-bulk]"):null;
        if(!b) return;
        var act=b.getAttribute("data-nv-bulk"), list=nvSelList();
        if(act==="clear"){
          nvSel=Object.create(null);
          Array.prototype.forEach.call(document.querySelectorAll("[data-nv-sel],[data-nv-selall]"),function(x){ x.checked=false; });
          nvBarSync(); return;
        }
        if(!list.length){ nvSafeCall(function(){ toast("Select at least one parcel first."); }); return; }
        if(act==="print") nvSafeCall(function(){ printLabels(list); });
        else if(act==="reattempt"){
          if(!window.confirm("Request a re-attempt for "+list.length+" parcel(s)?")) return;
          list.forEach(function(a){ nvSafeCall(function(){ requestRedelivery(a); }); });
        }
        else if(act==="message") list.slice(0,5).forEach(function(a){ nvSafeCall(function(){ messageCustomer(a); }); });
        else if(act==="export"){
          var ps=nvMyParcels().filter(function(p){ return list.indexOf(p.awb)>=0; });
          var cell=function(v){ return (typeof csvCell==="function")?csvCell(v):'"'+String(v==null?"":v).replace(/"/g,'""')+'"'; };
          var head=["AWB","Date","Consignee","Phone","City","Address","Status","COD","Order ID"].map(cell).join(",");
          var body=ps.map(function(p){ return [p.awb,p.date,p.consignee,p.phone,p.city,p.address,p.status,p.cod,p.orderId].map(cell).join(","); }).join("\n");
          var blob=new Blob([head+"\n"+body],{type:"text/csv;charset=utf-8;"});
          var a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="novax-selected-parcels.csv";
          document.body.appendChild(a); a.click(); a.remove();
          nvSafeCall(function(){ toast(list.length+" parcel(s) exported.","success"); });
        }
      });

      /* ---------- Task 17: provider-agnostic address autocomplete ----------
         Reads window.NOVAX_CONFIG.ADDRESS_AUTOCOMPLETE = { url, key, provider }.
         With no key configured it stays completely silent (no network calls,
         no UI change, typing works exactly as before). */
      function nvAddrCfg(){
        var c=nvSafeCall(function(){ return window.NOVAX_CONFIG&&window.NOVAX_CONFIG.ADDRESS_AUTOCOMPLETE; });
        return (c&&c.url&&c.key)?c:null;
      }
      function nvWireAddress(){
        var cfg=nvAddrCfg(); if(!cfg) return;
        ["bookingAddress","pickupAddress"].forEach(function(id){
          var el=document.getElementById(id);
          if(!el||el.getAttribute("data-nv-addr")) return;
          el.setAttribute("data-nv-addr","1");
          var timer=null;
          el.addEventListener("input",function(){
            clearTimeout(timer);
            timer=setTimeout(function(){
              var q=el.value.trim(); if(q.length<4) return;
              var url=cfg.url.replace("{q}",encodeURIComponent(q)).replace("{key}",encodeURIComponent(cfg.key));
              if(url.indexOf("{q}")<0 && url===cfg.url) url=cfg.url+encodeURIComponent(q);
              fetch(url).then(function(r){ return r.ok?r.json():null; }).then(function(d){
                if(!d) return;
                var arr=Array.isArray(d)?d:(d.predictions||d.features||d.results||d.suggestions||[]);
                var opts=arr.map(function(x){ return x.description||x.label||x.display_name||x.formatted||x.text||(x.properties&&x.properties.label)||""; }).filter(Boolean).slice(0,5);
                if(!opts.length) return;
                var host=document.getElementById("nvAddrSug_"+id);
                if(!host){ host=document.createElement("div"); host.id="nvAddrSug_"+id; host.style.cssText="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"; el.parentNode.appendChild(host); }
                host.innerHTML=opts.map(function(o){ return '<button type="button" class="nv-c-btn" data-nv-addr-pick="'+nvEsc(o)+'" data-nv-addr-target="'+id+'">'+nvEsc(o)+"</button>"; }).join("");
              })["catch"](function(){});
            },300);
          });
        });
      }
      document.addEventListener("click",function(e){
        var b=e.target.closest?e.target.closest("[data-nv-addr-pick]"):null;
        if(!b) return;
        var target=document.getElementById(b.getAttribute("data-nv-addr-target"));
        if(target){ target.value=b.getAttribute("data-nv-addr-pick"); target.dispatchEvent(new Event("change")); }
        var host=b.parentNode; if(host) host.innerHTML="";
      });

      /* ---------- Task 14: inline bulk-upload error editing ----------
         Wraps parseCsv to remember the raw grid, then re-runs the EXISTING
         validateBulkRows() after each fix. Parsing, validation rules and the
         import path (importValidBulkRowsOnly -> importBulkRows -> the same
         client_book_parcel RPC) are unchanged. */
      var nvCsvRows=null;
      var __nvOrigParseCsv=parseCsv;
      parseCsv=function(text){ var rows=__nvOrigParseCsv(text); nvCsvRows=rows.map(function(r){ return r.slice(); }); return rows; };
      window.parseCsv=parseCsv;
      var PROBLEM_COL={ phone:/phone/i, city:/city/i, address:/address/i, product:/product|item|detail/i, cod:/cod|amount/i, weight:/weight/i, dup_order:/order/i, dup_ref:/ref/i, dup_row:/consignee|name/i, consignee:/consignee|name/i };
      function nvBulkFixGrid(parsed){
        if(!nvCsvRows||nvCsvRows.length<2) return "";
        var header=nvCsvRows[0];
        var invalid=[];
        (parsed.results||[]).forEach(function(r,i){ if(!r.ok) invalid.push({ r:r, i:i }); });
        if(!invalid.length) return "";
        return '<div class="ops-card" id="nvBulkFixCard" style="margin-top:12px">'
          +'<div class="ops-card-head"><strong>Fix rejected rows here</strong><span class="chip warn">'+invalid.length+" row(s)</span></div>"
          +'<p class="footer-note">Edit a cell and it is re-validated instantly. Highlighted cells are the ones that failed. When rows turn valid, use the import button above.</p>'
          +invalid.map(function(o){
            var codes=(o.r.problems||[]).map(function(p){ return p.code; });
            var cells=header.map(function(h,c){
              var bad=codes.some(function(code){ return PROBLEM_COL[code]&&PROBLEM_COL[code].test(h); });
              var val=(nvCsvRows[o.i+1]&&nvCsvRows[o.i+1][c])||"";
              return '<div><label>'+nvEsc(h)+'</label><input class="nv-bulkfix'+(bad?" bad":"")+'" data-nv-fix-row="'+o.i+'" data-nv-fix-col="'+c+'" value="'+nvEsc(val)+'"></div>';
            }).join("");
            return '<div style="border:1px solid var(--nvu-good-bg);border-radius:var(--r-lg);padding:10px;margin-top:8px">'
              +'<div class="ops-card-head"><strong>Row '+nvEsc(o.r.line)+'</strong><span class="chip bad">'+(o.r.problems||[]).length+" issue(s)</span></div>"
              +(o.r.problems||[]).map(function(p){ return '<p class="footer-note">'+nvEsc(p.message)+" <em>Fix: "+nvEsc(p.fix)+"</em></p>"; }).join("")
              +'<div class="nv-bulkgrid">'+cells+"</div></div>";
          }).join("")
          +"</div>";
      }
      var __nvOrigRenderBulkValidation=renderBulkValidation;
      renderBulkValidation=function(parsed){
        __nvOrigRenderBulkValidation(parsed);
        try{
          if(!parsed||(parsed.missingColumns&&parsed.missingColumns.length)) return;
          var el=document.getElementById("bulkValidationList");
          if(!el) return;
          var grid=nvBulkFixGrid(parsed);
          if(grid) el.insertAdjacentHTML("beforeend",grid);
        }catch(e){ console.error("NovaX bulk fix grid failed",e); }
      };
      window.renderBulkValidation=renderBulkValidation;
      var nvFixTimer=null;
      document.addEventListener("input",function(e){
        var t=e.target;
        if(!t||!t.getAttribute||t.getAttribute("data-nv-fix-row")===null) return;
        var ri=Number(t.getAttribute("data-nv-fix-row")), ci=Number(t.getAttribute("data-nv-fix-col"));
        if(!nvCsvRows||!nvCsvRows[ri+1]) return;
        nvCsvRows[ri+1][ci]=t.value.trim();
        clearTimeout(nvFixTimer);
        nvFixTimer=setTimeout(function(){
          try{
            var parsed=validateBulkRows(nvCsvRows.map(function(r){ return r.slice(); }));
            state.lastBulkValidation=parsed;
            renderBulkValidation(parsed);
            var again=document.querySelector('[data-nv-fix-row="'+ri+'"][data-nv-fix-col="'+ci+'"]');
            if(again){ again.focus(); try{ again.setSelectionRange(again.value.length,again.value.length); }catch(e2){} }
          }catch(err){ console.error("NovaX re-validate failed",err); }
        },450);
      });

      /* ---------- Task 19: notification centre ----------
         Parcel events only. Wallet, payout, fee and invoice events
         are deliberately excluded. */
      var NOTIF_READ_KEY="novaxClientNotifReadV1";
      var notifOpen=false;
      function nvReadSet(){
        try{ return JSON.parse(localStorage.getItem(NOTIF_READ_KEY)||"[]"); }catch(e){ return []; }
      }
      function nvMarkAllRead(){
        try{ localStorage.setItem(NOTIF_READ_KEY,JSON.stringify(nvNotifEvents().map(function(n){ return n.id; }).slice(0,200))); }catch(e){}
      }
      function nvNotifEvents(){
        var out=[];
        nvMyParcels().forEach(function(p){
          var st=String(p.status||"");
          if(st==="Delivered") out.push({ id:p.awb+"|delivered", awb:p.awb, title:p.awb+" delivered", sub:[p.consignee,p.city].filter(Boolean).join(" \u00b7 ") });
          else if(NEEDS_ME.indexOf(st)>=0) out.push({ id:p.awb+"|"+st, awb:p.awb, title:p.awb+" \u2013 "+st, sub:(p.exception||[p.consignee,p.city].filter(Boolean).join(" \u00b7 ")) });
          else if(st==="Collected by rider") out.push({ id:p.awb+"|pickup", awb:p.awb, title:p.awb+" picked up", sub:"Rider collected this parcel" });
        });
        return out.slice(0,60);
      }
      function nvNotifWire(){
        var input=document.getElementById("clientSearch");
        var host=input?input.parentNode:null;
        if(!host||document.getElementById("nvBell")) return;
        nvCockpitCss();
        var bell=document.createElement("button");
        bell.type="button"; bell.id="nvBell"; bell.className="nv-bell"; bell.title="Notifications";
        bell.setAttribute("aria-label","Notifications");
        bell.innerHTML='\uD83D\uDD14<span class="nv-bell-badge" id="nvBellBadge" style="display:none">0</span>';
        host.appendChild(bell);
        var panel=document.createElement("div"); panel.className="nv-notif"; panel.id="nvNotifPanel";
        document.body.appendChild(panel);
        bell.addEventListener("click",function(e){
          e.stopPropagation();
          notifOpen=!notifOpen;
          if(notifOpen){
            var r=bell.getBoundingClientRect();
            panel.style.top=(r.bottom+8)+"px";
            panel.style.left=Math.max(8,Math.min(r.right-330,window.innerWidth-338))+"px";
            nvNotifRender(true); panel.classList.add("open");
            nvMarkAllRead(); setTimeout(nvNotifRender,50);
          } else panel.classList.remove("open");
        });
        document.addEventListener("click",function(e){
          if(notifOpen && !panel.contains(e.target) && e.target!==bell){ notifOpen=false; panel.classList.remove("open"); }
        });
        panel.addEventListener("click",function(e){
          var it=e.target.closest?e.target.closest("[data-nv-notif-awb]"):null;
          if(!it) return;
          var awb=it.getAttribute("data-nv-notif-awb");
          notifOpen=false; panel.classList.remove("open");
          if(awb) nvSafeCall(function(){ openClientParcelJourney(awb); });
          else nvTab("support");
        });
      }
      function nvNotifRender(force){
        var badge=document.getElementById("nvBellBadge"), panel=document.getElementById("nvNotifPanel");
        if(!badge||!panel) return;
        var events=nvNotifEvents(), read=nvReadSet();
        var unread=events.filter(function(n){ return read.indexOf(n.id)<0; });
        badge.textContent=unread.length>9?"9+":String(unread.length);
        badge.style.display=unread.length?"flex":"none";
        if(!notifOpen && !force) return;
        panel.innerHTML=events.length?events.map(function(n){
          return '<div class="nv-notif-i'+(read.indexOf(n.id)<0?" unread":"")+'" data-nv-notif-awb="'+nvEsc(n.awb||"")+'">'+nvEsc(n.title)+"<span>"+nvEsc(n.sub||"")+"</span></div>";
        }).join(""):'<div class="nv-notif-i">No notifications yet. Delivery, exception, pickup and support-reply updates appear here.</div>';
      }

      /* Clear notification read-state on logout (no financial data is stored). */
      try{
        if(typeof logout==="function"){
          var __nvOrigLogout=logout;
          logout=function(){ try{ localStorage.removeItem(NOTIF_READ_KEY); }catch(e){} return __nvOrigLogout.apply(this,arguments); };
          window.logout=logout;
        }
      }catch(e){}

      /* ---------- boot ---------- */
      function nvP3Tick(){
        nvSafeCall(nvWireOmni);
        nvSafeCall(nvNotifWire);
        nvSafeCall(nvGroupRareTabs);
        nvSafeCall(nvWireAddress);
        nvSafeCall(nvRenderCockpit);
        nvSafeCall(nvDecorateParcelRows);
        nvSafeCall(function(){ nvNotifRender(false); });
        nvSafeCall(nvBarSync);
      }
      /* Run the first tick immediately, not on a 300ms timer.

          nvRenderCockpit inserts #nvCockpit -- measured at 1,205px with 220
          parcels -- above the command strip and the metric row. On a 300ms
          delay that insertion landed after the dashboard had already painted,
          so everything below it was shoved down by 1,233px and the merchant
          watched the page jump a screen and a half. Filmed frame by frame:
          nvCommandStrip 663px -> 1,896px between t=347 and t=380.

          state is hydrated synchronously from localStorage by loadState(), so
          on every visit after the first the buckets are already populated here
          and the cockpit is in place before the first paint instead of after
          it. The 300ms call is kept as a second pass for anything that mounts
          late, and both are idempotent -- nvP3Tick's own guards make repeat
          calls no-ops. A first-ever load still fills the cockpit when its data
          arrives; there is nothing to render before that. */
      function nvP3Boot(){ nvP3Tick(); setTimeout(nvP3Tick,300); }
      if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",nvP3Boot);
      else nvP3Boot();
      nvInterval(nvP3Tick,2500);
      window.__novaxPhase3={ cockpit:nvRenderCockpit, notif:nvNotifRender, search:nvOmniSearch, selected:nvSelList };
    })();
  
/* ==== client.html inline block #7 ==== */

(function(){
  var __sb=window.__nvSb||window.__nvGuardSb||null;
  window.__nvGuardSb=__sb;
  function ses(){ try{ return JSON.parse(localStorage.getItem("novaxSession")||"null"); }catch(e){ return null; } }
  function logout(e){ if(e&&e.preventDefault) e.preventDefault(); try{ localStorage.removeItem("novaxSession"); }catch(_){ } /* NovaX fix (PII): drop the cached portal state (customer names, cities, COD) on sign-out too. */ try{ localStorage.removeItem("novaxLogisticsStateV10"); }catch(_3){ } try{ if(__sb&&__sb.auth) __sb.auth.signOut(); }catch(_2){ } window.location.href="index.html"; }
  window.nvLogout=logout;
  /* ===== NovaX fix (idle session timeout) =====
     One named duration constant, a non-blocking warning banner two minutes
     before the cut-off with a "Stay signed in" action, and the existing
     logout() at the limit. No modal, nothing that can trap the user. */
  var NOVAX_IDLE_LIMIT_MS = 30*60*1000;
  var NOVAX_IDLE_WARN_MS  = NOVAX_IDLE_LIMIT_MS - (2*60*1000);
  var __nvIdleWarnTimer=null, __nvIdleOutTimer=null, __nvLastActivity=Date.now();
  function nvIdleClearWarning(){ var el=document.getElementById("nvIdleWarning"); if(el){ try{ el.remove(); }catch(_){ el.style.display="none"; } } }
  function nvIdleShowWarning(){
    if(!document.body || document.getElementById("nvIdleWarning")) return;
    var bar=document.createElement("div");
    bar.id="nvIdleWarning";
    bar.setAttribute("role","status");
    bar.style.cssText="position:fixed;left:50%;transform:translateX(-50%);bottom:calc(18px + env(safe-area-inset-bottom));z-index:99999;display:flex;align-items:center;gap:12px;background:var(--nvu-ink);color:#fff;border-radius:var(--r-xl);padding:10px 14px;font:600 13px/1.35 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;box-shadow:var(--glow-1);max-width:calc(100vw - 24px)";
    var msg=document.createElement("span");
    msg.textContent="You have been idle for a while - signing out in 2 minutes.";
    var stay=document.createElement("button");
    stay.type="button"; stay.textContent="Stay signed in";
    stay.style.cssText="background:#14c77b;color:#06231a;border:0;border-radius:var(--r-lg);padding:7px 12px;font-weight:800;cursor:pointer;flex-shrink:0";
    stay.addEventListener("click",function(){ nvIdleReset(); });
    var x=document.createElement("button");
    x.type="button"; x.setAttribute("aria-label","Dismiss"); x.textContent="\u00d7";
    x.style.cssText="background:transparent;color:#cfe4da;border:0;font-size:18px;line-height:1;cursor:pointer;flex-shrink:0";
    /* BUG: the x only removed the banner. Both timers kept running, so the
       merchant was signed out two minutes later with no second warning,
       losing anything typed into a ticket or the edit-parcel modal. Flicking
       a "you are idle" notice away IS activity -- it proves someone is at the
       keyboard -- so it resets the clock like every other interaction. */
    x.addEventListener("click",function(){ nvIdleReset(); });
    bar.appendChild(msg); bar.appendChild(stay); bar.appendChild(x);
    document.body.appendChild(bar);
  }
  function nvIdleReset(){
    nvIdleClearWarning();
    if(__nvIdleWarnTimer) clearTimeout(__nvIdleWarnTimer);
    if(__nvIdleOutTimer) clearTimeout(__nvIdleOutTimer);
    __nvIdleWarnTimer=setTimeout(nvIdleShowWarning, NOVAX_IDLE_WARN_MS);
    __nvIdleOutTimer=setTimeout(function(){ nvIdleClearWarning(); try{ logout(); }catch(e){ window.location.href="index.html"; } }, NOVAX_IDLE_LIMIT_MS);
  }
  function nvIdleActivity(){
    var t=Date.now();
    // Throttled so a mousemove burst does not thrash the timers, but any
    // activity while the warning is on screen cancels it immediately.
    if((t-__nvLastActivity)<5000 && !document.getElementById("nvIdleWarning")) return;
    __nvLastActivity=t;
    nvIdleReset();
  }
  ["mousemove","keydown","click","touchstart","scroll"].forEach(function(evt){
    window.addEventListener(evt, nvIdleActivity, { passive:true, capture:true });
  });
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", nvIdleReset); else nvIdleReset();
  // NovaX fix (auth separation): the actual role decision for this page now
  // happens once, as early as possible, in the full-page auth gate injected
  // right after <body> (window.__novaxAuthGateReady / window.__novaxVerifiedProfile).
  // That gate already redirects admin/rider/unknown roles away and keeps the
  // dashboard hidden behind "Checking account..." until a real Supabase
  // session + profiles.role === "client" are both confirmed, so this block no
  // longer re-queries Supabase or repeats that decision -- it only reacts to
  // the verified result, and it never trusts localStorage novaxSession (UI
  // cache only) to decide whether to show the portal.
  function apply(){
    if(!window.__novaxVerifiedProfile||window.__novaxVerifiedProfile.role!=="client") return;
    /* The demo portal's own CTAs are deliberately signup links shown to a
       visitor who is NOT a merchant, so they are exempt -- without this the
       one button the demo exists to surface is hidden by the logged-in
       chrome cleanup. */
    var kill=document.querySelectorAll(
      ".auth-btn:not(.nvd-cta):not(.nvd-go), a[href*='#signin']:not(.nvd-cta):not(.nvd-go), a[href*='#signup']:not(.nvd-cta):not(.nvd-go)");
    Array.prototype.forEach.call(kill,function(el){ el.style.display="none"; });
    var actions=document.querySelector(".auth-actions");
    var reused=null;
    if(actions){
      var links=actions.querySelectorAll("a");
      for(var i=0;i<links.length;i++){ var t=(links[i].textContent||"").toLowerCase(); if(t.indexOf("sign out")>-1||t.indexOf("log out")>-1||t.indexOf("signout")>-1){ reused=links[i]; break; } }
      if(reused){ reused.textContent="Log out"; reused.style.display=""; reused.style.cursor="pointer"; reused.removeAttribute("href"); reused.addEventListener("click",logout); }
    }
    if(!reused){
      var nav=document.querySelector(".nav-tabs")||actions;
      if(nav && !document.getElementById("nvLogoutBtn")){
        var lo=document.createElement("a");
        lo.id="nvLogoutBtn";
        lo.className=(nav.className&&nav.className.indexOf("nav-tabs")>-1)?"tab-btn":"ghost-btn";
        lo.textContent="Log out"; lo.style.cursor="pointer";
        lo.addEventListener("click",logout);
        nav.appendChild(lo);
      }
    }
  }
  (window.__novaxAuthGateReady||Promise.resolve()).then(function(){
    if(document.readyState!=="loading") apply(); else document.addEventListener("DOMContentLoaded",apply);
  });
})();

/* ==== client.html inline block #8 ==== */

  (function(){
    var __SB_URL=window.NOVAX_CONFIG.SB_URL;
    var __SB_KEY=window.NOVAX_CONFIG.SB_KEY;
    var __PORTAL="Client Portal";
    function uid(){ try{ return crypto.randomUUID(); }catch(e){ return "v-"+Date.now()+"-"+Math.random().toString(16).slice(2); } }
    function sid(){ try{ var k="novaxVisitorId"; var v=sessionStorage.getItem(k); if(!v){ v=uid(); sessionStorage.setItem(k,v); } return v; }catch(e){ return uid(); } }
    var SESSION_ID=sid();
    var __vsb=null;
    try{ if(window.supabase&&window.supabase.createClient) __vsb=window.supabase.createClient(__SB_URL,__SB_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,storageKey:"sb-nv-visitor-ping"}}); }catch(e){}
    function humanizeTab(id){ if(!id) return "Dashboard"; return String(id).replace(/([a-z])([A-Z])/g,"$1 $2").replace(/[-_]/g," ").replace(/^./,function(c){ return c.toUpperCase(); }); }
    function activityLabel(){
      try{ if(window.state&&window.state.activeClientTab) return "Viewing "+humanizeTab(window.state.activeClientTab)+" tab"; }catch(e){}
      return "Browsing client portal";
    }
    function ping(){
      if(!__vsb) return;
      __vsb.rpc("visitor_ping", { p_session_id:SESSION_ID, p_portal:__PORTAL, p_activity:activityLabel(), p_path:location.pathname+location.hash, p_referrer:document.referrer||"", p_user_agent:navigator.userAgent }).then(function(r){ if(r&&r.error) console.warn("NovaX visitor ping",r.error.message); });
    }
    /* NovaX (database load): presence pings were a 20s timer PLUS a ping on
       every single click. Across 122 merchants that is ~224,000 row writes a
       day purely to record "someone is online" — a meaningful share of the
       load that took the database down. Now: 60s timer, and clicks are
       throttled to at most one ping every 45s. Same presence signal, roughly
       a third of the writes. */
    var __lastPing = 0;
    function pingThrottled(minGapMs){
      var now = Date.now();
      if (now - __lastPing < (minGapMs || 45000)) return;
      __lastPing = now;
      ping();
    }
    document.addEventListener("visibilitychange",function(){ if(document.visibilityState==="visible") pingThrottled(15000); });
    document.addEventListener("click",function(){ setTimeout(function(){ pingThrottled(45000); },150); });
    nvInterval(function(){ if(document.visibilityState==="visible") pingThrottled(55000); },60000);
    __lastPing = Date.now(); ping();
  })();
  
/* ==== client.html inline block #9 ==== */

(function(){
  if(window.__novaxAutopilotLoaded) return; window.__novaxAutopilotLoaded=true;
  var PORTAL="client";
  var SB_URL=window.NOVAX_CONFIG.SB_URL;
  var SB_KEY=window.NOVAX_CONFIG.SB_KEY;
  /* Both of these used to point at novax-ai -- the paid Opus console -- so
     the free deterministic engine and the free provider cascade were dead
     code while every Autopilot message ran an Opus agentic loop (up to 6
     model calls a turn) and silently consumed the merchant's 50-message
     premium quota. The contracts already matched: novax-ai-support reads
     {message, awb, portal} and returns {reply, intent, needAwb}, which is
     exactly what send() reads; novax-autopilot-brain reads {message, history}
     and returns {reply, unavailable}, which is exactly what tryBrain() reads.
     Only the URLs were wrong.

     FN_URL_FALLBACK keeps this safe to ship: if the free engine is not
     deployed on a given project, the call 404s and we retry against novax-ai,
     which is precisely today's behaviour. So the worst case is what already
     happens, and the normal case is free. */
  /* TWO LAYERS, and only the second one costs anything.

     novax-ai-support was deployed on 27 Aug and this is now true. It is
     DETERMINISTIC -- intent detection straight off the database, no LLM call
     anywhere in it -- so every question it can answer is answered for free
     and instantly, and cannot be fabricated. That is where the saving comes
     from, not from a cheaper model.

     The open-ended layer stays on Opus deliberately. novax-autopilot-brain
     was written against the free Groq/Cerebras/Gemini cascade and that did
     not work in practice, so BRAIN_URL is pinned to novax-ai (claude-opus-5)
     rather than following the switch below. Porting the brain to the
     Anthropic API is a real rewrite -- it speaks OpenAI tool/message format
     end to end -- and there is no reason to carry that risk when novax-ai
     already implements the same tool surface on Opus and is what has been
     serving this traffic all along.

     Net effect: the common questions stop reaching an LLM at all, and what
     is left goes to Opus, which is where it was already going. */
  var NV_FREE_AI_DEPLOYED = true;

  var FN_URL = SB_URL.replace(/\/$/,"") + (NV_FREE_AI_DEPLOYED
      ? "/functions/v1/novax-ai-support"
      : "/functions/v1/novax-ai");
  var FN_URL_FALLBACK=SB_URL.replace(/\/$/,"")+"/functions/v1/novax-ai";
  /* Open-ended LLM layer, Opus. Only called when the deterministic engine
     above has no answer. tryBrain() treats any non-ok response, missing
     reply, or {unavailable:true} as "no answer" and simply moves on, so this
     can only ever add an answer -- never remove one. */
  var BRAIN_URL = SB_URL.replace(/\/$/,"") + "/functions/v1/novax-ai";

  var style=document.createElement("style");
  style.textContent='.nvauto-btn{position:fixed;right:22px;left:auto;bottom:calc(22px + env(safe-area-inset-bottom));z-index:var(--z-fab);display:flex;align-items:center;gap:11px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-2xl);padding:8px 17px 8px 8px;cursor:pointer;min-height:54px;box-sizing:border-box;box-shadow:var(--sh-1);transition:transform .22s cubic-bezier(.2,.9,.2,1),box-shadow .22s,border-color .22s}.nvauto-btn:hover{transform:translateY(-2px);border-color:var(--green-2);box-shadow:var(--sh-2)}.nvauto-btn:active{transform:translateY(0) scale(.985)}.nvauto-btn-icon{position:relative;width:38px;height:38px;border-radius:var(--r-xl);flex-shrink:0;display:grid;place-items:center;color:#fff;background:linear-gradient(140deg,var(--green),var(--green-2));box-shadow:0 5px 16px rgba(19,163,111,.42),inset 0 1px 0 rgba(255,255,255,.22)}.nvauto-btn-icon svg{display:block;position:relative;z-index:1}.nvauto-btn-icon::after{content:"";position:absolute;inset:-3px;border-radius:var(--r-2xl);background:linear-gradient(140deg,var(--green),var(--green-2));opacity:.26;filter:blur(7px);z-index:0}.nvauto-btn-text{display:flex;flex-direction:column;line-height:1.2;text-align:left}.nvauto-btn-text b{font-size:13.5px;font-weight:750;color:var(--ink);letter-spacing:-.01em}.nvauto-btn-text small{font-size:10.5px;color:var(--muted);font-weight:600}.nvauto-badge{position:absolute;top:-6px;right:-6px;min-width:19px;height:19px;padding:0 5px;border-radius:var(--r-lg);background:#d4574e;color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:var(--sh-1)}.nvauto-btn.nv-pulse .nvauto-btn-icon::after{animation:nvGlow 2.4s ease-in-out infinite}@keyframes nvGlow{0%,100%{opacity:.26;transform:scale(1)}50%{opacity:.55;transform:scale(1.12)}}.nvauto-panel{position:fixed;right:22px;left:auto;bottom:92px;top:auto;z-index:99998;width:392px;max-width:calc(100vw - 36px);height:auto;max-height:min(640px,calc(100vh - 130px));background:var(--panel);border:1px solid var(--line);border-radius:20px;box-shadow:var(--sh-2);display:none;flex-direction:column;overflow:hidden;transform-origin:100% 100%}.nvauto-panel.open{display:flex;animation:nvPanelIn .34s cubic-bezier(.2,.9,.2,1)}@keyframes nvPanelIn{from{opacity:0;transform:translateY(14px) scale(.94)}to{opacity:1;transform:none}}.nvauto-panel::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;z-index:2;background:linear-gradient(90deg,transparent,var(--green-2),transparent)}.nvauto-head{background:var(--panel);color:var(--ink);padding:15px 16px;display:flex;align-items:center;gap:11px;flex-shrink:0;border-bottom:1px solid var(--line)}.nvauto-avatar{width:36px;height:36px;border-radius:var(--r-xl);flex-shrink:0;display:grid;place-items:center;color:#fff;background:linear-gradient(140deg,var(--green),var(--green-2));box-shadow:var(--glow-1)}.nvauto-head b{font-size:15px;line-height:1.15;display:block;color:var(--ink);letter-spacing:-.01em;font-weight:750}.nvauto-head small{font-size:11px;color:var(--muted);display:flex;align-items:center;margin-top:2px}.nvauto-live-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green-2);margin-right:6px;box-shadow:var(--ring);animation:nvLiveDot 2s ease-in-out infinite}@keyframes nvLiveDot{0%,100%{opacity:1;box-shadow:var(--ring)}50%{opacity:.5;box-shadow:var(--ring)}}.nvauto-x{margin-left:auto;background:transparent;color:var(--muted);border:1px solid var(--line);width:32px;height:32px;border-radius:var(--r-lg);cursor:pointer;font-size:15px;flex-shrink:0;display:grid;place-items:center;transition:background .18s,color .18s}.nvauto-x:hover{background:var(--panel-soft);color:var(--ink)}.nvauto-chips{display:flex;gap:7px;flex-wrap:wrap;padding:13px 15px 3px;background:var(--panel);flex-shrink:0}.nvauto-chips button{display:inline-flex;align-items:center;height:36px;box-sizing:border-box;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit;font-size:12px;font-weight:650;padding:0 14px;border-radius:var(--r-pill);cursor:pointer;transition:background .2s,border-color .2s,transform .2s,box-shadow .2s;animation:nvChipIn .18s cubic-bezier(.2,.7,.3,1) both}@keyframes nvChipIn{from{opacity:0;transform:translateY(6px) scale(.96)}to{opacity:1;transform:none}}.nvauto-chips button:hover{background:var(--mint);border-color:var(--green-2);transform:translateY(-1px);box-shadow:var(--glow-1)}.nvauto-chips button:active{transform:scale(.97)}.nvauto-chips button .cl-short{display:none}.nvauto-msgs{flex:1;overflow-y:auto;padding:15px;display:flex;flex-direction:column;gap:16px;background:var(--panel);min-height:0;scroll-behavior:smooth}.nvauto-m{max-width:100%;font-size:14px;line-height:1.6;white-space:pre-line;color:var(--ink);animation:nvMsgIn .3s cubic-bezier(.2,.9,.2,1) both}@keyframes nvMsgIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}.nvauto-m.u{align-self:flex-end;max-width:80%;background:var(--panel-soft);border:1px solid var(--line);color:var(--ink);padding:9px 14px;border-radius:var(--r-2xl) 15px 4px 15px;font-size:13.5px}.nvauto-m.b{align-self:stretch;position:relative;padding-left:15px}.nvauto-m.b::before{content:"";position:absolute;left:0;top:3px;bottom:3px;width:2px;border-radius:var(--r-xs);background:linear-gradient(180deg,var(--green-2),transparent)}.nvauto-m.nvauto-loading{opacity:.6}.nvauto-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:11px}.nvauto-action-btn{display:inline-flex;align-items:center;height:38px;box-sizing:border-box;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit;font-size:12px;font-weight:700;padding:0 15px;border-radius:var(--r-pill);cursor:pointer;transition:background .2s,border-color .2s,transform .2s,box-shadow .2s;animation:nvChipIn .18s cubic-bezier(.2,.7,.3,1) both}.nvauto-action-btn:hover{background:var(--mint);border-color:var(--green-2);transform:translateY(-1px);box-shadow:var(--glow-1)}.nvauto-action-btn:active{transform:scale(.97)}.nvauto-action-btn.nv-confirm{background:linear-gradient(135deg,var(--green),var(--green-2));color:#fff;border-color:transparent;box-shadow:var(--glow-1)}.nvauto-action-btn.nv-confirm:hover{filter:brightness(1.07)}.nvauto-action-btn.nv-cancel{background:transparent;color:#d4574e;border-color:rgba(212,87,78,.4)}.nvauto-action-btn.nv-cancel:hover{background:rgba(212,87,78,.08)}.nvauto-fb{display:flex;align-items:center;gap:7px;margin-top:9px;font-size:10.5px;color:var(--muted);opacity:.8}.nvauto-fb-btn{border:0;background:transparent;color:var(--muted);font:inherit;font-size:10.5px;font-weight:700;cursor:pointer;padding:2px 4px;transition:color .18s}.nvauto-fb-btn:hover{color:var(--ink)}.nvauto-fb-btn.active{color:var(--green-2)}.nvauto-fb-sep{opacity:.45}.nvauto-bar{display:flex;gap:8px;padding:12px 15px;padding-bottom:calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--panel);flex-shrink:0}.nvauto-bar input{flex:1;min-width:0;height:44px;border-radius:14px;border:1px solid var(--line);background:var(--panel-soft);padding:0 15px;font:inherit;font-size:16px;color:var(--ink);outline:none;transition:border-color .18s,box-shadow .18s}.nvauto-bar input:focus{border-color:var(--green-2);box-shadow:var(--ring)}.nvauto-bar input::placeholder{font-size:13px;color:var(--muted)}.nvauto-bar button{height:44px;padding:0 18px;border-radius:14px;font:inherit;font-weight:750;font-size:13.5px;background:linear-gradient(135deg,var(--green),var(--green-2));color:#fff;border:0;cursor:pointer;flex-shrink:0;box-shadow:var(--glow-1);transition:transform .18s,filter .18s}.nvauto-bar button:hover{transform:translateY(-1px);filter:brightness(1.07)}.nvauto-bar button:active{transform:none}.nvauto-nudge{position:fixed;z-index:var(--z-nudge);max-width:274px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-2xl);border-bottom-right-radius:5px;padding:12px 15px;font-size:12.5px;line-height:1.5;font-weight:600;box-shadow:var(--sh-2);cursor:pointer;opacity:0;transform:translateY(8px) scale(.96);pointer-events:none;transition:opacity .3s cubic-bezier(.2,.9,.2,1),transform .3s cubic-bezier(.2,.9,.2,1),border-color .18s}.nvauto-nudge.show{opacity:1;transform:none;pointer-events:auto}.nvauto-nudge:hover{border-color:var(--green-2)}.nvauto-btn{user-select:none;-webkit-user-select:none;transition:transform .26s cubic-bezier(.2,.9,.2,1),opacity .2s,box-shadow .22s,border-color .22s}@media (prefers-reduced-motion:reduce){.nvauto-btn{transition:opacity .2s}}.nvauto-btn:active{cursor:grabbing}@media (prefers-reduced-motion:reduce){.nvauto-btn,.nvauto-btn-icon::after,.nvauto-panel.open,.nvauto-live-dot,.nvauto-m,.nvauto-nudge{animation:none!important;transition:none!important}.nvauto-msgs{scroll-behavior:auto}}@media (max-width:760px){.nvauto-btn{right:14px;bottom:calc(var(--nv-stack-2) + 10px);padding:0;width:56px;height:56px;border-radius:18px;justify-content:center;gap:0}.nvauto-btn.nv-above-stickybar{bottom:calc(var(--nv-stack-2) + 10px)!important}.nvauto-btn-text{display:none}.nvauto-btn-icon{width:100%;height:100%;border-radius:18px}.nvauto-panel{left:0;right:0;bottom:0;top:auto;width:100%;max-width:100%;height:80vh;max-height:80vh;border-radius:20px 20px 0 0;border-left:0;border-right:0;border-bottom:0}.nvauto-chips{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding-bottom:4px}.nvauto-chips::-webkit-scrollbar{display:none}.nvauto-chips button{flex:0 0 auto;max-width:70vw}.nvauto-action-btn{height:42px}.nvauto-chips button .cl-full{display:none}.nvauto-chips button .cl-short{display:inline}.nvauto-action-btn{min-height:42px;padding:10px 14px}.nvauto-msgs{padding:13px;gap:14px}}.nvauto-btn.nv-console-open,.nvauto-nudge.nv-console-open{opacity:0;pointer-events:none;transform:translateY(10px) scale(.9);transition:opacity .25s,transform .25s}';
  document.head.appendChild(style);

  var btn=document.createElement("button");
  btn.className="nvauto-btn"; btn.setAttribute("aria-label","Open NovaX Autopilot assistant");
  btn.innerHTML='<span class="nvauto-btn-icon" aria-hidden="true"><svg viewBox="0 0 32 32" width="20" height="20" fill="none"><circle cx="16" cy="16" r="13" stroke="rgba(255,255,255,.55)" stroke-width="1.6"/><path d="M16 6.5 L20.6 20.4 L16 17.6 L11.4 20.4 Z" fill="#fff"/><circle cx="16" cy="16" r="1.7" fill="var(--nvu-accent)"/></svg></span><span class="nvauto-btn-text"><b>Autopilot</b><small>Ask anything</small></span>';

  /* The Autopilot button is fixed bottom-right, so on a phone it permanently
     sits on top of whatever has scrolled under it -- on the dashboard, the
     corner of the "What's moving" card. Reserving space below the lists only
     helped at rest; mid-scroll it still covered content.

     So it steps aside instead: it slides out while you are scrolling DOWN
     (reading), and comes straight back the moment you stop or scroll up
     (navigating). Purely a transform on the button -- it never touches the
     open/close state, and it never hides while the panel is open or while the
     merchant has not yet scrolled. */
  (function nvFabAutoHide(){
    var lastY = 0, hidden = false, idle = null;
    var show = function(){
      if(!hidden) return; hidden = false;
      btn.style.transform = ""; btn.style.opacity = "";
      btn.style.pointerEvents = "";
    };
    var hide = function(){
      if(hidden) return;
      if(document.querySelector(".nvauto-panel.open")) return;   // never while open
      hidden = true;
      btn.style.transform = "translateY(130%)";
      btn.style.opacity = "0";
      btn.style.pointerEvents = "none";                          // cannot be tapped while gone
    };
    addEventListener("scroll", function(){
      var y = window.scrollY || 0;
      if(y > lastY + 6 && y > 220) hide();
      else if(y < lastY - 6) show();
      lastY = y;
      clearTimeout(idle);
      idle = setTimeout(show, 900);   // back as soon as reading stops
    }, {passive:true});
    /* If anything opens the panel while the button is tucked away, bring it
       back so the two can never disagree about where it is. */
    addEventListener("click", function(){ setTimeout(function(){
      if(document.querySelector(".nvauto-panel.open")) show();
    }, 60); }, true);
  })();

  var panel=document.createElement("div");
  panel.className="nvauto-panel";
  panel.innerHTML=''
    +'<div class="nvauto-head"><div class="nvauto-avatar"><svg viewBox="0 0 32 32" width="19" height="19" fill="none"><circle cx="16" cy="16" r="13" stroke="rgba(255,255,255,.6)" stroke-width="1.6"/><path d="M16 6.5 L20.6 20.4 L16 17.6 L11.4 20.4 Z" fill="#fff"/></svg></div><div><b>NovaX Autopilot</b><small><span class="nvauto-live-dot" aria-hidden="true"></span>Live account-aware assistant</small></div><button class="nvauto-x" aria-label="Close">&times;</button></div>'
    +'<div class="nvauto-chips">'
      +'<button data-q="mera parcel kahan hai?"><span class="cl-full">Track Parcel</span><span class="cl-short">Track</span></button>'
      +'<button data-local="go_booking"><span class="cl-full">Book Order</span><span class="cl-short">Book</span></button>'
      +'<button data-q="COD kab milega?"><span class="cl-full">COD / Wallet</span><span class="cl-short">COD</span></button>'
      +'<button data-local="nv_review_issues"><span class="cl-full">Issue Help</span><span class="cl-short">Issue</span></button>'
      +'<button data-q="support se baat karni hai"><span class="cl-full">Human</span><span class="cl-short">Human</span></button>'
    +'</div>'
    +'<div class="nvauto-msgs" id="nvautoMsgs"></div>'
    +'<div class="nvauto-bar"><input id="nvautoInput" placeholder="Ask about parcels, COD, wallet..." /><button id="nvautoSend">Send</button></div>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  function refreshLauncherBadge(){
    try{
      var ctx=(typeof getClientContext==="function")?getClientContext():null;
      var hasIssue=!!(ctx && ctx.issueCount>0);
      var isOpen=panel.classList.contains("open");
      btn.classList.toggle("nv-pulse", hasIssue && !isOpen);
      var badgeEl=btn.querySelector(".nvauto-badge");
      if(hasIssue && !isOpen){
        if(!badgeEl){ badgeEl=document.createElement("span"); badgeEl.className="nvauto-badge"; btn.appendChild(badgeEl); }
        badgeEl.textContent=ctx.issueCount>9?"9+":String(ctx.issueCount);
      } else if(badgeEl){ badgeEl.remove(); }
    }catch(e){}
  }
  nvInterval(refreshLauncherBadge,5000);
  setTimeout(refreshLauncherBadge,1500);

  (function attachStickyBarWatch(){
    var tries=0;
    var iv=nvInterval(function(){
      tries++;
      var stickyBar=document.getElementById("nvMobileBookBar");
      if(stickyBar){
        clearInterval(iv);
        function syncElevate(){ btn.classList.toggle("nv-above-stickybar", stickyBar.classList.contains("show")); }
        new MutationObserver(syncElevate).observe(stickyBar,{attributes:true,attributeFilter:["class"]});
        syncElevate();
      } else if(tries>40){ clearInterval(iv); }
    },250);
  })();

  function sendFeedback(value){
    try{
      getAuthToken().then(function(token){
        fetch(FN_URL,{
          method:"POST",
          headers:{ "Content-Type":"application/json", "apikey":SB_KEY, "Authorization":"Bearer "+(token||SB_KEY) },
          body:JSON.stringify({ feedback:value, portal:PORTAL })
        }).catch(function(){});
      }).catch(function(){});
    }catch(e){}
  }

  function addMsg(text,who,actions){
    var m=document.createElement("div");
    m.className="nvauto-m "+(who==="u"?"u":"b");
    m.textContent=text;
    var box=document.getElementById("nvautoMsgs");
    box.appendChild(m);
    if(who!=="u" && Array.isArray(actions) && actions.length){
      var row=document.createElement("div");
      row.className="nvauto-actions";
      actions.forEach(function(a){
        if(!a || !a.label) return;
        var b=document.createElement("button");
        b.type="button"; b.className="nvauto-action-btn"+(a.type==="confirm_action"?" nv-confirm":a.type==="cancel_confirm"?" nv-cancel":""); b.textContent=a.label;
        b.addEventListener("click",function(){ handleAction(a); });
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    if(who!=="u" && text){
      // Only the latest Autopilot reply shows feedback controls — remove any
      // earlier feedback row so the thread doesn't get noisy.
      box.querySelectorAll(".nvauto-fb").forEach(function(old){ old.remove(); });
      var fb=document.createElement("div");
      fb.className="nvauto-fb";
      var helpfulBtn=document.createElement("button"); helpfulBtn.type="button"; helpfulBtn.className="nvauto-fb-btn"; helpfulBtn.textContent="Helpful";
      var sep1=document.createElement("span"); sep1.className="nvauto-fb-sep"; sep1.textContent="\u00B7";
      var notBtn=document.createElement("button"); notBtn.type="button"; notBtn.className="nvauto-fb-btn"; notBtn.textContent="Not helpful";
      var sep2=document.createElement("span"); sep2.className="nvauto-fb-sep"; sep2.textContent="\u00B7";
      var humanBtn=document.createElement("button"); humanBtn.type="button"; humanBtn.className="nvauto-fb-btn"; humanBtn.textContent="Human";
      helpfulBtn.addEventListener("click",function(){ sendFeedback("helpful"); helpfulBtn.classList.add("active"); notBtn.disabled=true; helpfulBtn.disabled=true; });
      notBtn.addEventListener("click",function(){ sendFeedback("not_helpful"); notBtn.classList.add("active"); notBtn.disabled=true; helpfulBtn.disabled=true; });
      humanBtn.addEventListener("click",function(){ sendFeedback("talk_to_human"); send("Please connect me with a human agent."); });
      fb.appendChild(helpfulBtn); fb.appendChild(sep1); fb.appendChild(notBtn); fb.appendChild(sep2); fb.appendChild(humanBtn);
      box.appendChild(fb);
    }
    box.scrollTop=box.scrollHeight;
    return m;
  }

  function handleAction(a){
    if(!a) return;
    if(a.kind==="send"){ send(a.message||""); return; }
    if(a.kind!=="local") return;
    try{
      if(a.type==="go_wallet"){ if(typeof showClientTab==="function") showClientTab("wallet"); panel.classList.add("open"); return; }
      if(a.type==="go_dashboard"){ if(typeof showClientTab==="function") showClientTab("dashboard"); panel.classList.add("open"); return; }
      if(a.type==="go_awb_label"){ if(typeof showClientTab==="function") showClientTab("awbLabel"); panel.classList.add("open"); return; }
      if(a.type==="nv_review_issues"){ panel.classList.add("open"); if(typeof nvReviewIssues==="function") nvReviewIssues(); else if(typeof showClientTab==="function") showClientTab("dashboard"); return; }
      if(a.type==="attach_proof"){ addMsg("Please reply here with your proof (photo, screenshot, or details) and our team will review it.","b"); return; }
      if(a.type==="show_journey"){
        var awb=a.awb; var p=(typeof state!=="undefined"&&state.parcels||[]).find(function(x){ return String(x.awb||"").toUpperCase()===String(awb||"").toUpperCase(); });
        if(!p){ addMsg("I don't have the journey steps for "+(awb||"that AWB")+" locally yet \u2014 open the AWB tab to see full details.","b"); return; }
        var steps=(p.steps&&p.steps.length)?p.steps.join(" \u2192 "):(p.status||"No steps recorded yet");
        addMsg("Journey for "+p.awb+": "+steps,"b");
        return;
      }
      if(a.type==="show_journey_awb"){ if(typeof openClientParcelJourney==="function") openClientParcelJourney(a.awb); return; }
      if(a.type==="open_tickets"){
        if(typeof showClientTab==="function") showClientTab("tickets");
        try{ if(typeof nvTkLoad==="function") nvTkLoad(); }catch(e){}
        return;
      }
      if(a.type==="cancel_booking_awb"){
        if(!a.awb){ addMsg("Which tracking number should I cancel?","b"); return; }
        if(typeof cancelClientBooking==="function") cancelClientBooking(a.awb);
        return;
      }
      if(a.type==="go_booking"){ if(typeof showClientTab==="function") showClientTab("newBooking"); panel.classList.add("open"); return; }
      if(a.type==="focus_manual_booking"){ if(window.novaxFocusFirstBookingField) window.novaxFocusFirstBookingField(); return; }
      if(a.type==="paste_whatsapp_order"){
        if(typeof showClientTab==="function") showClientTab("newBooking");
        setTimeout(function(){ var el=document.getElementById("nvPasteInput"); if(el) el.focus(); },150);
        return;
      }
      if(a.type==="start_tour"){
        try{ var u=new URL(location.href); u.searchParams.set("onboarding","1"); location.href=u.toString(); }
        catch(e){ location.search=(location.search?location.search+"&":"?")+"onboarding=1"; }
        return;
      }
      if(a.type==="prefill_booking"){
        var d=a.draft||{};
        if(typeof showClientTab==="function") showClientTab("newBooking");
        setTimeout(function(){
          try{
            var map={ bookingName:d.name, bookingPhone:d.phone, bookingCity:d.city, bookingCod:d.cod, bookingCategory:d.product, bookingAddress:d.address };
            var filled=[];
            Object.keys(map).forEach(function(id){
              var v=map[id];
              if(v==null||v==="") return;
              var el=document.getElementById(id);
              if(el){ el.value=v; filled.push(id.replace("booking","")); }
            });
            addMsg(filled.length?("Prefilled: "+filled.join(", ")+". Please complete the remaining booking fields and review before submitting."):"I couldn't find the booking fields to prefill \u2014 please enter the details manually.","b");
          }catch(e){ addMsg("I couldn't prefill the form automatically \u2014 please enter the details manually.","b"); }
        },200);
        return;
      }
      if(a.type==="confirm_action"){
        var pending=pendingAutopilotConfirm;
        clearPendingAutopilotConfirm();
        if(!pending){ addMsg("That confirmation has expired \u2014 please ask again.","b"); return; }
        executeConfirmedAction(pending);
        return;
      }
      if(a.type==="cancel_confirm"){
        clearPendingAutopilotConfirm();
        addMsg("Cancelled. Let me know if you need anything else.","b");
        return;
      }
      if(a.type==="copy_customer_message"){
        if(!a.awb){ addMsg("I don't have an AWB to copy a message for yet \u2014 open a parcel first.","b",[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }]); return; }
        if(typeof copyExceptionMessage==="function") copyExceptionMessage(a.awb);
        return;
      }
      if(a.type==="request_return_awb"){
        if(!a.awb){ addMsg("Which AWB should I prepare a return for?","b"); return; }
        var rc=buildReturnConfirm(a.awb);
        setPendingAutopilotConfirm(rc.confirmAction);
        addMsg(rc.reply,"b",rc.actions);
        return;
      }
      if(a.type==="request_reattempt_awb"){
        if(!a.awb){ addMsg("Which AWB needs a reattempt?","b"); return; }
        var rac=buildReattemptConfirm(a.awb);
        setPendingAutopilotConfirm(rac.confirmAction);
        addMsg(rac.reply,"b",rac.actions);
        return;
      }
      if(a.type==="open_awb"){
        if(typeof openClientParcelJourney==="function") openClientParcelJourney(a.awb);
        return;
      }
      if(a.type==="filter_delayed"){
        if(typeof showClientTab==="function") showClientTab("dashboard");
        setTimeout(function(){
          try{
            var el=document.getElementById("clientSearch");
            if(el){ el.value=""; el.dispatchEvent(new Event("input")); }
            var board=document.getElementById("clientStatusBoard");
            if(board && board.style.display==="none" && typeof toggleStatusBoard==="function") toggleStatusBoard();
            var dd=(typeof dailyCommandData==="function")?dailyCommandData():null;
            var list=(dd&&dd.delayed)||[];
            if(board) board.scrollIntoView({behavior:"smooth",block:"start"});
            if(list.length){
              addMsg("Delayed parcels: "+list.slice(0,8).map(function(p){ return p.awb; }).join(", ")+(list.length>8?(" and "+(list.length-8)+" more."):"."),"b",[{ label:"Open First", kind:"local", type:"open_awb", awb:list[0].awb }]);
            } else {
              addMsg("No delayed parcels right now \u2014 everything looks on track.","b");
            }
          }catch(e){}
        },150);
        return;
      }
      if(a.type==="filter_status"){
        if(typeof showClientTab==="function") showClientTab("dashboard");
        setTimeout(function(){
          var el=document.getElementById("clientSearch");
          if(el && a.query){ el.value=a.query; el.dispatchEvent(new Event("input")); }
        },150);
        return;
      }
      if(a.type==="preview_awb_label"){
        var pvRes=resolveOwnAwbs(a.awb?[a.awb]:[]);
        if(!pvRes.valid.length){ addMsg("I could not find "+(a.awb||"that AWB")+" in your account. Please check the tracking number.","b",[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }]); return; }
        var pvP=pvRes.valid[0];
        try{ state.lastGeneratedAwb=pvP.awb; saveState(); }catch(e){}
        if(typeof openAwbModal==="function") openAwbModal(pvP.awb);
        else if(typeof showClientTab==="function") showClientTab("awbLabel");
        addMsg("Here's the label preview for "+pvP.awb+" \u2014 confirm it's the right parcel before printing.","b",[
          { label:"Print This AWB", kind:"local", type:"print_awb", awb:pvP.awb },
          { label:"Open AWB Tab", kind:"local", type:"go_awb_label" }
        ]);
        return;
      }
      if(a.type==="print_awb"){
        var prA=safePrintAwbs(a.awb?[a.awb]:[]);
        if(prA.ok) addMsg("Opening the print dialog for "+prA.awbs.join(", ")+" now.","b",[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }]);
        return;
      }
      if(a.type==="preview_pending_awbs" || a.type==="print_pending_awbs"){
        try{
          var plr=buildPendingLabelsReply();
          addMsg(plr.reply,"b",plr.actions);
        }catch(e){ console.warn(e); addMsg("Couldn't check pending labels \u2014 try the AWB Label tab directly.","b",[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }]); }
        return;
      }
      if(a.type==="print_pending_awbs_confirmed"){
        var prB=safePrintAwbs(a.awbs||[]);
        if(prB.ok) addMsg("Printing "+prB.count+" pending label"+(prB.count===1?"":"s")+" now.","b",[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }]);
        return;
      }
      if(a.type==="open_wallet_withdraw"){
        if(typeof showClientTab==="function") showClientTab("wallet");
        setTimeout(function(){
          try{
            var el=document.getElementById("withdrawAmount");
            if(el && a.amount){ el.value=a.amount; el.dispatchEvent(new Event("input")); }
            if(el) el.scrollIntoView({behavior:"smooth",block:"center"});
          }catch(e){}
        },200);
        return;
      }
      if(a.type==="open_bulk_booking"){ if(typeof showClientTab==="function") showClientTab("bulkBooking"); return; }
      if(a.type==="open_reports"||a.type==="go_reports"){ if(typeof showClientTab==="function") showClientTab("reports"); return; }
      if(a.type==="open_payments"){ if(typeof showClientTab==="function") showClientTab("payments"); return; }
      if(a.type==="go_integrations"){ if(typeof showClientTab==="function") showClientTab("integrations"); return; }
      if(a.type==="talk_human"){ send("support se baat karni hai"); return; }
    }catch(e){ console.warn("NovaX Autopilot action failed",e); }
  }

  var INTRO_KEY="novaxAutopilotIntroSeen";
  var greeted=false;

  function hasClientIdentity(){
    try{ return !!(typeof state!=="undefined" && state.client && state.client.id); }catch(e){ return false; }
  }

  function showIntro(force){
    addMsg("Assalam o Alaikum, I'm NovaX Autopilot \u2014 your NovaX assistant.\n\nMain aapka NovaX assistant hoon. Aap bas normal message likhein, main tracking, COD, return aur support ka kaam handle kar dunga.\n\nI can help you:\n1. Track any parcel by AWB\n2. Check COD / wallet questions\n3. Start return or reattempt requests\n4. Explain what needs your attention today\n\nJust type like WhatsApp:\n\"mera parcel kahan hai?\"\n\"COD kab milega?\"\n\"return karwana hai\"\n\"rider ne call nahi ki\"","b",[
      { label:"Take Quick Tour", kind:"local", type:"start_tour" },
      { label:"Start Booking", kind:"local", type:"go_booking" }
    ]);
    if(!force){ try{ localStorage.setItem(INTRO_KEY,"1"); }catch(e){} }
  }

  function openPanel(){
    panel.classList.add("open");
    if(greeted) return;
    greeted=true;
    if(PORTAL==="client" && hasClientIdentity() && !localStorage.getItem(INTRO_KEY)){ showIntro(); return; }
    if(PORTAL==="client"){ greetWithBriefing(); return; }
    addMsg("Hi, I'm NovaX Autopilot. I only answer from your real account data \u2014 ask me to track an AWB, start a return, check your COD/wallet, or talk to a human.","b");
  }

  window.novaxOpenAutopilot=function(){ panel.classList.add("open"); openPanel(); };
  window.novaxAutopilotSay=function(text,actions){ try{ panel.classList.add("open"); greeted=true; addMsg(text,"b",actions); }catch(e){} };

  /* ===== Daily Command Center: Autopilot daily briefing (once per client per day) ===== */
  (function(){
    try{
      function briefingKey(){
        var today=new Date().toISOString().slice(0,10);
        var cId=(typeof cid==="function"&&cid())||(typeof state!=="undefined"&&state.client&&state.client.id)||"CL-0000";
        return "novaxDailyBriefingShown:"+cId+":"+today;
      }
      function briefingActions(data){
        var actions=[];
        if(data.issues.length) actions.push({ label:"Review Issues", kind:"local", type:"nv_review_issues" });
        if(data.unprinted.length) actions.push({ label:"Print Pending AWBs", kind:"local", type:"go_awb_label" });
        if(data.payable>0) actions.push({ label:"Withdraw Wallet", kind:"local", type:"go_wallet" });
        actions.push({ label:"Book Orders", kind:"local", type:"go_booking" });
        return actions;
      }
      function tryDailyBriefing(force){
        try{
          if(typeof PORTAL!=="undefined" && PORTAL!=="client") return;
          if(typeof dailyCommandData!=="function") return;
          var key=briefingKey();
          if(localStorage.getItem(key)==="1") return;
          var opened=panel && panel.classList.contains("open");
          if(!force && !opened) return;
          var data=dailyCommandData();
          localStorage.setItem(key,"1");
          window.novaxAutopilotSay(data.briefingText,briefingActions(data));
        }catch(e){}
      }
      /* This used to call tryDailyBriefing(true) 2.5 seconds after load for
         any merchant holding at least one issue parcel. force=true routes
         through novaxAutopilotSay(), which runs panel.classList.add("open") --
         so the chat panel opened itself over the dashboard, covering the right
         half on desktop and effectively all of it on a phone, and it landed
         AFTER the merchant had started reading, moving the page under them.

         Nobody asked for it. The briefing is not lost: the watch below already
         delivers it the moment the merchant opens the panel themselves, and
         openPanel() greets with it too. The FAB badge already carries the
         count and already pulses, so the signal survives without the takeover. */
      var watchTries=0;
      var watch=nvInterval(function(){
        watchTries++;
        if(panel && panel.classList.contains("open")){ tryDailyBriefing(false); clearInterval(watch); }
        if(watchTries>600){ clearInterval(watch); }
      },1000);
    }catch(e){}
  })();

  async function greetWithBriefing(){
    var loadingEl=addMsg("Pulling your daily briefing...","b");
    loadingEl.classList.add("nvauto-loading");
    try{
      var token=await getAuthToken();
      var res=await fetch(FN_URL,{
        method:"POST",
        headers:{ "Content-Type":"application/json", "apikey":SB_KEY, "Authorization":"Bearer "+token },
        body:JSON.stringify({ message:"", awb:null, portal:PORTAL })
      });
      var out=null; try{ out=await res.json(); }catch(e){}
      loadingEl.remove();
      if(!res.ok || !out || !out.reply){ addMsg("Hi, I'm NovaX Autopilot. Ask me to track an AWB, start a return, check your COD/wallet, or ask for a human.","b"); return; }
      addMsg(out.reply,"b",out.actions);
    }catch(e){
      loadingEl.remove();
      addMsg("Hi, I'm NovaX Autopilot. Ask me to track an AWB, start a return, check your COD/wallet, or ask for a human.","b");
    }
  }
  btn.addEventListener("click",function(){ panel.classList.toggle("open"); if(panel.classList.contains("open")) openPanel(); });
  panel.querySelector(".nvauto-x").addEventListener("click",function(){
    panel.classList.remove("open");
    /* Closing IS the dismissal. Nothing recorded it before, so the intro was
       free to open again on the next render, tab focus or reload. */
    try{ localStorage.setItem(INTRO_KEY,"1"); }catch(e){}
  });
  /* ===== Autopilot upgrades: delegated chips, per-tab suggestions,
     draggable launcher, proactive nudge. All additive — if any piece throws,
     the widget keeps working exactly as before. ===================== */

  /* Delegation instead of per-button listeners, because the chip row is now
     rebuilt whenever the merchant changes tab. Direct listeners would be lost
     on the first rebuild. */
  var chipsBox=panel.querySelector(".nvauto-chips");
  if(chipsBox){
    chipsBox.addEventListener("click",function(e){
      var c=e.target.closest("button"); if(!c||!chipsBox.contains(c)) return;
      if(c.getAttribute("data-help")){ showIntro(true); return; }
      if(c.getAttribute("data-local")){ handleAction({ kind:"local", type:c.getAttribute("data-local") }); return; }
      var q=c.getAttribute("data-q"); if(q) send(q);
    });
  }

  /* What to suggest on each tab. Keys match showClientTab() ids. */
  var NV_TAB_CHIPS={
    dashboard:[["What needs my attention?","q","What needs my attention?"],["Today's summary","q","my summary"],["Stuck parcels","q","which parcels haven't moved in two days?"],["Book","local","go_booking"]],
    newBooking:[["Paste an order","local","paste_whatsapp_order"],["What are my rates?","q","what are my delivery rates?"],["Track","q","mera parcel kahan hai?"],["Human","q","Please connect me with a human agent."]],
    bulkBooking:[["How does bulk work?","q","how do I upload a bulk booking file?"],["Book one instead","local","go_booking"],["Human","q","Please connect me with a human agent."]],
    awbLabel:[["Which need printing?","q","which parcels still need AWB labels printed?"],["Print AWBs","local","go_awb_label"],["Book","local","go_booking"]],
    wallet:[["When is my COD coming?","q","COD kab milega?"],["Wallet balance","q","what is my wallet balance?"],["Uninvoiced COD","q","how much COD is delivered but not yet invoiced?"],["Human","q","Please connect me with a human agent."]],
    payments:[["Explain my last invoice","q","explain my latest invoice"],["Why is my COD less?","q","why is my COD less than expected?"],["Wallet","local","go_wallet"]],
    logs:[["Explain a status","q","what does Reattempt mean?"],["Stuck parcels","q","which parcels haven't moved in two days?"],["Track","q","mera parcel kahan hai?"]],
    support:[["Talk to a human","q","Please connect me with a human agent."],["Review my issues","local","nv_review_issues"],["Refused parcels","q","which of my parcels were refused this week?"]],
    integrations:[["Shopify help","q","how do I connect my Shopify store?"],["Bulk import","q","how do I bulk import orders?"],["Human","q","Please connect me with a human agent."]]
  };
  var NV_CHIPS_DEFAULT=[["Track Parcel","q","mera parcel kahan hai?"],["Book Order","local","go_booking"],["COD / Wallet","q","COD kab milega?"],["Issue Help","local","nv_review_issues"],["Human","q","Please connect me with a human agent."]];

  function nvCurrentTab(){
    try{ return (typeof state!=="undefined" && state && state.activeClientTab) || "dashboard"; }
    catch(e){ return "dashboard"; }
  }
  function nvRenderChips(){
    if(!chipsBox) return;
    try{
      var list=NV_TAB_CHIPS[nvCurrentTab()]||NV_CHIPS_DEFAULT;
      chipsBox.innerHTML=list.map(function(c){
        var attr=c[1]==="local"?'data-local="'+c[2]+'"':'data-q="'+String(c[2]).replace(/"/g,"&quot;")+'"';
        return '<button type="button" '+attr+'>'+c[0].replace(/[&<>]/g,"")+'</button>';
      }).join("");
    }catch(e){}
  }
  nvRenderChips();

  /* Re-suggest when the merchant switches tab. Wraps showClientTab without
     replacing it, so the original behaviour is untouched. */
  try{
    if(typeof window.showClientTab==="function" && !window.__nvChipsHooked){
      window.__nvChipsHooked=true;
      var _origShowTab=window.showClientTab;
      window.showClientTab=function(){
        var r=_origShowTab.apply(this,arguments);
        try{ nvRenderChips(); nvMaybeNudge(); }catch(e){}
        return r;
      };
    }
  }catch(e){}

  /* ---- Draggable launcher -------------------------------------------- */
  var NV_POS_KEY="novaxAutopilotPos";
  var dragging=false, moved=false, sx=0, sy=0, ox=0, oy=0;
  function nvApplyPos(x,y){
    var w=btn.offsetWidth||54, h=btn.offsetHeight||54;
    x=Math.max(8,Math.min(x,window.innerWidth-w-8));
    y=Math.max(8,Math.min(y,window.innerHeight-h-8));
    btn.style.left=x+"px"; btn.style.top=y+"px";
    btn.style.right="auto"; btn.style.bottom="auto";
    nvPlacePanel();
  }
  function nvPlacePanel(){
    // Mobile keeps the bottom-sheet layout; only reposition on desktop.
    if(window.innerWidth<760){ panel.style.left=panel.style.top=panel.style.right=panel.style.bottom=""; return; }
    var r=btn.getBoundingClientRect(), pw=panel.offsetWidth||380, ph=panel.offsetHeight||420;
    var left=Math.max(8,Math.min(r.left,window.innerWidth-pw-8));
    var top=(r.top-ph-10>=8)?(r.top-ph-10):Math.min(r.bottom+10,window.innerHeight-ph-8);
    panel.style.left=left+"px"; panel.style.top=top+"px";
    panel.style.right="auto"; panel.style.bottom="auto";
  }
  try{
    var saved=JSON.parse(localStorage.getItem(NV_POS_KEY)||"null");
    if(saved && typeof saved.x==="number") setTimeout(function(){ nvApplyPos(saved.x,saved.y); },0);
  }catch(e){}

  btn.style.touchAction="none";
  btn.addEventListener("pointerdown",function(e){
    if(e.button&&e.button!==0) return;
    dragging=true; moved=false;
    var r=btn.getBoundingClientRect();
    sx=e.clientX; sy=e.clientY; ox=r.left; oy=r.top;
    try{ btn.setPointerCapture(e.pointerId); }catch(_){}
  });
  btn.addEventListener("pointermove",function(e){
    if(!dragging) return;
    var dx=e.clientX-sx, dy=e.clientY-sy;
    // 6px threshold so a normal tap still opens the panel.
    if(!moved && Math.abs(dx)+Math.abs(dy)<6) return;
    moved=true; btn.style.transition="none";
    nvApplyPos(ox+dx,oy+dy);
  });
  function nvEndDrag(e){
    if(!dragging) return;
    dragging=false; btn.style.transition="";
    try{ btn.releasePointerCapture(e.pointerId); }catch(_){}
    if(moved){
      var r=btn.getBoundingClientRect();
      try{ localStorage.setItem(NV_POS_KEY,JSON.stringify({x:r.left,y:r.top})); }catch(_){}
    }
  }
  btn.addEventListener("pointerup",nvEndDrag);
  btn.addEventListener("pointercancel",nvEndDrag);
  // Swallow the click that follows a drag, so moving it doesn't open the panel.
  btn.addEventListener("click",function(e){
    if(moved){ e.stopImmediatePropagation(); e.preventDefault(); moved=false; }
  },true);
  window.addEventListener("resize",function(){
    try{
      if(btn.style.left){ nvApplyPos(parseFloat(btn.style.left),parseFloat(btn.style.top)); }
      if(panel.classList.contains("open")) nvPlacePanel();
    }catch(e){}
  });

  /* ---- Proactive nudge ------------------------------------------------ */
  var nudge=document.createElement("div");
  nudge.className="nvauto-nudge";
  nudge.setAttribute("role","status");
  document.body.appendChild(nudge);
  var NV_NUDGE_SEEN={};
  /* Short enough to read at a glance. These sit in a small bubble tethered
     to the launcher for about two seconds -- a sentence does not fit and,
     on a phone, a long one wrapped to three lines and read as a stuck card
     floating on its own with no visible relationship to the button. */
  var NV_TAB_NUDGE={
    dashboard:["See what needs you today?","What needs my attention?"],
    newBooking:["Paste a WhatsApp order \u2014 I'll fill this in.","__paste"],
    wallet:["When does your COD land?","COD kab milega?"],
    awbLabel:["Which parcels need labels?","which parcels still need AWB labels printed?"],
    payments:["Explain your latest invoice?","explain my latest invoice"],
    support:["Look up a parcel issue?","which of my parcels have problems right now?"],
    tickets:["Open a support ticket?","how do I open a support ticket?"],
    integrations:["Connect your store?","how do I connect my Shopify store?"]
  };
  /* Timers are held so a second call can cancel the first. Without this a
     pending hide from an earlier tab could fire against a newly shown bubble
     -- or worse, never fire -- which is how it ended up stuck on screen. */
  var NV_NUDGE_T1=null, NV_NUDGE_T2=null;
  function nvHideNudge(){
    clearTimeout(NV_NUDGE_T1); clearTimeout(NV_NUDGE_T2);
    NV_NUDGE_T1=NV_NUDGE_T2=null;
    nudge.classList.remove("show");
  }
  function nvMaybeNudge(){
    try{
      if(panel.classList.contains("open")) return;
      var tab=nvCurrentTab(), cfg=NV_TAB_NUDGE[tab];
      if(!cfg || NV_NUDGE_SEEN[tab]) return;
      NV_NUDGE_SEEN[tab]=true;
      nvHideNudge();
      nudge.textContent=cfg[0];
      var r=btn.getBoundingClientRect();
      /* Tethered to the launcher at EVERY width. It used to stretch
         left:12px/right:12px under 760px, which turned it into a full-width
         card floating with no visible relationship to the button that owns
         it -- the launcher in one corner, its own speech bubble somewhere
         else entirely. Right-aligning to the button's edge keeps the two
         reading as one object. */
      nudge.style.left="auto";
      nudge.style.width="";
      nudge.style.right=Math.max(10,window.innerWidth-r.right)+"px";
      nudge.style.maxWidth="min(238px, calc(100vw - 28px))";
      nudge.style.bottom=(window.innerHeight-r.top+10)+"px";
      nudge.onclick=function(){
        nvHideNudge();
        panel.classList.add("open"); openPanel(); nvPlacePanel();
        if(cfg[1]==="__paste"){ handleAction({ kind:"local", type:"paste_whatsapp_order" }); }
        else send(cfg[1]);
      };
      /* Two seconds on screen, not eleven. It is a hint, not a message: long
         enough to read six words, short enough that it is gone before it can
         be in the way. */
      NV_NUDGE_T1=setTimeout(function(){ nudge.classList.add("show"); },350);
      NV_NUDGE_T2=setTimeout(nvHideNudge,2350);
    }catch(e){}
  }
  btn.addEventListener("click",nvHideNudge);
  /* Anything that moves the launcher or the page invalidates its position,
     so dismiss rather than leave it hanging in the wrong place. */
  window.addEventListener("scroll",nvHideNudge,{passive:true});
  window.addEventListener("resize",nvHideNudge,{passive:true});
  setTimeout(nvMaybeNudge,3500);

  var input=document.getElementById("nvautoInput");
  var sendBtn=document.getElementById("nvautoSend");
  sendBtn.addEventListener("click",function(){ send(input.value); });
  input.addEventListener("keydown",function(e){ if(e.key==="Enter") send(input.value); });

  function getAwbFromText(t){ var m=String(t||"").toUpperCase().match(/\b[A-Z]{0,4}\d{4,}[A-Z0-9]*\b/); return m?m[0]:null; }

  /* ===== NovaX Autopilot: Never-Blank Local Fallback Brain (Part C/D/E/F) ===== */
  var NV_KW={
    greeting:["hi","hello","hey","salam","assalam","aoa","asalam","slam","start"],
    abuse:["useless","stupid","idiot","scam","fraud","worst service","you people","bekar","ghatiya","nalayak","threat","report you","sue you","harami","bewakoof","nonsense","pathetic"],
    tracking:["where is","track","tracking","parcel kahan","kahan hai","order status","delivery status","scan update","location","hub kahan","rider location","kidhar hai","kaha hai","status kya","meri order","mera order","package status","kaha pohcha","kidr hai"],
    booking:["book parcel","create awb","new order","pickup request","schedule pickup","how to ship","bulk booking","paste whatsapp","booking kaise","order kaise book","naya order","parcel bhejna","book karna","shipment banana","order create"],
    codWallet:["cod ","cod?","cod.","payment","wallet","payout","withdraw","invoice","delivery fee","deduction","bank transfer","iban","paisay","paise","rupay","cod kab","payment kab","balance"],
    deliveryIssues:["delayed","stuck","no update","lost","damaged","wrong status","misroute","hub issue","rider issue","late ho gaya","abhi tak nahi mila","kharab ho gaya","ruk gaya","pending since"],
    refusalReturn:["refused","reattempt","return parcel","not available","wrong address","not picking","wapis","mangwana","return karna","refuse kar diya","mana kar diya","return chahiye"],
    riderPickup:["rider kab","pickup pending","rider not came","rider call","pickup address","rider assigned","rider nahi aya","abhi tak nahi aya","banda nahi aya","rider ne call"],
    printing:["print label","awb label","barcode","qr code","label not printing","printer issue","reprint","label print","print kaise","print nahi ho raha","print awb"],
    integrations:["shopify","woocommerce","api","webhook","website orders","sync orders","import orders","store connect","integration"],
    reports:["csv","full report","delivery report","payment report","status report","export","date range","report chahiye"],
    human:["human","agent","support se","complaint","escalation","manager","urgent","insan se","banda se","talk to someone"],
    account:["login issue","password","reset","sub account","team user","permissions","login nahi","account access"],
    rates:["rate","city rate","zone","cod fee","fuel surcharge","tax on","discount","charges kya","rate kya"],
    serviceability:["city available","area service","karachi","lahore","islamabad","rawalpindi","out of service area","service hai kya","covered city"],
    proof:["proof","pod","delivery proof","photo of delivery","signature","call proof"]
  };
  var NV_NEXT_STEP={
    "New booked":"Rider pickup",
    "Collected by rider":"Arrival at warehouse",
    "Arrived at warehouse":"Dispatch to transit",
    "Parcel now in transit":"Arrival at destination hub",
    "Parcel received at destination":"Out for delivery",
    "Parcel out for delivery":"Delivery attempt today",
    "Delivered":"Completed",
    "Refused":"Awaiting your return or reattempt decision",
    "Consignee not available":"Reattempt or reschedule",
    "Reattempt":"Next delivery attempt",
    "Reassigned":"New rider assignment",
    "Out of service area":"Likely return to origin",
    "Ready for return":"Return pickup",
    "Return in transit":"Arrival at origin",
    "Return received at origin":"Return closed",
    "Return out for delivery":"Return delivery to you",
    "Return to shipper":"Completed"
  };

  function localAutopilotFallback(rawMessage){
    var msg=String(rawMessage||"").trim();
    var lower=msg.toLowerCase();
    var ctx=null; try{ ctx=(typeof getClientContext==="function")?getClientContext():null; }catch(e){}
    var clientName=(ctx&&ctx.clientName)||(typeof state!=="undefined"&&state.client&&state.client.name)||"";

    function has(list){ return list.some(function(k){ return lower.indexOf(k)!==-1; }); }
    function fmtMoney(v){ try{ return (typeof money==="function")?money(v):("Rs "+Math.round(v||0)); }catch(e){ return String(v); } }

    if(has(NV_KW.abuse)){
      return { reply:"I'm sorry this has been frustrating \u2014 that's not okay and I want to get it fixed. A human teammate will need to look at this one directly.", actions:[
        { label:"Talk to Human", kind:"send", message:"support se baat karni hai" }
      ] };
    }

    var isGreeting=!msg || lower==="help" || lower==="start" || /(^|\s)(hi|hello|hey|salam|assalam|aoa|asalam|slam)(\s|$|[!.,])/i.test(lower);
    if(isGreeting){
      return { reply:"Hi"+(clientName?" "+clientName:"")+", I'm NovaX Autopilot.\nI can track parcels, handle COD/wallet questions, and start returns.\nAsk me like WhatsApp \u2014 e.g. \"mera parcel kahan hai?\"", actions:[
        { label:"Track Parcel", kind:"send", message:"track my parcel" },
        { label:"Book Order", kind:"local", type:"go_booking" },
        { label:"Talk to Human", kind:"send", message:"support se baat karni hai" }
      ] };
    }

    var awb=getAwbFromText(msg);
    if(!awb && has(NV_KW.tracking)){ try{ awb=(typeof state!=="undefined"&&state.selectedAwb)||null; }catch(e){} }
    // NovaX fix (Autopilot AWB printing v1): a message like "print awb
    // N5930015" also matches the generic AWB-number pattern above, so
    // without this check it used to fall straight into the tracking-status
    // reply below and never reach printing at all. Print intent is now
    // checked first so it always wins over the generic tracking guess.
    if(has(NV_KW.printing)) return awb?buildAwbPrintReply(awb):buildPendingLabelsReply();
    if(awb){
      var pool=(typeof myParcels==="function")?myParcels():((typeof state!=="undefined"&&state.parcels)||[]);
      var p=pool.find(function(x){ return String(x.awb||"").toUpperCase()===String(awb).toUpperCase(); });
      if(p){
        var next=NV_NEXT_STEP[p.status]||"In progress";
        return { reply:"AWB "+p.awb+": "+p.status+" ("+(p.city||"")+").\nNext step: "+next+".", actions:[
          { label:"Track Journey", kind:"local", type:"show_journey_awb", awb:p.awb },
          { label:"Copy Customer Message", kind:"local", type:"copy_customer_message", awb:p.awb }
        ] };
      }
      return { reply:"I couldn't find "+awb+" under this account. Please confirm the tracking ID.", actions:[
        { label:"Talk to Human", kind:"send", message:"support se baat karni hai" }
      ] };
    }

    if(has(["how many parcel","kitne parcel","kitny parcel","total parcel","parcel count"])){
      if(ctx) return { reply:"You have "+ctx.totalAllTime+" parcel(s) total \u2014 "+ctx.totalInRange+" in your current range, "+ctx.deliveredCount+" delivered.", actions:[{ label:"View Dashboard", kind:"local", type:"go_dashboard" }] };
    }
    if(has(["any issue","koi issue","masla hai","issues today","problem today","which parcels need my attention","parcels need my attention","need my attention","need attention","show action needed","action needed","action center"])){
      if(ctx && ctx.issueCount>0) return { reply:"You have "+ctx.issueCount+" parcel(s) needing attention. First one: "+ctx.firstIssueAwb+".", actions:[
        { label:"Review Issues", kind:"local", type:"nv_review_issues" },
        { label:"Track Journey", kind:"local", type:"show_journey_awb", awb:ctx.firstIssueAwb }
      ] };
      return { reply:"No open issues right now \u2014 everything looks on track.", actions:[{ label:"View Dashboard", kind:"local", type:"go_dashboard" }] };
    }
    if(has(["show delayed","delayed orders","delayed parcels","which parcels are delayed","delayed order"])){
      var pool2=(typeof myParcels==="function")?myParcels():((typeof state!=="undefined"&&state.parcels)||[]);
      var delayedList=pool2.filter(function(x){ try{ return typeof isDelayed==="function" && isDelayed(x) && x.status!=="Delivered"; }catch(e){ return false; } });
      if(!delayedList.length) return { reply:"No delayed parcels right now \u2014 everything is moving on time.", actions:[{ label:"View Dashboard", kind:"local", type:"go_dashboard" }] };
      var names=delayedList.slice(0,5).map(function(x){ return x.awb; }).join(", ");
      return { reply:"You have "+delayedList.length+" delayed parcel(s): "+names+(delayedList.length>5?" and more":"")+".", actions:[
        { label:"Review Issues", kind:"local", type:"nv_review_issues" },
        { label:"Track Journey", kind:"local", type:"show_journey_awb", awb:delayedList[0].awb }
      ] };
    }
    if(has(["reattempt this","reattempt it","redeliver this"])){
      var reAwb=awb||(typeof state!=="undefined"&&state.selectedAwb)||(ctx&&ctx.firstIssueAwb);
      if(!reAwb) return { reply:"Which AWB should I reattempt? Share the tracking ID and I'll prepare the request.", actions:[{ label:"Review Issues", kind:"local", type:"nv_review_issues" }] };
      return buildReattemptConfirm(reAwb);
    }
    if(has(["return this parcel","return this","return it"])){
      var rtAwb=awb||(typeof state!=="undefined"&&state.selectedAwb)||(ctx&&ctx.firstIssueAwb);
      if(!rtAwb) return { reply:"Which AWB should I return? Share the tracking ID and I'll prepare the request.", actions:[{ label:"Review Issues", kind:"local", type:"nv_review_issues" }] };
      return buildReturnConfirm(rtAwb);
    }
    if(has(["why was it refused","why refused","why was this refused","reason for refusal","refuse kyun"])){
      var whyAwb=awb||(typeof state!=="undefined"&&state.selectedAwb)||(ctx&&ctx.firstIssueAwb);
      var poolW=(typeof myParcels==="function")?myParcels():((typeof state!=="undefined"&&state.parcels)||[]);
      var pw=whyAwb?poolW.find(function(x){ return String(x.awb||"").toUpperCase()===String(whyAwb).toUpperCase(); }):null;
      if(pw && typeof classifyParcelException==="function"){
        var info=classifyParcelException(pw);
        if(info) return { reply:pw.awb+": "+info.problem+"\nLikely cause: "+info.cause+"\nSuggested action: "+info.action, actions:[
          { label:"Reattempt", kind:"local", type:"confirm_action", awb:pw.awb },
          { label:"Return to Me", kind:"local", type:"nv_review_issues" },
          ] };
      }
      return { reply:"I couldn't find a refusal reason for that parcel yet \u2014 share the AWB and I'll check again." };
    }

    if(has(NV_KW.printing)){
      // NovaX fix (Autopilot AWB printing v1): kept as a safety net -- the
      // printIntent check near the top of this function normally handles
      // this earlier, but if it ever doesn't, this still returns the same
      // safe tiered pending-labels reply instead of the old generic
      // one-line message.
      return buildPendingLabelsReply();
    }
    if(has(NV_KW.codWallet)){
      var payable=ctx?ctx.payableBalance:0;
      return { reply:"Your current payable balance is "+fmtMoney(payable)+". Delivered COD moves to your wallet for withdrawal.", actions:[{ label:"Open Wallet", kind:"local", type:"go_wallet" }] };
    }
    if(has(NV_KW.booking)){
      return { reply:"To book: open New Booking, or paste the WhatsApp order text and I'll fill the form for you.", actions:[
        { label:"Start Booking", kind:"local", type:"go_booking" },
        { label:"Paste Order", kind:"local", type:"paste_whatsapp_order" }
      ] };
    }
    if(has(NV_KW.refusalReturn)){
      return { reply:"For a refused or returned parcel I can start a reattempt or a return.", actions:[
        { label:"Review Issues", kind:"local", type:"nv_review_issues" },
        ] };
    }
    if(has(NV_KW.riderPickup)){
      return { reply:"I don't have live rider GPS here \u2014 the parcel journey shows the latest confirmed scan." };
    }
    if(has(NV_KW.deliveryIssues)){
      return { reply:"Sorry about that. Share the AWB and I'll check its exact status." };
    }
    if(has(NV_KW.integrations)){
      return { reply:"Shopify, WooCommerce and custom API orders can sync into NovaX automatically \u2014 set this up from the API tab.", actions:[{ label:"Open Integrations", kind:"local", type:"go_integrations" }] };
    }
    if(has(NV_KW.reports)){
      return { reply:"Full reports with CSV export are under Full Report \u2014 filter by date range or status there.", actions:[{ label:"Open Reports", kind:"local", type:"go_reports" }] };
    }
    if(has(NV_KW.account)){
      return { reply:"For login or account access, please contact NovaX support directly \u2014 I can't reset passwords from here." };
    }
    if(has(NV_KW.rates)){
      return { reply:"Charges depend on city/zone and COD amount \u2014 New Booking shows the exact rate as you fill the form.", actions:[{ label:"Start Booking", kind:"local", type:"go_booking" }] };
    }
    if(has(NV_KW.serviceability)){
      return { reply:"Most major Pakistani cities are covered. Enter the city in New Booking and I'll reflect the rate if it's serviceable.", actions:[{ label:"Start Booking", kind:"local", type:"go_booking" }] };
    }
    if(has(NV_KW.proof)){
      return { reply:"Delivery proof is attached once a parcel is delivered \u2014 check the AWB journey to see it." };
    }
    if(has(NV_KW.human)){
      return { reply:"A human teammate will need to look at this one \u2014 please contact NovaX support directly." };
    }
    if(has(NV_KW.tracking)){
      return { reply:"Share the AWB / tracking ID and I'll pull its exact status, city and next step.", actions:[
        { label:"Paste Order", kind:"local", type:"paste_whatsapp_order" },
        { label:"Open AWB Tab", kind:"local", type:"go_awb_label" }
      ] };
    }

    return { reply:"I'm not fully sure what you mean yet \u2014 could you add a little more detail (like an AWB number)?", actions:[
      { label:"Track Parcel", kind:"send", message:"track my parcel" },
      { label:"Book Order", kind:"local", type:"go_booking" },
      { label:"Talk to Human", kind:"send", message:"support se baat karni hai" }
    ] };
  }
  window.localAutopilotFallback=localAutopilotFallback;

  /* ===== NovaX Autopilot: Action Engine (safe actions + confirmed risky actions) ===== */
  var pendingAutopilotConfirm=null;
  var pendingAutopilotConfirmTimer=null;
  function clearPendingAutopilotConfirm(){
    pendingAutopilotConfirm=null;
    if(pendingAutopilotConfirmTimer){ clearTimeout(pendingAutopilotConfirmTimer); pendingAutopilotConfirmTimer=null; }
  }
  function setPendingAutopilotConfirm(action){
    pendingAutopilotConfirm=action;
    if(pendingAutopilotConfirmTimer) clearTimeout(pendingAutopilotConfirmTimer);
    pendingAutopilotConfirmTimer=setTimeout(function(){ pendingAutopilotConfirm=null; },60000);
  }

  /* ===== NovaX fix (Autopilot AWB printing v1) =====
     Safe, deterministic AWB print helpers used by every AI-driven print
     action below. These never touch the AWB Label tab's own manual print
     buttons (printAwb/printLabels callers elsewhere in the file) -- they
     only add a safe layer on top for Autopilot. */
  function resolveOwnAwbs(awbs){
    var list=Array.isArray(awbs)?awbs:(awbs?[awbs]:[]);
    var upper=list.map(function(a){ return String(a||"").trim().toUpperCase(); }).filter(Boolean);
    var pool=(typeof myParcels==="function")?myParcels():[];
    var valid=[]; var invalid=[];
    upper.forEach(function(a){
      var p=pool.find(function(x){ return String(x.awb||"").toUpperCase()===a; });
      if(p) valid.push(p); else invalid.push(a);
    });
    return { valid:valid, invalid:invalid, requested:upper };
  }

  // The one safe entry point for every AI-driven print: resolves against
  // the current client's own parcels only (never selectedParcel()),
  // always opens the AWB Label tab/preview before printing so the DOM is
  // real before printLabels touches it, and never silently prints
  // nothing -- it returns { ok:false, ... } and shows a clear Autopilot
  // message instead.
  function safePrintAwbs(awbs,options){
    var opts=options||{};
    var resolved=resolveOwnAwbs(awbs);
    if(!resolved.valid.length){
      var missingLabel=resolved.invalid.join(", ")||"that AWB";
      if(!opts.silent){
        addMsg(opts.notFoundMessage||("I could not find "+missingLabel+" in your account. Please check the tracking number."),"b",[
          { label:"Open AWB Tab", kind:"local", type:"go_awb_label" }
        ]);
      }
      return { ok:false, count:0, awbs:[], error:"No matching AWB found for this client." };
    }
    var validAwbs=resolved.valid.map(function(p){ return p.awb; });
    try{
      state.lastGeneratedAwb=resolved.valid[0].awb;
      if(typeof showClientTab==="function") showClientTab("awbLabel");
      if(typeof renderAwbLabel==="function") renderAwbLabel();
    }catch(e){}
    var run=function(){
      var result=(typeof printLabels==="function")?printLabels(validAwbs):{ ok:false, count:0, awbs:[], error:"Print function unavailable." };
      if(!result||!result.ok){
        addMsg("I couldn't open the print preview for "+(validAwbs.length>1?"those labels":validAwbs[0])+" \u2014 try the AWB Label tab directly.","b",[
          { label:"Open AWB Tab", kind:"local", type:"go_awb_label" }
        ]);
      }
      if(typeof opts.onDone==="function"){ try{ opts.onDone(result); }catch(e){} }
    };
    // NovaX fix: give the AWB Label tab one real paint frame before
    // printLabels touches printStage, so the preview underneath is never
    // left blank/stale when the print dialog closes.
    if(typeof requestAnimationFrame==="function") requestAnimationFrame(function(){ setTimeout(run,0); });
    else setTimeout(run,30);
    return { ok:true, count:validAwbs.length, awbs:validAwbs, error:null };
  }
  window.safePrintAwbs=safePrintAwbs;

  function buildAwbPrintReply(awb){
    var pool=(typeof myParcels==="function")?myParcels():[];
    var p=pool.find(function(x){ return String(x.awb||"").toUpperCase()===String(awb||"").toUpperCase(); });
    if(!p) return { reply:"I could not find "+awb+" in your account. Please check the tracking number.", actions:[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }] };
    var already=p.awbPrinted||p.labelPrinted;
    var reply=already?("This label was already printed, but you can reprint "+p.awb+" if needed."):("I found "+p.awb+". I'll open the label preview first so you don't print the wrong parcel.");
    return { reply:reply, actions:[
      { label:"Preview Label", kind:"local", type:"preview_awb_label", awb:p.awb },
      { label:"Print This AWB", kind:"local", type:"print_awb", awb:p.awb },
      { label:"Open AWB Tab", kind:"local", type:"go_awb_label" }
    ] };
  }

  function buildPendingLabelsReply(){
    var pool=(typeof myParcels==="function")?myParcels():[];
    var unprintedList=pool.filter(function(p){ return typeof isUnprintedLabel==="function"?isUnprintedLabel(p):false; }).map(function(p){ return p.awb; });
    if(!unprintedList.length) return { reply:"All AWB labels are already printed.", actions:[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }] };
    if(unprintedList.length===1) return { reply:"I found 1 pending label: "+unprintedList[0]+". I'll open the preview first so you can confirm before printing.", actions:[
      { label:"Preview Label", kind:"local", type:"preview_awb_label", awb:unprintedList[0] },
      { label:"Print This AWB", kind:"local", type:"print_awb", awb:unprintedList[0] }
    ] };
    var shown=unprintedList.slice(0,3);
    var more=unprintedList.length-shown.length;
    return { reply:"I found "+unprintedList.length+" printable AWBs: "+shown.join(", ")+(more>0?" and "+more+" more":"")+". I'll print only after you confirm \u2014 do you want to print all?", actions:[
      { label:"Print All Pending", kind:"local", type:"print_pending_awbs_confirmed", awbs:unprintedList },
      { label:"Open AWB Tab", kind:"local", type:"go_awb_label" },
      { label:"Cancel", kind:"local", type:"cancel_confirm" }
    ] };
  }

  function buildReturnConfirm(awb){
    return { reply:"I can prepare a return request for "+awb+". Confirm?", actions:[
      { label:"Confirm Return", kind:"local", type:"confirm_action" },
      { label:"Cancel", kind:"local", type:"cancel_confirm" }
    ], needsConfirm:true, confirmAction:{ type:"request_return_awb", awb:awb, resultMsg:"Return request prepared for "+awb+". Sent to operations." } };
  }
  function buildReattemptConfirm(awb){
    return { reply:"I can prepare a reattempt request for "+awb+". Confirm?", actions:[
      { label:"Confirm Reattempt", kind:"local", type:"confirm_action" },
      { label:"Cancel", kind:"local", type:"cancel_confirm" }
    ], needsConfirm:true, confirmAction:{ type:"request_reattempt_awb", awb:awb, resultMsg:"Reattempt request prepared for "+awb+". Sent to operations." } };
  }

  function executeConfirmedAction(action){
    if(!action) return;
    try{
      if(action.type==="request_return_awb"){
        // NovaX fix (item 3): requestReturnToOrigin() is async (it waits for
        // the ticket to be accepted server-side) -- Autopilot must
        // wait for that same result instead of announcing success the
        // instant the call is fired. On failure, tell the client clearly
        // instead of leaving the earlier "sent to operations" message as the
        // last word.
        if(typeof requestReturnToOrigin==="function"){
          var retP=requestReturnToOrigin(action.awb);
          if(retP && typeof retP.then==="function"){
            retP.then(function(){ addMsg(action.resultMsg||("Return request sent for "+action.awb+"."),"b",[{ label:"Open Journey", kind:"local", type:"open_awb", awb:action.awb }]); })
              .catch(function(){ addMsg("I couldn't send the return request for "+action.awb+" to operations \u2014 please try again in a moment.","b"); });
          } else {
            addMsg(action.resultMsg||("Return request sent for "+action.awb+"."),"b",[{ label:"Open Journey", kind:"local", type:"open_awb", awb:action.awb }]);
          }
        }
        else addMsg("I couldn't update this locally \u2014 please use the Return button on the parcel journey.","b");
        return;
      }
      if(action.type==="request_reattempt_awb"){
        // NovaX fix (item 3): same async-await fix as the return-to-origin
        // branch above, for requestRedelivery().
        if(typeof requestRedelivery==="function"){
          var reaP=requestRedelivery(action.awb);
          if(reaP && typeof reaP.then==="function"){
            reaP.then(function(){ addMsg(action.resultMsg||("Reattempt request sent for "+action.awb+"."),"b",[{ label:"Open Journey", kind:"local", type:"open_awb", awb:action.awb }]); })
              .catch(function(){ addMsg("I couldn't send the reattempt request for "+action.awb+" to operations \u2014 please try again in a moment.","b"); });
          } else {
            addMsg(action.resultMsg||("Reattempt request sent for "+action.awb+"."),"b",[{ label:"Open Journey", kind:"local", type:"open_awb", awb:action.awb }]);
          }
        }
        else addMsg("I couldn't update this locally \u2014 please use the Reattempt button on the parcel journey.","b");
        return;
      }
      if(action.type==="message_customer_awb"){
        if(typeof messageCustomer==="function"){ messageCustomer(action.awb); addMsg(action.resultMsg||("Opened a WhatsApp draft for "+action.awb+"."),"b"); }
        else addMsg("I couldn't open WhatsApp locally \u2014 use Message Customer on the parcel journey.","b");
        return;
      }
      if(action.type==="bulk_print_awbs"){
        if(typeof printLabels==="function") printLabels(action.awbs||[]);
        if(typeof showClientTab==="function") showClientTab("awbLabel");
        addMsg(action.resultMsg||"Opened print preview for the pending labels.","b");
        return;
      }
    }catch(e){
      console.warn("NovaX Autopilot confirmed action failed",e);
      addMsg("I couldn't complete that action locally \u2014 please try again from the relevant tab.","b");
    }
  }

  function autopilotActionEngine(rawMessage){
    var msg=String(rawMessage||"").trim();
    if(!msg) return null;
    var lower=msg.toLowerCase();
    function has(list){ return list.some(function(k){ return lower.indexOf(k)!==-1; }); }
    var ctx=null; try{ ctx=(typeof getClientContext==="function")?getClientContext():null; }catch(e){}
    var awb=getAwbFromText(msg);
    var selectedAwb=null; try{ selectedAwb=(typeof state!=="undefined"&&state.selectedAwb)||null; }catch(e){}
    var targetAwb=awb||(ctx&&ctx.firstIssueAwb)||null;
    var targetAwbRisky=awb||selectedAwb||null;
    var isQuestion=/\?|kaise|kyun|why|\bhow\b/i.test(lower);

    if(!isQuestion && (has(["return karna","return karwa","return chahiye","return this","return parcel","request return"]) || (lower.indexOf("return")!==-1 && awb))){
      if(!targetAwbRisky) return { reply:"Which AWB would you like to return? Please share the tracking ID.", actions:[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }] };
      return buildReturnConfirm(targetAwbRisky);
    }

    if(!isQuestion && has(["reattempt","dobara deliver","dubara deliver","dobara bhejo","dubara bhejo"])){
      if(!targetAwbRisky) return { reply:"Which AWB needs a reattempt? Please share the tracking ID.", actions:[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }] };
      return buildReattemptConfirm(targetAwbRisky);
    }

    if(has(["withdraw","payout nikal","paisay nikal","paise nikal"])){
      // NovaX fix: only real wallet money (clients.wallet_balance) can ever
      // be withdrawn -- invoice-payable-pending amounts are not in the
      // wallet yet, so they must not be offered/prefilled here.
      var wallet=ctx?ctx.walletBalance:0;
      if(!(wallet>0)) return { reply:"There's no wallet balance ready to withdraw right now.", actions:[{ label:"Open Wallet", kind:"local", type:"go_wallet" }] };
      var amtMatch=msg.match(/\b\d{2,7}\b/);
      var reqAmt=amtMatch?Number(amtMatch[0]):null;
      var amtForPrefill=(reqAmt && reqAmt>0 && reqAmt<=wallet)?reqAmt:null;
      return { reply:"I can open your Wallet to withdraw"+(amtForPrefill?(" Rs "+amtForPrefill):"")+" \u2014 please confirm the amount and your bank (IBAN) details there before submitting.", actions:[
        { label:"Open Wallet", kind:"local", type:"open_wallet_withdraw", amount:amtForPrefill }
      ] };
    }

    /* Cancel a booking. The AI only ever OFFERS it -- the button routes to
       cancelClientBooking(), which asks for confirmation and then calls the
       server RPC. The real guard is in the database, not here. */
    if(has(["cancel booking","cancel order","cancel parcel","cancel my order","booking cancel","order cancel","cancel kar","cancel karna","cancel karwana"])){
      if(!targetAwb) return { reply:"Share the tracking number and I'll check whether it can still be cancelled. Only parcels still showing \"New booked\" can be cancelled from the portal." };
      var cp=null;
      try{ cp=(nvMyParcels()||[]).find(function(x){ return String(x.awb).toUpperCase()===String(targetAwb).toUpperCase(); }); }catch(e){}
      if(!cp) return { reply:"I couldn't find "+targetAwb+" under this account. Please confirm the tracking ID." };
      if(typeof isCancellableBooking==="function" && !isCancellableBooking(cp)){
        return { reply:targetAwb+" is already \""+cp.status+"\", so it can't be cancelled from here any more. Open a support ticket and our team will look at it.",
                 actions:[{ label:"Open a ticket", kind:"local", type:"open_tickets" }] };
      }
      return { reply:"I can cancel "+targetAwb+". The tracking number stays on record and can't be reused, and this can't be undone.",
               actions:[{ label:"Cancel "+targetAwb, kind:"local", type:"cancel_booking_awb", awb:targetAwb }] };
    }
    /* Human handoff now means a real, manual ticket. */
    if(has(["open ticket","raise ticket","create ticket","ticket banao","support ticket","complaint","shikayat","talk to human","human agent","speak to someone","baat karni hai"])){
      return { reply:"I can take you to Support Tickets — open one there and a person will reply in the same thread. You'll see the reply in the portal.",
               actions:[{ label:"Open Support Tickets", kind:"local", type:"open_tickets" }] };
    }
    if(has(["mark delivered","mark returned","mark refused","mark as delivered","mark as returned","mark as refused"])){
      return { reply:"I can't change delivery status directly \u2014 only rider or admin scans update that." };
    }

    if(has(["send customer update","message customer","update the customer","customer ko batao","customer ko message"])){
      if(!targetAwbRisky) return { reply:"Which AWB's customer should I message? Please share the tracking ID.", actions:[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }] };
      return { reply:"I can open a WhatsApp draft to update the customer for "+targetAwbRisky+". Confirm?", actions:[
        { label:"Confirm Send", kind:"local", type:"confirm_action" },
        { label:"Cancel", kind:"local", type:"cancel_confirm" }
      ], needsConfirm:true, confirmAction:{ type:"message_customer_awb", awb:targetAwbRisky, resultMsg:"Opened a WhatsApp draft for "+targetAwbRisky+"." } };
    }


    if(awb && has(["track","open","status of","find","kahan","kaha"])){
      var pool=(typeof myParcels==="function")?myParcels():((typeof state!=="undefined"&&state.parcels)||[]);
      var p=pool.find(function(x){ return String(x.awb||"").toUpperCase()===String(awb).toUpperCase(); });
      if(!p) return { reply:"I couldn't find "+awb+" under this account. Please confirm the tracking ID." };
      return { reply:"Opening "+awb+" journey \u2014 currently "+p.status+".", actions:[{ label:"Open Journey", kind:"local", type:"open_awb", awb:awb }] };
    }

    if(has(["delayed parcel","problem parcel","issues today","show delayed","koi issue","masla hai","any issue"])){
      var issueCount=ctx?ctx.issueCount:0;
      if(issueCount>0) return { reply:"I found "+issueCount+" parcel(s) needing attention. Opening the first one.", actions:[{ label:"Review Issues", kind:"local", type:"nv_review_issues" }] };
      return { reply:"No delayed or problem parcels right now \u2014 everything looks on track.", actions:[{ label:"View Dashboard", kind:"local", type:"go_dashboard" }] };
    }

    if(has(["print label","print awb","print pending","reprint","label print","print kaise","print nahi ho raha"])){
      // NovaX fix (Autopilot AWB printing v1): a specific AWB in the message
      // always wins -- offer preview/print for that exact parcel. Only fall
      // back to the pending-labels summary when no AWB was mentioned, and
      // never blindly print everything from a generic "print" message.
      if(awb) return buildAwbPrintReply(awb);
      return buildPendingLabelsReply();
    }

    if(has(["book order","create booking","book parcel","new order","booking kaise","naya order"])){
      return { reply:"Opening New Booking for you.", actions:[{ label:"Start Booking", kind:"local", type:"go_booking" }] };
    }

    if(has(["paste order","paste whatsapp","whatsapp order"])){
      return { reply:"Opening Paste WhatsApp Order \u2014 paste the message and I'll fill the form.", actions:[{ label:"Paste Order", kind:"local", type:"paste_whatsapp_order" }] };
    }

    if(has(["bulk booking","bulk book"])){
      return { reply:"Opening Bulk Booking.", actions:[{ label:"Open Bulk Booking", kind:"local", type:"open_bulk_booking" }] };
    }

    if(has(["wallet kholo","open wallet","show wallet"])){
      return { reply:"Opening Wallet.", actions:[{ label:"Open Wallet", kind:"local", type:"go_wallet" }] };
    }

    if(has(["report dikhao","open report","show report","full report"])){
      return { reply:"Opening Full Report.", actions:[{ label:"Open Reports", kind:"local", type:"open_reports" }] };
    }

    if(has(["open payments","show payments","payments dikhao"])){
      return { reply:"Opening Payments.", actions:[{ label:"Open Payments", kind:"local", type:"open_payments" }] };
    }

    if(has(["copy customer message","copy message"])){
      if(!targetAwb) return { reply:"Which AWB's customer message should I copy? Please share the tracking ID.", actions:[{ label:"Open AWB Tab", kind:"local", type:"go_awb_label" }] };
      return { reply:"Copying the customer message for "+targetAwb+".", actions:[{ label:"Copy Message", kind:"local", type:"copy_customer_message", awb:targetAwb }] };
    }

    return null;
  }
  window.autopilotActionEngine=autopilotActionEngine;

  async function getAuthToken(){
    try{
      if(window.__nvSb && window.__nvSb.auth){
        var r=await window.__nvSb.auth.getSession();
        var tok=r && r.data && r.data.session && r.data.session.access_token;
        if(tok) return tok;
      }
    }catch(e){}
    return SB_KEY;
  }

  /* ===== Open-ended brain layer =====================================
     Called ONLY when the deterministic engine has no answer. It returns
     {reply:null,unavailable:true} whenever it is not deployed, has no API
     key, is rate limited, or errors — in every one of those cases this
     resolves to null and the caller carries on to the existing fallback.
     It can therefore only ever add an answer, never remove one. */
  var NV_BRAIN_HIST=[];
  async function tryBrain(text,token){
    try{
      var ctrl=new AbortController();
      var kill=setTimeout(function(){ ctrl.abort(); },25000);
      var res=await fetch(BRAIN_URL,{
        method:"POST",
        headers:{ "Content-Type":"application/json", "apikey":SB_KEY, "Authorization":"Bearer "+token },
        body:JSON.stringify({ message:text, history:NV_BRAIN_HIST.slice(-6) }),
        signal:ctrl.signal
      });
      clearTimeout(kill);
      if(!res.ok) return null;
      var out=null; try{ out=await res.json(); }catch(e){ return null; }
      if(!out || out.unavailable || !out.reply) return null;
      NV_BRAIN_HIST.push({ role:"user", content:text });
      NV_BRAIN_HIST.push({ role:"assistant", content:out.reply });
      if(NV_BRAIN_HIST.length>12) NV_BRAIN_HIST=NV_BRAIN_HIST.slice(-12);
      return out;
    }catch(e){
      return null;
    }
  }

  async function send(text){
    text=(text||"").trim();
    if(!text) return;
    addMsg(text,"u");
    if(input) input.value="";

    var lowerT=text.toLowerCase();
    if(pendingAutopilotConfirm){
      if(/^(yes|confirm|haan|theek hai|ok|okay)\b/.test(lowerT)){
        var pendingYes=pendingAutopilotConfirm; clearPendingAutopilotConfirm(); executeConfirmedAction(pendingYes); return;
      }
      if(/^(no|cancel|nahi)\b/.test(lowerT)){
        clearPendingAutopilotConfirm(); addMsg("Cancelled. Let me know if you need anything else.","b"); return;
      }
      clearPendingAutopilotConfirm();
    }

    var engineResult=null;
    try{ engineResult=autopilotActionEngine(text); }catch(e){ console.warn("NovaX Autopilot action engine failed",e); }
    if(engineResult && engineResult.reply){
      if(engineResult.needsConfirm && engineResult.confirmAction) setPendingAutopilotConfirm(engineResult.confirmAction);
      addMsg(engineResult.reply,"b",engineResult.actions);
      return;
    }

    var quickAwb=getAwbFromText(text);
    var quickLower=lowerT;
    var isQuickGreeting=text.length<40 && /(^|\s)(hi|hello|hey|salam|assalam|aoa|asalam|slam|help|start)(\s|$|[!.,])/i.test(quickLower);
    var isQuickCount=quickLower.indexOf("how many parcel")!==-1||quickLower.indexOf("kitne parcel")!==-1||quickLower.indexOf("kitny parcel")!==-1;
    var isQuickIssue=quickLower.indexOf("any issue")!==-1||quickLower.indexOf("koi issue")!==-1||quickLower.indexOf("issues today")!==-1;
    if(quickAwb || isQuickGreeting || isQuickCount || isQuickIssue){
      var quick=localAutopilotFallback(text);
      addMsg(quick.reply,"b",quick.actions);
      return;
    }

    var loadingEl=addMsg("Checking your account data...","b");
    loadingEl.classList.add("nvauto-loading");
    try{
      var token=await getAuthToken();
      var reqBody=JSON.stringify({ message:text, awb:getAwbFromText(text), portal:PORTAL });
      var reqHeaders={ "Content-Type":"application/json", "apikey":SB_KEY, "Authorization":"Bearer "+token };
      var res=await fetch(FN_URL,{ method:"POST", headers:reqHeaders, body:reqBody });
      /* Not deployed on this project -> fall back to what shipped before,
         so switching to the free engine can never take Autopilot down. */
      if(res.status===404 || res.status===501){
        console.warn("NovaX: novax-ai-support not deployed, falling back to novax-ai.");
        res=await fetch(FN_URL_FALLBACK,{ method:"POST", headers:reqHeaders, body:reqBody });
      }
      var out=null; try{ out=await res.json(); }catch(e){}

      /* The deterministic engine wins whenever it actually understood the
         question — it is free, instant and cannot invent a number. The brain
         is only consulted when that engine had nothing ("unknown"), or when
         the request itself failed. */
      /* The keyword engine claims an intent for anything containing "parcel",
         so "which Lahore parcels haven't moved in two days?" comes back as
         intent:"track" with "Share the AWB and I'll look it up" — an intent
         label, but not an answer. Treat that dodge as NOT answered so the
         brain gets a turn. Matched two ways (the needAwb flag and the reply
         text) so it works regardless of which build of novax-ai-support is
         deployed. */
      var engineDodged = !!out && (out.needAwb === true ||
        /share the awb|tracking number and i'?ll look/i.test(String(out.reply||"")));
      var engineAnswered = res.ok && out && out.reply && out.intent!=="unknown" && !engineDodged;
      if(!engineAnswered){
        var brain=await tryBrain(text,token);
        loadingEl.remove();
        if(brain && brain.reply){
          addMsg(brain.reply,"b",brain.actions);
          return;
        }
        /* Brain unavailable: fall back to precisely what shipped before. */
        if(out && out.reply){
          addMsg(out.reply,"b",out.actions);
          if(out.requireLogin) addMsg("Please log in again to continue, then ask me here.","b");
          return;
        }
        var fb1=localAutopilotFallback(text);
        addMsg(fb1.reply,"b",fb1.actions);
        return;
      }

      loadingEl.remove();
      addMsg(out.reply,"b",out.actions);
      if(out.requireLogin) addMsg("Please log in again to continue, then ask me here.","b");
    }catch(e){
      console.warn("NovaX Autopilot backend request failed",e);
      loadingEl.remove();
      var fb2=localAutopilotFallback(text);
      addMsg(fb2.reply,"b",fb2.actions);
    }
  }
  if(PORTAL==="client" && !localStorage.getItem(INTRO_KEY)){
    var __introTries=0, __introDone=false;
    var __stopIntro=function(){
      __introDone=true;
      if(window.nvClearInterval) window.nvClearInterval(__introTimer);
      else clearInterval(__introTimer);
    };
    var __introTimer=nvInterval(function(){
      /* Belt as well as braces. Even if this timer is somehow revived, or the
         merchant closed the panel in another tab, it must not reopen: a
         greeting that will not stay shut is worse than no greeting. */
      if(__introDone || localStorage.getItem(INTRO_KEY)){ __stopIntro(); return; }
      __introTries++;
      if(hasClientIdentity()){
        __stopIntro();
        setTimeout(function(){
          if(localStorage.getItem(INTRO_KEY)) return;
          /* Same queue as the review prompt: never open the intro on top of
             the pricing card. */
          var go = function(){
            if(localStorage.getItem(INTRO_KEY)) return;
            panel.classList.add("open"); openPanel();
          };
          if(typeof window.__nvWaitForGate === "function") window.__nvWaitForGate(go); else go();
        },900);
      } else if(__introTries>40){ __stopIntro(); }
    },500);
  }
})();

/* ==== client.html inline block #10 ==== */

(function(){
  if(window.__novaxCoachLoaded) return; window.__novaxCoachLoaded=true;
  var HIDE_KEY="novaxCoachHidden";
  var ACK_KEY="novaxCoachAck";

  var style=document.createElement("style");
  style.textContent='.nvcoach-bar{position:relative;width:100%;box-sizing:border-box;background:var(--nvu-good-bg);border:1px solid var(--nvu-good-ln);border-radius:var(--r-lg);box-shadow:none;padding:9px 12px;display:none;font-family:inherit;cursor:pointer;margin:0 0 14px}.nvcoach-bar.show{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.nvcoach-text{flex:1;min-width:0}.nvcoach-h{font-size:12.5px;font-weight:800;color:var(--nvu-accent);margin:0;display:inline}.nvcoach-a{font-size:12px;color:var(--nvu-ink-2);margin:0 0 0 6px;line-height:1.4;display:inline}.nvcoach-ctl{display:flex;gap:10px;flex-shrink:0}.nvcoach-ctl button{border:0;background:transparent;color:var(--nvu-accent);font-size:11px;font-weight:700;cursor:pointer;padding:0}.nvcoach-ctl button.muted{color:var(--nvu-ink-2)}';
  document.head.appendChild(style);

  var bar=document.createElement("div");
  bar.className="nvcoach-bar";
  bar.innerHTML='<div class="nvcoach-text"><span class="nvcoach-h" id="nvcoachH"></span><span class="nvcoach-a" id="nvcoachA"></span></div><div class="nvcoach-ctl"><button id="nvcoachGo" type="button">Got it</button><button class="muted" id="nvcoachHide" type="button">Hide tips</button></div>';
  // Mounted inline inside the active module (not appended to body) so it
  // reads as a thin helper strip built into the page, not a floating card.
  function mountInActiveModule(){
    try{
      var mod=document.querySelector(".client-module.active");
      if(mod && mod.firstChild!==bar) mod.insertBefore(bar,mod.firstChild);
    }catch(e){}
  }

  function cid(){ try{ return (state.client&&state.client.id)||null; }catch(e){ return null; } }
  function myParcels(){ try{ var id=cid(); return state.parcels.filter(function(p){ return p.clientId===id; }); }catch(e){ return []; } }
  function isDelayed(p){ try{ if(!p||p.status==="Delivered") return false; var hrs=Number.isFinite(Number(p.statusAgeHours))?Number(p.statusAgeHours):(p.statusSince?(Date.now()-new Date(p.statusSince).getTime())/3600000:NaN); return Number.isFinite(hrs)&&hrs>24; }catch(e){ return false; } }
  function bookingFormPercent(){
    var ids=["bookingName","bookingPhone","bookingPickupCity","bookingCity","bookingCod","bookingAddress"];
    var filled=0;
    ids.forEach(function(id){ var el=document.getElementById(id); if(el && String(el.value||"").trim()) filled++; });
    return Math.round(filled/ids.length*100);
  }
  function todayStr(){ return new Date().toISOString().slice(0,10); }
  function getAckMap(){ try{ return JSON.parse(localStorage.getItem(ACK_KEY)||"{}"); }catch(e){ return {}; } }
  function ackTip(key){ try{ var m=getAckMap(); m[key]=todayStr(); localStorage.setItem(ACK_KEY,JSON.stringify(m)); }catch(e){} }
  function isAcked(key){ return getAckMap()[key]===todayStr(); }

  function getTip(){
    var tab=(typeof state!=="undefined" && state.activeClientTab)||"dashboard";
    var mp=myParcels();
    var ctx=typeof getClientContext==="function"?getClientContext():null;
    var total=ctx?ctx.totalAllTime:mp.length;
    var delayed=ctx?ctx.delayedCount:mp.filter(isDelayed).length;
    var refused=ctx?ctx.refusedCount:mp.filter(function(p){ return p.status==="Refused"; }).length;
    var newBooked=mp.filter(function(p){ return p.status==="New booked"; }).length;
    var unprintedCount=ctx?ctx.unprintedCount:(typeof isUnprintedLabel==="function"?mp.filter(isUnprintedLabel).length:newBooked);
    var wallet=ctx?ctx.walletBalance:0; if(!ctx){ try{ wallet=Number((state.client&&state.client.walletBalance)||0); }catch(e){} }
    var ready=ctx?ctx.ready:(typeof isClientDataReady==="function"?isClientDataReady():false);

    if(tab==="dashboard"){
      if(total===0){
        if(!ready) return { h:"Loading your workspace...", a:"Hang tight while we sync your account.", key:"dash_loading", go:"dashboard" };
        return { h:"Start with your first booking.", a:"Tap New Booking and create your first AWB.", key:"dash_empty", go:"go_booking" };
      }
      if(delayed>0||refused>0) return { h:"Some parcels need attention.", a:delayed+" aging, "+refused+" refused \u2014 review them first.", key:"dash_attn_"+delayed+"_"+refused, go:"dashboard" };
      return { h:"Today's focus: check parcels needing attention.", a:"Tap any AWB to see full journey.", key:"dash_default", go:"dashboard" };
    }
    if(tab==="newBooking"){
      var pct=bookingFormPercent();
      if(total===0){
        if(!ready) return { h:"Loading your workspace...", a:"Hang tight while we sync your account.", key:"nb_loading", go:"newBooking" };
        if(pct===0) return { h:"Create your first parcel.", a:"Fill name, phone, city, COD, product and full address, or paste an order above to fill it for you.", key:"nb_first_0", go:"newBooking" };
        if(pct<100) return { h:"Almost there.", a:"Fill the remaining booking fields, then submit your first booking.", key:"nb_first_"+pct, go:"newBooking" };
        return { h:"Looks complete.", a:"Review the details, then submit your first booking.", key:"nb_first_100", go:"newBooking" };
      }
      if(total===1) return { h:"Booking your second parcel?", a:"Paste the WhatsApp order text above and I\u2019ll fill the form for you.", key:"nb_second_paste", go:"newBooking" };
      if(total===2) return { h:"Booking often?", a:"Bulk upload a CSV or connect your store so orders come in automatically.", key:"nb_third_bulk", go:"bulkBooking" };
      if(pct===0) return { h:"Create one clean AWB.", a:"Fill name, phone, city, COD, product and full address.", key:"nb_0", go:"newBooking" };
      if(pct<100) return { h:"Almost there.", a:"Fill the remaining booking fields, then submit.", key:"nb_"+pct, go:"newBooking" };
      return { h:"Looks complete.", a:"Review the details, then submit the booking.", key:"nb_100", go:"newBooking" };
    }
    if(tab==="awbLabel"){
      if(unprintedCount>0) return { h:"Print labels before pickup.", a:unprintedCount+" AWB label(s) are waiting.", key:"awb_"+unprintedCount, go:"awbLabel" };
      return { h:"Labels are clear.", a:"All AWBs are printed. Nothing waiting on this tab.", key:"awb_clear", go:"awbLabel" };
    }
    if(tab==="bulkBooking") return { h:"Upload many orders in one sheet.", a:"Download CSV format, fill it, then upload.", key:"bulk_default", go:"bulkBooking" };
    if(tab==="integrations") return { h:"Connect your store when ready.", a:"WooCommerce and custom API can send orders automatically.", key:"int_default", go:"integrations" };
    if(tab==="reports") return { h:"Find any parcel fast.", a:"Search by AWB, city, consignee or status.", key:"rep_default", go:"reports" };
    if(tab==="payments") return { h:"Delivered parcels become payable.", a:"Check your latest invoice.", key:"pay_default", go:"payments" };
    if(tab==="wallet"){
      if(wallet>0) return { h:"Cashout available.", a:"You can withdraw Rs "+Math.round(wallet)+".", key:"wal_"+Math.round(wallet), go:"wallet" };
      return { h:"Your payout area.", a:"Choose amount, payout speed and confirm IBAN.", key:"wal_default", go:"wallet" };
    }
    if(tab==="logs") return { h:"Every parcel has an audit trail.", a:"Review any order that looks wrong.", key:"logs_default", go:"logs" };
    if(tab==="subAccounts") return { h:"Give your team separate access.", a:"Invite finance, warehouse or support users.", key:"sub_default", go:"subAccounts" };
    if(tab==="support") return { h:"Ask in normal words.", a:"Try: \"mera parcel kahan hai?\" or \"COD kab milega?\"", key:"sup_default", go:"support" };
    return null;
  }

  function goToTip(tip){
    if(!tip) return;
    try{
      if(tip.go==="go_booking"||tip.go==="newBooking"){
        if(typeof showClientTab==="function") showClientTab("newBooking");
        setTimeout(function(){
          var ids=["bookingName","bookingPhone","bookingPickupCity","bookingCity","bookingCod","bookingAddress"];
          for(var i=0;i<ids.length;i++){ var el=document.getElementById(ids[i]); if(el&&!String(el.value||"").trim()){ el.focus(); break; } }
        },150);
        return;
      }
      if(tip.go==="wallet"){ if(typeof showClientTab==="function") showClientTab("wallet"); setTimeout(function(){ var el=document.getElementById("walletBalanceText"); if(el) el.scrollIntoView({behavior:"smooth",block:"center"}); },150); return; }
      if(tip.go==="awbLabel"){ if(typeof showClientTab==="function") showClientTab("awbLabel"); setTimeout(function(){ var el=document.getElementById("awbLabelPreview"); if(el) el.scrollIntoView({behavior:"smooth",block:"center"}); },150); return; }
      if(tip.go==="bulkBooking"){ if(typeof showClientTab==="function") showClientTab("bulkBooking"); setTimeout(function(){ var el=document.getElementById("bulkCsvInput"); if(el) el.scrollIntoView({behavior:"smooth",block:"center"}); },150); return; }
      if(tip.go==="support"){ if(window.novaxOpenAutopilot) window.novaxOpenAutopilot(); return; }
      if(typeof showClientTab==="function" && tip.go) showClientTab(tip.go);
    }catch(e){}
  }

  var lastTab=null;
  function renderCoach(){
    mountInActiveModule();
    if(localStorage.getItem(HIDE_KEY)==="1"){ bar.classList.remove("show"); return; }
    var tip=getTip();
    if(!tip || isAcked(tip.key)){ bar.classList.remove("show"); return; }
    var _h=bar.querySelector("#nvcoachH"), _a=bar.querySelector("#nvcoachA");
    if(_h) _h.textContent=tip.h;
    if(_a) _a.textContent=tip.a;
    bar.classList.add("show");
    bar.dataset.tipKey=tip.key;
  }

  bar.querySelector("#nvcoachGo").addEventListener("click",function(e){ e.stopPropagation(); var k=bar.dataset.tipKey; if(k) ackTip(k); bar.classList.remove("show"); });
  bar.querySelector("#nvcoachHide").addEventListener("click",function(e){ e.stopPropagation(); try{ localStorage.setItem(HIDE_KEY,"1"); }catch(e){} bar.classList.remove("show"); });
  bar.addEventListener("click",function(e){ if(e.target.closest("button")) return; goToTip(getTip()); });

  nvInterval(function(){
    try{
      var tab=(typeof state!=="undefined" && state.activeClientTab)||null;
      if(tab!==lastTab){ lastTab=tab; renderCoach(); }
      else renderCoach();
    }catch(e){}
  },3000);

  setTimeout(renderCoach,1200);
})();

/* ==== client.html inline block #11 ==== */

(function(){
  // NovaX fix (duplicate formatters): thin alias over the single shared
  // number formatter defined in the main app block. Same output as before.
  function fmtRs(v){ if(window.nvFormatNumber) return window.nvFormatNumber(v); try{ return Number(v||0).toLocaleString("en-US"); }catch(e){ return v; } }

  var FSTYLE_ID="nvfsStyle";
  function injectFirstBookingStyles(){
    if(document.getElementById(FSTYLE_ID)) return;
    var css=".nvfs-overlay{position:fixed;inset:0;z-index:999998;background:rgba(4,20,14,.55);display:flex;align-items:center;justify-content:center;padding:16px;animation:nvfsFade .2s ease}"
      +"@keyframes nvfsFade{from{opacity:0}to{opacity:1}}"
      +".nvfs-card{position:relative;background:var(--nvu-bg);border-radius:var(--r-2xl);max-width:420px;width:100%;padding:32px 26px 26px;text-align:center;box-shadow:var(--sh-1)}"
      +".nvfs-x{position:absolute;top:10px;right:12px;border:none;background:transparent;font-size:22px;line-height:1;color:#6b8f80;cursor:pointer}"
      +".nvfs-check{width:60px;height:60px;border-radius:50%;background:linear-gradient(145deg,var(--nvu-accent),#14c77b);color:#fff;font-size:28px;font-weight:900;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;box-shadow:var(--glow-1)}"
      +".nvfs-card h3{margin:0 0 8px;font-size:19px;color:var(--nvu-accent)}"
      +".nvfs-awb{font-weight:800;font-size:15px;color:#0f2e22;margin-bottom:10px;letter-spacing:.2px}"
      +".nvfs-card p{margin:0 0 16px;font-size:13px;color:#3a6b5a;line-height:1.5}"
      +".nvfs-journey{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px;margin-bottom:20px;font-size:10.5px}"
      +".nvfs-chip{background:#eafff5;border:1px solid #bfe8d7;color:#3a6b5a;border-radius:var(--r-pill);padding:4px 8px;font-weight:700;white-space:nowrap}"
      +".nvfs-chip.on{background:var(--nvu-accent);color:#fff;border-color:var(--nvu-accent)}"
      +".nvfs-arrow{color:#8fd8b9}"
      +".nvfs-actions{display:flex;gap:8px;flex-wrap:wrap}"
      +".nvfs-btn{flex:1;min-width:110px;border:none;border-radius:var(--r-lg);padding:11px 10px;font-size:12.5px;font-weight:700;cursor:pointer}"
      +".nvfs-btn.primary{background:var(--nvu-accent);color:#fff}"
      +".nvfs-btn.ghost{background:#eafff5;color:var(--nvu-accent);border:1px solid #bfe8d7}"
      +"@media(max-width:760px){.nvfs-overlay{align-items:flex-end;padding:0;}.nvfs-card{border-radius:var(--r-2xl) 16px 0 0;max-width:100%;width:100%;max-height:82vh;overflow:auto;-webkit-overflow-scrolling:touch;padding:22px 18px 18px;}.nvfs-actions{flex-direction:column;}}"
      +"@media(max-width:480px){.nvfs-btn{min-width:100%;}}";
    var st=document.createElement("style"); st.id=FSTYLE_ID; st.textContent=css; document.head.appendChild(st);
  }

  /* The delivery promise for THIS parcel's destination, so the first success
     screen states the same commitment the parcel list will. */
  function nvFsPromise(awb){
    try{
      if(typeof state!=="undefined" && state && state.parcels){
        var p=state.parcels.filter(function(x){return x&&x.awb===awb;})[0];
        if(p && typeof nvDeliveryPromise==="function") return nvDeliveryPromise(p.city).label.toLowerCase();
      }
    }catch(e){}
    return "in 3\u20134 days";
  }

  window.novaxShowFirstBookingSuccess=function(awb){
    try{
      injectFirstBookingStyles();
      if(document.getElementById("nvfsOverlay")) return;
      var stages=["Booked","Pickup Pending","In Transit","Out for Delivery","Delivered"];
      var chips=stages.map(function(s,i){
        return '<span class="nvfs-chip'+(i===0?' on':'')+'">'+s+'</span>'+(i<stages.length-1?'<span class="nvfs-arrow">\u2192</span>':'');
      }).join("");
      var ov=document.createElement("div");
      ov.id="nvfsOverlay"; ov.className="nvfs-overlay";
      ov.innerHTML='<div class="nvfs-card">'
        +'<button class="nvfs-x" id="nvfsClose" aria-label="Close">\u00d7</button>'
        +'<div class="nvfs-check">\u2713</div>'
        +'<h3>Your first AWB is ready.</h3>'
        +'<div class="nvfs-awb">Tracking ID: '+awb+'</div>'
        +'<p>Next: print this label and attach it to the parcel before pickup.</p>'
        /* The card told a first-time merchant what to do and showed the
           journey, but not the three things they actually ask next: when do
           you collect it, when does it arrive, and when do I get my money.
           Answered here rather than in a second card, so there is one success
           moment and not two competing ones. */
        +'<ul class="nvfs-facts">'
          +'<li><b>We collect it</b><span>Request a pickup from your dashboard and a rider comes to you.</span></li>'
          +'<li><b>Delivered '+nvFsPromise(awb)+'</b><span>Every step is visible on your dashboard as it happens.</span></li>'
          +'<li><b>COD reaches your wallet</b><span>Delivery charges netted off. Withdraw whenever you like.</span></li>'
        +'</ul>'
        +'<div class="nvfs-journey">'+chips+'</div>'
        +'<div class="nvfs-actions">'
        +'<button class="nvfs-btn primary" id="nvfsPrint">Print AWB</button>'
        +'<button class="nvfs-btn ghost" id="nvfsTrack">Track Journey</button>'
        +'<button class="nvfs-btn ghost" id="nvfsAgain">Book Another Parcel</button>'
        +'</div></div>';
      document.body.appendChild(ov);
      function close(){ var el=document.getElementById("nvfsOverlay"); if(el) el.remove(); }
      document.getElementById("nvfsClose").addEventListener("click",close);
      ov.addEventListener("click",function(e){ if(e.target===ov) close(); });
      document.getElementById("nvfsPrint").addEventListener("click",function(){ close(); if(typeof showClientTab==="function") showClientTab("awbLabel"); });
      document.getElementById("nvfsTrack").addEventListener("click",function(){ close(); if(typeof openClientParcelJourney==="function") openClientParcelJourney(awb); });
      document.getElementById("nvfsAgain").addEventListener("click",function(){
        close();
        if(typeof showClientTab==="function") showClientTab("newBooking");
        setTimeout(function(){ var el=document.getElementById("bookingName"); if(el) el.focus(); },150);
      });
    }catch(e){}
  };

  var PAYOUT_KEY="novaxFirstPayoutMoment";
  var DELIVERY_KEY="novaxFirstDeliveryMoment";
  var ISSUE_KEY="novaxFirstIssueRescueMoment";

  function myMomentParcels(){
    try{
      var cid=(typeof state!=="undefined"&&state.client&&state.client.id)||null;
      return ((typeof state!=="undefined"&&state.parcels)||[]).filter(function(p){ return p.clientId===cid; });
    }catch(e){ return []; }
  }

  function checkMoments(){
    try{
      if(typeof state==="undefined"||!state.client) return;

      if(localStorage.getItem(PAYOUT_KEY)!=="1"){
        var bal=(typeof walletBalance==="function")?walletBalance(state.client.id):Number(state.client.walletBalance||0);
        if(bal>0){
          localStorage.setItem(PAYOUT_KEY,"1");
          if(window.novaxAutopilotSay) window.novaxAutopilotSay("Rs "+fmtRs(bal)+" is ready. Want to withdraw?",[
            { label:"Go to Wallet", kind:"local", type:"go_wallet" }
          ]);
        }
      }

      var parcels=myMomentParcels();
      if(localStorage.getItem(DELIVERY_KEY)!=="1"){
        var delivered=parcels.find(function(p){ return p.status==="Delivered" || (p.steps&&p.steps.indexOf("Delivered")>-1); });
        if(delivered){
          localStorage.setItem(DELIVERY_KEY,"1");
          // NovaX fix: "COD is now moving toward wallet" implied the money was
          // already headed to the wallet, but COD only reaches the wallet
          // after admin generates an invoice and pushes it -- neither has
          // happened yet at the moment of delivery. State the real next step
          // instead of implying wallet movement that hasn't started.
          if(window.novaxAutopilotSay) window.novaxAutopilotSay("Your first delivery is complete. Once admin generates and pushes the invoice, this COD will land in your wallet.",[
            { label:"Go to Wallet", kind:"local", type:"go_wallet" }
          ]);
        }
      }

      if(localStorage.getItem(ISSUE_KEY)!=="1"){
        var troubled=parcels.find(function(p){ return p.status==="Refused" || (typeof isDelayed==="function"&&isDelayed(p)); });
        if(troubled){
          localStorage.setItem(ISSUE_KEY,"1");
          if(window.novaxAutopilotSay) window.novaxAutopilotSay("I found an issue before it becomes a complaint \u2014 "+troubled.awb+" needs a look.");
        }
      }
    }catch(e){}
  }

  nvInterval(checkMoments,4000);
  setTimeout(checkMoments,3000);
})();

/* ==== client.html inline block #12 ==== */

(function(){
  if(window.__novaxMobileBookBarLoaded) return; window.__novaxMobileBookBarLoaded=true;
  var style=document.createElement("style");
  style.textContent='.nv-mobile-book-bar{position:fixed;left:0;right:0;bottom:0;z-index:var(--z-bottombar);display:none;background:var(--nvu-bg);border-top:1px solid #d7ede1;padding:10px 12px calc(10px + env(safe-area-inset-bottom));box-shadow:var(--sh-1);box-sizing:border-box}.nv-mobile-book-bar.show{display:block}.nv-mobile-book-risk{font-size:12px;font-weight:700;color:#a15c00;background:var(--nvu-warn-bg);border:1px solid #f0d6a0;border-radius:var(--r-md);padding:6px 9px;margin-bottom:8px}.nv-mobile-book-bar button{width:100%;min-height:46px;border-radius:var(--r-lg);background:var(--nvu-accent);color:#fff;font-weight:800;font-size:14px;border:0}.nv-mobile-book-bar button[disabled]{opacity:.65}@media (min-width:761px){.nv-mobile-book-bar{display:none!important}}';
  document.head.appendChild(style);

  var bar=document.createElement("div");
  bar.className="nv-mobile-book-bar";
  bar.id="nvMobileBookBar";
  bar.innerHTML='<div class="nv-mobile-book-risk" id="nvMobileRiskMirror" style="display:none"></div><button type="button" id="nvStickyBookBtn">Create Booking</button>';
  document.body.appendChild(bar);

  function realBtn(){ return document.getElementById("quickBookingBtn"); }
  function syncButton(){
    try{
      var real=realBtn(); var sticky=document.getElementById("nvStickyBookBtn");
      if(!real||!sticky) return;
      var pct=(typeof bookingFormPercent==="function")?bookingFormPercent():null;
      var pasteEl=document.getElementById("nvPasteInput");
      var pasteHasContent=!!(pasteEl && pasteEl.value && pasteEl.value.trim().length>0);
      if(pct===0 && pasteHasContent){
        sticky.textContent="Fill from pasted order";
        sticky.disabled=false;
        sticky.dataset.nvMode="paste";
        return;
      }
      if(pct===0){
        sticky.textContent="Fill booking details first";
        sticky.disabled=true;
        sticky.dataset.nvMode="empty";
        return;
      }
      sticky.dataset.nvMode="";
      sticky.textContent=real.textContent||"Create Booking";
      sticky.disabled=!!real.disabled;
    }catch(e){}
  }
  function syncRisk(){
    try{
      var real=document.getElementById("nvRiskWarning"); var mirror=document.getElementById("nvMobileRiskMirror");
      if(!real||!mirror) return;
      var visible=real.style.display!=="none" && real.textContent.trim().length>0;
      mirror.style.display=visible?"":"none";
      mirror.textContent=real.textContent;
    }catch(e){}
  }
  function anyBlockingOverlayOpen(){
    try{
      if(document.querySelector(".nvauto-panel.open")) return true;
      if(document.querySelector(".modal-overlay.show")) return true;
      if(document.getElementById("nvfsOverlay")) return true;
      return false;
    }catch(e){ return false; }
  }
  function refreshVisibility(){
    try{
      var isMobile=window.innerWidth<=760;
      var onBooking=(typeof state!=="undefined") && state.activeClientTab==="newBooking";
      var blocked=anyBlockingOverlayOpen();
      var visible=!!(isMobile && onBooking && !blocked);
      bar.classList.toggle("show", visible);
      /* The in-page Create Booking button and this sticky bar say the same
         thing 113px apart on a phone. Mark the body so CSS can hide the
         in-page one -- but only while this bar is actually showing, so a
         failure to mount it can never leave the merchant with no button. */
      try{ document.body.classList.toggle("nv-has-book-bar", visible); }catch(e){}
      var bookingPanel=document.getElementById("client-newBooking");
      if(bookingPanel) bookingPanel.classList.toggle("nv-sticky-pad", visible);
      if(isMobile && onBooking){ syncButton(); syncRisk(); }
    }catch(e){}
  }
  bar.querySelector("#nvStickyBookBtn").addEventListener("click",function(){
    var sticky=document.getElementById("nvStickyBookBtn");
    if(sticky && sticky.dataset.nvMode==="paste"){
      if(typeof applyPastedOrder==="function") applyPastedOrder();
      var pasteEl=document.getElementById("nvPasteInput"); if(pasteEl) pasteEl.scrollIntoView({behavior:"smooth",block:"center"});
      return;
    }
    var real=realBtn(); if(real && !real.disabled) real.click();
  });
  document.addEventListener("input",function(e){
    try{
      if(!e.target) return;
      if(e.target.id==="nvPasteInput" || (e.target.closest && e.target.closest("#client-newBooking"))) syncButton();
    }catch(e){}
  });

  var moBtn=new MutationObserver(syncButton);
  var moRisk=new MutationObserver(syncRisk);
  function attachObservers(){
    try{
      var real=realBtn(); if(real) moBtn.observe(real,{attributes:true,attributeFilter:["disabled"],childList:true,subtree:true,characterData:true});
      var risk=document.getElementById("nvRiskWarning"); if(risk) moRisk.observe(risk,{attributes:true,attributeFilter:["style"],childList:true,subtree:true,characterData:true});
    }catch(e){}
  }
  attachObservers();

  try{
    var modParent=document.querySelector(".client-content");
    if(modParent){ new MutationObserver(refreshVisibility).observe(modParent,{attributes:true,attributeFilter:["class"],subtree:true}); }
  }catch(e){}
  try{
    var nvAutoPanelEl=document.querySelector(".nvauto-panel");
    if(nvAutoPanelEl){ new MutationObserver(refreshVisibility).observe(nvAutoPanelEl,{attributes:true,attributeFilter:["class"]}); }
  }catch(e){}
  try{
    document.querySelectorAll(".modal-overlay").forEach(function(m){ new MutationObserver(refreshVisibility).observe(m,{attributes:true,attributeFilter:["class"]}); });
  }catch(e){}
  try{
    new MutationObserver(refreshVisibility).observe(document.body,{childList:true});
  }catch(e){}
  window.addEventListener("resize",refreshVisibility);
  setTimeout(refreshVisibility,300);
  setTimeout(refreshVisibility,1200);
  refreshVisibility();
})();

/* ==== client.html inline block #13 ==== */

(function(){
  function nvCloseMobileMenuByDefault(){
    try{
      if(window.innerWidth<=760){
        var m=document.getElementById("clientMenu");
        var t=document.getElementById("clientMenuToggle");
        if(m && m.classList.contains("open")) m.classList.remove("open");
        if(t) t.setAttribute("aria-expanded","false");
      }
    }catch(e){}
  }
  nvCloseMobileMenuByDefault();
  document.addEventListener("DOMContentLoaded",nvCloseMobileMenuByDefault);
  window.addEventListener("resize",nvCloseMobileMenuByDefault);
})();

/* ==== client.html inline block #14 ==== */

/* ================= NovaX PHASE 4 (Tasks 20-22) =================
   Autopilot upgrades: proactive operational interventions, transactional
   actions routed through the EXISTING confirm framework, and Roman Urdu
   detection + a persisting language toggle.
   FORBIDDEN BY SPEC AND NOT PRESENT HERE: no withdrawal, payout, bank-detail
   or invoice action is ever wired to Autopilot. Money questions are only
   explained and deep-linked to the Wallet / Payments tab. */
(function nvPhase4(){
  if(window.__novaxPhase4Loaded) return; window.__novaxPhase4Loaded=true;
  var DISMISS_KEY="novaxAutopilotDismissedV1";
  var LANG_KEY="novaxAutopilotLangV1";
  var MAX_PER_SESSION=3;
  var shown=0;
  function safe(fn){ try{ return fn(); }catch(e){ return undefined; } }
  function dismissed(){ try{ return JSON.parse(localStorage.getItem(DISMISS_KEY)||"[]"); }catch(e){ return []; } }
  function dismiss(id){ try{ var d=dismissed(); if(d.indexOf(id)<0){ d.push(id); localStorage.setItem(DISMISS_KEY,JSON.stringify(d.slice(-200))); } }catch(e){} }

  /* ---------- Task 22: Roman Urdu detection + persisting toggle ---------- */
  var RU=/(\bkya\b|\bkyu\b|\bkahan\b|\bkab\b|\bkitna\b|\bkitne\b|\bmera\b|\bmeri\b|\bmujhe\b|\bnahi\b|\bnahin\b|\bhai\b|\bhain\b|\bkaro\b|\bkardo\b|\bkarna\b|\bbhej\b|\bbhejo\b|\bwapis\b|\bpaisay\b|\bpaise\b|\bparcel kahan\b|\baap\b|\bapna\b|\bthek\b|\bacha\b|\bkyun\b|\bdobara\b|\bjaldi\b)/i;
  function detectRomanUrdu(t){ return RU.test(String(t||"")); }
  function lang(){ try{ return localStorage.getItem(LANG_KEY)||"auto"; }catch(e){ return "auto"; } }
  function setLang(v){ try{ localStorage.setItem(LANG_KEY,v); }catch(e){} }
  function wantUrdu(text){
    var l=lang();
    if(l==="ur") return true;
    if(l==="en") return false;
    return detectRomanUrdu(text);
  }
  window.novaxDetectRomanUrdu=detectRomanUrdu;
  window.novaxAutopilotLanguage=function(v){ if(v) setLang(v); return lang(); };

  /* Language instruction is attached to the outgoing AI request only. AWB
     numbers, amounts and status names must be echoed verbatim. */
  var origFetch=window.fetch;
  if(typeof origFetch==="function" && !window.__novaxLangFetchWrapped){
    window.__novaxLangFetchWrapped=true;
    window.fetch=function(input,init){
      try{
        var url=typeof input==="string"?input:(input&&input.url)||"";
        /* Matched only "novax-ai-support", which is not deployed on this
           project, so this never fired and the Roman-Urdu/English toggle did
           nothing at all. Match any NovaX AI endpoint instead. novax-ai does
           not read a `language` field, so the instruction is also appended to
           the message itself -- that reaches the model whichever backend
           answers, and is ignored harmlessly by one that handles the field. */
        if(/\/functions\/v1\/novax-ai/.test(url) && init && typeof init.body==="string"){
          var body=JSON.parse(init.body);
          var msg=body.message||body.question||body.text||"";
          var useUrdu=wantUrdu(msg);
          body.language=useUrdu?"roman-urdu":"english";
          body.languageInstruction=useUrdu
            ? "Reply in Roman Urdu (Urdu written in Latin script), simple and friendly. Keep AWB numbers, amounts, currency values and NovaX status names exactly as they are, in English."
            : "Reply in English.";
          if(useUrdu && typeof body.message==="string" && body.message.trim()){
            body.message = body.message +
              "\n\n(Reply in Roman Urdu \u2014 Urdu written in Latin script. Keep AWB numbers, amounts and NovaX status names exactly as they are, in English.)";
          }
          init=Object.assign({},init,{ body:JSON.stringify(body) });
        }
      }catch(e){}
      return origFetch.call(this,input,init);
    };
  }

  function injectToggle(){
    var head=document.querySelector(".nvauto-head");
    if(!head||document.getElementById("nvLangToggle")) return;
    var btn=document.createElement("button");
    btn.type="button"; btn.id="nvLangToggle";
    btn.style.cssText="margin-left:auto;margin-right:6px;background:rgba(255,255,255,.18);color:#fff;border:0;height:28px;padding:0 10px;border-radius:var(--r-md);font-size:11px;font-weight:800;cursor:pointer";
    function label(){
      var l=lang();
      btn.textContent=l==="ur"?"Roman Urdu":l==="en"?"English":"Auto";
      btn.title="Reply language: "+btn.textContent+" (click to change)";
    }
    btn.addEventListener("click",function(e){
      e.stopPropagation();
      var order=["auto","en","ur"], l=lang();
      setLang(order[(order.indexOf(l)+1)%order.length]);
      label();
    });
    label();
    var x=head.querySelector(".nvauto-x");
    if(x) head.insertBefore(btn,x); else head.appendChild(btn);
  }

  /* ---------- Task 20 + 21: proactive interventions ---------- */
  function ctx(){
    var c=safe(function(){ return window.__novaxTodayContext?window.__novaxTodayContext():null; });
    if(c) return c;
    return safe(function(){ return window.getClientContext?window.getClientContext():null; })||{};
  }
  function t(en,ur){ return wantUrdu("")&&lang()==="ur"?ur:en; }
  function buildInterventions(){
    var c=ctx(), out=[];
    var stuck=(c.stuck||[]).slice(0,3);
    if(stuck.length){
      var a=stuck[0];
      out.push({
        id:"stuck|"+stuck.map(function(p){ return p.awb; }).join(","),
        text:t(stuck.length+" parcel(s) have not changed status in over 48 hours, starting with "+a.awb+" ("+(a.status||"")+", "+(a.city||"")+"). Do you want me to open it or ask the hub for a re-attempt?",
              stuck.length+" parcel 48 ghante se aage nahi barhay, pehla "+a.awb+" ("+(a.status||"")+", "+(a.city||"")+"). Journey kholun ya re-attempt request karun?"),
        actions:[
          { label:t("Open "+a.awb,a.awb+" kholein"), kind:"local", type:"show_journey_awb", awb:a.awb },
          { label:t("Request re-attempt","Re-attempt request"), kind:"local", type:"confirm_action", awb:a.awb },
          { label:t("Review all issues","Sab issues dekhein"), kind:"local", type:"nv_review_issues" }
        ]
      });
    }
    var needs=(c.needsMe||[]).slice(0,3);
    if(needs.length){
      var n=needs[0];
      out.push({
        id:"needs|"+needs.map(function(p){ return p.awb+":"+p.status; }).join(","),
        text:t(needs.length+" parcel(s) need a decision from you. "+n.awb+" is marked \u201c"+(n.status||"")+"\u201d. I can request a re-attempt or open the journey so you can see the rider proof.",
              needs.length+" parcel par aap ka faisla chahiye. "+n.awb+" ka status \u201c"+(n.status||"")+"\u201d hai. Re-attempt request karun ya journey kholun?"),
        actions:[
          { label:t("Request re-attempt","Re-attempt request"), kind:"local", type:"confirm_action", awb:n.awb },
          { label:t("Open journey","Journey kholein"), kind:"local", type:"show_journey_awb", awb:n.awb }
        ]
      });
    }
    var miss=(c.missingAddress||[]).slice(0,3);
    if(miss.length){
      out.push({
        id:"addr|"+miss.map(function(p){ return p.awb; }).join(","),
        text:t(miss.length+" parcel(s) are missing a house number or phone, starting with "+miss[0].awb+". Riders usually fail these on the first attempt \u2014 want to open it and fix the address now?",
              miss.length+" parcel mein ghar ka number ya phone missing hai, pehla "+miss[0].awb+". Aise parcel pehli koshish mein fail hotay hain \u2014 abhi address theek karein?"),
        actions:[
          { label:t("Open "+miss[0].awb,miss[0].awb+" kholein"), kind:"local", type:"show_journey_awb", awb:miss[0].awb },
          { label:t("Review all issues","Sab issues dekhein"), kind:"local", type:"nv_review_issues" }
        ]
      });
    }
    var ofd=(c.outForDelivery||[]).slice(0,5);
    if(ofd.length){
      out.push({
        id:"ofd|"+ofd.length+"|"+new Date().toISOString().slice(0,10),
        text:t(ofd.length+" parcel(s) are out for delivery today. A short WhatsApp heads-up to those customers cuts refusals \u2014 I can prepare the messages for you to send.",
              ofd.length+" parcel aaj out for delivery hain. Customers ko WhatsApp par bata dena refusals kam karta hai \u2014 messages tayar kar dun?"),
        actions:[
          { label:t("Prepare messages","Messages tayar karein"), kind:"local", type:"go_dashboard" },
          { label:t("Open "+ofd[0].awb,ofd[0].awb+" kholein"), kind:"local", type:"show_journey_awb", awb:ofd[0].awb }
        ]
      });
    }
    var nb=(c.newBooked||[]);
    if(nb.length){
      out.push({
        id:"labels|"+nb.length+"|"+new Date().toISOString().slice(0,10),
        text:t(nb.length+" newly booked parcel(s) still need printed labels before pickup.",
              nb.length+" naye booked parcel ke labels pickup se pehle print karne hain."),
        actions:[ { label:t("Open AWB labels","AWB labels kholein"), kind:"local", type:"go_awb_label" } ]
      });
    }
    var d=dismissed();
    return out.filter(function(i){ return d.indexOf(i.id)<0; });
  }

  function surface(){
    if(shown>=MAX_PER_SESSION) return;
    if(typeof window.novaxAutopilotSay!=="function") return;
    var list=buildInterventions();
    for(var i=0;i<list.length && shown<MAX_PER_SESSION;i++){
      var it=list[i];
      var acts=it.actions.concat([{ label:t("Not now","Abhi nahi"), kind:"local", type:"nv_dismiss_intervention", id:it.id }]);
      window.novaxAutopilotSay(it.text,acts);
      dismiss(it.id);
      shown++;
    }
  }

  /* "Not now" is handled here because the intervention ids are owned by this
     module; every other action re-uses the existing handleAction types. */
  document.addEventListener("click",function(e){
    var b=e.target.closest?e.target.closest(".nvauto-action-btn"):null;
    if(!b) return;
    if(/^(Not now|Abhi nahi)$/.test(b.textContent||"")){
      var msg=b.closest(".nvauto-m");
      if(msg){ var acts=msg.querySelector(".nvauto-actions"); if(acts) acts.remove(); }
    }
  });

  var lastOpen=false;
  nvInterval(function(){
    injectToggle();
    var panel=document.querySelector(".nvauto-panel");
    var open=!!(panel&&panel.classList.contains("open"));
    if(open&&!lastOpen) setTimeout(surface,900);
    lastOpen=open;
  },1200);

  window.__novaxPhase4={ interventions:buildInterventions, surface:surface, detectRomanUrdu:detectRomanUrdu, language:window.novaxAutopilotLanguage };
})();

/* ==== client.html inline block #15 ==== */

/* ===================================================================
   NovaX global error capture

   WHY THIS EXISTS
   log_portal_error(), the portal_error_logs table and the admin Error
   Monitor were all built already -- but nothing global ever called them.
   logClientError() had 3 call sites, logRiderError() 1, admin 0. They only
   caught errors somebody remembered to wrap, so the three crashes found in
   production on 7 Aug (renderWallets walletTopup, renderClientModules
   walletTopup, the coach-bar addEventListener) produced ZERO rows. All three
   were uncaught TypeErrors.

   This hooks the two events that catch everything the browser throws:
     window "error"              -- uncaught exceptions
     window "unhandledrejection" -- promise rejections nobody caught

   THREE DELIBERATE LIMITS, so this can never become the problem it reports:
     1. DEDUPE by message+line. A crash inside render() fires on every tick;
        without this it would write thousands of rows and recreate the
        database-load incident.
     2. HARD CAP of 40 rows per page load. Nothing pathological gets through.
     3. BUFFERED until Supabase is ready. Installed before the data layer
        exists, so boot-time crashes -- historically the worst ones, e.g. the
        structuredClone blank-portal bug -- are captured too, then flushed
        once a client appears. Gives up after ~40s rather than growing.

   Fully self-contained. Touches no existing function. If any part of it
   throws, the catch blocks swallow it: error logging must never be the thing
   that breaks the page.
   =================================================================== */
(function nvGlobalErrorCapture(){
  if (window.__nvGecLoaded) return;
  window.__nvGecLoaded = true;

  var SOURCE   = "client";
  var SEVERITY = "error";      // portal_error_logs severity value
  var MAX      = 40;           // per page load
  var seen = Object.create(null), sent = 0, queue = [], tries = 0, timer = null;

  function sb(){
    try { return window.__nvSb || window.__nvGuardSb || null; } catch(e){ return null; }
  }

  function page(){
    try {
      var t = (typeof state !== "undefined" && state && state.activeClientTab) ||
              (typeof state !== "undefined" && state && state.activeAdminTab)  || "";
      return (location.pathname + (t ? ":" + t : "")).slice(0, 120);
    } catch(e){ return location.pathname.slice(0, 120); }
  }

  /* p_message is stored at 300 chars in this schema, so order matters:
     message first, then file:line, then whatever stack still fits. */
  function compose(msg, src, line, col, err){
    var out = String(msg == null ? "unknown error" : msg);
    if (src) out += " @" + String(src).split("/").pop() + ":" + line + ":" + col;
    try {
      if (err && err.stack) {
        var st = String(err.stack).split("\n").slice(1, 4).join(" | ").replace(/\s+/g, " ");
        out += " || " + st;
      }
    } catch(e){}
    return out.slice(0, 300);
  }

  function flush(){
    var s = sb();
    if (!s || !s.rpc) return;
    while (queue.length) {
      var row = queue.shift();
      try {
        // Fire and forget. rpc() is a thenable without .catch(), so the
        // rejection handler goes in .then()'s second argument -- chaining
        // .catch() directly is the trap that once broke invoicing.
        s.rpc("log_portal_error", row).then(function(){}, function(){});
      } catch(e){}
    }
  }

  function pump(){
    if (timer) return;
    timer = nvInterval(function(){
      tries++;
      if (sb()) { flush(); clearInterval(timer); timer = null; return; }
      if (tries > 20) { clearInterval(timer); timer = null; queue.length = 0; }  // ~40s, then stop
    }, 2000);
  }

  function report(kind, msg, src, line, col, err){
    try {
      var key = kind + "|" + String(msg).slice(0, 120) + "|" + line;
      if (seen[key] || sent >= MAX) return;
      seen[key] = 1; sent++;
      var row = {
        p_source: SOURCE,
        p_rpc_name: null,
        p_page: page(),
        p_message: compose(msg, src, line, col, err),
        p_severity: SEVERITY
      };
      if (sb()) { queue.push(row); flush(); }
      else { queue.push(row); pump(); }
    } catch(e){}
  }

  window.addEventListener("error", function(e){
    try {
      // Resource load failures (img/script 404) surface here too, with no
      // message. They are noise for this purpose -- the Network tab owns them.
      if (e && e.target && e.target !== window && e.target.tagName) return;
      report("error", e && e.message, e && e.filename, e && e.lineno, e && e.colno, e && e.error);
    } catch(x){}
  }, true);

  window.addEventListener("unhandledrejection", function(e){
    try {
      var r = e && e.reason;
      report("promise", (r && (r.message || r)) || "unhandled promise rejection", "", 0, 0, r);
    } catch(x){}
  });

  // Manual escape hatch, e.g. from a catch block: window.nvLogError("msg")
  window.nvLogError = function(m, rpcName){
    try {
      var row = { p_source: SOURCE, p_rpc_name: rpcName || null, p_page: page(),
                  p_message: String(m == null ? "" : m).slice(0, 300), p_severity: "warning" };
      if (sb()) { queue.push(row); flush(); } else { queue.push(row); pump(); }
    } catch(e){}
  };
})();

/* ==== client.html inline block #16 ==== */

/* NovaX Command Palette wiring (client portal).
   INLINED on purpose -- see the nv-codegen note above: an external
   "nv-cmdk.js" would 404 in production exactly the way nv-codegen did, and
   this would silently disappear. */
/* ============================================================================
   NovaX — Command Palette (⌘K / Ctrl+K)

   Shared by client.html and admin.html, following the nv-codegen.js pattern:
   one file, no dependencies, no build step, no network.

   DESIGN RULES (this is a live operations portal, not a demo):
     1. ADDITIVE ONLY. This module never modifies existing DOM, never
        re-renders anything, and never writes to state. It reads whatever the
        host page hands it and calls back into the host's own navigation
        functions. If it throws, it throws inside its own try/catch and the
        portal is exactly as it was.
     2. NO DATA OF ITS OWN. Every row comes from the page's live state via the
        provider function, so it can never show a stale or invented parcel.
     3. ESCAPED. Everything rendered here is merchant/consignee-controlled
        text (AWBs, names, cities), so all of it goes through esc().

   USAGE — the host page calls:
     window.NovaXCmdK.init({
       accent: "var(--nvu-accent)",
       sources: function(q){ return [ {group, icon, title, subtitle, run}, ... ] }
     });
   `sources` is called on every keystroke with the lowercased query and must
   return an array of already-filtered items. Keeping the filtering in the host
   means each portal can scope to exactly what that user is allowed to see.
   ========================================================================== */
(function () {
  if (window.NovaXCmdK) return;

  var MAX = 40;                 // hard cap on rendered rows
  var cfg = null, host = null, input = null, list = null;
  var items = [], active = 0, open = false, lastFocus = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function css(accent) {
    return '' +
    '#nvck{position:fixed;inset:0;z-index:100000;display:none;justify-content:center;align-items:flex-start;' +
      'padding:12vh 16px 16px;background:rgba(8,20,16,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}' +
    '#nvck.on{display:flex;}' +
    '#nvck .nvck-box{width:min(640px,100%);background:var(--nvu-bg);border-radius:var(--r-2xl);overflow:hidden;' +
      'box-shadow:var(--sh-1);display:flex;flex-direction:column;max-height:70vh;' +
      'animation:nvckIn .16s ease both;}' +
    '@keyframes nvckIn{from{opacity:0;transform:translateY(-8px) scale(.99)}to{opacity:1;transform:none}}' +
    '#nvck .nvck-top{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--nvu-line);}' +
    '#nvck .nvck-mag{color:' + accent + ';flex:0 0 auto;display:flex;align-items:center;}' +
    '#nvck input{flex:1;border:0;outline:0;font-size:16px;font-weight:600;color:var(--nvu-ink);background:transparent;min-width:0;}' +
    '#nvck input::placeholder{color:#93a8a0;font-weight:500;}' +
    '#nvck .nvck-esc{font-size:10px;font-weight:800;letter-spacing:.06em;color:#7c8b86;border:1px solid var(--nvu-line-2);' +
      'border-radius:var(--r-sm);padding:3px 7px;flex:0 0 auto;}' +
    '#nvck .nvck-list{overflow-y:auto;padding:6px;}' +
    '#nvck .nvck-group{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--nvu-ink-3);' +
      'padding:10px 10px 5px;}' +
    '#nvck .nvck-row{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:var(--r-lg);cursor:pointer;}' +
    '#nvck .nvck-row[aria-selected="true"]{background:#eafff5;}' +
    '#nvck .nvck-ic{width:26px;height:26px;border-radius:var(--r-md);display:grid;place-items:center;font-size:13px;' +
      'background:var(--nvu-neutral-bg);flex:0 0 auto;}' +
    '#nvck .nvck-tx{min-width:0;flex:1;}' +
    '#nvck .nvck-t{display:block;font-size:13.5px;font-weight:750;color:var(--nvu-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#nvck .nvck-s{display:block;font-size:11.5px;color:#6b7d74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}' +
    '#nvck .nvck-go{font-size:10px;color:#9fb3ab;flex:0 0 auto;}' +
    '#nvck .nvck-empty{padding:26px 16px;text-align:center;color:#6b7d74;font-size:13px;}' +
    '#nvck .nvck-foot{display:flex;gap:14px;padding:9px 14px;border-top:1px solid var(--nvu-line);background:var(--nvu-bg-2);' +
      'font-size:10.5px;color:#7c8b86;flex-wrap:wrap;}' +
    '#nvck .nvck-foot b{color:var(--nvu-neutral-fg);font-weight:800;}' +
    '@media (max-width:560px){#nvck{padding:8vh 10px 10px;} #nvck .nvck-box{max-height:78vh;}}' +
    '@media (prefers-reduced-motion: reduce){#nvck .nvck-box{animation:none;}}';
  }

  function build(accent) {
    var st = document.createElement("style");
    st.id = "nvckCss";
    st.textContent = css(accent);
    document.head.appendChild(st);

    host = document.createElement("div");
    host.id = "nvck";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-label", "NovaX command palette");
    host.innerHTML =
      '<div class="nvck-box">' +
        '<div class="nvck-top">' +
          '<span class="nvck-mag" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 L14 14" stroke-linecap="round"/></svg></span>' +
          '<input type="text" autocomplete="off" spellcheck="false" placeholder="Search NovaX — AWB, client, rider, invoice, or a command…">' +
          '<span class="nvck-esc">ESC</span>' +
        '</div>' +
        '<div class="nvck-list"></div>' +
        '<div class="nvck-foot"><span><b>&uarr;&darr;</b> move</span><span><b>&crarr;</b> open</span>' +
          '<span><b>esc</b> close</span><span style="margin-left:auto"><b>&#8984;K</b> anytime</span></div>' +
      '</div>';
    document.body.appendChild(host);

    input = host.querySelector("input");
    list = host.querySelector(".nvck-list");

    host.addEventListener("mousedown", function (e) { if (e.target === host) close(); });
    input.addEventListener("input", function () { refresh(input.value); });
    input.addEventListener("keydown", onKey);
    list.addEventListener("mousedown", function (e) {
      var row = e.target.closest ? e.target.closest(".nvck-row") : null;
      if (!row) return;
      e.preventDefault();
      run(Number(row.getAttribute("data-i")));
    });
  }

  function refresh(q) {
    var query = String(q || "").trim().toLowerCase();
    try { items = (cfg.sources(query) || []).slice(0, MAX); }
    catch (e) { items = []; }
    active = 0;
    render();
  }

  function render() {
    if (!items.length) {
      list.innerHTML = '<div class="nvck-empty">No matches. Try an AWB, a client name, a city, or a command.</div>';
      return;
    }
    var html = "", lastGroup = null;
    items.forEach(function (it, i) {
      if (it.group !== lastGroup) {
        html += '<div class="nvck-group">' + esc(it.group || "Results") + "</div>";
        lastGroup = it.group;
      }
      html +=
        '<div class="nvck-row" data-i="' + i + '" aria-selected="' + (i === active) + '">' +
          '<span class="nvck-ic">' + esc(it.icon || "•") + "</span>" +
          '<span class="nvck-tx">' +
            '<span class="nvck-t">' + esc(it.title) + "</span>" +
            (it.subtitle ? '<span class="nvck-s">' + esc(it.subtitle) + "</span>" : "") +
          "</span>" +
          '<span class="nvck-go">&crarr;</span>' +
        "</div>";
    });
    list.innerHTML = html;
    var sel = list.querySelector('[aria-selected="true"]');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
  }

  function move(d) {
    if (!items.length) return;
    active = (active + d + items.length) % items.length;
    render();
  }

  function run(i) {
    var it = items[i];
    if (!it) return;
    close();
    // Defer so the overlay is gone before the host re-renders/navigates.
    setTimeout(function () { try { it.run(); } catch (e) { /* host's problem, not ours */ } }, 0);
  }

  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); run(active); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  }

  function open_() {
    if (open) return;
    open = true;
    lastFocus = document.activeElement;
    host.classList.add("on");
    input.value = "";
    refresh("");
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 20);
  }

  function close() {
    if (!open) return;
    open = false;
    host.classList.remove("on");
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
  }

  window.NovaXCmdK = {
    init: function (options) {
      try {
        cfg = options || {};
        if (!cfg.sources) return;
        // Idempotent: a second init() must not build a second overlay (which
        // would leave the first one orphaned in the DOM and stealing #nvck).
        if (host) return;
        build(cfg.accent || "var(--nvu-accent)");
        document.addEventListener("keydown", function (e) {
          var k = (e.key || "").toLowerCase();
          if ((e.metaKey || e.ctrlKey) && k === "k") { e.preventDefault(); open ? close() : open_(); return; }
          // "/" opens too, but never while the user is typing somewhere else.
          if (k === "/" && !open) {
            var t = e.target, tag = t && t.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
            e.preventDefault(); open_();
          }
        });
      } catch (e) { /* palette is a convenience; never break the portal */ }
    },
    open: open_,
    close: close
  };
})();

(function(){
  try{
    if(!window.NovaXCmdK) return;
    function myParcelsSafe(){
      try{
        var id = state && state.client && state.client.id;
        if(!id) return [];
        return (state.parcels||[]).filter(function(p){ return p && p.clientId===id; });
      }catch(e){ return []; }
    }
    var TABS=[
      ["dashboard","Dashboard","Overview, alerts and today's cockpit"],
      ["newBooking","New Booking","Book a single parcel"],
      ["awbLabel","AWB Label","Print labels, request a pickup"],
      ["bulkBooking","Bulk Booking","Import a CSV of orders"],
      ["reports","Full Report","Every parcel, filterable"],
      ["payments","Payments","Invoices and settlement"],
      ["wallet","Wallet","Balance, withdrawals, ledger"],
      ["logs","Order Logs","Activity history"],
      ["integrations","Integrations","Shopify, WooCommerce, API"],
      ["tickets","Support Tickets","Raise and track issues"],
      ["subAccounts","Sub Accounts","Team access"]
    ];
    window.NovaXCmdK.init({
      accent:"var(--nvu-accent)",
      sources:function(q){
        var out=[];
        // Commands first when the query is short -- they are what a merchant
        // reaches for most, and they are cheap to scan.
        TABS.forEach(function(t){
          if(!q || t[1].toLowerCase().indexOf(q)>-1 || t[0].toLowerCase().indexOf(q)>-1){
            out.push({group:"Go to",icon:"→",title:t[1],subtitle:t[2],
              run:function(){ if(typeof showClientTab==="function") showClientTab(t[0]); }});
          }
        });
        if(q && q.length>=2){
          myParcelsSafe().forEach(function(p){
            var hay=[p.awb,p.consignee,p.city,p.status,p.orderId].join(" ").toLowerCase();
            if(hay.indexOf(q)===-1) return;
            out.push({group:"Parcels",icon:"▣",
              title:(p.awb||"")+" · "+(p.consignee||""),
              subtitle:(p.city||"")+" · "+(p.status||"")+(Number(p.cod)>0?(" · Rs "+Number(p.cod).toLocaleString("en-PK")):" · Prepaid"),
              run:function(){ if(typeof openClientParcelJourney==="function") openClientParcelJourney(p.awb); }});
          });
          try{
            var myId=state&&state.client&&state.client.id;
            (state.invoices||[]).forEach(function(i){
              if(!myId||i.clientId!==myId||i.status==="Deleted") return;
              if(String(i.id||"").toLowerCase().indexOf(q)===-1) return;
              out.push({group:"Invoices",icon:"▤",title:i.id,
                subtitle:(i.invoiceType||"Invoice")+" · "+(i.status||"")+" · Rs "+Number(i.payable||0).toLocaleString("en-PK"),
                run:function(){ if(typeof showClientTab==="function") showClientTab("payments"); }});
            });
          }catch(e){}
        }
        return out;
      }
    });
  }catch(e){}
})();

/* ==== client.html inline block #17 ==== */

/* ============================================================================
   NovaX — shared UI primitives (status language, micro-charts, drawer,
   empty states).

   INLINED into client.html and admin.html on purpose. See the note above
   nv-codegen: an external file 404'd in production once and silently took its
   feature with it, so nothing new here ships as a separate request.

   DESIGN RULES — this is a live operations portal:
     1. ADDITIVE. Nothing here modifies or replaces an existing renderer. It
        exposes helpers the page opts into, plus one drawer element appended
        to <body>. If the whole module throws, the portal is unchanged.
     2. NO DATA OF ITS OWN. Every value is passed in by the caller from live
        state, so nothing here can display a stale or invented figure.
     3. ESCAPED. Everything rendered is merchant/consignee text.
     4. REDUCED MOTION respected on every animation.
   ========================================================================== */
(function () {
  if (window.NovaXUI) return;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function reduced() {
    try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }

  /* ---- 1. STATUS VISUAL LANGUAGE -----------------------------------------
     One shape + one tone per state, identical in every surface. Logistics is
     entirely about state, so the same parcel must never look different in
     admin, the client portal, the rider app or the tracking page. Glyphs are
     plain text so they survive print, PDF and a plain-text WhatsApp/SMS copy
     of the same status -- an icon font would not.                          */
  var STATUS = {
    "New booked":                     { g: "◌", tone: "info",  short: "Booked" },
    "Collected by rider":             { g: "◉", tone: "info",  short: "Picked up" },
    "Arrived at warehouse":           { g: "◆", tone: "info",  short: "At hub" },
    "Parcel now in transit":          { g: "→", tone: "info",  short: "In transit" },
    "Parcel received at destination": { g: "◆", tone: "info",  short: "At dest. hub" },
    "Parcel out for delivery":        { g: "⟶", tone: "warn",  short: "Out for delivery" },
    "Delivered":                      { g: "✓", tone: "good",  short: "Delivered" },
    "Refused":                        { g: "!", tone: "bad",   short: "Refused" },
    "Consignee not available":        { g: "!", tone: "warn",  short: "Not available" },
    "Reattempt":                      { g: "↻", tone: "warn",  short: "Reattempt" },
    "Reassigned":                     { g: "↻", tone: "info",  short: "Reassigned" },
    "Out of service area":            { g: "✕", tone: "bad",   short: "Out of area" },
    "Ready for return":               { g: "↩", tone: "warn",  short: "Returning" },
    "Return in transit":              { g: "↩", tone: "warn",  short: "Return transit" },
    "Return received at origin":      { g: "↩", tone: "warn",  short: "Return at origin" },
    "Return out for delivery":        { g: "↩", tone: "warn",  short: "Return out" },
    "Return to shipper":              { g: "↩", tone: "bad",   short: "Returned" },
    "Cancelled by client":            { g: "✕", tone: "",      short: "Cancelled" }
  };
  function statusMeta(s) {
    return STATUS[String(s == null ? "" : s)] || { g: "◌", tone: "info", short: String(s || "") };
  }
  /* Renders the glyph + label pill. `labelMode`: "full" keeps the stored
     status text (what ops search for), "short" uses the compact label (for
     dense tables). Never invents a status it does not know -- unknown values
     fall through with their own text intact. */
  function statusPill(s, labelMode) {
    var m = statusMeta(s);
    var txt = labelMode === "short" ? m.short : String(s || "");
    return '<span class="nvst nvst-' + (m.tone || "none") + '"><i>' + m.g + "</i>" + esc(txt) + "</span>";
  }
  function statusDot(s) {
    var m = statusMeta(s);
    return '<span class="nvst-dot nvst-' + (m.tone || "none") + '" title="' + esc(s) + '">' + m.g + "</span>";
  }

  /* ---- 2. MICRO-CHARTS ---------------------------------------------------
     Deliberately tiny and axis-free. These sit inside a stat tile to give it
     shape over time; anything that needs to be read precisely belongs in a
     real table, not here. Pure inline SVG: no library, no network, prints
     fine, and scales with the tile.                                       */
  function sparkline(values, opts) {
    opts = opts || {};
    var v = (values || []).map(Number).filter(function (n) { return isFinite(n); });
    if (v.length < 2) return "";
    var w = opts.w || 120, h = opts.h || 28, pad = 2;
    var min = Math.min.apply(null, v), max = Math.max.apply(null, v);
    var span = (max - min) || 1;
    var stepX = (w - pad * 2) / (v.length - 1);
    var pts = v.map(function (n, i) {
      return [pad + i * stepX, h - pad - ((n - min) / span) * (h - pad * 2)];
    });
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
    var area = d + " L " + pts[pts.length - 1][0].toFixed(1) + " " + (h - pad) + " L " + pad + " " + (h - pad) + " Z";
    var stroke = opts.color || "currentColor";
    var id = "nvsp" + Math.random().toString(36).slice(2, 8);
    return '<svg class="nv-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h +
      '" fill="none" aria-hidden="true" preserveAspectRatio="none">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + stroke + '" stop-opacity=".22"/>' +
        '<stop offset="100%" stop-color="' + stroke + '" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#' + id + ')"/>' +
      '<path d="' + d + '" stroke="' + stroke + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + pts[pts.length - 1][0].toFixed(1) + '" cy="' + pts[pts.length - 1][1].toFixed(1) +
        '" r="2.1" fill="' + stroke + '"/></svg>';
  }
  /* Horizontal distribution bar -- one row per segment, proportional. Used
     for cash-flow style breakdowns where the RATIO is the message. */
  function distBar(rows) {
    var list = (rows || []).filter(function (r) { return r && isFinite(Number(r.value)); });
    if (!list.length) return "";
    var max = Math.max.apply(null, list.map(function (r) { return Math.abs(Number(r.value)); })) || 1;
    return '<div class="nv-dist">' + list.map(function (r) {
      var pct = Math.max(1, Math.round((Math.abs(Number(r.value)) / max) * 100));
      return '<div class="nv-dist-row">' +
        '<span class="nv-dist-l">' + esc(r.label) + "</span>" +
        '<span class="nv-dist-t"><i style="width:' + pct + "%;background:" + (r.color || "#0c7c59") + '"></i></span>' +
        '<span class="nv-dist-v">' + esc(r.display != null ? r.display : r.value) + "</span>" +
      "</div>";
    }).join("") + "</div>";
  }
  function ring(pct, opts) {
    opts = opts || {};
    var p = Math.max(0, Math.min(100, Number(pct) || 0));
    var size = opts.size || 44, sw = opts.stroke || 5, r = (size - sw) / 2, c = 2 * Math.PI * r;
    return '<svg class="nv-ring" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '" aria-hidden="true">' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="rgba(0,0,0,.08)" stroke-width="' + sw + '"/>' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + (opts.color || "#0c7c59") +
        '" stroke-width="' + sw + '" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) +
        '" stroke-dashoffset="' + (c * (1 - p / 100)).toFixed(1) + '" transform="rotate(-90 ' + size / 2 + " " + size / 2 + ')"/>' +
      "</svg>";
  }

  /* ---- 3. DETAIL DRAWER --------------------------------------------------
     Opening a record must not cost a page change. Slides from the right,
     closes on Esc / backdrop / button, restores focus, and never assumes
     what is inside it -- the caller passes finished HTML.                  */
  var drawer = null, drawerBody = null, drawerTitle = null, drawerLast = null;
  function buildDrawer() {
    if (drawer) return;
    drawer = document.createElement("div");
    drawer.id = "nvdrawer";
    drawer.innerHTML =
      '<div class="nvdr-back"></div>' +
      '<aside class="nvdr-panel" role="dialog" aria-modal="true" aria-label="Details">' +
        '<header class="nvdr-head"><div class="nvdr-title"></div>' +
          '<button type="button" class="nvdr-x" aria-label="Close">&#10005;</button></header>' +
        '<div class="nvdr-body"></div>' +
      "</aside>";
    document.body.appendChild(drawer);
    drawerBody = drawer.querySelector(".nvdr-body");
    drawerTitle = drawer.querySelector(".nvdr-title");
    drawer.querySelector(".nvdr-back").addEventListener("click", closeDrawer);
    drawer.querySelector(".nvdr-x").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && drawer && drawer.classList.contains("on")) closeDrawer();
    });
  }
  function openDrawer(title, html) {
    try {
      buildDrawer();
      drawerLast = document.activeElement;
      drawerTitle.innerHTML = title || "";
      drawerBody.innerHTML = html || "";
      drawer.classList.add("on");
      document.body.style.overflow = "hidden";
      setTimeout(function () { try { drawer.querySelector(".nvdr-x").focus(); } catch (e) {} }, 60);
    } catch (e) {}
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove("on");
    document.body.style.overflow = "";
    try { if (drawerLast && drawerLast.focus) drawerLast.focus(); } catch (e) {}
  }

  /* ---- 4. TIMELINE -------------------------------------------------------
     Renders the parcel journey from recorded steps, marking the current one
     and greying what has not happened. Takes the flow it should show so a
     return journey can pass its own sequence.                              */
  function timeline(steps, current, times) {
    var done = {}, list = steps || [];
    (current ? [current] : []).forEach(function () {});
    return '<ol class="nv-tl">' + list.map(function (s, i) {
      var m = statusMeta(s.status || s);
      var label = s.label || (s.status || s);
      var state = s.state || "todo";
      return '<li class="nv-tl-i nv-tl-' + state + ' nvst-' + (m.tone || "none") + '">' +
        '<span class="nv-tl-g">' + (state === "todo" ? "○" : m.g) + "</span>" +
        '<span class="nv-tl-x"><b>' + esc(label) + "</b>" +
          (s.time ? '<span class="nv-tl-t">' + esc(s.time) + "</span>" : "") +
          (s.note ? '<span class="nv-tl-n">' + esc(s.note) + "</span>" : "") +
        "</span></li>";
    }).join("") + "</ol>";
  }

  /* ---- 5. EMPTY STATES ---------------------------------------------------
     An empty screen is the best teaching moment the product gets. "No data"
     wastes it. Every empty state states the good news (if it IS good news),
     then the single next action.                                          */
  function emptyState(o) {
    o = o || {};
    return '<div class="nv-empty">' +
      (o.icon ? '<div class="nv-empty-ic">' + esc(o.icon) + "</div>" : "") +
      '<div class="nv-empty-t">' + esc(o.title || "Nothing here yet") + "</div>" +
      (o.body ? '<div class="nv-empty-b">' + esc(o.body) + "</div>" : "") +
      (o.facts && o.facts.length
        ? '<div class="nv-empty-f">' + o.facts.map(function (f) { return "<span>✓ " + esc(f) + "</span>"; }).join("") + "</div>"
        : "") +
      (o.actionLabel
        ? '<button type="button" class="nv-empty-cta" data-nv-empty-action="' + esc(o.action || "") + '">' + esc(o.actionLabel) + "</button>"
        : "") +
    "</div>";
  }

  /* ---- 6. SKELETONS ------------------------------------------------------ */
  function skeleton(rows, lines) {
    var r = rows || 3, l = lines || 3, out = "";
    for (var i = 0; i < r; i++) {
      out += '<div class="nv-sk">';
      for (var j = 0; j < l; j++) out += '<div class="nv-sk-l" style="width:' + (40 + ((i + j) * 13) % 55) + '%"></div>';
      out += "</div>";
    }
    return out;
  }

  window.NovaXUI = {
    esc: esc, reduced: reduced,
    STATUS: STATUS, statusMeta: statusMeta, statusPill: statusPill, statusDot: statusDot,
    sparkline: sparkline, distBar: distBar, ring: ring,
    openDrawer: openDrawer, closeDrawer: closeDrawer,
    timeline: timeline, emptyState: emptyState, skeleton: skeleton
  };
})();

/* ═══ NovaX theme controller ═══════════════════════════════════════════════
   Two states: "dark" (the default for every merchant, new or existing) and
   "light" (only ever set by an explicit tap on the toggle). Stored per browser
   under novaxTheme. The <html> attribute is also stamped by a boot script at
   the top of <head>, so a dark user does not get a white flash before the
   sheet applies; this controller must agree with that script, and does.

   Scope note: this drives the NovaX UI primitives (--nvu-* tokens), which are
   fully themed. The surrounding legacy stylesheet still carries hardcoded
   light colours in many places, so dark is honest but not yet total -- the
   remaining surfaces are being converted to tokens incrementally. Nothing
   here changes behaviour or data; worst case it changes colours. */
(function(){
  try{
    var KEY="novaxTheme";
    /* NovaX fix (dark was the default in name only): this controller runs
       ~13,000 lines AFTER the boot script at the top of <head>, and it used to
       default to "system", resolve that against prefers-color-scheme, and
       OVERWRITE the dark attribute the boot script had just set. A merchant on
       a light-mode laptop who had never touched the toggle therefore saw a
       dark flash and then a light portal -- the default never actually held.

       The portal is dark for everyone, new signup or existing merchant, until
       they explicitly choose Light. So:
         - no stored value means "dark", matching the boot script exactly;
         - a stored "system" is migrated to "dark" on read. Someone who once
           chose "follow my device" did not choose Light, and the rule now is
           dark-until-Light. apply() writes the migrated value back, so this
           happens once per browser and then stays settled;
         - effective() never consults the OS again, because nothing can reach
           it with a non-dark/light mode any more. It is kept as the single
           place that maps a stored mode to an attribute value. */
    function stored(){
      var v;
      try{ v=localStorage.getItem(KEY); }catch(e){ v=null; }
      return (v==="light") ? "light" : "dark";
    }
    function effective(mode){ return (mode==="light") ? "light" : "dark"; }
    function apply(mode){
      var el=document.documentElement;
      el.setAttribute("data-theme", effective(mode));
      try{ localStorage.setItem(KEY,mode); }catch(e){}
      try{
        var m=document.querySelector('meta[name="theme-color"]');
        if(m) m.setAttribute("content", el.getAttribute("data-theme")==="dark" ? "#0B0F0D" : "#0c7c59");
      }catch(e){}
      document.querySelectorAll("[data-nv-theme-btn]").forEach(function(b){
        b.setAttribute("aria-pressed", String(b.getAttribute("data-nv-theme-btn")===mode));
      });
    }
    apply(stored());
    /* The prefers-color-scheme listener that used to live here is gone on
       purpose: with "system" retired there is no mode left for it to act on,
       and leaving it would let the OS quietly repaint a merchant who had
       explicitly chosen Light. */
    window.NovaXTheme={ get:stored, set:apply, cycle:function(){
      apply(stored()==="light" ? "dark" : "light");
      return stored();
    }};
    document.addEventListener("click",function(e){
      var b=e.target&&e.target.closest?e.target.closest("[data-nv-theme-btn]"):null;
      if(!b) return;
      e.preventDefault();
      apply(b.getAttribute("data-nv-theme-btn"));
    });
  }catch(e){ /* theming must never break the portal */ }
})();

/* ═══ Premium table behaviour ══════════════════════════════════════════════
   Purely presentational and entirely opt-out-safe: it decorates tables that
   already exist in the DOM and re-applies after re-renders. It never reads or
   writes portal state beyond one localStorage density preference, and never
   changes what a cell contains.

   Right-aligning numeric columns is done by INSPECTING RENDERED TEXT rather
   than by editing any renderer -- a cell is treated as numeric only when its
   header says so, so a consignee called "500" is never right-aligned. */
(function(){
  try{
    var KEY="novaxTableDensity";
    var NUM_HEADS=/^(cod|charges|amount|payable|balance|fee|total|value|net|due|qty|parcels|count|rs\b)/i;
    function density(){ try{ return localStorage.getItem(KEY)||"comfortable"; }catch(e){ return "comfortable"; } }
    function applyDensity(mode){
      try{ localStorage.setItem(KEY,mode); }catch(e){}
      document.querySelectorAll(".table-wrap").forEach(function(w){
        w.classList.toggle("nv-dense-compact", mode==="compact");
      });
      document.querySelectorAll("[data-nv-density]").forEach(function(b){
        b.setAttribute("aria-pressed", String(b.getAttribute("data-nv-density")===mode));
      });
    }
    function decorate(){
      document.querySelectorAll(".table-wrap").forEach(function(w){
        var t=w.querySelector("table");
        if(!t) return;
        // Only make it scroll-with-sticky-header when it is long enough to
        // need it; a 3-row table with a frozen header looks broken.
        var rows=t.querySelectorAll("tbody tr").length;
        w.classList.toggle("nv-scroll", rows>=12);
        var heads=t.querySelectorAll("thead th");
        if(!heads.length || t.dataset.nvNumDone==="1") return;
        var numCols=[];
        heads.forEach(function(th,i){ if(NUM_HEADS.test((th.textContent||"").trim())){ th.classList.add("nv-num"); numCols.push(i); } });
        if(numCols.length){
          t.querySelectorAll("tbody tr").forEach(function(tr){
            var tds=tr.children;
            numCols.forEach(function(i){ if(tds[i]) tds[i].classList.add("nv-num"); });
          });
        }
        t.dataset.nvNumDone="1";
      });
      applyDensity(density());
    }
    document.addEventListener("click",function(e){
      var b=e.target&&e.target.closest?e.target.closest("[data-nv-density]"):null;
      if(!b) return;
      e.preventDefault();
      applyDensity(b.getAttribute("data-nv-density"));
    });
    // Re-decorate after the portal re-renders. Debounced, and it clears the
    // per-table done flag so freshly written rows get their numeric classes.
    var pending=false;
    var mo=new MutationObserver(function(){
      if(pending) return; pending=true;
      requestAnimationFrame(function(){
        pending=false;
        try{
          document.querySelectorAll("table[data-nv-num-done]").forEach(function(t){ delete t.dataset.nvNumDone; });
          decorate();
        }catch(e){}
      });
    });
    function boot(){
      try{ decorate(); mo.observe(document.body,{childList:true,subtree:true}); }catch(e){}
    }
    if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot); else boot();
    window.NovaXTable={ decorate:decorate, density:applyDensity };
  }catch(e){ /* table polish must never break a table */ }
})();




/* ==== client.html inline block #18 ==== */

(function(){
  var LABELS = {
    1:"Not good — tell us what went wrong",
    2:"Below what you expected",
    3:"It's okay",
    4:"Good — we'll keep pushing",
    5:"Excellent — thank you!"
  };
  var rating = 0, submitting = false, mounted = false;

  function el(id){ return document.getElementById(id); }

  function buildStars(){
    var host = el("nvrvStars");
    if(!host || host.children.length) return;
    for(var i=1;i<=5;i++){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "nvrv-star";
      b.dataset.v = String(i);
      b.setAttribute("role","radio");
      b.setAttribute("aria-checked","false");
      b.setAttribute("aria-label", i + " star" + (i>1?"s":""));
      b.textContent = "★";
      b.addEventListener("click", onStar);
      host.appendChild(b);
    }
  }

  function onStar(e){
    var v = Number(e.currentTarget.dataset.v || 0);
    if(!v) return;
    rating = v;
    var stars = el("nvrvStars").children;
    for(var i=0;i<stars.length;i++){
      var on = (i+1) <= v;
      stars[i].classList.toggle("on", on);
      stars[i].setAttribute("aria-checked", (i+1)===v ? "true" : "false");
      stars[i].classList.remove("pop");
      if(on){ void stars[i].offsetWidth; stars[i].classList.add("pop"); }
    }
    var lab = el("nvrvRateLabel");
    lab.textContent = LABELS[v] || "";
    lab.classList.add("show");
    var btn = el("nvrvSubmit");
    btn.disabled = false;
    btn.textContent = "Submit review";
  }

  function show(){
    if(mounted) return;
    mounted = true;
    buildStars();
    var ov = el("nvrvOverlay");
    ov.classList.add("nvrv-open");
    // force a frame so the transition actually runs
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ ov.classList.add("nvrv-in"); }); });
    try{ document.body.style.overflow = "hidden"; }catch(e){}
  }

  function close(){
    var ov = el("nvrvOverlay");
    ov.classList.remove("nvrv-in");
    ov.classList.add("nvrv-out");
    setTimeout(function(){
      ov.classList.remove("nvrv-open","nvrv-out");
      try{ document.body.style.overflow = ""; }catch(e){}
    }, 380);
  }

  /* The confirmation. Form scales away while the tick rises through it, a
     spark burst fires outward, and the merchant's own rating pops back star by
     star so the last thing they see is what they actually said. */
  function celebrate(){
    var form = el("nvrvForm");
    var done = el("nvrvDone");
    var reduce = false;
    try{ reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){}

    // spark burst -- 12 dots radiating from the tick
    var burst = el("nvrvBurst");
    if(burst && !reduce){
      burst.innerHTML = "";
      for(var i = 0; i < 12; i++){
        var a = (Math.PI * 2 * i) / 12;
        var dist = 42 + (i % 3) * 9;
        var sp = document.createElement("span");
        sp.className = "nvrv-spark";
        sp.style.setProperty("--dx", (Math.cos(a) * dist).toFixed(1) + "px");
        sp.style.setProperty("--dy", (Math.sin(a) * dist).toFixed(1) + "px");
        sp.style.animationDelay = (0.5 + (i % 4) * 0.045) + "s";
        if(i % 2) sp.style.background = "#4ee6a5";
        burst.appendChild(sp);
      }
    }

    // echo their rating back, staggered
    var echo = el("nvrvEcho");
    if(echo){
      echo.innerHTML = "";
      for(var j = 0; j < rating; j++){
        var st = document.createElement("span");
        st.textContent = "\u2605";
        st.style.animationDelay = (reduce ? 0 : 0.62 + j * 0.075) + "s";
        echo.appendChild(st);
      }
    }

    form.classList.add("nvrv-leaving");
    setTimeout(function(){
      form.style.display = "none";
      done.classList.add("show");
    }, reduce ? 0 : 240);

    setTimeout(close, reduce ? 1200 : 3000);
  }

  function submit(){
    if(submitting || !rating) return;
    var sb = window.__nvSb;
    if(!sb){ el("nvrvErr").textContent = "Still connecting — try again in a moment."; return; }
    submitting = true;
    var btn = el("nvrvSubmit");
    btn.disabled = true;
    btn.textContent = "Sending…";
    el("nvrvErr").textContent = "";

    sb.rpc("submit_client_review", {
      p_rating: rating,
      p_comment: (el("nvrvComment").value || "").trim()
    }).then(function(r){
      if(r && r.error){
        submitting = false;
        btn.disabled = false;
        btn.textContent = "Submit review";
        el("nvrvErr").textContent = "Could not send that — " + r.error.message;
        return;
      }
      celebrate();
    }).catch(function(e){
      submitting = false;
      btn.disabled = false;
      btn.textContent = "Submit review";
      el("nvrvErr").textContent = "Could not send that — " + ((e && e.message) || e);
    });
  }

  /* There is no close control by design, but a stray Escape keypress or a
     backdrop click must not dismiss it either -- the merchant has to submit. */
  function guard(){
    var ov = el("nvrvOverlay");
    if(!ov) return;
    ov.addEventListener("click", function(ev){ if(ev.target === ov) ev.stopPropagation(); });
    document.addEventListener("keydown", function(ev){
      if(ev.key === "Escape" && ov.classList.contains("nvrv-open")){
        ev.preventDefault(); ev.stopPropagation();
      }
    }, true);
  }

  function boot(){
    var btn = el("nvrvSubmit");
    if(btn) btn.addEventListener("click", submit);
    guard();

    var tries = 0;
    (function waitForSb(){
      var sb = window.__nvSb;
      if(!sb){
        if(++tries > 40) return;          // ~20s, then give up quietly
        return setTimeout(waitForSb, 500);
      }
      sb.rpc("client_review_prompt_state", {}).then(function(r){
        if(!r || r.error || !r.data) return;
        var d = r.data;
        if(typeof d === "string"){ try{ d = JSON.parse(d); }catch(e){ return; } }
        /* The pricing card decides what this merchant is charged, so it goes
           first. Without this both overlays open and the review prompt --
           which mounts later -- lands on top of a decision they have not
           made yet. */
        /* Three overlays can now want the screen: pricing, this, and the
           onboarding deck. The deck belongs to brand-new merchants and this
           to merchants who have finished a journey, so they should never
           overlap -- but if they ever do, wait rather than stack. */
        if(d && d.eligible === true) setTimeout(function(){
          if(document.getElementById("nvObDeck")){
            var w=setInterval(function(){
              if(!document.getElementById("nvObDeck")){ clearInterval(w);
                if(typeof window.__nvWaitForGate==="function") window.__nvWaitForGate(show); else show(); }
            },600);
            return;
          }
          if(typeof window.__nvWaitForGate === "function") window.__nvWaitForGate(show);
          else show();
        }, 1400);
      }).catch(function(){});
    })();
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

/* ==== client.html inline block #19 ==== */

/* ═══════════════════ NovaX AI console ═══════════════════
   Talks only to the novax-ai Edge Function, which holds the API key.
   The browser never sees a model key. Every answer the function returns
   was grounded in RPCs run under this merchant's own JWT. */
(function(){
  "use strict";

  var STREAM, CHIPS, INPUT, SEND, SUB, QWRAP, QFILL, QTXT, CAPPED, CAPMSG, REQBTN, COMPOSER;
  var convId = null, busy = false, booted = false;

  function esc(v){
    return String(v == null ? "" : v).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function el(id){ return document.getElementById(id); }

  function cache(){
    STREAM=el("nvAiStream"); CHIPS=el("nvAiChips"); INPUT=el("nvAiInput");
    SEND=el("nvAiSend"); SUB=el("nvAiSub"); QWRAP=el("nvAiQuota");
    QFILL=el("nvAiQuotaFill"); QTXT=el("nvAiQuotaTxt"); CAPPED=el("nvAiCapped");
    CAPMSG=el("nvAiCappedMsg"); REQBTN=el("nvAiReqMore"); COMPOSER=el("nvAiComposer");
    return !!STREAM;
  }

  function scroll(){ if(STREAM) STREAM.scrollTop = STREAM.scrollHeight; }

  /* ---- rendering ---- */
  function cardHtml(c){
    if(!c || !c.title) return "";
    var kind = String(c.kind || "stat").toLowerCase();
    var lines = Array.isArray(c.lines) ? c.lines : [];
    var rows = lines.map(function(pair){
      if(!Array.isArray(pair) || !pair.length) return "";
      return '<div class="nvai-card-line"><span>' + esc(pair[0]) +
             '</span><span>' + esc(pair[1] == null ? "" : pair[1]) + '</span></div>';
    }).join("");
    return '<div class="nvai-card" data-kind="' + esc(kind) + '">' +
             '<div class="nvai-card-top">' +
               '<span class="nvai-card-title">' + esc(c.title) + '</span>' +
               (c.status ? '<span class="nvai-card-status">' + esc(c.status) + '</span>' : '') +
             '</div>' +
             (c.subtitle ? '<div class="nvai-card-sub">' + esc(c.subtitle) + '</div>' : '') +
             (rows ? '<div class="nvai-card-lines">' + rows + '</div>' : '') +
           '</div>';
  }

  /* Progressive reveal. This is NOT token streaming -- the full answer has
     already arrived. Revealing it a few characters at a time removes the
     dead pause where a finished reply lands as one block, which is what
     actually reads as slow. Cards appear once the text finishes. */
  function reveal(el, text, done){
    var full = String(text || "");
    if (prefersReducedMotion() || full.length < 40){
      el.textContent = full; if(done) done(); return;
    }
    var i = 0, step = Math.max(2, Math.round(full.length / 90));
    (function tick(){
      i = Math.min(full.length, i + step);
      el.textContent = full.slice(0, i);
      scroll();
      if(i < full.length) setTimeout(tick, 16);
      else if(done) done();
    })();
  }

  function prefersReducedMotion(){
    try{ return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch(e){ return false; }
  }

  function turn(role, text, cards, onDone){
    if(!STREAM) return null;
    var wrap = document.createElement("div");
    wrap.className = "nvai-turn" + (role === "me" ? " me" : "");
    wrap.innerHTML =
      (role === "me" ? "" : '<span class="nvai-av" aria-hidden="true">NX</span>') +
      '<div class="nvai-body"><div class="nvai-say"></div>' +
        '<div class="nvai-cards" hidden></div></div>';
    STREAM.appendChild(wrap);

    var say = wrap.querySelector(".nvai-say");
    var box = wrap.querySelector(".nvai-cards");
    var cardHtmls = (Array.isArray(cards) ? cards : []).map(cardHtml).join("");

    if(role === "me"){
      say.textContent = String(text || "");
      scroll();
      if(onDone) onDone();
    } else {
      reveal(say, text, function(){
        if(cardHtmls){ box.innerHTML = cardHtmls; box.hidden = false; }
        scroll();
        if(onDone) onDone();
      });
    }
    return wrap;
  }

  /* A write the merchant has to approve. The model only ever proposes;
     this button is the only thing that calls the writing RPC. */
  function confirmBar(action){
    if(!STREAM || !action || !action.type) return;
    var wrap = document.createElement("div");
    wrap.className = "nvai-turn";
    wrap.innerHTML =
      '<span class="nvai-av" aria-hidden="true">NX</span>' +
      '<div class="nvai-body"><div class="nvai-confirm">' +
        '<div class="nvai-confirm-txt">' + esc(confirmText(action)) + '</div>' +
        '<div class="nvai-confirm-row">' +
          '<button class="nvai-go" type="button">' + esc(action.label || "Confirm") + '</button>' +
          '<button class="nvai-no" type="button">Not now</button>' +
        '</div></div></div>';
    STREAM.appendChild(wrap); scroll();

    wrap.querySelector(".nvai-no").addEventListener("click", function(){ wrap.remove(); });
    wrap.querySelector(".nvai-go").addEventListener("click", function(){
      runAction(action, wrap);
    });
  }

  function confirmText(a){
    if(a.type === "fix_address"){
      return "Save this to " + a.awb + "?\n" + (a.address || "") + (a.phone ? "\n" + a.phone : "");
    }
    if(a.type === "reattempt") return "Ask operations to reattempt " + a.awb + "?";
    return "Confirm this?";
  }

  function runAction(a, wrap){
    var sb = client();
    if(!sb) return;
    var go = wrap.querySelector(".nvai-go");
    go.disabled = true; go.textContent = "Working...";
    var call = a.type === "fix_address"
      ? sb.rpc("ai_action_fix_address", { p_awb: a.awb, p_address: a.address || null, p_phone: a.phone || null })
      : sb.rpc("ai_action_request_reattempt", { p_awb: a.awb, p_note: a.note || null });
    Promise.resolve(call)
      .catch(function(e){ return { error: { message: String((e && e.message) || e) } }; })
      .then(function(r){
        wrap.remove();
        if(r && r.error){ turn("ai", "That did not go through: " + r.error.message); return; }
        var d = r && r.data;
        if(d && d.ok === false){
          turn("ai", d.reason === "not_your_parcel"
            ? "That parcel is not on your account, so I left it alone."
            : "I could not complete that.");
          return;
        }
        turn("ai", a.type === "fix_address"
          ? "Saved. " + a.awb + " has its address now, so the rider will not be stuck at the door."
          : "Filed. Operations have the reattempt request for " + a.awb + ".");
      });
  }

  function thinking(){
    if(!STREAM) return null;
    var wrap = document.createElement("div");
    wrap.className = "nvai-turn";
    wrap.setAttribute("data-thinking","1");
    wrap.innerHTML = '<span class="nvai-av" aria-hidden="true">NX</span>' +
      '<div class="nvai-body"><div class="nvai-think"><i></i><i></i><i></i></div></div>';
    STREAM.appendChild(wrap); scroll();
    return wrap;
  }

  /* `hold` is passed while a reply is in flight: the strip has nothing to
     show yet but must not give up its height, or the transcript above it
     moves. See the is-holding rule in the stylesheet. */
  function chips(list, hold){
    if(!CHIPS) return;
    CHIPS.innerHTML = "";
    var items = (Array.isArray(list) ? list : []).slice(0,3);
    var holding = !!hold && !items.length;
    CHIPS.classList.toggle("is-holding", holding);
    if(holding){
      /* One invisible chip, so the strip occupies exactly the box a real
         suggestion row will occupy -- no arithmetic to get wrong across the
         two breakpoints, which have different padding. */
      var ph = document.createElement("button");
      ph.className = "nvai-chip";
      ph.type = "button";
      ph.tabIndex = -1;
      ph.setAttribute("aria-hidden", "true");
      ph.textContent = "\u00a0";
      CHIPS.appendChild(ph);
      return;
    }
    items.forEach(function(t, i){
      if(!t) return;
      var b = document.createElement("button");
      b.className = "nvai-chip";
      b.type = "button";
      b.textContent = String(t);
      /* 26ms, not 60: three chips staggered at 60 finished 120ms after the
         first one even before the .34s animation was cut down. */
      b.style.animationDelay = (i * 26) + "ms";
      b.addEventListener("click", function(){ send(String(t)); });
      CHIPS.appendChild(b);
    });
  }

  function quota(q){
    if(!q || !QFILL) return;
    var used = Number(q.used || 0), cap = Number(q.cap || 50);
    var pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
    QFILL.style.width = pct + "%";
    if(QTXT) QTXT.textContent = used + " / " + cap;
    if(QWRAP){
      QWRAP.classList.toggle("low", pct >= 80 && pct < 100);
      QWRAP.classList.toggle("out", pct >= 100);
    }
    setCapped(!!q.blocked, !!q.pending_request);
  }

  function setCapped(isCapped, pending){
    if(!CAPPED || !COMPOSER) return;
    CAPPED.hidden = !isCapped;
    COMPOSER.style.display = isCapped ? "none" : "";
    if(isCapped && REQBTN){
      REQBTN.disabled = !!pending;
      REQBTN.textContent = pending ? "Request sent — waiting for admin" : "Request more from admin";
      if(CAPMSG && pending){
        CAPMSG.textContent = "You've used all your NovaX AI messages. An admin has your request and can top you back up.";
      }
    }
  }

  /* ---- transport ---- */
  function endpoint(){
    var base = (window.NOVAX_CONFIG && window.NOVAX_CONFIG.SB_URL) || "";
    return base.replace(/\/+$/,"") + "/functions/v1/novax-ai";
  }

  function client(){ return window.__nvSb || null; }

  function call(payload){
    var sb = client();
    if(!sb) return Promise.reject(new Error("not connected"));
    return sb.auth.getSession().then(function(res){
      var token = res && res.data && res.data.session && res.data.session.access_token;
      if(!token) throw new Error("not signed in");
      return fetch(endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify(payload)
      });
    }).then(function(r){
      return r.json().then(function(j){ return { status: r.status, body: j }; });
    });
  }

  function receive(res){
    var b = (res && res.body) || {};
    if(b.conv_id) convId = b.conv_id;
    if(b.quota) quota(b.quota);
    if(b.capped){
      turn("ai", b.answer || "You've reached your message limit.");
      setCapped(true, (b.quota && b.quota.pending_request) || false);
      chips([]);
      return;
    }
    if(res.status === 429){ chips([]); return; }
    turn("ai", b.answer || b.error || "I didn't catch that — try again?", b.cards, function(){
      if(b.pending_action) confirmBar(b.pending_action);
    });
    chips(b.suggestions);
    if(SUB) SUB.textContent = b.tools_used && b.tools_used.length
      ? "Checked: " + b.tools_used.filter(function(t,i,a){return a.indexOf(t)===i;}).join(", ")
      : "Reading your live account data";
  }

  function fail(e){
    turn("ai", "I couldn't reach my service just now. Your data is fine — try again in a moment.");
    chips(["Try again"]);
    if(SUB) SUB.textContent = "Connection interrupted";
    console.warn("NovaX AI:", e && e.message ? e.message : e);
  }

  function lock(on){
    busy = on;
    if(SEND) SEND.disabled = on;
    if(INPUT) INPUT.disabled = on;
  }

  function send(text){
    text = String(text || "").trim();
    if(!text || busy) return;
    if(INPUT){ INPUT.value = ""; autosize(); }   /* not height:auto -- see autosize() */
    turn("me", text);
    chips([], true);   /* keep the strip's height until the reply lands */
    lock(true);
    var t = thinking();
    call({ conv_id: convId, message: text, mode: "chat" })
      .then(function(res){ if(t) t.remove(); receive(res); })
      .catch(function(e){ if(t) t.remove(); fail(e); })
      .then(function(){ lock(false); if(INPUT) INPUT.focus(); });
  }

  /* ---- the proactive opener ---- */
  function boot(){
    if(booted || !cache()) return;
    booted = true;
    lock(true);
    var t = thinking();
    if(SUB) SUB.textContent = "Checking what needs your attention…";
    call({ mode: "open" })
      .then(function(res){ if(t) t.remove(); receive(res); })
      .catch(function(e){ if(t) t.remove(); fail(e); })
      .then(function(){ lock(false); });
  }

  function requestMore(){
    var sb = client();
    if(!sb || !REQBTN) return;
    REQBTN.disabled = true;
    REQBTN.textContent = "Sending…";
    Promise.resolve(sb.rpc("ai_quota_request_reset", { p_reason: "Requested from NovaX AI console" }))
      .then(function(){ setCapped(true, true); })
      .catch(function(){ REQBTN.disabled = false; REQBTN.textContent = "Request more from admin"; });
  }

  /* An EMPTY textarea does not measure as empty.

     Chrome lays the placeholder out and counts it in scrollHeight, and this
     placeholder -- "Ask about a parcel, a payout, your rates…" -- wraps to
     two lines in the 254px the composer gives it. So an empty box reports
     64px where one line is 40px. send() clears the value and then resized
     from that measurement, which grew the composer by 20px after every
     single message and pushed the transcript up with it.

     When there is no value there is nothing to fit: drop the inline height
     and let the CSS one-line height stand. Only a box with real text in it
     gets measured, and that measurement starts from 0px rather than auto so
     it can shrink again as well as grow. */
  function autosize(){
    if(!INPUT) return;
    if(!INPUT.value){ INPUT.style.height = ""; return; }
    INPUT.style.height = "0px";
    INPUT.style.height = Math.min(INPUT.scrollHeight, 132) + "px";
  }

  function bind(){
    if(!cache()) return;
    if(INPUT){
      INPUT.addEventListener("input", autosize);
      INPUT.addEventListener("keydown", function(e){
        if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); send(INPUT.value); }
      });
    }
    if(SEND) SEND.addEventListener("click", function(){ if(INPUT) send(INPUT.value); });
    if(REQBTN) REQBTN.addEventListener("click", requestMore);
  }

  /* Boot the opener the first time the Support tab is actually shown, so
     an unused tab never spends a message. */
  function watchTab(){
    var orig = window.showClientTab;
    if(typeof orig !== "function"){ setTimeout(watchTab, 400); return; }
    window.showClientTab = function(id){
      var out = orig.apply(this, arguments);
      try{
        var onConsole = String(id) === "support";
        if(onConsole){
          setTimeout(boot, 60);
          var shell = document.getElementById("nvAiShell");
          if(shell){
            shell.classList.remove("nv-opening");
            void shell.offsetWidth;          // force reflow so it replays
            shell.classList.add("nv-opening");
          }
        }
        // One assistant at a time. With the console open, the floating
        // launcher is a second entry point to the same brain sitting on
        // top of it -- it reads as two competing bots.
        ["nvauto-btn","nvauto-nudge"].forEach(function(cls){
          var el = document.querySelector("." + cls);
          if(el) el.classList.toggle("nv-console-open", onConsole);
        });
        if(onConsole){
          var panel = document.querySelector(".nvauto-panel.open");
          if(panel) panel.classList.remove("open");
        }
      }catch(e){}
      return out;
    };
    try{
      if(typeof state !== "undefined" && state && state.activeClientTab === "support") setTimeout(boot, 300);
    }catch(e){}
  }

  /* Proactive nudge. One cheap RPC -- no model call, no quota spend --
     so the launcher can say "3 need you" before anyone opens anything. */
  function attentionBadge(){
    var sb = client();
    if(!sb) { setTimeout(attentionBadge, 3000); return; }
    Promise.resolve(sb.rpc("ai_context_digest"))
      .catch(function(){ return null; })
      .then(function(r){
        var d = r && r.data;
        if(!d || d.error) return;
        var n = Number(d.needs_attention || 0);
        var btn = document.querySelector(".nvauto-btn");
        if(!btn) return;
        var old = btn.querySelector(".nvauto-badge");
        if(old) old.remove();
        if(n > 0){
          var b = document.createElement("span");
          b.className = "nvauto-badge";
          b.textContent = n > 9 ? "9+" : String(n);
          btn.appendChild(b);
          btn.classList.add("nv-pulse");
          var sub = document.getElementById("nvAiSub");
          if(sub) sub.textContent = n + " parcel" + (n === 1 ? "" : "s") + " need attention";
        } else {
          btn.classList.remove("nv-pulse");
        }
      });
  }

  function init(){ bind(); watchTab(); setTimeout(attentionBadge, 2600); }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.novaxAiOpen = function(){ boot(); };
})();

/* ==== client.html inline block #20 ==== */

/* NovaX pricing mode chooser.

   Reads client_pricing_choice_state(), shows the two options once, writes the
   answer through client_set_pricing_choice(). Everything else in the portal
   keys off state.client.pricingMode, which nvGeoActive() now respects, so a
   merchant on flat never sees a per-km quote and a merchant on per-km is never
   quietly dropped back onto the flat rate. */
(function(){
  var CHOSEN = null, BUSY = false;

  /* Three things want the screen on a first load: this card, the review
     prompt, and the Autopilot intro. Stacked, they bury each other. This card
     wins because it decides what the merchant is charged -- the other two wait
     their turn rather than being suppressed. */
  var GATE = window.__nvPricingGate = { pending:false, open:false };
  window.__nvGateBusy = function(){ return !!(GATE.pending || GATE.open); };
  window.__nvWaitForGate = function(fn, waited){
    waited = waited || 0;
    if(!window.__nvGateBusy() || waited > 90000){ fn(); return; }
    setTimeout(function(){ window.__nvWaitForGate(fn, waited + 500); }, 500);
  };

  function el(id){ return document.getElementById(id); }

  /* Same curve the server prices on: base 120, 6 km included, Rs 20/km,
     capped at 320. Read from novax_pricing_config when it is already loaded
     so this card can never quote numbers the booking form disagrees with. */
  function curve(){
    var c = (window.NV_GEO && NV_GEO.cfg) || {};
    return {
      base: Number(c.base_fee    != null ? c.base_fee    : 120),
      incl: Number(c.included_km != null ? c.included_km : 6),
      per:  Number(c.per_km      != null ? c.per_km      : 20),
      cap:  Number(c.max_fee     != null ? c.max_fee     : 320)
    };
  }
  function distanceFee(km){
    var c = curve();
    var f = c.base + Math.max(0, Math.ceil(km - c.incl)) * c.per;
    return c.cap > 0 ? Math.min(f, c.cap) : f;
  }
  function flatFee(){
    var r = Number((window.state && state.client && state.client.rate) || 200);
    return r > 0 ? r : 200;
  }

  function drawBars(){
    var host = el("nvpmBars"); if(!host) return;
    var kms = [3, 6, 10, 15, 20];
    var flat = flatFee();
    var peak = Math.max(flat, distanceFee(kms[kms.length - 1])) || 1;
    host.innerHTML = kms.map(function(km){
      var d = distanceFee(km);
      var hd = Math.max(4, Math.round(d / peak * 52));
      var hf = Math.max(4, Math.round(flat / peak * 52));
      return '<div class="nvpm-bar">' +
        '<div class="nvpm-bar-pair">' +
          '<div class="nvpm-bar-d" style="height:2px" data-h="' + hd + '" title="Per km: Rs ' + d + '"></div>' +
          '<div class="nvpm-bar-f" style="height:2px" data-h="' + hf + '" title="Flat: Rs ' + flat + '"></div>' +
        '</div>' +
        '<div class="nvpm-bar-amt">' + d + ' / ' + flat + '</div>' +
        '<div class="nvpm-bar-km">' + km + ' km</div>' +
      '</div>';
    }).join("");
  }

  /* Staggered so the eye follows the curve left to right instead of the whole
     chart appearing at once. Honours reduced-motion by jumping to final. */
  function growBars(){
    var reduce = false;
    try{ reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){}
    var bars = document.querySelectorAll("#nvpmBars [data-h]");
    Array.prototype.forEach.call(bars, function(b, i){
      var h = b.getAttribute("data-h") + "px";
      if(reduce){ b.style.height = h; return; }
      setTimeout(function(){ b.style.height = h; }, i * 55);
    });
  }

  /* Per-km needs an origin. Rather than let a merchant pick it and then
     discover their bookings are blocked, say so before they commit. */
  function hasPickup(){
    return !!(window.NV_GEO && NV_GEO.pickup && NV_GEO.pickup.area_id);
  }

  function refreshConfirm(){
    var btn = el("nvpmConfirm"), warn = el("nvpmPickupWarn");
    if(!btn) return;
    if(!CHOSEN){
      btn.disabled = true; btn.textContent = "Select an option";
      if(warn) warn.hidden = true;
      return;
    }
    if(CHOSEN === "distance" && !hasPickup()){
      if(warn) warn.hidden = false;
      btn.disabled = false;
      btn.textContent = "Set pickup point and continue";
      return;
    }
    if(warn) warn.hidden = true;
    btn.disabled = false;
    btn.textContent = CHOSEN === "distance"
      ? "Confirm per-kilometre pricing"
      : "Confirm flat rate";
  }

  function pick(mode){
    CHOSEN = mode;
    var grid = document.querySelector(".nvpm-grid");
    if(grid) grid.classList.add("nvpm-picked");
    Array.prototype.forEach.call(document.querySelectorAll("[data-nvpm]"), function(b){
      b.setAttribute("aria-pressed", String(b.getAttribute("data-nvpm") === mode));
    });
    refreshConfirm();
  }

  function show(){
    var ov = el("nvpmOverlay"); if(!ov) return;
    GATE.pending = false; GATE.open = true;
    drawBars();
    ov.classList.add("nvpm-open");
    try{ document.body.style.overflow = "hidden"; }catch(e){}
    requestAnimationFrame(function(){ ov.classList.add("nvpm-in"); });
    // Bars grow into place once the cards have landed, so the comparison
    // reads as a result rather than as decoration that was always there.
    setTimeout(growBars, 520);
    var first = document.querySelector("[data-nvpm]");
    if(first) setTimeout(function(){ try{ first.focus(); }catch(e){} }, 420);
  }
  function hide(){
    var ov = el("nvpmOverlay"); if(!ov) return;
    GATE.open = false; GATE.pending = false;
    try{ document.body.style.overflow = ""; }catch(e){}
    ov.classList.remove("nvpm-in"); ov.classList.add("nvpm-out");
    setTimeout(function(){ ov.classList.remove("nvpm-open","nvpm-out"); }, 340);
  }

  function save(){
    if(BUSY || !CHOSEN) return;

    // Per-km with no origin: send them to the existing pickup modal instead of
    // recording a choice the booking form cannot honour.
    if(CHOSEN === "distance" && !hasPickup()){
      hide();
      setTimeout(function(){
        if(typeof window.nvOpenPickupSetup === "function"){
          window.nvOpenPickupSetup();
          if(typeof toast === "function") toast("Set your pickup point, then pick your rate again.");
        }
        // Reopen once they are mapped so the choice actually gets recorded.
        var tries = 0;
        var t = nvInterval(function(){
          if(++tries > 120){ clearInterval(t); return; }
          if(hasPickup()){ clearInterval(t); CHOSEN = null; boot(true); }
        }, 1000);
      }, 360);
      return;
    }

    var sb = window.__nvSb;
    if(!sb){ if(typeof toast === "function") toast("Not connected yet.","error"); return; }
    BUSY = true;
    var btn = el("nvpmConfirm");
    if(btn){ btn.disabled = true; btn.textContent = "Saving..."; }

    Promise.resolve(sb.rpc("client_set_pricing_choice", { p_choice: CHOSEN }))
      .catch(function(e){ return { error:{ message:String((e && e.message) || e) } }; })
      .then(function(r){
        BUSY = false;
        var d = r && r.data;
        if(typeof d === "string"){ try{ d = JSON.parse(d); }catch(e){} }

        if((r && r.error) || !(d && d.ok)){
          // already_chosen is not a failure -- another tab got there first.
          if(d && d.error === "already_chosen"){ hide(); return; }
          if(btn){ btn.disabled = false; }
          refreshConfirm();
          var msg = (r && r.error && r.error.message) || (d && d.error) || "unknown error";
          if(typeof toast === "function") toast("Could not save that choice: " + msg, "error");
          return;
        }

        if(window.state && state.client) state.client.pricingMode = CHOSEN;

        // Land the choice visually before the card leaves, so the merchant
        // sees which one took rather than just a dialog vanishing.
        var card = document.querySelector(".nvpm-card");
        var won  = document.querySelector('[data-nvpm="' + CHOSEN + '"]');
        if(card) card.classList.add("nvpm-done");
        if(won)  won.classList.add("nvpm-won");
        setTimeout(hide, 620);

        if(typeof toast === "function"){
          toast(CHOSEN === "distance"
            ? "You are on per-kilometre pricing. Your Karachi bookings now quote by distance."
            : "You are on the flat rate. Every parcel is priced the same.", "success");
        }
        // Rebuild the booking form against the mode just chosen.
        try{ if(typeof nvGeoRenderPickup === "function") nvGeoRenderPickup(); }catch(e){}
        try{ if(typeof nvGeoToggleAreaField === "function") nvGeoToggleAreaField(); }catch(e){}
      });
  }

  function wire(){
    Array.prototype.forEach.call(document.querySelectorAll("[data-nvpm]"), function(b){
      if(b._nvpmWired) return;
      b._nvpmWired = true;
      b.addEventListener("click", function(){ pick(b.getAttribute("data-nvpm")); });
    });
    var c = el("nvpmConfirm");
    if(c && !c._nvpmWired){ c._nvpmWired = true; c.addEventListener("click", save); }
  }

  function boot(force){
    wire();
    var tries = 0, wsTries = 0;
    (function waitForSb(){
      var sb = window.__nvSb;
      if(!sb){
        if(++tries > 40) return;          // ~20s, then give up quietly
        return setTimeout(waitForSb, 500);
      }
      /* Retired 2026-08-24. There is no choice to make any more -- every
         merchant is flat Rs 200 -- so the chooser must never open. Bailing
         here rather than deleting the modal keeps the change small and
         reversible while bookings are live; the RPC is left deployed and
         simply never asked. */
      GATE.pending = false; GATE.open = false;
      if (true) return;

      Promise.resolve(sb.rpc("client_pricing_choice_state", {}))
        .then(function(r){
          if(!r || r.error || !r.data) return;
          var d = r.data;
          if(typeof d === "string"){ try{ d = JSON.parse(d); }catch(e){ return; } }
          if(!d) return;

          /* Straight after signup the workspace row can lag the first dashboard
             paint by a second or two. Without this retry a brand new merchant
             -- the one who most needs to pick a rate before their first
             booking -- would simply never be asked. */
          if(d.eligible === false && d.reason === "no_workspace" && ++wsTries <= 15){
            return setTimeout(waitForSb, 1000);
          }

          // Remember the answer either way so the booking form can key off it.
          if(window.state && state.client && d.mode) state.client.pricingMode = d.mode;

          if(d.eligible === true){
            // Claim the gate immediately, before the delay, so the review
            // prompt and the Autopilot intro know to stand down rather than
            // opening a second full-screen overlay on top of this one.
            GATE.pending = true;
            setTimeout(show, force ? 300 : 1800);
          } else {
            GATE.pending = false; GATE.open = false;
          }
        })
        .catch(function(){ GATE.pending = false; });
    })();
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ boot(false); });
  else boot(false);

  window.novaxPricingChooser = function(){ CHOSEN = null; boot(true); };
})();

