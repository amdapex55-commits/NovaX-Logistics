/* Regression gate for the "false zero-parcel workspace" family.
 *
 * Two properties, both of which were real defects:
 *
 *  1. A cached workspace may only ever be restored for the SAME client id.
 *     This is the only thing standing between two merchants sharing a browser
 *     and one of them seeing the other's parcels.
 *
 *  2. _raw must be stripped from the persisted copy. It is a nested duplicate
 *     of consignee/phone/address/city/cod kept for the edit concurrency check,
 *     and because the strip only removes top-level keys it was quietly
 *     carrying every consignee's phone and address into localStorage --
 *     defeating the three keys sitting next to it.
 *
 * Both are asserted against the REAL function text pulled out of the bundle,
 * not a reimplementation, so this fails if the bundle changes behaviour.
 */
import fs from "fs";

const src = fs.readFileSync(new URL("../client-app.js", import.meta.url), "utf8");
let pass = true;
function t(label, got, want){
  const ok = got === want;
  if(!ok) pass = false;
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (ok ? "" : `   (got ${got}, want ${want})`));
}

/* ---- extract a named function's source, brace-balanced ---- */
function grab(name){
  const i = src.indexOf("function " + name + "(");
  if(i < 0) throw new Error("not found in bundle: " + name);
  let d = 0;
  for(let k = src.indexOf("{", i); k < src.length; k++){
    if(src[k] === "{") d++;
    else if(src[k] === "}"){ d--; if(d === 0) return src.slice(i, k + 1); }
  }
  throw new Error("unbalanced braces reading " + name);
}

/* ---- 1. cache identity guard ---- */
const STORAGE_KEY = "novaxLogisticsStateV10";
let store = {};
const localStorage = { getItem: k => (k in store ? store[k] : null) };
const nvCachedWorkspaceFor = new Function(
  "STORAGE_KEY", "localStorage", grab("nvCachedWorkspaceFor") + "; return nvCachedWorkspaceFor;"
)(STORAGE_KEY, localStorage);

const good = JSON.stringify({ client:{ id:"CLIENT-A" }, parcels:[{awb:"N1"},{awb:"N2"}] });
store[STORAGE_KEY] = good;
t("same client id restores",               !!nvCachedWorkspaceFor("CLIENT-A"), true);
t("DIFFERENT client id refuses",           !!nvCachedWorkspaceFor("CLIENT-B"), false);
t("null client id refuses",                !!nvCachedWorkspaceFor(null), false);
t("empty client id refuses",               !!nvCachedWorkspaceFor(""), false);
store[STORAGE_KEY] = JSON.stringify({ client:{ id:"CLIENT-A" } });
t("cache without parcels refuses",         !!nvCachedWorkspaceFor("CLIENT-A"), false);
store[STORAGE_KEY] = "{not json";
t("corrupt cache refuses",                 !!nvCachedWorkspaceFor("CLIENT-A"), false);
delete store[STORAGE_KEY];
t("no cache refuses",                      !!nvCachedWorkspaceFor("CLIENT-A"), false);
store[STORAGE_KEY] = JSON.stringify({ client:{ id:"CLIENT-A" }, parcels:[] });
t("same id with zero parcels restores",    !!nvCachedWorkspaceFor("CLIENT-A"), true);

/* ---- 2. PII never reaches localStorage ---- */
const m = src.match(/NOVAX_PARCEL_PII_KEYS\s*=\s*\[([^\]]*)\]/);
const piiKeys = m ? m[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
["phone", "address", "trackingToken", "_raw"].forEach(k => {
  t(`PII strip list contains ${k}`, piiKeys.includes(k), true);
});

/* the strip must actually remove them, nested copy included */
const persistable = new Function("NOVAX_PARCEL_PII_KEYS", "state", `
  ${grab("persistableState")}
  return persistableState();
`);
const NOVAX_NEVER_PERSIST_KEYS = [];
const fakeState = {
  client: { id: "CLIENT-A" },
  parcels: [{
    awb: "N1", consignee: "Fatima", phone: "3118282675",
    address: "Khayaban e qasim, Karachi", trackingToken: "tok_abc",
    _raw: { consignee: "Fatima", phone: "3118282675", address: "Khayaban e qasim, Karachi" }
  }]
};
const out = new Function("NOVAX_PARCEL_PII_KEYS", "NOVAX_NEVER_PERSIST_KEYS", "state", `
  ${grab("persistableState")}
  return persistableState();
`)(piiKeys, NOVAX_NEVER_PERSIST_KEYS, fakeState);

const serialised = JSON.stringify(out);
t("persisted copy has no phone",    /3118282675/.test(serialised), false);
t("persisted copy has no address",  /Khayaban/.test(serialised), false);
t("persisted copy has no _raw",     /_raw/.test(serialised), false);
t("persisted copy keeps the awb",   /N1/.test(serialised), true);

console.log(pass ? "\nworkspace-cache: ALL PASS" : "\nworkspace-cache: FAILURES");
process.exit(pass ? 0 : 1);
