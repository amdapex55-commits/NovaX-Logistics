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
  const s = section("client-bulkBooking", "<!-- STORE INTEGRATIONS -->");
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
  assert.equal((p.match(/<details class="panel[^"]* nv-pf-sec"/g) || []).length, 8, "seven sections and the preview");
  assert.equal((p.match(/<\/details>/g) || []).length, 8);
  assert.equal((p.match(/<summary class="section-head">/g) || []).length, 8);
  assert.equal((p.match(/nv-pf-sec"[^>]* open>/g) || []).length, 8, "all open in the page itself, so nothing is hidden without the script");
  assert.match(p, /<details class="panel nv-pf-sec" open>\s*<summary class="section-head"><div><h3>Business profile<\/h3>/, "the first section never starts shut");
  assert.equal((p.match(/data-nv-fold="phone"/g) || []).length, 6);
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
