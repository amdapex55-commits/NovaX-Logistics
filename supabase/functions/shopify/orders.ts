// ---------------------------------------------------------------------------
// Turning a Shopify order into a NovaX booking.
//
// Pure functions on purpose: this is the part that decides whether a merchant's
// customer gets a parcel, and it must be testable without a network, a
// database, or a Shopify account.
//
// The single loudest complaint about every rival app in this market is
// "not syncing orders". Most of that is silent skipping. So every skip here
// returns an explicit reason, and that reason is stored on the order row and
// shown to the merchant. An order we chose not to book is never invisible.
// ---------------------------------------------------------------------------

export interface ShopifyAddress {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country_code?: string | null;
  phone?: string | null;
}

export interface ShopifyOrder {
  id: number | string;
  name?: string | null;
  order_number?: number | null;
  test?: boolean;
  cancelled_at?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  total_price?: string | null;
  current_total_price?: string | null;
  total_outstanding?: string | null;
  currency?: string | null;
  phone?: string | null;
  note?: string | null;
  shipping_address?: ShopifyAddress | null;
  customer?: { phone?: string | null; email?: string | null } | null;
  line_items?: Array<{ grams?: number | null; quantity?: number | null; requires_shipping?: boolean | null }> | null;
  // Read only by the booking rules below.
  tags?: string | string[] | null;
  gateway?: string | null;
  payment_gateway_names?: string[] | null;
  location_id?: number | string | null;
  shipping_lines?: Array<{ title?: string | null; code?: string | null }> | null;
}

/** The merchant's booking rules, as stored on nvsh_shop. A null array means
 *  "no restriction" -- an empty array would otherwise read as "allow nothing",
 *  which is the same mistake as an empty allowlist in a firewall. */
export interface BookingRules {
  booking_mode?: string | null;
  rule_require_confirmed?: boolean | null;
  rule_payment_modes?: string[] | null;
  rule_shipping_names?: string[] | null;
  rule_location_ids?: string[] | null;
  rule_exclude_tags?: string[] | null;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

function orderTags(order: ShopifyOrder): string[] {
  const t = order.tags;
  if (Array.isArray(t)) return t.map(norm).filter(Boolean);
  return String(t ?? "").split(",").map(norm).filter(Boolean);
}

function orderGateways(order: ShopifyOrder): string[] {
  const g = [order.gateway, ...(order.payment_gateway_names ?? [])];
  return g.map(norm).filter(Boolean);
}

/**
 * Why this order should NOT be booked automatically, or null to go ahead.
 *
 * Returns a reason a merchant can read, not a rule id: the whole point of
 * holding an order is that a human then decides, and they cannot decide from
 * "rule 3 matched".
 */
export function holdReason(order: ShopifyOrder, rules: BookingRules): string | null {
  const tags = orderTags(order);
  const excluded = (rules.rule_exclude_tags ?? []).map(norm).filter(Boolean);
  const hit = excluded.find((t) => tags.includes(t));
  if (hit) return `Order is tagged "${hit}", which you have excluded from automatic booking.`;

  if (rules.rule_require_confirmed) {
    // Shopify has no "confirmed" flag on the REST order; paid or partially
    // paid is the closest honest reading, and COD orders are pending by
    // design -- which is why this is off unless a merchant turns it on.
    const fin = norm(order.financial_status);
    if (fin !== "paid" && fin !== "partially_paid") {
      return `Payment is ${fin || "not recorded"}, and you only auto-book confirmed orders.`;
    }
  }

  const modes = rules.rule_payment_modes;
  if (modes && modes.length) {
    const want = modes.map(norm);
    const have = orderGateways(order);
    if (!have.some((g) => want.some((w) => g.includes(w)))) {
      return `Paid by ${have.join(", ") || "an unrecorded method"}, which is not in your allowed payment methods.`;
    }
  }

  const ships = rules.rule_shipping_names;
  if (ships && ships.length) {
    const want = ships.map(norm);
    const have = (order.shipping_lines ?? []).map((l) => norm(l.title ?? l.code));
    if (!have.some((h) => want.some((w) => h.includes(w)))) {
      return `Shipping method ${have.join(", ") || "is not set"}, which is not in your allowed methods.`;
    }
  }

  const locs = rules.rule_location_ids;
  if (locs && locs.length) {
    const have = String(order.location_id ?? "");
    if (!locs.map(String).includes(have)) {
      return `Order is assigned to a location you have not enabled for NovaX.`;
    }
  }

  if (norm(rules.booking_mode) === "manual") {
    return "You have automatic booking turned off. Approve it to create a parcel.";
  }

  return null;
}

export interface Booking {
  consignee: string;
  phone: string;
  city: string;
  address: string;
  cod: number;
  weight: string;
  service: string;
  category: string;
  fragile: string;
  paymentMode: "COD" | "Prepaid";
  orderId: string;
  referenceNo: string;
}

export type MapResult =
  | { action: "book"; booking: Booking }
  | { action: "skip"; reason: string };

export interface MapOptions {
  defaultWeight?: string;
  defaultService?: string;
  defaultCategory?: string;
  /** Book prepaid (already paid online) orders too. Off by default: a courier
   *  booking with cod 0 is still a real delivery the merchant pays for, so we
   *  do not make that call for them silently. */
  bookPrepaid?: boolean;
}

// --------------------------------------------------------------- phone ------

/**
 * Pakistani mobile numbers reach NovaX in every shape a customer can type.
 * Parcels are stored with digits only, so normalise to the local 03XXXXXXXXX
 * form and reject anything that cannot be one.
 *
 * A wrong number here means a rider who cannot call, which is the single most
 * common cause of a failed COD delivery -- so an unusable number is better
 * refused at booking than discovered at the door.
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  let d = String(raw).replace(/[^0-9]/g, "");

  if (d.startsWith("0092")) d = d.slice(4);
  else if (d.startsWith("92")) d = d.slice(2);
  else if (d.startsWith("0")) d = d.slice(1);

  // What is left must be a 10-digit mobile starting with 3 (3XXXXXXXXX).
  if (!/^3[0-9]{9}$/.test(d)) return "";
  return "0" + d;
}

function firstUsablePhone(order: ShopifyOrder): string {
  const candidates = [
    order.shipping_address?.phone,
    order.phone,
    order.customer?.phone,
  ];
  for (const c of candidates) {
    const p = normalizePhone(c);
    if (p) return p;
  }
  return "";
}

// -------------------------------------------------------------- money -------

function toAmount(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * What the rider must collect at the door.
 *
 * total_outstanding is the honest number when Shopify gives it -- it already
 * accounts for partial payments, edits and refunds. Falling back to
 * current_total_price before total_price matters for edited orders: total_price
 * is the ORIGINAL total, so using it would have the rider collect money the
 * merchant already refunded.
 */
export function codAmount(order: ShopifyOrder): number {
  const outstanding = toAmount(order.total_outstanding);
  if (outstanding !== null) return Math.max(0, outstanding);

  const current = toAmount(order.current_total_price);
  if (current !== null) return Math.max(0, current);

  return Math.max(0, toAmount(order.total_price) ?? 0);
}

// ------------------------------------------------------------- weight -------

/** Shopify carries grams per line item. NovaX stores "0.8 kg" style strings. */
export function weightFromOrder(order: ShopifyOrder, fallback: string): string {
  const items = order.line_items ?? [];
  let grams = 0;
  for (const li of items) {
    if (li.requires_shipping === false) continue;
    grams += (li.grams ?? 0) * (li.quantity ?? 1);
  }
  if (grams <= 0) return fallback;

  const kg = grams / 1000;
  // Round up to the nearest 100g: under-declaring weight is how a merchant ends
  // up disputing a surcharge later.
  const rounded = Math.max(0.5, Math.ceil(kg * 10) / 10);
  return `${rounded} kg`;
}

// ------------------------------------------------------------ address -------

function joinAddress(a: ShopifyAddress): string {
  return [a.address1, a.address2].map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
}

function consigneeName(a: ShopifyAddress): string {
  const full = (a.name ?? "").trim();
  if (full) return full;
  return [a.first_name, a.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- map -------

export function mapOrderToBooking(order: ShopifyOrder, opts: MapOptions = {}): MapResult {
  const {
    defaultWeight = "0.8 kg",
    defaultService = "Standard",
    defaultCategory = "General",
    bookPrepaid = false,
  } = opts;

  if (order.test) return { action: "skip", reason: "test order" };
  if (order.cancelled_at) return { action: "skip", reason: "order cancelled in Shopify" };

  const fs = String(order.fulfillment_status ?? "").toLowerCase();
  if (fs === "fulfilled" || fs === "restocked") {
    return { action: "skip", reason: `already ${fs} in Shopify` };
  }

  const fin = String(order.financial_status ?? "").toLowerCase();
  if (fin === "refunded" || fin === "voided") {
    return { action: "skip", reason: `payment ${fin}` };
  }

  const addr = order.shipping_address;
  if (!addr) {
    return { action: "skip", reason: "no shipping address (digital or pickup order)" };
  }

  // An order of only digital goods has a shipping address in some themes.
  const items = order.line_items ?? [];
  if (items.length > 0 && items.every((li) => li.requires_shipping === false)) {
    return { action: "skip", reason: "nothing in this order requires shipping" };
  }

  const consignee = consigneeName(addr);
  if (!consignee) return { action: "skip", reason: "shipping address has no name" };

  const city = (addr.city ?? "").trim();
  if (!city) return { action: "skip", reason: "shipping address has no city" };

  const address = joinAddress(addr);
  if (!address) return { action: "skip", reason: "shipping address has no street address" };

  const phone = firstUsablePhone(order);
  if (!phone) {
    return {
      action: "skip",
      reason: "no usable Pakistani mobile number on the order — a rider cannot deliver COD without one",
    };
  }

  const prepaid = fin === "paid";
  if (prepaid && !bookPrepaid) {
    return { action: "skip", reason: "order already paid online (prepaid booking is switched off)" };
  }

  const cod = prepaid ? 0 : codAmount(order);
  if (!prepaid && cod <= 0) {
    return { action: "skip", reason: "COD order with nothing left to collect" };
  }

  return {
    action: "book",
    booking: {
      consignee,
      phone,
      city,
      address,
      cod,
      weight: weightFromOrder(order, defaultWeight),
      service: defaultService,
      category: defaultCategory,
      fragile: "No",
      paymentMode: prepaid ? "Prepaid" : "COD",
      orderId: (order.name ?? (order.order_number ? `#${order.order_number}` : "")).trim(),
      referenceNo: String(order.id),
    },
  };
}
