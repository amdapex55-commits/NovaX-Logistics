// 11 Oct 2026: the rider app has no sign-in of its own; it sends riders to the
// homepage's. These checks keep the two in step: where the rider app sends
// people, the note it writes for the homepage's Sign in buttons, and what the
// homepage's sign-in box shows in each state. Reads the files only.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const index = read("index.html"), rider = read("rider-app.js"), riderHtml = read("rider.html");
const ok = (m) => console.log("ok - " + m);

// 1. The rider app: one address for signing in, used everywhere.
{
  assert.ok(rider.includes('var SIGNIN_URL = "index.html?for=rider#signin";'));
  assert.equal((rider.match(/location\.replace\(SIGNIN_URL\)/g) || []).length, 2, "no session, and after Log out");
  assert.ok(!/location\.replace\("index\.html#signin"\)/.test(rider), "no bare #signin left");
  assert.ok(riderHtml.includes('id="loginLink" href="index.html?for=rider#signin"'), "the gate's Sign in link goes to the same place");
  ok("rider app: every way out to sign in leads to index.html?for=rider#signin");
}

// 2. The note the homepage reads is written for this login only and removed with it.
{
  const store = {}; const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const src = /  function rememberNote\(email\) \{[\s\S]*?\n  \}\n/.exec(rider)[0] + /  function forgetNote\(\) \{[\s\S]*?\n  \}\n/.exec(rider)[0];
  const api = new Function("localStorage", "userId", "riderId", src + "return { rememberNote, forgetNote };");
  const mine = api(ls, "rider-1", "R-9");
  mine.rememberNote("rider@example.com");
  const note = JSON.parse(store.novaxSession);
  assert.equal(note.role + "|" + note.uid + "|" + note.rider_id + "|" + note.email, "rider|rider-1|R-9|rider@example.com");
  api(ls, "someone-else", "R-1").forgetNote();
  assert.ok(store.novaxSession, "another login signing out does not remove this rider's note");
  mine.forgetNote();
  assert.equal(store.novaxSession, undefined, "this rider signing out removes it");
  assert.ok(/authorized = false; forgetNote\(\); location\.replace\(SIGNIN_URL\);/.test(rider), "Log out forgets the note");
  assert.ok(rider.includes('if (event === "SIGNED_OUT") forgetNote();'), "so does a sign-out from another tab");
  assert.ok(rider.includes("rememberNote(s.data.session.user.email);"), "written once the rider is confirmed");
  ok("rider app: writes its note for the homepage, and clears only its own");
}

// 3. The homepage believes the note only when it belongs to the signed-in user.
{
  const blk = index.slice(index.indexOf("/* ═════ ALREADY SIGNED IN ═════"), index.indexOf("/* ═════ PHONE ACTION BAR ═════"));
  assert.ok(blk.includes('var stored=(note.uid && note.uid===s.user.id)?String(note.role||""):"";'), "a note left by someone else on this phone is ignored");
  assert.ok(blk.includes('stored==="rider"?"rider.html"') && blk.includes('role==="rider"?"rider.html"'), "a rider goes to the rider app, by the note and by the profile");
  assert.ok(!/:"client\.html";\s*\n\s*\/\* The note in this browser can be stale/.test(blk) && blk.includes('stored==="client"?"client.html":"";'), "with no note it does not guess the merchant portal");
  assert.ok(blk.includes('if(st==="blocked"||st==="disabled"){ unpoint(); return; }'), "a blocked login is not sent anywhere");
  assert.deepEqual(JSON.parse(/var IDS=(\[[^\]]+\]);/.exec(blk)[1]), ["hdrSignin", "menuSignin", "ftSignin", "heroSignin", "barSignin"]);
  for (const id of ["hdrSignin", "menuSignin", "ftSignin", "heroSignin", "barSignin", "signinTitle", "signinSub", "signinAlready", "signinAlreadyT", "signinAlreadyGo", "signinAlreadyOther", "signinNote", "fSignin"])
    assert.equal(index.split('id="' + id + '"').length - 1, 1, id + " exists once");
  ok("homepage: Sign in buttons follow the signed-in login, not a stale note");
}

// 4. The sign-in box, run with the page's own function in each state.
{
  const fn = /function nvSigninPaint\(\)\{[\s\S]*?\n\}\n/.exec(index)[0], words = /var NV_PORTAL_WORDS=\{[\s\S]*?\};/.exec(index)[0];
  const mk = (forWho, signed, other, typed) => {
    const els = {}; const el = (id) => (els[id] = els[id] || { id, hidden: false, textContent: "", value: "", attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); this.textContent += c.textContent; } });
    el("signinPassword").value = typed || "";
    const doc = { createTextNode: (t) => ({ textContent: t }), createElement: () => ({ textContent: "" }) };
    new Function("$", "document", "NV_SIGNED", "NV_SIGNIN_OTHER", "NV_SIGNIN_FOR", words + fn + "nvSigninPaint();")((id) => el(id), doc, signed, other, forWho);
    return els;
  };
  let e = mk("", null, false);
  assert.equal(e.signinTitle.textContent + "|" + e.fSignin.hidden + "|" + e.signinAlready.hidden + "|" + e.signinNote.hidden, "Sign in|false|true|false", "a visitor sees the usual form");
  e = mk("rider", null, false);
  assert.equal(e.signinTitle.textContent, "Rider sign in");
  assert.equal(e.signinSub.textContent, "Use the email and password the NovaX office gave you.");
  assert.equal(e.signinEmail.attrs.placeholder + "|" + e.signinNote.hidden, "Your email|true", "no merchant wording for a rider");
  e = mk("rider", { email: "rider@example.com", target: "rider.html" }, false);
  assert.equal(e.signinTitle.textContent + "|" + e.fSignin.hidden + "|" + e.signinAlready.hidden, "You are signed in|true|false", "a signed-in rider is not shown an empty form");
  assert.equal(e.signinAlreadyGo.attrs.href + "|" + e.signinAlreadyGo.textContent, "rider.html|Open the rider app");
  e = mk("", { email: "shop@example.com", target: "client.html" }, false);
  assert.equal(e.signinAlreadyGo.attrs.href + "|" + e.signinAlreadyGo.textContent, "client.html|Open your portal", "the same for a merchant");
  e = mk("", { email: "a@b.pk", target: "rider.html" }, true);
  assert.equal(e.fSignin.hidden + "|" + e.signinAlready.hidden, "false|true", "\"Sign in with another account\" brings the form back");
  e = mk("", { email: "a@b.pk", target: "rider.html" }, false, "secret");
  assert.equal(e.fSignin.hidden, false, "the form is never pulled away from someone typing a password");
  assert.ok(index.includes('if(k==="signin"){ NV_SIGNIN_OTHER=false; try{ nvSigninPaint(); }catch(e){} }'), "painted every time the box opens");
  assert.ok(!index.includes("Checking database"), "no developer wording on the button");
  ok("sign-in box: visitor, rider, already signed in, another account, mid-typing");
}
console.log("SIGN-IN SYNC CHECKS PASSED");
