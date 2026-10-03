/* WooCommerce status push (rebuilt 3 Oct 2026).
 *
 * nv_woo_enqueue_status() queues every status change of a WooCommerce-booked
 * parcel (meta.source = "woocommerce") into nv_woo_push_queue, and the
 * novax-woo-push cron calls this function with the drain token when rows are
 * due. Each row becomes, on the merchant's WooCommerce order:
 *   - a private order note: "NovaX: <status> · AWB <awb> · Track: <link>"
 *   - on booking, the AWB and tracking link saved as order meta
 *     (_novax_awb, _novax_tracking_url)
 *   - on Delivered, the order is marked "completed"
 * Returns and refusals stay notes: whether to cancel or refund an order is
 * the merchant's decision, not ours.
 *
 * Failures retry with backoff (2, 4, 8 ... up to 240 min); after 8 tries the
 * row is dead and logged to store_push_failures. Only NovaX's database can
 * call this (x-novax-drain), and only public https store addresses are used.
 */
import { unsafeDestination } from "../_shared/destination.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DRAIN_TOKEN = Deno.env.get("DRAIN_TOKEN") ?? "";
const MAX_TRIES = 8;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

function orderIdOf(meta: Record<string, unknown> | null): string | null {
  const m = meta || {};
  const direct = String(m.wooOrderId ?? "").trim();
  if (/^\d+$/.test(direct)) return direct;
  const ref = /^woo:(\d+)$/.exec(String(m.referenceNo ?? "").trim());
  return ref ? ref[1] : null;
}

async function woo(base: string, auth: string, path: string, method: string, body: unknown) {
  const r = await fetch(`${base}/wp-json/wc/v3/${path}`, {
    method, redirect: "manual",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const t = (await r.text().catch(() => "")).slice(0, 200);
    throw new Error(`WooCommerce ${method} ${path.split("/")[0]}: HTTP ${r.status} ${t}`);
  }
}

type Row = { id: number; parcel_id: string; client_id: string; awb: string; status: string; attempts: number };

async function pushOne(row: Row): Promise<string> {
  const pr = await rest(`parcels?id=eq.${row.parcel_id}&select=id,client_id,awb,meta&limit=1`);
  const parcel = Array.isArray(pr.data) ? pr.data[0] : null;
  if (!parcel) return "skip: parcel gone";
  const orderId = orderIdOf(parcel.meta);
  if (!orderId) return "skip: no WooCommerce order id";
  const sr = await rest(`store_secrets?client_id=eq.${row.client_id}&platform=eq.woocommerce&select=store_url,consumer_key,consumer_secret&limit=1`);
  const sec = Array.isArray(sr.data) ? sr.data[0] : null;
  if (!sec) return "skip: store not connected";
  const base = String(sec.store_url || "").replace(/\/+$/, "");
  const blocked = await unsafeDestination(base);
  if (blocked) throw new Error(`Store address refused: ${blocked}`);
  const auth = "Basic " + btoa(`${sec.consumer_key}:${sec.consumer_secret}`);
  const track = `https://novaxlogistics.com/tracking.html?awb=${encodeURIComponent(row.awb)}`;

  if (row.status === "New booked") {
    await woo(base, auth, `orders/${orderId}`, "PUT", {
      meta_data: [{ key: "_novax_awb", value: row.awb }, { key: "_novax_tracking_url", value: track }],
    });
  }
  await woo(base, auth, `orders/${orderId}/notes`, "POST", {
    note: `NovaX: ${row.status} · AWB ${row.awb} · Track: ${track}`, customer_note: false,
  });
  if (row.status === "Delivered") {
    await woo(base, auth, `orders/${orderId}`, "PUT", { status: "completed" });
  }
  return "done";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!DRAIN_TOKEN || req.headers.get("x-novax-drain") !== DRAIN_TOKEN) return json({ ok: false, error: "forbidden" }, 403);

  const now = new Date().toISOString();
  const q = await rest(`nv_woo_push_queue?done_at=is.null&dead=is.false&next_attempt_at=lte.${encodeURIComponent(now)}&order=id.asc&limit=20&select=id,parcel_id,client_id,awb,status,attempts`);
  if (!q.ok) return json({ ok: false, error: "queue unavailable" }, 503);
  const rows: Row[] = Array.isArray(q.data) ? q.data : [];
  const out = { done: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    try {
      const res = await pushOne(row);
      await rest(`nv_woo_push_queue?id=eq.${row.id}`, {
        method: "PATCH", headers: { prefer: "return=minimal" },
        body: JSON.stringify({ done_at: new Date().toISOString(), last_error: res === "done" ? null : res }),
      });
      if (res === "done") out.done++; else out.skipped++;
    } catch (e) {
      out.failed++;
      const tries = row.attempts + 1;
      const dead = tries >= MAX_TRIES;
      const msg = String((e as Error)?.message || e).slice(0, 300);
      await rest(`nv_woo_push_queue?id=eq.${row.id}`, {
        method: "PATCH", headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          attempts: tries, dead, last_error: msg,
          next_attempt_at: new Date(Date.now() + Math.min(2 ** tries, 240) * 60000).toISOString(),
        }),
      });
      if (dead) {
        await rest("store_push_failures", {
          method: "POST", headers: { prefer: "return=minimal" },
          body: JSON.stringify({ parcel_id: row.parcel_id, client_id: row.client_id, platform: "woocommerce",
            status_at_failure: row.status, error_message: msg, attempts: tries, resolved: false,
            last_attempt_at: new Date().toISOString() }),
        }).catch(() => {});
      }
    }
  }
  return json({ ok: true, ...out, batch: rows.length });
});
