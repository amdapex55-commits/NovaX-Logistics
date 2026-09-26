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
      fulfillmentOrders(first: 10, query: "status:open OR status:in_progress") {
        nodes { id status }
      }
    }
  }`;

// NOTE: fulfillmentCreate replaced fulfillmentCreateV2. The argument name is
// the one detail in this file not proven against a live store -- Shopify's own
// reference page shows `input:` in its example while the schema names the
// argument `fulfillment:`. Confirm on the very first dev-store fulfillment;
// a wrong name fails loudly with "unknown argument", it cannot fail silently.
const CREATE_FULFILLMENT = `
  mutation fulfill($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status trackingInfo { number url company } }
      userErrors { field message }
    }
  }`;

/**
 * Pushes the NovaX AWB back to Shopify as the tracking number and marks the
 * order fulfilled. This is what makes the merchant's customer see "shipped"
 * with a working tracking link, and it is the half of the integration that
 * every rival app is reviewed badly for getting wrong.
 */
export async function pushTracking(
  shop: string,
  accessToken: string,
  shopifyOrderId: string,
  awb: string,
  trackingUrl: string,
): Promise<{ ok: boolean; detail?: string }> {
  const gid = shopifyOrderId.startsWith("gid://")
    ? shopifyOrderId
    : `gid://shopify/Order/${shopifyOrderId}`;

  const found = await graphql<{
    order: { fulfillmentOrders: { nodes: Array<{ id: string; status: string }> } } | null;
  }>(shop, accessToken, FULFILLMENT_ORDERS, { id: gid });

  const nodes = found.order?.fulfillmentOrders?.nodes ?? [];
  if (nodes.length === 0) {
    // Nothing open to fulfil: already fulfilled elsewhere, or fully cancelled.
    // Not an error worth alarming anyone about.
    return { ok: false, detail: "no open fulfillment order" };
  }

  const data = await graphql<{
    fulfillmentCreate: {
      fulfillment: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(shop, accessToken, CREATE_FULFILLMENT, {
    fulfillment: {
      lineItemsByFulfillmentOrder: nodes.map((n) => ({ fulfillmentOrderId: n.id })),
      trackingInfo: {
        number: awb,
        url: trackingUrl,
        company: "NovaX Logistics",
      },
      notifyCustomer: true,
    },
  });

  const errs = data.fulfillmentCreate.userErrors;
  if (errs.length) return { ok: false, detail: errs.map((e) => e.message).join("; ") };
  return { ok: true };
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

const ORDERS_SINCE = `
  query orders($q: String!, $after: String) {
    orders(first: 50, query: $q, after: $after, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt cancelledAt test tags
        displayFinancialStatus displayFulfillmentStatus currencyCode
        phone
        totalOutstandingSet { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount } }
        shippingLine { title }
        shippingAddress { name firstName lastName address1 address2 city province zip countryCodeV2 phone }
        customer { phone }
        lineItems(first: 100) {
          nodes {
            title quantity requiresShipping
            variant { inventoryItem { measurement { weight { value unit } } } }
          }
        }
      }
    }
  }`;

interface GqlOrder {
  id: string; name: string | null; createdAt: string; cancelledAt: string | null;
  test: boolean | null; tags: string[] | null;
  displayFinancialStatus: string | null; displayFulfillmentStatus: string | null;
  currencyCode: string | null; phone: string | null;
  totalOutstandingSet?: { shopMoney?: { amount?: string } } | null;
  currentTotalPriceSet?: { shopMoney?: { amount?: string } } | null;
  shippingLine?: { title?: string | null } | null;
  shippingAddress?: Record<string, string | null> | null;
  customer?: { phone?: string | null } | null;
  lineItems?: { nodes: Array<{ quantity?: number; requiresShipping?: boolean;
    // Weight moved off ProductVariant: the API answers
    // "Field 'weight' doesn't exist on type 'ProductVariant'".
    variant?: { inventoryItem?: { measurement?: { weight?: { value?: number | null; unit?: string | null } | null } | null } | null } | null }> } | null;
}

const GRAMS: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.3495, POUNDS: 453.592 };

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
    tags: o.tags ?? [],
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
      quantity: li.quantity ?? 1,
      requires_shipping: li.requiresShipping ?? true,
      grams: Math.round(
        (li.variant?.inventoryItem?.measurement?.weight?.value ?? 0) *
        (GRAMS[String(li.variant?.inventoryItem?.measurement?.weight?.unit)] ?? 1),
      ),
    })),
  };
}

export async function ordersSince(
  shop: string,
  accessToken: string,
  sinceIso: string,
  maxPages = 4,
): Promise<Array<{ id: string; order: Record<string, unknown> }>> {
  const out: Array<{ id: string; order: Record<string, unknown> }> = [];
  let after: string | null = null;

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
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return out;
}
