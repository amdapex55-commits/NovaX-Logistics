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
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function checkPath(check) {
  const allowed = check.statuses || [check.status];
  let status = 0;
  // GitHub Pages can take a few seconds to swap a newly deployed artifact.
  // Bound every request so a slow edge cannot hang the security workflow.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(new URL(check.path, origin), {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      status = response.status;
      if (allowed.includes(status)) break;
      console.log(`retry ${check.path}: got ${status}, attempt ${attempt}/5`);
    } catch (error) {
      console.log(`retry ${check.path}: ${error.name}, attempt ${attempt}/5`);
    }
    if (attempt < 5) await sleep(1_000);
  }
  if (!allowed.includes(status)) {
    console.error(`${check.path}: expected ${allowed.join(" or ")}, got ${status}`);
    failed = true;
  } else {
    console.log(`ok ${check.path}: ${status}`);
  }
}

await Promise.all(checks.map(checkPath));

const response = await fetch(new URL("/", origin), { signal: AbortSignal.timeout(5_000) });
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
