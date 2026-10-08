// The public tracking page (tracking.html) was rebuilt in the portal's look on
// 9 Oct 2026. These checks load the real page in a browser-like window, feed
// it parcels in each status through a stand-in for the database, and read
// what a customer would see. Nothing here touches the live database.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
let JSDOM;
try{ ({JSDOM}=await import('jsdom')); }
catch{ ({JSDOM}=createRequire('/tmp/novax-rider-test-deps/')('jsdom')); }
const html=readFileSync(new URL('../tracking.html',import.meta.url),'utf8');
const ok=m=>console.log('ok - '+m);
const wait=(ms=30)=>new Promise(r=>setTimeout(r,ms));

async function open(query,row,brand){
  const page=html.replace('<script src="/assets/vendor/supabase-2.117.2.js"></script>','');
  const dom=new JSDOM(page,{runScripts:'outside-only',url:'https://novaxlogistics.com/tracking.html'+query,pretendToBeVisual:true});
  const w=dom.window; w.__calls=[];
  w.supabase={createClient:()=>({rpc:(n,a)=>{w.__calls.push([n,a]);
    if(n==='public_track_brand') return Promise.resolve({data:brand?[brand]:[],error:null});
    return Promise.resolve({data:row?[row]:[],error:null});}})};
  for(const m of page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) w.eval(m[1]);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await wait(60);
  const d=w.document, q=s=>d.querySelector(s), text=s=>(q(s)?q(s).textContent.replace(/\s+/g,' ').trim():'');
  return {w,d,q,text,close:()=>w.close()};
}
const base={awb:'N1234567',origin_city:'Karachi',destination_city:'Lahore',cod_amount:3450,consignee_first:'Hina',rider_first:null,exception_note:null,journey:[],steps:[],delivered_at:null,updated_at:'2026-10-08T10:00:00Z'};

// the page itself
{
  for(const id of ['out','tkLive','tkWaSlot','tkAiSlot']) assert.equal(html.split('id="'+id+'"').length-1,1,id+' exists once');
  assert.ok(html.includes('@media (prefers-color-scheme:dark)')&&html.includes('<meta name="color-scheme" content="light dark">'),'light and dark, following the phone');
  assert.ok(html.includes('<meta name="robots" content="noindex,nofollow">')&&html.includes('<meta name="referrer" content="no-referrer">'),'still unlisted, and the link is never sent on as a referrer');
  assert.ok(html.includes('your money in your wallet the day it lands'),'the settled COD line is word for word');
  assert.ok(!/ctaHtml|#04100b|indigo/.test(html),'nothing left of the old dark-only page');
  assert.ok(!/animation:[^;}]*\bboth\b/.test(html),'no entrance starts from invisible');
  ok('page: one layout, light and dark, private, settled wording kept');
}

// every status says the right thing
{
  const cases=[
    ['New booked',              'Booked',                 'tk-hero',          true ],
    ['Parcel out for delivery', 'Out for delivery',       'tk-hero',          true ],
    ['Reattempt',               'Re-attempt scheduled',   'tk-hero is-warn',  true ],
    ['Delivered',               'Delivered',              'tk-hero',          false],
    ['Refused',                 'Delivery refused',       'tk-hero is-bad',   false],
    ['Return in transit',       'Return in transit to Lahore','tk-hero is-warn',false],
    ['Return to shipper',       'Returned',               'tk-hero is-bad',   false],
    ['Cancelled by client',     'Cancelled by the sender','tk-hero is-off',   false],
  ];
  for(const [status,head,cls,cod] of cases){
    const p=await open('?t=aaaaaaaaaaaaaaaaaaaaaaaa',Object.assign({},base,{status,delivered_at:status==='Delivered'?'2026-10-08T09:00:00Z':null,rider_first:status==='Parcel out for delivery'?'Ali':null}));
    assert.equal(p.text('.status-head'),head,status);
    assert.equal(p.q('.tk-hero').className,cls,status+' card colour');
    assert.equal(!!p.q('.cod'),cod,status+(cod?' asks for the cash':' does not ask for cash'));
    assert.equal(p.text('.tk-awb').replace('Tracking number','').trim(),'N1234567');
    assert.equal(p.text('.tk-eyebrow'),'For Hina');
    if(cod) assert.match(p.text('.cod'),/Rs 3,450/);
    if(status==='Delivered'){ assert.match(p.text('.eta'),/^Delivered 8 Oct, 02:00 pm$/); assert.equal(p.q('#tkLive').hidden,true); }
    if(status==='Parcel out for delivery'){ assert.equal(p.text('.pill'),'Rider: Ali'); assert.equal(p.q('#tkLive').hidden,false); }
    if(status==='Cancelled by client') assert.deepEqual([...p.d.querySelectorAll('.prog-note')].map(n=>n.textContent),['The seller cancelled this parcel.']);
    if(status==='Return to shipper') assert.deepEqual([...p.d.querySelectorAll('.prog-note')].map(n=>n.textContent),['This parcel was returned to the seller.']);
    if(status==='Return in transit') assert.deepEqual([...p.d.querySelectorAll('.prog-note')].map(n=>n.textContent),['This parcel is on its way back to the seller.']);
    assert.equal(p.d.querySelectorAll('.pstep').length,5);
    assert.ok(p.q('.tk-seller')&&p.q('.acts .act'),'share button and seller note are there');
    p.close();
  }
  ok('statuses: headline, card colour and the cash line are right for booked, out for delivery, reattempt, delivered, refused, returning, returned and cancelled');
}

// a tracking number alone shows no personal detail
{
  const p=await open('?awb=N1234567',{awb:'N1234567',status:'Parcel out for delivery',origin_city:'Karachi',destination_city:'Lahore',journey:[{status:'New booked',at:'2026-10-07T05:00:00Z'},{status:'Parcel out for delivery',at:'2026-10-08T05:00:00Z'}]});
  assert.equal(p.w.__calls[0][0],'public_track_awb');
  assert.equal(p.text('.tk-eyebrow'),'Your parcel'); assert.equal(p.q('.cod'),null); assert.equal(p.q('.pill'),null);
  assert.deepEqual([...p.d.querySelectorAll('.tl .s')].map(e=>e.textContent),['Out for delivery','Booked'],'newest step first');
  assert.match(p.text('.tl li.now .d'),/8 Oct, 10:00 am/,'Pakistan time');
  p.close();
  ok('tracking number link: no name, no cash amount, no rider; journey newest first in Pakistan time');
}

// the shop's own brand
{
  const p=await open('?t=aaaaaaaaaaaaaaaaaaaaaaaa',Object.assign({},base,{status:'Parcel out for delivery'}),{display_name:"Sana's Closet",logo_url:null,accent_hex:'#7c3aed',support_whatsapp:'923001234567'});
  await wait(40);
  assert.equal(p.text('.brandbar strong'),"Sana's Closet");
  assert.match(p.q('.brandbar').getAttribute('style'),/background:\s*(rgb\(124, 58, 237\)|#7c3aed)/i);
  const wa=p.q('#tkWaSlot #nvShopWa'); assert.ok(wa,'the WhatsApp button sits in its slot, outside the part a refresh redraws');
  assert.match(wa.href,/^https:\/\/wa\.me\/923001234567\?text=/);
  p.close();
  const p2=await open('?t=aaaaaaaaaaaaaaaaaaaaaaaa',Object.assign({},base,{status:'Delivered'}),{display_name:'Plain Shop',logo_url:null,accent_hex:null,support_whatsapp:null});
  await wait(40);
  assert.match(p2.q('.brandbar').getAttribute('style'),/background:\s*(rgb\(12, 124, 89\)|#0c7c59)/i,'no colour chosen: NovaX green, as the Profile preview shows');
  assert.equal(p2.q('#nvShopWa'),null);
  p2.close();
  ok("brand: the shop's name and colour on the header, its WhatsApp button, NovaX green when no colour is set");
}

// dead ends say what to do
{
  let p=await open('',null); assert.match(p.text('.msg'),/No tracking link/); assert.equal(p.q('#tkLive').hidden,true); assert.ok(p.q('.tk-seller')); p.close();
  p=await open('?t=aaaaaaaaaaaaaaaaaaaaaaaa',null); assert.match(p.text('.msg'),/Parcel not found.*ask your seller/); p.close();
  p=await open('?awb=N0000000',null); assert.match(p.text('.msg'),/Parcel not found.*check it and try again/); p.close();
  ok('no link, a wrong link and a wrong number each explain themselves');
}
console.log('TRACKING PAGE CHECKS PASSED');
