// 9 Oct 2026: a sentence ran out of its box in the parcel drawer. The cause
// was a rule that keeps money figures on one line being applied to words.
// These checks keep words out of the boxes that may not wrap, and keep the
// other fixes from that sweep in place. Reads the files only; the measuring
// itself is done in a browser with scripts/dev/overflow-scan.js.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const html = readFileSync(new URL("../client.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../client-app.js", import.meta.url), "utf8");
const reports = readFileSync(new URL("../client-reports.js", import.meta.url), "utf8");
const ok = (m) => console.log("ok - " + m);

// 1. A money box holds a figure and nothing else.
{
  const calls = [...app.matchAll(/moneyBox\(("[^"]*"),([\s\S]*?)\)(?=[,;+`\]]|\s*\+|\s*$|\})/gm)].filter((m) => !/^function/.test(app.slice(m.index - 9, m.index)));
  assert.ok(calls.length >= 12, "found the money box calls (" + calls.length + ")");
  for (const m of calls) assert.ok(/money\(/.test(m[2]), "moneyBox(" + m[1] + ", …) must show a money figure, not words: " + m[2].slice(0, 60));
  const rule = /\.money-box strong,[^{]*\{\s*overflow-wrap:normal;word-break:keep-all;white-space:nowrap;/.exec(html);
  assert.ok(rule, "money figures still stay on one line");
  assert.ok(!/\.ops-card-head strong/.test(rule[0]), "a card's title is not in the one-line list");
  assert.ok(!/\.awb-field strong[,{]/.test(rule[0]), "nor is a label field");
  ok("money boxes: every one shows a figure; card titles and label fields are not held to one line");
}

// 2. "What to do next" is three sentences that wrap, each escaped.
{
  const fn = /    function renderExceptionCard\(p\)\{[\s\S]*?\n    \}\n/.exec(app)[0];
  assert.ok(!fn.includes("moneyBox("), "no money boxes in the card");
  assert.ok(fn.includes('<dl class="nv-exc-list">${say("Problem",cls.problem)}${say("Likely cause",cls.cause)}${say("Recommended action",cls.action)}</dl>'));
  assert.ok(fn.includes('<dd>${escLabelText(text)}</dd>'), "the rider's own words are escaped");
  assert.match(html, /\.nv-exc-item dd\{[^}]*white-space:normal;overflow-wrap:anywhere\}/);
  assert.ok(fn.includes(`var chip=hideDeliveryActions?'<span class="chip">Nothing to decide yet</span>':'<span class="chip warn">Needs your decision</span>';`), "no decision is asked for when none is offered");
  // every sentence the card can show, at the drawer's narrowest, is longer than one line: prove the markup carries them whole
  const cls = /    function classifyParcelException\(p\)\{[\s\S]*?\n    \}\n/.exec(app)[0];
  const sentences = [...cls.matchAll(/(?:problem|cause|action):"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sentences.length >= 21 && sentences.some((t) => t.length > 80), "the card's sentences are long (" + Math.max(...sentences.map((t) => t.length)) + " characters at most)");
  ok("what to do next: three wrapping sentences, escaped, and no \"Needs your decision\" without a decision");
}

// 3. Card titles wrap at spaces.
{
  assert.match(html, /\.ops-card-head strong\{min-width:0;overflow-wrap:break-word;word-break:normal;white-space:normal;\}/);
  assert.ok(!/\.ops-card-head strong\{[^}]*white-space:nowrap/.test(html));
  ok("card titles: a ticket subject or a team member's name wraps inside its card");
}

// 4. The Cities card measures itself, not the window.
{
  assert.ok(reports.includes("'.nvr-cities{container-type:inline-size;container-name:nvrct}',"));
  const at = reports.indexOf("'@container nvrct (max-width:560px){',");
  assert.ok(at > -1, "stacks when the card is narrow");
  const block = reports.slice(at, reports.indexOf("'}',", at));
  for (const t of [".nvr-ct-head{display:none}", 'grid-template-areas:"n n n n" "bar bar bar bar"', ".nvr-ct-v em{display:block"]) assert.ok(block.includes(t), t);
  ok("reports: the Cities card stacks each city when the card, not the window, is narrow");
}

// 5. Parcel cards: the tracking number is never squeezed.
{
  assert.match(html, /\.nv-pc-awb\{flex:0 0 auto;/);
  assert.match(html, /\.nv-pc \.status\{flex:0 1 auto;min-width:0;margin-left:auto;white-space:normal;/);
  assert.ok(app.includes('class="chip good" style="display:inline-flex;align-items:center;gap:6px;margin-bottom:10px;font-weight:700;white-space:normal;max-width:100%;'), "the printed-label line wraps on a phone");
  ok("parcel cards and the label line: a long status takes a second line instead of pushing text out");
}

// 6. The three-column sheet table fits its sheet.
{
  assert.match(html, /\.wide-scroll table\.nv-sheet-tbl\{min-width:0;\}/);
  assert.ok(html.indexOf(".wide-scroll table.nv-sheet-tbl{min-width:0;}") > html.indexOf(".wide-scroll table{min-width:760px;}"), "and comes after the wide-table rule it undoes");
  assert.ok(app.includes('<div class="wide-scroll"><table class="nv-sheet-tbl">'));
  ok("collected, awaiting invoice: the table no longer scrolls sideways on a desktop");
}

// 7. Rows of chips that scroll sideways say so.
{
  const fn = /\(function nvScrollHints\(\)\{[\s\S]*?\n    \}\)\(\);/.exec(app)[0];
  const sel = /var SEL="([^"]+)";/.exec(fn)[1].split(",");
  assert.deepEqual(sel, [".nvw-filters", ".nvr-tabs", ".nvr-chips", "#nvAiChips", ".nvauto-chips", ".nv-pf-nav"]);
  for (const c of [".nv-more-r{", ".nv-more-l{", ".nv-more-l.nv-more-r{"]) assert.ok(html.includes(c), c);
  assert.ok(!/nvr-chips\{[^}]*mask-image/.test(reports), "the Reports date chips no longer fade at the end of the row");
  assert.ok(html.includes("@media (min-width:641px){ .nvw-filters{flex-wrap:wrap;overflow-x:visible} }") && reports.includes("'@media (min-width:641px){.nvr-tabs{flex-wrap:wrap;overflow-x:visible}}',"), "they wrap where there is room");
  // the two classes follow the row's real scroll position
  const paint = new Function(/function paint\(el\)\{[\s\S]*?\n        \}/.exec(fn)[0] + "return paint;")();
  const row = (scrollWidth, clientWidth, scrollLeft) => { const on = new Set(); const el = { scrollWidth, clientWidth, scrollLeft, classList: { toggle: (c, v) => (v ? on.add(c) : on.delete(c)) } }; paint(el); return [...on].sort().join(" "); };
  assert.equal(row(300, 300, 0), "", "a row that fits does not fade");
  assert.equal(row(700, 340, 0), "nv-more-r", "more to the right");
  assert.equal(row(700, 340, 180), "nv-more-l nv-more-r", "more on both sides");
  assert.equal(row(700, 340, 360), "nv-more-l", "at the end only the left fades");
  ok("chip rows: fade on the side that has more, stop at the end, wrap on wider screens");
}

// 8. "3 parcel(s) have" is said the way a person would.
{
  const nvPlainCount = new Function(/    function nvPlainCount\(text\)\{[\s\S]*?\n    \}\n/.exec(app)[0] + "return nvPlainCount;")();
  assert.equal(nvPlainCount("3 parcel(s) have not moved in 3 days"), "3 parcels have not moved in 3 days");
  assert.equal(nvPlainCount("1 parcel(s) have not moved in 3 days"), "1 parcel has not moved in 3 days");
  assert.equal(nvPlainCount("15 parcel(s) are past 3 days with us"), "15 parcels are past 3 days with us");
  assert.equal(nvPlainCount("1 parcel(s) are past 3 days with us"), "1 parcel is past 3 days with us");
  assert.equal(nvPlainCount("1 booking(s) still waiting for pickup"), "1 booking still waiting for pickup");
  assert.equal(nvPlainCount("No status change for over 72 hours: N8530234, N8530261."), "No status change for over 72 hours: N8530234, N8530261.");
  assert.ok(app.includes("escLabelText(nvPlainCount(it.title))") && app.includes("var text=nvPlainCount(it&&it.body)") && app.includes("nvInsBody(it)"), "the title and the body are both reworded");
  ok("home notices: \"3 parcels have not moved\", \"1 parcel has not moved\"");
}
// 9. A chip with no tone is still a pill.
{
  assert.match(html, /\.chip:where\(:not\(\.good,\.warn,\.bad,\.info\)\)\{background:var\(--nvu-neutral-bg\);color:var\(--nvu-neutral-fg\);border:1px solid var\(--nvu-neutral-ln\);\}/);
  for (const tok of ["--nvu-neutral-bg:", "--nvu-neutral-fg:", "--nvu-neutral-ln:"]) assert.ok(html.split(tok).length - 1 >= 2, tok + " is set for both themes");
  ok("plain chips: a neutral pill in both themes, weaker than any chip that has its own look");
}
// 10. Admin: the one-line list holds figures only, and the shipping label can wrap.
{
  const admin = readFileSync(new URL("../admin.html", import.meta.url), "utf8");
  const list = /\n  \.metric strong,[^{]*\{\s*overflow-wrap:normal;word-break:keep-all;white-space:nowrap;/.exec(admin);
  assert.ok(list, "admin still keeps figures on one line");
  const sels = list[0].slice(0, list[0].indexOf("{")).split(",").map((x) => x.trim());
  assert.deepEqual(sels, [".metric strong", ".nv-settle-row .amt", ".awb-field.awb-cod strong", ".awb-field.awb-date strong", ".awb-field.awb-phone strong", "#landing .live-widget strong"],
    "only figures: not every label field, and not a merchant's name");
  assert.ok(!/[\s,]\.awb-field strong\s*[,{][^}]*white-space:\s*nowrap/.test(admin.replace(/\/\*[\s\S]*?\*\//g, "")), "no rule holds every label field to one line");
  assert.ok(admin.includes('<div class="awb-field awb-date"><span>Booking Date</span>') && admin.includes('<div class="awb-field awb-phone"><span>Phone</span>'), "the date and the phone are marked as the short tokens");
  assert.ok(admin.includes('<div class="awb-field awb-address"><span>Address</span>'), "the address is an ordinary, wrapping field");
  assert.ok(admin.includes(":is(#adminInvoiceList,#recentInvoiceList,#clientSummaryList,#clientSignupAuditList) .log-item:not(details){display:flex;flex-wrap:wrap;"), "invoice and client-summary rows wrap instead of using the 110px column");
  assert.ok(admin.includes("@media (max-width:640px){#admin-payments .mini-form{grid-template-columns:1fr!important}}"));
  ok("admin: label fields wrap (only COD, date and phone stay on one line), invoice rows and the Add Invoice form fit");
}
console.log("OVERFLOW RULE CHECKS PASSED");
