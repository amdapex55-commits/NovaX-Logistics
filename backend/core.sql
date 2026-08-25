-- =====================================================================
-- NovaX backend -- core
--
-- GENERATED from the live database, 2026-08-24. Do not hand-edit: change the
-- function in Supabase, then re-export so this file stays truthful.
--
-- This exists because 71 of the 88 RPCs the portals call had no source
-- anywhere outside the deployed database. That is what made every question
-- -- "is per-km still on?", "does the money tab count new bookings?",
-- "what does that trigger do?" -- an archaeological dig instead of a diff.
--
-- 31 function(s) in this file.
-- =====================================================================

CREATE FUNCTION public.build_weekly_digests() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_week_start date := (date_trunc('week', now()) - interval '1 week')::date;
  v_week_end   date := date_trunc('week', now())::date;
  v_count      integer := 0;
begin
  insert into public.client_digests (
    client_id, week_start, delivered_count, cod_collected, fees_paid,
    best_city, worst_city, headline
  )
  select
    c.id,
    v_week_start,
    coalesce(d.delivered_count, 0),
    coalesce(d.cod_collected, 0),
    coalesce(f.fees_paid, 0),
    d.best_city,
    d.worst_city,
    case
      when coalesce(d.delivered_count, 0) = 0
        then 'No deliveries completed last week.'
      else coalesce(d.delivered_count, 0) || ' parcels delivered, '
           || to_char(coalesce(d.cod_collected, 0), 'FM999,999,999') || ' PKR collected.'
    end
  from public.clients c
  left join lateral (
    select
      count(*) filter (where p.status = 'Delivered')::int as delivered_count,
      coalesce(sum(p.cod_amount) filter (where p.status = 'Delivered'), 0) as cod_collected,
      (select p2.city from public.parcels p2
        where p2.client_id = c.id
          and p2.status = 'Delivered'
          and p2.updated_at >= v_week_start
          and p2.updated_at <  v_week_end
        group by p2.city order by count(*) desc limit 1) as best_city,
      (select p3.city from public.parcels p3
        where p3.client_id = c.id
          and p3.status in ('Refused', 'Consignee not available')
          and p3.updated_at >= v_week_start
          and p3.updated_at <  v_week_end
        group by p3.city order by count(*) desc limit 1) as worst_city
    from public.parcels p
    where p.client_id = c.id
      and p.updated_at >= v_week_start
      and p.updated_at <  v_week_end
  ) d on true
  left join lateral (
    select coalesce(sum(w.fee), 0) as fees_paid
      from public.withdrawals w
     where w.client_id = c.id
       and w.created_at >= v_week_start
       and w.created_at <  v_week_end
  ) f on true
  -- AUDIT FIX (medium): without this, every dormant merchant got a
  -- "Your week in review" card telling them they did nothing, and the
  -- table grew by one row per client per week forever.
  where exists (
    select 1 from public.parcels p2
     where p2.client_id = c.id
       and p2.updated_at >= v_week_start
       and p2.updated_at <  v_week_end
  )
  on conflict (client_id, week_start) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

CREATE FUNCTION public.can_process_orders() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select
    public.is_admin()
    or public.is_staff_admin()
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.status::text, 'active')) = 'active'
        and lower(coalesce(p.role::text, '')) in (
          'admin', 'owner', 'superadmin', 'ops', 'ops manager', 'branch manager',
          'warehouse', 'warehouse staff', 'processing', 'processing staff'
        )
    )
    or exists (
      select 1
      from public.staff_users su
      where (
        su.auth_user_id = auth.uid()
        or (su.email is not null and lower(su.email) = lower(coalesce(auth.jwt() ->> 'email', '')))
      )
      and lower(coalesce(su.status, 'Active')) = 'active'
      and (
        lower(coalesce(su.role, '')) in (
          'admin', 'owner', 'superadmin', 'ops', 'ops manager', 'branch manager',
          'warehouse', 'warehouse staff', 'processing', 'processing staff'
        )
        or lower(coalesce(su.staff_role, '')) in (
          'admin', 'owner', 'superadmin', 'ops', 'ops manager', 'branch manager',
          'warehouse', 'warehouse staff', 'processing', 'processing staff'
        )
        or su.permissions @> '"orders-processing"'::jsonb
        or su.permissions @> '["orders-processing"]'::jsonb
      )
    );
$$;

CREATE FUNCTION public.consignee_history(p_phone text) RETURNS TABLE(total_parcels integer, delivered_count integer, refused_count integer, last_status text, last_city text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_phone     text;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- Normalise to digits so 0300-1234567 / +923001234567 / 03001234567 all
  -- match the same customer.
  v_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_phone) < 7 then
    return;  -- too short to be a real number; stay silent
  end if;
  v_phone := right(v_phone, 10);

  select count(*)::int,
         count(*) filter (where p.status = 'Delivered')::int,
         count(*) filter (where p.status in ('Refused', 'Parcel returned to consignee'))::int
    into total_parcels, delivered_count, refused_count
    from public.parcels p
   where p.client_id = v_client_id
     and right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 10) = v_phone;

  if coalesce(total_parcels, 0) = 0 then
    return;
  end if;

  select p.status, p.city
    into last_status, last_city
    from public.parcels p
   where p.client_id = v_client_id
     and right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 10) = v_phone
   order by p.booked_at desc nulls last
   limit 1;

  return next;
end;
$$;

CREATE FUNCTION public.create_client_workspace(p_name text, p_owner text, p_phone text, p_city text, p_address text, p_business_type text, p_website text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_existing_client_id uuid;
  v_client_id uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a workspace.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  select client_id into v_existing_client_id from public.profiles where id = v_uid;
  if v_existing_client_id is not null then
    return v_existing_client_id;
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
    200,                                     -- was 250
    jsonb_build_object(                      -- was absent, so v_base fell to rate
      'A', jsonb_build_object('overnight', 200, 'additionalKg', 85),
      'B', jsonb_build_object('overnight', 200, 'additionalKg', 85)
    ),
    'flat',                                  -- never ask, never per-km
    0
  )
  returning id into v_client_id;

  insert into public.profiles (id, email, role, status, client_id)
  values (v_uid, v_email, 'client', 'active', v_client_id)
  on conflict (id) do update
    set email = coalesce(public.profiles.email, excluded.email),
        role = 'client',
        status = 'active',
        client_id = excluded.client_id;

  return v_client_id;
end;
$$;

CREATE FUNCTION public.delete_new_booked_parcel(p_awb text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row       public.parcels;
  v_client_id uuid;
  v_is_admin  boolean;
begin
  v_is_admin  := public.is_admin();
  v_client_id := public.my_client_id();

  select * into v_row from public.parcels where awb = btrim(p_awb) limit 1;
  if v_row.awb is null then
    raise exception 'That parcel no longer exists.';
  end if;

  if not v_is_admin then
    if v_client_id is null or v_row.client_id is distinct from v_client_id then
      raise exception 'You can only delete parcels booked on your own account.';
    end if;
  end if;

  if v_row.status <> 'New booked' then
    raise exception 'Only a parcel still in "New booked" can be deleted. This one is "%" -- raise a ticket instead.', v_row.status;
  end if;

  if v_row.invoice_id is not null then
    raise exception 'This parcel is already on an invoice and cannot be deleted.';
  end if;

  insert into public.parcel_admin_audit (awb, client_id, action, snapshot, actor_id, actor_role)
  values (v_row.awb, v_row.client_id, 'deleted', to_jsonb(v_row), auth.uid(),
          case when v_is_admin then 'admin' else 'client' end);

  delete from public.parcels where awb = v_row.awb;
  return true;
end;
$$;

CREATE FUNCTION public.generate_channel_awb(p_client_id uuid, p_prefix text DEFAULT 'WOO'::text) RETURNS text
    LANGUAGE plpgsql
    AS $$
declare
  v_awb text;
  v_exists boolean;
begin
  loop
    v_awb := p_prefix || upper(substr(replace(p_client_id::text,'-',''),1,4)) || to_char(now(),'YYMMDDHH24MISS') || lpad(floor(random()*100)::text,2,'0');
    select exists(select 1 from public.parcels where awb = v_awb) into v_exists;
    exit when not v_exists;
  end loop;
  return v_awb;
end;
$$;

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce((new.raw_user_meta_data->>'role')::novax_role, 'client')
  )
  on conflict (id) do nothing;
  return new;
end $$;

CREATE FUNCTION public.invite_internal_staff_user(p_name text, p_email text, p_role text) RETURNS TABLE(id uuid, name text, email text, role text, status text, last_active_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_role   text;
  v_email  text;
  v_name   text;
  v_new_id uuid;
begin
  if not public.is_staff_admin() then
    raise exception 'Only NovaX admin/ops accounts can invite internal staff.' using errcode = '42501';
  end if;

  v_name  := nullif(btrim(coalesce(p_name, '')), '');
  v_email := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_role  := initcap(btrim(coalesce(p_role, '')));

  if v_name is null then
    raise exception 'A name is required for the new team member.' using errcode = '22023';
  end if;
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'A valid email address is required.' using errcode = '22023';
  end if;
  if v_role not in ('Owner', 'Admin', 'Ops', 'Finance', 'Warehouse', 'Support') then
    raise exception 'Role must be Owner, Admin, Ops, Finance, Warehouse or Support.' using errcode = '22023';
  end if;

  -- Same cross-tenant protection as invite_staff_user(): one seat per email,
  -- whether that seat is internal or belongs to a merchant's own team.
  if exists (select 1 from public.staff_users su where lower(su.email) = v_email) then
    raise exception 'That email already has an account on NovaX.' using errcode = '23505';
  end if;

  insert into public.staff_users (
    name, email, role, access_side, client_id, permissions, status,
    invited_by, invited_at, created_at, updated_at
  ) values (
    v_name, v_email, v_role, 'staff', null, '[]'::jsonb, 'Pending',
    auth.uid(), now(), now(), now()
  )
  returning staff_users.id into v_new_id;

  return query
    select su.id, su.name, su.email, su.role, su.status, su.last_active_at
    from public.staff_users su
    where su.id = v_new_id;
end;
$_$;

CREATE FUNCTION public.invite_staff_user(p_name text, p_email text, p_role text) RETURNS TABLE(id uuid, name text, email text, role text, status text, last_active_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_client_id uuid;
  v_role      text;
  v_email     text;
  v_name      text;
  v_new_id    uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client workspace is linked to this account.' using errcode = '42501';
  end if;

  if not public.is_client_owner_seat() then
    raise exception 'Only the workspace Owner can invite team members.' using errcode = '42501';
  end if;

  v_name  := nullif(btrim(coalesce(p_name, '')), '');
  v_email := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_role  := initcap(btrim(coalesce(p_role, '')));

  if v_name is null then
    raise exception 'A name is required for the new team member.' using errcode = '22023';
  end if;
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'A valid email address is required.' using errcode = '22023';
  end if;
  if v_role not in ('Owner', 'Finance', 'Warehouse', 'Support') then
    raise exception 'Role must be Owner, Finance, Warehouse or Support.' using errcode = '22023';
  end if;

  -- Never let an invite land on an email that already has a seat anywhere,
  -- and never let one workspace attach a seat that belongs to another.
  if exists (select 1 from public.staff_users su where lower(su.email) = v_email) then
    raise exception 'That email already has an account on NovaX.' using errcode = '23505';
  end if;

  insert into public.staff_users (
    name, email, role, access_side, client_id, permissions, status,
    invited_by, invited_at, created_at, updated_at
  ) values (
    v_name, v_email, v_role, 'client', v_client_id, '[]'::jsonb, 'Pending',
    auth.uid(), now(), now(), now()
  )
  returning staff_users.id into v_new_id;

  return query
    select su.id, su.name, su.email, su.role, su.status, su.last_active_at
    from public.staff_users su
    where su.id = v_new_id;
end;
$_$;

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select exists(select 1 from profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

CREATE FUNCTION public.is_client_owner_seat() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select public.my_client_id() is not null
     and (
       -- No seat row yet => the account that owns the workspace is the owner.
       not exists (
         select 1 from public.staff_users su
         where su.client_id = public.my_client_id()
           and (su.auth_user_id = auth.uid()
                or lower(su.email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), '')))
       )
       or exists (
         select 1 from public.staff_users su
         where su.client_id = public.my_client_id()
           and (su.auth_user_id = auth.uid()
                or lower(su.email) = lower(coalesce((select u.email from auth.users u where u.id = auth.uid()), '')))
           and lower(coalesce(su.role, '')) = 'owner'
           and coalesce(su.status, 'Active') <> 'Revoked'
       )
     );
$$;

CREATE FUNCTION public.is_return_chargeable(p_status text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  select coalesce(p_status,'') in (
    'Refused',
    'Ready for return',
    'Return in transit',
    'Return received at origin',
    'Return to shipper',            -- current name, written since the v1 rename
    'Parcel returned to consignee', -- legacy name, kept so pre-rename rows still bill
    'Out of service area'
  );
$$;

CREATE FUNCTION public.is_staff_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role::text in ('admin','ops')
  );
$$;

CREATE FUNCTION public.log_portal_error(p_source text, p_rpc_name text DEFAULT NULL::text, p_page text DEFAULT NULL::text, p_message text DEFAULT ''::text, p_severity text DEFAULT 'warning'::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_email text;
  v_recent_count int;
  v_source text;
  v_rpc_name text;
  v_page text;
  v_message text;
  v_severity text;
begin
  v_email := coalesce(auth.jwt() ->> 'email', null);
  select client_id into v_client_id from public.profiles where id = auth.uid();

  -- Basic anonymous spam mitigation: if this is an unauthenticated caller,
  -- and the exact same source+rpc+message has already been logged in the
  -- last 60 seconds, skip the insert instead of flooding the table.
  if auth.uid() is null then
    select count(*) into v_recent_count
    from public.portal_error_logs
    where client_id is null
      and source = case when p_source in ('client','admin','rider') then p_source else 'client' end
      and coalesce(rpc_name,'') = coalesce(p_rpc_name,'')
      and message = coalesce(nullif(trim(p_message), ''), 'Unknown error')
      and created_at > now() - interval '60 seconds';
    if v_recent_count > 0 then
      return;
    end if;
  end if;

  -- Truncate all free-text fields defensively -- callers are untrusted input.
  v_source := case when p_source in ('client','admin','rider') then p_source else 'client' end;
  v_rpc_name := left(coalesce(p_rpc_name,''), 120);
  v_page := left(coalesce(p_page,''), 200);
  v_message := left(coalesce(nullif(trim(p_message), ''), 'Unknown error'), 500);
  v_severity := case when p_severity in ('info','warning','critical') then p_severity else 'warning' end;

  insert into public.portal_error_logs (source, rpc_name, page, client_id, user_email, message, severity)
  values (v_source, v_rpc_name, v_page, v_client_id, v_email, v_message, v_severity);
exception when others then
  -- Error logging must never itself throw and break the caller's page.
  null;
end;
$$;

CREATE FUNCTION public.mark_digest_read(p_digest_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    return false;
  end if;
  update public.client_digests
     set read_at = now()
   where id = p_digest_id
     and client_id = v_client_id
     and read_at is null;
  return found;
end;
$$;

CREATE FUNCTION public.my_client_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select client_id from profiles where id = auth.uid();
$$;

CREATE FUNCTION public.my_rider_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select rider_id from profiles where id = auth.uid();
$$;

CREATE FUNCTION public.novax_client_default_pickup() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_area uuid;
begin
  if lower(coalesce(new.city, '')) <> 'karachi' then return new; end if;
  if exists (select 1 from public.client_pickup_locations l where l.client_id = new.id) then return new; end if;

  begin
    v_area := public.novax_resolve_area('Karachi', new.address);
  exception when others then
    v_area := null;
  end;

  if v_area is null then return new; end if;

  begin
    insert into public.client_pickup_locations (client_id, label, address, city, area_id, is_default)
    values (new.id, 'Main pickup', coalesce(new.address, ''), 'Karachi', v_area, true);
  exception when others then
    -- Signup must never fail because of pricing setup.
    raise notice 'NovaX: could not create default pickup for client % (%)', new.id, sqlerrm;
  end;
  return new;
end
$$;

CREATE FUNCTION public.novax_cod_reset_get() RETURNS TABLE(reset_at timestamp with time zone, reset_by text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not (public.is_admin() or public.can_process_orders()) then
    raise exception 'Admin or order-processing access required.';
  end if;
  return query
    select rs.reset_at, rs.reset_by
      from public.novax_cod_day_resets rs
     order by rs.reset_at desc
     limit 1;
end
$$;

CREATE FUNCTION public.novax_cod_reset_set(p_note text DEFAULT ''::text) RETURNS TABLE(reset_at timestamp with time zone, reset_by text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_email text;
  v_name  text;
  v_row   public.novax_cod_day_resets;
begin
  if not (public.is_admin() or public.can_process_orders()) then
    raise exception 'Admin or order-processing access required.';
  end if;

  v_email := coalesce(auth.jwt() ->> 'email',
                      (select pr.email from public.profiles pr where pr.id = auth.uid()), '');
  v_name  := coalesce(
    (select su.name from public.staff_users su where lower(su.email) = lower(v_email) limit 1),
    nullif(v_email, ''), 'Staff');

  insert into public.novax_cod_day_resets (reset_by, note)
  values (v_name, coalesce(p_note, ''))
  returning * into v_row;

  return query select v_row.reset_at, v_row.reset_by;
end
$$;

CREATE FUNCTION public.novax_stamp_delivered_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- Only on the FIRST transition into Delivered, and never overwritten.
  -- A parcel that somehow leaves and re-enters Delivered keeps its original
  -- timestamp: the cash was collected the first time.
  if new.status = 'Delivered'
     and coalesce(old.status, '') is distinct from 'Delivered'
     and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  return new;
end
$$;

CREATE FUNCTION public.ops_daily_report(p_token text, p_days integer DEFAULT 60) RETURNS TABLE(day date, picked integer, delivered integer, returned integer, same_day integer, cod_collected numeric, revenue_earned numeric, parcels_in_hand integer, is_closed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_ok boolean;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  select exists(select 1 from public.nv_ops_report_config c
                where c.id = 1 and c.token = p_token) into v_ok;
  if not v_ok then raise exception 'Invalid report token.'; end if;

  return query
  with ev as (
    select l.parcel_id,
           l.to_status,
           (l.changed_at at time zone 'Asia/Karachi')::date as d
    from public.nv_parcel_status_log l
    where l.changed_at > now() - (p_days || ' days')::interval
  ),
  -- first time each parcel reached each milestone, so nothing counts twice
  firsts as (
    select parcel_id, to_status, min(d) as d
    from ev
    where to_status in ('Arrived at warehouse','Delivered','Return to shipper')
    group by 1,2
  ),
  days as (
    select generate_series(v_today - (p_days - 1), v_today, interval '1 day')::date as day
  ),
  picked as   (select d, count(*) n from firsts where to_status='Arrived at warehouse' group by 1),
  delivered as(select d, count(*) n from firsts where to_status='Delivered'            group by 1),
  returned as (select d, count(*) n from firsts where to_status='Return to shipper'    group by 1),
  sameday as (
    select p.d, count(*) n
    from firsts p
    join firsts dl on dl.parcel_id = p.parcel_id and dl.to_status='Delivered' and dl.d = p.d
    where p.to_status='Arrived at warehouse'
    group by 1
  ),
  money as (
    select f.d,
           sum(case when f.to_status='Delivered' then coalesce(pr.cod_amount,0) else 0 end) as cod,
           sum(coalesce(pr.fee,0))                                                          as fee
    from firsts f
    join public.parcels pr on pr.id = f.parcel_id
    where f.to_status in ('Delivered','Return to shipper')
    group by 1
  ),
  in_hand as (
    select count(*)::int n
    from public.parcels
    where status in ('Arrived at warehouse','Parcel now in transit',
                     'Parcel received at destination','Parcel out for delivery',
                     'Reattempt','Consignee not available','Refused',
                     'Ready for return','Return in transit','Return out for delivery')
  )
  select d.day,
         coalesce(p.n,0)::int,
         coalesce(dl.n,0)::int,
         coalesce(r.n,0)::int,
         coalesce(sd.n,0)::int,
         coalesce(m.cod,0),
         coalesce(m.fee,0),
         (select n from in_hand),
         (d.day < v_today)
  from days d
  left join picked p     on p.d  = d.day
  left join delivered dl on dl.d = d.day
  left join returned r   on r.d  = d.day
  left join sameday sd   on sd.d = d.day
  left join money m      on m.d  = d.day
  order by d.day desc;
end;
$$;

CREATE FUNCTION public.public_reviews() RETURNS TABLE(rating integer, comment text, display_name text, created_at timestamp with time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select r.rating, r.comment, coalesce(r.display_name, 'NovaX merchant'), r.created_at
  from public.reviews r
  where r.status = 'approved'
  order by r.created_at desc
  limit 60;
$$;

CREATE FUNCTION public.public_track_parcel(p_token text) RETURNS TABLE(awb text, status text, origin_city text, destination_city text, booked_at timestamp with time zone, updated_at timestamp with time zone, cod_amount numeric, consignee_first text, rider_first text, exception_note text, steps jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select
    p.awb,
    p.status,
    coalesce(p.meta->>'pickupCity', 'Karachi')                as origin_city,
    p.city                                                    as destination_city,
    p.booked_at,
    p.updated_at,
    coalesce(p.cod_amount, 0)                                 as cod_amount,
    -- First name only. A consignee tracking their own parcel already knows
    -- their name; this is for reassurance ("yes, this is my parcel"), not
    -- disclosure. Surname withheld so a leaked link reveals as little as
    -- possible.
    nullif(split_part(btrim(coalesce(p.consignee, '')), ' ', 1), '')  as consignee_first,
    -- Rider first name only, and only while actually out for delivery.
    case
      when p.status = 'Parcel out for delivery'
      then nullif(split_part(btrim(coalesce(
             (select rd.name from public.riders rd where rd.id = p.rider_id), '')), ' ', 1), '')
      else null
    end                                                       as rider_first,
    -- AUDIT FIX (critical): p.exception is an INTERNAL ops field. Real
    -- writers put rider FULL names, cash-handling policy and accusatory
    -- notes in it, e.g. rider.html writes
    --   'Consignee refused the parcel on the doorstep -- house photo
    --    attached by <rider full name>'
    -- and admin.html writes 'Cash above rider limit' / 'Manual audit
    -- required by operations head'. Returning it raw published all of that
    -- to anyone holding a tracking link, and completely bypassed the
    -- first-name-only rule enforced 6 lines above. Mapped to a
    -- consignee-safe sentence keyed off status instead. Never return the
    -- raw column here.
    case p.status
      when 'Consignee not available' then 'We could not reach you for delivery. We will try again.'
      when 'Refused'                 then 'The delivery was not completed.'
      when 'Out of service area'     then 'This address is outside our current delivery area.'
      when 'Reattempt'               then 'A re-delivery attempt is scheduled.'
      else null
    end                                                       as exception_note,
    -- AUDIT FIX (high): meta.steps accumulates INTERNAL finance/ops states
    -- alongside the public flow -- 'COD collected', 'Branch cash received',
    -- 'Client settled', 'Rider holding cash', 'GPS scan verified'.
    -- 'Client settled' in particular tells a stranger the merchant has
    -- already been paid. Whitelisted to the seven public statuses.
    coalesce((
      select jsonb_agg(e)
        from jsonb_array_elements_text(coalesce(p.meta->'steps', '[]'::jsonb)) e
       where e in ('New booked','Collected by rider','Arrived at warehouse',
                   'Parcel now in transit','Parcel received at destination',
                   'Parcel out for delivery','Delivered')
    ), '[]'::jsonb)                                           as steps
  from public.parcels p
  where p.tracking_token is not null
    -- AUDIT FIX (medium): reject anything too short to be a real 22-char
    -- token, so a short guessable value can never resolve even if one was
    -- somehow persisted before the triggers below were tightened.
    and length(btrim(coalesce(p_token, ''))) >= 20
    and p.tracking_token = btrim(coalesce(p_token, ''))
  limit 1;
$$;

CREATE FUNCTION public.queue_notification_event(p_client_id uuid, p_awb text, p_event_type text, p_recipient text DEFAULT NULL::text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_prefs public.client_notification_prefs;
begin
  if p_client_id is null or p_event_type is null then
    return;
  end if;

  -- Security: only staff/admin may queue a notification for an arbitrary
  -- client. A non-admin caller may only queue notifications for their own
  -- linked client -- otherwise any logged-in account could spam another
  -- client's WhatsApp/SMS/Email.
  if not public.is_staff_admin() and p_client_id is distinct from public.my_client_id() then
    return;
  end if;

  select * into v_prefs from public.client_notification_prefs where client_id = p_client_id;
  if v_prefs is null then
    return; -- client never set preferences yet; nothing to send
  end if;
  if not (v_prefs.events @> to_jsonb(p_event_type::text)) then
    return; -- client opted out of this event type
  end if;
  if v_prefs.whatsapp_enabled then
    insert into public.notification_events (client_id, awb, channel, event_type, recipient, payload)
    values (p_client_id, p_awb, 'whatsapp', p_event_type, p_recipient, p_payload);
  end if;
  if v_prefs.sms_enabled then
    insert into public.notification_events (client_id, awb, channel, event_type, recipient, payload)
    values (p_client_id, p_awb, 'sms', p_event_type, p_recipient, p_payload);
  end if;
  if v_prefs.email_enabled then
    insert into public.notification_events (client_id, awb, channel, event_type, recipient, payload)
    values (p_client_id, p_awb, 'email', p_event_type, p_recipient, p_payload);
  end if;
exception when others then
  -- Never let a notification-queue failure break the calling action.
  null;
end;
$$;

CREATE FUNCTION public.request_wallet_withdrawal(p_amount numeric, p_iban text, p_speed text) RETURNS public.withdrawals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_balance numeric;
  v_fee numeric;
  v_net numeric;
  v_rate numeric;
  v_iban text;
  v_holder_name text;
  v_bank_name text;
  v_row public.withdrawals;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Withdrawal amount must be greater than zero.';
  end if;

  -- NovaX fix (withdrawal UX v3): saved bank details are only a
  -- convenience/default now, never a hard lock -- p_iban is always what
  -- actually gets paid, whether it matches a saved account or is a brand
  -- new one the client typed/pasted for this withdrawal. It still gets the
  -- same normalization + validation as save_client_bank_details.
  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));
  if v_iban = '' then
    raise exception 'IBAN / bank account details are required.';
  end if;
  if left(v_iban, 2) <> 'PK' then
    raise exception 'IBAN must start with PK.';
  end if;
  if length(v_iban) < 15 then
    raise exception 'IBAN must be at least 15 characters.';
  end if;
  if p_speed not in ('24h','12h','instant') then
    raise exception 'Payout speed must be 24h, 12h, or instant.';
  end if;

  -- Prevent duplicate rapid submissions (double-click / retry storms):
  -- one still-pending request per client per 15-second window.
  if exists (
    select 1 from public.withdrawals
    where client_id = v_client_id and status = 'Pending admin payout'
      and created_at > now() - interval '15 seconds'
  ) then
    raise exception 'A withdrawal request was already submitted. Please wait a moment before trying again.';
  end if;

  -- holder_name/bank_name are read only to snapshot onto the withdrawal row
  -- for admin visibility if the client has saved them -- never required and
  -- never compared against p_iban.
  select coalesce(wallet_balance,0),
    btrim(coalesce(meta->'bank'->>'holderName','')),
    btrim(coalesce(meta->'bank'->>'bankName',''))
    into v_balance, v_holder_name, v_bank_name
    from public.clients where id = v_client_id for update;
  if v_balance is null then
    raise exception 'Client wallet not found.';
  end if;
  if p_amount > v_balance then
    raise exception 'Withdrawal amount (%) is higher than the available wallet balance (%).', p_amount, v_balance;
  end if;

  v_rate := case p_speed when 'instant' then 0.007 when '12h' then 0.003 else 0.001 end;
  v_fee := round(p_amount * v_rate, 2);
  v_net := p_amount - v_fee;

  update public.clients set wallet_balance = v_balance - p_amount where id = v_client_id;

  insert into public.withdrawals (client_id, amount, fee, net, iban, speed, status, balance_before, holder_name, bank_name)
  values (v_client_id, p_amount, v_fee, v_net, v_iban, p_speed, 'Pending admin payout', v_balance, nullif(v_holder_name,''), nullif(v_bank_name,''))
  returning * into v_row;

  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_client_id, 'withdrawal_requested', -p_amount, true, 'Pending admin payout', 'withdrawal', v_row.id, v_row.id::text,
    'Withdrawal requested: Rs ' || p_amount || ' reserved, ' || v_net || ' net after Rs ' || v_fee || ' fee (' || p_speed || ').');
  insert into public.wallet_ledger (client_id, entry_type, amount, affects_balance, status, reference_type, reference_id, reference_code, note)
  values (v_client_id, 'payout_fee', -v_fee, false, 'Informational', 'withdrawal', v_row.id, v_row.id::text,
    'NovaX payout fee for this withdrawal (informational only, already netted into the amount above).');

  return v_row;
end;
$$;

CREATE FUNCTION public.revoke_staff_user(p_staff_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_role      text;
  v_owners    int;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client workspace is linked to this account.' using errcode = '42501';
  end if;

  if not public.is_client_owner_seat() then
    raise exception 'Only the workspace Owner can revoke access.' using errcode = '42501';
  end if;

  select lower(coalesce(su.role, '')) into v_role
  from public.staff_users su
  where su.id = p_staff_id and su.client_id = v_client_id;

  if v_role is null then
    raise exception 'That team member was not found in your workspace.' using errcode = 'P0002';
  end if;

  if v_role = 'owner' then
    select count(*) into v_owners
    from public.staff_users su
    where su.client_id = v_client_id
      and lower(coalesce(su.role, '')) = 'owner'
      and coalesce(su.status, 'Active') <> 'Revoked';
    if v_owners <= 1 then
      raise exception 'You cannot revoke the last Owner of the workspace.' using errcode = '42501';
    end if;
  end if;

  update public.staff_users
     set status = 'Revoked',
         permissions = '[]'::jsonb,
         updated_at = now()
   where id = p_staff_id
     and client_id = v_client_id;

  return true;
end;
$$;

CREATE FUNCTION public.save_client_bank_details(p_holder_name text, p_iban text, p_bank_name text DEFAULT ''::text) RETURNS TABLE(holder_name text, iban text, bank_name text, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_client_id uuid;
  v_holder text;
  v_iban text;
  v_bank text;
  v_now timestamptz;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  v_holder := btrim(coalesce(p_holder_name, ''));
  if v_holder = '' then
    raise exception 'Account holder name is required.';
  end if;

  v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s+', '', 'g'));
  if v_iban = '' then
    raise exception 'IBAN is required.';
  end if;
  if left(v_iban, 2) <> 'PK' then
    raise exception 'IBAN must start with PK.';
  end if;
  if length(v_iban) < 15 then
    raise exception 'IBAN must be at least 15 characters.';
  end if;

  v_bank := btrim(coalesce(p_bank_name, ''));
  v_now := now();

  update public.clients
    set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{bank}', jsonb_build_object(
      'holderName', v_holder, 'iban', v_iban, 'bankName', v_bank, 'updatedAt', v_now
    ), true)
    where id = v_client_id;

  holder_name := v_holder; iban := v_iban; bank_name := v_bank; updated_at := v_now;
  return next;
end;
$$;

CREATE FUNCTION public.submit_client_review(p_rating integer, p_comment text) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
    return json_build_object('ok', true, 'already', true);
end;
$$;

CREATE FUNCTION public.track_parcel_public(p_awb text) RETURNS TABLE(awb text, status text, city text, updated_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.awb, p.status, p.city, p.updated_at
  from public.parcels p
  where p.awb = upper(trim(p_awb))
  limit 1;
$$;

CREATE FUNCTION public.visitor_ping(p_session_id text, p_portal text, p_activity text, p_path text, p_referrer text, p_user_agent text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_session_id text;
  v_portal text;
  v_activity text;
  v_path text;
  v_referrer text;
  v_user_agent text;
begin
  v_session_id := btrim(coalesce(p_session_id, ''));
  if v_session_id = '' then
    raise exception 'session_id is required.';
  end if;
  v_session_id := left(v_session_id, 100);

  v_portal := lower(btrim(coalesce(p_portal, '')));
  if v_portal not in ('index', 'client', 'admin', 'rider', 'tracking', 'reset', 'landing') then
    v_portal := 'index';
  end if;

  v_activity := left(coalesce(p_activity, ''), 200);
  v_path := left(coalesce(p_path, ''), 300);
  v_referrer := left(coalesce(p_referrer, ''), 300);
  v_user_agent := left(coalesce(p_user_agent, ''), 400);

  insert into public.visitor_sessions (session_id, portal, activity, path, referrer, user_agent, first_seen, last_seen)
  values (v_session_id, v_portal, v_activity, v_path, v_referrer, v_user_agent, now(), now())
  on conflict (session_id) do update
    set portal = excluded.portal,
        activity = excluded.activity,
        path = excluded.path,
        referrer = excluded.referrer,
        user_agent = excluded.user_agent,
        last_seen = now();
end;
$$;
