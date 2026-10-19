// One step before pushing portal or rider changes (19 Oct 2026):
//   node scripts/release.mjs
// 1. builds client-app.min.js from client-app.js (build-client.mjs);
// 2. stamps a content hash on every versioned script/style in client.html
//    and rider.html (file.js?v=<hash>), so phones never keep an old copy;
// 3. bumps the offline cache name in sw.js only if something changed;
// 4. builds the public site (build-public.mjs).
// Safe to run twice: a second run with no edits changes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (f) => execFileSync(process.execPath, [path.join(root, "scripts", f)], { cwd: root, stdio: "inherit" });
const hash = (f) => createHash("sha1").update(readFileSync(path.join(root, f))).digest("hex").slice(0, 8);

run("build-client.mjs");

let changed = [];
for (const page of ["client.html", "rider.html"]) {
  const file = path.join(root, page);
  let html = readFileSync(file, "utf8");
  const next = html.replace(/(src|href)="([a-z0-9._-]+\.(?:js|css))\?v=([a-f0-9]+)"/gi, (m, attr, asset, old) => {
    let h; try { h = hash(asset); } catch { return m; }   // not a local file: leave it
    if (h !== old) changed.push(`${page}: ${asset} ${old} -> ${h}`);
    return `${attr}="${asset}?v=${h}"`;
  });
  if (next !== html) writeFileSync(file, next);
}

if (changed.length) {
  const sw = path.join(root, "sw.js");
  const src = readFileSync(sw, "utf8");
  const out = src.replace(/var CACHE = "novax-v(\d+)"/, (m, n) => `var CACHE = "novax-v${Number(n) + 1}"`);
  writeFileSync(sw, out);
  changed.push("sw.js: " + (src.match(/novax-v\d+/) || [""])[0] + " -> " + (out.match(/novax-v\d+/) || [""])[0]);
}
console.log(changed.length ? changed.join("\n") : "Nothing changed: versions already current.");
run("build-public.mjs");
