import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../client-app.js', import.meta.url), 'utf8');
const save = source.slice(source.indexOf('var emailQuery='), source.indexOf('\n        }catch(e){}', source.indexOf('var emailQuery=')));
const start = source.indexOf('// Keep only known email destinations');
const restore = source.slice(start, source.indexOf('\n        /* Deep links', start));
const values = new Map();
const context = {
  URLSearchParams, Date, Number, JSON,
  sessionStorage: { setItem: (k, v) => values.set(k, v), getItem: k => values.get(k) || null, removeItem: k => values.delete(k) },
  location: { search: '?tab=awbLabel&awb=nv-123', hash: '' }
};
vm.runInNewContext(save, context);
context.location.search = '';
context.qp = new URLSearchParams();
vm.runInNewContext(restore, context);
assert.equal(context.qp.get('tab'), 'awbLabel');
assert.equal(context.qp.get('awb'), 'NV-123');
assert.equal(values.size, 0);
for (const tab of ['money', 'support', 'profile', 'newBooking']) {
  context.location.search = `?tab=${tab}`;
  vm.runInNewContext(save, context);
  context.location.search = '';
  context.qp = new URLSearchParams();
  vm.runInNewContext(restore, context);
  assert.equal(context.qp.get('tab'), tab);
}
for (const payload of [
  { tab: 'https://evil.example', at: Date.now() },
  { tab: 'money', at: Date.now() - 900001 },
  { tab: 'money', at: Date.now() + 60000 }
]) {
  values.set('novaxEmailDestination', JSON.stringify(payload));
  context.qp = new URLSearchParams();
  vm.runInNewContext(restore, context);
  assert.equal(context.qp.get('tab'), null);
}
context.location.search = '?tab=money';
context.qp = new URLSearchParams(context.location.search);
values.set('novaxEmailDestination', JSON.stringify({ tab: 'support', at: Date.now() }));
vm.runInNewContext(restore, context);
assert.equal(context.qp.get('tab'), 'money');
console.log('PASS: email links survive sign-in, expire, reject unknown destinations and preserve explicit routes.');
