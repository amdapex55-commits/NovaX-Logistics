// 12 Oct 2026: riders asked to put the rider app on their phone's home screen.
// Checks the manifest, the page's phone tags, and the Add card's behaviour.
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {installFixture} from './rider-fixture.mjs';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=createRequire('/tmp/novax-rider-test-deps/package.json')('jsdom'));}
const root=new URL('../',import.meta.url);
const html=readFileSync(new URL('rider.html',root),'utf8');
const sw=readFileSync(new URL('sw.js',root),'utf8');
const scripts=['nv-payment.js','nv-journey.js','rider-core.js','rider-app.js'].map(f=>readFileSync(new URL(f,root),'utf8'));
const ok=m=>console.log('ok - '+m);
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));

// 1. the manifest a phone reads
{
  const m=JSON.parse(readFileSync(new URL('assets/rider.webmanifest',root),'utf8'));
  assert.equal(m.name,'NovaX Rider');assert.ok(m.short_name.length<=12,'the name under the icon is not cut short');
  assert.equal(m.start_url,'/rider.html');assert.equal(m.id,'/rider.html');assert.equal(m.display,'standalone');
  assert.equal(m.scope,'/','signing in happens on index.html, which must stay inside the installed window');
  assert.ok(/var SHELLS = \[[^\]]*"\/rider\.html"/.test(sw),'the page it opens is kept for offline');
  const png=p=>{const b=readFileSync(new URL(p.replace(/^\//,''),root));assert.equal(b.toString('latin1',1,4),'PNG');return b.readUInt32BE(16)+'x'+b.readUInt32BE(20);};
  for(const i of m.icons){assert.equal(i.type,'image/png');assert.equal(png(i.src),i.sizes,i.src);}
  assert.ok(m.icons.some(i=>i.sizes==='192x192')&&m.icons.some(i=>i.sizes==='512x512'&&!i.purpose)&&m.icons.some(i=>i.purpose==='maskable'),'192, 512 and a maskable icon');
  const other=JSON.parse(readFileSync(new URL('assets/instant-rider.webmanifest',root),'utf8'));assert.notEqual(other.id,m.id,'a different app from Nova Instant');
  ok('manifest: NovaX Rider, opens rider.html in its own window, icons are the sizes they say');
}
// 2. the page points at it, with the lines an iPhone needs
{
  for(const t of ['<link rel="manifest" href="/assets/rider.webmanifest">','<meta name="theme-color" content="#071d17">','<link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png">',
    '<meta name="apple-mobile-web-app-capable" content="yes">','<meta name="mobile-web-app-capable" content="yes">','<meta name="apple-mobile-web-app-title" content="NovaX Rider">'])assert.ok(html.includes(t),t);
  assert.ok(existsSync(new URL('assets/apple-touch-icon.png',root)));
  assert.ok(!/id="installBtn"[^>]*data-write/.test(html),'the Add button is not one of the buttons that wait for a connection');
  ok('rider.html: manifest, theme colour and iPhone home-screen tags');
}
// 3. the Add card
async function app({ua,standalone,flags}={}){
  const dom=new JSDOM(html,{url:'https://fixture.invalid/rider.html?nosw=1',runScripts:'outside-only'}),w=dom.window;
  if(ua)Object.defineProperty(w.navigator,'userAgent',{configurable:true,get:()=>ua});
  w.crypto.randomUUID=()=>crypto.randomUUID();installFixture(w,{});
  const dialog=w.document.querySelector('dialog');dialog.showModal=()=>{dialog.open=true;};dialog.close=v=>{dialog.returnValue=v;dialog.open=false;dialog.onclose&&dialog.onclose();};
  if(standalone)w.matchMedia=q=>({matches:/standalone/.test(q)});
  for(const k of flags||[])w.localStorage.setItem(k,'1');
  scripts.forEach(s=>w.eval(s));await wait();
  const q=id=>w.document.getElementById(id);
  return{dom,w,q,shown:()=>!q('installCard').classList.contains('hidden')};
}
{
  let a=await app();assert.equal(a.shown(),true,'offered in a browser tab');assert.equal(a.q('installSteps').classList.contains('hidden'),true);
  a.q('installBtn').click();await wait();assert.match(a.q('installSteps').textContent,/menu \(⋮\).*Add to Home screen.*Install app/);
  a.q('langBtn').click();await wait();assert.match(a.q('installSteps').textContent,/Browser ke upar menu/);assert.match(a.q('installCard').textContent,/home screen par lagayein/);a.dom.window.close();
  a=await app({ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'});
  a.q('installBtn').click();await wait();assert.match(a.q('installSteps').textContent,/Share button.*Add to Home Screen/);a.dom.window.close();
  a=await app({ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1'});
  a.q('installBtn').click();await wait();assert.match(a.q('installSteps').textContent,/works in Safari/);a.dom.window.close();
  a=await app({ua:'Mozilla/5.0 (Linux; Android 13; SM-A135F; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 WhatsApp/2.24'});
  a.q('installBtn').click();await wait();assert.match(a.q('installSteps').textContent,/Open this page in Chrome first/);a.dom.window.close();
  ok('Add without a prompt: the right steps for Android, iPhone Safari, iPhone Chrome and WhatsApp\'s browser, in both languages');

  // Android hands over a prompt: the tap shows it, once
  a=await app();let prompted=0,prevented=false;
  const ev=new a.w.Event('beforeinstallprompt',{cancelable:true});ev.prompt=()=>{prompted++;};ev.userChoice=Promise.resolve({outcome:'accepted'});
  const pd=ev.preventDefault.bind(ev);ev.preventDefault=()=>{prevented=true;pd();};
  a.w.dispatchEvent(ev);assert.equal(prevented,true,'the browser\'s own mini-bar is held back');
  a.q('installBtn').click();await wait();assert.equal(prompted,1);assert.equal(a.q('installSteps').classList.contains('hidden'),true,'no written steps when the phone asks by itself');
  a.q('installBtn').click();await wait();assert.equal(prompted,1,'a used prompt is not shown twice');
  a.w.dispatchEvent(new a.w.Event('appinstalled'));await wait();assert.equal(a.shown(),false);assert.equal(a.w.localStorage.getItem('novaxRiderInstalled'),'1');
  assert.match(a.w.document.getElementById('riderToast').textContent,/on your home screen/);a.dom.window.close();
  ok('Add with a prompt: shown once on the tap, and the card goes when the app is installed');

  a=await app({standalone:true});assert.equal(a.shown(),false,'nothing to add when it is already open from the home screen');a.dom.window.close();
  a=await app({flags:['novaxRiderInstalled']});assert.equal(a.shown(),false);
  const again=new a.w.Event('beforeinstallprompt',{cancelable:true});again.prompt=()=>{};again.userChoice=Promise.resolve({});a.w.dispatchEvent(again);assert.equal(a.shown(),true,'removed from the phone later: offered again');a.dom.window.close();
  a=await app();a.q('installHide').click();assert.equal(a.shown(),false);assert.equal(a.w.localStorage.getItem('novaxRiderInstallHide'),'1');a.dom.window.close();
  a=await app({flags:['novaxRiderInstallHide']});assert.equal(a.shown(),false,'"not now" is remembered on this phone');a.dom.window.close();
  ok('hidden when already installed or opened from the home screen, and after "not now"');
}
console.log('RIDER INSTALL CHECKS PASSED');
