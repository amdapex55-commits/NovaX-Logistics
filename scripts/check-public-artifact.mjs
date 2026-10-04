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
