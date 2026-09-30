// Wallet v3 (30 Sep 2026): card, activity feed, receipt sheet, transfer-style
// withdraw, payout tracker, bank card, "just landed" and the bank-style statement.
// The payout goes through the real nvWithdrawCore with the real durable-key helper.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom');
const app=readFileSync(new URL('../client-app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../client.html',import.meta.url),'utf8');
const wait=(ms=30)=>new Promise(r=>setTimeout(r,ms));
const plain=x=>JSON.parse(JSON.stringify(x));
const passed=[];const ok=m=>passed.push(m);
function slice(src,from,to){const a=src.indexOf(from);assert.ok(a>-1,'missing '+from.slice(0,50));const b=src.indexOf(to,a);assert.ok(b>a,'missing end '+to.slice(0,50));return src.slice(a,b);}
function fn(name){const a=app.indexOf('    function '+name+'(');assert.ok(a>-1,'missing fn '+name);let i=app.indexOf('{',a),d=0;for(;i<app.length;i++){if(app[i]==='{')d++;else if(app[i]==='}'){d--;if(!d)break;}}return app.slice(a,i+1);}
const walletJs=slice(app,"    /* ═══ Wallet v3 (30 Sep 2026)","    function renderClientWallet(){");
const coreJs=slice(app,"    /* One protected path for every withdrawal","    function requestWalletWithdrawal(){");
const idemJs=slice(app,"window.__novaxIdemKeys = window.__novaxIdemKeys ||","\n\n    let __withdrawInFlight");
const heroHtml=slice(html,'<div class="nvw-card" id="nvwCard">','<span class="nv-mh-note" id="nvMhNote"></span>');
const actHtml=slice(html,'<div class="nvw-filters" id="nvwFilters"','<div id="withdrawHistory" hidden></div>');
const CID='d2485e75-dde9-446a-a0ab-c5db158df20f', IBAN='PK36MEZN0000001123456702';

function page(o={}){
  const dom=new JSDOM('<!doctype html><body><section id="client-money"><div id="hero">'+heroHtml+'</div><div id="nvwActivityHead"></div>'+actHtml+'</section></body>',
    {runScripts:'outside-only',url:'https://novaxlogistics.com/client.html',pretendToBeVisual:true});
  const w=dom.window;
  Object.defineProperty(w,'crypto',{value:webcrypto,configurable:true});
  w.__calls=[];w.__toasts=[];w.__tabs=[];w.__forms=[];w.__docs=[];w.__prompts=[];w.__receipts=[];
  const rpcs=o.rpcs||{};
  w.__nvSb={rpc:async(n,a)=>{w.__calls.push([n,a]);if(rpcs[n])return rpcs[n](a);
    if(n==='request_wallet_withdrawal_idem')return{data:{id:'11111111-2222-4333-8444-555555555555',status:'Pending admin payout',fee:Math.round(a.p_amount*({ '24h':0.001,'12h':0.003,instant:0.007 }[a.p_speed])*100)/100,
      net:a.p_amount-Math.round(a.p_amount*({ '24h':0.001,'12h':0.003,instant:0.007 }[a.p_speed])*100)/100},error:null};
    return{data:null,error:null};}};
  w.__NOVAX_DEMO=!!o.demo;
  try{ w.localStorage.setItem('nvWalletHidden',o.hidden?'1':'0'); }catch(e){}
  w.eval(idemJs+';');
  w.eval([
    'var state='+JSON.stringify(Object.assign({client:{id:CID,name:"Test Store"},walletWithdrawals:[],paymentLogs:[],invoices:[],walletLedger:[],
      clientBankDetails:o.noBank?null:{holderName:"Test Owner",iban:IBAN,bankName:"",updatedAt:""},serverWalletSummary:{available_balance:o.avail!=null?o.avail:3425}},o.state||{}))+';',
    'var __withdrawInFlight=false;',
    'var NV_KYC='+JSON.stringify(o.kyc?{data:{status:o.kyc}}:{data:null})+';',
    'const PKR=new Intl.NumberFormat("en-PK",{style:"currency",currency:"PKR",maximumFractionDigits:0});',
    'const WALLET_FEE={ "24h":0.001, "12h":0.003, "instant":0.007 };',
    ...['money','moneyExact','walletFeeRate','nvPayoutFee','walletFeePct','walletSpeedLabel','validateIbanValue','maskIban','escLabelText'].map(fn),
    'function nvNiceDate(v){return String(v||"");}',
    'function clientById(id){return {id:id,walletBalance:'+(o.balance!=null?o.balance:3425)+'};}',
    'function toast(m){window.__toasts.push(m);} function showClientTab(t){window.__tabs.push(t);} function nvOpenWalletForms(f){window.__forms.push(f);}',
    'function render(){} function saveState(){} function nvLoadWalletIntelligence(){} function renderClientWallet(){}',
    'function nextId(p,l){return p+"-"+(l.length+1);} function time(){return "12:00";}',
    'function nvWithdrawalReceipt(id){window.__receipts.push(id);} function viewInvoice(id){window.__receipts.push(id);}',
    'function nvDocHead(t,s,m){return "<h2>"+t+"</h2><p>"+s+"</p><p>"+(m||[]).join("|")+"</p>";} function nvDocFoot(n){return "<footer>"+n+"</footer>";}',
    'function nvOpenDoc(t,h,c,n){window.__docs.push({t:t,h:h,c:c,n:n});}',
    'function nvKycLoad(){ return Promise.resolve(); }',
    'window.nvDemoPrompt=function(k){window.__prompts.push(k);};',
    'window.__novaxReloadClientData=function(){window.__calls.push(["reload"]);};'
  ].join('\n'));
  w.eval(coreJs);
  w.eval(walletJs);
  const $=q=>w.document.querySelector(q);
  const sheet=()=>w.document.querySelector('.nvw-back:last-of-type .nvw-sheet');
  const key=k=>sheet().querySelector(`[data-wd-key="${k}"]`).click();
  const typed=()=>sheet().querySelector('[data-wd-num]').textContent.replace(/\u00a0/g,' ');
  return {dom,w,$,sheet,key,typed};
}
const rpcCalls=p=>p.w.__calls.filter(c=>c[0]==='request_wallet_withdrawal_idem');

/* ─── feed: one transaction per event, titles, signs ─────────────────── */
{
  const p=page({state:{
    invoices:[{id:'INV-A',parcelRefs:['N1','N2','N3'],cod:3675,charges:675}],
    walletWithdrawals:[{_uuid:'wd-1',id:'WDR-AAAA01',iban:IBAN,speed:'24h',status:'Paid',net:4795.2,fee:4.8,createdAt:'2026-09-27 23:05',paidAt:'2026-09-28 21:06',paidTxnId:'FT1'}]}});
  const rows=[
    {id:'l1',entryType:'invoice_credit',amount:3000,affectsBalance:true,referenceType:'invoice',referenceCode:'INV-A',createdAt:'2026-09-30 16:05'},
    {id:'l2',entryType:'withdrawal_requested',amount:-4800,affectsBalance:true,referenceType:'withdrawal',referenceId:'wd-1',referenceCode:'wd-1',createdAt:'2026-09-27 23:05'},
    {id:'l3',entryType:'payout_fee',amount:-4.8,affectsBalance:false,referenceType:'withdrawal',referenceId:'wd-1',referenceCode:'wd-1',createdAt:'2026-09-27 23:05'},
    {id:'l4',entryType:'payout_paid',amount:0,affectsBalance:false,referenceType:'withdrawal',referenceId:'wd-1',referenceCode:'wd-1',createdAt:'2026-09-28 21:06'},
    {id:'l5',entryType:'delivery_charge_due',amount:-250,affectsBalance:true,referenceType:'parcel',referenceCode:'N77',createdAt:'2026-09-26 10:00'}];
  const tx=plain(p.w.eval('nvwTransactions('+JSON.stringify(rows)+').map(x=>({t:x.title,a:x.amountText.replace(/\\u00a0/g," "),tag:x.tag[0],k:x.kind}))'));
  assert.equal(tx.length,3);
  assert.deepEqual(tx[0],{t:'COD from 3 parcels',a:'+ Rs 3,000',tag:'Completed',k:'in'});
  assert.deepEqual(tx[1],{t:'Payout to Meezan ••6702',a:'− Rs 4,800',tag:'Completed',k:'payout'});
  assert.equal(tx[2].t,'Delivery charge');
  ok('feed: a payout and its fee and paid rows are one transaction; clear titles and signs');
  p.w.eval('nvwRenderActivity(document.getElementById("walletLedgerList"),'+JSON.stringify(rows)+',"")');
  assert.equal(p.w.document.querySelectorAll('#walletLedgerList .nvw-row').length,3);
  p.$('[data-nvw-filter="payouts"]').click();
  ok('feed renders; filters are wired');
  p.dom.window.close();
}

/* ─── withdraw: keypad, chips, keyboard, limits ──────────────────────── */
{
  const p=page();
  p.w.eval('nvwOpenWithdraw()');await wait();
  const go=()=>p.sheet().querySelector('[data-nvw="wd-next"]');
  assert.equal(p.typed(),'0');assert.ok(go().disabled);
  ['1','2','5','0'].forEach(p.key);assert.equal(p.typed(),'1,250');assert.equal(go().disabled,false);
  p.key('.');p.key('5');p.key('0');assert.equal(p.typed(),'1,250.50');
  p.key('7');assert.equal(p.typed(),'1,250.50');ok('keypad: digits, one decimal point, two decimals at most');
  p.key('del');p.key('del');p.key('del');p.key('del');assert.equal(p.typed(),'125');
  ['0','0','0'].forEach(p.key);assert.equal(p.typed(),'125,000');assert.ok(go().disabled);
  assert.match(p.sheet().querySelector('[data-wd-err]').textContent.replace(/\u00a0/g,' '),/more than your available balance/);
  ok('over the balance: error shown, Continue off');
  p.sheet().querySelector('[data-wd-pct="50"]').click();assert.equal(p.typed(),'1,712.50');
  p.sheet().querySelector('[data-wd-pct="100"]').click();assert.equal(p.typed(),'3,425');
  p.sheet().querySelector('[data-wd-pct="25"]').click();assert.equal(p.typed(),'856.25');
  ok('chips: 25% / 50% / All of Rs 3,425 give 856.25 / 1,712.50 / 3,425');
  for(let i=0;i<6;i++)p.key('del');
  p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'9',bubbles:true}));
  p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:',',bubbles:true}));
  p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'5',bubbles:true}));
  assert.equal(p.typed(),'9.5');ok('desktop keyboard types into the amount');
  p.key('del');p.key('del');p.key('del');p.key('.');p.key('5');assert.equal(p.typed(),'0.5');assert.ok(go().disabled);
  assert.match(p.sheet().querySelector('[data-wd-err]').textContent.replace(/\u00a0/g,' '),/smallest withdrawal is Rs 1/);
  ok('below Rs 1 is refused');
  p.dom.window.close();
}

/* ─── withdraw: speed, live "you will receive", hold to confirm, success ─ */
{
  const p=page();
  p.w.eval('nvwOpenWithdraw()');await wait();
  ['1','2','5','0'].forEach(p.key);
  p.sheet().querySelector('[data-nvw="wd-next"]').click();await wait();
  const sh=p.sheet();
  assert.equal(sh.querySelector('[data-wd="speed"]').hidden,false);
  assert.equal(sh.querySelectorAll('[data-wd-speed]').length,3);
  assert.equal(sh.querySelector('[data-wd-net]').textContent.replace(/\u00a0/g,' '),'Rs 1,248.75');
  assert.match(sh.querySelector('.nvw-bank').textContent.replace(/\u00a0/g,' '),/Meezan/);assert.match(sh.querySelector('.nvw-bank-num').textContent.replace(/\u00a0/g,' '),/PK36 MEZN •••• •••• 6702/);
  sh.querySelector('[data-wd-speed="instant"]').click();await wait(520);
  assert.equal(sh.querySelector('[data-wd-net]').textContent.replace(/\u00a0/g,' '),'Rs 1,241.25');
  assert.equal(sh.querySelector('[data-wd-speed="instant"]').getAttribute('aria-checked'),'true');
  ok('speed: fee and "you will receive" update live (24h 1,248.75 -> instant 1,241.25), bank card shown');
  const hold=sh.querySelector('[data-wd-hold]');
  hold.click();await wait();assert.match(sh.querySelector('[data-wd-err2]').textContent.replace(/\u00a0/g,' '),/Keep holding/);assert.equal(rpcCalls(p).length,0);
  hold.dispatchEvent(new p.w.Event('pointerdown',{bubbles:true}));await wait(500);
  hold.dispatchEvent(new p.w.Event('pointerup',{bubbles:true}));await wait(800);
  assert.equal(rpcCalls(p).length,0);assert.match(sh.querySelector('[data-wd-hold-t]').textContent.replace(/\u00a0/g,' '),/Hold to withdraw Rs 1,250/);
  ok('a tap or a short press sends nothing');
  hold.dispatchEvent(new p.w.Event('pointerdown',{bubbles:true}));await wait(1250);
  assert.equal(rpcCalls(p).length,1);
  const a=rpcCalls(p)[0][1];assert.equal(a.p_amount,1250);assert.equal(a.p_iban,IBAN);assert.equal(a.p_speed,'instant');assert.ok(a.p_request_key&&a.p_request_key.length>10);
  ok('holding one second sends one protected request (amount, saved IBAN, speed, durable key)');
  await wait(100);
  assert.equal(sh.querySelector('[data-wd="done"]').hidden,false);
  assert.match(sh.querySelector('.nvw-done').textContent.replace(/\u00a0/g,' '),/Withdrawal requested/);
  assert.match(sh.querySelector('.nvw-done-sub').textContent.replace(/\u00a0/g,' '),/Meezan ••6702 · usually within 2-3 hours \(by /);
  const steps=[...sh.querySelectorAll('.nvw-track li')].map(l=>l.className);assert.deepEqual(steps,['is-done','is-now','is-next']);
  assert.ok(p.w.__calls.some(c=>c[0]==='reload'));assert.equal(p.w.eval('state.walletWithdrawals.length'),1);
  assert.equal(p.w.eval('state.walletWithdrawSpeed'),'instant');
  ok('success: tick, amount, expected time, tracker Requested -> Being verified -> Paid; data reloaded');
  await wait(800);
  sh.querySelector('[data-nvw="wd-receipt"]').click();await wait(300);
  const rc=p.sheet();assert.match(rc.textContent.replace(/\u00a0/g,' '),/Payout to Meezan ••6702/);assert.ok(rc.querySelector('.nvw-track'));assert.match(rc.textContent.replace(/\u00a0/g,' '),/Processing/);
  ok('View receipt opens the new payout with its tracker');
  p.dom.window.close();
}

/* ─── withdraw: refusals, double holds, no bank, demo, empty wallet ───── */
{
  let p=page({rpcs:{request_wallet_withdrawal_idem:()=>({data:null,error:{message:'Amount exceeds available balance'}})}});
  p.w.eval('nvwOpenWithdraw()');await wait();['5','0','0'].forEach(p.key);p.sheet().querySelector('[data-nvw="wd-next"]').click();await wait();
  let hold=p.sheet().querySelector('[data-wd-hold]');
  hold.dispatchEvent(new p.w.Event('pointerdown',{bubbles:true}));await wait(1250);
  assert.equal(rpcCalls(p).length,1);
  assert.match(p.sheet().querySelector('[data-wd-err2]').textContent.replace(/\u00a0/g,' '),/Withdrawal request rejected: Amount exceeds available balance/);
  assert.equal(hold.disabled,false);assert.match(p.sheet().querySelector('[data-wd-hold-t]').textContent.replace(/\u00a0/g,' '),/Hold to withdraw/);
  assert.equal(p.w.eval('state.walletWithdrawals.length'),0);
  ok('server refusal: shown in the sheet, nothing recorded, can try again');
  p.dom.window.close();

  p=page({rpcs:{request_wallet_withdrawal_idem:a=>new Promise(r=>setTimeout(()=>r({data:{id:'22222222-2222-4333-8444-555555555555',status:'Pending admin payout',fee:0.5,net:499.5},error:null}),700))}});
  p.w.eval('nvwOpenWithdraw()');await wait();['5','0','0'].forEach(p.key);p.sheet().querySelector('[data-nvw="wd-next"]').click();await wait();
  hold=p.sheet().querySelector('[data-wd-hold]');
  hold.dispatchEvent(new p.w.Event('pointerdown',{bubbles:true}));await wait(1200);
  assert.ok(hold.disabled);assert.match(p.sheet().querySelector('[data-wd-hold-t]').textContent.replace(/\u00a0/g,' '),/Sending/);
  hold.dispatchEvent(new p.w.Event('pointerdown',{bubbles:true}));p.sheet().querySelector('[data-nvw="wd-back"]').click();
  p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.ok(p.w.document.querySelector('.nvw-back'));
  await wait(1400);
  assert.equal(rpcCalls(p).length,1);assert.equal(p.sheet().querySelector('[data-wd="done"]').hidden,false);
  ok('while sending: the button is locked, back and Escape are ignored, a second hold sends nothing');
  p.dom.window.close();

  p=page({noBank:true});p.w.eval('nvwOpenWithdraw()');await wait();['5','0','0'].forEach(p.key);p.sheet().querySelector('[data-nvw="wd-next"]').click();await wait();
  assert.ok(!p.sheet().querySelector('[data-wd-hold]'));p.sheet().querySelector('[data-nvw="wd-bank"]').click();await wait(300);
  assert.deepEqual(plain(p.w.__forms),['bankHolderName']);ok('no bank account: asked to add one first, opens the bank form');
  p.dom.window.close();

  p=page({demo:true});p.w.eval('nvwOpenWithdraw()');await wait();['5','0','0'].forEach(p.key);p.sheet().querySelector('[data-nvw="wd-next"]').click();await wait();
  hold=p.sheet().querySelector('[data-wd-hold]');hold.dispatchEvent(new p.w.Event('pointerdown',{bubbles:true}));await wait(1250);
  assert.equal(rpcCalls(p).length,0);assert.deepEqual(plain(p.w.__prompts),['save']);ok('demo: holding shows the sign-up prompt, never the server');
  p.dom.window.close();

  p=page({avail:0});p.w.eval('nvwOpenWithdraw()');await wait();p.key('5');
  assert.equal(p.typed(),'0');assert.match(p.sheet().querySelector('[data-wd-err]').textContent.replace(/\u00a0/g,' '),/Nothing to withdraw yet/);
  ok('empty wallet: keypad does nothing and says why');
  p.dom.window.close();

  p=page();p.w.eval('nvwOpenWithdraw()');await wait();['3','0','0'].forEach(p.key);p.sheet().querySelector('[data-nvw="wd-next"]').click();await wait();
  p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(300);
  assert.equal(p.w.document.querySelector('.nvw-back'),null);
  p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'7',bubbles:true}));
  ok('Escape closes; the keypad listener is removed with the sheet');
  p.dom.window.close();
}

/* ─── tracker states ─────────────────────────────────────────────────── */
{
  const p=page();
  const cls=w=>{const d=p.w.document.createElement('div');d.innerHTML=p.w.eval('nvwTrackerHtml('+JSON.stringify(w)+',"2026-09-30 10:00")');return [...d.querySelectorAll('li')].map(l=>l.className+':'+l.querySelector('b').textContent.replace(/\u00a0/g,' '));};
  assert.deepEqual(cls({status:'Pending admin payout'}),['is-done:Requested','is-now:Being verified','is-next:Paid']);
  const paid=p.w.eval('nvwTrackerHtml({status:"Paid",paidAt:"2026-10-01 11:00",paidTxnId:"FT99"},"2026-09-30 10:00")');
  assert.match(paid,/Bank ref FT99/);assert.deepEqual(cls({status:'Paid',paidAt:'x'}),['is-done:Requested','is-done:Being verified','is-done:Paid']);
  assert.deepEqual(cls({status:'Rejected'}),['is-done:Requested','is-bad:Returned to your wallet']);
  assert.deepEqual(cls({status:'Rejected / Cancelled'}),['is-done:Requested','is-bad:Returned to your wallet']);
  for(const st of ['Failed','Expired','Reversed']) assert.deepEqual(cls({status:st}),['is-done:Requested','is-bad:'+st]);
  assert.deepEqual(plain(p.w.eval('["Paid","Pending admin payout","Rejected / Cancelled","Failed","Expired","Reversed",""].map(nvwPayoutStage)')),
    ['paid','pending','returned','other','other','other','other']);
  const tag=st=>p.w.eval('nvwTx({id:"x",entryType:"withdrawal_requested",amount:-100,affectsBalance:true,referenceType:"withdrawal",referenceId:"w9",referenceCode:"w9",createdAt:"2026-09-30 10:00"},null,[{_uuid:"w9",id:"W9",status:'+JSON.stringify(st)+',net:99,fee:1,speed:"24h",iban:"'+IBAN+'"}]).tag[0]');
  assert.equal(tag('Pending admin payout'),'Processing');assert.equal(tag('Failed'),'Failed');assert.equal(tag('Paid'),'Completed');
  ok('tracker: pending, paid (with bank reference), returned; failed/expired/reversed are never shown or counted as on their way');
  p.dom.window.close();
}

/* ─── bank card ──────────────────────────────────────────────────────── */
{
  let p=page();p.w.eval('nvwOpenBank()');await wait(50);
  let sh=p.sheet();assert.match(sh.textContent.replace(/\u00a0/g,' '),/Meezan/);assert.match(sh.textContent.replace(/\u00a0/g,' '),/TEST OWNER|Test Owner/);
  assert.ok(sh.querySelector('[data-nvw-verified]').hidden);assert.match(sh.textContent.replace(/\u00a0/g,' '),/Add the owner's CNIC in Profile/);
  sh.querySelector('[data-nvw="bank-edit"]').click();await wait(300);assert.deepEqual(plain(p.w.__forms),['bankHolderName']);
  p.dom.window.close();
  p=page({kyc:'verified'});p.w.eval('nvwOpenBank()');await wait(50);sh=p.sheet();
  assert.equal(sh.querySelector('[data-nvw-verified]').hidden,false);assert.match(sh.textContent.replace(/\u00a0/g,' '),/CNIC is verified/);
  p.dom.window.close();
  p=page({noBank:true});p.w.eval('nvwOpenBank()');await wait(50);assert.match(p.sheet().textContent.replace(/\u00a0/g,' '),/No bank account yet/);assert.match(p.sheet().textContent.replace(/\u00a0/g,' '),/Add bank account/);
  p.dom.window.close();
  ok('bank card: bank from the IBAN, masked number, holder, verified tick only when the CNIC is verified');
}

/* ─── just landed ────────────────────────────────────────────────────── */
{
  const p=page();
  const rows=[{id:'a',entryType:'invoice_credit',amount:1000,affectsBalance:true,referenceCode:'INV-1',createdAt:'2026-09-30 09:00'}];
  p.w.eval('nvwDetectLanded('+JSON.stringify(rows)+')');assert.equal(p.w.document.getElementById('nvwLanded'),null);
  p.w.__nvLedgerLoads=1;p.w.eval('nvwDetectLanded('+JSON.stringify(rows)+')');assert.equal(p.w.document.getElementById('nvwLanded'),null);
  ok('landed: nothing before the server load, and the first load is only the baseline');
  const more=rows.concat([{id:'b',entryType:'invoice_credit',amount:12450,affectsBalance:true,referenceCode:'INV-2',createdAt:'2026-09-30 17:00'},
                          {id:'c',entryType:'delivery_charge_due',amount:-250,affectsBalance:true,createdAt:'2026-09-30 17:00'}]);
  p.w.__nvLedgerLoads=2;p.w.eval('nvwDetectLanded('+JSON.stringify(more)+')');
  const el=p.w.document.getElementById('nvwLanded');assert.ok(el);await wait(1000);
  assert.match(el.textContent.replace(/\u00a0/g,' '),/Rs 12,450 just landed/);assert.match(el.textContent.replace(/\u00a0/g,' '),/COD settlement/);
  el.click();assert.deepEqual(plain(p.w.__tabs),['money']);
  ok('landed: a new COD credit shows "Rs 12,450 just landed", counts up, tap opens Money; charges are ignored');
  await wait(500);
  p.w.__nvLedgerLoads=3;p.w.eval('nvwDetectLanded('+JSON.stringify(more)+')');assert.equal(p.w.document.getElementById('nvwLanded'),null);
  ok('landed: announced once, not again on the next reload');
  p.dom.window.close();
  const d=page({demo:true});d.w.__nvLedgerLoads=1;d.w.eval('nvwDetectLanded([])');d.w.__nvLedgerLoads=2;
  d.w.eval('nvwDetectLanded('+JSON.stringify(more)+')');assert.equal(d.w.document.getElementById('nvwLanded'),null);d.dom.window.close();
  ok('landed: never in the demo');
}

/* ─── statement: opening, closing, running balance ───────────────────── */
{
  const p=page({balance:1500,state:{walletLedger:[
    {id:'1',clientId:CID,entryType:'invoice_credit',amount:5000,affectsBalance:true,referenceCode:'INV-AUG',createdAt:'2026-08-20 10:00'},
    {id:'2',clientId:CID,entryType:'withdrawal_requested',amount:-4000,affectsBalance:true,referenceType:'withdrawal',referenceCode:'w1',createdAt:'2026-08-25 10:00'},
    {id:'3',clientId:CID,entryType:'payout_fee',amount:-4,affectsBalance:false,referenceType:'withdrawal',referenceCode:'w1',createdAt:'2026-08-25 10:00'},
    {id:'4',clientId:CID,entryType:'invoice_credit',amount:2000,affectsBalance:true,referenceCode:'INV-SEP',createdAt:'2026-09-10 10:00'},
    {id:'5',clientId:CID,entryType:'invoice_due_debit',amount:-500,affectsBalance:true,referenceCode:'INV-SEP2',createdAt:'2026-09-20 10:00'},
    {id:'6',clientId:CID,entryType:'withdrawal_requested',amount:-1000,affectsBalance:true,referenceType:'withdrawal',referenceCode:'w2',createdAt:'2026-10-02 10:00'}]}});
  const led=p.w.eval('JSON.stringify(state.walletLedger)');
  const sep=plain(p.w.eval('nvwStatementData("2026-09",'+led+',1500)'));
  assert.equal(sep.closing,2500);assert.equal(sep.opening,1000);assert.equal(sep.moneyIn,2000);assert.equal(sep.moneyOut,500);
  assert.deepEqual(sep.lines.map(l=>l.balance),[3000,2500]);
  const aug=plain(p.w.eval('nvwStatementData("2026-08",'+led+',1500)'));assert.equal(aug.opening,0);assert.equal(aug.closing,1000);
  const all=plain(p.w.eval('nvwStatementData("all",'+led+',1500)'));assert.equal(all.opening,0);assert.equal(all.closing,1500);assert.equal(all.lines.length,5);
  ok('statement (demo, worked out locally): Sep opens 1,000, closes 2,500 (Aug closing = Sep opening); fees not counted twice');
  p.dom.window.close();
}
{
  // The demo has no server: it still gets a statement, from its own data.
  const d=page({demo:true,balance:1500,state:{walletLedger:[
    {id:'1',clientId:CID,entryType:'invoice_credit',amount:5000,affectsBalance:true,referenceCode:'INV-AUG',createdAt:'2026-08-20 10:00'},
    {id:'4',clientId:CID,entryType:'invoice_credit',amount:2000,affectsBalance:true,referenceCode:'INV-SEP',createdAt:'2026-09-10 10:00'},
    {id:'6',clientId:CID,entryType:'withdrawal_requested',amount:-5500,affectsBalance:true,referenceType:'withdrawal',referenceCode:'w2',createdAt:'2026-09-12 10:00'}]}});
  d.w.eval('nvwBuildStatement("2026-09")');
  assert.equal(d.w.__docs.length,1);assert.match(d.w.__docs[0].h.replace(/\u00a0/g,' '),/Rs 1,500/);
  assert.equal(d.w.__calls.filter(c=>c[0]==='client_wallet_statement').length,0);
  d.dom.window.close();
}
{
  // Live: one server snapshot; the page's own ledger copy is not used for balances.
  const server={period:'2026-09',opening:1000,closing:2500,money_in:2000,money_out:500,balance_now:2500,first_day:'2026-09-01',last_day:'2026-09-30',
    generated_at:'2026-09-30 22:40',lines:[
      {id:'a',at:'2026-09-01 00:30',entry_type:'invoice_credit',amount:2000,reference_type:'invoice',reference_id:null,reference_code:'INV-SEP',note:'',balance:3000},
      {id:'b',at:'2026-09-20 10:00',entry_type:'invoice_due_debit',amount:-500,reference_type:'invoice',reference_id:null,reference_code:'INV-SEP2',note:'',balance:2500}]};
  const p=page({balance:999999,state:{walletLedger:[{id:'stale',clientId:CID,entryType:'invoice_credit',amount:999999,affectsBalance:true,createdAt:'2026-09-02 10:00'}]},
    rpcs:{client_wallet_statement:()=>({data:server,error:null})}});
  p.w.eval('nvWalletStatement()');await wait(50);
  const months=[...p.sheet().querySelectorAll('.nvw-month')];assert.equal(months.length,7);
  months[0].click();await wait(300);
  assert.equal(p.w.__calls.filter(c=>c[0]==='client_wallet_statement').length,1,'the month picker asks the server');
  p.w.__docs.length=0;p.w.__calls.length=0;
  await p.w.eval('nvwBuildStatement("2026-09")');
  assert.deepEqual(plain(p.w.__calls.find(c=>c[0]==='client_wallet_statement')[1]),{p_period:'2026-09'});
  const doc=p.w.__docs[0];doc.h=doc.h.replace(/\u00a0/g,' ');
  assert.match(doc.h,/Opening balance/);assert.match(doc.h,/Rs 1,000/);assert.match(doc.h,/Rs 2,500/);assert.doesNotMatch(doc.h,/999,999/);
  assert.match(doc.h,/1 Sept? 2026 – 30 Sept? 2026/);assert.match(doc.h,/Generated: 30 Sept? 2026, 10:40 pm PKT/);
  assert.equal(doc.c[2][0],'2026-09-01 00:30');assert.equal(doc.c[2][5],3000);assert.equal(doc.c.at(-1)[5],2500);
  assert.equal(doc.n,'NovaX-wallet-statement-2026-09.csv');
  const bad=page({rpcs:{client_wallet_statement:()=>({data:null,error:{message:'JWT expired'}})}});
  await bad.w.eval('nvwBuildStatement("2026-09")');
  assert.equal(bad.w.__docs.length,0);assert.match(bad.w.__toasts.at(-1),/Couldn't make your statement/);
  const thrown=page({rpcs:{client_wallet_statement:()=>{throw new Error('offline');}}});
  await thrown.w.eval('nvwBuildStatement("all")');
  assert.equal(thrown.w.__docs.length,0);assert.match(thrown.w.__toasts.at(-1),/Couldn't make your statement/);
  ok('statement (live): built by the server in Pakistan months, a failed call says so instead of showing local figures');
  p.dom.window.close();bad.dom.window.close();thrown.dom.window.close();
}

/* ─── hide amounts: the page text, not just the styling ──────────────── */
{
  const p=page({state:{walletWithdrawals:[{_uuid:'wd-1',id:'WDR-AAAA01',iban:IBAN,speed:'24h',status:'Paid',net:4795.2,fee:4.8,createdAt:'2026-09-27 23:05',paidAt:'2026-09-28 21:06',paidTxnId:'FT1'}]}});
  const d=p.w.document, $=q=>d.querySelector(q);
  const rows=[
    {id:'l1',entryType:'invoice_credit',amount:3225,affectsBalance:true,referenceType:'invoice',referenceCode:'INV-A',createdAt:'2026-09-30 16:05'},
    {id:'l2',entryType:'withdrawal_requested',amount:-4800,affectsBalance:true,referenceType:'withdrawal',referenceId:'wd-1',referenceCode:'wd-1',createdAt:'2026-09-27 23:05'}];
  const render=()=>p.w.eval('nvwRenderCard(3425);nvwPaintBalance(document.getElementById("walletBalanceText"),3425);nvwRenderActivity(document.getElementById("walletLedgerList"),'+JSON.stringify(rows)+',"these 2 entries total Rs 3,425 · balance Rs 3,425.")');
  render();
  d.getElementById('client-money').insertAdjacentHTML('beforeend','<ol id="rail"><li><strong aria-label="Paid Rs 4,795">Rs 4,795</strong><em>Rs 4,795 this month</em></li></ol>');
  d.body.insertAdjacentHTML('beforeend','<div id="nvCodHero"><div class="nv-cod-main"><span class="nv-cod-l">Wallet balance</span>'+p.w.eval('nvwEyeButton("nv-cod-eye")')+
    '<div class="nv-cod-v">Rs 3,425</div></div><div class="nv-cod-b"><span>Pending payout</span><strong>Rs 0</strong></div></div><div id="elsewhere">COD Rs 1,899 on N123</div>');
  const areas=()=>$('#client-money').textContent+$('#nvCodHero').textContent;
  const attrs=()=>[...d.querySelectorAll('#client-money [aria-label],#client-money [title],#nvCodHero [aria-label]')].map(e=>(e.getAttribute('aria-label')||'')+(e.getAttribute('title')||'')).join('|');
  const AMT=/(Rs|PKR)\.?[\s\u00a0]?[\u2212-]?\d/;
  const shown=$('#client-money').textContent, shownHome=$('#nvCodHero').textContent;
  assert.match(shown.replace(/\u00a0/g,' '),/balance Rs 3,425/);

  $('#nvwEye').click();await wait(0);
  assert.doesNotMatch(areas(),AMT,'no amount left in the wallet areas');
  assert.doesNotMatch(attrs(),AMT,'no amount left for screen readers');
  const flat=areas().replace(/\u00a0/g,' ');
  assert.match(flat,/balance Rs ••••/);assert.match(flat,/\+ Rs ••••/);assert.match(flat,/− Rs ••••/);
  assert.equal($('#walletBalanceText').getAttribute('aria-label'),'Balance hidden');
  assert.match($('#elsewhere').textContent,/Rs 1,899/,'parcel COD outside the wallet areas is untouched');
  for(const b of d.querySelectorAll('[data-nvw-eye]')){ assert.equal(b.getAttribute('aria-pressed'),'true'); assert.equal(b.getAttribute('aria-label'),'Show amounts'); }

  render();await wait(0);
  assert.doesNotMatch(areas(),AMT,'a re-render while hidden stays hidden');
  p.w.eval('nvwShowLanded(3225,['+JSON.stringify(Object.assign({},rows[0],{clientId:CID}))+'])');await wait(0);
  assert.doesNotMatch($('#nvwLanded').textContent,AMT,'"just landed" hides its amount too');
  $('#nvwLanded').remove();
  d.querySelector('[data-nvw-tx="0"]').click();await wait(50);
  assert.match(p.sheet().textContent.replace(/\u00a0/g,' '),/Rs 3,225/,'a receipt opened on purpose shows its figures');
  p.sheet().querySelector('[data-nvw="close"]').click();await wait(250);

  $('.nv-cod-eye').click();await wait(0);
  assert.equal($('#client-money').textContent,shown,'showing again restores every amount exactly');
  assert.equal($('#nvCodHero').textContent,shownHome);
  assert.match(attrs(),/Paid Rs 4,795/);
  for(const b of d.querySelectorAll('[data-nvw-eye]')) assert.equal(b.getAttribute('aria-pressed'),'false');
  assert.equal(p.w.localStorage.getItem('nvWalletHidden'),'0');
  p.dom.window.close();

  // Hidden last time: hidden from the first paint.
  const q2=page({hidden:true});
  q2.w.eval('nvwRenderCard(3425);nvwPaintBalance(document.getElementById("walletBalanceText"),3425);nvwRenderActivity(document.getElementById("walletLedgerList"),'+JSON.stringify(rows)+',"balance Rs 3,425.")');
  await wait(0);
  assert.doesNotMatch(q2.w.document.getElementById('client-money').textContent,AMT);
  q2.dom.window.close();
  ok('hide amounts: every wallet amount and label becomes dots in the text itself, on Money and Home, through re-renders; receipts opened on purpose still show; showing restores exactly');
}

/* ─── labels that read alike ─────────────────────────────────────────── */
{
  assert.ok(!app.includes("'<div class=\"nv-inc-lbl\">On its way to you</div>'"));
  assert.ok(app.includes("'<div class=\"nv-inc-lbl\">Coming to your wallet</div>'"));
  assert.ok(html.includes('<strong id="nvRailReq">Rs 0</strong><em>being paid to your bank</em>'));
  assert.ok(!/On its way to your bank/.test(html));
  ok('labels: money coming INTO the wallet and a payout going OUT to the bank no longer read alike');
}

console.log('PASS wallet: '+passed.length+' checks\n  - '+passed.join('\n  - '));
