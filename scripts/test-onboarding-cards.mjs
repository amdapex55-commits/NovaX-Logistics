// The cards a new merchant sees on first sign-in. Runs the portal's own deck
// code in a fake browser: the cards, their facts, the buttons, the keys, and
// the swipe. Touches no network and no database.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const app = readFileSync(new URL("../client-app.js", import.meta.url), "utf8");
const mail = readFileSync(new URL("../supabase/functions/novax-email-drain/templates.ts", import.meta.url), "utf8");
function fn(name){ const a=app.indexOf("    function "+name+"("); assert.ok(a>-1,"missing fn "+name); let i=app.indexOf("{",a),d=0; for(;i<app.length;i++){ if(app[i]==="{")d++; else if(app[i]==="}"){ d--; if(!d)break; } } return app.slice(a,i+1); }
const ok = (m) => console.log("ok - " + m);
const wait = (ms=20) => new Promise(r => setTimeout(r, ms));

function page({ demo=false, reduce=true } = {}){
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts:"outside-only", url:"https://novaxlogistics.com/client.html", pretendToBeVisual:true });
  const w = dom.window;
  w.__tabs = []; w.__done = []; w.__NOVAX_DEMO = demo;
  w.matchMedia = () => ({ matches: reduce });
  w.eval([
    "var NV_ONBOARD_SHOWN=false;",
    "var NV_BOTTOM_TABS=[{id:'dashboard',label:'Home',ico:'H'},{id:'newBooking',label:'Book',ico:'+'},{id:'money',label:'Wallet',ico:'R'},{id:'tickets',label:'Support',ico:'S'}];",
    "function showClientTab(t){ window.__tabs.push(t); }",
    "function nvOnboardMarkDone(c){ window.__done.push(c); }",
    /const WALLET_FEE=\{[^}]*\};/.exec(app)[0],
    ["walletFee","walletFeeText","walletSpeedName","walletSpeedWindow","nvOnboardCards","nvObWhere","nvOnboardBuild"].map(fn).join("\n"),
    "window.__cards=nvOnboardCards; window.__build=nvOnboardBuild;"
  ].join("\n"));
  const $ = (q) => w.document.querySelector(q);
  const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
  return { w, $, text };
}

// 1. The cards and their order.
{
  const p = page(); const cards = p.w.__cards();
  assert.deepEqual(plain(cards.map(c => c.t)), ["Your workspace is live","Book it","Print the label","Request pickup","Follow every parcel",
    "If a customer refuses","COD in your wallet the day it lands","Withdraw to your bank","It is all in the menu"]);
  assert.deepEqual(plain(cards.slice(1,4).map(c => c.k)), ["Step 1 of 3","Step 2 of 3","Step 3 of 3"]);
  for (const c of cards) { assert.ok(c.t && c.b && c.v && c.nav && c.k, "every card has a label, title, text, picture and a place"); }
  ok("nine cards, the three first-parcel steps first, in the order they happen");
  const all = cards.map(c => [c.t, c.b, c.v, c.n || ""].join(" ")).join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  // Facts that are settled elsewhere must be the same words here.
  const PRICE = /const PRICE = '([^']+)'/.exec(mail)[1];
  assert.ok(all.includes(PRICE), "price line is word for word the emails' line");
  for (const line of ["Riders collect between 11 am and 9 pm on working days.", "Pickup is free in Karachi, Lahore, Islamabad and Rawalpindi.",
    "Karachi same day or next day. Lahore, Islamabad and Rawalpindi in 2–3 working days.", "COD in your wallet the day it lands"]) {
    assert.ok(mail.includes(line), "the emails still say: " + line);
    assert.ok(all.includes(line), "the cards say: " + line);
  }
  ok("price, pickup hours, free pickup, delivery times and the COD line match the approved emails word for word");
  for (const s of ["Nova Saver · 48-72 hours Free", "Nova Express · 24 hours Fee Rs 100", "Nova Bolt · 6-12 hours Fee Rs 500"]) assert.ok(all.includes(s), s);
  ok("the three payout speeds come from the wallet's own names and fees");
  assert.ok(!/instant|2-3 hours|15 minutes|Create AWB/i.test(all), "no stale wording");
  assert.ok(!/[<]script|undefined|NaN/.test(cards.map(c => c.v).join("")));
  for (const s of ["Paste order","Labels and pickup","Request pickup","Bulk booking","Shopify","WooCommerce","Team","Reports","Nova Swap","API","NovaX AI","0312 3922558","tracking link"]) assert.ok(all.includes(s), "mentions " + s);
  ok("covers paste order, labels, pickup, tracking link, refusals, wallet, withdrawal, bulk, stores, team, reports, swap and help");
}

// 2. The deck: buttons, count, last card, finish.
{
  const p = page(); p.w.__build("c1");
  assert.ok(p.$("#nvObDeck"), "deck is on screen");
  assert.equal(p.$("#nvObDeck").getAttribute("aria-modal"), "true");
  assert.equal(p.w.document.querySelectorAll(".nvob-dot").length, 9);
  assert.equal(p.text(p.$("#nvObCount")), "1 / 9");
  assert.equal(p.$("#nvObPrev").disabled, true);
  assert.equal(p.text(p.$("#nvObCard h3")), "Your workspace is live");
  assert.ok(p.w.document.body.classList.contains("nvob-lock"));
  const seen = [];
  for (let k = 0; k < 8; k++) { seen.push(p.text(p.$("#nvObCard h3"))); p.$("#nvObNext").click(); await wait(); }
  assert.equal(p.text(p.$("#nvObCount")), "9 / 9");
  assert.equal(p.text(p.$("#nvObNext")), "Book your first parcel");
  assert.equal(p.w.document.querySelectorAll(".nvob-dot.on").length, 9);
  assert.ok(p.text(p.$(".nvob-where")).startsWith("NovaX AI is on every screen"));
  p.$("#nvObPrev").click(); await wait();
  assert.equal(p.text(p.$("#nvObCount")), "8 / 9");
  assert.ok(p.$(".nvob-w-i.on") && p.text(p.$(".nvob-w-i.on")).includes("Wallet"), "the withdrawal card lights the Wallet tab");
  p.$("#nvObNext").click(); await wait(); p.$("#nvObNext").click(); await wait();
  assert.equal(p.$("#nvObDeck"), null, "deck closed");
  assert.deepEqual(plain(p.w.__tabs), ["newBooking"]); assert.deepEqual(plain(p.w.__done), ["c1"]);
  assert.ok(!p.w.document.body.classList.contains("nvob-lock"));
  ok("Next walks all nine, Back goes back, the count and the lit tab follow, and the last button opens New booking and remembers it was seen");
}
function plain(x){ return JSON.parse(JSON.stringify(x)); }

// 3. Skip, Escape and the arrow keys.
{
  let p = page(); p.w.__build("c2"); p.$("#nvObSkip").click();
  assert.equal(p.$("#nvObDeck"), null); assert.deepEqual(plain(p.w.__tabs), []); assert.deepEqual(plain(p.w.__done), ["c2"]);
  p = page(); p.w.__build("c3");
  const key = (k) => p.w.document.dispatchEvent(new p.w.KeyboardEvent("keydown", { key:k, bubbles:true }));
  key("ArrowRight"); await wait(); assert.equal(p.text(p.$("#nvObCount")), "2 / 9");
  key("ArrowLeft"); await wait(); assert.equal(p.text(p.$("#nvObCount")), "1 / 9");
  key("ArrowLeft"); await wait(); assert.equal(p.text(p.$("#nvObCount")), "1 / 9");
  key("Escape"); assert.equal(p.$("#nvObDeck"), null); assert.deepEqual(plain(p.w.__tabs), []);
  key("ArrowRight"); await wait();   // the key listener is gone with the deck
  ok("Skip and Escape close without opening anything; arrow keys move and stop at the first card");
}

// 4. Swipe: left is next, right is back, the first card springs back, a vertical drag is a scroll.
{
  const p = page(); p.w.__build("c4");
  const drag = (x1, y1, x2, y2) => {
    const card = p.$("#nvObCard"); card.setPointerCapture = () => {};
    const ev = (type, x, y) => { const e = new p.w.Event(type, { bubbles:true }); e.clientX = x; e.clientY = y; e.pointerId = 1; e.pointerType = "touch"; e.button = 0; card.dispatchEvent(e); };
    ev("pointerdown", x1, y1); ev("pointermove", (x1 + x2) / 2, (y1 + y2) / 2); ev("pointermove", x2, y2); ev("pointerup", x2, y2);
  };
  drag(300, 300, 150, 310); await wait(); assert.equal(p.text(p.$("#nvObCount")), "2 / 9");
  drag(100, 300, 260, 305); await wait(); assert.equal(p.text(p.$("#nvObCount")), "1 / 9");
  drag(100, 300, 260, 305); await wait();
  assert.equal(p.text(p.$("#nvObCount")), "1 / 9"); assert.equal(p.$("#nvObCard").style.transform, "", "the first card is back in place, not left off-centre");
  drag(200, 400, 215, 200); await wait(); assert.equal(p.text(p.$("#nvObCount")), "1 / 9");
  assert.equal(p.$("#nvObCard").style.transform, "");
  ok("swipe left is next, right is back, the first card springs back, and an up-down drag is left to scrolling");
}

// 5. The demo: says what it is, and ends without sending a visitor into a form.
{
  const p = page({ demo:true });
  assert.equal(p.w.__cards()[0].t, "This is the real portal, with sample parcels");
  let armed = 0; p.w.__nvDemoArmInvite = () => { armed++; };
  p.w.__build("demo-client");
  for (let k = 0; k < 8; k++) { p.$("#nvObNext").click(); await wait(); }
  assert.equal(p.text(p.$("#nvObNext")), "Explore the demo");
  p.$("#nvObNext").click(); await wait();
  assert.equal(p.$("#nvObDeck"), null); assert.deepEqual(plain(p.w.__tabs), []); assert.equal(armed, 1);
  ok("demo: first card says it is a demo, last button just closes, and the sign-up invitation is armed after it");
}

// 6. Phone rules in the stylesheet, and one tutorial only.
{
  const css = /css\.textContent = \[([\s\S]*?)\]\.join\(""\);/.exec(fn("nvOnboardBuild"))[1];
  assert.ok(!/backdrop-filter|blur\(/.test(css), "no blur");
  assert.ok(/\.nvob-ov\{[^}]*background:#040d09/.test(css), "solid backdrop on phones");
  assert.ok(!/getElementById\("nvObNext"\)\.focus/.test(fn("nvOnboardBuild")), "Next is not focused by script");
  assert.ok(!/touch-action:none/.test(css), "the card can scroll by touch");
  assert.ok(/touch-action:pan-y/.test(css) && /env\(safe-area-inset-bottom\)/.test(css));
  const sizes = [...css.matchAll(/font-size:([\d.]+)px/g)].map(m => Number(m[1]));
  assert.ok(Math.min(...sizes) >= 11, "smallest text is " + Math.min(...sizes) + "px");
  assert.ok(/\.nvob-skip\{[^}]*min-height:44px/.test(css) && /\.nvob-next\{[^}]*min-height:52px/.test(css) && /\.nvob-nav\{[^}]*width:52px;height:52px/.test(css));
  assert.ok(!app.includes("nvtour"), "the older nine-step tour is gone");
  assert.ok(app.includes("window.nvOnboardReplay = function"));
  ok("stylesheet: no blur, touch scrolling allowed, safe areas, text 11px or larger, buttons 44px or larger; one tutorial only");
}
console.log("ONBOARDING CARD CHECKS PASSED");
