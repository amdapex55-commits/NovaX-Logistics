#!/usr/bin/env node
/*
 * NovaX pre-deploy checks.
 *
 * This repo deploys straight to novaxlogistics.com from main via GitHub
 * Pages. There is no build step, no bundler and no test suite, so a stray
 * character in a 988 KB HTML file goes live to merchants exactly as typed.
 * client.html alone carries 21 inline <script> blocks; a syntax error in the
 * first one silently kills every function the later ones call.
 *
 * These are the three failures that have actually happened or come closest
 * to happening on this project. Nothing clever, nothing that needs network.
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, extname } from "node:path";
import vm from "node:vm";

const root = process.argv[2] || ".";
const problems = [];
const notes = [];

/* ── 1. Every inline script must parse ────────────────────────────────────
   vm.Script compiles without executing, which is exactly what we want: a
   parse check with no DOM, no network and no side effects. */
const SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function checkHtml(file) {
  const src = readFileSync(join(root, file), "utf8");
  let m, n = 0, checked = 0;
  while ((m = SCRIPT_RE.exec(src)) !== null) {
    n++;
    const attrs = m[1] || "";
    const body = m[2] || "";
    if (/\bsrc\s*=/i.test(attrs)) continue;            // external, nothing inline to parse
    const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (type && !/javascript|module/i.test(type)) continue;  // JSON-LD, templates
    if (!body.trim()) continue;

    const startLine = lineOf(src, m.index);
    try {
      // A module may use import/export at top level; a classic script may not.
      new vm.Script(body, {
        filename: `${file}:<script #${n}> (line ${startLine})`,
        ...(/module/i.test(type || "") ? { importModuleDynamically: () => {} } : {})
      });
      checked++;
    } catch (e) {
      problems.push(`${file}: <script> block #${n} starting at line ${startLine} does not parse\n    ${e.message}`);
    }
  }
  const skipped = n - checked - problems.filter(p => p.startsWith(file + ":")).length;
  notes.push(`${file}: ${checked} inline script block(s) parse` +
             (skipped ? `, ${skipped} skipped (external src or non-JS type)` : ""));
}

/* ── 2. Standalone JS must parse too ─────────────────────────────────────
   sw.js is the dangerous one. A service worker that throws on parse fails to
   install, and the previous worker keeps serving -- which is how merchants
   got pinned to a stale build before. */
function checkJs(file) {
  const src = readFileSync(join(root, file), "utf8");
  try {
    new vm.Script(src, { filename: file });
    notes.push(`${file}: parses`);
  } catch (e) {
    problems.push(`${file} does not parse\n    ${e.message}`);
  }
}

/* ── 3. No credentials in a public repo ──────────────────────────────────
   GitHub Pages serves this repo publicly. The service_role JWT bypasses RLS
   entirely and does not expire until 2036; it has been pasted into this
   project's working files before, inside webhook trigger definitions dumped
   from the database. Anything matching a JWT header or a service_role
   reference fails the build. */
const SECRET_PATTERNS = [
  [/eyJhbGciOi[A-Za-z0-9_\-]{5,}/, "a JSON Web Token"],
  [/Bearer\s+ey[A-Za-z0-9_\-]{10,}/, "a Bearer token"],
  [/SUPABASE_SERVICE_KEY\s*[:=]\s*["'][^"']{20,}/, "a service key assignment"]
];
// NOTE: the bare word "service_role" is deliberately NOT a pattern. Every
// backend/*.sql file legitimately contains `grant execute ... to service_role`
// -- that is correct, necessary SQL. The danger is the KEY, never the word.
const SCANNABLE = new Set([".html", ".js", ".mjs", ".sql", ".json", ".md", ".sh", ".yml", ".yaml", ".gs"]);

/* Only git-tracked files are published by GitHub Pages, so only those are
   scanned. backend_dump.sql sits in this working directory and does contain
   the real service_role key -- it is gitignored, and scanning it would fail
   the build forever on a file that is never deployed. */
function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(f => f && SCANNABLE.has(extname(f)));
}

const tracked = trackedFiles();
let scanned = 0;
for (const file of tracked) {
  const src = readFileSync(join(root, file), "utf8");
  scanned++;
  for (const [re, label] of SECRET_PATTERNS) {
    const hit = src.match(re);
    if (!hit) continue;
    // The anon key is public by design and is meant to be in client HTML.
    // It is only safe because RLS stands behind it, so we still refuse any
    // JWT whose payload does not decode to role "anon".
    if (label === "a JSON Web Token") {
      const payload = src.slice(src.indexOf(hit[0])).split(".")[1] || "";
      try {
        const role = JSON.parse(Buffer.from(payload, "base64url").toString()).role;
        if (role === "anon") continue;
        problems.push(`${file} contains a JWT with role "${role}". Only the anon key may be committed.`);
        continue;
      } catch { /* undecodable -> fall through and fail loudly */ }
    }
    problems.push(`${file} contains ${label} (matched: ${hit[0].slice(0, 24)}...)`);
  }
}
notes.push(`secret scan: ${scanned} files`);

for (const f of readdirSync(root).filter(f => f.endsWith(".html"))) checkHtml(f);
for (const f of ["sw.js", "nv-codegen.js", "nv3d-hero.js"]) {
  try { checkJs(f); } catch { /* file may not exist; not a failure */ }
}

for (const n of notes) console.log(`  ok  ${n}`);
if (problems.length) {
  console.error(`\nFAILED -- ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}
console.log("\nAll checks passed.");
