// ---------------------------------------------------------------------------
// Postgres access, over PostgREST with the service role key.
//
// No supabase-js on purpose. This function is reached by Shopify, not by a
// browser, and every call it makes is one of about ten fixed shapes -- a
// dependency-free client is a smaller thing to keep working across Deno and
// library upgrades, which is what killed the official TCS app.
//
// The service role bypasses RLS entirely. Nothing in this file may ever take a
// table or column name from request data.
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "apikey": SERVICE_KEY,
    "Authorization": `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function pg(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers as Record<string, string> ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    // 409 is how the caller asks "has this webhook been handled already?" --
    // expected control flow, not a fault, so it is not logged as one.
    if (res.status !== 409) {
      // Never echo the body straight back to a caller: PostgREST errors can
      // contain column names and constraint text.
      console.error("pg error", res.status, path, text.slice(0, 400));
    }
    throw new Error(`db ${res.status}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return await pg(`rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(args),
  }) as T;
}

export async function selectOne<T>(
  table: string,
  query: string,
): Promise<T | null> {
  const rows = await pg(`${table}?${query}&limit=1`) as T[];
  return rows?.[0] ?? null;
}

export async function insert<T>(
  table: string,
  row: Record<string, unknown>,
  opts: { onConflict?: string; ignoreDuplicates?: boolean } = {},
): Promise<T | null> {
  const prefer = ["return=representation"];
  if (opts.onConflict) {
    prefer.push(opts.ignoreDuplicates ? "resolution=ignore-duplicates" : "resolution=merge-duplicates");
  }
  const path = opts.onConflict
    ? `${table}?on_conflict=${encodeURIComponent(opts.onConflict)}`
    : table;

  const rows = await pg(path, {
    method: "POST",
    headers: { Prefer: prefer.join(",") },
    body: JSON.stringify(row),
  }) as T[];
  return rows?.[0] ?? null;
}

export async function update<T>(
  table: string,
  query: string,
  patch: Record<string, unknown>,
): Promise<T[]> {
  return await pg(`${table}?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  }) as T[];
}

export async function remove(table: string, query: string): Promise<void> {
  await pg(`${table}?${query}`, { method: "DELETE" });
}

// ------------------------------------------------------------- domain -------

export interface ShopRow {
  id: string;
  shop_domain: string;
  access_token: string | null;
  scopes: string | null;
  client_id: string | null;
  status: string;
  orders_booked: number;
}

export function getShop(shop: string): Promise<ShopRow | null> {
  return selectOne<ShopRow>(
    "nvsh_shop",
    `shop_domain=eq.${encodeURIComponent(shop)}&select=id,shop_domain,access_token,scopes,client_id,status,orders_booked`,
  );
}

export async function logEvent(
  shopDomain: string | null,
  topic: string,
  webhookId: string | null,
  ok: boolean,
  detail?: string,
): Promise<void> {
  const patch = { ok, detail: detail?.slice(0, 500) ?? null };
  try {
    // claimWebhook() already inserted a row keyed on this webhook_id, and the
    // column is unique -- so for a webhook this must UPDATE that row. Inserting
    // instead hits the unique index and throws away the very detail we wanted
    // to record, which is exactly how a handler ends up looking fine in the log
    // while having failed.
    if (webhookId) {
      const rows = await update<{ id: number }>(
        "nvsh_event",
        `webhook_id=eq.${encodeURIComponent(webhookId)}`,
        patch,
      );
      if (rows.length > 0) return;
    }
    await insert("nvsh_event", { shop_domain: shopDomain, topic, webhook_id: webhookId, ...patch });
  } catch {
    // The log is diagnostics. A failure to write it must never turn a
    // successful booking into a 500 that Shopify then retries.
  }
}

/**
 * Shopify's protected-customer-data Level 2 requires an access log covering
 * customer name, address, phone and email. Called at the one place those
 * fields are read: the orders/create handler.
 */
export async function logProtectedAccess(
  shopDomain: string,
  purpose: string,
  fields: string[],
  subjectRef: string,
): Promise<void> {
  try {
    await insert("nvsh_access_log", {
      shop_domain: shopDomain,
      purpose,
      fields,
      subject_ref: subjectRef,
    });
  } catch (err) {
    console.error("access log write failed", String((err as Error).message));
  }
}

/**
 * True when this exact webhook delivery has already been handled.
 *
 * Shopify retries on any non-2xx, and retries are the normal case, not the
 * edge case. The unique index on nvsh_event.webhook_id makes the insert fail
 * for a repeat -- which is the check.
 */
export async function claimWebhook(
  shopDomain: string | null,
  topic: string,
  webhookId: string | null,
): Promise<boolean> {
  if (!webhookId) return true; // nothing to dedupe on; let it through
  try {
    await insert("nvsh_event", {
      shop_domain: shopDomain,
      topic,
      webhook_id: webhookId,
      ok: true,
      detail: "claimed",
    });
    return true;
  } catch {
    return false;
  }
}
