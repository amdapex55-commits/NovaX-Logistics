// 28 Nov 2026: one sample story across the three previews an app reviewer
// opens. The merchant preview (client-app.js nvDemoSeed), the rider preview
// (rider.html?demo=1) and the customer tracker (tracking.html?demo=1&awb=…)
// must show the same parcel under the same AWB, and none may reach NovaX.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
let JSDOM;
try{ ({JSDOM}=await import('jsdom')); }
catch{ ({JSDOM}=createRequire('/tmp/novax-rider-test-deps/')('jsdom')); }
const root=new URL('../',import.meta.url), read=f=>readFileSync(new URL(f,root),'utf8');
const ok=m=>console.log('ok - '+m), wait=(ms=60)=>new Promise(r=>setTimeout(r,ms));
const dataSrc=read('nv-demo-data.js');
const box={}; new Function('window',dataSrc)(box); const D=box.NVDemo;
assert.ok(D&&D.parcels.length===7,'seven sample parcels');

// 1. the merchant preview's own copy is the same seven parcels
{
  const src=read('client-app.js'), start=src.indexOf('function nvDemoSeed(){');
  assert.ok(start>0,'nvDemoSeed is still in client-app.js');
  let i=src.indexOf('{',start), depth=0, end=-1;
  for(;i<src.length;i++){ const c=src[i]; if(c==='{') depth++; else if(c==='}'){ depth--; if(!depth){ end=i+1; break; } } }
  const seed=new Function(src.slice(start,end)+'; return nvDemoSeed();')();
  const mine=seed.tables.parcels;
  assert.deepEqual(mine.map(p=>p.awb),D.parcels.map(p=>p.awb),'same AWBs in the same order');
  for(const p of mine){
    const d=D.byAwb(p.awb);
    assert.equal(p.status,d.status,p.awb+' status'); assert.equal(p.consignee,d.consignee,p.awb+' consignee');
    assert.equal(p.city,d.city,p.awb+' city'); assert.equal(p.address,d.address,p.awb+' address');
    assert.equal(p.cod_amount,d.cod,p.awb+' COD'); assert.equal(p.phone,d.phone,p.awb+' phone');
    assert.equal(p.meta.weight,d.kg,p.awb+' weight'); assert.equal(p.exception||'',d.exception||'',p.awb+' note');
    const last=d.journey[d.journey.length-1][1], age=d.journey[0][1];
    assert.ok(Math.abs((Date.now()-Date.parse(p.updated_at))/36e5-last)<0.1,p.awb+' last change matches the journey');
    assert.ok(Math.abs((Date.now()-Date.parse(p.booked_at))/36e5-age)<0.1,p.awb+' booking time matches the journey');
    assert.equal(p.fee,p.city==='Karachi'?225:250,p.awb+' fee follows the rate card zone');
  }
  assert.equal(seed.tables.clients[0].name,D.shipper.name);
  ok('merchant preview: the same seven parcels, cities, COD, notes and times as nv-demo-data.js');
}

// 2. the rider preview holds N9000002-4 as the same parcels, and no other AWB collides
{
  const html=read('rider.html');
  assert.match(html,/<script defer src="nv-demo-data\.js\?v=[0-9a-f]{8}"><\/script>\s*<script defer src="rider-core\.js/,'rider.html loads the data before the app');
  const dom=new JSDOM(html,{url:'https://fixture.invalid/rider.html?demo=1',runScripts:'outside-only'}), w=dom.window;
  w.crypto.randomUUID=()=>crypto.randomUUID(); w.scrollTo=()=>{};
  Object.defineProperty(w.navigator,'locks',{configurable:true,value:{request:async(_k,fn)=>fn()}});
  const net=[]; w.fetch=u=>{net.push(String(u));return Promise.reject(new Error('no network'));};
  w.supabase={createClient(){throw new Error('the preview must not make a real client');}};
  const dialog=w.document.querySelector('dialog'); dialog.showModal=()=>{dialog.open=true;}; dialog.close=()=>{dialog.open=false;};
  for(const f of ['nv-payment.js','nv-journey.js','nv-demo-data.js','rider-core.js','rider-app.js']) w.eval(read(f));
  await wait();
  const q=id=>w.document.getElementById(id), txt=id=>q(id).textContent.replace(/\s+/g,' ');
  const go=v=>w.document.querySelector(`nav [data-view="${v}"]`).click();
  go('parcels'); await wait();
  const all=w.document.body.textContent.replace(/\s+/g,' ');
  assert.match(txt('outList'),/N9000002/); assert.match(txt('outList'),/Bilal Ahmed/); assert.match(txt('outList'),/1,899/);
  assert.match(all,/Sana's Closet/,'the Karachi shipper is the merchant preview shop');
  go('process'); await wait();
  assert.match(txt('manifestList'),/KAR-LAH-DEMO.*4 to receive/s,'the sack still holds four');
  const station=txt('stationList');
  assert.match(station,/N9000004/); assert.match(station,/Usman Tariq/); assert.match(station,/reattempt Saturday/);
  const awbs=[...new Set((w.document.body.innerHTML.match(/N9\d{6}/g)||[]))];
  for(const a of awbs) assert.ok(/^N91\d{5}$/.test(a)||['N9000002','N9000003','N9000004'].includes(a),a+' is either shared or in the rider-only N91 block');
  assert.equal(net.length,0,'nothing is fetched');
  ok('rider preview: N9000002 out with the Demo Rider, N9000004 refused at the station, every other AWB in N91xxxxx');
}

// 3. the customer tracker opens every sample parcel without NovaX
{
  const html=read('tracking.html').replace('<script src="/assets/vendor/supabase-2.117.2.js"></script>','');
  async function open(q){
    const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://novaxlogistics.com/tracking.html'+q,pretendToBeVisual:true}), w=dom.window;
    let made=0; w.supabase={createClient(){made++;return {rpc(){throw new Error('no RPC in the preview');}};}};
    const orig=w.document.createElement.bind(w.document);
    w.document.createElement=t=>{const el=orig(t); if(String(t).toLowerCase()==='script') queueMicrotask(()=>{ if(/nv-demo-data\.js\?v=/.test(el.src)){ w.eval(dataSrc); el.onload&&el.onload(); } }); return el;};
    for(const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) w.eval(m[1]);
    w.document.dispatchEvent(new w.Event('DOMContentLoaded')); await wait(80);
    const t=s=>(w.document.querySelector(s)||{textContent:''}).textContent.replace(/\s+/g,' ').trim();
    return {w,t,made:()=>made,saved:()=>w.localStorage.getItem('nvTrackSaved')};
  }
  for(const p of D.parcels){
    const a=await open('?demo=1&awb='+p.awb);
    assert.match(a.t('.tk-demo'),/Preview with sample data\. Nothing here is real, and nothing is saved\./,p.awb+' label');
    assert.equal(a.t('.tk-awb').replace('Tracking number',''),p.awb);
    assert.match(a.t('.tk-eyebrow'),new RegExp('For '+p.consignee.split(' ')[0]));
    assert.match(a.t('.route'),new RegExp('Karachi.*'+p.city));
    assert.equal(a.w.document.querySelectorAll('.tl li').length,p.journey.length,p.awb+' journey has every step');
    assert.equal(a.made(),0,'no Supabase client'); assert.equal(a.saved(),null,'nothing saved on the phone');
    assert.equal(a.w.document.querySelectorAll('[data-reply]').length,0,'no customer answers in a preview');
    a.w.close();
  }
  const two=await open('?demo=1&awb=N9000002');
  assert.match(two.t('.status-head'),/out for delivery/i); assert.match(two.t('.cod'),/1,899/); assert.match(two.t('.awbline'),/Demo Rider/);
  assert.equal(two.w.document.querySelector('.tk-demo nav a[aria-current]').textContent,'N9000002');
  const four=await open('?demo=1&awb=N9000004');
  assert.match(four.t('.tk-note'),/reattempt Saturday/); assert.equal(four.t('.cod'),'','no cash line on a refused parcel');
  const bad=await open('?demo=1&awb=N1234567');
  assert.match(bad.t('#out'),/Not a sample parcel/); assert.match(bad.t('.tk-demo'),/Preview with sample data/);
  const none=await open('?demo=1');
  assert.match(none.t('.tk-awb'),/N9000002/,'a bare ?demo=1 opens the out-for-delivery parcel');
  ok('tracker preview: all seven sample parcels open with the label, journey and no connection; unknown AWBs say so');
}
console.log('DEMO DATASET CHECKS PASSED');
process.exit(0);
