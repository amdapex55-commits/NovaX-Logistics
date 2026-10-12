// 12 Oct 2026: a Korangi (Karachi) shop signed up with Lahore as its pickup
// city, and its first parcel waited three days in the Lahore rider's list.
// Sign-up now stops once when the address names another served city, and the
// rider app flags such a pickup. Reads the files only.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const core = readFileSync(new URL("../rider-core.js", import.meta.url), "utf8");
const portal = readFileSync(new URL("../client-app.js", import.meta.url), "utf8");
const ok = (m) => console.log("ok - " + m);

// 1. The sign-up form's reading of an address.
const src = /var NV_SIGNUP_CITY_MARKERS=\{[\s\S]*?\n\};\nfunction nvSignupCityFromAddress\(addr\)\{[\s\S]*?\n\}\n/.exec(html);
assert.ok(src, "sign-up has the address reader");
const looks = new Function(src[0] + "return nvSignupCityFromAddress;")();
{
  assert.equal(looks("Korangi Crossing, Allah Wala Town"), "Karachi");
  assert.equal(looks("Shop 4, Johar Town"), "Lahore");
  assert.equal(looks("Gulistan-e-Johar block 7"), "Karachi", "one word from Johar Town");
  assert.equal(looks("Satellite Town, Rawalpindi"), "Rawalpindi");
  assert.equal(looks("House F-10, street 4"), "", "a house number is not a sector");
  assert.equal(looks("Main market, shop 12"), "");
  assert.equal(looks(""), "");
  ok("sign-up: reads Korangi as Karachi, Johar Town as Lahore, and says nothing when no city is named");
}

// 2. It stops the first press and lets the second through.
{
  const at = html.indexOf("var looksCity=nvSignupCityFromAddress(address);");
  assert.ok(at > -1);
  const block = html.slice(at, html.indexOf("var cnicPick=", at));
  assert.ok(block.includes('if(city && looksCity && looksCity!==city && address.toLowerCase().indexOf(city.toLowerCase())<0){'), "only when the address names another city and not the chosen one");
  assert.ok(block.includes('if(window.__nvSignupCityAsked!==askedKey){') && block.includes("return;"), "asked once per city and address");
  assert.ok(block.includes('press the button again if "+city+" is right.'), "and says how to go on");
  assert.ok(at < html.indexOf("__nvSb.auth.signUp({"), "before the account is created");
  assert.ok(html.includes('id="merchantCityWarn" role="status" hidden') && html.includes('el.addEventListener("input",nvSignupCityCheck)'), "the hint under the address updates as they type");
  // replay the handler's decision
  const decide = (city, address, asked) => { const l = looks(address); return !!(city && l && l !== city && address.toLowerCase().indexOf(city.toLowerCase()) < 0 && asked !== city + "|" + address); };
  assert.equal(decide("Lahore", "Korangi Crossing, Allah Wala Town", ""), true, "the 8 Oct sign-up would have been stopped");
  assert.equal(decide("Lahore", "Korangi Crossing, Allah Wala Town", "Lahore|Korangi Crossing, Allah Wala Town"), false, "a second press goes ahead");
  assert.equal(decide("Karachi", "Korangi Crossing, Allah Wala Town", ""), false);
  assert.equal(decide("Lahore", "Clifton Colony, Lahore", ""), false, "an address that names the chosen city is trusted");
  assert.equal(decide("Lahore", "Main market, shop 12", ""), false);
  ok("sign-up: one stop with a plain message, never a dead end");
}

// 3. The rider app and sign-up use the portal's area names (sector codes left out on purpose).
{
  const names = (text, open) => { const m = new RegExp(open + "[\\s\\S]*?\\n\\s*\\};").exec(text)[0]; const out = {};
    for (const c of ["Karachi", "Lahore", "Islamabad", "Rawalpindi"]) out[c] = [...new RegExp(c + ":\\s*\\[([\\s\\S]*?)\\]").exec(m)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]); return out; };
  const P = names(portal, "var NV_CITY_MARKERS_C = \\{"), S = names(html, "var NV_SIGNUP_CITY_MARKERS=\\{"), Rm = names(core, "var CITY_MARKERS = \\{");
  const noCodes = (l) => l.filter((x) => !/^[a-z]-\d+$/.test(x));
  for (const c of Object.keys(P)) { assert.deepEqual(S[c], noCodes(P[c]), "sign-up " + c); assert.deepEqual(Rm[c], noCodes(P[c]), "rider " + c); }
  ok("one list of area names in three places: portal booking form, sign-up, rider app");
}
console.log("SIGN-UP CITY CHECKS PASSED");
