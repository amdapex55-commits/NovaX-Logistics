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
  {awb:"LATE",clientId:"merchant-1",status:"Parcel now in transit",statusSince:old,statusAgeHours:0,address:"123 Main Rd",phone:"03001234567"},
  {awb:"ADDRESS",clientId:"merchant-1",status:"New booked",address:"Address pending",phone:"03001234567"},
  {awb:"PHONE",clientId:"merchant-1",status:"New booked",address:"123 Main Rd",phone:"---"},
  /* Rescanned an hour ago -- so NOT late by the status clock -- but sitting in
     the destination city for three days. The cockpit used to carry this case in
     a second set of its own, which is how "35 need attention" and "38 need you"
     ended up on one screen. One predicate now, so it has to come out here. */
  {awb:"STALLED",clientId:"merchant-1",status:"Parcel received at destination",
   statusSince:new Date(now-1*3600e3).toISOString(),bookedAt:new Date(now-72*3600e3).toISOString(),
   address:"123 Main Rd",phone:"03001234567"},
];
const scope={state:{client:{id:"merchant-1"},parcels},window:{},isRiderCashHolding:()=>false,
  destinationArrivalAt:()=>null,Date,Number,String,Set,Object,Math,isFinite};
vm.createContext(scope);
vm.runInContext(section("    var NV_CONCLUDED_STATUSES=", "    /* Money actually received"),scope);
/* agingHours/nvOutcomeSettled live between the two sections below and are
   called by nvAttentionParcels, so the sandbox has to hold the real ones. */
vm.runInContext(section("    var NV_OUTCOME_SETTLED=", "    /* Merchant view exposes destination aging only"),scope);
vm.runInContext(section("    function nvMissingDeliveryInfo(p){", "    function dailyCommandData(){"),scope);
assert.equal(scope.nvParcelDelayed(parcels[3]),true,"delay advances from the status timestamp, not cached age");
assert.equal(scope.nvParcelDelayed(parcels[1]),false,"cancelled parcels are not delayed");
assert.equal(scope.nvParcelDelayed(parcels[6]),false,"a parcel rescanned an hour ago is not late by the status clock");
assert.deepEqual(Array.from(scope.nvAttentionParcels(),p=>p.awb).sort(),["ADDRESS","LATE","PHONE","RETURNED","STALLED"],"one consistent attention set includes missing details, returns and 48h stalls, without terminal delays");
/* #22: the order the cockpit and the Action needed card both show. */
assert.deepEqual(Array.from(scope.nvAttentionSorted(scope.nvAttentionParcels()),p=>p.awb).slice(0,2),["ADDRESS","PHONE"],"parcels the merchant must fix first are ranked first");
console.log("ok - attention set, terminal states, and live delay age remain consistent");
