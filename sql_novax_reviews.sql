-- ============================================================================
-- NovaX Client Reviews
-- ----------------------------------------------------------------------------
-- One review per client, ever. "Show it once" is enforced by a UNIQUE
-- constraint on client_id, not by localStorage -- a merchant who clears their
-- browser, switches phone, or logs in from the shop laptop still never sees
-- the prompt twice.
--
-- Eligibility differs by cohort:
--   * Clients that existed before go-live  -> eligible immediately.
--   * Clients created after go-live        -> eligible only once they have
--     completed the full journey: a delivered parcel AND a wallet withdrawal
--     that admin has marked Paid.
--
-- Run this whole file once in the Supabase SQL editor.
--
-- PREFLIGHT -- run this line first and confirm it returns a row. The cohort
-- split depends on clients.created_at existing:
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='clients' and column_name='created_at';
-- ============================================================================

-- ---------------------------------------------------------------- table -----
create table if not exists public.reviews (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  rating        int  not null check (rating between 1 and 5),
  comment       text not null default '',
  status        text not null default 'pending'
                  check (status in ('pending','approved','rejected')),
  display_name  text,
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  reviewed_by   uuid,
  constraint reviews_one_per_client unique (client_id)
);

create index if not exists reviews_status_idx  on public.reviews(status, created_at desc);

-- The go-live cutoff that separates the existing 211 merchants from new
-- signups. Everything created strictly before this instant is "existing".
create table if not exists public.nv_review_config (
  id      int primary key default 1,
  cutoff  timestamptz not null default now(),
  constraint nv_review_config_single_row check (id = 1)
);
insert into public.nv_review_config (id, cutoff)
values (1, now())
on conflict (id) do nothing;

-- ------------------------------------------------------------------ RLS -----
alter table public.reviews enable row level security;

-- No direct table access for clients. Everything goes through the RPCs below,
-- so a merchant can never write someone else's review or approve their own.
drop policy if exists reviews_no_direct_access on public.reviews;
create policy reviews_no_direct_access on public.reviews
  for all to authenticated
  using (false) with check (false);

-- ============================================================================
-- 1. Should this merchant see the prompt right now?
-- ============================================================================
create or replace function public.client_review_prompt_state()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id  uuid;
  v_created    timestamptz;
  v_cutoff     timestamptz;
  v_has_review boolean;
  v_delivered  boolean;
  v_paid_out   boolean;
begin
  -- Identity comes from profiles.client_id -- the same link every other
  -- client-side RPC uses. clients has no auth_user_id column.
  select c.id, c.created_at into v_client_id, v_created
  from public.profiles pr
  join public.clients c on c.id = pr.client_id
  where pr.id = auth.uid()
  limit 1;

  if v_client_id is null then
    return json_build_object('eligible', false, 'reason', 'no_workspace');
  end if;

  select exists(select 1 from public.reviews r where r.client_id = v_client_id)
    into v_has_review;

  if v_has_review then
    return json_build_object('eligible', false, 'reason', 'already_reviewed');
  end if;

  select cutoff into v_cutoff from public.nv_review_config where id = 1;

  -- Existing merchants: ask straight away.
  if v_created < v_cutoff then
    return json_build_object('eligible', true, 'reason', 'existing_client');
  end if;

  -- New merchants: only after the whole journey has actually completed.
  select exists(
    select 1 from public.parcels p
    where p.client_id = v_client_id and p.status = 'Delivered'
  ) into v_delivered;

  select exists(
    select 1 from public.withdrawals w
    where w.client_id = v_client_id and w.status = 'Paid'
  ) into v_paid_out;

  if v_delivered and v_paid_out then
    return json_build_object('eligible', true, 'reason', 'journey_complete');
  end if;

  return json_build_object(
    'eligible', false,
    'reason', 'journey_incomplete',
    'delivered', v_delivered,
    'paid_out', v_paid_out
  );
end;
$$;

-- ============================================================================
-- 2. Submit the review. Rejects a second attempt at the database level.
-- ============================================================================
create or replace function public.submit_client_review(
  p_rating  int,
  p_comment text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_name      text;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5.';
  end if;

  select c.id, c.name into v_client_id, v_name
  from public.profiles pr
  join public.clients c on c.id = pr.client_id
  where pr.id = auth.uid()
  limit 1;

  if v_client_id is null then
    raise exception 'No workspace is linked to this login.';
  end if;

  insert into public.reviews (client_id, rating, comment, display_name)
  values (v_client_id, p_rating, coalesce(trim(p_comment), ''), v_name);

  return json_build_object('ok', true);
exception
  when unique_violation then
    -- Already reviewed. Not an error the merchant needs to see as a failure.
    return json_build_object('ok', true, 'already', true);
end;
$$;

-- ============================================================================
-- 3. Public testimonials for the website. Callable by anonymous visitors.
--    Returns approved reviews only, and never exposes client_id.
-- ============================================================================
create or replace function public.public_reviews()
returns table (rating int, comment text, display_name text, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select r.rating, r.comment, coalesce(r.display_name, 'NovaX merchant'), r.created_at
  from public.reviews r
  where r.status = 'approved'
  order by r.created_at desc
  limit 60;
$$;

-- ============================================================================
-- 4. Admin moderation.
-- ============================================================================
create or replace function public.admin_list_reviews()
returns table (
  id uuid, client_id uuid, client_name text, rating int, comment text,
  status text, display_name text, created_at timestamptz, reviewed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and lower(p.role::text) in ('admin','owner','superadmin','ops','ops manager')
  ) then
    raise exception 'Admin access required.';
  end if;

  return query
  select r.id, r.client_id, c.name, r.rating, r.comment,
         r.status, r.display_name, r.created_at, r.reviewed_at
  from public.reviews r
  left join public.clients c on c.id = r.client_id
  order by (r.status = 'pending') desc, r.created_at desc;
end;
$$;

create or replace function public.admin_set_review_status(
  p_review_id    uuid,
  p_status       text,
  p_display_name text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and lower(p.role::text) in ('admin','owner','superadmin','ops','ops manager')
  ) then
    raise exception 'Admin access required.';
  end if;

  if p_status not in ('pending','approved','rejected') then
    raise exception 'Unknown review status: %', p_status;
  end if;

  update public.reviews
  set status       = p_status,
      display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
      reviewed_at  = now(),
      reviewed_by  = auth.uid()
  where id = p_review_id;

  if not found then
    raise exception 'Review not found.';
  end if;

  return json_build_object('ok', true);
end;
$$;

-- ------------------------------------------------------------- grants -------
revoke all on function public.client_review_prompt_state()      from public;
revoke all on function public.submit_client_review(int, text)   from public;
revoke all on function public.public_reviews()                  from public;
revoke all on function public.admin_list_reviews()              from public;
revoke all on function public.admin_set_review_status(uuid, text, text) from public;

grant execute on function public.client_review_prompt_state()    to authenticated;
grant execute on function public.submit_client_review(int, text) to authenticated;
grant execute on function public.admin_list_reviews()            to authenticated;
grant execute on function public.admin_set_review_status(uuid, text, text) to authenticated;

-- The website is public, so anonymous visitors must be able to read approved
-- testimonials. This function exposes no identifiers.
grant execute on function public.public_reviews() to anon, authenticated;
