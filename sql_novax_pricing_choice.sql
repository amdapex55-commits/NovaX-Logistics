-- ============================================================================
-- NovaX -- merchant-chosen pricing mode
--
-- WHY: distance pricing is already live (base 120 / 6km included / 20 per km /
-- max 320 / road factor 1.35). But whether a merchant actually GETS it is
-- decided by a chain nobody chose: global toggle AND pickup area mapped AND
-- destination area mapped AND city = Karachi. Fail any link and the parcel is
-- silently charged the flat zone rate instead. client.html says as much in its
-- own comment: "They are not choosing the fallback -- they do not know it
-- exists." That is the "two different rates" merchants keep asking about.
--
-- This makes the mode an explicit, recorded decision on the client row.
--
-- WHAT IT DOES NOT DO: it does not compute fees. client_book_parcel and
-- client_book_parcel_geo already do that and their bodies are not in this
-- repo, so nothing here rewrites pricing maths. This adds the stored choice,
-- the RPCs to read/set it, and a guard that stops a flat-mode merchant ever
-- receiving a distance-priced parcel.
--
-- Safe to re-run.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The stored choice
-- ----------------------------------------------------------------------------
alter table public.clients
  add column if not exists pricing_mode        text        not null default 'flat',
  add column if not exists pricing_mode_at     timestamptz,
  add column if not exists pricing_mode_source text;

-- Existing merchants default to 'flat'. That is deliberate: it is what almost
-- all of them are effectively paying today (unmapped pickup => flat), so the
-- default changes nobody's bill. The prompt is what moves them.
do $do$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_pricing_mode_chk'
  ) then
    alter table public.clients
      add constraint clients_pricing_mode_chk
      check (pricing_mode in ('flat','distance'));
  end if;
end
$do$;

create index if not exists idx_clients_pricing_mode
  on public.clients (pricing_mode);


-- ----------------------------------------------------------------------------
-- 2. Should this merchant be asked?
--
--    Mirrors client_review_prompt_state() deliberately -- same identity chain
--    (profiles.id = auth.uid() -> profiles.client_id), same json shape, so the
--    browser side is the same pattern the review prompt already proved.
--
--    Pickup-point status is NOT checked here. client.html already loads it via
--    client_pickup_locations_list() before it can render the prompt, and
--    duplicating that lookup would mean guessing at a table this file has no
--    business knowing about.
-- ----------------------------------------------------------------------------
create or replace function public.client_pricing_choice_state()
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_client_id uuid;
  v_mode      text;
  v_at        timestamptz;
begin
  select c.id, c.pricing_mode, c.pricing_mode_at
    into v_client_id, v_mode, v_at
  from public.profiles pr
  join public.clients  c on c.id = pr.client_id
  where pr.id = auth.uid()
  limit 1;

  if v_client_id is null then
    return json_build_object('eligible', false, 'reason', 'no_workspace');
  end if;

  -- Answered already: never ask twice. pricing_mode_at is the marker, not
  -- pricing_mode itself, because 'flat' is also the untouched default.
  if v_at is not null then
    return json_build_object(
      'eligible', false,
      'reason',   'already_chosen',
      'mode',     v_mode,
      'chosen_at', v_at
    );
  end if;

  return json_build_object(
    'eligible', true,
    'reason',   'not_chosen',
    'mode',     coalesce(v_mode, 'flat')
  );
end
$fn$;


-- ----------------------------------------------------------------------------
-- 3. The merchant records their choice
--
--    Write-once from the merchant's side. Once pricing_mode_at is stamped this
--    refuses, so a replayed request or a double-tapped card cannot flip a
--    merchant onto the other rate behind their back. Admin override in 4.
-- ----------------------------------------------------------------------------
create or replace function public.client_set_pricing_choice(p_choice text)
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_client_id uuid;
  v_at        timestamptz;
begin
  if p_choice is null or p_choice not in ('flat','distance') then
    return json_build_object('ok', false, 'error', 'invalid_choice');
  end if;

  select c.id, c.pricing_mode_at
    into v_client_id, v_at
  from public.profiles pr
  join public.clients  c on c.id = pr.client_id
  where pr.id = auth.uid()
  limit 1;

  if v_client_id is null then
    return json_build_object('ok', false, 'error', 'no_workspace');
  end if;

  -- Lock the row so two tabs cannot both pass the "not chosen yet" check.
  perform 1 from public.clients where id = v_client_id for update;

  select pricing_mode_at into v_at from public.clients where id = v_client_id;
  if v_at is not null then
    return json_build_object('ok', false, 'error', 'already_chosen');
  end if;

  update public.clients
     set pricing_mode        = p_choice,
         pricing_mode_at     = now(),
         pricing_mode_source = 'merchant'
   where id = v_client_id;

  return json_build_object('ok', true, 'mode', p_choice);
end
$fn$;


-- ----------------------------------------------------------------------------
-- 4. Admin override
--
--    "No fallback" means a merchant who picks distance and cannot be quoted is
--    blocked rather than quietly charged flat. That is only humane if somebody
--    can move them back, so ops needs this.
-- ----------------------------------------------------------------------------
create or replace function public.admin_set_client_pricing_mode(
  p_client_id uuid,
  p_mode      text
)
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_role text;
begin
  select lower(pr.role::text) into v_role
  from public.profiles pr where pr.id = auth.uid() limit 1;

  if v_role is null or v_role not in ('admin','owner') then
    return json_build_object('ok', false, 'error', 'not_authorised');
  end if;

  if p_mode is null or p_mode not in ('flat','distance') then
    return json_build_object('ok', false, 'error', 'invalid_mode');
  end if;

  if not exists (select 1 from public.clients where id = p_client_id) then
    return json_build_object('ok', false, 'error', 'no_such_client');
  end if;

  update public.clients
     set pricing_mode        = p_mode,
         pricing_mode_at     = now(),
         pricing_mode_source = 'admin'
   where id = p_client_id;

  return json_build_object('ok', true, 'mode', p_mode);
end
$fn$;


-- ----------------------------------------------------------------------------
-- 5. The no-fallback guard
--
--    Stamps every new parcel with the mode its merchant actually chose, and
--    refuses a distance-priced parcel for a flat-mode merchant.
--
--    It deliberately does NOT recompute fee. The booking RPCs own that and are
--    not visible here; a second pricing implementation in a trigger is exactly
--    the "same rule written twice" split that caused the 180/200/250 drift.
--    This only asserts the mode is the one on record.
-- ----------------------------------------------------------------------------
create or replace function public.nv_enforce_pricing_mode()
returns trigger
language plpgsql
as $fn$
declare
  v_mode text;
begin
  if new.client_id is null then
    return new;
  end if;

  select pricing_mode into v_mode
  from public.clients where id = new.client_id;

  if v_mode is null then
    return new;               -- unknown client: leave the booking path alone
  end if;

  if v_mode = 'flat' then
    -- A flat merchant must never be handed a distance price.
    if new.pricing_mode is not null and new.pricing_mode like 'distance%' then
      raise exception
        'Client % is on flat pricing but this parcel was priced by distance. Booking refused rather than silently charging a rate the merchant did not choose.',
        new.client_id;
    end if;
    new.pricing_mode := 'flat';
    new.distance_km  := null;
  end if;

  -- Distance merchants are not forced the other way: Lahore is flat 200 in
  -- both modes, so a flat-priced parcel is legitimate for them.
  return new;
end
$fn$;

drop trigger if exists trg_nv_enforce_pricing_mode on public.parcels;
create trigger trg_nv_enforce_pricing_mode
  before insert on public.parcels
  for each row execute function public.nv_enforce_pricing_mode();


-- ----------------------------------------------------------------------------
-- 6. Grants
-- ----------------------------------------------------------------------------
revoke all on function public.client_pricing_choice_state()          from public;
revoke all on function public.client_set_pricing_choice(text)        from public;
revoke all on function public.admin_set_client_pricing_mode(uuid,text) from public;

grant execute on function public.client_pricing_choice_state()          to authenticated;
grant execute on function public.client_set_pricing_choice(text)        to authenticated;
grant execute on function public.admin_set_client_pricing_mode(uuid,text) to authenticated;


-- ----------------------------------------------------------------------------
-- 7. Verify
-- ----------------------------------------------------------------------------
-- select pricing_mode, count(*) from public.clients group by 1;
-- select id, name, pricing_mode, pricing_mode_at, pricing_mode_source
--   from public.clients where pricing_mode_at is not null order by pricing_mode_at desc limit 20;
