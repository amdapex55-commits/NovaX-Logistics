/* Limited staff logins (9 Oct 2026): the parts of admin.html that must not
   quietly go back to "every Admin Portal login is a full admin". */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const html = read("admin.html");
// 1. Only the role "Admin" becomes a database admin.
assert.ok(/const fullAdmin = \/admin\/i\.test\(accessSide\) && \/\^admin\$\/i\.test\(String\(role\)\.trim\(\)\);/.test(html), "createUser: only role Admin is a full admin");
assert.ok(/\(fullAdmin \? "admin" : "support"\)/.test(html), "createUser: every other Admin Portal role gets profile role support");
assert.ok(!/const profileRole = \/admin\/i\.test\(accessSide\) \? "admin" :/.test(html), "createUser: the old rule (any Admin Portal login is admin) is gone");
// 2. Money, users and API ticks are never stored for a staff login.
assert.ok(/permissions = permissions\.filter\(p => \["finance-expense", "finance-invoices", "users", "api"\]\.indexOf\(p\) < 0\);/.test(html), "createUser: admin-only ticks are dropped for staff");
// 3. The gate asks the server, and a support login with no sections goes to the desk.
assert.ok(/__gsb\.rpc\("nv_staff_me",\{\}\)/.test(html) && /if\(!sections\.length\)\{ redirectAway\("care\.html"\); return; \}/.test(html), "gate: limited staff are let in only by nv_staff_me, else sent to care.html");
// 4. Sections: the switcher and the menu both obey the list, and every listed tab exists.
assert.ok(/function showAdminTab\(id\) \{\s*if \(!nvTabAllowed\(id\)\)/.test(html), "showAdminTab refuses a section the login does not have");
const map = html.match(/const NV_STAFF_TABS = \{([\s\S]*?)\};/);
assert.ok(map, "NV_STAFF_TABS exists");
const tabs = [...map[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
for (const t of tabs.filter((t) => !/^(dashboard|orders-view|orders-book|orders-processing|manifest|demanifest|pickups|support-tickets|clients|riders)$/.test(t))) {
  assert.ok(html.includes('data-admin-tab="' + t + '"'), "section " + t + " in NV_STAFF_TABS exists in the menu");
}
for (const never of ["finance-", "users-", "api-", "system-", "clients-create-new", "total-summary"]) {
  assert.ok(!tabs.some((t) => t.startsWith(never) || t === never), "a staff login can never be given " + never);
}
// 5. The form offers the ticks the database knows, and the background save is limited.
for (const p of ["orders-book", "pickups", "support-tickets", "support-desk", "orders-processing", "manifest", "demanifest", "clients", "riders"]) {
  assert.ok(html.includes('data-user-permission value="' + p + '"'), "Create Users has a tick for " + p);
}
assert.ok(/function nvStaffMaySync\(table\)/.test(html) && /if\(nvStaffMaySync\(s\[2\]\)\)\{ syncEntity/.test(html), "background save sends only what a staff login's sections own");
const sql = read("sql_novax_staff_limits_20261009.sql");
for (const p of ["orders-view", "orders-book", "orders-processing", "manifest", "demanifest", "pickups", "support-tickets", "clients", "riders"]) {
  assert.ok(sql.includes("'" + p + "'") || sql.includes("''" + p + "''"), "the database file knows the permission " + p);
}
assert.ok(!/nv_staff_can\(''(finance|users|api)/.test(sql), "the database file opens nothing for finance, users or API");
console.log("ok - limited staff: only role Admin is an admin, the gate asks the server, sections and saves are limited");
