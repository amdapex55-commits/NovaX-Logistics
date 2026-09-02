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
import { createClient } from "npm:@supabase/supabase-js@2";

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
  const { data: taken } = await asService
    .from("staff_users").select("id, client_id").eq("email", email).limit(1);
  if (taken && taken.length) {
    return json({ error: "That email already has a NovaX seat. Use a different address." }, 409);
  }

  const { data: created, error: createErr } = await asService.auth.admin.createUser({
    email,
    password,
    /* The whole point: no confirmation mail, because there is no mail. */
    email_confirm: true,
    user_metadata: { full_name: name, novax_role: role, created_by_owner: caller.id },
  });
  if (createErr || !created?.user) {
    const msg = String(createErr?.message || "");
    if (/already been registered|already exists/i.test(msg)) {
      return json({ error: "That email already has a NovaX login. Use a different address." }, 409);
    }
    return json({ error: "Could not create the login: " + (msg || "unknown error") }, 502);
  }
  const newId = created.user.id;

  /* From here on, any failure must undo the auth user. */
  const undo = async (why: string, status = 502) => {
    try { await asService.auth.admin.deleteUser(newId); } catch { /* nothing better to do */ }
    return json({ error: why }, status);
  };

  /* my_client_id() reads profiles.client_id. Note this is an UPDATE, not an
     insert: auth.users has an on_auth_user_created trigger (handle_new_user)
     that already inserted the profile row with role 'client' and NO client_id.
     Inserting again fails on profiles_pkey — found by rehearsing this exact
     sequence against production inside a transaction. Without the client_id the
     person signs in successfully to an empty workspace. */
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
     cosmetic one. */
  const { error: staffErr } = await asService.from("staff_users").insert({
    name, email, role, access_side: "client", client_id: clientId,
    auth_user_id: newId, permissions: [], status: "Active",
    invited_by: caller.id, invited_at: new Date().toISOString(),
  });
  if (staffErr) {
    /* deleteUser cascades the profile row, so no separate cleanup is needed. */
    return await undo("Could not save the team member: " + staffErr.message);
  }

  return json({
    ok: true,
    user: { name, email, role },
    password,
    note: "Send these to your team member yourself. The password is shown once and cannot be retrieved again.",
  }, 201);
});
