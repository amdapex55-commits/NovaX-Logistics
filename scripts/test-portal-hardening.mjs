// Portal fixes from the 38-point review (1 Oct 2026): bulk weights and payment
// modes, the IBAN check, booking problems that clear, pickup windows, the seat
// role default, the printed badge and the device cache.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const app = readFileSync(new URL('../client-app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../client.html', import.meta.url), 'utf8');
const passed = [];
const ok = m => passed.push(m);
// Any `function NAME(` in the bundle, brace-matched.
function fn(name) {
  const re = new RegExp('function ' + name + '\\(');
  const m = re.exec(app); assert.ok(m, 'missing fn ' + name);
  let i = app.indexOf('{', m.index), d = 0;
  for (; i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}') { d--; if (!d) break; } }
  return app.slice(m.index, i + 1);
}
function page(body = '') {
  const dom = new JSDOM('<!doctype html><body>' + body + '</body>', { runScripts: 'outside-only', url: 'https://novaxlogistics.com/client.html' });
  dom.window.eval('var state={ parcels:[], client:{ id:"c1" } }; var __toasts=[]; function toast(m){ __toasts.push(m); } function escLabelText(v){ return String(v==null?"":v).replace(/[&<>"]/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"}[c]; }); }');
  return dom;
}

/* ─── bulk weights: read the whole value or refuse it ─────────────────── */
{
  const w = page().window; w.eval(fn('nvBulkWeightKg'));
  const kg = v => { const r = w.eval('nvBulkWeightKg(' + JSON.stringify(v) + ')'); return r.error ? 'ERR' : r.kg; };
  const cases = { '0,5': 0.5, '1,5 kg': 1.5, '1 500 g': 1.5, '1.5': 1.5, '01.50': 1.5, ' 2 kg ': 2, '500g': 0.5, '500 grams': 0.5,
    '1,500 g': 1.5, '2 KG': 2, '70': 70, '1,500 kg': 'ERR', '1.5.2': 'ERR', '1,5,5': 'ERR', 'abc': 'ERR', '': 'ERR', '1..5': 'ERR', '1 5 kg': 'ERR' };
  for (const [v, want] of Object.entries(cases)) assert.equal(kg(v), want, v);
  ok('bulk weights: 1,5 kg = 1.5, 1 500 g = 1.5 kg, 01.50 = 1.5; 1,500 kg, 1.5.2 and text are refused, never truncated');
}

/* ─── IBAN: Pakistani shape plus check digits ─────────────────────────── */
{
  const w = page().window; w.eval(fn('nvIbanChecksumOk') + fn('validateIbanValue'));
  const v = s => w.eval('validateIbanValue(' + JSON.stringify(s) + ')');
  assert.equal(v('PK36SCBL0000001123456702'), '');
  assert.equal(v('pk36 scbl 0000 0011 2345 6702'), '');
  assert.equal(v('PK40MEZN0000001123456702'), '');
  assert.match(v('PK37SCBL0000001123456702'), /typo/);
  assert.match(v('PK12-INVALID-$$$$'), /24 letters and numbers/);
  assert.match(v('PK36SCBL00000011234567'), /24 letters and numbers/);
  assert.match(v('GB82WEST12345698765432'), /start with PK/);
  assert.match(v(''), /required/);
  ok('IBAN: 24 characters with valid check digits; PK12-INVALID-$$$$ and a one-digit typo are refused');
}

/* ─── booking: problems are named, marked on the field, and clear ─────── */
{
  const form = '<section id="client-newBooking"><div id="nvRiskWarning" style="display:none"></div>' +
    '<input id="bookingName"><input id="bookingPhone"><input id="bookingAddress"><input id="bookingCod">' +
    '<input id="bookingCity" value="Karachi"><input id="bookingCategory" value="Hoodie"><input id="bookingWeight" value="1 kg"></section>';
  const dom = page(form), w = dom.window;
  w.eval([fn('nvNormalizePkPhone'), fn('nvNormalizeWeightCommas'), fn('nvWeightProblem'), 'function nvFindCity(c){ return /karachi|lahore/i.test(c); }',
    fn('checkBookingRisk'), fn('nvBookingRiskInput'), fn('nvMarkBookingField'), fn('nvShowBookingProblem'), fn('nvRecheckBookingProblem')].join('\n'));
  const risk = o => JSON.parse(w.eval('JSON.stringify(checkBookingRisk(' + JSON.stringify(o) + '))'));
  const base = { phone: '03113323923', address: 'House 22, Street 4, DHA', cod: '2500', city: 'Karachi', product: 'Hoodie', weight: '1 kg', consignee: 'Ali Khan' };
  assert.deepEqual(risk(base).serious, []);
  assert.deepEqual(risk({ ...base, consignee: 'a' }).seriousFields, ['bookingName']);
  assert.deepEqual(risk({ ...base, consignee: '12' }).seriousFields, ['bookingName']);
  assert.deepEqual(risk({ ...base, consignee: 'علی' }).serious, []);
  assert.deepEqual(risk({ ...base, address: 'DHA' }).seriousFields, ['bookingAddress']);
  assert.deepEqual(risk({ ...base, address: 'مکان 22، گلی 4' }).serious, []);
  assert.deepEqual(risk({ ...base, phone: '0311' }).seriousFields, ['bookingPhone']);
  assert.deepEqual(risk({ ...base, cod: '250000' }).seriousFields, ['bookingCod']);
  assert.deepEqual(risk({ ...base, cod: '120000' }).serious, [], 'between 50k and 200k the merchant confirms instead');

  const $ = id => w.document.getElementById(id);
  const set = (id, v) => { $(id).value = v; };
  set('bookingName', 'Ali Khan'); set('bookingPhone', '0311'); set('bookingAddress', 'House 22, Street 4, DHA'); set('bookingCod', '2500');
  w.eval('nvShowBookingProblem("Phone number looks incomplete. Use 03XXXXXXXXX.","bookingPhone")');
  assert.equal($('nvRiskWarning').style.display, 'block');
  assert.equal($('bookingPhone').getAttribute('aria-invalid'), 'true');
  assert.equal($('bookingPhone').getAttribute('aria-describedby'), 'nvRiskWarning');
  assert.equal($('nvRiskWarning').getAttribute('role'), 'alert');
  set('bookingPhone', '03113323923'); w.eval('nvRecheckBookingProblem()');
  assert.equal($('nvRiskWarning').style.display, 'none', 'the banner goes once the phone is right');
  assert.equal($('bookingPhone').getAttribute('aria-invalid'), null);
  assert.equal($('bookingPhone').getAttribute('aria-describedby'), null);
  set('bookingPhone', '0311'); w.eval('nvShowBookingProblem("Phone number looks incomplete. Use 03XXXXXXXXX.","bookingPhone")');
  set('bookingPhone', '03113323923'); set('bookingAddress', 'DHA'); w.eval('nvRecheckBookingProblem()');
  assert.match($('nvRiskWarning').textContent, /full delivery address/, 'fixing one problem shows the next');
  assert.equal($('bookingAddress').getAttribute('aria-invalid'), 'true');
  assert.equal($('bookingPhone').getAttribute('aria-invalid'), null);
  ok('booking: name, address, phone and COD problems name their field, set aria-invalid, and clear as soon as they are fixed');
}

/* ─── pickup: day and window, never a past or out-of-hours time ───────── */
{
  const dom = page('<select id="pickupDay"></select><select id="pickupSlot"></select><input type="hidden" id="pickupRequestedFor">' +
    '<div id="pickupEligibleList"></div><button id="requestPickupBtn">Request Pickup</button><span id="pickupBtnHint"></span>');
  const w = dom.window;
  w.eval('var NV_PK_SLOTS;' + app.match(/var NV_PK_SLOTS=[^\n]+/)[0] + fn('nvPkDays') + fn('nvPkSync') + fn('nvPkButtonState') + 'function requestPickup(){}');
  const at = (y, m, d, h) => w.eval(`function nvPkNow(){ return { y:${y}, m:${m}, d:${d}, h:${h} }; }`);
  const $ = id => w.document.getElementById(id);
  at(2026, 10, 1, 14.0); w.eval("nvPkSync()");
  const opts = () => [...$('pickupSlot').options].map(o => (o.disabled ? 'x ' : '') + o.textContent);
  assert.match($('pickupDay').options[0].textContent, /^Today, Thu 1 Oct/);
  assert.equal($('pickupDay').options.length, 7);
  assert.deepEqual(opts().slice(0, 2), ['x 11 am – 1 pm (passed)', '1 – 3 pm']);
  assert.equal($('pickupRequestedFor').value, 'Thu 1 Oct, 1 – 3 pm (PKT)');
  $('pickupDay').value = $('pickupDay').options[1].value; w.eval('nvPkSync()');
  assert.ok(opts().every(o => !o.startsWith('x ')), 'tomorrow has every window');
  assert.equal($('pickupRequestedFor').value, 'Fri 2 Oct, 1 – 3 pm (PKT)');
  at(2026, 10, 1, 20.75); $('pickupDay').value = ''; w.eval('nvPkSync()');
  assert.match($('pickupDay').options[0].textContent, /^Tomorrow, Fri 2 Oct/, 'after the last window, today is gone');

  w.eval('nvPkButtonState()');
  assert.equal($('requestPickupBtn').disabled, true);
  assert.match($('pickupBtnHint').textContent, /Book a parcel first/);
  $('pickupEligibleList').innerHTML = '<input type="checkbox" class="pickup-check" value="N1">';
  w.eval('nvPkButtonState()');
  assert.equal($('requestPickupBtn').disabled, true); assert.match($('pickupBtnHint').textContent, /Tick the parcels/);
  w.document.querySelector('.pickup-check').checked = true; w.eval('nvPkButtonState()');
  assert.equal($('requestPickupBtn').disabled, false); assert.equal($('pickupBtnHint').textContent, '');
  ok('pickup: two-hour windows 11 am-9 pm in PKT, passed windows and a finished today cannot be picked; the button needs a ticked parcel');
}

/* ─── seat role while the lookup is pending ──────────────────────────── */
{
  const w = page().window;
  w.eval('var NOVAX_ROLE_TABS={ Owner:[], Finance:[], Warehouse:[], Support:[] };' + fn('nvClientRole'));
  const role = (session, resolved) => w.eval(`window.__novaxGateSession=${JSON.stringify(session)}; window.__novaxClientRole=${JSON.stringify(resolved)}; nvClientRole()`);
  assert.equal(role({ user: { user_metadata: {} } }, undefined), 'Owner', 'the account holder is never locked out');
  assert.equal(role(null, undefined), 'Owner');
  assert.equal(role({ user: { user_metadata: { created_by_owner: 'owner-uid' } } }, undefined), 'Support', 'a team login waits as the most limited seat');
  assert.equal(role({ user: { user_metadata: { created_by_owner: 'owner-uid' } } }, 'Owner'), 'Owner', 'its real role wins once read');
  assert.equal(role({ user: { user_metadata: { created_by_owner: 'owner-uid' } } }, 'Finance'), 'Finance');
  ok('roles: the account holder defaults to Owner; a team login waits as Support until its seat row is read');
}

/* ─── printed badge, device cache, page markup ───────────────────────── */
{
  const w = page().window;
  w.eval(fn('nvNiceDate').replace(/var one=nvDateTime\(v\);[^\n]*\n/, '') + fn('awbCompleteBadge'));
  const old = w.eval('awbCompleteBadge({ awbPrinted:true, awbPrintedAt:"2026-09-12 18:40", status:"Delivered" })');
  assert.match(old, /AWB printed · now Delivered · printed 12 Sept? 2026, 18:40 PKT/);
  assert.doesNotMatch(old, /booking complete/);
  assert.match(w.eval('awbCompleteBadge({ awbPrinted:true, awbPrintedAt:"2026-10-01 11:05", status:"New booked" })'), /ready for pickup/);
  assert.match(w.eval('awbCompleteBadge({ awbPrinted:false })'), /not printed yet/);

  assert.match(app, /const NOVAX_PARCEL_PII_KEYS = \["phone","address","trackingToken","_raw","consignee"\];/);
  const lw = page().window;
  lw.eval('var STORAGE_KEY="k"; var baseState={ parcels:[] }; function nvClone(o){ return JSON.parse(JSON.stringify(o)); }' + fn('loadState'));
  lw.localStorage.setItem('k', JSON.stringify({ parcels: [{ awb: 'N1' }], invoices: [{}], theme: 'dark', _savedAt: Date.now() - 8 * 864e5 }));
  assert.deepEqual(JSON.parse(lw.eval('JSON.stringify(loadState())')), { parcels: [], invoices: [], theme: 'dark', _savedAt: JSON.parse(lw.localStorage.getItem('k'))._savedAt });
  lw.localStorage.setItem('k', JSON.stringify({ parcels: [{ awb: 'N1' }], _savedAt: Date.now() }));
  assert.equal(lw.eval('loadState().parcels.length'), 1);

  for (const page of ['client.html', 'admin.html', 'rider.html']) {
    const src = readFileSync(new URL('../' + page, import.meta.url), 'utf8');
    const head = src.slice(0, src.indexOf('</head>'));
    assert.match(head, /if\(window\.top!==window\.self\)\{document\.documentElement\.style\.display="none"/, page + ' framing guard');
  }
  assert.match(app, /id="nvInvitePass" type="password" autocomplete="new-password"/);
  assert.match(html, /<input id="webKey" type="password"/);
  assert.match(html, /<label for="bulkCsvInput">/);
  assert.match(html, /<b>payment_mode<\/b>: COD or Prepaid/);
  assert.match(html, /<div class="panel mt-14" hidden aria-hidden="true">\s*<div class="section-head"><div><h3>Withdraw Funds/);
  assert.match(html, /#nvdrawer\[hidden\]\{display:none!important;\}/);
  assert.match(app, /Live \$\{time\(\)\} PKT/);
  assert.match(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), /fetch\(req, \{ cache: "no-cache" \}\)/);
  ok('badge dates old prints and names their status; the device copy keeps no customer names and expires in a week; guards and labels are in the pages');
}

/* ─── reattempt: once per parcel (3 Oct 2026) ─────────────────────────── */
{
  const w = page().window;
  w.eval('var __rpc=[], __next=null; function nvBusy(){ return function(){}; } function saveState(){} function render(){} function nvOpsRequestTicket(){ return Promise.resolve(); }' +
    'window.__nvSb={ rpc:function(n,a){ __rpc.push(n+":"+a.p_awb); var r=__next||{ data:{ ok:true } }; __next=null; return Promise.resolve(r); } };');
  w.eval(fn('nvReattemptUsed') + fn('nvReattemptDoneMsg') + fn('requestRedelivery'));
  w.eval('state.parcels=[' +
    '{ awb:"A1", status:"Consignee not available", steps:["New booked","Parcel out for delivery","Consignee not available"], _meta:{} },' +
    '{ awb:"A2", status:"Refused", steps:["New booked","Parcel out for delivery","Reattempt","Refused"], _meta:{} },' +
    '{ awb:"A3", status:"Reattempt", steps:["New booked","Parcel out for delivery","Reattempt"], _meta:{} },' +
    '{ awb:"A4", status:"Refused", steps:["New booked","Refused"], _meta:{} }]');
  const used = a => w.eval('nvReattemptUsed(' + JSON.stringify(a) + ')');
  assert.equal(used('A1'), ''); assert.equal(used('A2'), 'used'); assert.equal(used('A3'), '', 'a parcel waiting at Reattempt may be confirmed once');
  const req = a => w.eval('requestRedelivery(' + JSON.stringify(a) + ').then(function(){ return "ok"; }, function(e){ return "refused: " + e.message; })');
  assert.equal(await req('A1'), 'ok');
  assert.equal(used('A1'), 'requested', 'the request is remembered on the parcel');
  assert.match(await req('A1'), /^refused: A1: a reattempt is already requested/);
  assert.match(await req('A2'), /^refused: A2 has already had its one reattempt/);
  w.eval('__next={ data:{ ok:false, reason:"already_requested", at:"2026-10-03T08:00:00Z" } }');
  assert.match(await req('A4'), /already requested/, 'the server refusing a repeat is shown, not reported as sent');
  assert.equal(used('A4'), 'requested');
  assert.equal(w.eval('__rpc.join(",")'), 'ai_action_request_reattempt:A1,ai_action_request_reattempt:A4', 'refused locally without calling the server');
  ok('reattempt: one request per parcel; none after a used reattempt; a server refusal is shown and remembered');
}

console.log('PASS portal hardening: ' + passed.length + ' checks\n  - ' + passed.join('\n  - '));
