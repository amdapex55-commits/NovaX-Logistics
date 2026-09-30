// Regression tests for audits/rider-20260930 (screen side). One block per finding.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {installFixture} from './rider-fixture.mjs';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=createRequire('/tmp/novax-rider-test-deps/package.json')('jsdom'));}
const html=readFileSync(new URL('../rider.html',import.meta.url),'utf8');
const scripts=['nv-payment.js','nv-journey.js','rider-core.js','rider-app.js'].map(f=>readFileSync(new URL('../'+f,import.meta.url),'utf8'));
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));
const QKEY='novaxRiderQueue:v2:fixture-user:fixture-rider';
async function app(opts={},tweak){
  const dom=new JSDOM(html,{url:'https://fixture.invalid/rider.html?nosw=1',runScripts:'outside-only'}),w=dom.window;
  w.crypto.randomUUID=()=>crypto.randomUUID();const fixture=installFixture(w,opts);if(tweak)tweak(fixture);
  const dialog=w.document.querySelector('dialog');dialog.showModal=()=>{dialog.open=true;};
  dialog.close=v=>{dialog.returnValue=v;dialog.open=false;dialog.onclose&&dialog.onclose();};
  scripts.forEach(s=>w.eval(s));await wait();
  const q=id=>w.document.getElementById(id);
  return{dom,w,fixture,q,dialog,go:v=>w.document.querySelector(`nav [data-view="${v}"]`).click(),tab:t=>w.document.querySelector(`[data-tab="${t}"]`).click(),
    pick:a=>{const cb=w.document.querySelector(`[data-pick="${a}"]`);cb.checked=true;cb.dispatchEvent(new w.Event('change',{bubbles:true}));}};
}
const passed=[];const ok=m=>passed.push(m);

// RIDER-001 cash lists are the server's rows, not the 36-hour station slice
let a=await app({},f=>{f.cash={...f.cash,hand_rows:[{awb:'N9000001',consignee:'A',city:'Lahore',cod:1200},{awb:'N9000002',consignee:'B',city:'Lahore',cod:3600}],
  pending_rows:[{batch:'d1',net:5000,method:'Easypaisa',reference:'EP1',parcels:2,awbs:['N9000003','N9000004']}],confirmed_rows:[]};});
a.go('cash');assert.match(a.q('cashList').textContent,/N9000001/);assert.match(a.q('cashList').textContent,/N9000002/);assert.match(a.q('cashPendingList').textContent,/Easypaisa/);assert.match(a.q('cashPendingList').textContent,/N9000003/);
a.dom.window.close();ok('001');

// RIDER-004 a parcel with 3 attempts cannot be selected to go out, and says why
a=await app({},f=>{f.rows[3].attempts=3;});a.go('delivery');
const cb=a.w.document.querySelector('[data-pick="N1000003"]');assert.equal(cb.disabled,true);assert.match(a.q('stationList').textContent,/3 attempts done/);
a.dom.window.close();ok('004');

// RIDER-009 + RIDER-010 select all respects the search filter and stops at 200
a=await app({large:true});a.go('pickup');a.tab('pickup:receive');
a.q('riderSearch').value='B1004';a.q('riderSearch').dispatchEvent(new a.w.Event('input'));
a.w.document.querySelector('#receiveList [data-selall]').click();await wait();
assert.match(a.q('actionGo').textContent,/Mark 1 received/);ok('010');
a.q('riderSearch').value='';a.q('riderSearch').dispatchEvent(new a.w.Event('input'));
a.q('actionClear').click();a.w.document.querySelector('#receiveList [data-selall]').click();await wait();
assert.match(a.q('actionGo').textContent,/Mark 200 received/);ok('009 cap');
a.q('actionGo').click();await wait(200);
const recv=a.fixture.requests.filter(r=>r.name==='rider_station_action');assert.ok(recv.every(r=>r.args.p_awbs.length<=200));ok('009 server calls within 200');
a.dom.window.close();

// RIDER-017 + RIDER-018 a rejected pickup can be removed (logged) and never blocks cash
a=await app();a.fixture.failRpc='reject';a.go('pickup');a.pick('N1000000');a.q('actionGo').click();await wait(120);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY))[0].state,'review');
a.fixture.failRpc=null;a.go('cash');a.q('depositMethod').value='Cash to office';await wait();
assert.equal(a.q('depositCashBtn').disabled,false);ok('018');
a.w.document.querySelector('[data-discard]').click();await wait();a.dialog.close('confirm');await wait(120);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY)).length,0);assert.equal((a.fixture.discards||[]).length,1);ok('017');
a.dom.window.close();

// RIDER-019 two different offline expenses are both saved
a=await app();a.fixture.online=false;a.w.dispatchEvent(new a.w.Event('offline'));a.go('cash');
a.q('expenseAmount').value='100';a.q('expenseNote').value='fuel';a.q('expenseForm').dispatchEvent(new a.w.Event('submit',{cancelable:true}));await wait(80);
a.q('expenseAmount').value='200';a.q('expenseCategory').value='Toll';a.q('expenseNote').value='toll';a.q('expenseForm').dispatchEvent(new a.w.Event('submit',{cancelable:true}));await wait(80);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY)).filter(j=>j.kind==='expense').length,2);ok('019');
a.dom.window.close();

// RIDER-022 the reattempt date is a date picker bounded to 14 days
a=await app();a.go('delivery');a.tab('delivery:out');
a.q('outList').querySelector('[data-act="reattempt"][data-awb="N1000004"]').click();await wait();
assert.equal(a.q('extraInput').type,'date');assert.ok(a.q('extraInput').min && a.q('extraInput').max);
a.q('reasonOther').value='Phone off';a.dialog.close('confirm');await wait(150);
const rea=a.fixture.requests.filter(r=>r.name==='rider_station_action').at(-1);assert.equal(rea.args.p_action,'reattempt');assert.match(rea.args.p_extra.next_date,/^\d{4}-\d{2}-\d{2}$/);
a.dom.window.close();ok('022');

// RIDER-025 a return card collects nothing; RIDER-026 Directions without a phone
a=await app({},f=>{f.rows[3].phone='';});a.go('delivery');a.tab('delivery:out');
assert.match(a.q('outList').textContent,/Return to shipper · collect nothing/);ok('025');
a.tab('delivery:station');
const noPhone=a.w.document.querySelector('#stationList [data-awb="N1000003"]');assert.match(noPhone.textContent,/Directions/);assert.doesNotMatch(noPhone.textContent,/WhatsApp/);
a.dom.window.close();ok('026');

// RIDER-027 a selected parcel that disappears on refresh is dropped from the selection
a=await app();a.go('delivery');a.pick('N1000003');assert.match(a.q('actionGo').textContent,/Take 1 out/);
a.fixture.rows[3].status='Delivered';a.q('refreshBtn').click();await wait(150);
assert.equal(a.q('actionBar').classList.contains('hidden'),true);a.dom.window.close();ok('027');

// RIDER-028 a server answer that moved nothing is not treated as success
a=await app();a.fixture.zeroMove=true;a.go('pickup');a.pick('N1000000');a.q('actionGo').click();await wait(150);
assert.equal(JSON.parse(a.w.localStorage.getItem(QKEY))[0].state,'review');assert.match(a.q('queueReview').textContent,/confirmed 0 of 1/);
a.dom.window.close();ok('028');

// RIDER-030 switching tabs clears the search
a=await app();a.go('pickup');a.q('riderSearch').value='N1000000';a.q('riderSearch').dispatchEvent(new a.w.Event('input'));
a.tab('pickup:receive');assert.equal(a.q('riderSearch').value,'');a.dom.window.close();ok('030');

console.log('PASS rider audit regressions: '+passed.join(', '));
