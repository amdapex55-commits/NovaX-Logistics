#!/usr/bin/env node
// Runs the Shopify app's test suites. No dependencies, no test framework: the
// edge function is plain Deno-flavoured TypeScript and Node can execute it
// directly with --experimental-strip-types.
//
//   node scripts/test-shopify.mjs
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)),
                      "..", "supabase", "functions", "shopify", "tests");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();

let failed = 0;
for (const f of files) {
  process.stdout.write(`\n=== ${f} ===\n`);
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", path.join(dir, f)],
      { stdio: "inherit", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  } catch {
    failed++;
  }
}
if (failed) { console.error(`\n${failed} suite(s) failed`); process.exit(1); }
console.log(`\nall ${files.length} suites passed`);
