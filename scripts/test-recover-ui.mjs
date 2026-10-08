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
