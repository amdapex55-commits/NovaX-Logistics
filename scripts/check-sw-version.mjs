#!/usr/bin/env node
/*
 * The service worker caches assets cache-first. If an asset changes but the
 * cache name does not, every merchant who already has the worker installed
 * keeps the old copy until they clear storage -- the exact failure that
 * previously pinned merchants to a stale build.
 *
 * HTML is served network-first, so client.html changing does NOT require a
 * bump. Only the cache-first paths do: anything under assets/, and anything
 * listed in PRECACHE.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const base = process.argv[2];
if (!base) { console.log("  ok  no base ref given; skipping service worker version check"); process.exit(0); }

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let changed;
try { changed = git("diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean); }
catch { console.log("  ok  base ref unavailable; skipping service worker version check"); process.exit(0); }

if (!changed.length) { console.log("  ok  nothing changed"); process.exit(0); }

const sw = readFileSync("sw.js", "utf8");
const cacheName = (sw.match(/var\s+CACHE\s*=\s*["']([^"']+)["']/) || [])[1];
if (!cacheName) {
  console.error("FAILED -- could not find the CACHE name in sw.js.");
  process.exit(1);
}
const precache = (sw.match(/PRECACHE\s*=\s*\[([^\]]*)\]/) || [])[1] || "";
const precached = [...precache.matchAll(/["']([^"']+)["']/g)].map(m => m[1].replace(/^\//, ""));

// Only cache-first paths matter. HTML is network-first and self-heals.
const cacheFirst = changed.filter(f =>
  (f.startsWith("assets/") || precached.includes(f)) && !f.endsWith(".html"));

if (!cacheFirst.length) {
  console.log(`  ok  no cache-first asset changed; CACHE stays ${cacheName}`);
  process.exit(0);
}

let oldSw = "";
try { oldSw = git("show", `${base}:sw.js`); } catch { /* sw.js is new */ }
const oldName = (oldSw.match(/var\s+CACHE\s*=\s*["']([^"']+)["']/) || [])[1];

if (oldName && oldName === cacheName) {
  console.error(`\nFAILED -- these cache-first files changed:\n${cacheFirst.map(f => "    " + f).join("\n")}`);
  console.error(`\n  but sw.js CACHE is still "${cacheName}". Every merchant with the worker`);
  console.error(`  already installed will keep serving the old copy. Bump it in sw.js.\n`);
  process.exit(1);
}

console.log(`  ok  cache-first assets changed and CACHE moved ${oldName || "(new)"} -> ${cacheName}`);
