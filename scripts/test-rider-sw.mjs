import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const base='https://fixture.invalid',handlers={},store=new Map(),cache={
  async add(url){store.set(new URL(url,base).href,new Response(url==='/rider.html'?readFileSync(new URL('../rider.html',import.meta.url),'utf8'):url==='/client.html'?'<script src="client-app.js?v=fixture"></script>':'asset'));},
  async match(url){return store.get(new URL(typeof url==='string'?url:url.url,base).href)?.clone();},
  async put(req,res){store.set(req.url,res);}
};
const deleted=[],caches={open:async()=>cache,match:url=>cache.match(url),keys:async()=>['novax-v92','novax-v93'],delete:async k=>{deleted.push(k);}};
let offline=true;
const context={URL,Response,Promise,caches,fetch:async()=>{if(offline)throw Error('offline');return new Response('network HTML');},self:{location:{origin:base},skipWaiting(){},clients:{claim:async()=>{}},registration:{unregister:async()=>{}},addEventListener:(name,fn)=>{handlers[name]=fn;}}};
vm.runInNewContext(readFileSync(new URL('../sw.js',import.meta.url),'utf8'),context);
let pending;handlers.install({waitUntil:p=>{pending=p;}});await pending;
const shell=readFileSync(new URL('../rider.html',import.meta.url),'utf8');
const assets=[...shell.matchAll(/<script[^>]+src="([^"]+)"/g),...shell.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"/g)].map(m=>m[1]);
for(const file of assets)assert.ok(await cache.match(file),file+' precached');
async function request(path,method='GET',accept='text/html'){
  let response;handlers.fetch({request:new Request(new URL(path,base),{method,headers:{accept}}),respondWith:p=>{response=p;}});return response?await response:null;
}
assert.match(await(await request('/rider.html?reload=1')).text(),/NovaX \| Rider/);
assert.match(await(await request('/client.html?reload=1')).text(),/client-app/);
assert.equal((await request('/tracking.html?uncached=1')).status,503);
assert.equal(await request('https://api.example.com/data'),null);
assert.equal(await request('/rider.html','POST'),null);
offline=false;assert.equal(await(await request('/rider.html?fresh=1')).text(),'network HTML');
handlers.activate({waitUntil:p=>{pending=p;}});await pending;assert.deepEqual(deleted,['novax-v92']);
console.log('PASS rider service worker: coherent HTML/JS/CSS precache, role-correct offline fallbacks, unknown-page 503, external/POST bypass, network-first HTML and cache version cleanup.');
