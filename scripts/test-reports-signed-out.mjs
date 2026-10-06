// Reports must never show "No parcels booked" just because the page has lost
// its sign-in. NovaX hides a merchant's parcels from every other login without
// an error, so a signed-out page is answered with an empty list. (6 Oct 2026:
// a portal tab whose sign-in had ended showed "0 parcels booked" for a merchant
// with 16 parcels that day.)
// Run: node scripts/test-reports-signed-out.mjs   (part of npm run test:client)
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const src = readFileSync(new URL("../client-reports.js", import.meta.url), "utf8");
let bad = 0;
const ok = (label, pass, why) => { console.log((pass ? "ok - " : "FAIL - ") + label + (pass || !why ? "" : ": " + why)); if (!pass) bad++; };

async function run(mode) {
  const dom = new JSDOM('<!doctype html><body><div id="nvReport2"></div></body>', { runScripts: "outside-only", pretendToBeVisual: true, url: "https://novaxlogistics.com/client.html" });
  const w = dom.window, calls = [];
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  w.localStorage.setItem("nvRep2", JSON.stringify({ period: "today", compare: false }));
  const rows = () => Array.from({ length: 5 }, (_, i) => ({ id: "u" + i, awb: "N853028" + i, consignee: "Test " + i, phone: "03001234567", address: "House " + i, city: "Lahore",
    status: "New booked", cod_amount: 1500, fee: 250, booked_at: new Date(Date.now() - i * 1000).toISOString(), delivered_at: null, status_since: null, exception: "", invoice_id: null, steps: ["New booked"], orderId: "", destArr: null }));
  const builder = (table) => { const b = { select: () => b, eq: () => b, gte: () => b, lt: () => b, order: () => b, range: () => b, limit: () => b,
    then: (res) => { calls.push(table); const data = table === "parcels" ? (mode === "in" ? rows() : []) : table === "clients" ? (mode === "out" ? [] : [{ id: "cid" }]) : []; return Promise.resolve({ data, error: null }).then(res); } }; return b; };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  w.__nvRepBridge = { clientId: () => "cid", clientName: () => "Test Store", parcels: () => [], sb: () => ({ from: builder }), demo: () => false,
    nvStatus: (s) => s, statusLabel: (s) => s, money: (n) => "Rs " + n, esc, isDelivered: () => false, settled: () => false, rated: () => false, ageText: () => "", agingHours: () => 0,
    paidPill: () => "", csvCell: (v) => v, toast() {}, stepsOf: (st) => [st], openParcel() {}, printHtml: () => true, showTab() {} };
  w.eval(src);
  w.NovaXReports.open(w.document.getElementById("nvReport2"));
  await new Promise((r) => setTimeout(r, 150));
  const text = w.document.getElementById("nvReport2").textContent;
  dom.window.close();
  return { text, calls };
}

const out = await run("out");
ok("a page that lost its sign-in is told to sign in again", /Sign in again to see this report/.test(out.text), out.text.slice(0, 160));
ok("and is not told the merchant has no parcels", !/No parcels booked/.test(out.text));
ok("the report checked whether it can still see the account", out.calls.join(",") === "parcels,clients", out.calls.join(","));

const empty = await run("empty");
ok("a merchant who really has no parcels still sees the plain empty state", /No parcels booked today/.test(empty.text) && !/Sign in again/.test(empty.text), empty.text.slice(0, 160));

const signedIn = await run("in");
ok("a signed-in merchant sees their parcels", /5 parcels booked/.test(signedIn.text), signedIn.text.slice(0, 160));
ok("with no extra question to NovaX", signedIn.calls.join(",") === "parcels", signedIn.calls.join(","));

console.log(bad ? `REPORTS SIGNED-OUT CHECKS FAILED (${bad})` : "REPORTS SIGNED-OUT CHECKS PASSED");
process.exit(bad ? 1 : 0);
