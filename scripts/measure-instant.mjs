// How fast does Nova Instant feel on a cheap phone?
// Opens the booking page in headless Chrome as a 360x640 phone with the
// processor slowed 6x on a slow connection, and reports:
//   shown       when the booking screen is on screen (first visit, repeat visit)
//   ready       when the page's own script is running and every tap acts
//   tap         how long a tap takes to show a result
//   movement    how much the layout shifts by itself (0 is the goal)
// Usage: node scripts/measure-instant.mjs [url] [--cpu=6] [--fast]
// Needs Google Chrome. Changes nothing: it only looks.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--")) || "https://novaxlogistics.com/instant.html";
const cpu = Number((args.find((a) => a.startsWith("--cpu=")) || "--cpu=6").slice(6));
const fast = args.includes("--fast");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(CHROME)) { console.error("Google Chrome is not installed."); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), "nvi-measure-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + dir, "--no-first-run",
  "--disable-extensions", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => { try { chrome.kill(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); };

let port = 0;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  try { port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {}
}
if (!port) { console.error("Chrome did not start."); done(1); }
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const waiting = new Map(); const events = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } else if (d.method) events.push(d.method); };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, (d) => d.error ? rej(new Error(method + ": " + d.error.message)) : res(d.result)); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

await send("Page.enable"); await send("Network.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true });
await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 12; TECNO KG5k) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36" });
await send("Emulation.setCPUThrottlingRate", { rate: cpu });
if (!fast) await send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 7.5e5 / 8 });
// Runs inside the page before anything else: stamps the moments that matter.
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(function(){
  var m=window.__m={ shifts:[], usable:null, ready:null, fcp:null, lcp:null, taps:[] };
  var rt=setInterval(function(){ if(window.__nviReady){ m.ready=performance.now(); clearInterval(rt); } },10);
  try{ new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ m.shifts.push({ t:e.startTime, v:e.value, input:e.hadRecentInput }); }); }).observe({ type:"layout-shift", buffered:true }); }catch(e){}
  try{ new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ if(e.name==="first-contentful-paint") m.fcp=e.startTime; }); }).observe({ type:"paint", buffered:true }); }catch(e){}
  try{ new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ m.lcp=e.startTime; }); }).observe({ type:"largest-contentful-paint", buffered:true }); }catch(e){}
  try{ new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ if(e.name==="click"||e.name==="pointerup") m.taps.push({ name:e.name, delay:e.processingStart-e.startTime, total:e.duration }); }); }).observe({ type:"event", durationThreshold:16, buffered:true }); }catch(e){}
  var seen=function(){ if(m.usable==null&&document.getElementById("go")){ m.usable=performance.now(); return true; } return m.usable!=null; };
  document.addEventListener("DOMContentLoaded",function(){ if(seen()) return; var o=new MutationObserver(function(){ if(seen()) o.disconnect(); }); o.observe(document.documentElement,{ childList:true, subtree:true }); });
  window.addEventListener("click",function(e){ m.clickAt=performance.now(); m.domAt=null; var o=new MutationObserver(function(){ m.domAt=performance.now(); o.disconnect(); }); o.observe(document.body,{ childList:true, subtree:true, attributes:true }); },true);
})();` });

async function visit(label) {
  await send("Page.navigate", { url });
  let m = null;
  for (let i = 0; i < 400; i++) { await sleep(100); try { m = await js("window.__m&&window.__m.usable!=null&&window.__m.ready!=null?JSON.stringify(window.__m):null"); } catch { m = null; } if (m) break; }
  if (!m) { console.log(label + ": the booking button never appeared (40 s)."); return null; }
  await sleep(2500);   // let late shifts happen
  return JSON.parse(await js("JSON.stringify(window.__m)"));
}
const r = (n) => n == null ? "n/a" : Math.round(n) + " ms";
const shift = (m, after) => m.shifts.filter((s) => !s.input && (after == null || s.t > after)).reduce((a, s) => a + s.v, 0);

const first = await visit("First visit");
await sleep(3000);   // the service worker saves the page
const again = await visit("Repeat visit");
let tap = null;
if (again) {
  const box = await js(`(function(){ var b=document.querySelector('[data-pick="p"]'); if(!b) return null; var r=b.getBoundingClientRect(); return JSON.stringify({ x:r.left+r.width/2, y:r.top+r.height/2 }); })()`);
  if (box) {
    const p = JSON.parse(box);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(2500);
    tap = JSON.parse(await js("JSON.stringify(window.__m)"));
  }
}
console.log(`\nNova Instant on a slow phone (360x640, processor ${cpu}x slower${fast ? "" : ", slow connection"})\n${url}\n`);
if (first) console.log(`First visit    shown ${r(first.fcp)}   ready ${r(first.ready)}   movement ${shift(first).toFixed(3)}`);
if (again) console.log(`Repeat visit   shown ${r(again.fcp)}   ready ${r(again.ready)}   movement ${shift(again).toFixed(3)}`);
if (tap && tap.clickAt != null) {
  const ev = tap.taps.filter((t) => t.name === "click").pop();
  console.log(`Tap on Pickup  screen starts to change ${r(tap.domAt != null ? tap.domAt - tap.clickAt : null)}   painted ${ev ? r(ev.total) : "under 16 ms"}   movement after the tap ${shift(tap, tap.clickAt).toFixed(3)}`);
} else console.log("Tap on Pickup  could not be measured.");
console.log("\nGoals: tap under 100 ms, screen change under 150 ms, ready under 1000 ms on a repeat visit, movement 0.");
done(0);
