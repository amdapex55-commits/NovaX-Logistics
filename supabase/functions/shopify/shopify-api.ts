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

// Every webhook the app needs. The three compliance topics are mandatory for
// any App Store app; app/uninstalled is how we learn we have been removed,
// because Shopify will not tell us any other way.
export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_CANCELLED",
  "APP_UNINSTALLED",
  "CUSTOMERS_DATA_REQUEST",
  "CUSTOMERS_REDACT",
  "SHOP_REDACT",
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
