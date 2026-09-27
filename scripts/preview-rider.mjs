import http from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {installFixture} from './rider-fixture.mjs';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ico':'image/x-icon'};
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/assets/vendor/supabase-2.117.2.js'){
    res.setHeader('Content-Type','text/javascript');res.end(`(${installFixture.toString()})(window,{long:true,conflict:true});`);return;
  }
  const file=path.resolve(root,'.'+(url.pathname==='/'?'/rider.html':url.pathname));
  if(!file.startsWith(root+path.sep)||!existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',types[path.extname(file)]||'text/plain');res.setHeader('Cache-Control','no-store');res.end(readFileSync(file));
}).listen(8766,'127.0.0.1',()=>console.log('Rider isolated preview: http://127.0.0.1:8766/rider.html?nosw=1'));
