#!/usr/bin/env node
// The embedded Shopify page is BUILT AT RUNTIME from a template literal in
// ui.ts, so check-build never sees it — and a `\/` inside that template is an
// escape that collapses to a bare `/`, which turned a regex into a syntax error
// and killed the whole page in production on 26 Sep 2026. Nothing caught it
// because every test exercises the handlers, not the emitted HTML.
//
// This fetches the live page and parses its inline script the way a browser
// would. Run it after every deploy that touches ui.ts.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.env.NOVAX_SHOPIFY_APP_URL ??
  "https://novaxlogistics.com/shopify/app?shop=nova-test-sblskclr.myshopify.com";

const res = await fetch(URL_);
const html = await res.text();
const problems = [];

if (!res.ok) problems.push(`page returned HTTP ${res.status}`);

const ct = res.headers.get("content-type") ?? "";
if (!ct.includes("text/html")) {
  problems.push(`content-type is "${ct}" — the proxy is not rewriting it, App Bridge cannot boot`);
}
const csp = res.headers.get("content-security-policy") ?? "";
if (!csp.includes("frame-ancestors")) {
  problems.push(`CSP is "${csp}" — Shopify will refuse to frame this`);
}
if (/default-src 'none'/.test(csp)) {
  problems.push("the Supabase gateway CSP is back; the Worker route is not in front of this");
}

const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (blocks.length === 0) problems.push("no inline script in the page at all");

const dir = mkdtempSync(join(tmpdir(), "nvsh-"));
const file = join(dir, "page.mjs");
writeFileSync(file, blocks.join("\n;\n"));
try {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
} catch (e) {
  problems.push(`inline script does not parse:\n${String(e.stderr ?? e).slice(0, 600)}`);
}

// A regex that collapsed to `//` is a comment, not an error, in some positions —
// so look for the specific damage as well as for a parse failure.
if (/replace\(\/\^\/\//.test(html) || /replace\(\/\/app/.test(html)) {
  problems.push("a regex literal lost its backslash — check the escaping in ui.ts's template");
}

if (problems.length) {
  console.error("\nFAILED — " + problems.length + " problem(s):\n");
  for (const p of problems) console.error("  " + p + "\n");
  process.exit(1);
}
console.log(`  ok  live embedded page: ${ct.split(";")[0]}, CSP frame-ancestors set, ${blocks.length} inline script(s) parse`);
