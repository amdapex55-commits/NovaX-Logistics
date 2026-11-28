// Comparison pages: NovaX vs other COD couriers (19 Oct 2026).
// Run: node scripts/gen-compare-pages.mjs  -> writes the pages to the repo root.
//
// Rules for what these pages may say:
// - NovaX facts only as published on the homepage and answer pages (rates,
//   COD the day it lands, flat withdrawal fees, no extra return fee).
// - Other couriers: their real strengths, and how they work in general terms.
//   Third-party 2026 blogs disagree on their fees and payout days, so no
//   competitor price or payout day is stated as fact. Each page carries the
//   "checked" date and says to confirm with the courier.
// - Honest about NovaX's limit: 12 cities, pickup in four.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://novaxlogistics.com";
const UPDATED = "19 October 2026", ISO = "2026-10-19";
const CITIES = "Karachi, Lahore, Islamabad, Rawalpindi, Faisalabad, Multan, Sahiwal, Okara, Chichawatni, Harappa, Yousuf Wala and Adda Gamber";

const NX = {
  price: "Flat and published: Rs 225 for the first kg to a Karachi address, Rs 250 to Lahore, Islamabad, Rawalpindi and the new stations, plus Rs 85 per extra kg",
  codFee: "None. No COD fee and no percentage taken from your cash",
  payout: "Credited to your NovaX wallet the day the parcel is delivered",
  withdraw: "Nova Saver free (48–72 hours), Nova Express Rs 100 (within 24 hours), Nova Bolt Rs 500 (6–12 hours), flat per withdrawal",
  returns: "Refused parcels come back at the normal delivery charge, with no extra return fee",
  recover: "Nova Recover: a NovaX agent phones the customer who refused and sells the order again",
  proof: "The rider records a voice note on every refusal, and you can play it in your portal",
  pickup: "Free pickup from your door in Karachi, Lahore, Islamabad and Rawalpindi",
  speed: "Same-day or next-day in Karachi; 2–3 working days to other cities",
  coverage: "12 cities: " + CITIES,
  tools: "Shopify app, WooCommerce, Merchant API, bulk CSV upload, Nova Swap exchanges",
  signup: "Sign up online in minutes, free, no minimum volume",
};

const RIVALS = [
  { slug: "tcs", name: "TCS", strength: "the biggest courier network in Pakistan, with nationwide and international reach and a name every customer knows",
    pick: "you ship to towns outside NovaX's 12 cities, or send parcels abroad",
    how: { price: "Rate card set per account and weight slab", codFee: "A COD handling charge applies on COD accounts (tiered by order value on published examples)", payout: "Paid to your bank on a remittance cycle", coverage: "Nationwide and international", signup: "COD account opened with documents through TCS" } },
  { slug: "leopards", name: "Leopards Courier", strength: "a large nationwide network that many Pakistani online stores already use",
    pick: "most of your orders go to smaller towns NovaX does not serve yet",
    how: { price: "Rate card set per account and weight slab", codFee: "A COD handling fee applies on most accounts (often a percentage with a minimum)", payout: "Paid to your bank on a remittance cycle", coverage: "Nationwide", signup: "COD account through Leopards' eCommerce team" } },
  { slug: "postex", name: "PostEx", strength: "early COD payouts: its model can pay sellers before parcels are delivered, priced through its commission",
    pick: "you need cash before your parcels are even delivered and accept the cost that comes with it",
    how: { price: "Negotiated per account", codFee: "Commission negotiated around your volume and COD profile", payout: "Early or upfront payout is its headline offer", coverage: "Nationwide through partner networks", signup: "Account through the PostEx sales team" } },
  { slug: "trax", name: "Trax", strength: "a tech-first courier with clear dashboards and strong delivery in the big metros",
    pick: "you ship nationwide and want one dashboard for every city",
    how: { price: "Account-based, improves with volume", codFee: "A COD handling fee applies on most accounts", payout: "Paid to your bank on a settlement cycle", coverage: "Nationwide, strongest in major cities", signup: "Account through the Trax team" } },
  { slug: "mnp", name: "M&P", strength: "one of the long-established nationwide courier networks",
    pick: "you need a long-established nationwide network for every town",
    how: { price: "Rate card set per account and weight slab", codFee: "A COD handling charge applies on COD accounts", payout: "Paid to your bank on a remittance cycle", coverage: "Nationwide", signup: "COD account through M&P" } },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:#0b0e12;color:#e8eef4;font:16px/1.65 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:#5fe0a8}a:focus-visible{outline:2px solid #14c77b;outline-offset:2px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:860px;margin:0 auto;padding:16px}
.top a.brand{color:#e8eef4;text-decoration:none;font-weight:800;font-size:17px}.top a.cta{background:#14c77b;color:#04130d;font-weight:800;text-decoration:none;padding:10px 16px;border-radius:12px;font-size:14px}
.top a.brand,.top a.cta{display:inline-flex;align-items:center;min-height:44px}
main{max-width:860px;margin:0 auto;padding:8px 16px 48px}
.crumb{font-size:13px;color:#9aa7b4}.crumb a{color:#9aa7b4;display:inline-block;padding:14px 6px;margin:-14px -6px}
h1{font-size:clamp(26px,5vw,38px);line-height:1.15;margin:10px 0 14px;letter-spacing:-.02em}
.answer{background:#11151a;border:1px solid #28303a;border-left:4px solid #14c77b;border-radius:14px;padding:16px 18px;font-size:18px;font-weight:600;margin:0 0 10px}
.upd{font-size:13px;color:#9aa7b4;margin:0 0 26px}
h2{font-size:21px;margin:30px 0 8px}h3{font-size:17px;margin:18px 0 4px}
ul,ol{padding-left:20px}li{margin:5px 0}
.cmp{width:100%;border-collapse:collapse;margin:8px 0 4px;font-size:15px}.cmp th,.cmp td{text-align:left;vertical-align:top;padding:11px 12px;border-bottom:1px solid #28303a}
.cmp thead th{color:#9aa7b4;font-size:13px;font-weight:700}.cmp tbody th{width:22%;color:#c9d3dc;font-weight:700}
.cmp td.nx{background:rgba(20,199,123,.08);color:#e8eef4}.cmp td.nx b{color:#5fe0a8}
.wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px}
@media (max-width:640px){.cmp thead{display:none}.cmp,.cmp tbody,.cmp tr,.cmp th,.cmp td{display:block;width:100%}.cmp tr{border:1px solid #28303a;border-radius:12px;margin:0 0 10px;overflow:hidden}.cmp tbody th{width:auto;border:0;padding:10px 12px 4px}.cmp td{border:0;padding:6px 12px 10px}.cmp td::before{content:attr(data-l);display:block;font-size:12px;font-weight:700;color:#9aa7b4;margin-bottom:2px}}
.pick{display:grid;gap:10px;grid-template-columns:1fr 1fr;margin:10px 0}.pick>div{background:#11151a;border:1px solid #28303a;border-radius:14px;padding:14px 16px}.pick>div.nx{border-color:#14c77b}.pick b{display:block;margin-bottom:4px}
@media (max-width:640px){.pick{grid-template-columns:1fr}}
.rank{counter-reset:r;list-style:none;padding:0}.rank li{counter-increment:r;position:relative;padding:14px 16px 14px 56px;background:#11151a;border:1px solid #28303a;border-radius:14px;margin:0 0 10px}
.rank li::before{content:counter(r);position:absolute;left:14px;top:14px;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#1d232a;font-weight:800}.rank li.nx{border-color:#14c77b}.rank li.nx::before{background:#14c77b;color:#04130d}
.go{display:inline-flex;align-items:center;min-height:48px;margin:14px 0 4px;padding:0 20px;border-radius:12px;background:#14c77b;color:#04130d;font-weight:800;text-decoration:none}
.note{color:#9aa7b4;font-size:14px}
.more{display:grid;gap:8px;margin-top:10px}.more a{display:block;padding:12px 14px;border:1px solid #28303a;border-radius:12px;text-decoration:none;color:#e8eef4;background:#11151a}.more a:hover{border-color:#14c77b}
details{border:1px solid #28303a;border-radius:12px;padding:0 14px;margin:0 0 8px;background:#11151a}summary{cursor:pointer;font-weight:700;padding:13px 0;min-height:44px}details p{margin:0 0 14px}
footer{max-width:860px;margin:0 auto;padding:24px 16px 40px;color:#75828f;font-size:13px;border-top:1px solid #1d232a}footer a{display:inline-block;padding:12px 4px;margin:-12px -4px}
@media (prefers-color-scheme:light){body{background:#f5f7fa;color:#121821}.top a.brand,.more a{color:#121821}.answer,.more a,.pick>div,.rank li,details{background:#fff;border-color:#d4dae1}.cmp th,.cmp td,.cmp tr{border-color:#d4dae1}.cmp tbody th{color:#2a3440}.cmp td.nx{background:#e8f8f0;color:#121821}.cmp td.nx b{color:#0c7c59}.rank li::before{background:#e9edf1}a{color:#0c7c59}.crumb,.crumb a,.upd,.note,.cmp thead th,.cmp td::before{color:#5b6875}footer{border-color:#e5e9ee}}`;

function page({ slug, title, h1, desc, crumb, body, faq }) {
  const url = `${SITE}/${slug}.html`;
  const ld = { "@context": "https://schema.org", "@graph": [
    { "@type": "WebPage", "@id": url + "#page", url, name: h1, description: desc, inLanguage: "en-PK", dateModified: ISO,
      isPartOf: { "@id": SITE + "/#website" }, about: { "@id": SITE + "/#service" }, publisher: { "@id": SITE + "/#org" } },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
      ...(crumb ? [{ "@type": "ListItem", position: 2, name: "Compare couriers", item: SITE + "/best-cod-courier-pakistan.html" }] : []),
      { "@type": "ListItem", position: crumb ? 3 : 2, name: h1, item: url }] },
    { "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
  ] };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(h1)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/assets/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0b0e12">
<link rel="icon" href="/assets/favicon.ico" sizes="32x32">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${CSS}</style>
</head>
<body>
<header class="top"><a class="brand" href="/">NovaX Logistics</a><a class="cta" href="/#signup">Start shipping</a></header>
<main>
<p class="crumb"><a href="/">Home</a> › ${crumb ? '<a href="/best-cod-courier-pakistan.html">Compare couriers</a> › ' + esc(crumb) : "Compare couriers"}</p>
<h1>${esc(h1)}</h1>
${body}
<h2>Questions sellers ask</h2>
${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("\n")}
<p class="note">TCS, Leopards, PostEx, Trax and M&amp;P are trademarks of their owners. NovaX is not connected to them. What this page says about other couriers is drawn from public information as of ${UPDATED}; their rates, fees and payout terms are set per account and can change, so confirm them in writing with the courier. NovaX rates and terms are the ones published on <a href="/">novaxlogistics.com</a>.</p>
<h2>More comparisons</h2>
<div class="more">${[{ slug: "best-cod-courier-pakistan", name: "Best COD courier in Pakistan for online sellers" }, ...RIVALS.map(r => ({ slug: "novax-vs-" + r.slug, name: "NovaX vs " + r.name }))]
  .filter(x => x.slug !== slug).map(x => `<a href="/${x.slug}.html">${esc(x.name)}</a>`).join("")}<a href="/when-is-cod-paid.html">When is COD paid?</a><a href="/customer-refused-cod-parcel.html">What happens when a customer refuses a COD parcel?</a></div>
</main>
<footer>NovaX Logistics · COD courier for online sellers, delivering to ${CITIES} · WhatsApp 0312 3922558 · <a href="/privacy.html">Privacy</a></footer>
</body>
</html>
`;
}

const ROWS = [["price", "Delivery price"], ["codFee", "COD fee"], ["payout", "When your COD reaches you"], ["coverage", "Where it delivers"], ["signup", "Getting started"]];
const NX_ONLY = [["withdraw", "Getting your money out"], ["returns", "Refused parcels"], ["recover", "Selling refused orders again"], ["proof", "Proof on refusals"], ["pickup", "Pickup"], ["speed", "Delivery time"], ["tools", "Store connections"]];

function vsPage(r) {
  const rows = ROWS.map(([k, label]) => `<tr><th>${label}</th><td class="nx" data-l="NovaX">${esc(NX[k])}</td><td data-l="${esc(r.name)}">${esc(r.how[k])}</td></tr>`).join("")
    + NX_ONLY.map(([k, label]) => `<tr><th>${label}</th><td class="nx" data-l="NovaX">${esc(NX[k])}</td><td data-l="${esc(r.name)}">Ask ${esc(r.name)} for its terms</td></tr>`).join("");
  const body = `<p class="answer">For online sellers whose orders go to NovaX's 12 cities, NovaX is usually the better deal: flat published rates, no COD fee or percentage, and COD in your wallet the day the parcel is delivered. ${esc(r.name)}'s strength is ${esc(r.strength)}, so it is the better choice when ${esc(r.pick)}.</p>
<p class="upd">Updated ${UPDATED}</p>
<h2>NovaX vs ${esc(r.name)} at a glance</h2>
<div class="wrap"><table class="cmp"><thead><tr><th></th><th>NovaX</th><th>${esc(r.name)}</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Where NovaX wins</h2>
<ul>
<li><b>You keep more of every order.</b> NovaX takes no COD fee and no percentage. The only deduction is the flat delivery charge you saw when booking.</li>
<li><b>Your cash does not wait for a cycle.</b> COD is credited to your wallet the day the parcel is delivered, and Nova Saver withdrawals to your bank are free.</li>
<li><b>Refusals cost less.</b> A refused parcel comes back at the normal delivery charge with no extra return fee. Nova Recover can phone the customer and sell it again. The rider's voice note shows exactly what happened at the door.</li>
<li><b>One price list, in public.</b> Rs 225 to a Karachi address, Rs 250 to the other stations, Rs 85 per extra kg. No slabs to negotiate and no volume minimum.</li>
<li><b>Built for online stores.</b> Shopify and WooCommerce orders book themselves, the Merchant API takes bulk orders, and the portal works on a phone.</li>
</ul>
<h2>When ${esc(r.name)} is the better choice</h2>
<div class="pick"><div class="nx"><b>Choose NovaX if</b>most of your orders go to ${esc(CITIES)}, you sell cash on delivery, and you want your money fast and your fees flat.</div><div><b>Choose ${esc(r.name)} if</b>${esc(r.pick)}. Many sellers use NovaX for its 12 cities and another courier for the rest.</div></div>
<h2>Switching takes a day</h2>
<ol><li>Sign up at novaxlogistics.com (free, a few minutes).</li><li>Connect your Shopify or WooCommerce store, or upload a CSV of open orders.</li><li>Print labels and request a pickup. A rider collects from your door.</li></ol>
<a class="go" href="/#signup">Start shipping with NovaX</a>`;
  const faq = [
    [`Is NovaX cheaper than ${r.name}?`, `NovaX charges a flat Rs 225 to a Karachi address and Rs 250 to its other stations for the first kg, plus Rs 85 per extra kg, with no COD fee and no percentage. ${r.name} sets prices per account, so compare its written quote, including its COD fee, against these numbers.`],
    [`How fast does NovaX pay COD compared with ${r.name}?`, `NovaX credits COD to your wallet the day the parcel is delivered. Withdrawals to your bank are free on Nova Saver (48–72 hours), Rs 100 on Nova Express (within 24 hours) or Rs 500 on Nova Bolt (6–12 hours). ${r.name} pays on its own schedule, which you should confirm with them.`],
    [`Does NovaX deliver everywhere ${r.name} does?`, `No. NovaX delivers to 12 cities: ${CITIES}. ${r.name} covers more of Pakistan, so many sellers use NovaX for these cities and another courier for the rest.`],
    [`Can I use NovaX and ${r.name} together?`, "Yes. There is no minimum volume and no contract lock-in, so you can send your orders for NovaX's cities through NovaX and the rest through your current courier."],
  ];
  return page({ slug: "novax-vs-" + r.slug, title: `NovaX vs ${r.name} for COD sellers (2026): fees, payouts, returns`,
    h1: `NovaX vs ${r.name}: which COD courier is better for online sellers?`,
    desc: `NovaX vs ${r.name} compared for Pakistani online sellers: delivery price, COD fee, when COD is paid, refused parcels and coverage. Updated ${UPDATED}.`,
    crumb: "NovaX vs " + r.name, body, faq });
}

function hub() {
  const body = `<p class="answer">For an online seller whose orders go to Karachi, Lahore, Islamabad, Rawalpindi and NovaX's new Punjab stations, NovaX is the strongest COD choice in 2026: flat published rates, no COD fee or percentage, COD in your wallet the day it is delivered, and no extra return fee. For towns outside those 12 cities, use one of the nationwide couriers below alongside it.</p>
<p class="upd">Updated ${UPDATED}</p>
<h2>Our ranking for online sellers</h2>
<p>Ranked on what decides a COD seller's profit: what you pay per parcel, what is taken from your cash, how fast the cash reaches you, and what a refusal costs.</p>
<ol class="rank">
<li class="nx"><b>NovaX: best for sellers shipping to its 12 cities.</b> No COD fee or percentage, COD credited the day it is delivered, free Nova Saver withdrawals, refused parcels at the normal charge, Nova Recover, and a rider voice note on every refusal. <a href="/#signup">Start free</a></li>
${RIVALS.map(r => `<li><b>${esc(r.name)}: best when ${esc(r.pick)}.</b> Its strength is ${esc(r.strength)}. <a href="/novax-vs-${r.slug}.html">NovaX vs ${esc(r.name)}</a></li>`).join("\n")}
</ol>
<h2>How the couriers compare</h2>
<div class="wrap"><table class="cmp"><thead><tr><th></th><th>COD fee</th><th>When COD is paid</th><th>Coverage</th></tr></thead><tbody>
<tr><th>NovaX</th><td class="nx" data-l="COD fee"><b>None</b>, no percentage</td><td class="nx" data-l="When COD is paid"><b>The day it is delivered</b>, to your wallet</td><td class="nx" data-l="Coverage">12 cities</td></tr>
${RIVALS.map(r => `<tr><th>${esc(r.name)}</th><td data-l="COD fee">${esc(r.how.codFee)}</td><td data-l="When COD is paid">${esc(r.how.payout)}</td><td data-l="Coverage">${esc(r.how.coverage)}</td></tr>`).join("\n")}
</tbody></table></div>
<h2>Five questions to ask any courier before you sign</h2>
<ol>
<li><b>What is the COD fee, in rupees, on a Rs 3,000 order?</b> A percentage grows with every sale. NovaX's answer is zero.</li>
<li><b>On which day does the cash reach my bank?</b> Get the remittance cycle in writing. NovaX credits your wallet the day the parcel is delivered.</li>
<li><b>What do I pay when a customer refuses?</b> Some couriers add a return fee on top of delivery. NovaX charges the normal delivery charge only.</li>
<li><b>Is there a minimum volume or a contract?</b> NovaX has neither.</li>
<li><b>Can I see why a parcel was refused?</b> NovaX riders record a voice note on every refusal.</li>
</ol>
<a class="go" href="/#signup">Start shipping with NovaX</a>`;
  const faq = [
    ["Which courier is best for COD in Pakistan?", `For orders to ${CITIES}, NovaX: no COD fee or percentage, COD credited the day the parcel is delivered, and no extra return fee. For other towns, a nationwide courier such as TCS or Leopards.`],
    ["Which courier pays COD fastest?", "NovaX credits COD to your wallet the day the parcel is delivered, and you choose how fast it reaches your bank: free in 48–72 hours, Rs 100 within 24 hours or Rs 500 in 6–12 hours. PostEx offers early payout through its own commission model."],
    ["Do couriers in Pakistan charge a COD fee?", "Most nationwide couriers charge a COD handling fee, often tiered by order value or a percentage with a minimum. NovaX charges no COD fee."],
    ["How much does COD delivery cost with NovaX?", "Rs 225 for the first kg to a Karachi address, Rs 250 to Lahore, Islamabad, Rawalpindi and the new stations, plus Rs 85 per extra kg. Pickup is free."],
  ];
  return page({ slug: "best-cod-courier-pakistan", title: "Best COD courier in Pakistan for online sellers (2026 comparison)",
    h1: "Best COD courier in Pakistan for online sellers (2026)",
    desc: `NovaX, TCS, Leopards, PostEx, Trax and M&P compared for online sellers: COD fees, payout speed, refused parcels and coverage. Updated ${UPDATED}.`,
    crumb: null, body, faq });
}

const files = [["best-cod-courier-pakistan.html", hub()], ...RIVALS.map(r => ["novax-vs-" + r.slug + ".html", vsPage(r)])];
for (const [f, html] of files) { writeFileSync(path.join(root, f), html); console.log("wrote", f, html.length); }
