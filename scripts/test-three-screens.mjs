// Bulk booking, labels and pickup, and Home's wallet card were rebuilt on
// 8 Oct 2026. These checks keep the rebuild honest: every control the code
// drives still exists exactly once, the column guide matches the importer's
// own list, and the order of the blocks is the order a merchant works in.
// Reads the files only.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const html = readFileSync(new URL("../client.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../client-app.js", import.meta.url), "utf8");
const ok = (m) => console.log("ok - " + m);
const once = (id) => assert.equal(html.split('id="' + id + '"').length - 1, 1, id + " must exist exactly once");
const section = (id, next) => html.slice(html.indexOf('id="' + id + '"'), html.indexOf(next));

// Bulk booking
{
  const s = section("client-bulkBooking", "<!-- STORE CONNECTIONS");
  ["downloadBulkTemplateBtn","bulkCsvInput","bulkCsvHelp","bulkUploadBtn","bulkFileTile","bulkFileName","bulkFileHint","bulkValidationList","bulkPreviewPanel","bulkPreviewList","bulkPrintAllBtn"].forEach(once);
  assert.equal((s.match(/class="nvbk-step"/g) || []).length, 3, "three steps");
  assert.match(s, /<input id="bulkCsvInput" type="file" accept="\.csv,text\/csv" class="nvbk-input"/, "the browser's own file control is hidden behind the tile");
  assert.match(s, /<label class="nvbk-file" for="bulkCsvInput"/, "the tile opens the file picker");
  assert.ok(!s.includes('class="bulk-drop"'), "the old drop box is gone");
  const required = JSON.parse(/const required=(\["consignee"[^\]]+\])/.exec(app)[1]);
  const chips = (cls) => [...new RegExp('<div class="' + cls + '">(.*?)</div>').exec(s)[1].matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(chips("nvbk-chips"), required, "the guide lists exactly the columns the importer requires, in its order");
  assert.deepEqual(chips("nvbk-chips is-opt"), ["reference", "reference_no", "fragile"]);
  for (const t of ["Karachi, Lahore, Islamabad or Rawalpindi", "COD or Prepaid", "0.1–70 kg, like 1.5 kg or 500 g", "yes or no", "Checking a file books nothing"]) assert.ok(s.includes(t), t);
  assert.ok(app.includes('inp.addEventListener("change",function(){') && app.includes("window.nvBulkFileSync=function(){"), "a chosen file is named and checked");
  assert.ok(app.includes('if(nvIn) nvIn.value=""; if(typeof window.nvBulkFileSync==="function") window.nvBulkFileSync();'), "the tile resets after an import");
  ok("bulk booking: three steps, a file tile, a column guide tied to the importer, every control still there");
}

// Labels and pickup
{
  const s = section("client-awbLabel", "<!-- LOAD SHEET -->");
  ["newBookedSelectAllBtn","newBookedPrintBtn","newBookedPdfBtn","newBookedList","printAwbBtn","savePdfAwbBtn","waAwbBtn","awbJourneyBtn","awbLabelPreview","pickupEligibleList","nvPaManageBtn","nvPaChips","pickupAddress","nvPaSaveRow","nvPaQuickLabel","nvPaQuickSave","pickupDay","pickupSlot","pickupRequestedFor","pickupNote","requestPickupBtn","pickupBtnHint","pickupRequestList","nvPickupPanel"].forEach(once);
  const at = (t) => { const i = s.indexOf(t); assert.ok(i > -1, "missing " + t); return i; };
  assert.ok(at('id="newBookedList"') < at('id="nvPickupPanel"') && at('id="nvPickupPanel"') < at('id="awbLabelPreview"'), "print, then pickup, then the single-label preview");
  assert.ok(s.includes("Riders collect between 11 am and 9 pm on working days. Pickup is free in Karachi, Lahore, Islamabad and Rawalpindi."));
  assert.ok(!/Select unpicked|New booked AWBs/.test(s) && !app.includes("No New booked AWBs are available"), "no internal wording");
  assert.match(app, /<label class="ops-card nvlb-row"\$\{p\.awb===focusAwb\?' data-nv-focus="1"':''\}><input type="checkbox" class="newbooked-check"/);
  assert.match(app, /<button class="nvlb-cancel nv-nb-act" title="Cancel this booking" onclick="event\.preventDefault\(\);event\.stopPropagation\(\);deleteNewBooking\(/, "Cancel still stops the row's tick and still asks");
  assert.match(app, /<label class="ops-card nvlb-row"><input type="checkbox" class="pickup-check"/);
  assert.ok(app.includes('parcel${(pr.awbs||[]).length===1?"":"s"}') && !app.includes("AWB(s)</strong><span class=\"chip ${cls}\">"));
  ok("labels and pickup: every control still there, pickup straight after printing, plain wording, tidy rows");
}

// Home's wallet card and the order of Home
{
  assert.ok(html.includes("#nvCodHero .nv-cod-hero{position:relative;overflow:hidden;border:0;border-radius:20px"), "Home's card has the Wallet tab's skin");
  const skin = (sel) => new RegExp(sel.replace(/[.#\[\]"=]/g, "\\$&") + "\\{[^}]*?(radial-gradient\\([^;]+;)").exec(html)[1];
  assert.equal(skin("#nvCodHero .nv-cod-hero"), skin(".nvw-card"), "the same gradient as the Wallet tab's card");
  assert.equal(skin('#nvCodHero .nv-cod-hero[data-owe="1"]'), skin(".nvw-card.is-owe"), "and the same amber when the merchant owes");
  assert.ok(app.includes(`(Number(balance||0)<0?' data-owe="1"':'')`));
  assert.ok(html.includes("#client-dashboard .nv-instant{order:9}"), "Nova Instant sits at the foot of Home");
  const order = (sel) => Number(new RegExp("#client-dashboard " + sel.replace(/[.#]/g, "\\$&") + "\\{order:(\\d+)\\}").exec(html)[1]);
  assert.ok(order("#nvCodHero") < order("#clientDashboardMainGrid") && order("#clientDashboardMainGrid") < 9);
  ok("Home: the wallet card matches the Wallet tab, parcels follow it, Nova Instant comes last");
}
console.log("THREE SCREENS CHECKS PASSED");

// ── Later on 8 Oct: the invoice document, Profile and the Wallet's invoice cards ──
{
  const fnSrc = (name) => { const a = app.indexOf("    function " + name + "("); assert.ok(a > -1, "missing fn " + name); let i = app.indexOf("{", a), d = 0; for (; i < app.length; i++) { if (app[i] === "{") d++; else if (app[i] === "}") { d--; if (!d) break; } } return app.slice(a, i + 1); };
  // Invoice: the same parts, window and print path as receipts and statements.
  const inv = fnSrc("clientInvoiceHtml");
  assert.ok(inv.includes('return nvDocHead("Invoice", invType,') && inv.includes('class="nv-doc-grid"') && inv.includes('class="nv-doc-total"') && inv.includes('class="nv-doc-foot"'), "built from the shared document parts");
  assert.ok(!/font-family:\s*Arial/i.test(inv) && !inv.includes("nv-doc-paper"), "no page style of its own");
  assert.ok(!/var\(--nvu-/.test(inv), "white paper in both themes: no theme colours inside the document");
  assert.match(fnSrc("viewInvoice"), /nvOpenDoc\("Invoice "\+inv\.id, clientInvoiceHtml\(inv\), nvInvoiceCsvRows\(inv\)/);
  assert.match(fnSrc("printInvoice"), /nvPrintDoc\(clientInvoiceHtml\(inv\)\)/);
  assert.ok(fnSrc("downloadInvoiceCsv").includes("nvInvoiceCsvRows(inv)") && fnSrc("nvInvoiceCsvRows").includes('"payment_mode"') && fnSrc("nvInvoiceCsvRows").includes('line.billedNote||""'), "one CSV for the card and the window, payment mode and the note kept");
  for (const t of ["collected later &mdash; not on this invoice", "delivered after this invoice was made</b>", "summary totals are the ones that settle", "prepaid &mdash; no cash due", "not collected"]) assert.ok(inv.includes(t), t);
  ok("invoice: drawn, opened and printed like receipts and statements; figures and notes unchanged");

  // Wallet invoice cards.
  assert.ok(app.includes(`<div class="inline-actions nvinv-acts" style="margin-top:10px"><button class="ghost-btn nvinv-view" onclick="viewInvoice('\${inv.id}')">View invoice</button><button class="ghost-btn" onclick="printInvoice('\${inv.id}')">Print</button><button class="ghost-btn" onclick="downloadInvoiceCsv('\${inv.id}')">CSV</button></div>`));
  assert.ok(html.includes("#client-money .nvinv-acts{display:grid;grid-template-columns:minmax(0,1fr) auto auto !important"));
  ok("wallet: each invoice card has one clear action and two lesser ones on the same row");

  // Profile: sections that fold, nothing removed.
  const p = section("client-profile", 'id="client-subAccounts"');
  // (10 Oct 2026: "Business" was merged into "Business profile", so seven sections and the preview.)
  assert.equal((p.match(/<details class="panel[^"]* nv-pf-sec"/g) || []).length, 8, "seven sections and the preview");
  assert.equal((p.match(/<\/details>/g) || []).length, 8);
  assert.equal((p.match(/<summary class="section-head">/g) || []).length, 8);
  assert.equal((p.match(/nv-pf-sec"[^>]* open>/g) || []).length, 8, "all open in the page itself, so nothing is hidden without the script");
  assert.match(p, /<details class="panel nv-pf-sec" id="nvPfSecBrand" open>\s*<summary class="section-head"><div><h3>Business profile<\/h3>/, "the first section never starts shut");
  assert.equal((p.match(/data-nv-fold="phone"/g) || []).length, 6);
  assert.match(p, /id="nvKycPanel" data-nv-fold="phone-verified" open>/, "the CNIC section starts shut only once verified");
  ["nvPfLogo","nvPfName","nvPfAccent","nvPfPhone","nvPfWa","nvPfEmail","nvPfWeb","nvPfType","nvPfAddr","nvPfTrackOn","nvPfCity","nvPfCityReq","nvKycPanel","nvKycSend","nvKycReplace","nvPfHistory","nvPfSaveBar","nvPfSave","nvPfDiscard","nvPfPvTrack"].forEach(once);
  const fold = fnSrc("nvPfFoldOnce");
  assert.ok(fold.includes('matchMedia("(max-width:760px)")') && fold.includes("if(NV_PF.folded) return; NV_PF.folded=true;"), "phones only, once per visit");
  assert.ok(!/nvPfEl\("nvPf[A-Za-z]+"\)\.focus\(\)/.test(app) && fnSrc("nvPfShow").includes("d.open=true"), "a save that fails on a field opens its section");
  ok("profile: seven folding sections, every field still in the page, phones start with the first one open");

  // Profile, 10 Oct 2026: the form must fill the first time, whatever loaded first.
  {
    const load = fnSrc("nvPfLoad");
    assert.ok(load.includes("if(!NV_PF.filled || !nvPfDirty()) nvPfFill(); else { nvPfHistory(); nvPfHeroPaint(); }"), "an unfilled form is always filled");
    assert.ok(fnSrc("nvPfFill").includes("NV_PF.filled=true;") && fnSrc("nvPfDirty").includes("if(!NV_PF.loaded || !NV_PF.filled) return false;"));
    assert.ok(fnSrc("nvPfSave").includes("if(NV_PF.saving || !NV_PF.loaded || !NV_PF.filled) return;"), "a form that was never filled cannot be saved");
    // Run the real functions in the order a signed-in page runs them: data arrives while the form is empty.
    const els = {}; const el = (id) => (els[id] = els[id] || { id, value: "", checked: false, hidden: false, textContent: "", style: { setProperty() {} }, classList: { toggle() {}, remove() {}, add() {}, contains: () => false }, setAttribute() {}, querySelectorAll: () => [], innerHTML: "" });
    const doc = { getElementById: (id) => (/^(nvPfLoadErr|nvPfName|nvPfPhone|nvPfEmail|nvPfWeb|nvPfType|nvPfAddr|nvPfWa|nvPfAccent|nvPfTrackOn)$/.test(id) ? el(id) : null), querySelectorAll: () => [] };
    const real = { name: "KKM Test", phone: "03001234567", email: "a@b.pk", website: "", business_type: "Sweets", address: "Shop 1, Lahore", accent: "", whatsapp: "", tracking_on: false, logo_url: "", is_owner: true };
    const sb = { rpc: () => Promise.resolve({ data: real, error: null }), from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    const win = { __nvSb: sb, __NOVAX_DEMO: false };
    const src = /    var NV_PF=\{[^;]*\};/.exec(app)[0] + 'var NV_PF_DEFAULT_ACCENT="#0c7c59";' +
      ["nvPfEl", "nvPfOwner", "nvPfVal", "nvPfValues", "nvPfBaseline", "nvPfDirty", "nvPfFill", "nvPfLoad"].map((n) => fnSrc(n)).join("\n") +
      "function nvPfSync(){} function nvPfHistory(){} function nvPfHeroPaint(){} function nvPfWorkspace(){} return { NV_PF, nvPfLoad, nvPfDirty };";
    const api = new Function("document", "window", "state", src)(doc, win, { client: { name: "KKM Test" } });
    await api.nvPfLoad(false);
    assert.equal(els.nvPfName.value, "KKM Test", "the name is in the form");
    assert.equal(els.nvPfAddr.value + "|" + els.nvPfEmail.value + "|" + els.nvPfType.value, "Shop 1, Lahore|a@b.pk|Sweets", "and so are the optional details a blank form used to wipe");
    assert.equal(api.nvPfDirty(), false, "nothing reads as changed");
    els.nvPfType.value = "Sweets and nimco";
    await api.nvPfLoad(true);
    assert.equal(els.nvPfType.value, "Sweets and nimco", "typing that is not saved yet survives a reload in the background");
    ok("profile: the form fills on first load even when the details arrived before the tab was opened");
  }
  // Profile header and jump links.
  {
    ["nvPfHero","nvPfHeroLogo","nvPfHeroName","nvPfHeroSub","nvPfMeter","nvPfMeterN","nvPfMeterFill","nvPfTodo","nvPfNav","nvPfSecBrand","nvPfSecContact","nvPfSecTrack","nvPfSecAccount","nvPfSecNotify","nvPfSecHistory"].forEach(once);
    const jumps = [...p.matchAll(/data-nv-pf-jump="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(jumps, ["nvPfSecBrand", "nvPfSecContact", "nvPfSecTrack", "nvKycPanel", "nvPfSecAccount", "nvPfSecNotify", "nvPfSecHistory"], "one link for each section, in page order");
    const order = [...p.matchAll(/<details class="panel[^"]* nv-pf-sec"(?: id="(\w+)")?/g)].map((m) => m[1]).filter(Boolean);
    assert.deepEqual(order, jumps, "and the sections are in that order");
    const parts = /var NV_PF_PARTS=\[([\s\S]*?)\];/.exec(app)[1];
    for (const m of parts.matchAll(/\["(\w+)","[^"]+","(\w+)","([^"]+)"\]/g)) { assert.ok(p.includes('id="' + m[2] + '"'), m[2] + " is a real field"); assert.ok(!/\(s\)/.test(m[3]) && /^[A-Z]/.test(m[3])); }
    assert.equal([...parts.matchAll(/\["\w+"/g)].length, 7, "seven details and the CNIC make eight");
    ok("profile: header with what is missing, and a link to every section");
  }
}
console.log("INVOICE, PROFILE AND WALLET CARD CHECKS PASSED");

// ── Later again on 8 Oct: bulk results, Home's figures, "(s)" wording, heading chips, the AI button ──
{
  // Wording: nothing a merchant reads counts with "(s)".
  const left = [...app.matchAll(/\b(rows?|AWBs?|orders?|issues?|columns?|drafts?|requests?|invoices?|withdrawals?|parcels?|labels?|bookings?)\(s\)/g)].map((m) => m[0]);
  assert.deepEqual(left, [], "messages still written with (s): " + left.join(", "));
  assert.ok(!/\(s\)/.test(html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")), "no (s) in the page's own text");
  const win = {}; new Function("window", /window\.nvCount=function\(n,one,many\)\{[\s\S]*?\n\};/.exec(app)[0])(win);
  assert.equal(win.nvCount(1, "row"), "1 row"); assert.equal(win.nvCount(2, "row"), "2 rows"); assert.equal(win.nvCount(0, "row"), "0 rows");
  assert.equal(win.nvCount(1, "city", "cities"), "1 city"); assert.equal(win.nvCount(3, "city", "cities"), "3 cities"); assert.equal(win.nvCount(1200, "parcel"), "1,200 parcels");
  ok('wording: one counting helper, and no "row(s)", "AWB(s)" or "order(s)" left');

  // Bulk results: a verdict and only the problems that exist.
  assert.ok(app.includes('<div class="nvbr ${invalidRows.length?"is-bad":"is-ok"}">') && app.includes("ready to book</span>"));
  assert.ok(!app.includes('["Total rows",results.length,""]') && !app.includes("Duplicate reference numbers"), "the eleven count boxes are gone");
  assert.ok(app.includes(".filter(k=>k[1]>0)"), "a problem is named only when the file has it");
  assert.ok(html.includes(".nvbr{margin-bottom:12px"));
  ok("bulk results: rows checked, ready, needing a fix, and only the problems this file has");

  // Home's figures.
  assert.ok(html.includes('<h3>Figures for <span id="nvRangeLabel">all time</span></h3>') && !html.includes("Tap to change the dates for the figures below"));
  ["accountHistoryHead", "accountHistoryChevron", "accountHistoryBody", "clientDateFrom", "clientDateTo", "applyDateRangeBtn", "nvRangeLabel"].forEach(once);
  assert.ok(app.includes('metricCard("Parcels",cm.total,null,"booked in these dates"') && !app.includes("bar = average journey progress"));
  assert.ok(app.includes("function nvRangeLabel(){") && app.includes("nvRangePaint();"));
  ok("home: the strip names the dates the figures cover, and Parcels is a count with no bar to explain");

  // A chip in a heading is a pill, not a bar.
  assert.ok(html.includes(".section-head>.chip{justify-self:start;align-self:flex-start;width:auto"));
  ok('headings: a count or status chip ("0 open", "Live") keeps its own width on phones');

  // The AI button never rests on a control.
  assert.ok(app.includes("var covers = function(){") && app.includes('el.closest("button,a[href],input,select,textarea,summary")'));
  assert.ok(app.includes("if(covers()){ tuck(); return; }") && app.includes('btn.style.translate="none"'));
  ok("AI button: before it returns it checks what lies under its spot, and stays tucked over a button, link or field");
}
console.log("BULK RESULTS, HOME FIGURES, WORDING, CHIPS AND AI BUTTON CHECKS PASSED");

// Store connections, Team, the customer history note and the menu names
// (8 Oct 2026). Every id the code drives is still there exactly once.
{
  // Store connections
  const s = section("client-integrations", "<!-- FULL REPORT -->");
  ["nvShopifyAppPanel","nvShopifyChip","nvShopifyStores","nvShopifyConnectIntro","nvShopifyCodeBtn","nvShopifyCodeOut","nvWooPanel","wooStatusChip","wooStoreUrl","wooKey","wooSecret","wooWebhookResult","wooIntakeUrlOut","wooSecretOut","nvWebPanel","webStatusChip","webEndpoint","webKey","webWebhookResult","webIntakeUrlOut","webSecretOut"].forEach((id) => { once(id); assert.ok(s.includes('id="' + id + '"'), id + " is inside Store connections"); });
  for (const h of ['onclick="nvShopifyConnectPopup(true)"', "onclick=\"connectStore('woocommerce')\"", "onclick=\"connectStore('web')\"", "copyFieldValue('wooIntakeUrlOut')", "copyFieldValue('wooSecretOut')", "copyFieldValue('webIntakeUrlOut')", "copyFieldValue('webSecretOut')"]) assert.ok(s.includes(h), "handler kept: " + h);
  assert.equal((s.match(/class="panel[^"]*\bnvsc\b/g) || []).length, 3, "one card per store");
  assert.ok(!s.includes('<span class="chip good">Live</span>') && s.includes('<span class="chip" id="nvShopifyChip" hidden></span>'), "no Live badge before a store is connected");
  assert.ok(!s.includes("nv-pf-moved") && !s.includes(">Retired<"), "the two leftover panels are gone");
  assert.ok(s.includes("Using the old Shopify webhook setup?") && s.includes("Existing connections keep working"), "the old-setup note is kept, folded");
  assert.ok(s.includes("An order is booked once, when it reaches <b>Processing</b>") && s.includes("Weight starts at 0.5 kg"), "the WooCommerce facts are word for word");
  assert.ok(app.includes('badge.textContent=liveN?(liveN===1?"Connected":liveN+" stores connected"):"Not connected";'), "the Shopify badge is what the server answered");
  assert.ok(app.includes('x.status==="uninstalled"?"App removed"'), "a removed app is named in plain words");
  assert.ok(!app.includes('" &middot; "+c.importedCount'), "no HTML entity written as text");
  assert.ok(app.includes('if(d && c && c.connected && d.dataset.nvAuto!=="1"){ d.dataset.nvAuto="1"; d.open=true; }'), "a connected store opens its own card once");
  ok("store connections: three cards, real status, numbered steps, every field and handler kept");

  // Team
  const t = section("client-subAccounts", "<!-- AI SUPPORT -->");
  once("inviteUserBtn"); once("subAccountList");
  assert.ok(t.includes("<h3>Team</h3>") && !/Maker Checker|Manual Status Edit|Sub accounts/.test(t), "plain words");
  const sum = new Function(/function nvRolePermissionSummary\(role\)\{[\s\S]*?\n    \}/.exec(app)[0] + "; return nvRolePermissionSummary;")();
  for (const r of ["Owner", "Finance", "Warehouse", "Support"]) assert.ok(t.includes("<b>" + r + "</b><span>" + sum(r) + "</span>"), "the page and the code say the same about " + r);
  assert.ok(!app.includes("subAccountEmptyInvite") && !app.includes('<span class="chip">empty</span>'), "one invite button, no 'empty' tag");
  assert.ok(app.includes('data-nv-revoke="') && app.includes('sb.rpc("revoke_staff_user",{ p_staff_id:id })'), "removing access still calls the same server function");
  {
    // Draw the real list for an empty team and for three kinds of row.
    const src = /function renderSubAccounts\(\)\{[\s\S]*?\n    \}\n/.exec(app)[0];
    const draw = (rows) => {
      const host = { innerHTML: "", querySelectorAll: () => [] };
      new Function("document", "__nvStaffRows", "__nvStaffLoading", "__nvStaffError", "NOVAX_ROLE_TABS", "nvRolePermissionSummary", "escLabelText", "nvDateTime", "revokeSubAccountUser", src + "renderSubAccounts();")(
        { getElementById: () => host }, rows, false, null, { Owner: [], Finance: [], Warehouse: [], Support: [] }, sum, (x) => String(x).replace(/[&<>"]/g, ""), (x) => "on " + x, () => {});
      return host.innerHTML;
    };
    const empty = draw([]);
    assert.ok(empty.includes("It is just you so far") && !empty.includes("<button"), "the empty team is a note, not a second button");
    const list = draw([{ id: "a1", name: "Sara", email: "sara@example.com", role: "Finance", status: "Active", last_active_at: "5 Oct" },
                       { id: "b2", name: "", email: "ali@example.com", role: "Warehouse", status: "pending", last_active_at: null },
                       { id: "c3", name: "Old", email: "old@example.com", role: "Support", status: "revoked", last_active_at: null }]);
    assert.ok(list.includes('<span class="chip good">Active</span>') && list.includes('<span class="chip warn">Pending</span>') && list.includes('<span class="chip bad">Access removed</span>'));
    assert.ok(list.includes("Last active on 5 Oct") && list.includes("Has not signed in yet") && list.includes("<strong>Finance</strong> — " + sum("Finance")));
    assert.equal((list.match(/data-nv-revoke="/g) || []).length, 2, "no Remove access button on a login already removed");
    assert.ok(list.includes('data-nv-revoke="a1">Remove access</button>'));
  }
  ok("team: renamed, the four roles in the code's own words, one way to add someone");

  // Menu names
  for (const b of ['data-client-tab="awbLabel">Labels and pickup<', 'data-client-tab="subAccounts">Team<', 'data-client-tab="integrations">Store connections<', 'data-acct="subAccounts">Team<', 'data-acct="integrations">Store connections<']) assert.ok(html.includes(b), b);
  assert.ok(app.includes('["awbLabel","Labels and pickup","Print AWB labels, request a pickup"]') && app.includes('["subAccounts","Team","Logins for your staff, sub accounts"]') && app.includes('["integrations","Store connections","Shopify, WooCommerce, API integrations"]'), "search finds them by the new and the old words");
  assert.ok(!/AWB tab|AWB Label tab|Open AWB Tab|the API tab|Open Integrations/.test(app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")), "no message still names the old tabs");
  const mail = readFileSync(new URL("../supabase/functions/novax-email-drain/templates.ts", import.meta.url), "utf8");
  assert.ok(!mail.includes("AWB label tab") && mail.includes("from Labels and pickup, in the menu"), "the emails name the tab as the menu does");
  ok("menu: Labels and pickup, Team, Store connections, in the menu, the search, the messages and the emails");

  // Support tab and Profile
  const supAt = html.indexOf('id="client-support"'), sup = html.slice(supAt, html.indexOf("</section>", supAt));
  assert.ok(!sup.includes("Your business name") && !html.includes("nv-pf-moved\">"), "the pointer panels are gone");
  ["notifPrefWhatsapp","notifPrefSms","notifPrefEmail","notifPrefEventsGrid","notifPrefStatus","notifPrefSaveBtn"].forEach((id) => { once(id); assert.ok(sup.includes('id="' + id + '"'), id + " stays on the tab that loads it"); });
  const prof = section("client-profile", 'id="nvPfSaveBar"');
  assert.ok(prof.includes("<h3>What NovaX sends you</h3>") && prof.includes("<b>Account emails</b>") && !sup.includes("What NovaX sends you</h3>"), "the notification facts live in Profile");
  ok("support tab: only the assistant; what NovaX sends you is in Profile");

  // Customer history at booking
  once("consigneeHistoryBadge");
  assert.ok(app.includes('var back=Number(d.refused||0)+Number(d.returned||0)+inStatus(["Return in transit"]);') && app.includes("if(back>0){"), "a returned parcel counts, not only one still marked Refused");
  {
    // Run the real function on each kind of history.
    const src = /function nvConsigneeBadge\(\)\{[\s\S]*?\n    \}\n/.exec(app)[0];
    const win = {}; new Function("window", /window\.nvCount=function\(n,one,many\)\{[\s\S]*?\n\};/.exec(app)[0])(win);
    const paint = /    function nvConsigneePaint\(host\)\{[\s\S]*?\n    \}\n/.exec(app)[0];
    const run = async (data, net) => {
      const host = { style: {}, innerHTML: "" }, input = { value: "0300 1234567" };
      const window = { __nvSb: { rpc: (name) => Promise.resolve(name === "client_phone_network_risk" ? (net === "fail" ? { data: null, error: { message: "denied" } } : { data: { level: net || "none" }, error: null }) : { data, error: null }) }, nvCount: win.nvCount };
      const document = { getElementById: (id) => (id === "bookingPhone" ? input : host) };
      new Function("document", "window", "nvSetHtml", "nvCount", "var NV_CONSIGNEE_LAST='', NV_CONSIGNEE_PARTS={ own:'', net:'' };" + paint + src + "nvConsigneeBadge();")(document, window, (h, x) => { h.innerHTML = x; }, win.nvCount);
      await new Promise((r) => setTimeout(r, 5));
      return host.style.display === "none" ? "" : host.innerHTML.replace(/<[^>]+>/g, " ").replace(/&#\d+;/g, "").replace(/\s+/g, " ").trim();
    };
    assert.equal(await run({ total_parcels: 2, delivered: 1, refused: 0, returned: 1, recent: [] }), "1 parcel to this customer came back, 1 delivered Refused or returned. Call to confirm the order before you book it.");
    assert.equal(await run({ total_parcels: 1, delivered: 0, refused: 0, returned: 0, recent: [{ status: "Return in transit" }] }), "This customer's last parcel came back Refused or returned. Call to confirm the order before you book it.");
    assert.equal(await run({ total_parcels: 3, delivered: 0, refused: 1, returned: 2, recent: [] }), "All 3 parcels to this customer came back Refused or returned. Call to confirm the order before you book it.");
    assert.equal(await run({ total_parcels: 3, delivered: 3, refused: 0, returned: 0, recent: [] }), "3 parcels delivered to this customer before");
    assert.equal(await run({ total_parcels: 1, delivered: 0, refused: 0, returned: 0, recent: [{ status: "Parcel now in transit" }] }), "1 parcel to this number on the way now Check this is not the same order twice.");
    assert.equal(await run({ total_parcels: 1, delivered: 0, refused: 0, returned: 0, recent: [{ status: "Cancelled by client" }] }), "", "a cancelled booking is not a history");
    assert.equal(await run({ total_parcels: 0, delivered: 0, refused: 0, returned: 0, recent: [] }), "", "a new customer shows nothing");
    assert.equal(await run({ error: "no_client" }), "");
    // The shared flag from other NovaX sellers (9 Oct 2026): one line, no detail.
    assert.equal(await run({ total_parcels: 0, recent: [] }, "some"), "A parcel to this number came back from another NovaX seller Call to confirm the order before you book it.");
    assert.equal(await run({ total_parcels: 0, recent: [] }, "high"), "Several parcels to this number came back from other NovaX sellers Call to confirm the order before you book it.");
    assert.equal(await run({ total_parcels: 3, delivered: 3, refused: 0, returned: 0, recent: [] }, "some"),
      "3 parcels delivered to this customer before A parcel to this number came back from another NovaX seller Call to confirm the order before you book it.", "own history first, then the shared flag");
    assert.equal(await run({ total_parcels: 0, recent: [] }, "fail"), "", "a refused or failed lookup shows nothing");
    const risk = readFileSync(new URL("../sql_novax_network_risk_20261009.sql", import.meta.url), "utf8");
    assert.ok(/return jsonb_build_object\('level',\s*case/.test(risk) && !/jsonb_build_object\([^)]*(awb|consignee|client_id|address|v_back|v_deliv)/.test(risk.replace(/case when[\s\S]*?end\)/, "")), "only a level leaves the database: no seller, name, address or count");
    assert.ok(risk.includes("if v_n > 300 then") && risk.includes("p.client_id <> c") && risk.includes("interval '180 days'") && risk.includes("revoke all on function public.client_phone_network_risk(text) from public, anon;"), "other sellers only, 180 days, 300 lookups a day, signed-in sellers only");
  }
  assert.ok(app.includes("Call to confirm the order before you book it."));
  assert.ok(html.includes(".nv-chist.warn{background:var(--nvu-warn-bg)"));
  ok("booking: the note warns when this customer's earlier parcels came back");
}
console.log("STORE CONNECTIONS, TEAM, MENU NAMES, SUPPORT TAB AND BOOKING NOTE CHECKS PASSED");

// Colours (9 Oct 2026). A contrast pass found white text on the accent colour
// in dark mode (2.2:1) on the booking button, the booked card and five other
// places, and the booked card's tracking number at 1.25:1. The rule these
// checks hold: text on a themed background takes its colour from the same
// token set, never a fixed hex.
{
  const rules = (src) => [...src.matchAll(/([^{}]{0,90})\{([^{}]*)\}/g)];
  const onAccent = (b) => /background(?:-color)?\s*:\s*(?:linear-gradient\([^;]*)?var\(--nvu-accent\b/.test(b);
  const fixedText = (b) => /(?:^|[;{\s])color\s*:\s*(?:#[0-9a-f]{3,8}\b|white\b|rgba?\()/i.test(b);
  const bad = [...rules(html), ...rules(app)].filter((m) => onAccent(m[2]) && fixedText(m[2])).map((m) => m[1].trim().slice(-50));
  assert.deepEqual(bad, [], "text on the accent colour uses --nvu-accent-ink");
  assert.ok(!/color:#04140d;/.test(app), "the sign-in again buttons use the accent's own ink");
  const fs = /var css="\.nvfs-overlay[\s\S]*?css\+=cssExtra;/.exec(app)[0];
  assert.ok(!/#eafff5|#0f2e22|#3a6b5a|#6b8f80|#bfe8d7|#8fd8b9|color:#fff/.test(fs), "the booked card has no fixed colours left");
  assert.ok(fs.includes(".nvfs-awb{font-weight:800;font-size:15px;color:var(--nvu-ink);"), "the tracking number is the main ink");
  const ck = /'#nvck \.nvck-top\{[\s\S]*?'@media \(max-width:560px\)\{#nvck/.exec(app)[0];
  assert.ok(!/color:#(6b7d74|9fb3ab|7c8b86|0b1512)|background:#eafff5/.test(ck), "the search palette follows the theme");
  assert.ok(html.includes('id="bookingConfirmLine" style="display:none;margin-top:12px;font-weight:700;color:var(--green-ink)"') && !/color:var\(--green\)"/.test(html), "--green has no dark value, so it is not a text colour");
  assert.ok(html.includes(".nv-notice-warm strong{ color:var(--nvu-warn-fg) !important; }") && html.includes(".nv-w2-rail li.is-empty strong,.nv-w2-rail li.is-empty em{color:var(--nvu-ink-3)}"));
  assert.ok(html.includes("opacity:.48 !important;"), "placeholders stay faint on purpose (19 Aug 2026): do not 'fix' them here");
  ok("colours: text on a themed background comes from the same token set");
}
console.log("COLOUR CHECKS PASSED");

// Payout fees (9 Oct 2026): a flat fee for each withdrawal, never a share of
// the amount. The database, the portal, the admin page and the public pages
// must all quote the same three numbers.
{
  const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
  const sql = read("sql_novax_payout_flat_fees_20261009.sql"), admin = read("admin.html"), home = read("index.html"), cod = read("when-is-cod-paid.html"), agent = read("supabase/functions/novax-site-agent/index.ts");
  const db = /case p_speed when 'instant' then (\d+) when '12h' then (\d+) else (\d+) end/.exec(sql).slice(1).map(Number);
  assert.deepEqual(db, [500, 100, 0], "the database charges Rs 500 / Rs 100 / nothing");
  const portal = JSON.parse(/const WALLET_FEE=(\{[^}]*\});/.exec(app)[1]);
  assert.deepEqual([portal.instant, portal["12h"], portal["24h"]], db, "the portal previews what the database charges");
  const adminFee = new Function(/function walletFee\(speed\) \{[\s\S]*?\n    \}/.exec(admin)[0] + "; return walletFee;")();
  assert.deepEqual([adminFee("instant"), adminFee("12h"), adminFee("24h")], db, "so does the admin page");
  assert.deepEqual([...home.matchAll(/<tr data-fee="(\d+)"><th scope="row">([^<]+)</g)].map((m) => m[2] + "=" + m[1]), ["Nova Saver=0", "Nova Express=100", "Nova Bolt=500"], "and the homepage table");
  for (const [name, src] of [["portal", app], ["portal page", html], ["admin", admin], ["homepage", home], ["COD page", cod], ["site assistant", agent]]) {
    assert.ok(!/0\.[137] ?%|data-pct|walletFeePct|walletFeeRate/.test(src), name + " quotes no percentage fee");
    assert.ok(src.includes("Nova Saver") && src.includes("Nova Express") && src.includes("Nova Bolt"), name + " names the three speeds");
  }
  assert.ok(/var NV_FLAT_FEES_FROM="2026-10-09 \d\d:\d\d";/.test(app) && /const NV_FLAT_FEES_FROM = "2026-10-09 \d\d:\d\d";/.test(admin), "the change time is set");
  assert.equal(/var NV_FLAT_FEES_FROM="([^"]+)"/.exec(app)[1], /const NV_FLAT_FEES_FROM = "([^"]+)"/.exec(admin)[1], "portal and admin agree on when it changed");
  assert.ok(sql.includes("if v_fee > 0 and p_amount < v_fee + 1 then") && app.includes("function walletSpeedMin(s){ return walletFee(s)+1; }"), "a paid speed needs its fee plus Rs 1, on the server and in the preview");
  ok("payout fees: flat Rs 0 / 100 / 500 in the database, portal, admin, homepage, COD page and site assistant");
}
console.log("PAYOUT FEE CHECKS PASSED");

// The customer's answer from the tracking page (9 Oct 2026): saved in its own
// closed table, shown to the seller on Home and in the parcel drawer, and to
// the rider on the parcel card.
{
  const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
  const sql = read("sql_novax_customer_replies_20261009.sql"), rider = read("rider-app.js"), trk = read("tracking.html");
  assert.ok(sql.includes("revoke all on table public.nv_customer_replies from public, anon, authenticated;") && sql.includes("enable row level security"), "the table is closed to the API");
  assert.ok(!/update\s+public\.parcels|update public\.parcels/i.test(sql), "an answer never changes a parcel");
  assert.ok(sql.includes("if v_n >= 6 then") && sql.includes("char_length(v_note) < 8") && sql.includes("length(btrim(coalesce(p_token, ''))) < 20"), "daily limit, a real address, a real link");
  assert.ok(sql.includes("grant execute on function public.client_customer_replies() to authenticated;") && sql.includes("revoke all on function public.client_customer_replies() from public, anon;"), "only a signed-in seller reads their own answers");
  const choices = (src) => [...new Set([...src.matchAll(/\b(home_today|tomorrow|call_first|wrong_address)\b/g)].map((m) => m[1]))].sort();
  for (const [n, src] of [["database", sql], ["tracking page", trk], ["portal", app], ["rider app", rider]]) assert.deepEqual(choices(src), ["call_first", "home_today", "tomorrow", "wrong_address"], n + " knows the same four answers");
  assert.ok(rider.includes("m.customerReply = p.customer_reply || null;") && rider.includes('class="swaptag custsay"') && /esc\(cr\.note\)/.test(rider), "the rider's card shows it, escaped");
  once("nvCustSay");

  // Draw the real Home card and drawer line.
  const pick = (name) => new RegExp("    function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n    \\}\\n").exec(app)[0];
  const host = { hidden: true, innerHTML: "" }, store = {};
  const win = {}; new Function("window", /window\.nvCount=function\(n,one,many\)\{[\s\S]*?\n\};/.exec(app)[0])(win);
  const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
  const api = new Function("document", "localStorage", "state", "activeClientId", "escLabelText", "nvCount",
    /var NV_CS=\{[^;]*\};/.exec(app)[0] + /var NV_CS_SAY=\{[\s\S]*?\};/.exec(app)[0] +
    ["nvCustReply", "nvCustWhen", "nvCustDrawerHtml", "nvCustPaint"].map(pick).join("") + "return { NV_CS, nvCustDrawerHtml, nvCustPaint };")(
    { getElementById: () => host }, { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    { parcels: [{ awb: "N1", clientId: "c1", consignee: "Hina", status: "Parcel out for delivery" }, { awb: "N2", clientId: "c1", consignee: "<b>Ali</b>", status: "Refused" },
                { awb: "N3", clientId: "c1", consignee: "Done", status: "Delivered" }, { awb: "N4", clientId: "c2", consignee: "Other shop", status: "Reattempt" }] },
    () => "c1", (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), win.nvCount);
  api.nvCustPaint(); assert.equal(host.hidden, true, "nothing to show, nothing drawn");
  api.NV_CS.map = { N1: { awb: "N1", choice: "call_first", note: null, at: iso(now - 3600e3) }, N2: { awb: "N2", choice: "wrong_address", note: "<script>x</script> House 9", at: iso(now - 7200e3) },
                    N3: { awb: "N3", choice: "tomorrow", at: iso(now - 600e3) }, N4: { awb: "N4", choice: "tomorrow", at: iso(now - 600e3) }, N1old: { awb: "N1old", choice: "tomorrow", at: iso(now - 9 * 864e5) } };
  api.nvCustPaint();
  assert.equal(host.hidden, false);
  assert.ok(host.innerHTML.includes("<h3>2 customers answered on the tracking page</h3>"), "delivered parcels and other shops are left out");
  assert.ok(host.innerHTML.indexOf('data-nv-cust-open="N1"') < host.innerHTML.indexOf('data-nv-cust-open="N2"'), "newest first");
  assert.ok(host.innerHTML.includes("Asked the rider to call first") && host.innerHTML.includes("Says the address is wrong: &lt;script&gt;x&lt;/script&gt; House 9") && host.innerHTML.includes("&lt;b&gt;Ali&lt;/b&gt;"), "the customer's words are escaped");
  store["nvCustSeen:c1"] = api.NV_CS.map.N1.at; api.nvCustPaint();
  assert.equal(host.hidden, true, '"Got it" hides the card until a newer answer arrives');
  const dr = api.nvCustDrawerHtml({ awb: "N2" });
  assert.ok(dr.includes("<span>Customer says</span>Says the address is wrong: <b>&lt;script&gt;x&lt;/script&gt; House 9</b>") && dr.includes("The address on the parcel has not changed"), "the drawer says the parcel itself was not edited");
  assert.equal(api.nvCustDrawerHtml({ awb: "N9" }), "");
  ok("customer answers: closed table, same four answers everywhere, Home card and drawer line drawn and escaped, rider card wired");
}
console.log("CUSTOMER ANSWER CHECKS PASSED");

// Home: every parcel on one line (9 Oct 2026). The line is drawn from the
// same "needs you" set as the list below it, so the two cannot disagree.
{
  once("nvParcelLine");
  assert.ok(html.includes("#client-dashboard:not(.nv-figs-open) #clientMetrics{display:none!important}") && app.includes('dash.classList.toggle("nv-figs-open", !open);'), "the period boxes fold under the figures strip");
  assert.ok(html.includes('<span class="nv-range-change">Show figures <span id="accountHistoryChevron"'), "the strip says what it opens");
  assert.ok(/\.nvln-track\.is-moving::after\{[^}]*animation:nvlnFlow/.test(html) && html.includes(".nvln-track.is-moving::after{display:none}"), "the moving pulse is decoration, and stops for reduced motion");
  const pick = (name) => new RegExp("    function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n    \\}\\n").exec(app)[0];
  const win = {}; new Function("window", /window\.nvCount=function\(n,one,many\)\{[\s\S]*?\n\};/.exec(app)[0])(win);
  const host = { hidden: true, innerHTML: "" }, hrs = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const P = (awb, status, h, extra) => Object.assign({ awb, clientId: "c1", consignee: "Hina <b>", city: "Karachi", status, statusSince: hrs(h) }, extra || {});
  const state = { parcels: [] }; let needs = [];
  const api = new Function("document", "state", "activeClientId", "nvAttentionParcels", "escLabelText", "nvCount", "nvStatusLabel", "openClientParcelJourney",
    /var NV_LN=\{[^;]*\};/.exec(app)[0] + /var NV_LN_STOPS=\[[\s\S]*?\];/.exec(app)[0] + /var NV_LN_SIDE=\{[^;]*\};/.exec(app)[0] +
    ["nvLineData", "nvLineAge", "nvLineRows", "nvLineRender"].map(pick).join("") + "return { NV_LN, nvLineData, nvLineRender };")(
    { getElementById: () => host }, state, () => "c1", () => needs.map((awb) => ({ awb })),
    (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), win.nvCount, (s) => s, () => {});

  api.nvLineRender(); assert.equal(host.hidden, true, "an account with no parcels shows no line");
  state.parcels = [
    P("B1", "New booked", 2), P("K1", "Arrived at warehouse", 5), P("T1", "Parcel now in transit", 80), P("T2", "Parcel received at destination", 4),
    P("O1", "Parcel out for delivery", 3), P("O2", "Reattempt", 60), P("D1", "Delivered", 30, { deliveredAt: hrs(30) }), P("D2", "Delivered", 400, { deliveredAt: hrs(400) }),
    P("R1", "Refused", 20), P("N1", "Consignee not available", 9), P("X1", "Return in transit", 50), P("X2", "Return to shipper", 300), P("C1", "Cancelled by client", 10),
    Object.assign(P("Z1", "Parcel now in transit", 2), { clientId: "other-shop" })
  ];
  needs = ["T1", "O2", "R1", "N1", "X1"];
  const d = api.nvLineData(), ids = (k) => d.g[k].map((p) => p.awb).join(",");
  assert.deepEqual([ids("booked"), ids("picked"), ids("transit"), ids("out"), ids("done"), ids("stopped"), ids("back")], ["B1", "K1", "T1,T2", "O2,O1", "D1", "R1,N1", "X1"],
    "each parcel sits at the stop it reached; amber first; old deliveries, finished returns, cancelled parcels and other shops are left out");
  api.nvLineRender();
  assert.equal(host.hidden, false);
  assert.ok(host.innerHTML.includes("<p>6 parcels on the way · 4 need you. Tap a stop to see them.</p>"), "the heading counts what is moving and what needs the merchant");
  const stop = (k) => new RegExp('<button type="button" class="([^"]*)" data-nvln="' + k + '"[^>]*aria-label="([^"]*)">').exec(host.innerHTML);
  assert.match(stop("transit")[2], /^In transit: 2 parcels, 1 need you$/); assert.ok(stop("transit")[1].includes("has-amber"));
  assert.match(stop("booked")[2], /^Booked: 1 parcel$/); assert.ok(!stop("booked")[1].includes("has-amber"));
  assert.ok(host.innerHTML.includes('data-nvln="stopped" aria-expanded="false"><i aria-hidden="true"></i>2 stopped at the door') && host.innerHTML.includes("1 coming back"));
  assert.equal((host.innerHTML.match(/<i class="amber"><\/i>/g) || []).length, 2, "one amber dot for each stuck parcel on the line");
  const before = host.innerHTML; api.nvLineRender(); assert.equal(host.innerHTML, before, "nothing changed, nothing redrawn");
  api.NV_LN.open = "transit"; api.nvLineRender();
  assert.ok(host.innerHTML.indexOf('data-nvln-awb="T1"') < host.innerHTML.indexOf('data-nvln-awb="T2"') && host.innerHTML.includes("3 days at this step · needs you"), "the stuck one leads its list and says why");
  assert.ok(host.innerHTML.includes("Hina &lt;b&gt;") && !host.innerHTML.includes("Hina <b>"), "names are escaped");
  for (let i = 0; i < 12; i++) state.parcels.push(P("B" + (10 + i), "New booked", 1));
  api.NV_LN.open = "booked"; api.nvLineRender();
  const rowsShown = () => (host.innerHTML.match(/data-nvln-awb=/g) || []).length;
  assert.ok(host.innerHTML.includes("<em>+5</em>") && rowsShown() === 8, "a busy stop shows eight dots and eight rows");
  assert.ok(host.innerHTML.includes('class="nvln-more" data-nvln-more="booked" aria-expanded="false">Show all 13</button>') && !host.innerHTML.includes("in Your parcels below"), "and a button for the rest, not a sentence");
  api.NV_LN.all = "booked"; api.nvLineRender();
  assert.ok(rowsShown() === 13 && host.innerHTML.includes('aria-expanded="true">Show fewer</button>'), "Show all opens every parcel at that stop, in place");
  api.NV_LN.all = ""; api.nvLineRender(); assert.equal(rowsShown(), 8, "Show fewer folds it again");
  assert.ok(app.includes('NV_LN.open=NV_LN.open===k?"":k; NV_LN.all="";'), "opening another stop starts folded");
  ok("home line: every parcel at its stop, amber from the one needs-you rule, lists that open and stay open, and no redraw without a change");
}
// New booking, regrouped 10 Oct 2026: three steps, every field still there once.
{
  const nb = html.slice(html.indexOf('id="client-newBooking"'), html.indexOf("</section>", html.indexOf('id="client-newBooking"')));
  const groups = [...nb.matchAll(/<div class="nvnb-g">\s*<div class="nvnb-gh"><b aria-hidden="true">(\d)<\/b><div><h4>([^<]+)<\/h4>/g)].map((m) => m[1] + " " + m[2]);
  assert.deepEqual(groups, ["1 Customer", "2 Parcel", "3 Pickup and notes"]);
  assert.equal((nb.match(/class="form-grid"/g) || []).length, 3, "one grid of fields in each step");
  assert.deepEqual([...nb.matchAll(/<label for="(\w+)"/g)].map((m) => m[1]),
    ["bookingName", "bookingPhone", "bookingCity", "bookingDestArea", "bookingAddress", "bookingCod", "bookingCategory", "bookingWeight", "bookingFragile", "bookingAllowOpen", "bookingPickupCity", "bookingService", "bookingOrderId", "bookingComments"],
    "who it is for, what is in it, then pickup and notes");
  ["nvBookingForm","nvPasteBox","nvPasteInput","nvPasteFillBtn","nvRiskWarning","bookingName","bookingPhone","consigneeHistoryBadge","nvPickupBanner","bookingPickupCity","bookingCity","bookingZoneHint","nvAreaAutoChip","bookingDestAreaField","bookingDestArea","bookingCod","bookingService","bookingComments","bookingCategory","bookingFragile","bookingWeight","nvWeightChips","bookingPayMode","bookingPaymentMode","bookingOrderId","bookingAllowOpen","bookingAddress","bookingCityWarn","nvBookReview","bookingConfirmLine","quickBookingBtn"].forEach(once);
  assert.equal((nb.match(/<div/g) || []).length, (nb.match(/<\/div>/g) || []).length, "nothing left unclosed");
  assert.ok(!/parcel ledger|writes to/.test(nb), "no developer wording in the heading");
  ok("new booking: three numbered steps, every field and control still in the page once");
}
console.log("HOME LINE CHECKS PASSED");

// Home notices: a long list of tracking numbers folds after ten.
{
  const pick = (name) => new RegExp("    function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n    \\}\\n").exec(app)[0];
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const api = new Function("escLabelText", "var NV_INS_OPEN={};" + pick("nvPlainCount") + pick("nvLinkAwbs") + pick("nvInsBody") + "return { nvInsBody, NV_INS_OPEN };")(esc);
  const awbs = (n) => Array.from({ length: n }, (_, i) => "N85302" + String(10 + i)).join(", ");
  const few = api.nvInsBody({ kind: "stuck", body: "No status change for over 72 hours: " + awbs(3) + "." });
  assert.ok(!few.includes("nv-ins-more") && (few.match(/class="nv-ins-awb"/g) || []).length === 3, "a short list is shown whole, with no button");
  const ten = api.nvInsBody({ kind: "stuck", body: "Booked: " + awbs(10) + ", and 5 more." });
  assert.ok(!ten.includes("nv-ins-more"), "the old ten-and-a-count wording is left as it is");
  const many = api.nvInsBody({ kind: "overdue", body: "Booked over 72 hours ago: " + awbs(15) + ". These are simply taking too long." });
  const [head, rest] = many.split('<span class="nv-ins-rest" hidden>');
  assert.equal((head.match(/class="nv-ins-awb"/g) || []).length, 10, "ten show");
  assert.equal((rest.split("</span>")[0].match(/class="nv-ins-awb"/g) || []).length, 5, "five wait behind the button");
  assert.ok(many.includes('data-nv-ins-more="overdue" data-n="15" aria-expanded="false">Show all 15</button>') && many.includes("These are simply taking too long."), "the button names the total and the rest of the sentence is kept");
  api.NV_INS_OPEN.overdue = true;
  const open = api.nvInsBody({ kind: "overdue", body: "Booked over 72 hours ago: " + awbs(15) + "." });
  assert.ok(open.includes('<span class="nv-ins-rest">') && open.includes('aria-expanded="true">Show fewer</button>'), "once opened it stays open when Home is drawn again");
  assert.ok(app.includes("nvInsBody(it)") && html.includes(".nv-ins-rest[hidden]{display:none}"));
  ok("home notices: ten tracking numbers, then Show all; the choice survives a redraw");
}

// Audit fixes, 10 Oct 2026.
{
  // A reattempt that is already requested shows a note, not a button that can only fail.
  assert.ok(app.includes('var __ra=(typeof nvReattemptUsed==="function")?nvReattemptUsed(p):"";') && app.includes('? \'<span class="chip" title="\'+escLabelText(nvReattemptDoneMsg(p.awb,__ra))+\'">\'+(__ra==="requested"?"Reattempt requested":"Reattempted once")+\'</span>\''), "parcel row");
  assert.ok(app.includes('${nvReattemptUsed(p)?`<span class="chip" title="${escLabelText(nvReattemptDoneMsg(p.awb,nvReattemptUsed(p)))}">'), "Action needed card");
  assert.equal((app.match(/requestRedelivery\(\\?['`]/g) || []).length >= 2, true);
  ok("reattempt: the parcel row and the Action needed card show \"Reattempt requested\" once one is asked for");

  // Customer answers load without a tab switch, and a lookup that was never sent does not start the two-minute clock.
  assert.ok(/try\{ nvLineRender\(\); \}catch\(e\)\{\}\s*\/\*[\s\S]*?\*\/\s*try\{ nvCustCheck\(\); \}catch\(e\)\{\}/.test(app), "asked from Home's own render");
  const chk = /    function nvCustCheck\(force\)\{[\s\S]*?\n    \}\n/.exec(app)[0];
  assert.ok(chk.indexOf("if(!sb||!sb.rpc) return;") < chk.indexOf("NV_CS.asked=id; NV_CS.at=now;"), "the clock starts only after the connection check");
  {
    const pick = (name) => new RegExp("    function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n    \\}\\n").exec(app)[0];
    const win = {}; new Function("window", /window\.nvCount=function\(n,one,many\)\{[\s\S]*?\n\};/.exec(app)[0])(win);
    let writes = 0, html = "";
    const host = { hidden: true, get innerHTML() { return html; }, set innerHTML(v) { html = v; writes++; } };
    const api = new Function("document", "localStorage", "state", "activeClientId", "escLabelText", "nvCount",
      /var NV_CS=\{[^;]*\};/.exec(app)[0] + /var NV_CS_SAY=\{[\s\S]*?\};/.exec(app)[0] + ["nvCustReply", "nvCustWhen", "nvCustPaint"].map(pick).join("") + "return { NV_CS, nvCustPaint };")(
      { getElementById: () => host }, { getItem: () => null, setItem() {} }, { parcels: [{ awb: "N1", clientId: "c1", consignee: "Hina", status: "Parcel out for delivery" }] }, () => "c1", (x) => String(x), win.nvCount);
    api.NV_CS.map = { N1: { awb: "N1", choice: "call_first", note: null, at: new Date(Date.now() - 60000).toISOString() } };
    api.nvCustPaint(); api.nvCustPaint(); api.nvCustPaint();
    assert.equal(writes, 1, "three renders with the same answers write the card once");
    api.NV_CS.map.N1 = { awb: "N1", choice: "tomorrow", note: null, at: new Date().toISOString() };
    api.nvCustPaint(); assert.equal(writes, 2, "a new answer redraws it");
  }
  ok("customer answers: loaded on Home's first render, retried until sent, redrawn only when they change");

  assert.ok(app.includes("const net=Math.max(0,useAmt-fee);"), "the older withdraw form never shows a negative amount");
  assert.ok(app.includes('delivered_at:o.status==="Delivered"?iso(now-o.upd):null,'), "a delivered sample parcel has a delivery time");
  ok("small fixes: no negative \"You receive\", demo deliveries carry their time");
}
console.log("AUDIT FIX CHECKS PASSED");
