-- 4 Nov 2026: signup queue. A merchant who signs up sees the portal but
-- cannot use it. They get a queue number (random 101-199) until an admin
-- approves them. Existing merchants have no row and are unaffected.
begin;

create table if not exists public.nv_client_queue (
  client_id   uuid primary key references public.clients(id) on delete cascade,
  number      integer not null,
  status      text not null default 'waiting' check (status in ('waiting','approved')),
  joined_at   timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid
);
alter table public.nv_client_queue enable row level security;
revoke all on public.nv_client_queue from public, anon, authenticated;
create index if not exists nv_client_queue_waiting_idx on public.nv_client_queue (joined_at) where status = 'waiting';

create or replace function public.nv_client_waiting(p_client uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.nv_client_queue q where q.client_id = p_client and q.status = 'waiting');
$$;
revoke all on function public.nv_client_waiting(uuid) from public, anon, authenticated;

-- The server is the gate: nothing is booked, picked up, bought or keyed for a
-- merchant still in the queue, whichever path it comes from (portal, API,
-- Shopify, WooCommerce). Admins may still act for them.
create or replace function public.nv_queue_guard()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.client_id is not null and public.nv_client_waiting(new.client_id) and not public.is_admin() then
    raise exception 'Your NovaX account is still in the queue. You can use it as soon as it is approved.'
      using errcode = 'P0001', hint = 'NOVAX_QUEUE';
  end if;
  return new;
end $$;
revoke all on function public.nv_queue_guard() from public, anon, authenticated;

drop trigger if exists trg_nv_queue_guard on public.parcels;
create trigger trg_nv_queue_guard before insert on public.parcels for each row execute function public.nv_queue_guard();
drop trigger if exists trg_nv_queue_guard on public.pickup_requests;
create trigger trg_nv_queue_guard before insert on public.pickup_requests for each row execute function public.nv_queue_guard();
drop trigger if exists trg_nv_queue_guard on public.nv_flyer_orders;
create trigger trg_nv_queue_guard before insert on public.nv_flyer_orders for each row execute function public.nv_queue_guard();
drop trigger if exists trg_nv_queue_guard on public.nv_api_key;
create trigger trg_nv_queue_guard before insert on public.nv_api_key for each row execute function public.nv_queue_guard();

-- The merchant's own place in line.
create or replace function public.nv_my_queue()
returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(
    (select jsonb_build_object('waiting', q.status = 'waiting', 'number', q.number,
                               'joinedAt', q.joined_at, 'approvedAt', q.approved_at,
                               'email', (select u.email from auth.users u where u.id = auth.uid()))
       from public.nv_client_queue q where q.client_id = public.my_client_id()),
    jsonb_build_object('waiting', false));
$$;
revoke all on function public.nv_my_queue() from public, anon;
grant execute on function public.nv_my_queue() to authenticated;

-- Admin: everyone waiting, oldest first, plus the last 14 days approved.
create or replace function public.admin_queue_list()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'clientId', c.id, 'code', c.meta->>'clientCode', 'name', c.name, 'owner', c.owner, 'phone', c.phone,
      'city', coalesce(c.meta->>'pickupCity', c.city), 'business', c.business_type, 'website', c.website,
      'address', c.address, 'email', public.nv_email_owner(c.id),
      'number', q.number, 'status', q.status, 'joinedAt', q.joined_at, 'approvedAt', q.approved_at)
      order by (q.status = 'waiting') desc, q.joined_at)
    from public.nv_client_queue q join public.clients c on c.id = q.client_id
    where q.status = 'waiting' or q.approved_at > now() - interval '14 days'), '[]'::jsonb);
end $$;
revoke all on function public.admin_queue_list() from public, anon;
grant execute on function public.admin_queue_list() to authenticated;

-- Admin: let a merchant in. Emails the owner that their portal is open.
create or replace function public.admin_queue_approve(p_client uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_row public.nv_client_queue; v_email text; v_name text; v_biz text;
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  update public.nv_client_queue
     set status = 'approved', approved_at = now(), approved_by = auth.uid()
   where client_id = p_client and status = 'waiting'
  returning * into v_row;
  if v_row.client_id is null then
    if exists (select 1 from public.nv_client_queue where client_id = p_client) then
      return jsonb_build_object('ok', true, 'already', true);
    end if;
    raise exception 'That merchant is not in the queue.';
  end if;
  v_email := public.nv_email_owner(p_client);
  select c.name, coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''), c.owner, '')
    into v_biz, v_name
    from public.clients c left join auth.users u on lower(u.email) = lower(v_email)
   where c.id = p_client;
  if v_email is not null then
    begin
      perform public.nv_email_enqueue('portal_open:' || p_client, 'portal_open', v_email,
        jsonb_build_object('name', coalesce(v_name, ''), 'business', coalesce(v_biz, ''), 'number', v_row.number));
    exception when others then raise warning 'NovaX email enqueue failed (portal_open), SQLSTATE %', SQLSTATE;
    end;
  end if;
  insert into public.audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'queue_approved', 'client', p_client, jsonb_build_object('number', v_row.number));
  return jsonb_build_object('ok', true, 'emailed', v_email is not null);
end $$;
revoke all on function public.admin_queue_approve(uuid) from public, anon;
grant execute on function public.admin_queue_approve(uuid) to authenticated;

alter table public.nv_email_queue drop constraint nv_email_queue_kind_check;
alter table public.nv_email_queue add constraint nv_email_queue_kind_check check (kind = any (array[
  'recover_refused','recover_won','recover_launch','welcome','first_booking','payout_paid','cnic_verified',
  'cnic_rejected','first_parcel_d1','first_parcel_d3','first_parcel_d7','back_quiet','back_tried','setup_ready',
  'stations_launch','flyers_launch','reattempt_digest','portal_open']));

CREATE OR REPLACE FUNCTION public.create_client_workspace(p_name text, p_owner text, p_phone text, p_city text, p_address text, p_business_type text, p_website text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_existing_client_id uuid;
  v_existing_role text;
  v_client_id uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a workspace.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  select client_id, role::text into v_existing_client_id, v_existing_role
    from public.profiles where id = v_uid;
  if v_existing_client_id is not null then
    return v_existing_client_id;
  end if;
  /* The upsert below sets role = 'client'. Called from an admin, staff or
     rider session -- any profile that exists and is not a merchant -- it
     silently turned that account into a merchant and cut it off from
     admin.html / rider.html. Only a brand-new login or a merchant profile
     still waiting for its workspace may be provisioned here. */
  if v_existing_role is not null and v_existing_role <> 'client' then
    raise exception 'This login is a % account, not a merchant account. Sign in to the right portal.', v_existing_role
      using errcode = '42501';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into public.clients (
    name, owner, meta, phone, business_type, address, city, website,
    status, wallet_balance, rate, rate_card, pricing_mode, risk_score
  )
  values (
    coalesce(nullif(btrim(p_name), ''), split_part(coalesce(v_email,''), '@', 1), 'Merchant'),
    coalesce(nullif(btrim(p_owner), ''), split_part(coalesce(v_email,''), '@', 1), 'Merchant'),
    jsonb_build_object('email', coalesce(v_email, '')),
    coalesce(p_phone, ''), coalesce(p_business_type, ''), coalesce(p_address, ''), coalesce(p_city, ''), coalesce(p_website, ''),
    'Active', 0,
    225,                                     -- Zone A base; Zone B is 250
    jsonb_build_object(
      'A', jsonb_build_object('overnight', 225, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45),
      'B', jsonb_build_object('overnight', 250, 'additionalKg', 85, 'detainBase', 540, 'detainAdditionalKg', 125, 'overlandBase', 900, 'overlandAdditionalKg', 45)
    ),
    'flat',
    0
  )
  returning id into v_client_id;

  -- 4 Nov 2026: a merchant who signs up waits in the queue until an admin
  -- lets them in (nv_client_queue). The number is a random 101-199.
  insert into public.nv_client_queue (client_id, number)
  values (v_client_id, 101 + floor(random() * 99)::int)
  on conflict (client_id) do nothing;

  insert into public.profiles (id, email, role, status, client_id)
  values (v_uid, v_email, 'client', 'active', v_client_id)
  on conflict (id) do update
    set email = coalesce(public.profiles.email, excluded.email),
        role = 'client',
        status = 'active',
        client_id = excluded.client_id;

  return v_client_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.nv_email_first_parcel_reminders(p_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_local timestamp := p_now at time zone 'Asia/Karachi';
  v_budget integer;
  v_queued integer := 0;
  v_token uuid;
  r record;
begin
  -- Monday to Saturday, 10 am to 8 pm Pakistan time: inside support hours, so a
  -- merchant who answers on WhatsApp reaches a person.
  if extract(isodow from v_local) = 7 or extract(hour from v_local) < 10
     or extract(hour from v_local) >= 20 then
    return 0;
  end if;
  -- Resend's free plan sends 100 emails a day. Reminders stop at 80, so account
  -- emails (welcome, first booking, payouts, CNIC) always have room.
  select 80 - count(*) into v_budget from public.nv_email_queue
  where accepted_at > p_now - interval '24 hours'
     or (state = 'pending' and next_attempt_at <= p_now + interval '1 hour');
  v_budget := least(v_budget, 20);
  if v_budget <= 0 then return 0; end if;

  for r in
    with owners as (
      select c.id as client_id, c.name as business, btrim(u.email) as email,
        coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
          nullif(btrim(to_jsonb(p)->>'full_name'), ''), '') as name,
        p_now - greatest(c.created_at, u.created_at, coalesce(cq.approved_at, c.created_at)) as age
      from public.clients c
      join public.profiles p on p.client_id = c.id and p.role::text = 'client'
      join auth.users u on u.id = p.id
      -- 4 Nov 2026: a merchant still in the signup queue cannot book yet, and
      -- the reminders count from the day the portal opened for them.
      left join public.nv_client_queue cq on cq.client_id = c.id
      where lower(coalesce(c.status, 'active')) = 'active'
        and coalesce(cq.status, 'approved') = 'approved'
        and greatest(c.created_at, u.created_at, coalesce(cq.approved_at, c.created_at))
            between p_now - interval '10 days' and p_now - interval '1 day'
        and u.email ~ '^[^[:space:]<>@,;]+@[^[:space:]<>@,;]+[.][^[:space:]<>@,;]+$'
        and lower(u.email) = lower(public.nv_email_owner(c.id))
    ), due as (
      select o.*, case when o.age >= interval '7 days' then 7
                       when o.age >= interval '3 days' then 3 else 1 end as step
      from owners o
    )
    select d.* from due d
    where not exists (select 1 from public.parcels x where x.client_id = d.client_id)
      and not exists (select 1 from public.nv_email_reminders s
                      where s.client_id = d.client_id and s.stopped_at is not null)
      and not exists (select 1 from public.client_notification_prefs n
                      where n.client_id = d.client_id and n.email_enabled is false)
      and not exists (select 1 from public.nv_email_milestones m
                      where m.event_key = 'first_parcel_d' || d.step || ':' || d.client_id)
      -- Never two emails to one inbox within 20 hours, or two reminders within 44.
      and not exists (select 1 from public.nv_email_queue q
                      where lower(btrim(q.recipient)) = lower(d.email)
                        and q.created_at > p_now - interval '20 hours')
      and not exists (select 1 from public.nv_email_queue q
                      where q.event_key in ('first_parcel_d1:' || d.client_id,
                        'first_parcel_d3:' || d.client_id, 'first_parcel_d7:' || d.client_id)
                        and q.created_at > p_now - interval '44 hours')
    -- When the budget binds, the reminder whose window closes soonest goes first.
    order by (case d.step when 1 then interval '3 days' when 3 then interval '7 days'
              else interval '10 days' end) - d.age, d.client_id
    limit v_budget
  loop
    insert into public.nv_email_reminders(client_id) values (r.client_id)
      on conflict (client_id) do nothing;
    select token into v_token from public.nv_email_reminders where client_id = r.client_id;
    perform public.nv_email_enqueue('first_parcel_d' || r.step || ':' || r.client_id,
      'first_parcel_d' || r.step, r.email,
      jsonb_build_object('name', r.name, 'business', r.business, 'token', v_token, 'step', r.step));
    v_queued := v_queued + 1;
  end loop;
  return v_queued;
end;
$function$;

commit;
