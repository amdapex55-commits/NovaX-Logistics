import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");

const forbiddenExtensions = new Set([
  ".csv", ".dump", ".gs", ".log", ".md", ".mjs", ".sh", ".sql", ".toml",
]);
const forbiddenSegments = new Set([
  ".claude", ".git", ".github", ".shopify", "audits", "backend", "node_modules",
  "output", "prototypes", "scripts", "supabase", "tmp", "workers",
]);
const forbiddenNames = [/^__/, /^backend_dump/i, /^sql_/i, /^plan_/i, /^project_history/i];

const requiredFiles = [
  "index.html", "client.html", "tracking.html", "instant.html", "sw.js",
  "assets/vendor/supabase-2.117.2.js",
];

async function walk(directory, relative = "") {
  const findings = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) findings.push(...await walk(path.join(directory, entry.name), rel));
    else findings.push(rel);
  }
  return findings;
}

await access(output);
for (const file of requiredFiles) await access(path.join(output, file));

/* Every script a published page or bundle loads by a versioned address
   ("name.js?v=<hash>") must itself be published. On 8 Oct 2026 the portal
   bundle went live pointing at client-recover.js, which was not in
   build-public.mjs's list: the address answered 404 on the live site. */
const missingScripts = [];
for (const page of ["client.html", "client-app.js", "rider.html", "care.html", "admin.html", "index.html"]) {
  let text = "";
  try { text = await readFile(path.join(output, page), "utf8"); } catch { continue; }
  for (const m of text.matchAll(/["'(]([A-Za-z0-9_-]+\.js)\?v=[0-9a-f]{8}/g)) {
    try { await access(path.join(output, m[1])); } catch { missingScripts.push(`${page} loads ${m[1]}, which is not published`); }
  }
}
if (missingScripts.length) {
  console.error([...new Set(missingScripts)].join("\n"));
  console.error("Add the file to the list in scripts/build-public.mjs.");
  process.exit(1);
}

const files = await walk(output);
const violations = files.filter((file) => {
  const segments = file.split(path.sep);
  const basename = path.basename(file);
  return segments.some((segment) => forbiddenSegments.has(segment)) ||
    forbiddenExtensions.has(path.extname(file).toLowerCase()) ||
    forbiddenNames.some((pattern) => pattern.test(basename));
});

// Catch common private-key/service-role accidents even in otherwise allowed files.
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /SUPABASE_SERVICE_ROLE_KEY\s*[:=]/i,
  /CLOUDFLARE_API_TOKEN\s*[:=]/i,
  /(?:sk_live|sk_test)_[A-Za-z0-9]{16,}/,
];
for (const file of files) {
  const fullPath = path.join(output, file);
  const info = await stat(fullPath);
  if (info.size > 5_000_000) continue;
  const content = await readFile(fullPath, "utf8").catch(() => "");
  if (secretPatterns.some((pattern) => pattern.test(content))) violations.push(`${file} (secret pattern)`);
}

if (violations.length) {
  console.error("Refusing to publish unsafe files:\n" + [...new Set(violations)].sort().join("\n"));
  process.exit(1);
}

console.log(`Public artifact passed: ${files.length} files, no private source or secret patterns.`);
