(function (global) {
  "use strict";
  var ACTIONS = {
    "New booked": ["Collected by rider"],
    "Collected by rider": ["Arrived at warehouse"],
    "Parcel now in transit": ["Parcel received at destination"],
    "Parcel received at destination": ["Parcel out for delivery"],
    Reattempt: ["Parcel out for delivery"],
    Reassigned: ["Parcel out for delivery"],
    "Parcel out for delivery": ["Delivered", "Refused", "Consignee not available"],
    "Ready for return": ["Return in transit"],
    "Return in transit": ["Return received at origin"],
    "Return received at origin": ["Return out for delivery"],
    "Return out for delivery": ["Return to shipper", "Consignee not available"]
  };
  function object(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  function timestamp(v) {
    if (!v) return NaN;
    var s = String(v);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(s)) s = s.replace(" ", "T") + "+05:00";
    return new Date(s).getTime();
  }
  function day(v) {
    var ms = timestamp(v);
    if (!isFinite(ms)) return "";
    var parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
    var values = {}; parts.forEach(function (p) { values[p.type] = p.value; });
    return values.year + "-" + values.month + "-" + values.day;
  }
  function truth(v) { return v === true || v === "true"; }
  function awbs(v) {
    var seen = new Set();
    return String(v || "").toUpperCase().split(/[\s,;]+/).filter(function (x) {
      if (!x || seen.has(x)) return false; seen.add(x); return true;
    });
  }
  function deliveredAt(p) {
    if (p.deliveredAt) return p.deliveredAt;
    var rows = Array.isArray(p.meta.processHistory) ? p.meta.processHistory : [];
    var h = rows.filter(function (x) { return x && (x.status || x.to) === "Delivered" && x.at; });
    return h.length ? h[h.length - 1].at : p.updatedAt;
  }
  function phone(v) {
    var d = String(v || "").replace(/\D/g, "");
    if (/^\s*\+/.test(String(v)) && !/^92/.test(d)) return "+" + d;
    if (/^0092/.test(d)) d = d.slice(4);
    else if (/^92/.test(d) && d.length >= 12) d = d.slice(2);
    else if (/^0/.test(d)) d = d.slice(1);
    return d.length >= 9 ? "+92" + d : d;
  }
  function isOrigin(p) {
    if (p.status === "Consignee not available") {
      var history = Array.isArray(p.meta.processHistory) ? p.meta.processHistory : [];
      var previous = history.slice().reverse().find(function (h) { return h && !["Consignee not available", "Refused"].includes(h.status || h.to); });
      if (previous && /return/i.test(previous.status || previous.to || "")) return true;
    }
    return ["New booked", "Collected by rider"].indexOf(p.status) >= 0 || /return/i.test(p.status);
  }
  function mapParcel(p) {
    return { id: p.id, awb: String(p.awb || ""), clientId: p.client_id,
      consignee: p.consignee || "", phone: p.phone || "", address: p.address || "", city: p.city || "",
      cod: Number(p.cod_amount || 0), status: p.status || "", meta: object(p.meta),
      statusSince: p.status_since || p.updated_at, updatedAt: p.updated_at, deliveredAt: p.delivered_at };
  }
  function validate(list, to, reason, parcels) {
    var errors = [];
    if (!list.length || list.length > 200) errors.push("Enter between 1 and 200 AWBs.");
    if ((to === "Refused" || to === "Consignee not available") && !String(reason || "").trim()) errors.push("A reason is required.");
    list.forEach(function (code) {
      var p = parcels.find(function (x) { return x.awb.toUpperCase() === code; });
      if (!p) errors.push(code + ": not on your route");
      else if (p.status !== to && (ACTIONS[p.status] || []).indexOf(to) < 0) errors.push(code + ": cannot move from " + p.status + " to " + to);
      else if (to === "Delivered" && global.NovaXPayment.isConflict({ cod: p.cod, paymentMode: p.meta.paymentMode || p.meta.payment_mode })) errors.push(code + ": COD/prepaid conflict. Contact the office.");
    });
    return errors;
  }
  function Queue(storage, user, rider) {
    this.storage = storage; this.user = user; this.rider = rider;
    this.key = "novaxRiderQueue:v2:" + user + ":" + rider;
  }
  Queue.prototype.read = function () {
    var value;
    try { value = JSON.parse(this.storage.getItem(this.key) || "[]"); }
    catch (_) { throw new Error("Saved updates are unreadable. Contact the office before clearing this phone."); }
    if (!Array.isArray(value)) throw new Error("Saved updates are unreadable. Contact the office before clearing this phone.");
    return value.filter(function (x) { return x && x.user === this.user && x.rider === this.rider; }, this);
  };
  Queue.prototype.write = function (rows) {
    this.storage.setItem(this.key, JSON.stringify(rows));
    if (this.storage.getItem(this.key) !== JSON.stringify(rows)) throw new Error("This phone cannot save updates safely.");
  };
  Queue.prototype.add = function (job) {
    var rows = this.read();
    if (rows.length >= 200) throw new Error("200 saved updates are waiting. Reconnect before adding more.");
    job.user = this.user; job.rider = this.rider;
    rows.push(job); this.write(rows); return job;
  };
  Queue.prototype.change = function (key, patch) {
    this.write(this.read().map(function (x) { return x.key === key ? Object.assign({}, x, patch) : x; }));
  };
  Queue.prototype.remove = function (key) { this.write(this.read().filter(function (x) { return x.key !== key; })); };
  function overlay(parcels, jobs) {
    var rows = parcels.map(function (p) { return Object.assign({}, p); });
    jobs.filter(function (j) { return j.kind === "status" && j.state !== "review"; }).forEach(function (j) {
      j.list.forEach(function (code) {
        var p = rows.find(function (x) { return x.awb.toUpperCase() === code; });
        if (p && p.status !== j.to && (ACTIONS[p.status] || []).indexOf(j.to) >= 0) {
          p.status = j.to; p.pending = true; p.pendingAt = j.at;
        }
      });
    });
    return rows;
  }
  function retryable(e) {
    var code = String(e && e.code || ""), status = Number(e && e.status || 0);
    return /fetch|network|timeout|abort|failed to send/i.test(String(e && e.message || e)) ||
      [408, 429, 500, 502, 503, 504].indexOf(status) >= 0 || /^(08|40|53|57)/.test(code) || code === "PGRST000";
  }
  global.NovaXRider = { ACTIONS: ACTIONS, object: object, timestamp: timestamp, day: day, truth: truth,
    awbs: awbs, deliveredAt: deliveredAt, phone: phone, isOrigin: isOrigin, mapParcel: mapParcel,
    validate: validate, Queue: Queue, overlay: overlay, retryable: retryable };
})(typeof window !== "undefined" ? window : globalThis);
