#!/usr/bin/env node
/* Exercise the live pickup handler's lost-reply path without writing a parcel. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../client-app.js", import.meta.url), "utf8");
const start = source.indexOf("    function requestPickup(){");
const end = source.indexOf("\n    /* Runs each renderer", start);
assert(start >= 0 && end > start, "pickup handler is present");
const handler = source.slice(start, end);
const id = "b8bd7260-b1a4-4d0f-8146-46b2b41a58d8";

async function scenario({ loseInsertReply = false, loseFirstLookup = false, initialCommit = false }) {
  let stored = null, insertCount = 0, lookupCount = 0, releaseCount = 0;
  const toasts = [], insertedIds = [];
  const fields = {
    pickupAddress: { value: "Test warehouse" }, pickupRequestedFor: { value: "" },
    pickupNote: { value: "" }, requestPickupBtn: { disabled: false, textContent: "Request Pickup" },
  };
  const state = { pickupRequests: [] };
  const sb = {
    from(table) {
      assert.equal(table, "pickup_requests");
      return {
        insert(row) {
          insertCount++;
          insertedIds.push(row.id);
          const duplicate = !!stored;
          if (!duplicate && (initialCommit || !loseInsertReply || insertCount > 1))
            stored = { id: row.id, created_at: "2026-09-18T00:00:00Z" };
          return { select() { return { maybeSingle: async () =>
            loseInsertReply && insertCount === 1
              ? { data: null, error: { message: "network timeout" } }
              : duplicate ? { data: null, error: { code: "23505", message: "duplicate key" } }
              : { data: stored, error: null } }; } };
        },
        select() { return { eq() { return this; }, maybeSingle: async () => {
          lookupCount++;
          return loseFirstLookup && lookupCount === 1
            ? { data: null, error: { message: "network timeout" } }
            : { data: stored, error: null };
        } }; },
      };
    },
  };
  const context = vm.createContext({
    state, window: { __nvSb: sb, __novaxIdemKeys: {
      acquire: async () => ({ key: "pickup:" + id, slot: "pickup:hash" }),
      release: () => { releaseCount++; },
    } },
    document: {
      querySelectorAll: () => [{ checked: true, value: "N9000005" }],
      getElementById: key => fields[key] || null,
    },
    activePickupAwbs: () => new Set(), activeClientId: () => "merchant-1",
    renderPickupEligibleList: () => {}, renderPickupRequestList: () => {},
    saveState: () => {}, toast: (message, kind) => toasts.push({ message, kind }),
    Date, Set, Promise, JSON, String, Array, Error,
  });
  vm.runInContext(handler, context, { filename: "client-app.js:requestPickup" });
  context.requestPickup();
  await new Promise(resolve => setTimeout(resolve, 0));
  if (loseFirstLookup) {
    assert.equal(toasts[0]?.kind, "error", "uncertain first attempt is not called a failure");
    assert.equal(releaseCount, 0, "uncertain request retains its durable key");
    context.requestPickup();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(state.pickupRequests.length, 1, "the merchant sees exactly one request");
  assert.equal(toasts.at(-1)?.kind, "success", "confirmed request reports success");
  assert.equal(releaseCount, 1, "confirmed request releases its key");
  assert(insertedIds.every(value => value === id), "retries use the same primary key");
  return { insertCount, lookupCount };
}

await scenario({ loseInsertReply: true, initialCommit: true });
await scenario({ loseInsertReply: true, loseFirstLookup: true, initialCommit: true });
await scenario({ loseInsertReply: true, loseFirstLookup: true });
console.log("ok - pickup lost replies reconcile by durable primary key without duplicate requests");

function section(first, next) {
  const from=source.indexOf(first), to=source.indexOf(next,from);
  assert(from>=0 && to>from, "source section present: "+first);
  return source.slice(from,to);
}
const now=Date.now(), old=new Date(now-25*3600e3).toISOString();
const parcels=[
  {awb:"DELIVERED",clientId:"merchant-1",status:"Delivered",statusSince:old},
  {awb:"CANCELLED",clientId:"merchant-1",status:"Cancelled by client",statusSince:old},
  {awb:"RETURNED",clientId:"merchant-1",status:"Return to shipper",statusSince:old},
  {awb:"LATE",clientId:"merchant-1",status:"Parcel now in transit",statusSince:old,statusAgeHours:0},
  {awb:"ADDRESS",clientId:"merchant-1",status:"New booked",address:"Address pending",phone:"03001234567"},
  {awb:"PHONE",clientId:"merchant-1",status:"New booked",address:"123 Main Rd",phone:"---"},
];
const scope={state:{client:{id:"merchant-1"},parcels},window:{},isRiderCashHolding:()=>false,Date,Number,String,Set,Object};
vm.createContext(scope);
vm.runInContext(section("    var NV_CONCLUDED_STATUSES=", "    /* Money actually received"),scope);
vm.runInContext(section("    function nvMissingDeliveryInfo(p){", "    function dailyCommandData(){"),scope);
assert.equal(scope.nvParcelDelayed(parcels[3]),true,"delay advances from the status timestamp, not cached age");
assert.equal(scope.nvParcelDelayed(parcels[1]),false,"cancelled parcels are not delayed");
assert.deepEqual(Array.from(scope.nvAttentionParcels(),p=>p.awb).sort(),["ADDRESS","LATE","PHONE","RETURNED"],"one consistent attention set includes missing details and returns, without terminal delays");
console.log("ok - attention set, terminal states, and live delay age remain consistent");
