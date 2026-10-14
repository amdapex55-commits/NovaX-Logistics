// 12 Oct 2026: rider.html?demo=1 shows the rider app with sample data and no
// sign-in. It must never reach NovaX, never touch a real login on the same
// phone, and never keep anything.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=createRequire('/tmp/novax-rider-test-deps/package.json')('jsdom'));}
const root=new URL('../',import.meta.url);
const html=readFileSync(new URL('rider.html',root),'utf8');
const scripts=['nv-payment.js','nv-journey.js','rider-core.js','rider-app.js'].map(f=>readFileSync(new URL(f,root),'utf8'));
const ok=m=>console.log('ok - '+m);
const wait=(ms=60)=>new Promise(r=>setTimeout(r,ms));
async function app(search,{withRealLogin}={}){
  const dom=new JSDOM(html,{url:'https://fixture.invalid/rider.html'+search,runScripts:'outside-only'}),w=dom.window;
  w.crypto.randomUUID=()=>crypto.randomUUID();w.scrollTo=()=>{};
  Object.defineProperty(w.navigator,'locks',{configurable:true,value:{request:async(_k,fn)=>fn()}});
  const net=[];w.fetch=(u)=>{net.push(String(u));return Promise.reject(new Error('no network in the preview'));};
  let made=0;w.supabase={createClient(){made++;throw new Error('the preview must not make a real client');}};
  const dialog=w.document.querySelector('dialog');dialog.showModal=()=>{dialog.open=true;};dialog.close=v=>{dialog.returnValue=v;dialog.open=false;dialog.onclose&&dialog.onclose();};
  if(withRealLogin){w.localStorage.setItem('novaxSession','{"role":"rider","uid":"real-user"}');w.localStorage.setItem('sb-rhzunbzbdzicajqtohwp-auth-token','{"access_token":"real"}');
    w.localStorage.setItem('novaxRiderQueue:v2:real-user:real-rider','[{"key":"k","user":"real-user","rider":"real-rider"}]');w.localStorage.setItem('novaxRiderStation:v1:real-user:real-rider','{"saved":true}');}
  const before=JSON.stringify(Object.fromEntries(Object.keys(w.localStorage).sort().map(k=>[k,w.localStorage.getItem(k)])));
  let threw=null;try{scripts.forEach(s=>w.eval(s));}catch(e){threw=e;}await wait();
  const q=id=>w.document.getElementById(id);
  const go=v=>w.document.querySelector(`nav [data-view="${v}"]`).click(),tab=t=>w.document.querySelector(`[data-tab="${t}"]`).click();
  const pick=awb=>{const cb=w.document.querySelector(`.view:not(.hidden) [data-pick="${awb}"]`);cb.checked=true;cb.dispatchEvent(new w.Event('change',{bubbles:true}));};
  const ls=()=>JSON.stringify(Object.fromEntries(Object.keys(w.localStorage).sort().map(k=>[k,w.localStorage.getItem(k)])));
  return{dom,w,q,go,tab,pick,net,made:()=>made,before,ls,dialog,threw};
}
// 1. opens with no sign-in, on a phone that also has a real rider login
{
  const a=await app('?demo=1',{withRealLogin:true});
  assert.equal(a.threw,null);assert.equal(a.q('gate').classList.contains('hidden'),true,'no sign-in wall');
  assert.equal(a.q('riderName').textContent,'Demo Rider');assert.match(a.q('routeName').textContent,/Lahore/);
  assert.match(a.w.document.querySelector('.demo-bar').textContent,/Preview with sample data\. Nothing here is real, and nothing is saved\./);
  assert.equal(a.q('logoutBtn').textContent,'Exit');assert.equal(a.q('installCard').classList.contains('hidden'),true,'nothing to install from a preview');
  assert.match(a.q('homePickup').textContent,/^5 to collect$/);assert.match(a.q('homeDelivery').textContent,/^5 arriving · 9 at station · 3 out now$/);assert.match(a.q('homeTransit').textContent,/^3 to send$/);
  assert.equal(a.made(),0,'no connection to NovaX is created');assert.equal(a.net.length,0,'and nothing is fetched');
  assert.equal(a.ls(),a.before,'the real login, its saved actions and its saved station are untouched');
  assert.equal(a.w.NovaXRiderClient,undefined);

  // collect two: one stays in Lahore (At station), one is for Karachi (Transit)
  a.go('pickup');const awbs=[...a.q('collectList').querySelectorAll('[data-pick]')].map(x=>x.dataset.pick);assert.equal(awbs.length,5);
  const local=awbs[0],away=awbs[2];a.pick(local);a.pick(away);assert.match(a.q('actionGo').textContent,/Mark 2 collected/);
  a.q('actionGo').click();await wait(250);
  assert.equal(a.q('collectList').querySelectorAll('[data-pick]').length,3);
  a.go('home');assert.match(a.q('homePickup').textContent,/^3 to collect$/);assert.match(a.q('homeDelivery').textContent,/10 at station/);assert.match(a.q('homeTransit').textContent,/^4 to send$/);
  // receive the batch from Karachi
  a.go('delivery');a.tab('delivery:receive');assert.match(a.q('batchList').textContent,/KAR-LAH-DEMO.*0 \/ 4 received/s);
  a.q('batchList').querySelector('[data-selall]').click();await wait();assert.match(a.q('actionGo').textContent,/Mark 4 received/);a.q('actionGo').click();await wait(60);a.dialog.close('confirm');await wait(250);
  assert.equal(a.q('batchList').querySelectorAll('.parcel').length,0);assert.equal(a.q('nArriving').textContent,'1');assert.equal(a.q('nStation').textContent,'14');
  // deliver one that is out: cash to hand over goes up by its COD
  a.tab('delivery:out');const btn=a.q('outList').querySelector('[data-act="delivered"]');const cod=Number(/COD Rs ([\d,]+)/.exec(btn.closest('.parcel').textContent)[1].replace(/,/g,''));
  const cashBefore=Number(/Cash to hand over\s*Rs ([\d,]+)/.exec(a.q('stats').textContent)[1].replace(/,/g,''));
  btn.click();await wait();a.dialog.close('confirm');await wait(300);
  assert.equal(a.q('outList').querySelectorAll('.parcel').length,2);
  const cashAfter=Number(/Cash to hand over\s*Rs ([\d,]+)/.exec(a.q('stats').textContent)[1].replace(/,/g,''));assert.equal(cashAfter,cashBefore+cod);
  // a made-up number never rings
  a.tab('delivery:station');const call=a.q('stationList').querySelector('a.call[href^="tel:"]');const ev=new a.w.MouseEvent('click',{bubbles:true,cancelable:true});call.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented,true);assert.match(a.w.document.getElementById('riderToast').textContent,/calls and WhatsApp are switched off/);
  assert.equal(a.net.length,0);assert.equal(a.made(),0);assert.equal(a.ls(),a.before,'still nothing kept on the phone after using it');
  a.q('langBtn').click();await wait();assert.match(a.w.document.querySelector('.demo-bar').textContent,/sirf namoona/);
  a.dom.window.close();
  ok('preview: opens signed-out, shows a working sample station, reaches nothing and keeps nothing (only the language choice)');
}
// 2. without ?demo it is the real app: the preview code is not in play
{
  const a=await app('?nosw=1');
  assert.equal(a.made(),1,'the real client is asked for');assert.equal(a.w.document.querySelector('.demo-bar'),null);
  assert.notEqual(a.q('riderName').textContent,'Demo Rider');assert.equal(a.q('gate').classList.contains('hidden'),false,'and the sign-in wall stands');
  a.dom.window.close();
  ok('no ?demo: nothing of the preview runs, and the sign-in wall stands');
}
console.log('RIDER PREVIEW CHECKS PASSED');
