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
  line_items?: Array<{
    id?: number | string | null;
    grams?: number | null;
    quantity?: number | null;
    /** What is still shippable after refunds and earlier fulfillments. */
    fulfillable_quantity?: number | null;
    requires_shipping?: boolean | null;
  }> | null;
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
/**
 * A30: an excluded tag is a HARD exclusion, not a hold.
 *
 * The field says "Never book orders tagged", and the rule put those orders in
 * the approval queue -- where "Approve all held orders" released them in a
 * single click, because approval sets approved_at and approval skips the rules.
 * A merchant who tagged an order "pickup" had it booked anyway.
 *
 * Returned separately from holdReason() so the caller can skip rather than
 * hold, and so approval cannot override it.
 */
export function excludedByTag(order: ShopifyOrder, rules: BookingRules): string | null {
  const tags = orderTags(order);
  const excluded = (rules.rule_exclude_tags ?? []).map(norm).filter(Boolean);
  const hit = excluded.find((t) => tags.includes(t));
  return hit
    ? `Order is tagged "${hit}", which you have set NovaX never to book. Remove the tag in Shopify to book it.`
    : null;
}

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

  // B10: rule_require_confirmed drove TWO things -- "also book prepaid" and
  // "only book confirmed orders". Ticking the box to allow prepaid therefore
  // started holding ordinary pending COD, which is the opposite of what the
  // label promises. The flag now means only what it says; prepaid permission is
  // passed to the mapper and nothing here holds a COD order for being unpaid.

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

  // A29: order.location_id is null for ordinary online-store orders -- it is
  // only set for POS and some draft orders. Treating null as "not in the list"
  // held every single order the moment a merchant filled this field in. A rule
  // that cannot be evaluated is not a rule that failed.
  const locs = rules.rule_location_ids;
  if (locs && locs.length) {
    const have = String(order.location_id ?? "").trim();
    if (have && !locs.map(String).includes(have)) {
      return `Order is assigned to location ${have}, which you have not enabled for NovaX.`;
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

/** Gateways that mean "the rider collects cash". Anything else with money
 *  still owed is ambiguous, and ambiguous is not COD. */
const COD_GATEWAYS = [
  "cod", "cash on delivery", "cash_on_delivery", "cashondelivery",
  "manual", "bogus",
];

export type PaymentKind = "cod" | "prepaid" | "unknown";

export function paymentKind(order: ShopifyOrder): PaymentKind {
  const fin = String(order.financial_status ?? "").trim().toLowerCase();
  if (fin === "paid") return "prepaid";

  const gateways = [order.gateway, ...(order.payment_gateway_names ?? [])]
    .map((g) => String(g ?? "").trim().toLowerCase())
    .filter(Boolean);

  // No gateway recorded at all: the ordinary shape of a COD order created by a
  // theme or by hand, including the advance-plus-balance pattern that is normal
  // in Pakistan -- codAmount() collects total_outstanding, which is the balance.
  // The dangerous case A11 names is an AUTHORIZED CARD order, and that always
  // carries a gateway, so it falls through to "unknown" below.
  if (gateways.length === 0) {
    return ["", "pending", "unpaid", "partially_paid", "partially_refunded", "authorized"]
        .includes(fin)
      ? (fin === "authorized" ? "unknown" : "cod")
      : "unknown";
  }
  if (gateways.some((g) => COD_GATEWAYS.some((c) => g.includes(c)))) return "cod";

  // A real payment method with money still outstanding -- authorized, pending
  // capture, partially paid. Not ours to guess at.
  return "unknown";
}

/** Shopify carries grams per line item. NovaX stores "0.8 kg" style strings. */
export function weightFromOrder(order: ShopifyOrder, fallback: string): string {
  const items = order.line_items ?? [];
  let grams = 0;
  for (const li of items) {
    if (li.requires_shipping === false) continue;
    // A21: quantity is what was ORDERED. fulfillable_quantity is what is left
    // to ship after refunds, restocks and anything already sent by someone
    // else. Weighing the original quantity overcharged the merchant for goods
    // that were never in the parcel.
    const qty = li.fulfillable_quantity ?? li.quantity ?? 1;
    if (qty <= 0) continue;
    grams += (li.grams ?? 0) * qty;
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

  // A10: the COD amount was taken as a bare number and handed to a rider who
  // collects rupees. A USD 100 order became "Rs 100" with nothing said, and the
  // merchant would have been short about 27,000 rupees per order. NovaX
  // collects cash in Pakistan; there is no conversion policy and inventing one
  // silently is worse than refusing.
  const cur = String(order.currency ?? "").trim().toUpperCase();
  if (cur && cur !== "PKR") {
    return {
      action: "skip",
      reason: `Order is in ${cur}. NovaX riders collect cash in PKR only, so this order was not booked.`,
    };
  }

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

  // A27: a Dubai address with a Pakistani mobile passed straight through and
  // became a payable booking a rider could never deliver.
  const country = String(addr.country_code ?? "").trim().toUpperCase();
  if (country && country !== "PK") {
    return {
      action: "skip",
      reason: `Delivery address is in ${country}. NovaX delivers inside Pakistan only.`,
    };
  }

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

  // A11/A12: the old rule was `prepaid = financial_status === "paid"`, so every
  // other state -- authorized, pending, partially_paid -- became a COD parcel
  // for the full amount. An authorised card order would have had the buyer
  // charged twice: once by the card capture, once by the rider at the door.
  // Financial status alone never proves cash on delivery; the gateway does.
  const kind = paymentKind(order);

  if (kind === "unknown") {
    return {
      action: "skip",
      reason: `Payment method "${(order.gateway ?? order.payment_gateway_names?.[0] ?? "unrecorded")}" ` +
        `is not a cash-on-delivery method and the order is not paid, so NovaX cannot tell how much ` +
        `to collect. Book it by hand if the buyer is paying the rider.`,
    };
  }

  if (kind === "prepaid" && !bookPrepaid) {
    return { action: "skip", reason: "order already paid online (prepaid booking is switched off)" };
  }

  const cod = kind === "prepaid" ? 0 : codAmount(order);
  if (kind === "cod" && cod <= 0) {
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
      paymentMode: kind === "prepaid" ? "Prepaid" : "COD",
      orderId: (order.name ?? (order.order_number ? `#${order.order_number}` : "")).trim(),
      referenceNo: String(order.id),
    },
  };
}
