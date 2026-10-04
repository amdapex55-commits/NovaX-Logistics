/* Builds client-app.min.js, the copy of the portal bundle that browsers load.
 *
 * client-app.js stays the source: edit it, never the .min file. This strips
 * comments and whitespace only -- no renaming, no syntax rewriting, no target
 * lowering -- so the code that runs is the code in client-app.js. The bundle
 * is about half comments; merchants on budget Android phones were downloading
 * and parsing 1.4 MB for an 860 KB program (gzip 422 KB -> about 250 KB).
 *
 * The banner records the source's git hash; check-build.mjs refuses a
 * client-app.min.js built from anything but the current client-app.js.
 *
 *   node scripts/build-client.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "client-app.js");
const out = join(root, "client-app.min.js");
const hash = execFileSync("git", ["hash-object", src]).toString().trim().slice(0, 8);
const tmp = join(mkdtempSync(join(tmpdir(), "nvbuild-")), "client-app.min.js");

execFileSync("npx", ["-y", "esbuild@0.24.0", src,
  "--minify-whitespace", "--legal-comments=none",
  "--log-level=warning", "--outfile=" + tmp], { stdio: ["ignore", "inherit", "inherit"] });

const body = readFileSync(tmp, "utf8");
writeFileSync(out, `/* Built from client-app.js@${hash} by scripts/build-client.mjs. Do not edit; edit client-app.js. */\n` + body);
console.log(`client-app.min.js built from client-app.js@${hash}: ${Math.round(readFileSync(src).length / 1024)} KB -> ${Math.round(readFileSync(out).length / 1024)} KB`);
