// ---------------------------------------------------------------------------
// Shopify Admin API client.
//
// GraphQL only. Every public app created after 1 Apr 2025 must be built
// exclusively on the GraphQL Admin API -- REST is not accepted at review, so
// there is deliberately no REST helper here for anyone to reach for.
// ---------------------------------------------------------------------------

// 2026-07 is the current stable version, accessible until 16 Jul 2027. An app
// cannot be submitted while its API version is within 90 days of removal, so
// this needs bumping each time we approach that. It is the exact failure that
// put the official TCS app at 2.4 stars.
export const API_VERSION = "2026-07";

export interface GraphQLResult<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

export class ShopifyApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ShopifyApiError";
    this.status = status;
  }
}

/**
 * One GraphQL call, with retries for the two failures Shopify expects clients
 * to handle: 429 (too many requests) and THROTTLED (the cost-based limiter).
 * Anything else fails fast -- retrying a malformed query just wastes the
 * merchant's rate limit.
 */
export async function graphql<T>(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
  attempt = 0,
): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    // A34: an unbounded call to Shopify could hold a cron run open until the
    // platform terminated it, leaving every row behind it untouched.
    signal: AbortSignal.timeout(20_000),
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? "2");
    await sleep(Math.min(retryAfter, 10) * 1000);
    return graphql<T>(shop, accessToken, query, variables, attempt + 1);
  }

  // 401 means the merchant uninstalled or revoked us. There is nothing to retry
  // and the caller needs to mark the shop dead rather than keep trying.
  if (res.status === 401 || res.status === 403) {
    throw new ShopifyApiError("access token rejected", res.status);
  }

  if (!res.ok) {
    throw new ShopifyApiError(
      `admin api ${res.status}: ${(await res.text()).slice(0, 300)}`,
      res.status,
    );
  }

  const body = await res.json() as GraphQLResult<T>;

  if (body.errors?.length) {
    const throttled = body.errors.some(
      (e) => (e.extensions as { code?: string } | undefined)?.code === "THROTTLED",
    );
    if (throttled && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      return graphql<T>(shop, accessToken, query, variables, attempt + 1);
    }
    throw new ShopifyApiError(body.errors.map((e) => e.message).join("; "));
  }

  if (!body.data) throw new ShopifyApiError("empty response");
  return body.data;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------- webhook registry ---

// The webhooks this app SUBSCRIBES to per shop. app/uninstalled is how we learn
// we have been removed, because Shopify will not tell us any other way.
//
// The three privacy/compliance topics are NOT here, and must not be. They are
// not members of the WebhookSubscriptionTopic enum, so webhookSubscriptionCreate
// rejects them outright -- on the first real install, 25 Sep 2026:
//   CUSTOMERS_DATA_REQUEST(Variable $topic of type WebhookSubscriptionTopic!
//   was provided invalid value), and the same for CUSTOMERS_REDACT and
//   SHOP_REDACT.
// Shopify delivers those three from the APP CONFIG instead -- the
// [webhooks.privacy_compliance] URLs in shopify.app.toml, which are already set
// and already answer 401 to a bad HMAC. Nothing is lost by dropping them here.
export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_CANCELLED",
  "APP_UNINSTALLED",
] as const;

const REGISTER = `
  mutation register($topic: WebhookSubscriptionTopic!, $url: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $url, format: JSON }
    ) {
      userErrors { field message }
      webhookSubscription { id }
    }
  }`;

/**
 * Registers every topic. Re-registering an identical subscription returns a
 * userError rather than duplicating it, so this is safe to run on every
 * install and on every re-auth -- which matters because a merchant who
 * reinstalls must end up with working webhooks without any manual step.
 */
export async function registerWebhooks(
  shop: string,
  accessToken: string,
  baseUrl: string,
): Promise<{ topic: string; ok: boolean; detail?: string }[]> {
  const out: { topic: string; ok: boolean; detail?: string }[] = [];

  for (const topic of WEBHOOK_TOPICS) {
    const url = `${baseUrl}/webhooks/${topic.toLowerCase().replace(/_/g, "-")}`;
    try {
      const data = await graphql<{
        webhookSubscriptionCreate: {
          userErrors: Array<{ message: string }>;
          webhookSubscription: { id: string } | null;
        };
      }>(shop, accessToken, REGISTER, { topic, url });

      const errs = data.webhookSubscriptionCreate.userErrors;
      const already = errs.some((e) => /already (been )?taken|exists/i.test(e.message));
      out.push({
        topic,
        ok: errs.length === 0 || already,
        detail: errs.map((e) => e.message).join("; ") || undefined,
      });
    } catch (err) {
      out.push({ topic, ok: false, detail: String((err as Error).message) });
    }
  }
  return out;
}

// ----------------------------------------------------------- fulfillment ----

const FULFILLMENT_ORDERS = `
  query fulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      name
      fulfillmentOrders(first: 50, query: "status:open OR status:in_progress") {
        pageInfo { hasNextPage }
        nodes {
          id
          status
          assignedLocation { location { id name } }
          lineItems(first: 100) { nodes { id remainingQuantity } }
        }
      }
    }
  }`;

const CREATE_FULFILLMENT = `
  mutation fulfill($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status trackingInfo { number url company } }
      userErrors { field message }
    }
  }`;

interface FoPage { pageInfo?: { hasNextPage?: boolean }; nodes: FoNode[] }

interface FoNode {
  id: string;
  status: string;
  assignedLocation?: { location?: { id?: string | null; name?: string | null } | null } | null;
  lineItems?: { nodes: Array<{ id: string; remainingQuantity: number }> } | null;
}

/**
 * Pushes the NovaX AWB back to Shopify as the tracking number and marks the
 * handed-over items fulfilled.
 *
 * Two rules this used to break:
 *
 * A14 -- every open fulfillment order went into ONE mutation. Shopify requires
 * the fulfillment orders in a single fulfillmentCreate to share a location, so
 * a merchant shipping from two warehouses got a rejected mutation and a parcel
 * that never appeared as shipped. One mutation per location now.
 *
 * A15 -- line items were omitted entirely, and Shopify reads that as "all of
 * them". A split dispatch, a preorder, or a second carrier's items were marked
 * shipped on the strength of a NovaX parcel that did not contain them. Each
 * item is now named with its remaining quantity.
 */
export async function pushTracking(
  shop: string,
  accessToken: string,
  shopifyOrderId: string,
  awb: string | string[],
  trackingUrl: string | string[],
): Promise<{ ok: boolean; detail?: string; fulfillmentIds?: string[] }> {
  // A44: an order shipped in three boxes sent the buyer one tracking number and
  // the other two never reached Shopify at all. Shopify takes a list.
  const numbers = (Array.isArray(awb) ? awb : [awb]).filter(Boolean);
  const urls = (Array.isArray(trackingUrl) ? trackingUrl : [trackingUrl]).filter(Boolean);
  const primary = numbers[0] ?? "";
  const gid = shopifyOrderId.startsWith("gid://")
    ? shopifyOrderId
    : `gid://shopify/Order/${shopifyOrderId}`;

  const found = await graphql<{ order: { fulfillmentOrders: FoPage } | null }>(
    shop, accessToken, FULFILLMENT_ORDERS, { id: gid },
  );

  // A48: the query capped at 10 with no cursor, so a complex order could leave
  // fulfillment orders unsynced and say nothing. 50 covers anything realistic,
  // and going over is now reported rather than hidden.
  const truncated = Boolean(found.order?.fulfillmentOrders?.pageInfo?.hasNextPage);

  const nodes = (found.order?.fulfillmentOrders?.nodes ?? [])
    .filter((n) => (n.lineItems?.nodes ?? []).some((li) => (li.remainingQuantity ?? 0) > 0));

  if (nodes.length === 0) {
    // A42: before calling this a failure, check whether THIS AWB is already on
    // the order. If it is, an earlier attempt reached Shopify and only our own
    // write failed -- the buyer has the tracking number and the right answer is
    // success, not a permanent failure on a delivered parcel.
    try {
      const seen = await graphql<{ order: { fulfillments: Array<{ id: string; trackingInfo: Array<{ number: string | null }> }> } | null }>(
        shop, accessToken,
        `query t($id: ID!) { order(id: $id) { fulfillments(first: 20) { id trackingInfo { number } } } }`,
        { id: gid },
      );
      const mine = (seen.order?.fulfillments ?? [])
        .filter((f) => (f.trackingInfo ?? []).some((t) => t.number === primary));
      if (mine.length) return { ok: true, fulfillmentIds: mine.map((f) => f.id) };
    } catch { /* fall through to the ordinary answer */ }

    // Nothing open to fulfil: already fulfilled elsewhere, or fully cancelled.
    // Not an error worth alarming anyone about.
    return { ok: false, detail: "no open fulfillment order" };
  }

  // Group by assigned location. An unnamed location still gets its own bucket
  // rather than being merged into someone else's.
  const byLocation = new Map<string, FoNode[]>();
  for (const n of nodes) {
    const loc = n.assignedLocation?.location?.id ?? `unassigned:${n.id}`;
    const list = byLocation.get(loc) ?? [];
    list.push(n);
    byLocation.set(loc, list);
  }

  // B04: grouping by location fixed Shopify's constraint, not the contents
  // problem. NovaX collects one parcel from one pickup address; it has no idea
  // which warehouse's items are inside it. Fulfilling every open location marks
  // a second warehouse's goods -- or another carrier's -- as shipped on the
  // strength of our box. This app supports whole-order dispatch from one
  // location; anything else is handed back to a human rather than guessed.
  if (byLocation.size > 1) {
    const names = [...byLocation.values()]
      .map((g) => g[0].assignedLocation?.location?.name ?? "an unnamed location");
    return {
      ok: false,
      detail: `This order ships from ${byLocation.size} locations (${names.join(", ")}). ` +
        `NovaX collects one parcel from one address and cannot tell which items are in it, ` +
        `so it will not mark the whole order shipped. Fulfil this one in Shopify by hand.`,
    };
  }

  const problems: string[] = [];
  const fulfillmentIds: string[] = [];
  let ok = 0;

  for (const [, group] of byLocation) {
    const lineItemsByFulfillmentOrder = group.map((n) => ({
      fulfillmentOrderId: n.id,
      fulfillmentOrderLineItems: (n.lineItems?.nodes ?? [])
        .filter((li) => (li.remainingQuantity ?? 0) > 0)
        .map((li) => ({ id: li.id, quantity: li.remainingQuantity })),
    }));

    try {
      const data = await graphql<{
        fulfillmentCreate: {
          fulfillment: { id: string } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(shop, accessToken, CREATE_FULFILLMENT, {
        fulfillment: {
          lineItemsByFulfillmentOrder,
          trackingInfo: numbers.length > 1
            ? { numbers, urls, company: "NovaX Logistics" }
            : { number: primary, url: urls[0], company: "NovaX Logistics" },
          notifyCustomer: true,
        },
      });

      const errs = data.fulfillmentCreate.userErrors;
      if (errs.length) problems.push(errs.map((e) => e.message).join("; "));
      else {
        ok++;
        // A42: the id was thrown away, so if Shopify succeeded and our own
        // write then failed, the retry saw no open fulfillment order and
        // reported failure for a customer who had already been emailed.
        if (data.fulfillmentCreate.fulfillment?.id) {
          fulfillmentIds.push(data.fulfillmentCreate.fulfillment.id);
        }
      }
    } catch (err) {
      problems.push(String((err as Error).message).slice(0, 200));
    }
  }

  if (ok === 0) return { ok: false, detail: problems.join(" | ") || "fulfillment failed", fulfillmentIds };
  // A partial success is still a failure to report: some items are not marked
  // shipped, and the merchant has to know which.
  if (problems.length) return { ok: false, detail: `partly fulfilled; ${problems.join(" | ")}`, fulfillmentIds };
  if (truncated) {
    return { ok: false, detail: "more than 50 fulfillment orders on this order; some were not synced", fulfillmentIds };
  }
  return { ok: true, fulfillmentIds };
}

// --------------------------------------------------------- reconcile --------
// A09: webhooks are at-least-once but not at-all-once. An orders/create that
// never reaches durable storage -- a deploy mid-request, a gateway 5xx after
// Shopify gave up retrying, a webhook deleted by hand -- is invisible forever,
// because the drain only ever re-reads rows we already have. The only cure is
// to ask Shopify what it has.
//
// GraphQL rather than REST: REST order endpoints are legacy, and a new public
// app should not ship on them.

const ORDER_FIELDS = `
        id name createdAt cancelledAt test tags
        displayFinancialStatus displayFulfillmentStatus currencyCode
        phone
        paymentGatewayNames
        totalOutstandingSet { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount } }
        shippingLine { title }
        shippingAddress { name firstName lastName address1 address2 city province zip countryCodeV2 phone }
        customer { phone }
        lineItems(first: 250) {
          pageInfo { hasNextPage }
          nodes {
            id title quantity requiresShipping
            unfulfilledQuantity
          }
        }
`;

const ORDERS_SINCE = `
  query orders($q: String!, $after: String) {
    orders(first: 50, query: $q, after: $after, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_FIELDS} }
    }
  }`;

interface GqlOrder {
  id: string; name: string | null; createdAt: string; cancelledAt: string | null;
  test: boolean | null; tags: string[] | null;
  displayFinancialStatus: string | null; displayFulfillmentStatus: string | null;
  currencyCode: string | null; phone: string | null;
  // B02: this was missing, so a refetched pending CARD order had no gateway and
  // paymentKind() read "no gateway + pending" as cash on delivery -- a Visa
  // authorisation became a COD parcel for the full amount.
  paymentGatewayNames?: string[] | null;
  totalOutstandingSet?: { shopMoney?: { amount?: string } } | null;
  currentTotalPriceSet?: { shopMoney?: { amount?: string } } | null;
  shippingLine?: { title?: string | null } | null;
  shippingAddress?: Record<string, string | null> | null;
  customer?: { phone?: string | null } | null;
  // B03: variant.inventoryItem.measurement needs read_inventory, which this app
  // does not request and should not. Weight is carried forward from the webhook
  // payload instead -- see mergeKnownWeights().
  // B11: unfulfilledQuantity is the remaining shippable count, and it needs no
  // extra scope; without it a refetch weighed the ORIGINAL quantity.
  // B26: lineItems was capped at 100 with no page info, so a long order was
  // silently truncated.
  lineItems?: { pageInfo?: { hasNextPage?: boolean }; nodes: Array<{
    id?: string; quantity?: number; requiresShipping?: boolean;
    unfulfilledQuantity?: number | null }> } | null;
}

/** Reshapes a GraphQL order into the REST shape mapOrderToBooking() expects,
 *  so reconciliation and webhooks go through exactly one mapper. Two mappers
 *  is two sets of rules that drift. */
function toRestShape(o: GqlOrder): Record<string, unknown> {
  const a = o.shippingAddress ?? null;
  return {
    id: o.id.replace(/^gid:\/\/shopify\/Order\//, ""),
    name: o.name,
    test: o.test ?? false,
    cancelled_at: o.cancelledAt,
    financial_status: (o.displayFinancialStatus ?? "").toLowerCase(),
    fulfillment_status: (o.displayFulfillmentStatus ?? "").toLowerCase(),
    currency: o.currencyCode,
    phone: o.phone,
    gateway: (o.paymentGatewayNames ?? [])[0] ?? null,
    payment_gateway_names: o.paymentGatewayNames ?? [],
    tags: o.tags ?? [],
    // B26: say so rather than pretending this is the whole order.
    _line_items_truncated: Boolean(o.lineItems?.pageInfo?.hasNextPage),
    total_outstanding: o.totalOutstandingSet?.shopMoney?.amount ?? null,
    current_total_price: o.currentTotalPriceSet?.shopMoney?.amount ?? null,
    shipping_lines: o.shippingLine?.title ? [{ title: o.shippingLine.title }] : [],
    customer: o.customer ? { phone: o.customer.phone ?? null } : null,
    shipping_address: a
      ? {
        name: a.name, first_name: a.firstName, last_name: a.lastName,
        address1: a.address1, address2: a.address2, city: a.city,
        province: a.province, zip: a.zip, country_code: a.countryCodeV2, phone: a.phone,
      }
      : null,
    line_items: (o.lineItems?.nodes ?? []).map((li) => ({
      id: li.id ?? null,
      quantity: li.quantity ?? 1,
      fulfillable_quantity: li.unfulfilledQuantity ?? li.quantity ?? 1,
      requires_shipping: li.requiresShipping ?? true,
      grams: 0,   // filled in from the stored webhook payload; see below
    })),
  };
}

export async function ordersSince(
  shop: string,
  accessToken: string,
  sinceIso: string,
  maxPages = 10,
  startCursor: string | null = null,
): Promise<{ orders: Array<{ id: string; order: Record<string, unknown> }>; cursor: string | null; complete: boolean }> {
  // B08: this stopped after four pages and returned normally, so a store with
  // more than 200 orders in the window had the SAME first 200 re-scanned every
  // run and its later orders were never looked at. The caller checkpoints the
  // cursor and resumes, and an incomplete sweep says so instead of reporting
  // success.
  const out: Array<{ id: string; order: Record<string, unknown> }> = [];
  let after: string | null = startCursor;
  let complete = true;

  for (let page = 0; page < maxPages; page++) {
    const data: {
      orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlOrder[] };
    } = await graphql(shop, accessToken, ORDERS_SINCE, {
      q: `created_at:>='${sinceIso}'`,
      after,
    });

    for (const n of data.orders.nodes) {
      const rest = toRestShape(n);
      out.push({ id: String(rest.id), order: rest });
    }
    if (!data.orders.pageInfo.hasNextPage) { after = null; break; }
    after = data.orders.pageInfo.endCursor;
    if (page === maxPages - 1) complete = false;
  }
  return { orders: out, cursor: complete ? null : after, complete };
}

/** A24: one order, refetched. Manual approval used the payload captured when
 *  the webhook arrived, so an address or a total the merchant corrected in
 *  Shopify afterwards was ignored and the parcel went out with the old one. */
/**
 * B03: the GraphQL order does not carry per-item weight without read_inventory,
 * a scope this app deliberately does not request. The webhook payload does
 * carry grams, and we stored it. Carry those weights across so a refetched
 * order does not silently become the default weight.
 */
export function mergeKnownWeights(
  fresh: Record<string, unknown>,
  stored: Record<string, unknown> | null,
): Record<string, unknown> {
  const s = (stored?.line_items ?? []) as Array<{ id?: unknown; grams?: number }>;
  if (!s.length) return fresh;

  const byId = new Map<string, number>();
  let fallback = 0;
  for (const li of s) {
    if (li?.id != null) byId.set(String(li.id), Number(li.grams ?? 0));
    fallback = Math.max(fallback, Number(li?.grams ?? 0));
  }

  const f = (fresh.line_items ?? []) as Array<{ id?: unknown; grams?: number }>;
  for (const li of f) {
    const known = li?.id != null ? byId.get(String(li.id)) : undefined;
    li.grams = known ?? fallback;
  }
  return fresh;
}

export async function fetchOrder(
  shop: string,
  accessToken: string,
  orderId: string,
): Promise<Record<string, unknown> | null> {
  const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const data = await graphql<{ order: GqlOrder | null }>(
    shop,
    accessToken,
    `query one($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { id: gid },
  );
  return data.order ? toRestShape(data.order) : null;
}
