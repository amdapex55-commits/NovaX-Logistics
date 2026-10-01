// CNIC photos (30 Sep 2026): shared helper, signup, merchant Profile and admin review.
// The database rules are rehearsed separately against production in a rolled-back
// transaction; this covers the screens and the calls they make.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {JSDOM,VirtualConsole}=require('jsdom');
const {webcrypto}=require('node:crypto');
const read=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8');
const cnicJs=read('nv-cnic.js');
const wait=(ms=30)=>new Promise(r=>setTimeout(r,ms));
const CID='d2485e75-dde9-446a-a0ab-c5db158df20f';
const PATH_RE=new RegExp('^'+CID+'/cnic-(front|back)-[0-9]{10,16}-[0-9a-f]{8}\\.jpg$');   // storage rule + random tail
const passed=[];const ok=m=>passed.push(m);
const plain=x=>JSON.parse(JSON.stringify(x));   // jsdom objects live in another realm

/* jsdom cannot decode images or draw on a canvas: fake both, per file.
   A file's spec decides its size and what its pixels look like. */
let seedN=0;
function fakeMedia(w,opts={}){
  const specs=new Map();let n=0;
  /* jsdom has no Blob.arrayBuffer or crypto.subtle; the browser has both. */
  if(!w.Blob.prototype.arrayBuffer)w.Blob.prototype.arrayBuffer=function(){return Promise.resolve((this.__bytes||new Uint8Array(0)).slice().buffer);};
  if(!w.crypto.subtle)Object.defineProperty(w.crypto,'subtle',{value:webcrypto.subtle});
  w.URL.createObjectURL=b=>{const u='blob:fake/'+(++n);specs.set(u,b&&b.__spec||{w:1200,h:800,seed:++seedN});return u;};
  w.URL.revokeObjectURL=()=>{};
  w.Image=class{constructor(){this.naturalWidth=0;this.naturalHeight=0;}
    set src(u){this._s=u;const s=specs.get(u)||{w:1200,h:800,seed:++seedN};this.__spec=s;setTimeout(()=>{if(s.bad){this.onerror&&this.onerror();}else{this.naturalWidth=s.w;this.naturalHeight=s.h;this.onload&&this.onload();}},0);}
    get src(){return this._s;}};
  w.HTMLCanvasElement.prototype.getContext=function(){const cv=this;return{fillStyle:'',fillRect(){},drawImage(img){cv.__spec=img&&img.__spec;},
    getImageData(x,y,W,H){const s=cv.__spec||{},d=new w.Uint8ClampedArray(W*H*4);let r=(s.seed||1)*2654435761>>>0;
      for(let i=0;i<W*H;i++){r=(r*1103515245+12345)>>>0;const v=s.blank?200:s.dark?8+(r%10):(r>>>8)%256;d[i*4]=d[i*4+1]=d[i*4+2]=v;d[i*4+3]=255;}
      return{data:d};}};};
  w.HTMLCanvasElement.prototype.toBlob=function(cb,type,q){const size=(opts.outSize||(()=>200*1024))(this.width,this.height,q);
    const b=new w.Blob([new Uint8Array(Math.min(size,64))],{type});Object.defineProperty(b,'size',{value:size});
    (opts.qualities||[]).push(q);setTimeout(()=>cb(b),0);};
}
function photo(w,{width=4000,height=3000,type='image/jpeg',name='cnic.jpg',bad=false,blank=false,dark=false,seed,size=3e6}={}){
  const sd=seed||++seedN,bytes=new Uint8Array(16).map((_,i)=>(sd*31+i*7)&255);   // same seed = same file bytes
  const f=new w.File([bytes],name,{type});f.__bytes=bytes;
  Object.defineProperty(f,'size',{value:size});f.__spec={w:width,h:height,bad,blank,dark,seed:sd};return f;
}
function choose(w,input,file){Object.defineProperty(input,'files',{value:[file],configurable:true});input.dispatchEvent(new w.Event('change',{bubbles:true}));}
function stubSb(o={}){
  const calls=[];
  const sb={calls,
    auth:{signUp:async a=>{calls.push(['signUp',a.email]);return{data:{user:{id:'u-new',identities:[{}]},session:o.noSession?null:{access_token:'t'}},error:null};},
      getSession:async()=>({data:{session:null},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
      signInWithPassword:async()=>({data:null,error:{message:'no'}})},
    rpc:async(name,args)=>{calls.push(['rpc',name,args]);
      if(o.rpc&&o.rpc[name])return o.rpc[name](args);
      if(name==='client_kyc_upload_check')return{data:{ok:true,message:null},error:null};
      if(name==='nv_signup_lead_create')return{data:'lead-1',error:null};
      if(name==='nv_signup_provision')return{data:CID,error:null};
      if(name==='client_kyc_submit')return{data:{status:'submitted'},error:null};
      return{data:null,error:null};},
    storage:{from:b=>({
      upload:async(path,blob,opt)=>{calls.push(['upload',b,path,opt.contentType,opt.upsert,blob.size]);
        if(o.uploadHang)return new Promise(()=>{});
        if(o.uploadDelay&&o.uploadDelay(path))await wait(o.uploadDelay(path));
        const f=o.uploadFail&&(o.uploadFail===true||o.uploadFail(path));
        if(f)return{data:null,error:{message:typeof f==='string'?f:'Network request failed'}};
        return{data:{path},error:null};},
      remove:async names=>{calls.push(['remove',b,names.slice()]);return{data:names.map(n=>({name:n})),error:null};},
      createSignedUrls:async(paths,sec)=>{calls.push(['sign',b,paths,sec]);return{data:paths.map(p=>({path:p,signedUrl:'https://signed.test/'+p})),error:null};},
      list:async()=>({data:[],error:null})})},
    from:()=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,single:async()=>({data:null,error:null}),then:r=>r({data:[],error:null})};return q;}};
  return sb;
}
const removed=sb=>sb.calls.filter(c=>c[0]==='remove').flatMap(c=>c[2]);

/* ─── 1. nv-cnic.js on its own ─────────────────────────────────────────── */
{
  const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://novax.test/'});const w=dom.window;
  const qualities=[];fakeMedia(w,{qualities});w.eval(cnicJs);const N=w.NVCnic;
  const p=N.paths(CID),p2=N.paths(CID);assert.match(p.front,PATH_RE);assert.match(p.back,PATH_RE);
  assert.notEqual(p.front,p2.front);assert.notEqual(p.back,p2.back);
  ok('paths match the storage rule and never repeat, even in the same millisecond');
  assert.equal(N.ACCEPT,'image/jpeg,image/png,image/webp');
  const out=await N.prepare(photo(w));assert.equal(out.width,1600);assert.equal(out.height,1200);assert.equal(out.blob.type,'image/jpeg');
  ok('4000x3000 photo shrinks to 1600x1200 JPEG');
  await assert.rejects(N.prepare(photo(w,{width:500,height:300})),/too small/);ok('tiny photo refused');
  await assert.rejects(N.prepare(photo(w,{width:10000,height:380})),/long and narrow/);
  await assert.rejects(N.prepare(photo(w,{width:1200,height:3100})),/long and narrow/);
  await N.prepare(photo(w,{width:4000,height:2250}));await N.prepare(photo(w,{width:1080,height:2340}));
  ok('10000x380 strips refused; normal 16:9 and tall phone photos still pass');
  await assert.rejects(N.prepare(photo(w,{blank:true})),/looks blank/);
  await assert.rejects(N.prepare(photo(w,{dark:true})),/too dark/);ok('blank and dark photos refused');
  await assert.rejects(N.prepare(photo(w,{type:'application/pdf'})),/JPG or PNG/);
  await assert.rejects(N.prepare(photo(w,{type:'image/gif'})),/JPG or PNG/);
  await assert.rejects(N.prepare(photo(w,{type:'image/svg+xml'})),/JPG or PNG/);ok('PDF, GIF and SVG refused');
  await assert.rejects(N.prepare(photo(w,{type:'image/heic',name:'IMG_1.HEIC',bad:true})),/HEIC/);
  await assert.rejects(N.prepare(photo(w,{type:'',name:'IMG_2.heif',bad:true})),/HEIC/);
  await assert.rejects(N.prepare(photo(w,{bad:true})),/can't be opened/);
  ok('an HEIC the browser cannot open gets its own message; other unreadable files a general one');
  await N.prepare(photo(w,{type:'image/heic',name:'IMG_3.HEIC'}));ok('an HEIC the browser can open is converted like any photo');
  await assert.rejects(N.prepare(photo(w,{size:30*1024*1024})),/too large/);ok('30 MB input refused');
  await N.prepare(photo(w,{type:''}));ok('missing file type still tried');
  const dom2=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://novax.test/'});const w2=dom2.window;
  const q2=[];fakeMedia(w2,{qualities:q2,outSize:(W,H,q)=>q>0.7?4e6:1e6});w2.eval(cnicJs);
  const o2=await w2.NVCnic.prepare(photo(w2));assert.ok(q2.length===2&&q2[1]<q2[0]);assert.equal(o2.blob.size,1e6);
  const dom3=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://novax.test/'});const w3=dom3.window;
  fakeMedia(w3,{outSize:()=>9e6});w3.eval(cnicJs);await assert.rejects(w3.NVCnic.prepare(photo(w3)),/too large/);
  ok('oversized output re-encoded lower, then refused');

  const f=await N.prepare(photo(w)),b=await N.prepare(photo(w)),same=await N.prepare(photo(w,{seed:4242})),same2=await N.prepare(photo(w,{seed:4242}));
  let sb=stubSb();
  await assert.rejects(N.upload(null,CID,f,b),/Not connected/);
  await assert.rejects(N.upload(sb,'CL-1234',f,b),/still loading/);
  await assert.rejects(N.upload(sb,CID,f,null),/front and the back/);
  await assert.rejects(N.send(sb,CID,same,same2),/same photo/);assert.equal(sb.calls.length,0);
  ok('the same shot for front and back is refused before anything uploads');
  const res=await N.send(sb,CID,f,b);
  const order=sb.calls.map(c=>c[0]==='rpc'?c[1]:c[0]);
  assert.deepEqual(plain(order),['client_kyc_upload_check','upload','upload','client_kyc_submit']);
  sb.calls.filter(c=>c[0]==='upload').forEach(u=>{assert.equal(u[1],'client-kyc');assert.match(u[2],PATH_RE);assert.equal(u[3],'image/jpeg');assert.equal(u[4],false);});
  assert.equal(res.status,'submitted');assert.equal(removed(sb).length,0);
  ok('send: asks the server first, uploads both (jpeg, no overwrite), records them, removes nothing');
  sb=stubSb({rpc:{client_kyc_upload_check:()=>({data:{ok:false,message:'Too many photo uploads today. Try again tomorrow.'},error:null})}});
  await assert.rejects(N.send(sb,CID,f,b),/Too many photo uploads today/);assert.ok(!sb.calls.some(c=>c[0]==='upload'));
  ok('a blocked merchant is told why and nothing uploads');
  sb=stubSb({uploadFail:p=>/cnic-back/.test(p)});
  await assert.rejects(N.send(sb,CID,f,b),/Network request failed/);await wait();
  const up1=sb.calls.find(c=>c[0]==='upload'&&/cnic-front/.test(c[2]))[2];
  assert.deepEqual(plain(removed(sb)),[up1]);assert.ok(!sb.calls.some(c=>c[1]==='client_kyc_submit'));
  ok('front uploaded, back failed: the front is removed again, nothing recorded');
  sb=stubSb({rpc:{client_kyc_submit:()=>({data:null,error:{message:'Your CNIC is already verified. Contact NovaX to change it.'}})}});
  await assert.rejects(N.send(sb,CID,f,b),/already verified/);await wait();
  assert.equal(removed(sb).length,2);ok('recording refused: both uploads are removed again, and the reason reaches the screen');
  sb=stubSb({uploadDelay:p=>/cnic-back/.test(p)?150:0});
  await assert.rejects(N.upload(sb,CID,f,b,60,true),/taking too long/);await wait(10);
  const upF=sb.calls.find(c=>c[0]==='upload'&&/cnic-front/.test(c[2]))[2];
  assert.deepEqual(plain(removed(sb)),[upF]);
  await wait(200);const upB=sb.calls.find(c=>c[0]==='upload'&&/cnic-back/.test(c[2]))[2];
  assert.deepEqual(plain(removed(sb)).sort(),[upF,upB].sort());
  ok('timed out: the finished upload is removed at once, the late one when it finishes');
  sb=stubSb({uploadFail:()=> 'new row violates row-level security policy',
    rpc:{client_kyc_upload_check:(()=>{let n=0;return()=>({data:n++?{ok:false,message:'Only the account owner can add the CNIC.'}:{ok:true},error:null});})()}});
  await assert.rejects(N.send(sb,CID,f,b),/Only the account owner can add the CNIC/);
  ok('a refused upload is explained in plain words (asks the server why)');
  sb=stubSb({uploadFail:()=> 'new row violates row-level security policy'});
  await assert.rejects(N.send(sb,CID,f,b),/could not be saved\. Refresh/);ok('an unexplained refusal says refresh, not jargon');
  sb=stubSb();await N.attach(sb,CID,f,b);
  assert.ok(!sb.calls.some(c=>c[1]==='client_kyc_upload_check'));assert.equal(sb.calls.find(c=>c[1]==='admin_kyc_attach')[2].p_client,CID);
  sb=stubSb({rpc:{admin_kyc_attach:()=>({data:null,error:{message:'That client no longer exists.'}})}});
  await assert.rejects(N.attach(sb,CID,f,b),/no longer exists/);await wait();assert.equal(removed(sb).length,2);
  ok('admin upload: no merchant check; cleaned up when refused');
  sb=stubSb();const urls=await N.signedUrls(sb,[p.front,null,p.back],120);assert.equal(urls[p.front],'https://signed.test/'+p.front);
  assert.deepEqual(plain(sb.calls.find(c=>c[0]==='sign')[2]),[p.front,p.back]);ok('signed links, nulls skipped');
  // picker
  w.document.body.innerHTML='<div id="pk"><label data-cnic-side="front"><input type="file"><img hidden><span data-cnic-note>Take</span></label><label data-cnic-side="back"><input type="file"><img hidden><span data-cnic-note>Take</span></label></div>';
  let changes=0;const pk=N.picker(w.document.getElementById('pk'),{onChange:()=>changes++});
  const [fi,bi]=w.document.querySelectorAll('input');assert.equal(fi.getAttribute('accept'),'image/jpeg,image/png,image/webp');
  choose(w,fi,photo(w,{seed:777}));assert.ok(pk.busy());await wait();assert.ok(!pk.ready());
  choose(w,bi,photo(w,{width:300,height:200}));await wait();
  const bt=w.document.querySelector('[data-cnic-side=back]');assert.ok(bt.classList.contains('is-err'));assert.match(bt.textContent,/too small/);assert.equal(bi.value,'');
  choose(w,bi,photo(w,{seed:777}));await wait();
  assert.ok(bt.classList.contains('is-err'));assert.match(bt.textContent,/same photo as the front/);assert.ok(!pk.ready());
  choose(w,bi,photo(w));await wait();assert.ok(pk.ready());assert.equal(changes,4);
  assert.ok(!w.document.querySelector('[data-cnic-side=front] img').hidden);
  pk.reset();assert.ok(!pk.ready());assert.equal(w.document.querySelector('[data-cnic-side=front] [data-cnic-note]').textContent,'Take');
  ok('picker: busy, errors in the tile, same photo on both sides refused, ready, reset');
  // two different files that look alike in a small copy (a small card on the same table) are NOT the same photo
  const look1=photo(w,{seed:900}),look2=photo(w,{seed:900});look2.__bytes=new Uint8Array(16).fill(9);
  choose(w,fi,look1);choose(w,bi,look2);await wait();assert.ok(pk.ready());
  ok('picker: look-alike but different photos are accepted (only the same file counts as the same photo)');
  [dom,dom2,dom3].forEach(d=>d.window.close());
}

/* ─── 2. Signup (index.html) ──────────────────────────────────────────── */
async function signupPage(o={}){
  let html=read('index.html');
  html=html.replace(/<script src="(https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2|\/assets\/vendor\/supabase-[0-9.]+\.js)"><\/script>/,
    '<script>window.supabase={createClient:function(){return window.__stubSb;}};</script>');
  html=html.replace(/<script src="nv-cnic\.js\?v=[a-f0-9]+"><\/script>/,o.noHelper?'':()=>'<script>'+cnicJs.replace(/<\/script/gi,'<\\/script')+'</script>');
  const vc=new VirtualConsole();const errors=[];vc.on('jsdomError',e=>{if(!/Not implemented|navigation/i.test(e.message))errors.push(e.message);});
  const sb=stubSb(o);
  const dom=new JSDOM(html,{url:'https://novaxlogistics.com/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
    beforeParse(w){
      w.matchMedia=q=>({matches:false,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
      w.scrollTo=()=>{};w.__stubSb=sb;fakeMedia(w);
    }});
  await wait(60);
  const w=dom.window,d=w.document,$=id=>d.getElementById(id);
  const fill=()=>{const v={merchantStoreName:'Test Store',merchantName:'Test Owner',merchantPhone:'03001234567',merchantAddress:'Shop 1, Tariq Road',
      merchantProduct:'Clothing',merchantEmail:'owner@test.invalid',merchantPassword:'Kx9!mudBrick42',merchantPasswordConfirm:'Kx9!mudBrick42'};
    Object.entries(v).forEach(([k,x])=>{$(k).value=x;});$('merchantCity').value='Karachi';};
  const submit=async(ms=250)=>{$('fSignup').dispatchEvent(new w.Event('submit',{cancelable:true}));await wait(ms);};
  const tiles=()=>d.querySelectorAll('#merchantCnic input[type=file]');
  return{dom,w,d,$,sb,fill,submit,tiles,errors};
}
{
  let s=await signupPage();
  assert.equal(s.errors.length,0,'page scripts threw: '+s.errors.join(' | '));
  assert.equal(s.tiles().length,2);assert.ok(s.w.__nvSignupCnic);assert.equal(s.tiles()[0].getAttribute('accept'),'image/jpeg,image/png,image/webp');
  s.fill();await s.submit();
  assert.match(s.$('mSignup').textContent,/front and the back of your CNIC/);assert.ok(!s.sb.calls.some(c=>c[0]==='signUp'));
  ok('signup: Create is refused until both photos are added; no account made');
  const [fi,bi]=s.tiles();choose(s.w,fi,photo(s.w));choose(s.w,bi,photo(s.w));
  await s.submit(5);assert.match(s.$('mSignup').textContent,/still being prepared/);assert.ok(!s.sb.calls.some(c=>c[0]==='signUp'));
  ok('signup: waits while a photo is still being prepared');
  await wait(40);await s.submit(400);
  const order=s.sb.calls.map(c=>c[0]==='rpc'?c[1]:c[0]);
  const idx=k=>order.indexOf(k);
  assert.ok(idx('signUp')>-1&&idx('signUp')<idx('nv_signup_provision'));
  assert.ok(idx('nv_signup_provision')<idx('client_kyc_upload_check')&&idx('client_kyc_upload_check')<idx('upload'));
  assert.ok(idx('upload')<idx('client_kyc_submit'));
  const ups=s.sb.calls.filter(c=>c[0]==='upload');assert.equal(ups.length,2);ups.forEach(u=>assert.match(u[2],PATH_RE));
  const sub=s.sb.calls.find(c=>c[1]==='client_kyc_submit')[2];assert.deepEqual([sub.p_front,sub.p_back].sort(),ups.map(u=>u[2]).sort());
  assert.match(s.$('mdlSignup').textContent,/Workspace Ready/);assert.doesNotMatch(s.$('mdlSignup').textContent,/did not upload/);
  ok('signup: account -> workspace -> check -> both photos under the new workspace id -> recorded -> workspace opens');
  s.dom.window.close();

  s=await signupPage({uploadFail:true});s.fill();{const [fi,bi]=s.tiles();choose(s.w,fi,photo(s.w));choose(s.w,bi,photo(s.w));}
  await wait(40);await s.submit(400);
  assert.ok(s.sb.calls.some(c=>c[1]==='nv_signup_provision'));assert.ok(!s.sb.calls.some(c=>c[1]==='client_kyc_submit'));
  assert.match(s.$('mdlSignup').textContent,/Workspace Ready/);assert.match(s.$('mdlSignup').textContent,/did not upload/);
  ok('signup: a failed photo upload still opens the workspace and says the portal will ask again');
  s.dom.window.close();

  s=await signupPage({noHelper:true});assert.equal(s.w.__nvSignupCnic,undefined);s.fill();await s.submit(400);
  assert.ok(s.sb.calls.some(c=>c[0]==='signUp'));assert.match(s.$('mdlSignup').textContent,/Workspace Ready/);
  ok('signup: if the photo helper fails to load, signup is never blocked');
  s.dom.window.close();

  s=await signupPage({noSession:true});s.fill();{const [fi,bi]=s.tiles();choose(s.w,fi,photo(s.w));choose(s.w,bi,photo(s.w));}
  await wait(40);await s.submit(300);
  assert.ok(!s.sb.calls.some(c=>c[0]==='upload'));assert.match(s.$('mdlSignup').textContent,/Check your email/);
  ok('signup: with email confirmation on, nothing uploads without a session (portal asks later)');
  s.dom.window.close();
}

/* ─── 3. Merchant Profile panel (client.html + client-app.js) ─────────── */
const clientHtml=read('client.html'),clientJs=read('client-app.js');
function slice(src,from,to){const a=src.indexOf(from);assert.ok(a>-1,'missing '+from.slice(0,40));const b=src.indexOf(to,a);assert.ok(b>a,'missing end '+to.slice(0,40));return src.slice(a,b);}
const bannerHtml=slice(clientHtml,'<div class="nv-kyc-banner"','<div class="nv-command-strip"');
const panelHtml=slice(clientHtml,'<div class="panel mt-14" id="nvKycPanel">','<div class="panel mt-14">\n                    <div class="section-head"><div><h3>Recent changes');
const kycJs=slice(clientJs,"/* ═══ Owner's CNIC (30 Sep 2026)",'\n    function renderIntegrations(){');
async function profile(status,o={}){
  const dom=new JSDOM('<!doctype html><body><section id="client-dashboard">'+bannerHtml+'</section><section id="client-profile"><div class="nv-pf-main">'+panelHtml+'</div></section></body>',
    {runScripts:'outside-only',url:'https://novaxlogistics.com/client.html'});
  const w=dom.window;fakeMedia(w);w.eval(cnicJs);
  const sb=stubSb({rpc:{client_kyc_status:()=>({data:status,error:null}),...(o.rpc||{})},uploadFail:o.uploadFail});
  const toasts=[],tabs=[];
  w.__nvSb=sb;w.__NOVAX_DEMO=!!o.demo;w.__tabs=tabs;w.__toasts=toasts;
  w.eval('var state={identityVerified:true,activeClientTab:"profile"};function toast(m){window.__toasts.push(m);}function activeClientId(){return "'+CID+'";}function showClientTab(t){window.__tabs.push(t);}');
  w.eval(kycJs);
  w.eval('nvKycEnsure()');await wait(40);
  const $=id=>w.document.getElementById(id);
  return{dom,w,$,sb,toasts,tabs,shown:id=>!$(id).hidden};
}
{
  let p=await profile({status:'missing',is_owner:true,can_upload:true});
  assert.ok(p.shown('nvKycBanner'));assert.match(p.$('nvKycBannerT').textContent,/Add the owner's CNIC/);
  assert.equal(p.$('nvKycChip').textContent,'Not added');assert.ok(p.shown('nvKycEdit'));assert.ok(!p.shown('nvKycView'));assert.ok(p.$('nvKycSend').disabled);
  p.$('nvKycBannerGo').click();assert.deepEqual(plain(p.tabs),['profile']);
  const [fi,bi]=p.w.document.querySelectorAll('#nvKycPair input');choose(p.w,fi,photo(p.w));choose(p.w,bi,photo(p.w));await wait(40);
  assert.equal(p.$('nvKycSend').disabled,false);
  p.sb.calls.length=0;p.$('nvKycSend').click();await wait(80);
  assert.equal(p.sb.calls.filter(c=>c[0]==='upload').length,2);assert.ok(p.sb.calls.some(c=>c[1]==='client_kyc_submit'));
  assert.ok(p.sb.calls.some(c=>c[1]==='client_kyc_status'));assert.match(p.toasts.join(),/CNIC sent/);
  ok('profile: missing -> banner opens Profile -> two photos -> Send checks, uploads, records and reloads');
  p.dom.window.close();

  p=await profile({status:'submitted',is_owner:true,can_upload:true,submitted_at:'2026-09-30T10:00:00Z',front_path:CID+'/cnic-front-1727700000001-0a1b2c3d.jpg',back_path:CID+'/cnic-back-1727700000002-0a1b2c3e.jpg'});
  assert.ok(!p.shown('nvKycBanner'));assert.equal(p.$('nvKycChip').textContent,'Being checked');assert.ok(p.shown('nvKycView'));assert.ok(!p.shown('nvKycEdit'));
  assert.equal(p.$('nvKycFrontImg').src,'https://signed.test/'+CID+'/cnic-front-1727700000001-0a1b2c3d.jpg');assert.ok(p.shown('nvKycActs'));
  p.$('nvKycReplace').click();assert.ok(p.shown('nvKycEdit'));assert.ok(p.shown('nvKycCancel'));
  p.$('nvKycCancel').click();assert.ok(!p.shown('nvKycEdit'));assert.ok(p.shown('nvKycView'));
  ok('profile: under review shows both photos (signed links) and can be replaced or cancelled');
  p.dom.window.close();

  p=await profile({status:'rejected',is_owner:true,can_upload:true,reason:'Front photo is blurry',front_path:CID+'/cnic-front-1727700000001.jpg',back_path:CID+'/cnic-back-1727700000002.jpg'});
  assert.ok(p.shown('nvKycBanner'));assert.ok(p.$('nvKycBanner').classList.contains('is-bad'));assert.match(p.$('nvKycBannerB').textContent,/Front photo is blurry/);
  assert.match(p.$('nvKycMsg').textContent,/Front photo is blurry\. Add the front/);assert.ok(p.shown('nvKycEdit'));assert.equal(p.$('nvKycChip').textContent,'New photo needed');
  ok('profile: new photo asked shows the reason in the banner and panel');
  p.dom.window.close();

  p=await profile({status:'rejected',is_owner:true,can_upload:false,reason:'Front photo is blurry',upload_block:'Too many photo uploads today. Try again tomorrow, or send the photos to NovaX support on WhatsApp.'});
  assert.match(p.$('nvKycMsg').textContent,/Too many photo uploads today/);assert.ok(p.$('nvKycMsg').classList.contains('is-err'));assert.ok(!p.shown('nvKycEdit'));
  ok('profile: at the daily upload limit the merchant is told when to try again');
  p.dom.window.close();

  p=await profile({status:'verified',is_owner:true,can_upload:false,reviewed_at:'2026-09-30T12:00:00Z',front_path:CID+'/cnic-front-1727700000001.jpg',back_path:CID+'/cnic-back-1727700000002.jpg'});
  assert.ok(!p.shown('nvKycBanner'));assert.equal(p.$('nvKycChip').textContent,'Verified');assert.ok(p.shown('nvKycView'));
  assert.ok(!p.shown('nvKycActs'));assert.ok(!p.shown('nvKycEdit'));assert.match(p.$('nvKycMsg').textContent,/contact NovaX support/);
  ok('profile: verified is locked (no replace), no banner');
  p.dom.window.close();

  p=await profile({status:'missing',is_owner:false,can_upload:false});
  assert.ok(!p.shown('nvKycBanner'));assert.ok(!p.shown('nvKycEdit'));assert.ok(!p.shown('nvKycView'));assert.match(p.$('nvKycMsg').textContent,/Only the account owner/);
  assert.ok(!p.sb.calls.some(c=>c[0]==='sign'));
  ok('profile: Finance/Warehouse/Support seats see the status only, no photos, no banner');
  p.dom.window.close();

  p=await profile({status:'missing',is_owner:true,can_upload:true},{uploadFail:true});
  {const [fi,bi]=p.w.document.querySelectorAll('#nvKycPair input');choose(p.w,fi,photo(p.w));choose(p.w,bi,photo(p.w));}await wait(40);
  p.$('nvKycSend').click();await wait(80);
  assert.match(p.$('nvKycMsg').textContent,/Network request failed/);assert.ok(p.$('nvKycMsg').classList.contains('is-err'));assert.equal(p.$('nvKycSend').disabled,false);
  ok('profile: a failed send says why and can be retried');
  p.dom.window.close();

  p=await profile({status:'missing',is_owner:true,can_upload:true},{demo:true});
  p.w.eval('nvKycLoad()');await wait(20);
  assert.ok(!p.shown('nvKycBanner'));assert.ok(!p.sb.calls.some(c=>c[1]==='client_kyc_status'));
  ok('profile: the demo portal shows the panel without calling the server or nagging');
  p.dom.window.close();
}

/* ─── 4. Admin review (admin.html) ────────────────────────────────────── */
{
  const adminHtml=read('admin.html');
  const adminJs=slice(adminHtml,"    /* ═══ Owner's CNIC review (30 Sep 2026)",'    function deleteClient(clientId) {');
  const markup=slice(adminHtml,'<div class="panel" id="nvKycReviewPanel"','<div class="panel">\n                <div class="section-head"><div><h3>Client Summary</h3>');
  const dom=new JSDOM('<!doctype html><body>'+markup+'<div id="cards"></div></body>',{runScripts:'outside-only',url:'https://novaxlogistics.com/admin.html'});
  const w=dom.window,d=w.document;fakeMedia(w);w.eval(cnicJs);
  const F1=CID+'/cnic-front-1727700000001-0a1b2c3d.jpg',B1=CID+'/cnic-back-1727700000002-0a1b2c3e.jpg',F2=CID+'/cnic-front-1727700000030-0a1b2c50.jpg';
  const rows=[{client_id:CID,status:'submitted',front_path:F1,back_path:B1,submitted_at:'2026-09-30T09:00:00Z'}];
  const reviews=[],orphanCalls=[];let orphans=['00000000-0000-4000-8000-00000000dead/cnic-front-1727700000009-0a1b2c3d.jpg'];
  const sb=stubSb({rpc:{admin_kyc_list:()=>({data:rows,error:null}),
    admin_kyc_events:()=>({data:[{event:'submitted',detail:{},actor_email:null,at:'2026-09-30T09:00:00Z'}],error:null}),
    admin_kyc_review:a=>{reviews.push(a);
      if(a.p_front!==rows[0].front_path||a.p_back!==rows[0].back_path)return{data:null,error:{message:'The merchant sent new photos while you were looking. Check the new ones, then decide.'}};
      rows[0].status=a.p_decision;return{data:{ok:true,status:a.p_decision,emailed:true},error:null};},
    admin_kyc_attach:()=>({data:{ok:true,status:'submitted'},error:null}),
    admin_kyc_orphans:a=>{orphanCalls.push(a);const out=orphans.filter(n=>!a.p_client||n.startsWith(a.p_client));orphans=orphans.filter(n=>!out.includes(n));return{data:out.map(name=>({name})),error:null};}}});
  const asks=[];w.__asks=asks;w.__answers=[];
  w.__nvSb=sb;w.nvAsk=async o=>{asks.push(o);return w.__answers.shift();};
  w.eval(`var __t=[];function toast(m){__t.push(m);}
    function escLabelText(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function nvEscAttrJs(v){return String(v).replace(/[\\\\'"]/g,'\\\\$&');}
    function shortClientCode(c){return 'CL-'+String(c.id).slice(0,6).toUpperCase();}
    var state={clients:[{id:'${CID}',_uuid:'${CID}',name:'Zeesh bags',owner:'Test Owner',displayOwner:'Test Owner',phone:'03001234567',city:'Karachi',_meta:{bank:{holderName:'Test Owner'}}},
                         {id:'00000000-0000-4000-8000-000000000001',_uuid:'00000000-0000-4000-8000-000000000001',name:'Other shop',_meta:{}}]};`);
  w.eval(adminJs);
  d.getElementById('cards').innerHTML=w.eval('state.clients.map(nvKycAdminChipHtml).join("")');
  await w.eval('nvKycAdminLoad(false)');await wait(40);
  const chips=[...d.querySelectorAll('[data-kyc-chip]')].map(c=>c.textContent);
  assert.deepEqual(chips,['CNIC: to review','CNIC: not added']);
  assert.match(d.getElementById('nvKycReviewCount').textContent,/1 to review/);assert.match(d.getElementById('nvKycReviewList').textContent,/Zeesh bags/);
  assert.match(d.getElementById('nvKycReviewList').textContent,/1 not added yet/);
  ok('admin: chips and the review list come from admin_kyc_list');
  assert.equal(orphanCalls.length,2);assert.equal(orphanCalls[0].p_client,null);   // one round removes, the next finds nothing
  assert.deepEqual(plain(removed(sb)),['00000000-0000-4000-8000-00000000dead/cnic-front-1727700000009-0a1b2c3d.jpg']);
  await w.eval('nvKycAdminLoad(true)');await wait(20);assert.equal(orphanCalls.length,2);
  ok('admin: leftovers are cleared once per page load, through the storage API');
  orphans=[CID+'/a.jpg',CID+'/b.jpg','11111111-1111-4111-8111-111111111111/c.jpg'];sb.calls.length=0;
  const n=await w.eval(`nvKycAdminSweep('${CID}')`);assert.equal(n,2);assert.deepEqual(plain(removed(sb)),[CID+'/a.jpg',CID+'/b.jpg']);
  ok('admin: after a client is deleted, all of that account\'s files are removed (and only those)');

  w.eval(`nvKycOpen('${CID}')`);await wait(60);
  let box=d.querySelector('.nvkyc');assert.ok(box);
  assert.equal(box.querySelector('[data-box="front"] img').src,'https://signed.test/'+F1);
  assert.ok(box.querySelector('[data-act="verify"]').disabled);assert.ok(box.querySelector('[data-act="reject"]').disabled);
  box.querySelector('[data-box="front"] img').dispatchEvent(new w.Event('load'));
  assert.ok(box.querySelector('[data-act="verify"]').disabled);
  box.querySelector('[data-box="back"] img').dispatchEvent(new w.Event('load'));
  assert.equal(box.querySelector('[data-act="verify"]').disabled,false);
  ok('admin: Verify and Ask stay off until both photos are actually on screen');
  assert.match(box.textContent,/Bank account holder/);assert.match(box.textContent,/Sent by the merchant/);
  box.querySelector('[data-rot="front"]').click();assert.match(box.querySelector('[data-box="front"] img').style.transform,/rotate\(90deg\)/);
  ok('admin: review screen shows owner vs bank name and history; rotate works');
  const loadBoth=()=>d.querySelectorAll('.nvkyc [data-box] img').forEach(i=>i.dispatchEvent(new w.Event('load')));
  w.__answers.push({reason:'Other (write it below)',note:''});box.querySelector('[data-act="reject"]').click();await wait(30);
  assert.match(box.querySelector('[data-err]').textContent,/Write what is wrong/);assert.equal(reviews.length,0);
  w.__answers.push({reason:'Photo is blurry',note:'Retake the front in daylight'});d.querySelector('.nvkyc [data-act="reject"]').click();await wait(80);
  assert.deepEqual(plain(reviews[0]),{p_client:CID,p_decision:'rejected',p_reason:'Photo is blurry. Retake the front in daylight',p_name:null,p_front:F1,p_back:B1});
  ok('admin: ask for a new photo needs a reason and names the photos on screen');
  loadBoth();
  // the merchant sends a new front while this screen still shows the old one
  rows[0]={...rows[0],status:'submitted',front_path:F2};
  w.__answers.push({name:'Test Owner'});d.querySelector('.nvkyc [data-act="verify"]').click();await wait(100);
  assert.equal(reviews[1].p_front,F1);assert.equal(rows[0].status,'submitted');
  box=d.querySelector('.nvkyc');assert.match(box.querySelector('[data-err]').textContent,/sent new photos/);
  assert.equal(box.querySelector('[data-box="front"] img').src,'https://signed.test/'+F2);assert.ok(box.querySelector('[data-act="verify"]').disabled);
  ok('admin: photos replaced while the screen was open cannot be verified unseen; the new ones are shown instead');
  loadBoth();
  w.__answers.push({name:'Test Owner'});d.querySelector('.nvkyc [data-act="verify"]').click();await wait(100);
  assert.deepEqual(plain(reviews[2]),{p_client:CID,p_decision:'verified',p_reason:null,p_name:'Test Owner',p_front:F2,p_back:B1});
  assert.ok(!d.querySelector('.nvkyc [data-act="verify"]'));assert.match(d.querySelector('.nvkyc [data-act="reject"]').textContent,/Unlock/);
  ok('admin: verify sends the name and the photos seen; afterwards only Unlock is offered');
  loadBoth();w.__answers.push(null);d.querySelector('.nvkyc [data-act="reject"]').click();await wait(30);assert.equal(reviews.length,3);
  ok('admin: cancelling a prompt changes nothing');
  d.querySelector('.nvkyc [data-act="upload"]').click();const up=d.querySelector('.nvkyc [data-up]');assert.equal(up.hidden,false);
  const save=d.querySelector('.nvkyc [data-act="upsave"]');assert.ok(save.disabled);
  const [fi,bi]=d.querySelectorAll('.nvkyc [data-pair] input');choose(w,fi,photo(w));choose(w,bi,photo(w));await wait(40);
  assert.equal(save.disabled,false);sb.calls.length=0;save.click();await wait(80);
  assert.equal(sb.calls.filter(c=>c[0]==='upload').length,2);
  const at=sb.calls.find(c=>c[1]==='admin_kyc_attach');assert.equal(at[2].p_client,CID);assert.match(at[2].p_front,PATH_RE);
  ok('admin: upload for the merchant (WhatsApp photos) goes to their folder and admin_kyc_attach');
  d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));await wait();assert.equal(d.querySelector('.nvkyc'),null);
  ok('admin: Escape closes the review screen');
  dom.window.close();
}

console.log('PASS CNIC: '+passed.length+' checks\n  - '+passed.join('\n  - '));
