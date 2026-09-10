import { mapOrderToBooking, normalizePhone, codAmount, weightFromOrder }
  from "../orders.ts";

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) pass++; else { fail++; console.log("  FAIL:", n, extra ?? ""); } };

// ---- phone normalisation --------------------------------------------------
const phones = [
  ["+92 300 1234567", "03001234567"], ["03001234567", "03001234567"],
  ["923001234567", "03001234567"],    ["00923001234567", "03001234567"],
  ["3001234567", "03001234567"],      ["+92-300-1234567", "03001234567"],
  ["0300 123 4567", "03001234567"],   ["(0300) 1234567", "03001234567"],
  ["0345 9876543", "03459876543"],
  // rejects
  ["021 34567890", ""],   // landline, not a mobile
  ["0300123456", ""],     // one digit short
  ["030012345678", ""],   // one digit long
  ["", ""], [null, ""], [undefined, ""], ["abc", ""], ["+1 555 123 4567", ""],
];
for (const [inp, want] of phones) {
  const got = normalizePhone(inp);
  t(`phone ${JSON.stringify(inp)} -> ${JSON.stringify(want)}`, got === want, `got ${JSON.stringify(got)}`);
}

// ---- COD amount -----------------------------------------------------------
t("cod: prefers total_outstanding",
  codAmount({ id: 1, total_outstanding: "1200.00", current_total_price: "1400.00", total_price: "1500.00" }) === 1200);
t("cod: falls back to current_total_price (edited order)",
  codAmount({ id: 1, current_total_price: "1400.00", total_price: "1500.00" }) === 1400);
t("cod: falls back to total_price",
  codAmount({ id: 1, total_price: "1500.00" }) === 1500);
t("cod: negative clamped to 0", codAmount({ id: 1, total_outstanding: "-50" }) === 0);
t("cod: missing everything -> 0", codAmount({ id: 1 }) === 0);

// ---- weight ---------------------------------------------------------------
t("weight: sums grams x qty",
  weightFromOrder({ id: 1, line_items: [{ grams: 400, quantity: 2 }, { grams: 300, quantity: 1 }] }, "0.8 kg") === "1.1 kg");
t("weight: rounds up to 100g",
  weightFromOrder({ id: 1, line_items: [{ grams: 1010, quantity: 1 }] }, "0.8 kg") === "1.1 kg");
t("weight: floor of 0.5kg",
  weightFromOrder({ id: 1, line_items: [{ grams: 50, quantity: 1 }] }, "0.8 kg") === "0.5 kg");
t("weight: zero grams -> fallback",
  weightFromOrder({ id: 1, line_items: [{ grams: 0, quantity: 1 }] }, "0.8 kg") === "0.8 kg");
t("weight: no line items -> fallback", weightFromOrder({ id: 1 }, "0.8 kg") === "0.8 kg");
t("weight: ignores non-shipping items",
  weightFromOrder({ id: 1, line_items: [{ grams: 500, quantity: 1, requires_shipping: false }, { grams: 600, quantity: 1 }] }, "0.8 kg") === "0.6 kg");

// ---- the mapping ----------------------------------------------------------
const base = {
  id: 5001, name: "#1043", financial_status: "pending", total_price: "1400.00",
  shipping_address: { name: "Huzaifa Ahmed", address1: "C836 pehlwan goth Block 9",
                      address2: "near Tuba public school", city: "Karachi", phone: "+92 300 1234567" },
  line_items: [{ grams: 800, quantity: 1 }],
};

{
  const r = mapOrderToBooking(base);
  t("book: happy path books", r.action === "book", JSON.stringify(r));
  if (r.action === "book") {
    const b = r.booking;
    t("book: consignee", b.consignee === "Huzaifa Ahmed", b.consignee);
    t("book: phone normalised", b.phone === "03001234567", b.phone);
    t("book: cod", b.cod === 1400, String(b.cod));
    t("book: payment mode COD", b.paymentMode === "COD");
    t("book: address joined", b.address === "C836 pehlwan goth Block 9, near Tuba public school", b.address);
    t("book: city", b.city === "Karachi");
    t("book: weight", b.weight === "0.8 kg", b.weight);
    t("book: order id is the shopify name", b.orderId === "#1043", b.orderId);
    t("book: reference is the shopify id", b.referenceNo === "5001", b.referenceNo);
  }
}

// name assembled from first/last when `name` is absent
{
  const r = mapOrderToBooking({ ...base, shipping_address: { ...base.shipping_address, name: null, first_name: "Aun", last_name: "Mehdi" } });
  t("book: name from first+last", r.action === "book" && r.booking.consignee === "Aun Mehdi");
}
// phone fallback chain
{
  const r = mapOrderToBooking({ ...base, shipping_address: { ...base.shipping_address, phone: null }, phone: null, customer: { phone: "0345 9876543" } });
  t("book: falls back to customer phone", r.action === "book" && r.booking.phone === "03459876543");
}
// landline on address, good mobile on customer -> must use the mobile
{
  const r = mapOrderToBooking({ ...base, shipping_address: { ...base.shipping_address, phone: "021 34567890" }, customer: { phone: "03001112223" } });
  t("book: skips unusable phone for a usable one", r.action === "book" && r.booking.phone === "03001112223",
    r.action === "book" ? r.booking.phone : r.reason);
}

// ---- every skip path ------------------------------------------------------
const skips = [
  ["test order",            { ...base, test: true },                                    /test order/i],
  ["cancelled",             { ...base, cancelled_at: "2026-08-20T10:00:00Z" },          /cancelled/i],
  ["already fulfilled",     { ...base, fulfillment_status: "fulfilled" },               /already fulfilled/i],
  ["restocked",             { ...base, fulfillment_status: "restocked" },               /already restocked/i],
  ["refunded",              { ...base, financial_status: "refunded" },                  /payment refunded/i],
  ["voided",                { ...base, financial_status: "voided" },                    /payment voided/i],
  ["no shipping address",   { ...base, shipping_address: null },                        /no shipping address/i],
  ["all digital",           { ...base, line_items: [{ grams: 0, quantity: 1, requires_shipping: false }] }, /requires shipping/i],
  ["no name",               { ...base, shipping_address: { ...base.shipping_address, name: null, first_name: null, last_name: null } }, /no name/i],
  ["no city",               { ...base, shipping_address: { ...base.shipping_address, city: "" } },          /no city/i],
  ["no street",             { ...base, shipping_address: { ...base.shipping_address, address1: "", address2: "" } }, /no street/i],
  ["no usable phone",       { ...base, shipping_address: { ...base.shipping_address, phone: "021 34567890" }, phone: null, customer: null }, /mobile number/i],
  ["prepaid by default",    { ...base, financial_status: "paid" },                      /already paid online/i],
  ["cod with nothing due",  { ...base, total_outstanding: "0.00" },                     /nothing left to collect/i],
];
for (const [name, order, re] of skips) {
  const r = mapOrderToBooking(order);
  t(`skip: ${name}`, r.action === "skip" && re.test(r.reason), JSON.stringify(r));
}

// prepaid IS booked when the merchant opts in, at cod 0
{
  const r = mapOrderToBooking({ ...base, financial_status: "paid" }, { bookPrepaid: true });
  t("prepaid: booked when enabled", r.action === "book" && r.booking.cod === 0 && r.booking.paymentMode === "Prepaid",
    JSON.stringify(r));
}
// partially paid -> collect only the outstanding balance
{
  const r = mapOrderToBooking({ ...base, financial_status: "partially_paid", total_outstanding: "400.00" });
  t("partially paid: collects the balance only", r.action === "book" && r.booking.cod === 400,
    r.action === "book" ? String(r.booking.cod) : r.reason);
}
// every skip must carry a human reason -- silence is the rivals' failure mode
{
  const all = skips.map(([, o]) => mapOrderToBooking(o));
  t("every skip has a non-empty reason", all.every(r => r.action === "skip" && r.reason.trim().length > 8));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
