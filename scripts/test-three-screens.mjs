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
  assert.equal((p.match(/<details class="panel[^"]* nv-pf-sec"/g) || []).length, 9, "eight sections and the preview");
  assert.equal((p.match(/<\/details>/g) || []).length, 9);
  assert.equal((p.match(/<summary class="section-head">/g) || []).length, 9);
  assert.equal((p.match(/nv-pf-sec"[^>]* open>/g) || []).length, 9, "all open in the page itself, so nothing is hidden without the script");
  assert.match(p, /<details class="panel nv-pf-sec" open>\s*<summary class="section-head"><div><h3>Business profile<\/h3>/, "the first section never starts shut");
  assert.equal((p.match(/data-nv-fold="phone"/g) || []).length, 7);
  assert.match(p, /id="nvKycPanel" data-nv-fold="phone-verified" open>/, "the CNIC section starts shut only once verified");
  ["nvPfLogo","nvPfName","nvPfAccent","nvPfPhone","nvPfWa","nvPfEmail","nvPfWeb","nvPfType","nvPfAddr","nvPfTrackOn","nvPfCity","nvPfCityReq","nvKycPanel","nvKycSend","nvKycReplace","nvPfHistory","nvPfSaveBar","nvPfSave","nvPfDiscard","nvPfPvTrack"].forEach(once);
  const fold = fnSrc("nvPfFoldOnce");
  assert.ok(fold.includes('matchMedia("(max-width:760px)")') && fold.includes("if(NV_PF.folded) return; NV_PF.folded=true;"), "phones only, once per visit");
  assert.ok(!/nvPfEl\("nvPf[A-Za-z]+"\)\.focus\(\)/.test(app) && fnSrc("nvPfShow").includes("d.open=true"), "a save that fails on a field opens its section");
  ok("profile: eight folding sections, every field still in the page, phones start with the first one open");
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
    const run = async (data) => {
      const host = { style: {}, innerHTML: "" }, input = { value: "0300 1234567" };
      const window = { __nvSb: { rpc: () => Promise.resolve({ data, error: null }) }, nvCount: win.nvCount };
      const document = { getElementById: (id) => (id === "bookingPhone" ? input : host) };
      new Function("document", "window", "nvSetHtml", "nvCount", "var NV_CONSIGNEE_LAST='';" + src + "nvConsigneeBadge();")(document, window, (h, x) => { h.innerHTML = x; }, win.nvCount);
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
