const origin = process.env.NOVAX_ORIGIN || "https://novaxlogistics.com";

const checks = [
  { path: "/", status: 200 },
  { path: "/instant.html", status: 200 },
  { path: "/sql_novax_nova_instant_20261004.sql", statuses: [403, 404] },
  { path: "/backend/functions/production_functions.sql", statuses: [403, 404] },
  { path: "/package.json", statuses: [403, 404] },
  { path: "/index-v2.html", status: 404 },
  { path: "/demo.html", status: 404 },
];

let failed = false;
for (const check of checks) {
  const allowed = check.statuses || [check.status];
  let status = 0;
  // GitHub Pages can take a few seconds to swap a newly deployed artifact.
  // Retry only status mismatches; network/configuration errors still fail.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await fetch(new URL(check.path, origin), { redirect: "manual" });
    status = response.status;
    if (allowed.includes(status)) break;
    if (attempt < 10) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (!allowed.includes(status)) {
    console.error(`${check.path}: expected ${allowed.join(" or ")}, got ${status}`);
    failed = true;
  } else {
    console.log(`ok ${check.path}: ${status}`);
  }
}

const response = await fetch(new URL("/", origin));
const requiredHeaders = new Map([
  ["strict-transport-security", /max-age=[1-9]/],
  ["x-content-type-options", /^nosniff$/i],
  ["x-frame-options", /^(sameorigin|deny)$/i],
  ["referrer-policy", /\S+/],
  ["permissions-policy", /\S+/],
]);

for (const [name, pattern] of requiredHeaders) {
  const value = response.headers.get(name) || "";
  if (!pattern.test(value)) {
    console.error(`missing or invalid ${name}`);
    failed = true;
  } else {
    console.log(`ok header ${name}`);
  }
}

if (failed) process.exit(1);
console.log("Live security checks passed.");
