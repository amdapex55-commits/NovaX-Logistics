#!/usr/bin/env node
// Fails when the UI or SQL references an Edge Function route that has no
// source directory under supabase/functions and is not explicitly deferred.
// Added 2026-08-30 after the Codex hard audit found 7 such routes (MED-006).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SRC_EXT = new Set(['.html', '.js', '.ts', '.sql', '.mjs']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build']);
// Routes deployed in Supabase but not yet represented in source.
// Aisha deferred the Shopify/WooCommerce reconciliation to later this week.
// Remove entries here as each one gets a source-owned implementation.
const DEFERRED = new Map([
  ['shopify-order-intake', 'deployed v11 — Shopify work deferred'],
  ['shopify-status-push',  'deployed v7  — Shopify work deferred'],
  ['shopify-bulk-import',  'NOT deployed — Shopify work deferred'],
  ['woo-order-intake',     'deployed as "woo-order-intake-" (trailing hyphen) — deferred'],
  ['woo-status-push',      'deployed v7  — Woo work deferred'],
  ['web-order-intake',     'deployed v7  — custom-web work deferred'],
  ['web-status-push',      'deployed v7  — custom-web work deferred'],
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (SRC_EXT.has(extname(name)) && !name.startsWith('backend_dump')) out.push(p);
  }
  return out;
}

const refs = new Map();          // route -> Set(file)
// matches "/functions/v1/<name>" and  intakeFn:"<name>"  style declarations
const PATTERNS = [/functions\/v1\/([a-zA-Z0-9_-]+)/g, /intakeFn\s*:\s*["']([a-zA-Z0-9_-]+)["']/g];
for (const file of walk(ROOT)) {
  let text; try { text = readFileSync(file, 'utf8'); } catch { continue; }
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (!refs.has(m[1])) refs.set(m[1], new Set());
      refs.get(m[1]).add(file.replace(ROOT + '/', ''));
    }
  }
}

const have = existsSync('supabase/functions')
  ? new Set(readdirSync('supabase/functions').filter(d => statSync(join('supabase/functions', d)).isDirectory()))
  : new Set();

const missing = [], deferred = [];
for (const [route, files] of [...refs].sort()) {
  if (have.has(route)) continue;
  (DEFERRED.has(route) ? deferred : missing).push([route, files]);
}

for (const [route] of deferred) console.log(`  deferred  ${route}  (${DEFERRED.get(route)})`);
for (const [route, files] of missing) {
  console.error(`  MISSING   ${route}  referenced by: ${[...files].join(', ')}`);
}
if (missing.length) {
  console.error(`\nedge route check FAILED: ${missing.length} route(s) referenced with no source and no deferral.`);
  console.error('Add the function under supabase/functions/<name>, remove the reference, or add it to DEFERRED with a reason.');
  process.exit(1);
}
console.log(`\nok  ${refs.size} route reference(s); ${have.size} with source; ${deferred.length} deferred; 0 unexplained.`);
