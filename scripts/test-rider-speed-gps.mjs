// 14 Oct 2026: the rider app was slow to refresh, GPS was taken only at
// "Delivered" (up to 10 s of waiting), and nobody could see how far a rider
// went. These checks hold the fixes: one parallel load, a cheap change check
// every 15 s, a GPS reading ready before the tap and saved with every action
// at a door, the day's route on Home, and the shop's note on the card.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {installFixture} from './rider-fixture.mjs';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=createRequire('/tmp/novax-rider-test-deps/package.json')('jsdom'));}
const html=readFileSync(new URL('../rider.html',import.meta.url),'utf8');
const scripts=['nv-payment.js','nv-journey.js','rider-core.js','rider-app.js'].map(f=>readFileSync(new URL('../'+f,import.meta.url),'utf8'));
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));
const ok=m=>console.log('ok - '+m);
/* geo: {mode:'watch'|'denied'} -- a phone whose GPS we drive by hand */
async function app(options={},geoMode='watch',setup){
  const dom=new JSDOM(html,{url:'https://fixture.invalid/rider.html?nosw=1',runScripts:'outside-only'}),w=dom.window;
  w.crypto.randomUUID=()=>crypto.randomUUID();const fixture=installFixture(w,options);
  if(setup)setup(fixture);
  Object.defineProperty(w.document,'hidden',{configurable:true,get:()=>false});
  const geo={watches:new Map(),n:0,started:0,cleared:0,
    fire(acc,lat=31.5,lng=74.35){for(const [,cb] of geo.watches)cb.ok({coords:{latitude:lat,longitude:lng,accuracy:acc},timestamp:Date.now()});},
    deny(){for(const [,cb] of geo.watches)cb.err&&cb.err({code:1});}};
  Object.defineProperty(w.navigator,'geolocation',{configurable:true,value:{
    watchPosition(okf,err){const id=++geo.n;geo.started++;geo.watches.set(id,{ok:okf,err});if(geoMode==='denied')setTimeout(()=>err&&err({code:1}),0);return id;},
    clearWatch(id){if(geo.watches.delete(id))geo.cleared++;},
    getCurrentPosition(okf,err){if(geoMode==='denied')err({code:1});else okf({coords:{latitude:31.5,longitude:74.35,accuracy:20},timestamp:Date.now()});}}});
  /* every network answer takes 30 ms, so overlapping requests can be seen */
  const real=w.supabase.createClient;let inFlight=0,maxIn=0;
  w.supabase={createClient(){const c=real();const slow=f=>async(...a)=>{inFlight++;maxIn=Math.max(maxIn,inFlight);await wait(30);try{return await f(...a);}finally{inFlight--;}};
    const from=c.from;return{...c,rpc:slow(c.rpc),from:t=>{const qy=from(t);const single=qy.single;qy.single=slow(single);return qy;}};}};
  const dialog=w.document.querySelector('dialog');dialog.showModal=()=>{dialog.open=true;};
  dialog.close=value=>{dialog.returnValue=value;dialog.open=false;dialog.onclose&&dialog.onclose();};
  scripts.forEach(s=>w.eval(s));await wait(150);
  const q=id=>w.document.getElementById(id);
  const go=v=>w.document.querySelector(`nav [data-view="${v}"]`).click();
  const tab=t=>w.document.querySelector(`[data-tab="${t}"]`).click();
  const pick=awb=>{const cb=w.document.querySelector(`.view:not(.hidden) [data-pick="${awb}"]`);cb.checked=true;cb.dispatchEvent(new w.Event('change',{bubbles:true}));};
  const views=()=>fixture.requests.filter(r=>r.name==='rider_station_view').length;
  const back=async()=>{w.document.dispatchEvent(new w.Event('visibilitychange'));await wait(120);};
  return{w,q,fixture,geo,dialog,go,tab,pick,views,back,maxIn:()=>maxIn};
}
const OUT='N1000004', STATION='N1000003';
const lastAction=f=>f.requests.filter(r=>r.name==='rider_station_action').slice(-1)[0];

// 1. one load = the three answers fetched together
{
  const a=await app();
  assert.equal(a.q('gate').classList.contains('hidden'),true);
  assert.ok(a.maxIn()>=3,'profile, station and cash are fetched at the same time (at most '+a.maxIn()+' at once)');
  ok('load: profile, station and cash in parallel, not one after the other');
}

// 2. the change check: nothing changed = nothing downloaded; a change = one download
{
  const a=await app({},'watch',f=>{f.stamp='s1';});
  const v0=a.views();
  await a.back();
  assert.equal(a.views(),v0,'same stamp: the station is not downloaded again');
  assert.ok(a.fixture.requests.some(r=>r.name==='rider_station_stamp'),'it asked whether anything changed');
  assert.equal(a.q('lastSync').textContent,'Up to date');
  a.fixture.stamp='s2';await a.back();
  assert.equal(a.views(),v0+1,'new stamp: downloaded once');
  // a server without the check: no stamp calls, the old once-a-minute download
  const b=await app();const v1=b.views();await b.back();
  assert.equal(b.views(),v1,'no stamp from the server: no extra download within the minute');
  assert.equal(b.fixture.requests.filter(r=>r.name==='rider_station_stamp').length,0,'and no stamp calls');
  ok('refresh: a few-byte check every 15 s, the station downloaded only when it changed; old servers fall back to once a minute');
}

// 3. GPS ready before the tap: Delivered saves at once with the reading already there
{
  const a=await app();
  assert.equal(a.geo.watches.size,1,'the phone follows the rider while a parcel is out');
  a.geo.fire(8,31.51234,74.34321);
  a.go('delivery');a.tab('delivery:out');
  a.q('outList').querySelector(`[data-act="delivered"][data-awb="${OUT}"]`).click();await wait();
  const t0=Date.now();a.dialog.close('confirm');await wait(120);
  const job=lastAction(a.fixture);
  assert.equal(job.args.p_action,'delivered');
  assert.equal(job.args.p_loc.lat,31.51234);assert.equal(job.args.p_loc.lng,74.34321);assert.equal(job.args.p_loc.accuracy,8);
  assert.ok(job.args.p_loc.at&&job.args.p_loc.fix_at,'the tap time and the reading time are both sent');
  assert.ok(Date.now()-t0<1000,'no waiting');
  assert.equal(a.geo.watches.size,1,'a return is still out: still one watch, never a second one');
  a.w.document.querySelector('nav [data-view="cash"]').click();await wait();
  assert.equal(a.geo.watches.size,1,'other screens do not stop it while parcels are out');
  ok('GPS: a reading within 30 m is ready before the tap and goes with Delivered straight away');
}

// 4. a weak reading: it waits for a better one; refused and taking out carry the place too
{
  const a=await app();
  a.geo.fire(90);
  a.go('delivery');a.tab('delivery:out');
  a.q('outList').querySelector(`[data-act="refused"][data-awb="${OUT}"]`).click();await wait();
  a.q('reasonOther').value='Customer refused';a.dialog.close('confirm');await wait(60);
  assert.match(a.q('notice').textContent,/Getting GPS/,'±90 m is not good enough: it keeps looking');
  a.geo.fire(12,31.4,74.2);await wait(120);
  const job=lastAction(a.fixture);
  assert.equal(job.args.p_action,'refused');assert.equal(job.args.p_loc.accuracy,12);assert.equal(job.args.p_loc.lat,31.4);
  // At station → take out: the place is sent with it (the station, the start of the route)
  a.tab('delivery:station');a.pick(STATION);a.q('actionGo').click();await wait(150);
  const out=lastAction(a.fixture);
  assert.equal(out.args.p_action,'out');assert.ok(out.args.p_loc&&typeof out.args.p_loc.lat==='number','taking out carries the place');
  ok('GPS: a weak reading waits for a better one; Refused and taking out save the place too');
}

// 5. location switched off: the rider is told how to turn it on, and the action still saves
{
  const a=await app({},'denied');await wait(60);
  a.go('delivery');a.tab('delivery:out');
  assert.equal(a.q('geoNote').classList.contains('hidden'),false,'the warning shows');
  assert.match(a.q('geoNote').textContent,/Location is off/);
  a.q('outList').querySelector(`[data-act="delivered"][data-awb="${OUT}"]`).click();await wait();a.dialog.close('confirm');await wait(120);
  const job=lastAction(a.fixture);
  assert.equal(job.args.p_loc.unavailable,true);assert.equal(job.args.p_loc.reason,'denied');
  ok('location off: a plain warning with the steps, and Delivered still saves (marked "no GPS" for the office)');
}

// 6. the shop's note, "may open" and fragile on the card
{
  const a=await app({},'watch',f=>{f.rows[4].meta={allowOpen:'Yes',comments:'Fragile, Handle with care',fragile:'Yes'};f.rows[3].meta={allowOpen:'No',fragile:'Yes'};});
  a.go('delivery');a.tab('delivery:out');
  const out=a.q('outList').querySelector('.shopnote');
  assert.ok(out,'shown on a parcel that is out');
  assert.equal(out.textContent,"May open before paying · Shop's note: Fragile, Handle with care",'fragile is not said twice');
  a.tab('delivery:station');
  assert.equal(a.q('stationList').querySelector('.shopnote').textContent,'Do not open · Fragile');
  a.go('pickup');assert.equal(a.q('collectList').querySelector('.shopnote'),null,'not on a pickup');
  ok("cards: the shop's note, whether it may be opened before paying, and fragile");
}

// 7. today's route on Home
{
  const route={day:'2026-10-15',km:9.9,n:4,gps:4,same:1,stops:[
    {at:'2026-10-15T05:00:00Z',action:'out',awbs:['N1','N2','N3'],lat:31.5204,lng:74.3587,acc:12},
    {at:'2026-10-15T06:00:00Z',action:'delivered',awbs:['N1'],lat:31.5102,lng:74.3431,acc:9,km:1.86},
    {at:'2026-10-15T06:05:00Z',action:'delivered',awbs:['N2'],lat:31.51021,lng:74.34311,acc:9,km:0,flag:'same'},
    {at:'2026-10-15T07:00:00Z',action:'refused',awbs:['N3'],acc:400,flag:'weak'}]};
  const a=await app({},'watch',f=>{f.route=route;});
  assert.match(a.q('stats').textContent,/Distance today\s*9\.9 km/);
  const box=a.q('routeBox');assert.equal(box.classList.contains('hidden'),false);
  assert.match(box.querySelector('summary').textContent,/Today's route\s*4 stops · 9\.9 km/);
  const rows=[...box.querySelectorAll('.route-list li')].map(li=>li.textContent);
  assert.equal(rows.length,4);
  assert.match(rows[0],/^12:00 pm\s*Refused N3\s*weak GPS, not counted$/i,'newest first, Pakistan time');
  assert.match(rows[1],/Delivered N2\s*same place as the stop before\+0\.0 km/);
  assert.match(rows[2],/Delivered N1\+1\.9 km/);
  assert.match(rows[3],/Took out 3 parcels/);
  const map=box.querySelector('a.call').getAttribute('href');
  assert.equal(map,'https://www.google.com/maps/dir/31.520400,74.358700/31.510200,74.343100/31.510210,74.343110','the map leaves out the weak reading');
  const none=await app();assert.equal(none.q('routeBox').classList.contains('hidden'),true,'no route yet: nothing shown');
  assert.doesNotMatch(none.q('stats').textContent,/Distance today/);
  ok("home: today's route, newest stop first, km from the stop before, flags, and a map of the stops");
}
console.log('RIDER SPEED + GPS CHECKS PASSED');
process.exit(0);
