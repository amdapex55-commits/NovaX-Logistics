// City rider app (Pickup / Delivery / Transit) against an in-memory fixture.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {installFixture} from './rider-fixture.mjs';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=createRequire('/tmp/novax-rider-test-deps/package.json')('jsdom'));}
const html=readFileSync(new URL('../rider.html',import.meta.url),'utf8');
const scripts=['nv-payment.js','nv-journey.js','rider-core.js','rider-app.js'].map(f=>readFileSync(new URL('../'+f,import.meta.url),'utf8'));
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));
const QKEY='novaxRiderQueue:v2:fixture-user:fixture-rider';
async function app(options={}){
  const dom=new JSDOM(html,{url:'https://fixture.invalid/rider.html?nosw=1',runScripts:'outside-only'}),w=dom.window;
  w.crypto.randomUUID=()=>crypto.randomUUID();const fixture=installFixture(w,options);
  const dialog=w.document.querySelector('dialog');dialog.showModal=()=>{dialog.open=true;};
  dialog.close=value=>{dialog.returnValue=value;dialog.open=false;dialog.onclose&&dialog.onclose();};
  scripts.forEach(s=>w.eval(s));await wait();
  const q=id=>w.document.getElementById(id);
  const go=(v)=>{w.document.querySelector(`nav [data-view="${v}"]`).click();};
  const tab=(t)=>{w.document.querySelector(`[data-tab="${t}"]`).click();};
  const pick=(awb)=>{const cb=w.document.querySelector(`[data-pick="${awb}"]`);cb.checked=true;cb.dispatchEvent(new w.Event('change',{bubbles:true}));};
  return{dom,w,fixture,q,dialog,go,tab,pick};
}
const memory=()=>{const m=new Map();return{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)}};
// core helpers
const core={Intl,Date,Set,Number,isFinite};vm.createContext(core);vm.runInContext(scripts[0]+scripts[1]+scripts[2],core);const R=core.NovaXRider;
assert.equal(R.day('2026-09-27 00:30'),'2026-09-27');
assert.equal(R.phone('0092 300-1234567'),'+923001234567');
const storage=memory(),qa=new R.Queue(storage,'a','r1'),qb=new R.Queue(storage,'b','r2');qa.add({key:'job'});assert.equal(qb.read().length,0);
assert.throws(()=>new R.Queue({getItem:()=>'{bad'},'a','r').read(),/unreadable/);
// Directions: the area, not the house and street numbers that sent riders to the wrong sector (14 Oct 2026)
for (const [addr,city,want] of [
  ['H No 123 St No 45 F11,3 Islamabad\nIslamabad\nIslamabad Capital Territory','Islamabad','F-11/3, Islamabad, Pakistan'],
  ['Flat 4, Second Floor, Street 21, Sector F-10/2','Islamabad','F-10/2, Islamabad, Pakistan'],
  ['G-10-2 Back 13 flat-12','Islamabad','G-10/2 Back 13, Islamabad, Pakistan'],
  ['House No. 12A, ali street, lajna chowk, college road lahore\nLahore\nPakistan','Lahore','ali street, lajna chowk, college road, Lahore, Pakistan'],
  ['House no. 1234 St D3 sector A, DHA Phase 6 town Lahore\nLahore 54000\nPakistan','Lahore','sector A, DHA Phase 6, Lahore, Pakistan'],
  ['askari 11 sector B building 12 apartment 4D, Lahore, Pakistan','Lahore','askari 11 sector B, Lahore, Pakistan'],
  ['House number 245 street 12 G block DHA phase 5, Lahore, Pakistan','Lahore','G block DHA phase 5, Lahore, Pakistan'],
  ['House 5, Street 2, Multan Road, Lahore','Lahore','Multan Road, Lahore, Pakistan'],
  ['Mohalla Islampura, Lahore Road, Sheikhupura','Lahore','Mohalla Islampura, Lahore Road, Sheikhupura, Lahore, Pakistan'],
  ['Shop 6, Liberty Market, Gulberg 0300-1234567','Lahore','Liberty Market, Gulberg, Lahore, Pakistan'],
  ['House 12, Street 9','Lahore','House 12, Street 9, Lahore, Pakistan'],
  ['Art Village, Hamza Avenue, Lahore Cantt, House No E','Lahore','Art Village, Hamza Avenue, Lahore Cantt, Lahore, Pakistan'],
  ['Railway colony, new campus, house no ram 5','Lahore','Railway colony, new campus, Lahore, Pakistan'],
  ['','Lahore','Lahore, Pakistan'],
]) assert.equal(R.mapsQuery(addr,city),want,addr);
assert.equal(R.directionsUrl('Sector F-10/2','Islamabad'),'https://www.google.com/maps/search/?api=1&query=F-10%2F2%2C%20Islamabad%2C%20Pakistan');

// 3 Nov 2026: two tabs. Process opens first; My parcels holds out-now, station, delivered and cash
let a=await app();
assert.equal(a.q('gate').classList.contains('hidden'),true);
assert.deepEqual([...a.w.document.querySelectorAll('nav .navbtn:not([hidden])')].map(b=>b.dataset.view),['process','parcels']);
assert.equal(a.q('view-process').classList.contains('hidden'),false);
assert.match(a.q('routeName').textContent,/Lahore/);
assert.match(a.q('riderIdLine').textContent,/Lahore Rider · Rider ID FIXTURE-?R?/i);
assert.match(a.q('riderIdLine').textContent,/saved under this ID/);
const procType=(text)=>{const el=a.q('procInput');el.value=text;el.dispatchEvent(new a.w.Event('input',{bubbles:true}));};
const procBtn=(re)=>[...a.q('procPlan').querySelectorAll('button')].find(b=>re.test(b.textContent));

// collect: one button per shipper -> one station action
assert.match(a.q('collectList').textContent,/Shipper Store/);
assert.equal(a.q('hCollect').textContent,'1');
assert.doesNotMatch(a.q('collectList').textContent,/N1000002|N1000006/,'parcels from another city are not a pickup');
assert.match(a.q('pickupHelp').textContent,/shippers in Lahore/);
a.q('collectList').querySelector('[data-collect-awbs]').click();await wait(120);
let req=a.fixture.requests.filter(r=>r.name==='rider_station_action');
assert.equal(req.length,1);assert.equal(req[0].args.p_action,'collect');assert.equal(JSON.stringify(req[0].args.p_awbs),'["N1000000"]');
assert.equal(a.q('notice').classList.contains('show'),false);assert.match(a.w.document.getElementById('riderToast').textContent,/1 parcel collected/);
a.dom.window.close();

// Process: numbers in any shape; each shows what can happen here; one tap acts
a=await app();
procType('n1000002 10000031000010 , 9999999');await wait();
assert.equal(a.q('procInput').value,'N1000002, N1000003, N1000010, N9999999, ','commas and N go in by themselves; runs split every 7 digits');
assert.match(a.q('procList').textContent,/N1000002.*Arriving/);assert.match(a.q('procList').textContent,/N9999999.*Not at your station/);
assert.ok(procBtn(/Take out for delivery: 2/),'station parcels (incl. a refusal) can go out');assert.ok(procBtn(/^Receive: 1/));assert.ok(procBtn(/Receive and take out: 1/));
// take out: GPS once, one action for both
procBtn(/Take out for delivery: 2/).click();await wait(160);
req=a.fixture.requests.filter(r=>r.name==='rider_station_action');assert.equal(req.at(-1).args.p_action,'out');assert.equal(JSON.stringify(req.at(-1).args.p_awbs),'["N1000003","N1000010"]');
assert.equal(a.q('procInput').value,'N1000002, N9999999, ','done numbers leave the list');
// receive typed numbers: the rider has them in hand, so no tick list
procBtn(/^Receive: 1/).click();await wait(140);
req=a.fixture.requests.filter(r=>r.name==='rider_station_action');assert.equal(req.at(-1).args.p_action,'receive');assert.equal(JSON.stringify(req.at(-1).args.p_awbs),'["N1000002"]');
// pieces that are not a whole number stay in the box and are named, while typing and after leaving the box
procType('1000003 12345 90000');await wait();
assert.match(a.q('procCount').textContent,/Not a full number: 12345/);assert.match(a.q('procInput').value,/12345/,'kept so the rider can fix it');
a.q('procInput').dispatchEvent(new a.w.Event('blur'));await wait();
assert.match(a.q('procCount').textContent,/Not a full number: 12345, 90000/);
// a parcel out with this rider points to My parcels
procType('1000004');await wait();assert.ok(procBtn(/out with you/));
procBtn(/out with you/).click();await wait();assert.equal(a.q('view-parcels').classList.contains('hidden'),false);
a.dom.window.close();

// My parcels: station cards (no ticks), Directions + WhatsApp text, out card outcomes, refusal with reason
a=await app();a.go('parcels');
assert.equal(a.q('stationList').querySelectorAll('[data-pick]').length,0,'no tick boxes: taking out happens in Process');
{ const dir=[...a.q('stationList').querySelectorAll('a.call')].find(x=>/Directions/.test(x.textContent));
  assert.equal(dir.getAttribute('href'),'https://www.google.com/maps/search/?api=1&query=Destination%20address%2C%20Lahore%2C%20Pakistan','the card opens Maps on the cleaned address'); }
const waText=(root,awb)=>{ const card=root.querySelector(`[data-awb="${awb}"]`); const w=[...card.querySelectorAll('a.call')].find(x=>/WhatsApp/.test(x.textContent));
  const u=new URL(w.getAttribute('href')); assert.equal(u.origin+u.pathname,'https://wa.me/923001234567'); return u.searchParams.get('text'); };
assert.equal(waText(a.q('stationList'),'N1000003'),['Assalam o Alaikum! I am Lahore Rider from NovaX Logistics. I am bringing your parcel.',
  'Please send me your location here on WhatsApp so I can reach you.','','Parcel: N1000003','From: Shipper Store','Cash to pay: Rs 1,200',
  'Track it: https://novaxlogistics.com/tracking.html?awb=N1000003'].join('\n'));
assert.ok(a.q('outList').querySelector('[data-act="delivered"][data-awb="N1000004"]'));
a.q('outList').querySelector('[data-act="refused"][data-awb="N1000004"]').click();await wait();
a.q('reasonOther').value='Customer refused';a.dialog.close('confirm');await wait(120);
req=a.fixture.requests.filter(r=>r.name==='rider_station_action');assert.equal(req.at(-1).args.p_action,'refused');assert.equal(req.at(-1).args.p_reason,'Customer refused');
a.dom.window.close();

// send on: grouped by destination in Process, needs a bilty reference
a=await app();
assert.match(a.q('transitGroups').textContent,/To Karachi/);assert.match(a.q('transitGroups').textContent,/Returns to Karachi/);
a.w.document.querySelector('#transitGroups [data-sendall="Karachi"]').click();await wait();
a.q('extraInput').value='DAEWOO-5566';a.dialog.close('confirm');await wait(150);
req=a.fixture.requests.filter(r=>r.name==='rider_station_action');
assert.equal(req.at(-1).args.p_action,'transit');assert.equal(req.at(-1).args.p_extra.reference,'DAEWOO-5566');assert.equal(req.at(-1).args.p_extra.to_city,'Karachi');
a.dom.window.close();
// send on from typed numbers
a=await app();
{ const el=a.q('procInput');el.value='1000001';el.dispatchEvent(new a.w.Event('input',{bubbles:true}));await wait();
  const btn=[...a.q('procPlan').querySelectorAll('button')].find(b=>/Send 1 to Karachi/.test(b.textContent));assert.ok(btn);btn.click();await wait();
  a.q('extraInput').value='TCS-1';a.dialog.close('confirm');await wait(150);
  assert.equal(a.fixture.requests.filter(r=>r.name==='rider_station_action').at(-1).args.p_action,'transit'); }
a.dom.window.close();

// lost reply: saved, replayed later on the same key
a=await app();a.fixture.failRpc='afterCommit';a.q('collectList').querySelector('[data-collect-awbs]').click();await wait(120);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY)).length,1);
const first=a.fixture.requests.find(r=>r.name==='rider_station_action');
a.fixture.failRpc=null;a.w.dispatchEvent(new a.w.Event('online'));await wait(150);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY)).length,0);
assert.equal(a.fixture.requests.filter(r=>r.name==='rider_station_action').at(-1).args.p_key,first.args.p_key);
a.dom.window.close();

// offline: saved, not sent, card shows saved, cash disabled
a=await app();a.fixture.online=false;a.w.dispatchEvent(new a.w.Event('offline'));a.q('collectList').querySelector('[data-collect-awbs]').click();await wait(120);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY)).length,1);assert.equal(a.fixture.requests.filter(r=>r.name==='rider_station_action').length,0);
assert.match(a.q('collectList').textContent,/Saved on phone/);assert.equal(a.q('depositCashBtn').disabled,true);
assert.equal(a.q('notice').textContent,'Saved on this phone. Awaiting server confirmation.');assert.equal(a.q('notice').classList.contains('show'),true);
const cached={};for(let i=0;i<a.w.localStorage.length;i++){const k=a.w.localStorage.key(i);cached[k]=a.w.localStorage.getItem(k);}a.dom.window.close();
const dom=new JSDOM(html,{url:'https://fixture.invalid/rider.html?nosw=1',runScripts:'outside-only'});installFixture(dom.window,{online:false});Object.entries(cached).forEach(([k,v])=>dom.window.localStorage.setItem(k,v));scripts.forEach(s=>dom.window.eval(s));await wait(80);
assert.equal(dom.window.document.getElementById('gate').classList.contains('hidden'),true);assert.match(dom.window.document.getElementById('notice').textContent,/last saved station/);dom.window.close();

// rejection: shown in plain words with Try again / Remove; the station is fetched again
a=await app();a.fixture.failRpc='reject';const viewsBefore=a.fixture.requests.filter(r=>r.name==='rider_station_view').length;a.q('collectList').querySelector('[data-collect-awbs]').click();await wait(160);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY))[0].state,'review');assert.match(a.q('queueReview').textContent,/Not accepted by NovaX/);assert.match(a.q('queueReview').textContent,/Not assigned/);
assert.ok(a.fixture.requests.filter(r=>r.name==='rider_station_view').length>viewsBefore,'the station is fetched again after a refusal');a.dom.window.close();

// COD/prepaid conflict disables Delivered
a=await app({conflict:true});a.go('parcels');
assert.equal(a.q('outList').querySelector('[data-act="delivered"]').disabled,true);assert.match(a.q('outList').textContent,/marked Prepaid/);a.dom.window.close();

// load failure -> retry; large station; session revoked
a=await app({failLoad:true});assert.equal(a.q('retryBtn').classList.contains('hidden'),false);a.fixture.failLoad=false;a.q('retryBtn').click();await wait(80);assert.equal(a.q('gate').classList.contains('hidden'),true);a.dom.window.close();
a=await app({large:true});assert.equal(a.q('manifestList').querySelectorAll('li').length,1007,'a sack-less arrival list still holds every parcel');a.dom.window.close();
a=await app();a.fixture.authChange('SIGNED_OUT',null);assert.equal(a.q('gate').classList.contains('hidden'),false);a.dom.window.close();

// a shipper whose address is in another city: warned, last in the list, no Collect button
assert.equal(R.wrongCity('Korangi Crossing, Allah Wala Town',['Lahore']),'Karachi');
assert.equal(R.wrongCity('Sector XX DHA phase 3 Lahore',['Lahore']),'');
assert.equal(R.wrongCity('Clifton Colony, Lahore',['lahore']),'');
assert.equal(R.wrongCity('House F-10, Model Town',['Lahore']),'');
assert.equal(R.wrongCity('Gulistan-e-Johar block 7',['Lahore']),'Karachi');
assert.equal(R.wrongCity('Shop 4, Johar Town',['Karachi']),'Lahore');
assert.equal(R.wrongCity('Satellite Town',['Islamabad','Rawalpindi']),'');
assert.equal(R.wrongCity('Main market, shop 12',['Lahore']),'');
assert.equal(R.wrongCity('Korangi',[]),'');
a=await app({shipperAddress:'Korangi Crossing, Allah Wala Town'});
assert.match(a.q('collectList').querySelector('.wrong-city').textContent,/looks like Karachi, not Lahore\. Do not go\. Tell the office\./);
assert.equal(a.q('collectList').querySelectorAll('[data-collect-awbs]').length,0);a.dom.window.close();

// manifests: one card per sack with its own count and sent day (two sacks are never added together)
a=await app();a.fixture.batches=[
  {code:'KAR-LAH-1012-HO',kind:'forward',from_city:'Karachi',to_city:'Lahore',reference:'Head office dispatch',awbs:['N1000002','N9999990'],received:[],status:'Sent',sent_at:'2026-10-12T10:00:00Z'},
  {code:'KAR-LAH-1013-HO',kind:'forward',from_city:'Karachi',to_city:'Lahore',reference:'Head office dispatch',awbs:['N1000006'],received:[],status:'Sent',sent_at:'2026-10-13T10:00:00Z'}];
a.q('refreshBtn').click();await wait(80);
{ const cards=[...a.q('manifestList').querySelectorAll('.manifest')];
  assert.equal(cards.length,2,'two sacks, two cards');
  assert.match(cards[0].textContent,/KAR-LAH-1012-HO.*Sent 12 Oct.*1 to receive/);assert.match(cards[1].textContent,/KAR-LAH-1013-HO.*Sent 13 Oct.*1 to receive/);
  assert.match(cards[0].querySelector('summary').textContent,/^Show the tracking number$/);
  // Receive a whole sack: the check dialog first; cancel sends nothing; confirm sends only that sack
  cards[0].querySelector('[data-recv-awbs]').click();await wait(60);assert.equal(a.q('dialogTitle').textContent,'Check the parcel');
  a.dialog.close('cancel');await wait(80);assert.equal(a.fixture.requests.filter(r=>r.name==='rider_station_action').length,0);
  a.q('manifestList').querySelector('[data-recv-awbs]').click();await wait(60);a.dialog.close('confirm');await wait(140);
  const r=a.fixture.requests.filter(x=>x.name==='rider_station_action');assert.equal(r.length,1);assert.equal(JSON.stringify(r[0].args.p_awbs),'["N1000002"]');
  assert.equal(a.q('reasonPresets').innerHTML,'','the dialog is left clean for the next question');assert.equal(a.q('dialogConfirm').textContent,'Confirm'); }
a.dom.window.close();

// 4 Nov 2026: each arriving tracking number opens to address, phone, cash and shop;
// parcels still at the Lahore hub say so, and the card is named after the hub
a=await app();a.fixture.batches=[{code:'KAR-LAH-1012-HO',kind:'forward',from_city:'Karachi',to_city:'Lahore',reference:'Head office dispatch',awbs:['N1000002'],received:[],status:'Sent',sent_at:'2026-10-12T10:00:00Z'}];
a.q('refreshBtn').click();await wait(80);
{ const row=a.q('manifestList').querySelector('details.man-awb[data-awb="N1000002"]');assert.ok(row,'the sack row opens');
  assert.match(row.querySelector('summary').textContent,/N1000002.*Recipient 2 · Lahore/);
  assert.match(row.querySelector('.man-more').textContent,/Destination address, building 12, Lahore/);
  assert.equal(row.querySelector('a.man-call').getAttribute('href'),'tel:+923001234567');
  assert.match(row.textContent,/Collect Rs 1,200 · Shop: Shipper Store/);
  assert.equal(row.querySelector('.man-where'),null,'inside its own sack the sack is not repeated'); }
a.dom.window.close();
a=await app();a.fixture.rows[2].meta={atHub:'Lahore',hub:'Lahore',transitBatch:'KAR-LAH-1102-HO'};a.q('refreshBtn').click();await wait(80);
{ const card=[...a.q('manifestList').querySelectorAll('.manifest')].find(c=>/via Lahore hub/.test(c.textContent));assert.ok(card,'hub parcels get a card named after the hub');
  assert.match(card.querySelector('.man-line').textContent,/1 at Lahore hub/);
  assert.match(card.querySelector('.man-where').textContent,/At Lahore hub with the hub rider, not sent on yet/);
  assert.ok(card.querySelector('[data-recv-awbs]'),'still one tap to receive them when they arrive'); }
a.dom.window.close();

// the message for a return, a prepaid exchange, and in Roman Urdu
a=await app({swap:true});a.go('parcels');
{ const txt=awb=>{ const card=a.q('outList').querySelector(`[data-awb="${awb}"]`); const w=[...card.querySelectorAll('a.call')].find(x=>/WhatsApp/.test(x.textContent)); return new URL(w.getAttribute('href')).searchParams.get('text'); };
  const sw=txt('N1000004');assert.match(sw,/Already paid, nothing to pay\.\nPlease keep the item you are exchanging ready\.\nTrack it: /);assert.doesNotMatch(sw,/Cash to pay/);
  const back=txt('N1000008');assert.match(back,/^Assalam o Alaikum! I am Lahore Rider from NovaX Logistics\. I am bringing back your returned parcel\.\nPlease send me your location here on WhatsApp\.\n\nParcel: N1000008\nCustomer: Recipient 8, Karachi\nNothing to pay\./);
  a.q('langBtn').click();await wait();
  assert.match(txt('N1000004'),/^Assalam o Alaikum! Main Lahore Rider, NovaX Logistics se\. Aap ka parcel le kar aa raha hoon\.\nMeherbani kar ke yahan WhatsApp par apni location bhej dein/);
  a.q('langBtn').click(); }
a.dom.window.close();

// Roman Urdu switch
a=await app();a.q('langBtn').click();await wait();assert.match(a.w.document.querySelector('nav [data-view="parcels"] span').textContent,/Mere parcel/);assert.match(a.q('procTitle')?'':a.w.document.querySelector('#view-process h2').textContent,/Parcel process/);a.q('langBtn').click();a.dom.window.close();

// cash handover needs a transaction id unless handed to the office
a=await app();a.go('parcels');a.q('cashFold').open=true;a.q('depositMethod').value='Easypaisa';a.q('depositRef').value='';a.q('depositCashBtn').click();await wait(80);
assert.match(a.q('cashResult').textContent,/transaction ID/);
a.q('depositRef').value='EP-99887766';a.q('depositCashBtn').click();await wait();a.dialog.close('confirm');await wait(150);
const dep=a.fixture.requests.find(r=>r.name==='rider_deposit_cash_v2');assert.ok(dep);assert.equal(dep.args.p_method,'Easypaisa');assert.equal(dep.args.p_reference,'EP-99887766');a.dom.window.close();

console.log('PASS rider UI: two tabs + rider ID, Process number entry (any shape) with take out / receive / send on, collect per shipper, per-sack manifests with check, out + refused with reason, transit batch with bilty, lost-reply replay on one key, offline save + reload, rejection review, COD conflict, load retry, 1000+ parcels, session revocation, Roman Urdu, cash handover with method + transaction id.');
