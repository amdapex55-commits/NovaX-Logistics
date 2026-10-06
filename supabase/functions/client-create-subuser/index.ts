/* client-create-subuser
   ─────────────────────────────────────────────────────────────────────────
   Why this exists: "Invite a user" called invite_staff_user(), which inserted a
   staff_users row with status 'Pending' and stopped there. It created no auth
   user, set no password, and sent no email — NovaX has no mail provider wired
   up. So the owner saw a row that looked like a team member, handed out the
   email address, and that person could never sign in. There was nothing to
   confirm and nothing to click.

   This creates a sub-user that can log in immediately, no email involved:

     1. a Supabase auth user with email_confirm: true (nothing to verify)
     2. a profiles row  — my_client_id() reads profiles.client_id, so without
        this the person logs in to an empty workspace
     3. a staff_users row — the portal resolves a seat's ROLE by matching the
        session email against staff_users, so without this they would silently
        be treated as an Owner

   All three or none: if a later step fails the auth user is deleted again,
   because a half-made account is worse than none — it blocks the email from
   ever being used and gives someone a login into nothing.

   The password is returned ONCE. The owner passes it on however they already
   talk to their staff, which in Pakistan is WhatsApp, not email.
*/
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ROLES = ["Owner", "Finance", "Warehouse", "Support"];

/* Readable on a phone screen and safe to dictate aloud: no l/1/I/O/0. */
function makePassword(): string {
  const words = ["Parcel", "Karachi", "Lahore", "Rider", "Wallet", "Ledger", "Transit", "Pickup"];
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let tail = "";
  for (const b of bytes) tail += chars[b % chars.length];
  return words[bytes[0] % words.length] + "-" + tail;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Not signed in." }, 401);

  const SB_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE) return json({ error: "Server is not configured to create users." }, 503);

  const asCaller = createClient(SB_URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: userRes, error: userErr } = await asCaller.auth.getUser();
  const caller = userRes?.user;
  if (userErr || !caller) return json({ error: "Not signed in." }, 401);

  /* Both answers come from the caller's own JWT, never from the request body. */
  const [{ data: isOwner, error: ownerErr }, { data: clientId, error: cidErr }] = await Promise.all([
    asCaller.rpc("is_client_owner_seat"),
    asCaller.rpc("my_client_id"),
  ]);
  if (ownerErr || cidErr) return json({ error: "Could not verify your workspace access." }, 500);
  if (!clientId) return json({ error: "No client workspace is linked to this account." }, 403);
  if (!isOwner) return json({ error: "Only the workspace Owner can create team logins." }, 403);

  let body: { name?: string; email?: string; role?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request body." }, 400); }

  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "").trim();
  let password = String(body.password ?? "").trim();

  if (!name) return json({ error: "A name is required." }, 422);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "A valid email address is required." }, 422);
  if (!ROLES.includes(role)) return json({ error: `Role must be one of: ${ROLES.join(", ")}.` }, 422);
  if (password && password.length < 10) {
    return json({ error: "Password must be at least 10 characters. Leave it blank and we will generate one." }, 422);
  }
  if (!password) password = makePassword();

  const asService = createClient(SB_URL, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  /* Refuse before creating anything. staff_users is checked across ALL
     workspaces on purpose — one email is one person on NovaX. */
  /* A REVOKED seat must not block reuse. This originally matched ANY row for
     the address, so revoking someone and then re-inviting them failed forever
     with "That email already has a NovaX seat" — reported by Hayat Scents, who
     revoked syedabdullah0420@gmail.com and could not reissue it. Revoking is
     how you take access away; it cannot also be how you burn the address. */
  const { data: seats, error: seatsErr } = await asService
    .from("staff_users").select("id, client_id, status, name, role, auth_user_id, permissions, invited_by, invited_at").eq("email", email);
  if (seatsErr) return json({ error: "Could not check existing seats. Try again." }, 500);
  const live = (seats ?? []).filter((r: any) => String(r.status ?? "Active") !== "Revoked");
  if (live.length) {
    return json({ error: "That email already has an active NovaX seat. Revoke it first, or use a different address." }, 409);
  }
  /* 6 Oct 2026 audit. Only revoked rows remain, and only THIS workspace's are
     ours to touch. This used to delete every revoked row for the address in
     every workspace, before its own checks had run: inviting an address from
     merchant B erased merchant A's revoked record even when B was then
     refused. Other workspaces' rows are now left alone, and nothing is
     changed until every check below has passed. */
  const mine = (seats ?? []).filter((r: any) => String(r.client_id ?? "") === String(clientId));

  const { data: created, error: createErr } = await asService.auth.admin.createUser({
    email,
    password,
    /* The whole point: no confirmation mail, because there is no mail. */
    email_confirm: true,
    user_metadata: { full_name: name, novax_role: role, created_by_owner: caller.id },
  });
  /* A revoked seat can leave its auth user behind, so re-inviting that person
     hit the same dead end one layer down. With no live seat anywhere for this
     address (checked above), that login is an orphan and the owner is entitled
     to re-issue it — reuse it, rather than telling them to invent a new email
     address. Its password is reset LAST (see below). */
  let newId: string;
  const reusedExisting = !!(createErr || !created?.user);
  if (reusedExisting) {
    const msg = String(createErr?.message || "");
    if (!/already been registered|already exists/i.test(msg)) {
      return json({ error: "Could not create the login: " + (msg || "unknown error") }, 502);
    }
    const { data: found } = await asService.auth.admin.listUsers({ page: 1, perPage: 200 });
    const existing = (found?.users ?? []).find(
      (u: any) => String(u.email ?? "").toLowerCase() === email,
    );
    if (!existing) {
      return json({ error: "That email already has a NovaX login that could not be re-issued. Use a different address." }, 409);
    }
    /* Re-issuing resets that login's password and moves it into THIS
       workspace, so it is only allowed for a login this workspace itself
       revoked. "No active seat anywhere" was not enough: another merchant's
       owner, a rider, an admin, or anyone who signed up and never got a seat
       has no active staff_users row either -- and an owner who typed their
       email would have taken over that account. */
    const { data: prof } = await asService
      .from("profiles").select("role, client_id").eq("id", existing.id).maybeSingle();
    const profRole = String(prof?.role ?? "client").toLowerCase();
    const profClient = prof?.client_id ? String(prof.client_id) : null;
    if (!mine.length || profRole !== "client" || (profClient !== null && profClient !== String(clientId))) {
      return json({
        error: "That email already belongs to a NovaX account that this workspace cannot re-issue. Use a different address, or contact NovaX support.",
      }, 409);
    }
    newId = existing.id;
  } else {
    newId = created!.user!.id;
  }

  /* From here on, any failure must put everything back. */
  let prevProfile: { client_id: string | null; full_name: string | null; email: string | null } | null = null;
  let seatId: string | null = null;      // the seat row this request made Active
  let seatWasInserted = false;
  const prevSeat: any = mine[0] ?? null; // the revoked row being brought back, as it was
  const undo = async (why: string, status = 502) => {
    try {
      if (seatId && seatWasInserted) await asService.from("staff_users").delete().eq("id", seatId);
      else if (seatId && prevSeat) {
        await asService.from("staff_users").update({
          name: prevSeat.name, role: prevSeat.role, status: prevSeat.status, auth_user_id: prevSeat.auth_user_id,
          permissions: prevSeat.permissions, invited_by: prevSeat.invited_by, invited_at: prevSeat.invited_at,
        }).eq("id", seatId);
      }
    } catch { /* keep undoing */ }
    if (reusedExisting) {
      /* A reused login predates us: never delete it, only restore its profile. */
      if (prevProfile) { try { await asService.from("profiles").update(prevProfile).eq("id", newId); } catch { /* nothing better to do */ } }
    } else {
      try { await asService.auth.admin.deleteUser(newId); } catch { /* nothing better to do */ }
    }
    return json({ error: why }, status);
  };

  /* my_client_id() reads profiles.client_id. Note this is an UPDATE, not an
     insert: auth.users has an on_auth_user_created trigger (handle_new_user)
     that already inserted the profile row with role 'client' and NO client_id.
     Inserting again fails on profiles_pkey — found by rehearsing this exact
     sequence against production inside a transaction. Without the client_id the
     person signs in successfully to an empty workspace. */
  if (reusedExisting) {
    const { data: was } = await asService.from("profiles").select("client_id, full_name, email").eq("id", newId).maybeSingle();
    prevProfile = was ? { client_id: was.client_id ?? null, full_name: was.full_name ?? null, email: was.email ?? null } : null;
  }
  const { data: linked, error: profErr } = await asService
    .from("profiles")
    .update({ client_id: clientId, full_name: name, email })
    .eq("id", newId)
    .select("id, client_id");
  if (profErr) return await undo("Could not link the login to your workspace: " + profErr.message);
  if (!linked || !linked.length || !linked[0].client_id) {
    return await undo("The login was created but could not be linked to your workspace. Nothing was kept.");
  }

  /* The portal resolves a seat's ROLE from here, by session email. Without it
     they would default to Owner — which is the dangerous failure, not a
     cosmetic one. A seat this workspace revoked earlier is brought back in
     place (same row); only this workspace's rows are ever written. */
  const seat = {
    name, email, role, access_side: "client", client_id: clientId,
    auth_user_id: newId, permissions: [], status: "Active",
    invited_by: caller.id, invited_at: new Date().toISOString(),
  };
  if (prevSeat) {
    const { data: up, error: upErr } = await asService.from("staff_users").update(seat)
      .eq("id", prevSeat.id).eq("client_id", clientId).select("id");
    if (upErr || !up || !up.length) return await undo("Could not save the team member: " + (upErr?.message || "the seat was not found"));
    seatId = prevSeat.id;
  } else {
    const { data: ins, error: staffErr } = await asService.from("staff_users").insert(seat).select("id");
    if (staffErr || !ins || !ins.length) return await undo("Could not save the team member: " + (staffErr?.message || "nothing was saved"));
    seatId = ins[0].id; seatWasInserted = true;
  }
  /* Older duplicate revoked rows for this address IN THIS WORKSPACE would
     still read as "revoked" to the permission checks, so they go. */
  const extra = mine.filter((r: any) => r.id !== seatId).map((r: any) => r.id);
  if (extra.length) {
    const { error: delErr } = await asService.from("staff_users").delete().in("id", extra).eq("client_id", clientId);
    if (delErr) return await undo("Could not tidy the old seat for that address: " + delErr.message);
  }

  /* Last of all, and only for a re-issued login: its password. It used to be
     reset first, so a failure further down left the invitation refused but
     the person's old password already dead. */
  if (reusedExisting) {
    const { error: resetErr } = await asService.auth.admin.updateUserById(newId, {
      password,
      email_confirm: true,
      user_metadata: { full_name: name, novax_role: role, reissued_by_owner: caller.id },
    });
    if (resetErr) return await undo("Could not re-issue that login: " + resetErr.message);
  }

  return json({
    ok: true,
    user: { name, email, role },
    password,
    note: "Send these to your team member yourself. The password is shown once and cannot be retrieved again.",
  }, 201);
});
