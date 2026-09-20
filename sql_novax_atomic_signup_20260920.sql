-- NovaX — atomic signup provisioning.
--
-- WHY. Signup was three independent operations: auth.signUp(), then
-- nv_signup_lead_create(), then create_client_workspace(). Auth lives in a
-- different service and can never share a transaction with the database, but
-- the two DATABASE steps could -- and did not. A failure between them left a
-- merchant able to log in with no workspace, or a workspace with no lead for
-- Admin to see. Three such accounts exist in production today
-- (profiles.client_id is null on a 'client' role).
--
-- nv_signup_lead_create() also inserted unconditionally, so every retry of a
-- half-finished signup would add another lead row. No duplicates exist yet;
-- this closes it before they do.
--
-- WHAT. One function that does both in a single transaction and is safe to
-- call repeatedly. A plpgsql function IS one transaction, so either the
-- workspace and the lead both exist afterwards or neither does.
--
-- Idempotent by design, because the sign-in recovery path calls it on every
-- login for an account that has no workspace yet:
--   * workspace: delegates to create_client_workspace(), which already takes
--     an advisory lock on the uid and returns the existing client_id.
--   * lead: inserted only when this auth user has none.
-- Existing accounts are untouched -- a merchant who already has a workspace
-- gets their existing client_id back and no second lead row.

create or replace function public.nv_signup_provision(
  p_name          text,
  p_owner         text,
  p_phone         text,
  p_city          text,
  p_address       text,
  p_business_type text,
  p_website       text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text;
  v_client_id uuid;
  v_had_workspace uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to set up your workspace.';
  end if;

  -- Same key create_client_workspace uses. pg_advisory_xact_lock is
  -- re-entrant within a transaction, so taking it here and again inside that
  -- function is safe, and two concurrent tabs cannot both provision.
  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  select email into v_email from auth.users where id = v_uid;

  -- Did this account already have a workspace? Decided BEFORE provisioning,
  -- because it is what separates a real new signup from an existing merchant
  -- simply signing in.
  select client_id into v_had_workspace from public.profiles where id = v_uid;

  -- 1. Workspace. Returns the existing one when there is one.
  v_client_id := public.create_client_workspace(
    p_name, p_owner, p_phone, p_city, p_address, p_business_type, p_website
  );

  -- 2. Lead -- ONLY for a genuinely new workspace.
  --    Writing it whenever one was merely missing looked harmless and was not:
  --    the 231 merchants who predate the leads feature have no lead row, so the
  --    next sign-in of each would have manufactured a brand-new "signup" for
  --    Admin to chase. Rehearsal caught exactly that (leads_delta: 2 from two
  --    existing accounts). A lead belongs to a signup, not to a login.
  if v_had_workspace is null
     and not exists (select 1 from public.signup_leads where auth_user_id = v_uid) then
    insert into public.signup_leads
      (name, phone, email, city, address, business_type, website, auth_user_id, status)
    values (
      left(coalesce(nullif(btrim(p_name),''), split_part(coalesce(v_email,''),'@',1), 'Merchant'), 200),
      left(coalesce(p_phone,''), 40),
      left(lower(coalesce(v_email,'')), 200),
      left(coalesce(p_city,''), 80),
      left(coalesce(p_address,''), 500),
      left(coalesce(p_business_type,''), 200),
      left(coalesce(p_website,''), 300),
      v_uid,
      'workspace_created'
    );
  end if;

  return v_client_id;
end
$$;

revoke all on function public.nv_signup_provision(text,text,text,text,text,text,text) from public;
grant execute on function public.nv_signup_provision(text,text,text,text,text,text,text) to authenticated;

-- Repairs the three 'client' accounts that can sign in with no workspace.
-- Deliberately scoped: role must be 'client', so the riders and admins that
-- correctly have no client_id are never given one. Idempotent -- re-running
-- changes nothing once they are repaired.
do $$
declare r record; v_client_id uuid; v_repaired int := 0;
begin
  for r in
    select p.id, u.email, u.raw_user_meta_data as meta
    from public.profiles p join auth.users u on u.id = p.id
    where p.client_id is null and p.role::text = 'client'
  loop
    insert into public.clients (
      name, owner, meta, phone, business_type, address, city, website,
      status, wallet_balance, rate, rate_card, pricing_mode, risk_score
    ) values (
      coalesce(nullif(btrim(r.meta->>'business_name'),''), split_part(coalesce(r.email,''),'@',1), 'Merchant'),
      coalesce(nullif(btrim(r.meta->>'owner_name'),''),   split_part(coalesce(r.email,''),'@',1), 'Merchant'),
      jsonb_build_object('email', coalesce(r.email,''), 'repaired_at', now()),
      coalesce(r.meta->>'phone',''), coalesce(r.meta->>'business_type',''),
      coalesce(r.meta->>'address',''), coalesce(r.meta->>'city',''), coalesce(r.meta->>'website',''),
      'Active', 0, 225,
      jsonb_build_object(
        'A', jsonb_build_object('overnight',225,'additionalKg',85,'detainBase',540,'detainAdditionalKg',125,'overlandBase',900,'overlandAdditionalKg',45),
        'B', jsonb_build_object('overnight',250,'additionalKg',85,'detainBase',540,'detainAdditionalKg',125,'overlandBase',900,'overlandAdditionalKg',45)
      ),
      'flat', 0
    ) returning id into v_client_id;

    update public.profiles set client_id = v_client_id, status = 'active' where id = r.id;
    v_repaired := v_repaired + 1;
  end loop;
  raise notice 'repaired % orphaned client workspace(s)', v_repaired;
end $$;
