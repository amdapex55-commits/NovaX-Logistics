// Supabase Edge Function: woo-status-push
// Pushes a NovaX parcel status change back to the client's WooCommerce order,
// so the client sees delivery progress inside WooCommerce automatically.
//
// Deploy as a Supabase Edge Function named exactly "woo-status-push".
// Wire it up with a Supabase Database Webhook (Dashboard -> Database ->
// Webhooks -> Create a new webhook):
//   Table: parcels
//   Events: Update
//   Type: Supabase Edge Function
//   Edge Function: woo-status-push
// This sends { type, table, record, old_record } automatically on every
// parcels row update; we ignore updates where status did not change.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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

// Only force an actual WooCommerce order-status change for terminal states.
// Everything else becomes an order note so we never risk pushing an invalid
// or unexpected WooCommerce status transition.
const TERMINAL_STATUS_MAP: Record<string, string> = {
  "Delivered": "completed",
  "Refused": "failed",
  "Return received at origin": "cancelled",
  "Parcel returned to consignee": "cancelled",
};

function wooAuthHeader(consumerKey: string, consumerSecret: string): string {
  return "Basic " + btoa(`${consumerKey}:${consumerSecret}`);
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

    const wooOrderId = record.meta?.wooOrderId;
    if (!wooOrderId) {
      return new Response(JSON.stringify({ ok: true, note: "Not a WooCommerce-sourced parcel" }), { status: 200 });
    }

    const { data: secretRow, error: secretErr } = await admin
      .from("store_secrets")
      .select("*")
      .eq("client_id", record.client_id)
      .eq("platform", "woocommerce")
      .maybeSingle();

    if (secretErr || !secretRow) {
      return new Response(JSON.stringify({ ok: true, note: "No WooCommerce connection for this client" }), { status: 200 });
    }

    const baseUrl = secretRow.store_url.replace(/\/+$/, "");
    const blocked = await unsafeDestination(baseUrl);
    if (blocked) {
      return new Response(JSON.stringify({ ok: false, note: `Store URL refused: ${blocked}` }), { status: 200 });
    }
    const auth = wooAuthHeader(secretRow.consumer_key, secretRow.consumer_secret);
    const wooStatus = TERMINAL_STATUS_MAP[newStatus];

    if (wooStatus) {
      const res = await fetch(`${baseUrl}/wp-json/wc/v3/orders/${wooOrderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Authorization": auth },
        redirect: "manual",
        body: JSON.stringify({ status: wooStatus }),
      });
      if (!res.ok) {
        const text = await res.text();
        return new Response(JSON.stringify({ error: `WooCommerce status update failed: ${res.status} ${text}` }), { status: 502 });
      }
    } else {
      const res = await fetch(`${baseUrl}/wp-json/wc/v3/orders/${wooOrderId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": auth },
        redirect: "manual",
        body: JSON.stringify({ note: `NovaX delivery update: ${newStatus}`, customer_note: false }),
      });
      if (!res.ok) {
        const text = await res.text();
        return new Response(JSON.stringify({ error: `WooCommerce note push failed: ${res.status} ${text}` }), { status: 502 });
      }
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
