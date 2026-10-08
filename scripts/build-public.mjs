import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");

// GitHub Pages must never publish the repository root. Keep this list explicit:
// anything added to the repository stays private from the website until it is
// deliberately reviewed and added here.
const publicFiles = [
  "CNAME",
  "admin.html",
  "care.html",
  "client.html",
  "cod-courier-islamabad.html",
  "cod-courier-karachi.html",
  "cod-courier-lahore.html",
  "cod-courier-rawalpindi.html",
  "cod-delivery-cost-karachi-to-lahore.html",
  "customer-refused-cod-parcel.html",
  "index.html",
  "instant-account.html",
  "instant-ops.html",
  "instant-rider.html",
  "instant-terms.html",
  "instant.html",
  "new-password.html",
  "offline.html",
  "privacy.html",
  "rider.html",
  "sales.html",
  "shopify-orders-to-novax-bookings.html",
  "support.html",
  "terms.html",
  "tracking.html",
  "unsubscribe.html",
  "when-is-cod-paid.html",
  "client-app.js",
  "client-app.min.js",
  "client-recover.js",
  "client-reports.js",
  "nv-cnic.js",
  "nv-journey.js",
  "nv-payment.js",
  "rider-app.js",
  "rider-core.js",
  "rider.css",
  "sw.js",
  "robots.txt",
  "sitemap.xml",
];

const publicDirectories = ["assets"];

async function copy(relativePath) {
  const source = path.join(root, relativePath);
  const destination = path.join(output, relativePath);
  await stat(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of publicFiles) await copy(file);
for (const directory of publicDirectories) await copy(directory);

// Prevent Jekyll processing from changing files whose names begin with `_`.
await mkdir(path.join(output, ".nojekyll"));

console.log(`Built allowlisted public site in ${output}`);
