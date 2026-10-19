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
  "cod-courier-faisalabad.html",
  "cod-courier-multan.html",
  "cod-courier-sahiwal.html",
  "cod-courier-okara.html",
  "cod-delivery-cost-karachi-to-lahore.html",
  "customer-refused-cod-parcel.html",
  "index.html",
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
  "best-cod-courier-pakistan.html",
  "novax-vs-tcs.html",
  "novax-vs-leopards.html",
  "novax-vs-postex.html",
  "novax-vs-trax.html",
  "novax-vs-mnp.html",
  "client-app.js",
  "client-app.min.js",
  "client-recover.js",
  "client-reports.js",
  "nv-cnic.js",
  "nv-voice.js",
  "nv-journey.js",
  "nv-payment.js",
  "rider-app.js",
  "rider-core.js",
  "rider.css",
  "sw.js",
  "robots.txt",
  "531cb461222aa19aa0a9dcd567463352.txt",  // IndexNow key (19 Oct 2026): proves the site is ours when pinging Bing/Yandex
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

// Nova Instant is paused (19 Oct 2026): its old addresses (sign-in routing,
// bookmarks, tracking links) all show one "paused" page. The real pages are in
// shelved/nova-instant/pages/; see shelved/nova-instant/README.md to restore.
for (const name of ["instant.html", "instant-rider.html", "instant-account.html", "instant-ops.html", "instant-terms.html"]) {
  await cp(path.join(root, "instant-paused.html"), path.join(output, name));
}

// Prevent Jekyll processing from changing files whose names begin with `_`.
await mkdir(path.join(output, ".nojekyll"));

console.log(`Built allowlisted public site in ${output}`);
