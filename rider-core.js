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
  /* A shipper's address that names another city. Sign-up asks for the pickup
     city and the address separately; on 8 Oct 2026 a Korangi (Karachi)
     merchant picked Lahore, and the parcel sat in the Lahore rider's pickup
     list for three days. Area names only -- the lists the booking form warns
     with (client-app.js NV_CITY_MARKERS_C) minus sector codes such as "F-10",
     which are house numbers everywhere else. Earliest match wins, then the
     longest: "Johar Town" is Lahore, "Gulistan-e-Johar" is Karachi. */
  var CITY_MARKERS = {
    Karachi: ["gulistan-e-jauhar", "gulistan-e-johar", "gulistan e johar", "gulistan e jauhar", "gulstan-e-johar", "gulstan e johar",
      "gulishtan-e-johar", "gulshan-e-johar", "johar block", "jauhar block", "gulshan-e-iqbal", "gulshan e iqbal", "gulshan block",
      "korangi", "nazimabad", "malir", "landhi", "orangi", "liaquatabad", "shah faisal", "lyari", "saddar karachi", "defence karachi",
      "dha karachi", "clifton", "baldia", "gadap", "surjani", "north karachi", "federal b area", "f.b area", "saadabad", "karachi"],
    Lahore: ["johar town", "model town", "gulberg lahore", "dha lahore", "defence lahore", "iqbal town", "wapda town", "faisal town",
      "garden town", "township lahore", "cantt lahore", "lahore"],
    Islamabad: ["islamabad", "blue area"],
    Rawalpindi: ["rawalpindi", "satellite town", "chaklala", "westridge", "pindi"],
    /* New stations, 17 Oct 2026 (same lists as the portal). */
    Faisalabad: ["faisalabad", "faisal abad", "lyallpur"],
    Multan: ["multan"],
    Sahiwal: ["sahiwal"],
    Okara: ["okara"],
    Chichawatni: ["chichawatni", "chicha watni"],
    Harappa: ["harappa", "harrapa", "harapa"],
    "Yousuf Wala": ["yousuf wala", "yousufwala", "yousaf wala", "yousafwala", "yusuf wala"],
    "Adda Gamber": ["adda gamber", "adda gambar", "gamber", "gambar"]
  };
  function cityFromAddress(addr) {
    var a = String(addr || "").toLowerCase().replace(/\s+/g, " "), best = "", bestAt = Infinity, bestLen = 0;
    if (!a.trim()) return "";
    Object.keys(CITY_MARKERS).forEach(function (city) {
      CITY_MARKERS[city].forEach(function (m) {
        var at = a.indexOf(m);
        /* A town name followed by "road"/"bypass" is a street: "Multan Road" runs through Lahore. */
        while (at > -1 && m === city.toLowerCase() && /^\s*(road|rd\b|bypass)/.test(a.slice(at + m.length))) at = a.indexOf(m, at + 1);
        if (at > -1 && (at < bestAt || (at === bestAt && m.length > bestLen))) { best = city; bestAt = at; bestLen = m.length; }
      });
    });
    return best;
  }
  /* The other city an address points to, or "" when it names one of the
     rider's own cities or no city at all. It only ever warns. */
  function wrongCity(addr, cities) {
    var a = String(addr || "").toLowerCase(), mine = (cities || []).map(function (c) { return String(c || "").toLowerCase().trim(); }).filter(Boolean);
    if (!mine.length || mine.some(function (c) { return a.indexOf(c) > -1; })) return "";
    var looks = cityFromAddress(a);
    return looks && mine.indexOf(looks.toLowerCase()) < 0 ? looks : "";
  }
  /* What the Directions button sends to Google Maps (14 Oct 2026).
     The whole typed address went in as a search, and the house and street
     numbers decided the answer: "H No 123 St No 45 F11,3 Islamabad" opened
     Street 45 in G-9, another sector, because Google matched the numbers to a
     street it knew. Pakistani addresses are found by their area -- sector,
     block, phase, society, road, chowk -- and the rider finds the door by
     asking or calling. So the house, flat, plot and street numbers are taken
     out, phone numbers and repeats dropped, Islamabad sectors written the
     way maps know them (F-11/3), and the city and country put on the end
     once. If nothing is left but numbers, the cleaned full address is used. */
  function mapsQuery(address, city) {
    var c = String(city || "").trim(), lc = c.toLowerCase();
    var a = String(address || "").replace(/[\r\n;|]+/g, ", ")
      .replace(/(\+?92[\s-]?|0)?3\d{2}[\s-]?\d{7}/g, " ").replace(/\d{10,}/g, " ")
      .replace(/\b(address|addr)\s*[:.]/gi, " ").replace(/\.{2,}/g, ", ").replace(/\s+/g, " ");
    if (/^(islamabad|rawalpindi)$/.test(lc) || /islamabad/i.test(a))
      a = a.replace(/\b([DEFGHI])\s*[-.]?\s*(\d{1,2})(?:\s*[\/,\-]\s*(\d))?\b/g, function (m, l, n, sub) {
        n = Number(n); return n >= 5 && n <= 17 ? l.toUpperCase() + "-" + n + (sub ? "/" + sub : "") : m;
      }).replace(/\bsector\s+(?=[DEFGHI]-\d)/gi, "");
    var drop = /^(pakistan|punjab|sindh|(islamabad )?capital territory|ict|\d{5})$/i, seen = {};
    /* The city goes on the end once. Only a trailing "... lahore" is taken off a
       part: "Lahore Road" or "Multan Road" is a road, not the city. */
    var own = lc ? new RegExp("\\s+" + lc.replace(/[^a-z ]/g, "") + "$", "i") : null;
    var parts = a.split(",").map(function (part) {
      return part
        .replace(/\b(house|home|h)\s*(no|number|num)?\s*[.#:]*\s*[a-z]?\d+[a-z]?(\s*[-\/]\s*[a-z0-9]+)?\b/gi, " ")
        .replace(/\b(house|h)\s*(no|number|#)\s*[.#:]*\s*([a-z]{1,4}\b\s*\d*[a-z]?)?/gi, " ")   /* "House No E", "house no ram 5" */
        .replace(/\b(flat|apartment|apt|plot|shop|office|unit|room|portion|building|bldg)\s*(no|number)?\s*[-.#:]*\s*[a-z]?\d+[a-z]?\b/gi, " ")
        .replace(/\b(street|st|gali|lane)\s*(no|number)?\s*[-.#:]*\s*[a-z]?\d+[a-z]?\b/gi, " ")
        .replace(/\b\d{5}\b/g, " ").replace(/\s+/g, " ").trim().replace(own || /$^/, "")
        .replace(/\b(ground|first|second|third|fourth|\d+(st|nd|rd|th))\s+floor\b/gi, " ")
        .replace(/\b(near|nearby|opp|opposite|behind|beside|in front of)\b\.?/gi, " ")
        .replace(/\b(phase\s*-?\s*\d+)\s+town\b/gi, "$1")
        .replace(/\s+/g, " ").replace(/^[\s.#:\-\/]+|[\s.#:\-\/]+$/g, "");
    }).filter(function (part) {
      var k = part.toLowerCase();
      if (!part || part.length < 3 || /^[\d\s#\/-]+$/.test(part) || drop.test(part) || k === lc || seen[k]) return false;
      seen[k] = true; return true;
    });
    var tail = (c ? c + ", " : "") + "Pakistan";
    if (!parts.length) {
      var full = a.replace(/\s*,\s*/g, ", ").replace(/^[,\s]+|[,\s]+$/g, "");
      return full ? full + ", " + tail : tail;
    }
    return parts.join(", ") + ", " + tail;
  }
  /* A search, not a route: Maps shows the place it found (a sector, a
     block, a chowk) with its own Directions button, so a wrong guess is seen
     before the rider rides to it. Tested 14 Oct on F-11/3, F-10/2, Sector A
     DHA Phase 6, Askari 11 Sector B, G block DHA Phase 5 and Lajna Chowk:
     each landed on its area. */
  function directionsUrl(address, city) {
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(mapsQuery(address, city));
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
    validate: validate, Queue: Queue, overlay: overlay, retryable: retryable, cityFromAddress: cityFromAddress, wrongCity: wrongCity,
    mapsQuery: mapsQuery, directionsUrl: directionsUrl };
})(typeof window !== "undefined" ? window : globalThis);
