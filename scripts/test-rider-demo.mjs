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
  const MAP={delivery:'parcels',cash:'parcels',home:'process',pickup:'process',transit:'process'};
  const go=v=>w.document.querySelector(`nav [data-view="${MAP[v]||v}"]`).click(),tab=()=>{};
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
  assert.equal(a.q('hCollect').textContent,'5');assert.equal(a.q('nStation').textContent,'9');assert.equal(a.q('nOut').textContent,'3');assert.equal(a.q('hTransit').textContent,'3');
  assert.equal(a.made(),0,'no connection to NovaX is created');assert.equal(a.net.length,0,'and nothing is fetched');
  assert.equal(a.ls(),a.before,'the real login, its saved actions and its saved station are untouched');
  assert.equal(a.w.NovaXRiderClient,undefined);

  // collect: one button per shipper
  const coll=[...a.q('collectList').querySelectorAll('[data-collect-awbs]')];assert.ok(coll.length>=1);
  const n0=coll[0].getAttribute('data-collect-awbs').split(',').length;coll[0].click();await wait(250);
  assert.equal(a.q('hCollect').textContent,String(5-n0));
  // receive the demo sack: its own card, its own count
  assert.match(a.q('manifestList').textContent,/KAR-LAH-DEMO.*4 to receive/s);
  const st0=Number(a.q('nStation').textContent);
  a.q('manifestList').querySelector('[data-recv-awbs]').click();await wait(60);a.dialog.close('confirm');await wait(250);
  assert.doesNotMatch(a.q('manifestList').textContent,/KAR-LAH-DEMO/);assert.ok(Number(a.q('nStation').textContent)>=st0+3,'received parcels are at the station');
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
