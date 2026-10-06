/* admin-reset-password
   ─────────────────────────────────────────────────────────────────────────
   Why this exists: admin.html's "Edit Login" only ever wrote to a local state
   record. It never touched Supabase Auth, so a merchant who forgot their
   password could not be helped from the admin panel at all — the toast even
   said so. Changing an Auth password requires the service-role key, which must
   never be shipped to a browser, so it has to happen here.

   Three modes:
     mode:"email" — send Supabase's own reset link to the merchant. Safest, and
                    the right default: we never learn the password.
     mode:"set"   — an admin sets a password directly, for the common Pakistani
                    case where the merchant cannot get into their email but is
                    on WhatsApp with you right now.
     mode:"update" — change the merchant's real Supabase Auth login email, and
                     optionally set a new password in the same audited request.

   Guards, in order:
     1. caller must present a real JWT
     2. caller must be an admin, checked by calling is_admin() AS THE CALLER
     3. target must be a client account (profiles.client_id is not null)
     4. target must not be staff/admin/rider — you cannot pivot to another admin
     5. caller cannot target themselves (use the normal change-password flow)
     6. email/password policy enforced server-side
     7. every attempt is written to admin_audit_log, allowed or refused
*/
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Not signed in." }, 401);

  const SB_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE) return json({ error: "Server is not configured for password resets." }, 503);

  // The caller's own JWT. Everything about *who is asking* is derived from
  // this, never from the request body.
  const asCaller = createClient(SB_URL, ANON, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userRes, error: userErr } = await asCaller.auth.getUser();
  const caller = userRes?.user;
  if (userErr || !caller) return json({ error: "Not signed in." }, 401);

  // is_admin() is SECURITY DEFINER and reads auth.uid(), so calling it through
  // the caller's client answers "is THIS person an admin" and cannot be spoofed.
  const { data: isAdmin, error: adminErr } = await asCaller.rpc("is_admin");
  if (adminErr) return json({ error: "Could not verify admin access." }, 500);

  // service-role client: used only after the admin check above has passed
  const asService = createClient(SB_URL, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const audit = async (action: string, targetClient: string | null, ok: boolean, detail: string) => {
    try {
      await asService.from("admin_audit_log").insert({
        actor_auth_id: caller.id,
        actor_email: caller.email ?? null,
        action,
        target_client_id: targetClient,
        allowed: ok,
        detail,
      });
    } catch { /* an audit failure must never block or leak */ }
  };

  if (!isAdmin) {
    await audit("reset_password", null, false, "caller is not an admin");
    return json({ error: "Admins only." }, 403);
  }

  let body: { client_id?: string; mode?: string; new_password?: string; new_email?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request body." }, 400); }

  const clientId = String(body.client_id ?? "").trim();
  const mode = body.mode === "set" ? "set" : (body.mode === "update" ? "update" : "email");
  if (!clientId) return json({ error: "client_id is required." }, 400);

  // Resolve the merchant's auth user. profiles is the real link between a
  // client row and an auth user; clients.meta->>'email' is not authoritative.
  const { data: prof, error: profErr } = await asService
    .from("profiles")
    .select("id, email, role, client_id, rider_id")
    .eq("client_id", clientId)
    .limit(50);

  if (profErr) return json({ error: "Lookup failed." }, 500);
  if (!prof || prof.length === 0) {
    await audit("reset_password", clientId, false, "no auth account linked to this client");
    return json({ error: "This client has no login account yet. Create one before resetting a password." }, 404);
  }
  /* 6 Oct 2026 audit. Every team login (Finance, Warehouse, Support) is a
     profile on the same client, so "exactly one profile" stopped being true
     the day a merchant added a sub-user, and this refused with 409 from then
     on. The target is the OWNER: a profile with no seat row, or whose seat is
     Owner. Team seats are never reset from here. */
  const { data: seatRows, error: seatErr } = await asService
    .from("staff_users").select("id, email, auth_user_id, role, status").eq("client_id", clientId);
  if (seatErr) return json({ error: "Lookup failed." }, 500);
  const seatOf = (p: { id: string; email: string | null }) => (seatRows ?? []).filter((r: any) =>
    r.auth_user_id === p.id || (r.email && p.email && String(r.email).toLowerCase() === String(p.email).toLowerCase()));
  const owners = prof.filter((p: any) => {
    const mine = seatOf(p);
    return mine.length === 0 || mine.some((r: any) =>
      ["owner", "client"].includes(String(r.role ?? "").toLowerCase()) && String(r.status ?? "Active") !== "Revoked");
  });
  if (owners.length === 0) {
    await audit("reset_password", clientId, false, "no owner login found among the client's profiles");
    return json({ error: "No owner login was found for this client (only team seats). Resolve that first." }, 409);
  }
  if (owners.length > 1) {
    await audit("reset_password", clientId, false, "multiple owner profiles linked to this client");
    return json({ error: "This client has more than one owner login. Resolve that first — refusing to guess." }, 409);
  }

  const target = owners[0];

  if (target.rider_id) {
    await audit("reset_password", clientId, false, "target is a rider account");
    return json({ error: "That account is a rider, not a merchant." }, 403);
  }
  if (target.id === caller.id) {
    await audit("reset_password", clientId, false, "self-target refused");
    return json({ error: "Use your own account settings to change your password." }, 400);
  }
  const targetRole = String(target.role ?? "").toLowerCase();
  if (targetRole.includes("admin") || targetRole.includes("staff")) {
    await audit("reset_password", clientId, false, `target role is ${targetRole}`);
    return json({ error: "Refusing to reset an admin or staff password from here." }, 403);
  }

  const cleanEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const validEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const validatePassword = (pw: string) => {
    if (pw.length < 10) return "Password must be at least 10 characters.";
    if (/^\s|\s$/.test(pw)) return "Password cannot start or end with a space — merchants mistype these constantly.";
    return "";
  };

  // ── mode: email — Supabase sends its own reset link ──────────────────
  if (mode === "email") {
    const email = target.email;
    if (!email) {
      await audit("reset_email", clientId, false, "no email on the account");
      return json({ error: "That account has no email address, so a reset link cannot be sent. Set a password directly instead." }, 400);
    }
    const { error } = await asService.auth.resetPasswordForEmail(email, {
      /* The page that actually has the new-password form (client.html has none). */
      redirectTo: "https://novaxlogistics.com/new-password.html",
    });
    if (error) {
      await audit("reset_email", clientId, false, error.message);
      return json({ error: "Could not send the reset email: " + error.message }, 502);
    }
    await audit("reset_email", clientId, true, `reset link sent to ${email}`);
    return json({ ok: true, mode: "email", sent_to: email });
  }

  // ── mode: update — admin changes the real Auth email and/or password ───
  if (mode === "update") {
    const nextEmail = cleanEmail(body.new_email);
    const pw = String(body.new_password ?? "");
    const attrs: { email?: string; email_confirm?: boolean; password?: string } = {};
    const changed: string[] = [];

    if (nextEmail) {
      if (!validEmail(nextEmail)) {
        await audit("update_login", clientId, false, "invalid email");
        return json({ error: "Enter a valid login email address." }, 400);
      }
      if (nextEmail !== cleanEmail(target.email)) {
        attrs.email = nextEmail;
        attrs.email_confirm = true;
        changed.push("email");
      }
    }

    if (pw) {
      const pwError = validatePassword(pw);
      if (pwError) {
        await audit("update_login", clientId, false, pwError);
        return json({ error: pwError }, 400);
      }
      attrs.password = pw;
      changed.push("password");
    }

    if (!changed.length) {
      return json({ error: "No login email or password change was requested." }, 400);
    }

    const { error: authErr } = await asService.auth.admin.updateUserById(target.id, attrs);
    if (authErr) {
      await audit("update_login", clientId, false, authErr.message);
      return json({ error: "Could not update the login: " + authErr.message }, 502);
    }

    /* supabase-js answers with {error} instead of throwing, so each result is
       checked; a copy that did not sync is reported, never silently dropped. */
    const notSynced: string[] = [];
    if (attrs.email) {
      const p1 = await asService.from("profiles").update({ email: attrs.email }).eq("id", target.id);
      if (p1.error) notSynced.push("profile");

      const { data: clientRow, error: cErr } = await asService.from("clients").select("meta").eq("id", clientId).single();
      if (cErr) notSynced.push("client record");
      else {
        const existingMeta = clientRow && clientRow.meta && typeof clientRow.meta === "object" && !Array.isArray(clientRow.meta)
          ? clientRow.meta
          : {};
        const meta = { ...existingMeta, email: attrs.email };
        const c2 = await asService.from("clients").update({ meta }).eq("id", clientId);
        if (c2.error) notSynced.push("client record");
      }

      /* Only the owner's own seat. This used to update every seat on the
         client, which gave each team member the owner's email address. */
      const ownSeatIds = seatOf(target).map((r: any) => r.id);
      if (ownSeatIds.length) {
        const s1 = await asService.from("staff_users").update({ email: attrs.email }).in("id", ownSeatIds).eq("client_id", clientId);
        if (s1.error) notSynced.push("owner seat");
      }
    }

    await audit("update_login", clientId, true, `updated ${changed.join("+")} for ${attrs.email ?? target.email ?? target.id}` +
      (notSynced.length ? `; NOT synced: ${notSynced.join(", ")}` : ""));
    return json({
      ok: true, mode: "update", changed, email: attrs.email ?? target.email ?? null,
      ...(notSynced.length ? { warning: `The login was changed, but these copies did not update: ${notSynced.join(", ")}. Check the client record.` } : {}),
    });
  }

  // ── mode: set — admin sets the password directly ────────────────────
  const pw = String(body.new_password ?? "");
  const pwError = validatePassword(pw);
  if (pwError) return json({ error: pwError }, 400);

  const { error: setErr } = await asService.auth.admin.updateUserById(target.id, { password: pw });
  if (setErr) {
    await audit("reset_password", clientId, false, setErr.message);
    return json({ error: "Could not set the password: " + setErr.message }, 502);
  }

  await audit("reset_password", clientId, true, `password set for ${target.email ?? target.id}`);
  return json({ ok: true, mode: "set", email: target.email ?? null });
});
