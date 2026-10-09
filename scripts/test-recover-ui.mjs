/* Nova Recover: two things that went wrong on the day it shipped (8 Oct 2026)
   and must not come back.
   1. The menu entry must stay hidden until the server opens the tab. The
      menu's own rule is "#clientMenu .client-tab{display:flex !important}",
      so the hide rule has to carry the id as well, or it loses.
   2. client-recover.js must be in the list of published files. */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const html = read("client.html");
const css = html.replace(/\s+/g, "");
assert.ok(/#clientMenu\.client-tab\{[^}]*display:flex!important/.test(css) === false || css.includes('body:not(.nv-rc-on)#clientMenu.client-tab[data-client-tab="recover"]'),
  'client.html: the rule hiding the Nova Recover menu entry must include "#clientMenu" to beat the menu\'s display:flex !important');
const hide = html.match(/body:not\(\.nv-rc-on\) #clientMenu \.client-tab\[data-client-tab="recover"\][^{]*\{([^}]*)\}/);
assert.ok(hide && /display:\s*none\s*!important/.test(hide[1]), "client.html: the Nova Recover menu entry is hidden unless body.nv-rc-on");
assert.ok(/data-client-tab="recover"/.test(html), "client.html: the Nova Recover menu entry exists");
const app = read("client-app.js");
assert.ok(/v === "recover" && !\(document\.body && document\.body\.classList\.contains\("nv-rc-on"\)\)/.test(app), "client-app.js: the tab cannot be opened unless the server opened it");
const src = app.match(/client-recover\.js\?v=([0-9a-f]{8})/);
assert.ok(src, "client-app.js names client-recover.js by version");
assert.ok(read("scripts/build-public.mjs").includes('"client-recover.js"'), "scripts/build-public.mjs publishes client-recover.js");
console.log("ok - Nova Recover: menu entry hidden until opened, tab guarded, screen file published");

/* 10 Oct 2026: parcels booked before 19 Aug carry no phone number. 23 of the
   first 29 cases reached the desk with nobody to call. */
{
  const rc = read("client-recover.js"), care = read("care.html"), sql = read("sql_novax_recover_phone_20261010.sql");
  const okPhone = new Function(/  function okPhone\(v\)\{[^\n]*\n/.exec(rc)[0] + "return okPhone;")();
  assert.deepEqual(["0300 1234567", "+92 300 1234567", "3001234567", "12345", "", null, "0300 12345678901234"].map(okPhone), [true, true, true, false, false, false, false], "a number is 10 to 13 digits");
  assert.ok(rc.includes("p_key:S.key, p_phones:phones })"), "the typed numbers are sent with the parcels");
  assert.ok(rc.includes('go.disabled = (tick ? !tick.checked : false) || v == null || !numsOk;'), "Send stays off until every missing number is typed");
  assert.ok(rc.includes('rpc("client_recover_add_phone", { p_case:id, p_phone:v })'), "a number can be added to a case already sent");
  assert.ok(rc.includes("o.no_phone = !String(c.phone || \"\").trim(); return o; }") && !/demoCasePublic[^\n]*o\.phone\s*=/.test(rc), "the merchant's copy of a case says a number is missing but never holds one");
  assert.ok(rc.includes("return { v:2, accepted:false") && rc.includes("j.v === 2"), "the preview starts again with two orders that have no number");

  /* The desk: which group a case falls in. */
  const fns = /function rcNoNum\(x\)\{[^\n]*\n/.exec(care)[0] + /function rcIn\(x, f\)\{[\s\S]*?\n\}\n/.exec(care)[0];
  const rcIn = new Function(fns + "return rcIn;")();
  const waiting = { open: true, status: "waiting", phone: "03001234567" }, blank = { open: true, status: "waiting", phone: "" }, dashes = { open: true, status: "waiting", phone: " - " };
  const later = { open: true, status: "callback", due: false, phone: "03001234567" }, due = { open: true, status: "callback", due: true, phone: "03001234567" };
  const groups = (x) => ["call", "nonum", "later", "won", "closed"].filter((f) => rcIn(x, f)).join(",");
  assert.deepEqual([waiting, blank, dashes, later, due, { open: false, status: "recovered", phone: "" }, { open: false, status: "unreachable", phone: "" }].map(groups),
    ["call", "nonum", "nonum", "later", "call", "won", "closed"], "a case with nobody to dial is never in To call");
  const sheet = /function drawResellSheet\(x\)\{[\s\S]*?\n\}\n/.exec(care)[0];
  assert.ok(sheet.includes("(x.open && nonum") && sheet.indexOf("(x.open && nonum") < sheet.indexOf('href="tel:+'), "no Call button when there is no number");
  assert.ok(sheet.includes("rcAskNumberMsg(x)") && sheet.includes('rcNumForm(x, "Customer\'s phone number")') && sheet.includes('rcNumForm(x, "Correct phone number")'), "ask the merchant, save the number, or correct one");
  assert.ok(care.includes('rpc("cs_recover_set_phone", { p_case: o.id, p_phone: v })') && care.includes('if (id === "fRcNum") return rcSaveNum(e);'));
  assert.ok(care.includes("if (x.open && !x.held_by && !rcNoNum(x)) {"), "a case nobody can call is not held for ten minutes");
  const where = new Function(/var RC_BACK = [^\n]*\n/.exec(care)[0] + /function rcMoved\(x\)\{[^\n]*\n/.exec(care)[0] + /function rcWhere\(x\)\{[\s\S]*?\n\}\n/.exec(care)[0] + "return rcWhere;")();
  assert.match(where({ action: "none", parcel_status: "Parcel out for delivery" }), /^Out again with a rider \(Parcel out for delivery\)/);
  assert.match(where({ action: "none", parcel_status: "Return in transit" }), /^On its way back to the merchant/);
  assert.match(where({ action: "none", parcel_status: "Delivered" }), /^Already delivered/);
  assert.match(where({ action: "resend", parcel_status: "Refused" }), /^Still with NovaX/);

  /* The database file. */
  for (const f of ["client_recover_push(uuid[], numeric, boolean, jsonb, text, text, jsonb)", "client_recover_add_phone(uuid, text)", "cs_recover_set_phone(uuid, text)"])
    assert.ok(sql.includes("revoke all on function public." + f + " from public, anon;") && sql.includes("grant execute on function public." + f + " to authenticated;"), f + " is closed to signed-out callers");
  assert.ok(sql.includes("revoke all on function public.nv_recover_phone(text) from public, anon, authenticated;"));
  assert.ok(sql.includes("execute 'drop function ' || v_old::text;"), "the old six-argument push is replaced, not left beside the new one");
  assert.ok(!/update\s+public\.parcels/i.test(sql), "the parcel itself is never changed");
  console.log("ok - Nova Recover: a missing phone number is asked for, shown truthfully on the desk, and can be saved or corrected");
}
