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

// home: three buttons with counts, city in the header
let a=await app();
assert.equal(a.q('gate').classList.contains('hidden'),true);
assert.equal(a.w.document.querySelectorAll('.home-btn').length,3);
assert.equal(a.q('homePickup').textContent,'1 to collect');                 // this city's shippers and nothing else
assert.match(a.q('homeDelivery').textContent,/^\d+ arriving · \d+ at station · \d+ out now$/);
assert.match(a.q('homeTransit').textContent,/2 to send/);
assert.match(a.q('routeName').textContent,/Lahore/);

// pickup: grouped by shipper, select, collect -> one station action
a.go('pickup');
assert.match(a.q('collectList').textContent,/Shipper Store/);
a.pick('N1000000');assert.equal(a.q('actionBar').classList.contains('hidden'),false);assert.match(a.q('actionGo').textContent,/Mark 1 collected/);
a.q('actionGo').click();await wait(120);
let req=a.fixture.requests.filter(r=>r.name==='rider_station_action');
assert.equal(req.length,1);assert.equal(req[0].args.p_action,'collect');assert.equal(JSON.stringify(req[0].args.p_awbs),'["N1000000"]');
// once NovaX has answered, "awaiting server confirmation" is no longer on the screen
assert.equal(a.q('notice').classList.contains('show'),false);assert.match(a.w.document.getElementById('riderToast').textContent,/1 parcel collected/);

// Pickup is the rider's own city: no tabs, and nothing that is coming from another city
assert.equal(a.w.document.querySelectorAll('#view-pickup [data-tab]').length,0);
assert.doesNotMatch(a.q('view-pickup').textContent,/N1000002|N1000006/);
assert.match(a.q('pickupHelp').textContent,/shippers in Lahore/);

// arriving parcels sit under Delivery; last-4-digit entry selects
a.go('delivery');a.tab('delivery:receive');
assert.equal(a.q('deliveryReceive').classList.contains('hidden'),false);assert.equal(a.q('deliveryStation').classList.contains('hidden'),true);
assert.equal(a.q('nArriving').textContent,String(a.q('receiveList').querySelectorAll('.parcel').length));
assert.match(a.q('receiveList').textContent,/N1000002/);
a.q('riderSearch').value='0002';a.q('riderSearch').dispatchEvent(new a.w.KeyboardEvent('keydown',{key:'Enter'}));await wait();
assert.match(a.q('actionGo').textContent,/Mark 1 received/);
// a parcel from another screen is not selected, the rider is told where it is
a.q('riderSearch').value='N1000003';a.q('riderSearch').dispatchEvent(new a.w.KeyboardEvent('keydown',{key:'Enter'}));await wait();
assert.match(a.w.document.getElementById('riderToast').textContent,/At station/);
// "Mark received" first shows the parcels to check; nothing is sent until the rider confirms
a.q('actionGo').click();await wait(60);
assert.equal(a.dialog.open,true);assert.equal(a.q('dialogTitle').textContent,'Check the parcel');assert.match(a.q('reasonPresets').textContent,/N100\s*0002/);
assert.equal(a.fixture.requests.filter(r=>r.name==='rider_station_action'&&r.args.p_action==='receive').length,0);
a.dialog.close('confirm');await wait(120);
req=a.fixture.requests.filter(r=>r.name==='rider_station_action');assert.equal(req.at(-1).args.p_action,'receive');assert.equal(JSON.stringify(req.at(-1).args.p_awbs),'["N1000002"]');
assert.equal(a.q('reasonPresets').innerHTML,'','the dialog is left clean for the next question');assert.equal(a.q('dialogConfirm').textContent,'Confirm');

// delivery: station -> out; out card has outcomes; COD conflict blocks Delivered
a.tab('delivery:station');
{ const dir=[...a.q('stationList').querySelectorAll('a.call')].find(x=>/Directions/.test(x.textContent));
  assert.equal(dir.getAttribute('href'),'https://www.google.com/maps/search/?api=1&query=Destination%20address%2C%20Lahore%2C%20Pakistan','the card opens Maps on the cleaned address'); }
a.pick('N1000003');a.q('actionGo').click();await wait(120);
assert.equal(a.fixture.requests.filter(r=>r.name==='rider_station_action').at(-1).args.p_action,'out');
a.tab('delivery:out');
assert.ok(a.q('outList').querySelector('[data-act="delivered"][data-awb="N1000004"]'));
a.q('outList').querySelector('[data-act="refused"][data-awb="N1000004"]').click();await wait();
a.q('reasonOther').value='Customer refused';a.dialog.close('confirm');await wait(120);
req=a.fixture.requests.filter(r=>r.name==='rider_station_action');assert.equal(req.at(-1).args.p_action,'refused');assert.equal(req.at(-1).args.p_reason,'Customer refused');

// transit: grouped by destination, send needs a bilty reference
a.go('transit');
assert.match(a.q('transitGroups').textContent,/To Karachi/);assert.match(a.q('transitGroups').textContent,/Returns to Karachi/);
a.w.document.querySelector('[data-sendall="Karachi"]').click();await wait();
a.q('extraInput').value='DAEWOO-5566';a.dialog.close('confirm');await wait(150);
req=a.fixture.requests.filter(r=>r.name==='rider_station_action');
assert.equal(req.at(-1).args.p_action,'transit');assert.equal(req.at(-1).args.p_extra.reference,'DAEWOO-5566');assert.equal(req.at(-1).args.p_extra.to_city,'Karachi');
a.dom.window.close();

// lost reply: saved, replayed later on the same key
a=await app();a.fixture.failRpc='afterCommit';a.go('pickup');a.pick('N1000000');a.q('actionGo').click();await wait(120);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY)).length,1);
const first=a.fixture.requests.find(r=>r.name==='rider_station_action');
a.fixture.failRpc=null;a.w.dispatchEvent(new a.w.Event('online'));await wait(150);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY)).length,0);
assert.equal(a.fixture.requests.filter(r=>r.name==='rider_station_action').at(-1).args.p_key,first.args.p_key);
a.dom.window.close();

// offline: saved, not sent, card shows saved, cash disabled
a=await app();a.fixture.online=false;a.w.dispatchEvent(new a.w.Event('offline'));a.go('pickup');a.pick('N1000000');a.q('actionGo').click();await wait(120);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY)).length,1);assert.equal(a.fixture.requests.filter(r=>r.name==='rider_station_action').length,0);
assert.match(a.q('collectList').textContent,/Saved on phone/);assert.equal(a.q('depositCashBtn').disabled,true);
assert.equal(a.q('notice').textContent,'Saved on this phone. Awaiting server confirmation.');assert.equal(a.q('notice').classList.contains('show'),true);   // not confirmed yet: the line stays
const cached={};for(let i=0;i<a.w.localStorage.length;i++){const k=a.w.localStorage.key(i);cached[k]=a.w.localStorage.getItem(k);}a.dom.window.close();
// offline reload shows the saved station
const dom=new JSDOM(html,{url:'https://fixture.invalid/rider.html?nosw=1',runScripts:'outside-only'});installFixture(dom.window,{online:false});Object.entries(cached).forEach(([k,v])=>dom.window.localStorage.setItem(k,v));scripts.forEach(s=>dom.window.eval(s));await wait(80);
assert.equal(dom.window.document.getElementById('gate').classList.contains('hidden'),true);assert.match(dom.window.document.getElementById('notice').textContent,/last saved station/);dom.window.close();

// rejection goes to office review
a=await app();a.fixture.failRpc='reject';a.go('pickup');a.pick('N1000000');const viewsBefore=a.fixture.requests.filter(r=>r.name==='rider_station_view').length;a.q('actionGo').click();await wait(160);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY))[0].state,'review');assert.match(a.q('queueReview').textContent,/Not assigned/);
// a refusal (with two riders: "the other one has it") fetches the station again at once, so the stale parcel leaves the screen
assert.ok(a.fixture.requests.filter(r=>r.name==='rider_station_view').length>viewsBefore,'the station is fetched again after a refusal');a.dom.window.close();

// COD/prepaid conflict disables Delivered
a=await app({conflict:true});a.go('delivery');a.tab('delivery:out');
assert.equal(a.q('outList').querySelector('[data-act="delivered"]').disabled,true);assert.match(a.q('outList').textContent,/marked Prepaid/);a.dom.window.close();

// load failure -> retry; large station; session revoked
a=await app({failLoad:true});assert.equal(a.q('retryBtn').classList.contains('hidden'),false);a.fixture.failLoad=false;a.q('retryBtn').click();await wait(80);assert.equal(a.q('gate').classList.contains('hidden'),true);a.dom.window.close();
a=await app({large:true});a.go('delivery');a.tab('delivery:receive');assert.equal(a.q('receiveList').querySelectorAll('.parcel').length,1007);a.dom.window.close();
a=await app();a.fixture.authChange('SIGNED_OUT',null);assert.equal(a.q('gate').classList.contains('hidden'),false);a.dom.window.close();

// a shipper whose address is in another city: warned, last in the list, no "Select all"; an address in this city is left alone
assert.equal(R.wrongCity('Korangi Crossing, Allah Wala Town',['Lahore']),'Karachi');
assert.equal(R.wrongCity('Sector XX DHA phase 3 Lahore',['Lahore']),'');
assert.equal(R.wrongCity('Clifton Colony, Lahore',['lahore']),'');               // names the rider's own city
assert.equal(R.wrongCity('House F-10, Model Town',['Lahore']),'');               // a house number is not an Islamabad sector
assert.equal(R.wrongCity('Gulistan-e-Johar block 7',['Lahore']),'Karachi');
assert.equal(R.wrongCity('Shop 4, Johar Town',['Karachi']),'Lahore');
assert.equal(R.wrongCity('Satellite Town',['Islamabad','Rawalpindi']),'');
assert.equal(R.wrongCity('Main market, shop 12',['Lahore']),'');                 // no city named: nothing to say
assert.equal(R.wrongCity('Korangi',[]),'');
a=await app({shipperAddress:'Korangi Crossing, Allah Wala Town'});a.go('pickup');
assert.match(a.q('collectList').querySelector('.wrong-city').textContent,/looks like Karachi, not Lahore\. Do not go\. Tell the office\./);
assert.equal(a.q('collectList').querySelectorAll('[data-selall]').length,0);assert.equal(a.q('collectList').querySelectorAll('[data-pick]').length,1);a.dom.window.close();
a=await app();a.go('pickup');assert.equal(a.q('collectList').querySelector('.wrong-city'),null);assert.equal(a.q('collectList').querySelectorAll('[data-selall]').length,1);a.dom.window.close();

// a batch card lists its tracking numbers; the check before receiving lets the rider untick what did not come
a=await app();a.fixture.batches=[{code:'KAR-LAH-1012-HO',kind:'forward',from_city:'Karachi',to_city:'Lahore',reference:'Head office dispatch',awbs:['N1000002','N1000006','N9999990'],received:[],status:'Sent'}];
a.q('refreshBtn').click();await wait(80);a.go('delivery');a.tab('delivery:receive');
{ const card=a.q('batchList').querySelector('.batch'), list=card.querySelector('details.batch-awbs');
  assert.match(list.querySelector('summary').textContent,/Show the 3 tracking numbers/);
  const rows=[...list.querySelectorAll('li')].map(li=>li.textContent.replace(/\s+/g,' ').trim());
  assert.match(rows[0],/N1000002.*Recipient 2.*on the way/);assert.match(rows[2],/N9999990.*not in your list/);
  list.open=true;list.dispatchEvent(new a.w.Event('toggle'));
  card.querySelector('[data-selall]').click();await wait();
  assert.match(a.q('actionGo').textContent,/Mark 2 received/);
  assert.equal(a.q('batchList').querySelector('details.batch-awbs').open,true,'stays open after the screen redraws');
  assert.match(a.q('batchList').querySelector('li').textContent,/ticked/); }
// closing the check sends nothing and keeps the selection
a.q('actionGo').click();await wait(60);assert.equal(a.q('dialogTitle').textContent,'Check the 2 parcels');assert.match(a.q('checkCount').textContent,/^2 of 2 ticked$/);
a.dialog.close('cancel');await wait(80);
assert.equal(a.fixture.requests.filter(r=>r.name==='rider_station_action').length,0);assert.match(a.q('actionGo').textContent,/Mark 2 received/);
// untick one: only the ticked one is marked received
a.q('actionGo').click();await wait(60);
{ const cb=a.q('reasonPresets').querySelector('[data-keep="N1000006"]');cb.checked=false;cb.dispatchEvent(new a.w.Event('change',{bubbles:true}));
  assert.match(a.q('checkCount').textContent,/^1 of 2 ticked$/);assert.equal(a.q('dialogConfirm').textContent,'Mark 1 received');
  const all=[...a.q('reasonPresets').querySelectorAll('[data-keep]')];all.forEach(x=>{x.checked=false;x.dispatchEvent(new a.w.Event('change',{bubbles:true}));});
  assert.equal(a.q('dialogConfirm').disabled,true,'nothing ticked, nothing to confirm');
  a.q('reasonPresets').querySelector('[data-keep="N1000002"]').checked=true;a.q('reasonPresets').dispatchEvent(new a.w.Event('change',{bubbles:true})); }
assert.match(a.q('reasonPresets').textContent,/^1 of 2 tickedKAR-LAH-1012-HO \(2\)N1000002/,'grouped under the batch the screen showed');
a.dialog.close('confirm');await wait(120);
{ const r=a.fixture.requests.filter(x=>x.name==='rider_station_action');assert.equal(r.length,1);assert.equal(JSON.stringify(r[0].args.p_awbs),'["N1000002"]');assert.equal(a.q('dialogConfirm').disabled,false); }
a.dom.window.close();

// Roman Urdu switch
a=await app();a.q('langBtn').click();await wait();assert.match(a.w.document.querySelector('.home-btn b').textContent,/Parcel Uthana/);a.q('langBtn').click();a.dom.window.close();

// cash handover needs a transaction id unless handed to the office
a=await app();a.go('cash');a.q('depositMethod').value='Easypaisa';a.q('depositRef').value='';a.q('depositCashBtn').click();await wait(80);
assert.match(a.q('cashResult').textContent,/transaction ID/);
a.q('depositRef').value='EP-99887766';a.q('depositCashBtn').click();await wait();a.dialog.close('confirm');await wait(150);
const dep=a.fixture.requests.find(r=>r.name==='rider_deposit_cash_v2');assert.ok(dep);assert.equal(dep.args.p_method,'Easypaisa');assert.equal(dep.args.p_reference,'EP-99887766');a.dom.window.close();

console.log('PASS rider UI: home counts, pickup by shipper, collect, receive with last-4-digit entry and wrong-screen hint, out + refused with reason, transit batch with bilty, lost-reply replay on one key, offline save + reload, rejection review, COD conflict, load retry, 1000+ parcels, session revocation, Roman Urdu, cash handover with method + transaction id.');
