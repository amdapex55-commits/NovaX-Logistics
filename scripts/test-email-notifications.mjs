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
};
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
const welcome = buildEmail('welcome', 'owner@example.com', fixtures.welcome);
for (const feature of ['bulk bookings', 'parcel statuses', 'request payouts', 'Connect Shopify']) {
  assert.ok(welcome.html.includes(feature));
  assert.ok(welcome.text.includes(feature));
}
for (const [kind, data] of Object.entries(fixtures)) {
  const message = buildEmail(kind, 'owner@example.com', data);
  assert.ok(Buffer.byteLength(message.html) < 50000);
  for (const link of message.html.matchAll(/href="([^"]+)"/g)) {
    assert.equal(new URL(link[1].replaceAll('&amp;', '&')).origin, 'https://novaxlogistics.com');
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
console.log('PASS: three templates, net payout, PKT dates, escaping and invalid-data guards.');

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
