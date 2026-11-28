/* ═══ One set of sample parcels for every preview (28 Nov 2026) ═══════════
   The merchant preview (client.html?demo=1), the rider preview
   (rider.html?demo=1) and the customer tracker (tracking.html?demo=1&awb=…)
   used to invent their own parcels. The same AWB, N9000002, was Bilal Ahmed
   in DHA Karachi in the merchant preview and somebody else in Lahore in the
   rider preview, and the tracker could not open it at all. An app reviewer
   following one parcel from merchant to rider to customer hit three stories.

   This file is the one story. Sana's Closet ships from Karachi; three of its
   parcels go to Lahore, where the Demo Rider works:
     N9000002  out for delivery with the Demo Rider   (rider: Delivery tab)
     N9000003  in transit, in the Karachi-Lahore sack  (rider: Receive tab)
     N9000004  refused at the door, back at the station (rider: Station)
   The other four are Karachi parcels the Lahore rider never sees.

   client-app.js keeps its own copy of these seven parcels (it is bundled and
   loads for every merchant); scripts/test-demo-dataset.mjs fails the build
   if the two ever disagree. Nothing here is real: every name, phone number
   and address is made up, and nothing that reads this file talks to NovaX.

   A preview opens ONLY from ?demo=1, never from the AWB alone: nv_next_awb()
   numbers a merchant's parcels N + the last three digits of its client id,
   so a merchant whose id ends in 900 would get a real N9000002 one day.

   journey: [status, hours ago] oldest first; ages match client-app.js. */
(function (root) {
  "use strict";
  if (root.NVDemo) return;
  var SHIPPER = { name: "Sana's Closet", phone: "0300-0000000", address: "Shop 14, Tariq Road, Karachi", city: "Karachi" };
  var RIDER = "Demo Rider";
  var PARCELS = [
    { awb: "N9000001", status: "Delivered", consignee: "Hina Raza", phone: "0300-0000001", city: "Karachi",
      address: "Flat 3B, Block 7, Gulshan-e-Iqbal, Karachi", cod: 3450, kg: "0.5 kg",
      journey: [["New booked", 120], ["Collected by rider", 118], ["Arrived at warehouse", 116], ["Parcel out for delivery", 8], ["Delivered", 6]] },
    { awb: "N9000002", status: "Parcel out for delivery", consignee: "Bilal Ahmed", phone: "0300-0000002", city: "Lahore",
      address: "House 21, Phase 5, DHA, Lahore", cod: 1899, kg: "1 kg",
      journey: [["New booked", 48], ["Collected by rider", 45], ["Arrived at warehouse", 43], ["Parcel now in transit", 40],
                ["Parcel received at destination", 14], ["Parcel out for delivery", 2]] },
    { awb: "N9000003", status: "Parcel now in transit", consignee: "Ayesha Siddiqui", phone: "0300-0000003", city: "Lahore",
      address: "House 8, Block C, Johar Town, Lahore", cod: 2750, kg: "0.5 kg",
      journey: [["New booked", 24], ["Collected by rider", 21], ["Arrived at warehouse", 19], ["Parcel now in transit", 5]] },
    { awb: "N9000004", status: "Refused", consignee: "Usman Tariq", phone: "0300-0000004", city: "Lahore",
      address: "House 44, Model Town, Lahore", cod: 1200, kg: "0.5 kg",
      exception: "Consignee refused at doorstep - asked to reattempt Saturday",
      journey: [["New booked", 72], ["Collected by rider", 69], ["Arrived at warehouse", 67], ["Parcel now in transit", 64],
                ["Parcel received at destination", 40], ["Parcel out for delivery", 22], ["Refused", 20]] },
    { awb: "N9000005", status: "New booked", consignee: "Maryam Khan", phone: "0300-0000005", city: "Karachi",
      address: "Flat 12, Clifton Block 2, Karachi", cod: 4300, kg: "1.5 kg",
      journey: [["New booked", 3]] },
    { awb: "N9000006", status: "Delivered", consignee: "Zara Malik", phone: "0300-0000006", city: "Karachi",
      address: "House 8, Block 13D, Gulshan-e-Iqbal, Karachi", cod: 2750, kg: "0.5 kg",
      journey: [["New booked", 168], ["Collected by rider", 165], ["Arrived at warehouse", 162], ["Parcel out for delivery", 82], ["Delivered", 78]] },
    { awb: "N9000007", status: "Delivered", consignee: "Omar Sheikh", phone: "0300-0000007", city: "Karachi",
      address: "Flat 5, Bahadurabad, Karachi", cod: 2500, kg: "0.5 kg",
      journey: [["New booked", 168], ["Collected by rider", 165], ["Arrived at warehouse", 162], ["Parcel out for delivery", 81], ["Delivered", 77]] }
  ];
  function byAwb(awb) {
    var a = String(awb || "").toUpperCase();
    for (var i = 0; i < PARCELS.length; i++) if (PARCELS[i].awb === a) return PARCELS[i];
    return null;
  }
  /* The row the customer tracker renders, shaped like public_track_parcel():
     the tokenised link a seller sends, so the preview shows the full page. */
  function trackRow(awb, now) {
    var p = byAwb(awb); if (!p) return null;
    now = now || Date.now();
    var at = function (h) { return new Date(now - h * 36e5).toISOString(); };
    var last = p.journey[p.journey.length - 1], moving = ["Parcel out for delivery", "Delivered"].indexOf(p.status) > -1;
    return {
      awb: p.awb, status: p.status, origin_city: SHIPPER.city, destination_city: p.city, city: p.city,
      consignee_first: p.consignee.split(" ")[0], cod_amount: p.cod, rider_first: moving ? RIDER : "",
      exception_note: p.exception || "", updated_at: at(last[1]),
      delivered_at: p.status === "Delivered" ? at(last[1]) : null,
      journey: p.journey.map(function (j) { return { status: j[0], at: at(j[1]) }; })
    };
  }
  root.NVDemo = { shipper: SHIPPER, rider: RIDER, parcels: PARCELS, byAwb: byAwb, trackRow: trackRow };
})(typeof window !== "undefined" ? window : globalThis);
