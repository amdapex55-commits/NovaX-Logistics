import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// The site agent's rate limiting, run in Node against a fake database:
// it must keep counting (not wave everything through) when the limiter is down.
const src = readFileSync(new URL('../supabase/functions/novax-site-agent/index.ts', import.meta.url), 'utf8');
const part = src.slice(src.indexOf('// The shared limiter, in the database.'), src.indexOf('let inflight = 0;'));
assert.ok(part.length > 200, 'limiter block found');
const env = {};
let db = 'up', calls = 0;
const fakeFetch = async () => { calls++; if (db === 'throws') throw new Error('network'); if (db === 'http500') return { ok: false };
  return { ok: true, json: async () => db === 'deny' ? false : true }; };
const make = new Function('Deno', 'fetch', 'console', stripTypeScriptTypes(part) + '\nreturn { allowed, memOk };');
const quiet = { error() {}, warn() {}, log() {} };
const { allowed } = make({ env: { get: k => env[k] } }, fakeFetch, quiet);

// 1. configured and reachable: the database decides
env.SUPABASE_URL = 'https://x.supabase.co'; env.SUPABASE_SERVICE_ROLE_KEY = 'k';
assert.equal(await allowed('siteai:1.2.3.4', 25, '01:00:00', 6), true);
db = 'deny';
assert.equal(await allowed('siteai:1.2.3.4', 25, '01:00:00', 6), false, 'database says no');
// 2. database unreachable: a per-instance count takes over, it never waves everything through
for (const mode of ['throws', 'http500']) {
  db = mode;
  const bucket = 'siteai:' + mode;
  const got = [];
  for (let i = 0; i < 8; i++) got.push(await allowed(bucket, 25, '01:00:00', 6));
  assert.deepEqual(got, [true, true, true, true, true, true, false, false], mode + ': 6 allowed, then refused');
}
// 3. not configured at all (the old "never block on our own misconfig")
delete env.SUPABASE_URL; db = 'up';
const got = [];
for (let i = 0; i < 4; i++) got.push(await allowed('siteai:model', 300, '01:00:00', 3));
assert.deepEqual(got, [true, true, true, false], 'misconfigured: emergency ceiling holds');
console.log('PASS: site agent rate limits hold when the shared limiter is down (6 per network, then refused).');

// 4. the source wires both ceilings and always releases the in-flight slot
assert.match(src, /allowed\(`siteai:\$\{clientIp\(req\) \|\| "unknown"\}`, RATE_LIMIT/);
assert.match(src, /inflight >= MAX_INFLIGHT \|\| !\(await allowed\("siteai:model", MODEL_LIMIT/);
assert.match(src, /inflight\+\+;\s*\n\s*try \{/);
assert.match(src, /\} finally \{\s*\n\s*inflight--;/);
assert.doesNotMatch(src, /return true;\s*\/\/ never block on our own misconfig/);
assert.match(src, /workspace is created the moment signup finishes/);
console.log('PASS: per-network limit before the answer bank, cost ceiling and in-flight cap before the model, signup facts current.');
