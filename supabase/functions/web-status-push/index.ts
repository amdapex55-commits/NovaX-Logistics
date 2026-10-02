// Supabase Edge Function: web-status-push
// Pushes a NovaX parcel status change to a client's own website/API as a
// signed webhook, so their custom-built store can update order status
// automatically (no platform-specific API assumed, unlike Shopify/WooCommerce).
//
// Deploy as a Supabase Edge Function named exactly "web-status-push".
// Wire it up with a Supabase Database Webhook (Dashboard -> Database ->
// Webhooks -> Create a new webhook):
//   Table: parcels | Events: Update | Type: Supabase Edge Function
//   Edge Function: web-status-push
//
// What the client's server receives (POST, JSON body):
//   { "orderId": "ORD-1001", "awb": "WEBAB12...", "status": "Delivered",
//     "codCollected": 3500, "updatedAt": "2026-07-08T10:00:00.000Z" }
// Headers sent:
//   X-NovaX-Signature: hex HMAC-SHA256 of the raw JSON body, using this
//     store's webhook_secret (same secret returned at connection time).
//   Authorization: Bearer <API key> -- only sent if an API key was saved
//     for this connection (optional, for the client's own auth check).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";
import { unsafeDestination } from "../_shared/destination.ts";

/* Only NovaX's own database may call this (30 Sep 2026 review). It trusted
   whatever parcel the request described, so anyone able to call it could have
   NovaX send a signed, made-up status to another merchant's store. It now
   needs the private drain token, re-reads the parcel from the database, and
   only calls a public https address. Nothing calls it yet: wire a database
   webhook with the x-novax-drain header before relying on it. */
const DRAIN_TOKEN = Deno.env.get("DRAIN_TOKEN") ?? "";
function forbidden(): Response {
  return new Response(JSON.stringify({ ok: false, error: "forbidden" }), {
    status: 403, headers: { "content-type": "application/json" },
  });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (!DRAIN_TOKEN || req.headers.get("x-novax-drain") !== DRAIN_TOKEN) return forbidden();

    const payload = await req.json();
    const oldRecord = payload?.old_record;
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // The database's copy of the parcel, never the one in the request.
    const { data: record } = payload?.record?.id
      ? await admin.from("parcels").select("id,client_id,awb,status,cod_amount,meta").eq("id", payload.record.id).maybeSingle()
      : { data: null };

    if (!record || !record.client_id) {
      return new Response(JSON.stringify({ ok: true, note: "No parcel record, ignored" }), { status: 200 });
    }

    const newStatus = record.status;
    const prevStatus = oldRecord?.status;
    if (!newStatus || newStatus === prevStatus) {
      return new Response(JSON.stringify({ ok: true, note: "Status unchanged, ignored" }), { status: 200 });
    }

    const webOrderId = record.meta?.webOrderId;
    if (!webOrderId) {
      return new Response(JSON.stringify({ ok: true, note: "Not a Custom Web/API-sourced parcel" }), { status: 200 });
    }

    const { data: secretRow, error: secretErr } = await admin
      .from("store_secrets")
      .select("*")
      .eq("client_id", record.client_id)
      .eq("platform", "web")
      .maybeSingle();

    if (secretErr || !secretRow || !secretRow.store_url) {
      return new Response(JSON.stringify({ ok: true, note: "No Custom Web/API status URL saved for this client" }), { status: 200 });
    }

    const body = JSON.stringify({
      orderId: webOrderId,
      awb: record.awb,
      status: newStatus,
      codCollected: ["Delivered"].includes(newStatus) ? Number(record.cod_amount || 0) : 0,
      updatedAt: new Date().toISOString(),
    });
    const signature = await hmacHex(secretRow.webhook_secret, body);

    const headers: Record<string, string> = { "Content-Type": "application/json", "X-NovaX-Signature": signature };
    if (secretRow.consumer_key) headers["Authorization"] = `Bearer ${secretRow.consumer_key}`;

    const blocked = await unsafeDestination(secretRow.store_url);
    if (blocked) {
      return new Response(JSON.stringify({ ok: false, note: `Status URL refused: ${blocked}` }), { status: 200 });
    }
    let pushError: string | null = null;
    const res = await fetch(secretRow.store_url, { method: "POST", headers, body, redirect: "manual" });
    if (!res.ok) {
      pushError = `Custom Web/API status push failed: ${res.status} ${await res.text()}`;
    }

    if (pushError) {
      await admin.from("store_push_failures").upsert({
        parcel_id: record.id,
        client_id: record.client_id,
        platform: "web",
        status_at_failure: newStatus,
        error_message: pushError,
        attempts: 1,
        resolved: false,
        last_attempt_at: new Date().toISOString(),
      }, { onConflict: "parcel_id,platform" });
      return new Response(JSON.stringify({ error: pushError, queuedForRetry: true }), { status: 502 });
    }

    await admin.from("store_push_failures").update({ resolved: true })
      .eq("parcel_id", record.id).eq("platform", "web");

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
