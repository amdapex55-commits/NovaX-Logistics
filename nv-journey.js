/* ═══ One parcel journey for every portal (29 Sep 2026) ═══════════════════
   The client drawer, the client dashboard, admin and the rider app each drew
   a parcel's journey their own way: seven fixed steps in one, fourteen in
   another, all seventeen statuses (return legs included) in admin -- so a
   delivered Karachi parcel read "6/16 steps, 37%" in admin and 7/7 in the
   portal, and a Karachi-to-Karachi parcel showed "In transit" and "At
   destination city" as steps it would never take.

   The path here is the one riders actually scan (status log, last 45 days):
     Karachi to Karachi:  Booked > Picked up > Warehouse > Out for delivery > Delivered
     Intercity:           ... > Warehouse > In transit > At destination > Out for delivery > Delivered
   A reattempt is a second try at "Out for delivery", not a new stage. A
   refusal ends the forward path and starts the way back to the merchant.

   Pure functions, no DOM, no dependencies -- the same file is loaded by
   client.html, admin.html and rider.html.
     NVJourney.steps(p)     -> [{ status, label, state:"done"|"now"|"todo", bad, note }]
     NVJourney.progress(p)  -> { stage, total, pct, step:"3 of 5", label, tone, final }
     NVJourney.label(status)
     NVJourney.lateApplies(p) -> false when a delay is not NovaX's (reattempt,
                               refusal, a return) or the parcel is finished
   p needs status; city, pickupCity and steps (statuses already recorded) make
   it exact. */
(function (root) {
  "use strict";
  if (root.NVJourney) return;

  var LOCAL = ["New booked", "Collected by rider", "Arrived at warehouse", "Parcel out for delivery", "Delivered"];
  var INTER = ["New booked", "Collected by rider", "Arrived at warehouse", "Parcel now in transit",
               "Parcel received at destination", "Parcel out for delivery", "Delivered"];
  var FAIL = ["Refused", "Consignee not available", "Out of service area"];
  var RETURN = ["Ready for return", "Return in transit", "Return received at origin", "Return out for delivery", "Return to shipper"];
  var ATTEMPT = ["Reattempt", "Reassigned"];
  var CANCEL = ["Cancelled by client", "Cancelled"];
  var LABEL = {
    "New booked": "Booked",
    "Collected by rider": "Picked up",
    "Arrived at warehouse": "At NovaX warehouse",
    "Parcel now in transit": "In transit",
    "Parcel received at destination": "At destination city",
    "Parcel out for delivery": "Out for delivery",
    "Delivered": "Delivered",
    "Refused": "Refused by customer",
    "Consignee not available": "Customer not available",
    "Out of service area": "Outside service area",
    "Reattempt": "Delivery reattempt",
    "Reassigned": "Given to another rider",
    "Ready for return": "Return started",
    "Return in transit": "Return in transit",
    "Return received at origin": "Return at origin hub",
    "Return out for delivery": "Return on its way to you",
    "Return to shipper": "Returned to you",
    "Cancelled by client": "Cancelled",
    "Cancelled": "Cancelled"
  };

  function has(list, s) { return list.indexOf(s) > -1; }
  function lower(v) { return String(v == null ? "" : v).trim().toLowerCase(); }
  function recorded(p) {
    var out = [];
    (Array.isArray(p && p.steps) ? p.steps : []).forEach(function (s) { if (s && out.indexOf(s) < 0) out.push(String(s)); });
    (Array.isArray(p && p.processHistory) ? p.processHistory : []).forEach(function (h) {
      var s = h && (h.status || h.to); if (s && out.indexOf(s) < 0) out.push(String(s));
    });
    return out;
  }
  function label(s) { return LABEL[s] || String(s || ""); }

  /* Intercity when it scanned an intercity step, or when pickup and
     destination differ. With no pickup city on record, a non-Karachi
     destination is intercity: 270 of 296 merchants collect in Karachi. */
  function intercity(p, seen) {
    if (has(seen, "Parcel now in transit") || has(seen, "Parcel received at destination")) return true;
    var st = String(p && p.status || "");
    if (st === "Parcel now in transit" || st === "Parcel received at destination") return true;
    var from = lower(p && (p.pickupCity || p.pickup_city)), to = lower(p && p.city);
    if (from && to) return from !== to;
    return !!to && to !== "karachi";
  }
  function row(s, state, extra) {
    var r = { status: s, label: label(s), state: state, bad: false, note: "" };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  function steps(p) {
    var st = String(p && p.status || "New booked"), seen = recorded(p);
    var fwd = intercity(p, seen) ? INTER : LOCAL;

    if (has(CANCEL, st)) return [row("New booked", "done"), row(st, "now", { bad: true, label: "Cancelled" })];

    if (has(fwd, st)) {
      var i = fwd.indexOf(st), last = fwd.length - 1;
      return fwd.map(function (s, k) {
        return row(s, k < i ? "done" : k === i ? (k === last ? "done" : "now") : "todo");
      });
    }
    /* A status from the other path (an intercity scan on a parcel recorded as
       local, or the reverse) still has to land somewhere sensible. */
    if (has(INTER, st)) return steps(Object.assign({}, p, { pickupCity: "Karachi", city: "Lahore", steps: seen.concat(["Parcel now in transit"]) }));

    var ofd = fwd.indexOf("Parcel out for delivery");
    if (has(ATTEMPT, st)) {
      return fwd.map(function (s, k) {
        if (k < ofd) return row(s, "done");
        if (k === ofd) return row(s, "now", { note: st === "Reassigned" ? "Given to another rider for the next attempt" : "Another delivery attempt is scheduled" });
        return row(s, "todo");
      });
    }

    if (has(FAIL, st) || has(RETURN, st)) {
      /* Where it failed: the last forward step it reached. Most refusals are
         at the door, some at the warehouse (Out of service area). */
      var reached = -1;
      fwd.forEach(function (s, k) { if (k < fwd.length - 1 && has(seen, s)) reached = k; });
      if (reached < 0) reached = ofd;
      var out = fwd.slice(0, reached + 1).map(function (s) { return row(s, "done"); });
      var why = has(FAIL, st) ? st : null;
      if (!why) for (var j = seen.length - 1; j >= 0; j--) if (has(FAIL, seen[j])) { why = seen[j]; break; }
      if (has(FAIL, st)) {
        out.push(row(st, "now", { bad: true }));
        out.push(row("Return to shipper", "todo"));
      } else {
        out.push(why ? row(why, "done", { bad: true }) : row("Delivered", "done", { bad: true, label: "Not delivered" }));
        if (st === "Return to shipper") out.push(row(st, "done", { bad: true }));
        else { out.push(row(st, "now", { bad: true })); out.push(row("Return to shipper", "todo")); }
      }
      return out;
    }

    /* Unknown status: say what it is, after the booking. */
    return [row("New booked", "done"), row(st, "now")];
  }

  function progress(p) {
    var rows = steps(p), total = rows.length, now = -1, doneN = 0;
    rows.forEach(function (r, k) { if (r.state === "now") now = k; if (r.state === "done") doneN = k + 1; });
    var stage = now > -1 ? now + 1 : doneN;
    var final = now < 0 && doneN === total;
    var bad = rows.some(function (r) { return r.bad; });
    var cur = rows[(now > -1 ? now : Math.max(0, doneN - 1))] || rows[0];
    return {
      stage: stage, total: total,
      pct: final ? 100 : Math.round((stage / total) * 100),
      step: stage + " of " + total,
      label: cur ? cur.label : "",
      tone: bad ? "bad" : final ? "good" : "info",
      final: final
    };
  }

  function lateApplies(p) {
    var st = String(p && p.status || "");
    if (st === "Delivered" || has(FAIL, st) || has(RETURN, st) || has(ATTEMPT, st) || has(CANCEL, st)) return false;
    return true;
  }

  root.NVJourney = { steps: steps, progress: progress, label: label, lateApplies: lateApplies,
                     LOCAL: LOCAL.slice(), INTER: INTER.slice() };
})(typeof window !== "undefined" ? window : globalThis);
