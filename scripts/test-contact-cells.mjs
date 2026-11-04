// 4 Nov 2026: a parcel from the portal's saved copy (_partial: no customer
// names, phones or addresses are ever saved in the browser) must never be shown
// as "Not provided". KKM's shipper was told N8530348 had no address while the
// server had it. The cells say Loading and the drawer fetches the row.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(new URL('../client-app.js', import.meta.url), 'utf8');
const grab = name => { const i = src.indexOf('    function ' + name + '('); assert.ok(i > -1, name + ' exists'); const j = src.indexOf('\n    }\n', i); return src.slice(i, j + 6); };
const ctx = { escLabelText: s => String(s) };
vm.createContext(ctx);
vm.runInContext(grab('nvContactMissing') + grab('nvContactCell'), ctx);
const cell = (p, k, none) => vm.runInContext('nvContactCell(p,k,none)', Object.assign(ctx, { p, k, none }));
assert.match(cell({ awb: 'N1', _partial: true, consignee: '', phone: '', address: '' }, 'address', 'Not provided'), /Loading/);
assert.match(cell({ awb: 'N1', consignee: '', phone: '', address: '' }, 'phone', 'Not provided'), /Loading/, 'all three empty is a missing copy, not a fact');
assert.equal(cell({ awb: 'N1', consignee: 'Aqeela', phone: '0300', address: '' }, 'address', 'Not provided'), 'Not provided', 'a full row may truly lack an address');
assert.equal(cell({ awb: 'N1', consignee: 'Aqeela', phone: '0300', address: 'Islam nagar' }, 'address', 'Not provided'), 'Islam nagar');
assert.match(cell({ awb: 'N1', _partial: true, __nvContactErr: "Sign in again to see the customer's details." }, 'phone', 'Not provided'), /Sign in again/);
// the drawer uses the cells and hydrates on open
assert.ok(/'<dt>Address<\/dt><dd>'\+nvContactCell\(p,"address"/.test(src), 'drawer address goes through nvContactCell');
assert.ok(/if\(nvContactMissing\(p\)\) nvHydrateContact\(p,/.test(src), 'opening a partial parcel fetches its contact row');
assert.ok(!/escLabelText\(p\.address\|\|"Not provided"\)/.test(src), 'no raw "Not provided" fallback left in the drawer');
console.log('PASS: saved-copy parcels show Loading, then the server row; never a false "Not provided".');
