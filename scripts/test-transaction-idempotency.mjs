#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const app = readFileSync(new URL("../client-app.js", import.meta.url), "utf8");
const sql = readFileSync(new URL("../sql_novax_transaction_integrity_20260914.sql", import.meta.url), "utf8");

const helperStart = app.indexOf("window.__novaxIdemKeys = window.__novaxIdemKeys ||");
const helperEnd = app.indexOf("\n\n    let __withdrawInFlight", helperStart);
assert(helperStart > -1 && helperEnd > helperStart, "durable-key helper is present");
const helperSource = app.slice(helperStart, helperEnd) + ";";

const values = new Map();
const localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); }
};

function freshPage() {
  const window = { crypto: webcrypto, TextEncoder, localStorage };
  vm.runInNewContext(helperSource, { window, localStorage, TextEncoder, Uint8Array, Promise, Date, Math });
  return window.__novaxIdemKeys;
}

const client = "test-client";
const sensitivePayload = JSON.stringify([1250, "PK00PRIVATE1234567890", "24h"]);
const firstPage = freshPage();
const first = await firstPage.acquire("payout", client, sensitivePayload);
const samePageRetry = await firstPage.acquire("payout", client, sensitivePayload);
assert.equal(samePageRetry.key, first.key, "same-page retry reuses payout key");

const afterReload = await freshPage().acquire("payout", client, sensitivePayload);
assert.equal(afterReload.key, first.key, "reload retry reuses payout key");
assert(![...values.values()].join("\n").includes("PK00PRIVATE"), "idempotency storage contains no IBAN/customer payload");

const changed = await freshPage().acquire("payout", client, sensitivePayload + "-changed");
assert.notEqual(changed.key, first.key, "different request receives a different key");

firstPage.release(client, first.slot, first.key);
const afterConfirmation = await freshPage().acquire("payout", client, sensitivePayload);
assert.notEqual(afterConfirmation.key, first.key, "confirmed request releases its key");

const bookingStart = app.indexOf("window.__novaxBookParcel=function(o)");
const bookingEnd = app.indexOf("function mapSc", bookingStart);
const booking = app.slice(bookingStart, bookingEnd);
assert(booking.includes('sb.rpc("client_book_parcel_idem"'), "booking uses protected RPC");
assert(!booking.includes("nvLegacyBookCall"), "booking has no legacy fallback");
assert(!booking.includes('sb.rpc("client_book_parcel",'), "booking cannot call unprotected RPC");
assert(app.includes('sbClient.rpc("request_wallet_withdrawal_idem"'), "payout uses protected RPC");

const coreStart = sql.indexOf("create or replace function public.nv_request_wallet_withdrawal_core");
const coreEnd = sql.indexOf("$function$;", coreStart);
const core = sql.slice(coreStart, coreEnd);
const lockAt = core.indexOf("for update;");
const idemAt = core.indexOf("if v_key is not null then", lockAt);
const duplicateAt = core.indexOf("if exists (", idemAt);
assert(lockAt > -1 && idemAt > lockAt && duplicateAt > idemAt,
  "wallet lock precedes idempotency and duplicate checks");
assert(sql.includes("withdrawals_client_request_key_uidx"), "payout request key is database-unique");
assert(sql.includes("update public.clients") && sql.includes("insert into public.withdrawals") && sql.includes("insert into public.wallet_ledger"),
  "wallet debit, withdrawal, and ledger writes share the RPC transaction");

console.log("ok - durable booking/payout keys survive reload without storing PII");
console.log("ok - unsafe client RPC fallbacks are absent");
console.log("ok - wallet lock precedes payout checks and request keys are unique");
