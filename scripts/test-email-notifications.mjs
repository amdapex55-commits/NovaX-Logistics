import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildEmail } from '../supabase/functions/novax-email-drain/templates.ts';
import { createHandler } from '../supabase/functions/novax-email-drain/worker.ts';

const fixtures = {
  welcome: { name: 'Aisha', business: 'Sample Store' },
  first_booking: { business: 'Sample Store', awb: 'NVX-100001', booked_at: '2026-09-27T11:00:00Z' },
  payout_paid: { business: 'Sample Store', amount: '10500', fee: '500', net: '10000',
    reference: 'DEMO-TRANSFER-001', paid_at: '2026-09-27T11:00:00Z' },
  cnic_verified: { business: 'Sample Store' },
  cnic_rejected: { business: 'Sample Store', reason: 'Front photo is blurry' },
  first_parcel_d1: { name: 'Aisha', business: 'Sample Store', token: '8f14e45f-ceea-4e7a-9c1b-2f6d8a0b3c11', step: 1 },
  first_parcel_d3: { name: 'Aisha', business: 'Sample Store', token: '8f14e45f-ceea-4e7a-9c1b-2f6d8a0b3c11', step: 3 },
  first_parcel_d7: { name: 'Aisha', business: 'Sample Store', token: '8f14e45f-ceea-4e7a-9c1b-2f6d8a0b3c11', step: 7 },
  back_quiet: { name: 'Aisha', business: 'Sample Store', token: '8f14e45f-ceea-4e7a-9c1b-2f6d8a0b3c11', parcels: 12, last: '2026-08-30T09:00:00Z', wallet: 2845.5 },
  back_tried: { name: '', business: 'Sample Store', token: '8f14e45f-ceea-4e7a-9c1b-2f6d8a0b3c11', parcels: 1, last: '2026-08-02T21:30:00Z', wallet: 0 },
  setup_ready: { name: 'Aisha', business: 'Sample Store', token: '8f14e45f-ceea-4e7a-9c1b-2f6d8a0b3c11' },
};
const NUDGE_KINDS = ['back_quiet', 'back_tried', 'setup_ready'];
const REMINDER_KINDS = ['first_parcel_d1', 'first_parcel_d3', 'first_parcel_d7'];
for (const [kind, data] of Object.entries(fixtures)) {
  const message = buildEmail(kind, 'owner@example.com', data);
  assert.ok(message.html.includes('name="viewport"'));
  assert.ok(message.text.includes('https://novaxlogistics.com/client.html'));
  assert.deepEqual(message.to, ['owner@example.com']);
  assert.ok(message.from.endsWith('<updates@auth.novaxlogistics.com>'));
}
assert.ok(buildEmail('payout_paid', 'owner@example.com', fixtures.payout_paid).subject.includes('10,000.00'));
assert.ok(buildEmail('payout_paid', 'owner@example.com', fixtures.payout_paid).html.includes('href="https://novaxlogistics.com/client.html?tab=money"'));
assert.ok(buildEmail('first_booking', 'owner@example.com', fixtures.first_booking).html.includes('href="https://novaxlogistics.com/client.html?tab=awbLabel&amp;awb=NVX-100001"'));
assert.ok(buildEmail('welcome', 'owner@example.com', fixtures.welcome).html.includes('href="https://novaxlogistics.com/client.html?tab=support"'));
assert.ok(buildEmail('payout_paid', 'owner@example.com', fixtures.payout_paid).text.includes('04:00 pm PKT'));
for (const kind of ['cnic_verified', 'cnic_rejected']) {
  const m = buildEmail(kind, 'owner@example.com', fixtures[kind]);
  assert.ok(m.html.includes('href="https://novaxlogistics.com/client.html?tab=profile"'));
  assert.ok(m.text.includes('Sample Store'));
}
assert.ok(buildEmail('cnic_rejected', 'owner@example.com', fixtures.cnic_rejected).html.includes('Front photo is blurry'));
assert.throws(() => buildEmail('cnic_rejected', 'owner@example.com', { business: 'Sample Store' }), /missing_reason/);
assert.ok(!buildEmail('cnic_rejected', 'owner@example.com', { business: 'S', reason: '<img src=x onerror=alert(1)>' }).html.includes('<img src=x'));
const welcome = buildEmail('welcome', 'owner@example.com', fixtures.welcome);
for (const feature of ['bulk bookings', 'parcel statuses', 'request payouts', 'Connect Shopify']) {
  assert.ok(welcome.html.includes(feature));
  assert.ok(welcome.text.includes(feature));
}
for (const [kind, data] of Object.entries(fixtures)) {
  const message = buildEmail(kind, 'owner@example.com', data);
  assert.ok(Buffer.byteLength(message.html) < 50000);
  for (const link of message.html.matchAll(/href="([^"]+)"/g)) {
    const url = new URL(link[1].replaceAll('&amp;', '&'));
    // The day-7 reminder's button opens NovaX's own WhatsApp support number, nothing else.
    if ((kind === 'first_parcel_d7' || NUDGE_KINDS.includes(kind)) && url.origin === 'https://wa.me') {
      assert.equal(url.pathname, '/923123922558');
      continue;
    }
    assert.equal(url.origin, 'https://novaxlogistics.com');
  }
}
const hostile = buildEmail('welcome', 'owner@example.com', { name: '<script>alert(1)</script>', business: 'A & B' });
assert.ok(!hostile.html.includes('<script>'));
assert.ok(hostile.html.includes('&lt;script&gt;'));
assert.ok(hostile.html.includes('A &amp; B'));
for (const recipient of ['', 'two@example.com,other@example.com', 'a@example.com\r\nBcc:b@example.com']) {
  assert.throws(() => buildEmail('welcome', recipient, fixtures.welcome));
}
for (const net of [null, '', -1, 'NaN']) {
  assert.throws(() => buildEmail('payout_paid', 'a@example.com', { ...fixtures.payout_paid, net }));
}
assert.throws(() => buildEmail('payout_paid', 'a@example.com', { ...fixtures.payout_paid, net: 10500 }));
assert.throws(() => buildEmail('payout_paid', 'a@example.com', { ...fixtures.payout_paid, reference: '' }));
assert.throws(() => buildEmail('first_booking', 'a@example.com', { ...fixtures.first_booking, booked_at: '' }));
assert.throws(() => buildEmail('untrusted', 'a@example.com', {}));

// First-parcel reminders.
const PRICE = 'Rs 225 for the first kg to a Karachi address, Rs 250 to Lahore, Islamabad or Rawalpindi, plus Rs 85 per additional kg.';
const STOP = 'https://novaxlogistics.com/unsubscribe.html?t=8f14e45f-ceea-4e7a-9c1b-2f6d8a0b3c11';
const reminders = Object.fromEntries(REMINDER_KINDS.map(kind => [kind, buildEmail(kind, 'owner@example.com', fixtures[kind])]));
for (const [kind, m] of Object.entries(reminders)) {
  assert.ok(m.html.includes(`href="${STOP}"`), kind + ' stop link');
  assert.ok(m.html.includes('Stop these reminders'));
  assert.ok(m.html.includes('three of these at most'));
  assert.ok(m.text.includes(STOP));
  assert.deepEqual(m.headers, { 'List-Unsubscribe': `<${STOP}>` });
  assert.ok(m.html.includes('Hi Aisha, '));
  assert.ok(!m.html.includes('Automated account notification'));
  assert.equal(m.tags[0].value, kind);
  assert.ok(m.html.includes('href="https://novaxlogistics.com/client.html?tab=newBooking"'), kind + ' books');
  for (const bad of ['undefined', 'null', 'NaN', '[object']) assert.ok(!m.text.includes(bad), kind + ' ' + bad);
  for (const token of [undefined, '', 'not-a-token', '8f14e45f-ceea-4e7a-9c1b-2f6d8a0b3c1', '"><script>']) {
    assert.throws(() => buildEmail(kind, 'owner@example.com', { ...fixtures[kind], token }), /missing_token/);
  }
  const anonymous = buildEmail(kind, 'owner@example.com', { ...fixtures[kind], name: '' });
  assert.ok(anonymous.html.includes('Hi there, '));
  const hostileReminder = buildEmail(kind, 'owner@example.com', { ...fixtures[kind], name: '<b>x</b>', business: 'A & B' });
  assert.ok(!hostileReminder.html.includes('<b>x</b>'));
}
assert.equal(reminders.first_parcel_d1.subject, 'Your first NovaX parcel, in three steps');
assert.ok(reminders.first_parcel_d1.html.includes('Rs&nbsp;250 to Lahore'));
assert.ok(reminders.first_parcel_d1.text.includes('Rs 250 to Lahore'));
assert.ok(reminders.first_parcel_d1.html.replaceAll('&nbsp;', ' ').includes('Price: ' + PRICE));
assert.ok(reminders.first_parcel_d1.html.includes('between 11 am and 9 pm on working days'));
assert.ok(reminders.first_parcel_d1.html.includes('Paste order'));
assert.ok(reminders.first_parcel_d1.html.includes('Sample Store'));
assert.ok(reminders.first_parcel_d3.html.includes('COD in your wallet the day it lands.'));
assert.ok(reminders.first_parcel_d3.html.includes('try again or bring it back'));
assert.ok(reminders.first_parcel_d7.html.replaceAll('&nbsp;', ' ').includes(PRICE));
assert.ok(reminders.first_parcel_d7.html.includes('Karachi same day or next day. Lahore, Islamabad and Rawalpindi in 2–3 working days.'));
assert.ok(reminders.first_parcel_d7.html.includes('COD in your wallet the day it lands.'));
assert.ok(reminders.first_parcel_d7.html.includes('href="https://wa.me/923123922558?text=Hi%20NovaX%2C%20I%20need%20help%20booking%20my%20first%20parcel."'));
assert.ok(reminders.first_parcel_d7.html.includes('0312 3922558'));
assert.ok(reminders.first_parcel_d7.html.includes('This is our last reminder.'));
assert.ok(reminders.first_parcel_d7.text.includes('Or book it yourself in your portal: https://novaxlogistics.com/client.html?tab=newBooking'));
for (const kind of ['welcome', 'first_booking', 'payout_paid', 'cnic_verified', 'cnic_rejected']) {
  const m = buildEmail(kind, 'owner@example.com', fixtures[kind]);
  assert.equal(m.headers, undefined);
  assert.ok(m.html.includes('Automated account notification'));
  assert.ok(!m.html.includes('unsubscribe.html'));
}
// Nova Recover: the two emails a merchant gets.
{
  const refused = buildEmail('recover_refused', 'owner@example.com', { business: 'Sample Store', awb: 'N7810001', customer: 'Ayesha <b>', city: 'Lahore', cod: 2499, fee: 100, reason: 'Refused at door' });
  assert.equal(refused.subject, 'A customer refused parcel N7810001');
  assert.ok(refused.html.includes('PKR 2,499.00'));
  assert.ok(refused.html.includes('Recover it.') && refused.html.includes('Try again.') && refused.html.includes('Return to me.'));
  assert.ok(refused.html.replaceAll('&nbsp;', ' ').includes('PKR 100.00 only if it works'));
  assert.ok(refused.html.includes('client.html?tab=recover'));
  assert.ok(!refused.html.includes('<b>,') && refused.html.includes('Ayesha &lt;b&gt;'));
  assert.throws(() => buildEmail('recover_refused', 'owner@example.com', { cod: 100, fee: 100 }), /missing_awb/);
  const won = buildEmail('recover_won', 'owner@example.com', { business: 'Sample Store', awb: 'N7810331', was_awb: 'N7810092', mode: 'rebook', customer: 'Bilal', city: 'Karachi', cod: 3900, was_cod: 4100, fee: 100, deliver_on: '2026-10-09' });
  assert.equal(won.subject, 'We recovered an order for you: N7810331');
  assert.ok(won.html.includes('Print the new label') && won.html.includes('tab=awbLabel&amp;awb=N7810331'));
  assert.ok(won.html.includes('Earlier tracking number') && won.html.includes('N7810092'));
  assert.ok(won.html.includes('PKR 200.00'));           // taken off
  assert.ok(won.html.includes('9 October'));
  const again = buildEmail('recover_won', 'owner@example.com', { awb: 'N7810277', was_awb: 'N7810277', mode: 'resend', customer: 'Sana', cod: 1200, was_cod: 1200, fee: 0, deliver_on: '2026-10-09' });
  assert.ok(again.html.includes('Nothing for you to do.') && again.html.includes('There is no fee for this one.'));
  assert.ok(!again.html.includes('Earlier tracking number') && !again.html.includes('Taken off'));
  assert.throws(() => buildEmail('recover_won', 'owner@example.com', { awb: 'N1', cod: 100, fee: 100, deliver_on: 'soon' }), /invalid_event_date/);
}
{
  const launch = buildEmail('recover_launch', 'owner@example.com', { business: 'Sample Store', count: 22, cod: 34977, recent: 22, fee: 100 });
  assert.equal(launch.subject, '22 orders came back. We can sell them again');
  assert.ok(launch.html.includes('PKR 34,977.00') && launch.html.includes('client.html?tab=recover'));
  assert.ok(launch.html.replaceAll('&nbsp;', ' ').includes('PKR 100.00 only when it works.'));
  const one = buildEmail('recover_launch', 'owner@example.com', { count: 1, cod: 1200, fee: 0 });
  assert.equal(one.subject, 'An order came back. We can sell it again');
  assert.ok(one.html.includes('No fee for now.') && !one.html.includes('PKR 0.00 only'));
  assert.throws(() => buildEmail('recover_launch', 'owner@example.com', { count: 0, cod: 0, fee: 100 }), /invalid_parcel_count/);
}
console.log('PASS: eleven templates, net payout, PKT dates, escaping, invalid-data guards, reminder stop links and the three Nova Recover emails.');

const config = { url: 'https://example.supabase.co', serviceKey: 'test-service-key',
  resendKey: 'test-resend-key', drainToken: 'a'.repeat(64) };
const job = { id: 'fixture-job', kind: 'welcome', recipient: 'owner@example.com',
  payload: fixtures.welcome, lease_token: 'fixture-lease', attempts: 1, request_body: null };
function harness(options = {}) {
  const calls = [];
  const handler = createHandler({ ...config, ...options.config }, {
    sleep: async () => {},
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (url.endsWith('/nv_email_claim')) return Response.json(options.jobs ?? [job]);
      if (url.endsWith('/nv_email_prepare')) return Response.json(options.leaseLost ? null : body.p_body);
      if (url.endsWith('/nv_email_result')) {
        if (options.resultFailure) throw new Error('DO NOT expose credentials');
        return Response.json(true);
      }
      if (url === 'https://api.resend.com/emails') {
        if (options.sendThrows) throw new Error('network containing secret');
        return Response.json(options.response ?? { id: 'provider-demo-id' }, {
          status: options.status ?? 200, headers: options.headers ?? {},
        });
      }
      throw new Error('unexpected network destination');
    },
  });
  return { handler, calls };
}
const request = (token = config.drainToken, method = 'POST') =>
  new Request('https://example.test/drain', { method, headers: { 'x-novax-email-drain': token } });
for (const missing of ['url', 'serviceKey', 'resendKey', 'drainToken']) {
  const h = harness({ config: { [missing]: '' } });
  assert.equal((await h.handler(request())).status, 503);
  assert.equal(h.calls.length, 0);
}
for (const token of ['', 'wrong-token', config.drainToken + 'x']) {
  const h = harness(); assert.equal((await h.handler(request(token))).status, 403);
  assert.equal(h.calls.length, 0);
}
assert.equal((await harness().handler(request(config.drainToken, 'GET'))).status, 405);
const ok = harness();
assert.deepEqual(await (await ok.handler(request())).json(), { ok: true, claimed: 1, accepted: 1, failed: 0 });
const api = ok.calls.find(c => c.url === 'https://api.resend.com/emails');
assert.equal(api.init.headers['Idempotency-Key'], 'novax-email/fixture-job');
assert.equal(api.init.redirect, 'error');
assert.equal(ok.calls.at(-1).body.p_provider, 'provider-demo-id');
assert.ok(!JSON.stringify(await (await harness({ sendThrows: true }).handler(request())).json()).includes('secret'));

const frozen = JSON.stringify({ from: 'previous-template@example.com', to: ['owner@example.com'], subject: 'Original' });
const retry = harness({ jobs: [{ ...job, request_body: frozen, recipient: 'invalid', payload: {} }] });
await retry.handler(request());
assert.equal(retry.calls.find(c => c.url === 'https://api.resend.com/emails').init.body, frozen);
const lost = harness({ leaseLost: true }); await lost.handler(request());
assert.equal(lost.calls.some(c => c.url === 'https://api.resend.com/emails'), false);
const invalid = harness({ jobs: [{ ...job, recipient: '' }] }); await invalid.handler(request());
assert.equal(invalid.calls.some(c => c.url === 'https://api.resend.com/emails'), false);
assert.equal(invalid.calls.at(-1).body.p_terminal, true);
for (const [status, response, terminal] of [
  [422, { name: 'validation_error' }, true], [401, {}, true], [500, {}, false],
  [409, { name: 'invalid_idempotent_request' }, true],
  [409, { name: 'concurrent_idempotent_requests' }, false], [429, {}, false],
]) {
  const h = harness({ status, response, headers: { 'retry-after': '120' } });
  await h.handler(request());
  assert.equal(h.calls.at(-1).body.p_terminal, terminal);
  if (status === 429) assert.equal(h.calls.at(-1).body.p_retry_seconds, 120);
}
const uncertain = harness({ sendThrows: true }); await uncertain.handler(request());
assert.equal(uncertain.calls.at(-1).body.p_error, 'send_or_prepare_uncertain');
assert.equal(uncertain.calls.at(-1).body.p_terminal, false);
assert.equal((await harness({ resultFailure: true }).handler(request())).status, 502);
const empty = harness({ jobs: [] });
assert.equal((await (await empty.handler(request())).json()).accepted, 0);
console.log('PASS: fail-closed authentication, frozen retries, leases, HTTP errors and no exposed secrets.');

const previewFlag = process.argv.indexOf('--previews');
if (previewFlag >= 0) {
  const directory = path.resolve(process.argv[previewFlag + 1]);
  mkdirSync(directory, { recursive: true });
  for (const [kind, data] of Object.entries(fixtures)) {
    writeFileSync(path.join(directory, `${kind}.html`), buildEmail(kind, 'preview@example.com', data).html);
  }
  writeFileSync(path.join(directory, 'messages.json'), JSON.stringify(Object.fromEntries(
    Object.entries(fixtures).map(([kind,data]) => [kind, buildEmail(kind,'preview@example.com',data)])), null, 2));
  console.log(`Sample email previews: ${directory}`);
}

// One-off emails to merchants who stopped, or set up and never shipped (8 Oct 2026).
{
  const quiet = buildEmail('back_quiet', 'owner@example.com', fixtures.back_quiet);
  assert.equal(quiet.subject, 'Did something go wrong with your last parcels?');
  assert.ok(quiet.text.includes('Hi Aisha, you sent 12 parcels with NovaX from Sample Store, the last on 30 August, and none since.'));
  assert.ok(quiet.html.replaceAll('&nbsp;', ' ').includes('Rs 2,845'), 'the money still in the wallet is shown');
  assert.ok(quiet.html.includes('href="https://wa.me/923123922558?text='));
  const tried = buildEmail('back_tried', 'owner@example.com', fixtures.back_tried);
  assert.equal(tried.subject, 'How was your first NovaX delivery?');
  assert.ok(tried.text.includes('Hi there, you sent one parcel with NovaX, the last on 3 August, and none since.'), 'date is Pakistan time, one parcel reads as one');
  assert.ok(!tried.html.includes('STILL IN YOUR NOVAX WALLET'), 'an empty wallet is not mentioned');
  const ready = buildEmail('setup_ready', 'owner@example.com', fixtures.setup_ready);
  assert.equal(ready.subject, 'Your NovaX account is ready. Send your first parcel');
  assert.ok(ready.html.includes('href="https://novaxlogistics.com/client.html?tab=newBooking"'));
  for (const kind of NUDGE_KINDS) {
    const m = buildEmail(kind, 'owner@example.com', fixtures[kind]);
    assert.ok(m.html.includes('href="https://novaxlogistics.com/unsubscribe.html?t=8f14e45f-ceea-4e7a-9c1b-2f6d8a0b3c11"'), kind + ' carries the stop link');
    assert.equal(m.headers['List-Unsubscribe'], '<https://novaxlogistics.com/unsubscribe.html?t=8f14e45f-ceea-4e7a-9c1b-2f6d8a0b3c11>');
    assert.ok(m.text.includes('We send this email once.'));
    assert.ok(!m.html.includes('three of these'), kind + ' does not claim to be one of three reminders');
    assert.throws(() => buildEmail(kind, 'owner@example.com', { ...fixtures[kind], token: '' }), /missing_token/);
    assert.ok(m.html.replaceAll('&nbsp;', ' ').includes('Rs 225 for the first kg to a Karachi address, Rs 250 to Lahore, Islamabad or Rawalpindi, plus Rs 85 per additional kg.'));
  }
  assert.throws(() => buildEmail('back_quiet', 'owner@example.com', { ...fixtures.back_quiet, parcels: 0 }), /invalid_parcel_count/);
  assert.throws(() => buildEmail('back_quiet', 'owner@example.com', { ...fixtures.back_quiet, last: 'x' }), /invalid_event_date/);
  console.log('ok - the three one-off emails: wording, wallet line, stop link, WhatsApp button');
}

