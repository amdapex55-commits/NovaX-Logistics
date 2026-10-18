// Rider voice notes (18 Oct 2026): after Refused / Not available the rider
// must record a note (or report a blocked microphone). Runs the real rider
// app in jsdom against the in-memory fixture, with a fake microphone and a
// fake storage bucket. Touches no network and no database.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {installFixture} from './rider-fixture.mjs';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=createRequire('/tmp/novax-rider-test-deps/package.json')('jsdom'));}
const html=readFileSync(new URL('../rider.html',import.meta.url),'utf8');
const raw=['nv-payment.js','nv-journey.js','rider-core.js','rider-app.js'].map(f=>readFileSync(new URL('../'+f,import.meta.url),'utf8'));
// The live app pilots the recorder with listed riders; these checks switch it on for the fixture rider.
assert.ok(raw[3].includes('var VOICE_RIDERS = ['),'pilot list present');
// Since 18 Oct 2026 the live list holds "*" (every rider); the pilot check strips it again.
const allOn=raw.map((s,i)=>i===3&&!s.includes('var VOICE_RIDERS = ["*"')?s.replace('var VOICE_RIDERS = [','var VOICE_RIDERS = ["*", '):s);
const pilotOnly=raw.map((s,i)=>i===3?s.replace('var VOICE_RIDERS = ["*", ','var VOICE_RIDERS = ['):s);
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));

async function app({micBlocked=false,pilot=true,brokenStore=false}={}){
  const scripts=pilot?allOn:pilotOnly;
  const dom=new JSDOM(html,{url:'https://fixture.invalid/rider.html?nosw=1',runScripts:'outside-only'}),w=dom.window;
  w.crypto.randomUUID=()=>crypto.randomUUID();
  const fixture=installFixture(w,{});fixture.uploads=[];
  const make=w.supabase.createClient;
  w.supabase.createClient=(...a)=>Object.assign(make(...a),{storage:{from:bucket=>({upload:async(path,blob,opts)=>{
    fixture.uploads.push({bucket,path,size:blob.size,opts,at:fixture.requests.length});return{data:{path},error:null};}})}});
  for(const d of w.document.querySelectorAll('dialog')){
    d.showModal=()=>{d.open=true;};
    d.close=v=>{d.returnValue=v;d.open=false;d.onclose&&d.onclose();};
  }
  Object.defineProperty(w.navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
    if(micBlocked){const e=new Error('denied');e.name='NotAllowedError';throw e;}
    return{getTracks:()=>[{stop(){}}]};}}});
  w.MediaRecorder=class{constructor(){this.state='inactive';this.mimeType='audio/webm;codecs=opus';}
    static isTypeSupported(m){return m.startsWith('audio/webm');}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable({data:new w.Blob([new Uint8Array(40000)],{type:'audio/webm'})});this.onstop();}};
  w.URL.createObjectURL=()=>'blob:fixture';w.URL.revokeObjectURL=()=>{};
  // iPhone Safari, 18 Oct 2026: storage opens, then every write aborts with error === null.
  if(brokenStore)w.indexedDB={open(){const req={};setTimeout(()=>{req.result={transaction(){const tx={error:null};
    tx.objectStore=()=>({put(){setTimeout(()=>tx.onabort&&tx.onabort(),0);},delete(){setTimeout(()=>tx.oncomplete&&tx.oncomplete(),0);},
      getAll(){const g={result:[]};setTimeout(()=>tx.oncomplete&&tx.oncomplete(),0);return g;}});return tx;}};req.onsuccess&&req.onsuccess();},0);return req;}};
  scripts.forEach(s=>w.eval(s));await wait();
  const q=id=>w.document.getElementById(id);
  return{w,fixture,q,action:w.document.getElementById('actionDialog'),voice:w.document.getElementById('voiceDialog')};
}
async function refuse(a){
  a.w.document.querySelector('nav [data-view="delivery"]').click();
  a.w.document.querySelector('[data-tab="delivery:out"]').click();
  a.q('outList').querySelector('[data-act="refused"][data-awb="N1000004"]').click();await wait();
  a.q('reasonOther').value='Customer refused';a.action.close('confirm');await wait(80);
}

// 1. the recorder opens after the refusal is saved, and cannot be dismissed
{
  const a=await app();
  await refuse(a);
  assert.equal(a.voice.open,true,'voice recorder opens');
  await wait(150);
  assert.ok(a.fixture.requests.some(r=>r.name==='rider_station_action'&&r.args.p_action==='refused'),'the refusal is sent while the recorder is open');
  assert.match(a.q('voiceFor').textContent,/N1000004.*Refused.*Customer refused/);
  const esc=new a.w.Event('cancel',{cancelable:true});a.voice.dispatchEvent(esc);
  assert.equal(esc.defaultPrevented,true,'Escape / back cannot close it');
  // too short: start and stop at once
  a.q('voiceRec').click();await wait();a.q('voiceRec').click();await wait();
  assert.match(a.q('voiceError').textContent,/Too short/);
  assert.equal(a.q('voiceReview').classList.contains('hidden'),true);
  // a real-length note: 5 seconds
  const real=a.w.Date.now.bind(a.w.Date);let shift=0;a.w.Date.now=()=>real()+shift;
  a.q('voiceRec').click();await wait();shift=5000;a.q('voiceRec').click();await wait();
  assert.equal(a.q('voiceReview').classList.contains('hidden'),false,'listen-back shows');
  assert.match(a.q('voiceTime').textContent,/0:05/);
  a.q('voiceSend').click();await wait(300);
  assert.equal(a.voice.open,false,'closes once sent');
  const station=a.fixture.requests.findIndex(r=>r.name==='rider_station_action'&&r.args.p_action==='refused');
  assert.ok(station>=0,'refusal sent');
  assert.equal(a.fixture.uploads.length,1,'one upload');
  const up=a.fixture.uploads[0];
  assert.equal(up.bucket,'parcel-voice');
  assert.match(up.path,/^client-1\/N1000004\/fixture-rider-\d{12,14}-[0-9a-f]{8}\.webm$/);
  assert.equal(up.opts.contentType,'audio/webm');assert.equal(up.opts.upsert,false);
  assert.ok(up.at>station,'uploaded only after the refusal reached NovaX');
  const att=a.fixture.requests.find(r=>r.name==='rider_voice_attach');
  assert.ok(att,'attached');
  assert.equal(att.args.p_awb,'N1000004');assert.equal(att.args.p_path,up.path);
  assert.ok(att.args.p_duration_ms>=3000&&att.args.p_duration_ms<=60000);
  assert.equal(att.args.p_reason,'Customer refused');assert.equal(att.args.p_mime,'audio/webm');
  assert.ok(att.args.p_lat&&att.args.p_lng,'the place of the refusal travels with it');
  console.log('ok - refusal -> mandatory recorder -> too short refused -> 5 s note uploaded after the status, then attached');
}

// 2. microphone blocked: the only way past, and it is reported
{
  const a=await app({micBlocked:true});
  await refuse(a);
  a.q('voiceRec').click();await wait();
  assert.equal(a.q('voiceBlocked').classList.contains('hidden'),false,'blocked panel');
  assert.match(a.q('voiceBlockedText').textContent,/blocked the microphone/);
  a.q('voiceSkip').click();await wait(300);
  assert.equal(a.voice.open,false);
  const skip=a.fixture.requests.find(r=>r.name==='rider_voice_skip');
  assert.ok(skip,'skip sent');assert.equal(skip.args.p_awb,'N1000004');assert.equal(skip.args.p_why,'no_mic');
  assert.equal(a.fixture.uploads.length,0);
  console.log('ok - blocked microphone: explained, skip recorded as no_mic, nothing uploaded');
}
// 4. the phone cannot store the recording (iPhone): no "null", the rider is not stuck, the note still sends
{
  const a=await app({brokenStore:true});
  await refuse(a);
  const real=a.w.Date.now.bind(a.w.Date);let shift=0;a.w.Date.now=()=>real()+shift;
  a.q('voiceRec').click();await wait();shift=6000;a.q('voiceRec').click();await wait();
  a.q('voiceSend').click();await wait(400);
  assert.notEqual(a.q('voiceError').textContent,'null','never shows a bare null');
  assert.equal(a.voice.open,false,'rider is not stuck on the recorder');
  assert.equal(a.fixture.uploads.length,1,'note still uploaded');
  assert.ok(a.fixture.requests.find(r=>r.name==='rider_voice_attach'),'and attached');
  const st=a.fixture.requests.findIndex(r=>r.name==='rider_station_action'&&r.args.p_action==='refused');
  assert.ok(st>=0&&a.fixture.uploads[0].at>st,'refusal first, then the note');
  console.log('ok - phone storage fails with a null error: note kept in memory and sent, rider not blocked');
}

// 3. a rider outside the pilot is not asked for a note
{
  const a=await app({pilot:false});
  await refuse(a);
  assert.equal(a.voice.open,false,'no recorder outside the pilot');
  assert.ok(a.fixture.requests.some(r=>r.name==='rider_station_action'&&r.args.p_action==='refused'),'the refusal itself still saves');
  console.log('ok - pilot: riders not on the list mark refused exactly as before');
}
console.log('RIDER VOICE CHECKS PASSED');
process.exit(0);
