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
