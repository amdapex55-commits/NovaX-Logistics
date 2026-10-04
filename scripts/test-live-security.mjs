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
  const response = await fetch(new URL(check.path, origin), { redirect: "manual" });
  const allowed = check.statuses || [check.status];
  if (!allowed.includes(response.status)) {
    console.error(`${check.path}: expected ${allowed.join(" or ")}, got ${response.status}`);
    failed = true;
  } else {
    console.log(`ok ${check.path}: ${response.status}`);
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
