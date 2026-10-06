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

// One shell: moving between booking, deliveries, the account and tracking never loads the page again.
const acct = read("instant-account.html");
const pop = book.slice(book.indexOf('addEventListener("popstate"'), book.indexOf('addEventListener("popstate"') + 1400);
ok("the Back button never reloads the page", !/location\.reload\(/.test(book) && /nvi==="view"/.test(pop));
ok("bottom bar has Book, Deliveries and Account", ["book", "list", "acct"].every((v) => book.includes('data-nav="' + v + '"')));
ok("the bottom bar is hidden while a booking is being filled in", /\[data-step="2"\] \.nav[^{]*\{display:none\}/.test(book));
ok("a finished booking becomes tracking as one Back step", /S\.done=true;\s*try\{ history\.replaceState\(\{ nvi:"view", view:"track"/.test(book));
ok("the rules open inside the page", (book.match(/data-rules/g) || []).length >= 4 && book.includes("function openRules("));
ok("the account opens inside the booking page", book.includes('src="instant-account.html?embed=1') && acct.includes('location.replace("instant.html?view=account"'));
ok("the account page only talks to the page that holds it", /postMessage\(o,location\.origin\)/.test(acct) && /e\.origin!==location\.origin\|\|e\.source!==f\.contentWindow/.test(book));
ok("a sign-in link from an email is not redirected", /standalone\|code\|token\|type\|error/.test(acct));

// The sheet: only its handle moves it, and pulling the page down never reloads it.
ok("the sheet handle is a real button", /<button class="grab" id="grab" type="button" aria-label=/.test(book));
ok("only the handle drags the sheet", /g\.addEventListener\("pointerdown"/.test(book) && /\.grab\{[^}]*touch-action:none/.test(book));
ok("pulling down on the page does not reload it", /html\{overscroll-behavior-y:contain\}/.test(book));
ok("the sheet can be switched off", book.includes("[?&]sheet=0"));
// The draft: kept on the phone for 45 minutes, back to the step it was on, without the rules tick.
const draftKeys = (book.match(/var DRAFT=\[([^\]]*)\]/) || ["", ""])[1];
ok("a half-made booking is kept on the phone", /localStorage\.setItem\("nvi_draft"/.test(book) && /45\*60000/.test(book));
ok("it returns to the step it was on, the review included", /S\.resume=Math\.min\(Number\(o\.step\)\|\|1,4\)/.test(book));
ok("the rules tick, CAPTCHA answer and PIN are never kept", !/"agree"|"cap"|pin|token/i.test(draftKeys));
ok("a finished booking clears the draft", (book.match(/dropDraft\(\);/g) || []).length >= 3);

// The keyboard: panels fit above it, and every text field has the right key.
ok("panels are sized to the space above the keyboard", /\.panel\{bottom:auto;height:var\(--vvh,100dvh\)/.test(book) && book.includes("window.visualViewport"));
ok("Android shrinks the page for the keyboard", /interactive-widget=resizes-content/.test(book));
const noHint = (book.match(/<input[^>]*>/g) || []).filter((i) => !/type="checkbox"|id="agree"/.test(i) && !/enterkeyhint=/.test(i));
ok("every text field names its keyboard key", noHint.length === 0, noHint.map((i) => (i.match(/id="([^"]+)"/) || [])[1]).join(", "));
ok("the bottom bar and map buttons hide while typing", /body\.kb \.nav,body\.kb \.leaflet-control-container\{display:none\}/.test(book));

// Placeholders, and questions that a newer one replaces.
ok("tracking draws its shape before the delivery arrives", book.includes("var TRACK_SK=") && /<\/div>'\+TRACK_SK\);/.test(book));
ok("the account shows its shape while it loads", /class="sks" aria-hidden="true"/.test(book));
ok("typing again cancels the search before it", /if\(searchGrp\)\{ try\{ searchGrp\.abort\(\)/.test(book));
ok("search answers are kept for 10 minutes", /Date\.now\(\)-hit\.at<600000/.test(book));
ok("a newer fare check cancels the one before", /quoteAc\.abort\(\)/.test(book) && /rpc\("nvi_quote",\{[^}]*\},quoteAc&&quoteAc\.signal\)/.test(book));
ok("an unchanged route is not redrawn", /rk===routeKey/.test(book));
ok("the saved availability note never opens booking", /if\(!s&&!S\.statusErr&&S\.hint\) s=S\.hint;/.test(book) && /function canBookNow\(\)\{ var s=S\.status; return !!s&&/.test(book));

ok("a slow place search is waited for while Mapbox is asked as well", /photon\(q,grp,10000\)/.test(book) && /askMb\(\)\.then\(function\(a\)\{ if\(!done&&a\.length\)/.test(book));

console.log(bad ? `NOVA INSTANT PAGE CHECKS FAILED (${bad})` : "NOVA INSTANT PAGE CHECKS PASSED");
process.exit(bad ? 1 : 0);
