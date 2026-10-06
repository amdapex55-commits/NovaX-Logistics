// Nova Instant page checks that need no browser and no database.
// Run: node scripts/test-instant-pages.mjs   (part of npm run test:instant)
import { readFileSync } from "node:fs";
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
let bad = 0;
const ok = (label, pass, why) => { console.log((pass ? "  ok  " : "  FAIL ") + label + (pass || !why ? "" : ": " + why)); if (!pass) bad++; };

// NVI-05: the rules page and the version every booking records must be the same number.
const terms = read("instant-terms.html"), audit = read("sql_novax_instant_audit_20261006.sql");
const shown = (terms.match(/Version (\d+\.\d+),/) || [])[1];
const stored = (audit.match(/set terms_version = '(\d+\.\d+)'/) || [])[1];
const dflt = (audit.match(/alter column terms_version set default '(\d+\.\d+)'/) || [])[1];
ok("rules page shows a version", !!shown);
ok("bookings record the version the rules page shows", shown === stored && shown === dflt, `page ${shown}, database ${stored}, default ${dflt}`);

// NVI-10: with no answer from NovaX about riders, booking must stay shut.
const book = read("instant.html");
const fn = (book.match(/function canBookNow\(\)\{[^\n]*\}/) || [""])[0];
ok("booking stays shut until availability is known", /return !!s&&/.test(fn) && !/return !s\|\|/.test(fn));
ok("a failed availability check can be tried again", book.includes("data-restatus") && book.includes("function loadStatus("));

// NVI-01: both withdrawal forms send a key, and keep it until NovaX answers.
for (const [f, call] of [["instant-account.html", "nvi_client_withdraw"], ["instant-rider.html", "nvi_rider_payout"]]) {
  const p = read(f), line = p.split("\n").find((l) => l.includes('rpc("' + call + '"')) || "";
  ok(f + " sends a key with a withdrawal", /p_key:/.test(line.slice(line.indexOf(call))));
  ok(f + " keeps the key until NovaX answers", p.includes("function payKey(") && p.includes("payKeyDone()"));
}

// NVI-13: the rules say whose number a tracking page shows.
ok("rules say the rider's number is shown while on a job", /rider's first name, bike number and mobile number/.test(terms) && !/never the mobile numbers\./.test(terms));
// NVI-11: the rules no longer say every rider is a freelancer.
ok("rules cover staff riders too", /rider on NovaX's own staff/.test(terms));

console.log(bad ? `NOVA INSTANT PAGE CHECKS FAILED (${bad})` : "NOVA INSTANT PAGE CHECKS PASSED");
process.exit(bad ? 1 : 0);
