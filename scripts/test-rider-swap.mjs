// Nova Swap in the rider app: the doorstep buttons, one saved action, replay-safe.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {installFixture} from './rider-fixture.mjs';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=createRequire('/tmp/novax-rider-test-deps/package.json')('jsdom'));}
const html=readFileSync(new URL('../rider.html',import.meta.url),'utf8');
const scripts=['nv-payment.js','nv-journey.js','rider-core.js','rider-app.js'].map(f=>readFileSync(new URL('../'+f,import.meta.url),'utf8'));
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));
async function app(opts){
  const dom=new JSDOM(html,{url:'https://fixture.invalid/rider.html?nosw=1',runScripts:'outside-only'}),w=dom.window;
  w.crypto.randomUUID=()=>crypto.randomUUID();const fixture=installFixture(w,opts);
  const dialog=w.document.querySelector('dialog');dialog.showModal=()=>{dialog.open=true;};
  dialog.close=v=>{dialog.returnValue=v;dialog.open=false;dialog.onclose&&dialog.onclose();};
  scripts.forEach(s=>w.eval(s));await wait();return{dom,w,fixture,q:id=>w.document.getElementById(id),dialog};
}
let a=await app({swap:true});
const card=[...a.q('outList').querySelectorAll('.parcel')].find(c=>c.querySelector('[data-swap]'));
assert.ok(card,'swap card shows swap buttons');
assert.match(card.textContent,/NOVA SWAP/);assert.match(card.textContent,/N9999999/);
assert.equal(card.querySelector('[data-action="Delivered"]'),null,'normal Delivered button replaced');
card.querySelector('[data-swap="exchanged"]').click();await wait();
assert.match(a.q('dialogText').textContent,/N9999999/);
a.dialog.close('confirm');await wait(120);
let req=a.fixture.requests.filter(r=>r.name==='rider_swap_complete');
assert.equal(req.length,1);assert.equal(req[0].args.p_outcome,'exchanged');assert.ok(req[0].args.p_loc&&req[0].args.p_loc.lat);
assert.equal(a.fixture.rows[4].status,'Delivered');
a.dom.window.close();
// lost reply: same key is replayed, never a second action
a=await app({swap:true});a.fixture.failRpc='afterCommit';
[...a.q('outList').querySelectorAll('[data-swap="exchanged"]')][0].click();await wait();a.dialog.close('confirm');await wait(120);
const queued=JSON.parse(a.w.localStorage.getItem([...Array(a.w.localStorage.length).keys()].map(i=>a.w.localStorage.key(i)).find(k=>/Queue:v2/.test(k)))||'[]');
assert.equal(queued.length,1);a.fixture.failRpc=null;a.w.dispatchEvent(new a.w.Event('online'));await wait(150);
req=a.fixture.requests.filter(r=>r.name==='rider_swap_complete');
assert.equal(new Set(req.map(r=>r.args.p_key)).size,1,'replay uses one key');
a.dom.window.close();
// cannot exchange: needs a reason
a=await app({swap:true});
[...a.q('outList').querySelectorAll('[data-swap="failed"]')][0].click();await wait();
a.q('reasonOther').value='Customer does not have the old item';a.dialog.close('confirm');await wait(120);
req=a.fixture.requests.filter(r=>r.name==='rider_swap_complete');
assert.equal(req[0].args.p_outcome,'failed');assert.match(req[0].args.p_reason,/old item/);
a.dom.window.close();
console.log('PASS rider swap: doorstep buttons, return AWB shown, exchanged with GPS, lost-reply replay on one key, failed needs reason.');
