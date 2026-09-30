-- ═══ Rider app hardening (30 Sep 2026) ══════════════════════════════════════
-- Fixes audits/rider-20260930/RIDER_APP_AUDIT.md after checking every finding
-- against production code and data. RIDER-nnn tags mark each change.

-- ---- RIDER-005: a Blocked rider record stops every rider action -----------
create or replace function public.nv_require_rider()
returns uuid language plpgsql stable security definer set search_path to 'public' as $$
declare r uuid;
begin
  r := public.my_rider_id();
  if r is null then raise exception 'Not signed in as an active rider.' using errcode = '42501'; end if;
  if not exists (select 1 from public.riders x where x.id = r and x.access = 'Active') then
    raise exception 'This rider account is blocked. Contact the office.' using errcode = '42501';
  end if;
  return r;
end $$;

-- ---- RIDER-006 / RIDER-016: one public write path per job ------------------
-- The legacy status RPC had no Nova Swap guard and ignored city rules; the
-- legacy deposit functions accept a handover with no method. The rider app
-- uses rider_station_action / rider_swap_complete / rider_deposit_cash_v2;
-- those call the old functions internally as their owner, which is unaffected.
revoke execute on function public.rider_batch_update_status(text[],text,text,text,jsonb) from public, anon, authenticated;
do $$ begin
  if to_regprocedure('public.rider_deposit_cash_checked(text,numeric,numeric,numeric)') is not null then
    execute 'revoke execute on function public.rider_deposit_cash_checked(text,numeric,numeric,numeric) from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_proc where proname = 'rider_deposit_cash' and pronamespace = 'public'::regnamespace) then
    execute (select string_agg('revoke execute on function public.rider_deposit_cash(' || pg_get_function_identity_arguments(oid) || ') from public, anon, authenticated', '; ')
               from pg_proc where proname = 'rider_deposit_cash' and pronamespace = 'public'::regnamespace);
  end if;
end $$;

-- ---- RIDER-020: expenses in their own table, not inside a parcel -----------
create table if not exists public.nv_rider_expense (
  id            text primary key,
  rider_id      uuid not null references public.riders(id),
  category      text not null check (category in ('Fuel','Toll','Bike repair','Meal','Other')),
  amount        numeric(12,2) not null check (amount > 0 and amount <= 100000),
  note          text not null default '',
  expense_date  date not null default ((now() at time zone 'Asia/Karachi')::date),
  created_at    timestamptz not null default now(),
  status        text not null default 'Rider submitted',
  settled       boolean not null default false,
  settled_batch text,
  settled_at    timestamptz
);
create index if not exists nv_rider_expense_rider_idx on public.nv_rider_expense (rider_id, settled, created_at desc);
alter table public.nv_rider_expense enable row level security;
drop policy if exists nv_rider_expense_admin on public.nv_rider_expense;
create policy nv_rider_expense_admin on public.nv_rider_expense for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.nv_rider_expense from anon, public;
grant select, delete on public.nv_rider_expense to authenticated;

create or replace function public.nv_rider_expenses(p_rider uuid)
returns table(expense_id text, anchor_id uuid, entry jsonb, amount numeric, invalid boolean)
language sql stable security definer set search_path to 'public' as $$
  select distinct on (x.expense_id) x.expense_id, x.anchor_id, x.entry, x.amount, x.invalid from (
    select e.id as expense_id, null::uuid as anchor_id,
           jsonb_build_object('id', e.id, 'riderId', e.rider_id, 'category', e.category, 'amount', e.amount,
             'note', e.note, 'name', e.category || ' - ' || coalesce(rd.name, 'Rider'), 'branch', rd.branch,
             'expenseDate', to_char(e.expense_date, 'YYYY-MM-DD'), 'createdAt', e.created_at, 'status', e.status,
             'settled', e.settled, 'settledBatch', e.settled_batch, 'settledAt', e.settled_at) as entry,
           e.amount, false as invalid, 0 as src
      from public.nv_rider_expense e left join public.riders rd on rd.id = e.rider_id
     where e.rider_id = p_rider
    union all
    -- legacy entries written into parcel meta before this table existed (none on 30 Sep)
    select e->>'id', p.id, e,
      case when e->>'amount' ~ '^[0-9]+([.][0-9]{1,2})?$' then (e->>'amount')::numeric else 0 end,
      coalesce(e->>'amount','') !~ '^[0-9]+([.][0-9]{1,2})?$'
      or case when e->>'amount' ~ '^[0-9]+([.][0-9]{1,2})?$' then (e->>'amount')::numeric <= 0 else true end, 1
    from public.parcels p cross join lateral jsonb_array_elements(
      case when jsonb_typeof(p.meta->'riderExpenses')='array' then p.meta->'riderExpenses' else '[]'::jsonb end) e
    where coalesce(nullif(e->>'riderId',''),p.rider_id::text)=p_rider::text and coalesce(e->>'id','') <> ''
  ) x
  order by x.expense_id, x.src, (x.entry->>'settled'='true') desc nulls last;
$$;

create or replace function public.rider_add_expense(p_key text, p_category text, p_amount numeric, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r uuid := public.nv_require_rider(); result jsonb;
begin
  if p_key is null or length(p_key)<16 or length(p_key)>200 or p_key ~ '[[:cntrl:]]' then raise exception 'Expense reference is invalid.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select q.result into result from public.rider_expense_requests q where request_key=p_key and rider_id=r;
  if found then return result; end if;
  if p_amount is null or p_amount<=0 or p_amount>100000 or p_amount<>round(p_amount,2)
    or p_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid expense amount.'; end if;
  if p_category is null or p_category not in ('Fuel','Toll','Bike repair','Meal','Other') then raise exception 'Invalid expense category.'; end if;
  if length(coalesce(p_note,''))>160 then raise exception 'Expense note is too long.'; end if;
  insert into public.nv_rider_expense (id, rider_id, category, amount, note)
  values (p_key, r, p_category, p_amount, coalesce(nullif(btrim(p_note),''), p_category || ' rider expense'));
  result := jsonb_build_object('id',p_key,'amount',p_amount);
  insert into public.rider_expense_requests values(p_key,r,result,now());
  return result;
end $$;

-- ---- RIDER-007 / RIDER-016: handover details are fixed once recorded -------
create or replace function public.rider_deposit_cash_v2(p_batch_key text, p_expected_gross numeric, p_expected_expenses numeric,
  p_expected_net numeric, p_method text, p_reference text default '')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r uuid := public.nv_require_rider(); res jsonb; d public.rider_cash_deposits; v_ref text := left(btrim(coalesce(p_reference,'')),80);
begin
  if p_method is null or p_method not in ('Bank transfer','Easypaisa','JazzCash','Cash to office') then raise exception 'Choose how the cash was sent.'; end if;
  if p_method <> 'Cash to office' and length(v_ref) < 4 then
    raise exception 'Enter the transaction ID from the bank or wallet receipt.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select * into d from public.rider_cash_deposits where batch_key = p_batch_key and rider_id = r;
  if found then
    -- A replay returns what was recorded. It never rewrites the receipt.
    if d.method is not null and (d.method is distinct from p_method or coalesce(d.reference,'') is distinct from v_ref) then
      raise exception 'This handover was already recorded as % %. It cannot be changed from the phone.', d.method, coalesce(nullif(d.reference,''),'');
    end if;
    return jsonb_build_object('batch', d.batch_key, 'gross', d.gross, 'expenses', d.expenses, 'net', d.net,
      'count', cardinality(d.parcel_ids), 'replayed', true, 'method', coalesce(d.method, p_method), 'reference', coalesce(d.reference, v_ref));
  end if;
  res := public.rider_deposit_cash_checked(p_batch_key, p_expected_gross, p_expected_expenses, p_expected_net);
  update public.rider_cash_deposits set method = p_method, reference = v_ref
   where batch_key = p_batch_key and rider_id = r and method is null;
  return res || jsonb_build_object('method', p_method, 'reference', v_ref);
end $$;

-- ---- RIDER-017: removing a stuck saved action leaves an audit trail -------
create table if not exists public.nv_rider_queue_discards (
  id bigserial primary key, rider_id uuid not null, job_key text not null, kind text not null,
  detail jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
alter table public.nv_rider_queue_discards enable row level security;
drop policy if exists nv_rider_queue_discards_admin on public.nv_rider_queue_discards;
create policy nv_rider_queue_discards_admin on public.nv_rider_queue_discards for select to authenticated using (public.is_admin());
revoke all on public.nv_rider_queue_discards from anon, public;
grant select on public.nv_rider_queue_discards to authenticated;
create or replace function public.rider_queue_discard(p_key text, p_kind text, p_detail jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r uuid := public.nv_require_rider();
begin
  if coalesce(btrim(p_key),'') = '' or length(p_key) > 200 then raise exception 'Reference is invalid.'; end if;
  insert into public.nv_rider_queue_discards (rider_id, job_key, kind, detail)
  values (r, p_key, left(coalesce(p_kind,''),20), coalesce(p_detail,'{}'::jsonb));
  return jsonb_build_object('ok', true);
end $$;

-- ---- RIDER-002/003: carriers may send a failed return back to its origin station
CREATE OR REPLACE FUNCTION public.enforce_parcel_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_allowed text[];
  v_carrier boolean;
begin
  -- Admins AND any authorized order-processing staff keep full flexibility
  -- to correct/override status -- this is exactly what admin_processing_
  -- update_status relies on to move a parcel through every stage.
  if public.is_admin() or public.can_process_orders() then
    return new;
  end if;
  -- No status change on this update -- nothing to validate.
  if new.status is not distinct from old.status then
    return new;
  end if;
  /* Who is asking decides which moves exist. The sequence below is the
     physical journey: only the rider carrying the parcel, or the database
     itself (cron, service role -- no auth.uid()), walks it. A merchant session
     used to be able to walk it too, one legal step at a time, to Delivered. A
     merchant decides only what is theirs: cancel before pickup, and reattempt
     or return after a failed delivery. */
  v_carrier := auth.uid() is null
               or (old.rider_id is not null and old.rider_id = public.my_rider_id());
  if not v_carrier then
    v_allowed := case old.status
      when 'New booked' then array['Cancelled by client']
      when 'Refused' then array['Reattempt','Ready for return']
      when 'Consignee not available' then array['Reattempt','Ready for return']
      when 'Out of service area' then array['Reattempt','Ready for return']
      else array[]::text[]
    end;
    if not (new.status = any(v_allowed)) then
      raise exception 'Illegal parcel status transition: % -> % is not permitted for this role.', old.status, new.status;
    end if;
    return new;
  end if;

  v_allowed := case old.status
    when 'New booked' then array['Collected by rider','Cancelled by client','Parcel received at destination']
    when 'Collected by rider' then array['Arrived at warehouse','Parcel now in transit','Parcel received at destination','Parcel out for delivery']
    when 'Arrived at warehouse' then array['Parcel now in transit','Parcel received at destination','Parcel out for delivery']
    when 'Parcel now in transit' then array['Parcel received at destination']
    when 'Parcel received at destination' then array['Parcel out for delivery']
    when 'Parcel out for delivery' then array['Delivered','Refused','Consignee not available','Reattempt']
    when 'Refused' then array['Reattempt','Ready for return','Parcel out for delivery']
    when 'Consignee not available' then array['Reattempt','Ready for return','Parcel out for delivery']
    when 'Reattempt' then array['Parcel out for delivery','Ready for return']
    when 'Reassigned' then array['Parcel out for delivery']
    when 'Out of service area' then array['Reattempt','Ready for return']
    when 'Ready for return' then array['Return in transit','Return out for delivery']
    when 'Return in transit' then array['Return received at origin']
    when 'Return received at origin' then array['Return out for delivery']
    when 'Return out for delivery' then array['Return to shipper','Consignee not available','Return received at origin']
    else array[]::text[]
  end;
  if not (new.status = any(v_allowed)) then
    raise exception 'Illegal parcel status transition: % -> % is not permitted for this role.', old.status, new.status;
  end if;
  return new;
end;
$function$;

-- ---- RIDER-020: the handover also settles table expenses
CREATE OR REPLACE FUNCTION public.rider_deposit_cash_checked(p_batch_key text, p_expected_gross numeric, p_expected_expenses numeric, p_expected_net numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r uuid := public.nv_require_rider(); d public.rider_cash_deposits; c jsonb; ids uuid[]; xids text[]; result jsonb;
begin
  if p_batch_key is null or length(p_batch_key)<12 or length(p_batch_key)>200 or p_batch_key ~ '[[:cntrl:]]' then raise exception 'Deposit reference is invalid.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select * into d from public.rider_cash_deposits where batch_key=p_batch_key and rider_id=r;
  if found then return jsonb_build_object('batch',d.batch_key,'gross',d.gross,'expenses',d.expenses,'net',d.net,'count',cardinality(d.parcel_ids),'replayed',true); end if;
  perform 1 from public.nv_rider_expense e where e.rider_id=r and not e.settled order by e.id for update;
  perform p.id from public.parcels p where p.rider_id=r
    or p.id in(select anchor_id from public.nv_rider_expenses(r)) order by p.id for update;
  c := public.rider_cash_summary();
  if (c->>'count')::integer=0 then raise exception 'No undeposited COD is waiting.'; end if;
  if (c->>'review')::boolean then raise exception 'Expenses exceed COD or contain invalid amounts. Office reconciliation is required.'; end if;
  if p_expected_gross is distinct from (c->>'gross')::numeric
    or p_expected_expenses is distinct from (c->>'expenses')::numeric
    or p_expected_net is distinct from (c->>'net')::numeric then
    raise exception 'Cash position changed. Refresh and confirm the new amount; no handover was recorded.';
  end if;
  select array_agg(id order by id) into ids from public.parcels where rider_id=r and status='Delivered' and cod_amount>0
    and coalesce(meta->>'cashReceived','false')<>'true' and coalesce(meta->>'cashDepositStatus','')<>'pending_confirmation';
  select array_agg(expense_id) into xids from public.nv_rider_expenses(r) where coalesce(entry->>'settled','false')<>'true';
  perform set_config('novax.rider_write','1',true);
  update public.parcels set meta=coalesce(meta,'{}') || jsonb_build_object('cashDepositStatus','pending_confirmation',
    'cashDepositedAt',now(),'cashDepositBatchId',p_batch_key,'cashDepositGross',(c->>'gross')::numeric,
    'cashDepositExpenses',(c->>'expenses')::numeric,'cashDepositNet',(c->>'net')::numeric) where id=any(ids);
  -- Stamp every copy of a deduplicated expense in this transaction, exactly once.
  update public.parcels p set meta=jsonb_set(p.meta,'{riderExpenses}',(select jsonb_agg(
    case when e->>'id'=any(xids) and coalesce(nullif(e->>'riderId',''),p.rider_id::text)=r::text
      then e||jsonb_build_object('settled',true,'settledBatch',p_batch_key,'settledAt',now()) else e end order by i)
    from jsonb_array_elements(p.meta->'riderExpenses') with ordinality t(e,i)))
  where jsonb_typeof(p.meta->'riderExpenses')='array' and exists(select 1 from jsonb_array_elements(p.meta->'riderExpenses') e
    where e->>'id'=any(xids) and coalesce(nullif(e->>'riderId',''),p.rider_id::text)=r::text);
  update public.nv_rider_expense set settled=true, settled_batch=p_batch_key, settled_at=now(), status='Settled'
   where rider_id=r and id=any(xids) and not settled;
  insert into public.rider_cash_deposits(batch_key,rider_id,gross,expenses,net,parcel_ids)
    values(p_batch_key,r,(c->>'gross')::numeric,(c->>'expenses')::numeric,(c->>'net')::numeric,ids);
  result := c || jsonb_build_object('batch',p_batch_key,'replayed',false);
  return result;
end $function$;

-- ---- RIDER-001: the rows behind every cash total
CREATE OR REPLACE FUNCTION public.rider_cash_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r uuid := public.nv_require_rider(); g numeric; x numeric; n integer; pending numeric; bad boolean; bad_payment boolean; expenses jsonb;
begin
  select coalesce(sum(cod_amount),0), count(*) into g,n from public.parcels
  where rider_id=r and status='Delivered' and coalesce(cod_amount,0)>0
    and coalesce(meta->>'cashReceived','false')<>'true'
    and coalesce(meta->>'cashDepositStatus','')<>'pending_confirmation';
  select exists(select 1 from public.parcels where rider_id=r and status='Delivered'
    and coalesce(meta->>'cashReceived','false')<>'true' and coalesce(meta->>'cashDepositStatus','')<>'pending_confirmation'
    and cod_amount>0 and btrim(coalesce(meta->>'paymentMode',meta->>'payment_mode','')) ~* '(non\s*-?\s*cod|prepaid|^paid$)') into bad_payment;
  select coalesce(sum(amount) filter(where coalesce(entry->>'settled','false')<>'true'),0),
    coalesce(bool_or(invalid and coalesce(entry->>'settled','false')<>'true'),false)
  into x,bad from public.nv_rider_expenses(r);
  select coalesce(jsonb_agg(entry order by entry->>'createdAt' desc),'[]') into expenses
  from (select entry from public.nv_rider_expenses(r)
    order by entry->>'createdAt' desc limit 100) e;
  select coalesce(sum(d.net),0) into pending from public.rider_cash_deposits d
  where d.rider_id=r and exists(select 1 from public.parcels p
    where p.id=any(d.parcel_ids) and p.meta->>'cashDepositStatus'='pending_confirmation'
      and coalesce(p.meta->>'cashReceived','false')<>'true');
  /* RIDER-001: the app listed only parcels delivered in the last 36 hours
     under totals that cover every unsettled delivery, so Naveed's Rs 21,172
     showed Rs 17,572 of cards. The rows behind each total come from the same
     predicates as the totals. */
  return jsonb_build_object('hand_rows', coalesce((select jsonb_agg(jsonb_build_object('awb',p.awb,'consignee',p.consignee,'city',p.city,
        'cod',p.cod_amount,'delivered_at',p.delivered_at) order by p.delivered_at)
      from public.parcels p where p.rider_id=r and p.status='Delivered' and coalesce(p.cod_amount,0)>0
        and coalesce(p.meta->>'cashReceived','false')<>'true' and coalesce(p.meta->>'cashDepositStatus','')<>'pending_confirmation'),'[]'::jsonb),
    'pending_rows', coalesce((select jsonb_agg(jsonb_build_object('batch',d.batch_key,'net',d.net,'gross',d.gross,'expenses',d.expenses,
        'method',d.method,'reference',d.reference,'at',d.created_at,'parcels',cardinality(d.parcel_ids),
        'awbs',(select coalesce(jsonb_agg(p.awb order by p.awb),'[]'::jsonb) from public.parcels p where p.id=any(d.parcel_ids))) order by d.created_at)
      from public.rider_cash_deposits d where d.rider_id=r and exists(select 1 from public.parcels p
        where p.id=any(d.parcel_ids) and p.meta->>'cashDepositStatus'='pending_confirmation' and coalesce(p.meta->>'cashReceived','false')<>'true')),'[]'::jsonb),
    'confirmed_rows', coalesce((select jsonb_agg(z.j order by z.at desc) from (select jsonb_build_object('awb',p.awb,'consignee',p.consignee,
        'city',p.city,'cod',p.cod_amount,'delivered_at',p.delivered_at) j, p.delivered_at at
      from public.parcels p where p.rider_id=r and p.status='Delivered' and coalesce(p.cod_amount,0)>0
        and coalesce(p.meta->>'cashReceived','false')='true' and p.delivered_at > now() - interval '14 days'
      order by p.delivered_at desc limit 100) z),'[]'::jsonb)) ||
    jsonb_build_object('gross',g,'expenses',x,'net',greatest(0,g-x),'count',n,
    'pending',pending,'review',bad or bad_payment or x>g,'expense_rows',expenses);
end $function$;

-- ---- RIDER-024: GPS stays optional (Aisha: no proof for now); head office sees deliveries without it
CREATE OR REPLACE FUNCTION public.admin_station_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'cities', (select jsonb_agg(jsonb_build_object('city', initcap(cty),
        'to_pickup', (select count(*) from public.parcels p where p.status = 'New booked' and public.nv_parcel_origin(p) = cty and coalesce(p.meta->>'swapLeg','') <> 'back'),
        'incoming', (select count(*) from public.parcels p where p.status = 'Parcel now in transit' and public.nv_parcel_dest(p) = cty),
        'at_station', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status in ('Parcel received at destination','Refused','Consignee not available','Reattempt','Reassigned')),
        'out_now', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status = 'Parcel out for delivery'),
        'to_send', (select count(*) from public.parcels p where public.nv_parcel_origin(p) = cty and public.nv_parcel_dest(p) <> cty and p.status in ('Collected by rider','Arrived at warehouse')),
        'no_gps_7d', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status = 'Delivered'
            and p.delivered_at > now() - interval '7 days' and jsonb_typeof(p.meta->'deliveryLocation'->'lat') is distinct from 'number'),
        'delivered_today', (select count(*) from public.parcels p where public.nv_parcel_dest(p) = cty and p.status = 'Delivered' and (p.delivered_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date),
        'riders', (select coalesce(jsonb_agg(jsonb_build_object('name', rd.name, 'access', rd.access)), '[]'::jsonb) from public.riders rd where lower(cty) = any(select lower(x) from unnest(rd.cities) x))
      ) order by cty) from unnest(array['karachi','lahore','islamabad','rawalpindi']) cty),
    'batches', (select coalesce(jsonb_agg(jsonb_build_object('code', b.code, 'kind', b.kind, 'from', b.from_city, 'to', b.to_city,
        'reference', b.reference, 'sent', cardinality(b.awbs), 'received', cardinality(b.received_awbs), 'status', b.status, 'sent_at', b.sent_at,
        'missing', to_jsonb(array(select a from unnest(b.awbs) a where a <> all(b.received_awbs)))) order by b.sent_at desc), '[]'::jsonb)
      from public.nv_transit_batches b where b.sent_at > now() - interval '14 days'),
    'deposits', (select coalesce(jsonb_agg(jsonb_build_object('rider', rd.name, 'net', d.net, 'method', d.method, 'reference', d.reference, 'at', d.created_at)
        order by d.created_at desc), '[]'::jsonb)
      from public.rider_cash_deposits d join public.riders rd on rd.id = d.rider_id where d.created_at > now() - interval '14 days')
  );
end $function$;

-- ---- the station read -------------------------------------------------------
-- RIDER-008 pickup address from the open pickup request
-- RIDER-013 "coming in" means actually in transit
-- RIDER-029 a parcel assigned to this rider outside his cities still shows
create or replace function public.rider_station_view()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare r uuid := public.nv_require_rider(); c text[] := public.nv_rider_cities(); rr public.riders; out jsonb;
begin
  select * into rr from public.riders where id = r;
  with base as (
    select p.*, public.nv_parcel_origin(p) o, public.nv_parcel_dest(p) d from public.parcels p
     where public.nv_parcel_origin(p) = any(c) or public.nv_parcel_dest(p) = any(c)
        or (p.rider_id = r and p.status in ('Parcel out for delivery','Return out for delivery'))
  ), tagged as (
    select b.*, case
      when b.status = 'New booked' and b.o = any(c) and coalesce(b.meta->>'swapLeg','') <> 'back' then 'pickup'
      when b.status = 'Parcel now in transit' and b.d = any(c) and not (b.o = any(c)) then 'incoming'
      when b.status = 'Return in transit' and b.o = any(c) and not (b.d = any(c)) then 'incoming'
      when b.status in ('Collected by rider','Arrived at warehouse') and b.o = any(c) and not (b.d = any(c)) then 'transit'
      when b.status in ('Collected by rider','Arrived at warehouse') and b.o = any(c) and b.d = any(c) then 'station'
      when b.status = 'Ready for return' and b.d = any(c) and not (b.o = any(c)) then 'transit'
      when b.status = 'Ready for return' and b.d = any(c) and b.o = any(c) then 'station'
      when b.status in ('Parcel received at destination','Refused','Consignee not available','Reattempt','Reassigned') and b.d = any(c) then 'station'
      when b.status = 'Return received at origin' and b.o = any(c) then 'station'
      when b.status = 'Parcel out for delivery' and b.d = any(c) and public.nv_rider_can_take(b.rider_id, b.d, r) then 'out'
      when b.status = 'Return out for delivery' and b.o = any(c) and public.nv_rider_can_take(b.rider_id, b.o, r) then 'out'
      when b.status in ('Parcel out for delivery','Return out for delivery') and b.rider_id = r then 'out'
      when b.status = 'Delivered' and b.rider_id = r and b.updated_at > now() - interval '36 hours' then 'done'
      else null end as bucket
      from base b
  )
  select jsonb_build_object(
    'rider', jsonb_build_object('id', rr.id, 'name', rr.name, 'branch', rr.branch, 'cities', to_jsonb(rr.cities), 'cash_limit', rr.cash_limit),
    'parcels', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'awb', t.awb, 'client_id', t.client_id, 'consignee', t.consignee, 'phone', t.phone, 'address', t.address,
        'city', t.city, 'origin', initcap(t.o), 'cod_amount', t.cod_amount, 'status', t.status, 'bucket', t.bucket,
        'status_since', t.status_since, 'updated_at', t.updated_at, 'delivered_at', t.delivered_at, 'rider_id', t.rider_id,
        'held_by', case when t.rider_id is not null and t.rider_id <> r then (select x.name from public.riders x where x.id = t.rider_id) end,
        'outside', not (t.o = any(c) or t.d = any(c)),
        'meta', t.meta, 'exception', t.exception,
        'attempts', (select count(*) from public.nv_parcel_status_log l where l.parcel_id = t.id and l.to_status = 'Parcel out for delivery'),
        'shipper', (select jsonb_build_object('name', cl.name, 'phone', cl.phone,
                       'address', coalesce(nullif(btrim(pr.pickup_address),''), cl.address),
                       'from_request', pr.id is not null, 'requested_for', pr.requested_for, 'note', pr.note)
                      from public.clients cl
                      left join lateral (select q.id, q.pickup_address, q.requested_for, q.note from public.pickup_requests q
                                          where t.bucket = 'pickup' and q.client_id = t.client_id and q.awbs ? t.awb
                                            and coalesce(q.status,'') not in ('Picked Up','Cancelled','Completed')
                                          order by q.created_at desc limit 1) pr on true
                     where cl.id = t.client_id)
      ) order by t.bucket, t.status_since) from tagged t where t.bucket is not null), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(jsonb_build_object('code', b.code, 'kind', b.kind, 'from_city', b.from_city, 'to_city', b.to_city,
        'reference', b.reference, 'awbs', to_jsonb(b.awbs), 'received', to_jsonb(b.received_awbs), 'status', b.status, 'sent_at', b.sent_at)
        order by b.sent_at desc)
      from public.nv_transit_batches b
      where (lower(b.to_city) = any(c) and b.status <> 'Received') or (b.rider_id = r and b.sent_at > now() - interval '3 days')), '[]'::jsonb),
    'server_time', now()
  ) into out;
  return out;
end $$;

-- ---- the station write ------------------------------------------------------
-- RIDER-002/003 a failed return stays a return at its origin station
-- RIDER-004 3-attempt cap and the customer's chosen date apply when going out
-- RIDER-011/012 batch number never truncates; batch origin is the parcels' city
-- RIDER-013 receive only what is actually in transit
-- RIDER-015 prepaid in either spelling blocks cash collection
-- RIDER-022 next attempt must be a real date, today to 14 days out
-- RIDER-023 GPS is either "unavailable" or real coordinates
create or replace function public.rider_station_action(p_awbs text[], p_action text, p_reason text default '',
  p_key text default null, p_loc jsonb default null, p_extra jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  r uuid := public.nv_require_rider(); c text[] := public.nv_rider_cities();
  codes text[]; code text; p public.parcels; o text; d text; target text; targets text[] := '{}';
  res jsonb; m jsonb; h jsonb; steps jsonb; lat numeric; lng numeric; moved text[] := '{}';
  v_to text; v_ref text; v_kind text; v_batch text; v_attempts int; i int := 0; v_next text; v_next_d date;
  v_from text; v_froms text[] := '{}'; v_n int; v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_pat text := '(non\s*-?\s*cod|prepaid|^paid$)';
begin
  if cardinality(c) = 0 then raise exception 'No city is set on your rider account. Ask the office to set it.'; end if;
  if p_key is null or length(p_key) < 16 or length(p_key) > 200 or p_key ~ '[[:cntrl:]]' then raise exception 'Reference is invalid.'; end if;
  if p_action is null or p_action not in ('collect','receive','out','delivered','reattempt','refused','not_available','transit') then raise exception 'Unknown action.'; end if;
  if p_awbs is null or cardinality(p_awbs) < 1 or cardinality(p_awbs) > 200 then raise exception 'Choose between 1 and 200 parcels.'; end if;
  select array_agg(distinct upper(btrim(a)) order by upper(btrim(a))) into codes from unnest(p_awbs) a where btrim(coalesce(a,'')) <> '';
  if codes is null then raise exception 'No AWB given.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select x.result into res from public.rider_batches x where x.batch_key = p_key and x.rider_id = r;
  if found then return res; end if;
  if p_action in ('refused','not_available','reattempt') and nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'Choose a reason.'; end if;
  if length(coalesce(p_reason,'')) > 160 then raise exception 'Reason is too long.'; end if;
  if p_loc is not null then
    if coalesce(p_loc->>'unavailable','false') = 'true' then
      null;
    elsif jsonb_typeof(p_loc->'lat') = 'number' and jsonb_typeof(p_loc->'lng') = 'number' then
      lat := (p_loc->>'lat')::numeric; lng := (p_loc->>'lng')::numeric;
      if abs(lat) > 90 or abs(lng) > 180 then raise exception 'GPS coordinates are out of range.'; end if;
      if p_loc ? 'accuracy' and (jsonb_typeof(p_loc->'accuracy') <> 'number' or (p_loc->>'accuracy')::numeric < 0 or (p_loc->>'accuracy')::numeric > 100000) then
        raise exception 'GPS accuracy is invalid.';
      end if;
    else
      raise exception 'Invalid GPS data.';
    end if;
  end if;
  if p_action = 'reattempt' then
    v_next := btrim(coalesce(p_extra->>'next_date',''));
    if v_next !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Choose the next delivery date.'; end if;
    begin v_next_d := v_next::date; exception when others then raise exception 'Choose the next delivery date.'; end;
    if v_next_d < v_today or v_next_d > v_today + 14 then raise exception 'The next delivery date must be between today and 14 days from now.'; end if;
  end if;
  if p_action = 'transit' then
    v_to := lower(btrim(coalesce(p_extra->>'to_city','')));
    v_ref := btrim(coalesce(p_extra->>'reference',''));
    if v_to = '' then raise exception 'Choose the city this batch is going to.'; end if;
    if length(v_ref) < 2 then raise exception 'Enter the bus or courier reference (bilty number).'; end if;
    if length(v_ref) > 80 then raise exception 'Reference is too long.'; end if;
  end if;

  perform id from public.parcels where upper(awb) = any(codes) order by id for update;

  -- validate everything first: all or nothing
  foreach code in array codes loop
    select * into p from public.parcels where upper(awb) = code;
    if not found then raise exception '%: no such AWB.', code; end if;
    o := public.nv_parcel_origin(p); d := public.nv_parcel_dest(p);
    target := case p_action
      when 'collect' then case when p.status = 'New booked' and o = any(c) and coalesce(p.meta->>'swapLeg','') <> 'back'
                               then case when d = any(c) then 'Parcel received at destination' else 'Collected by rider' end end
      when 'receive' then case
                               when p.status = 'Parcel now in transit' and d = any(c) and not (o = any(c)) then 'Parcel received at destination'
                               when p.status = 'Return in transit' and o = any(c) then 'Return received at origin' end
      when 'out' then case
                               when p.status in ('Parcel received at destination','Reattempt','Reassigned','Refused','Consignee not available') and d = any(c) then 'Parcel out for delivery'
                               when p.status in ('Collected by rider','Arrived at warehouse') and o = any(c) and d = any(c) then 'Parcel out for delivery'
                               when p.status = 'Return received at origin' and o = any(c) then 'Return out for delivery'
                               when p.status = 'Ready for return' and o = any(c) and d = any(c) then 'Return out for delivery' end
      when 'delivered' then case when p.status = 'Parcel out for delivery' and (p.rider_id = r or (d = any(c) and public.nv_rider_can_take(p.rider_id, d, r))) then 'Delivered'
                                 when p.status = 'Return out for delivery' and (p.rider_id = r or (o = any(c) and public.nv_rider_can_take(p.rider_id, o, r))) then 'Return to shipper' end
      when 'reattempt' then case when p.status = 'Parcel out for delivery' and (p.rider_id = r or (d = any(c) and public.nv_rider_can_take(p.rider_id, d, r))) then 'Reattempt' end
      when 'refused' then case when p.status = 'Parcel out for delivery' and (p.rider_id = r or (d = any(c) and public.nv_rider_can_take(p.rider_id, d, r))) then 'Refused' end
      when 'not_available' then case when p.status = 'Parcel out for delivery' and (p.rider_id = r or (d = any(c) and public.nv_rider_can_take(p.rider_id, d, r))) then 'Consignee not available'
                                     -- a return nobody took back goes back to the origin station, still a return
                                     when p.status = 'Return out for delivery' and (p.rider_id = r or (o = any(c) and public.nv_rider_can_take(p.rider_id, o, r))) then 'Return received at origin' end
      when 'transit' then case
                               when p.status in ('Collected by rider','Arrived at warehouse') and o = any(c) and d = v_to and not (d = any(c)) then 'Parcel now in transit'
                               when p.status = 'Ready for return' and d = any(c) and o = v_to and not (o = any(c)) then 'Return in transit' end
    end;
    if target is null then
      raise exception '%: cannot do "%" -- it is "%" (from % to %).', p.awb, p_action, p.status, initcap(o), initcap(d);
    end if;
    if p_action in ('reattempt','out') and target in ('Reattempt','Parcel out for delivery') then
      select count(*) into v_attempts from public.nv_parcel_status_log l where l.parcel_id = p.id and l.to_status = 'Parcel out for delivery';
      if p_action = 'reattempt' and v_attempts >= 3 then
        raise exception '%: 3 delivery attempts already. Mark it Refused so it goes back to the shipper.', p.awb;
      end if;
      if p_action = 'out' and v_attempts >= 3 then
        raise exception '%: already taken out 3 times. It goes back to the shipper -- ask the office to start the return.', p.awb;
      end if;
      if p_action = 'out' and p.status = 'Reattempt' and coalesce(p.meta->>'nextAttempt','') ~ '^\d{4}-\d{2}-\d{2}$'
         and (p.meta->>'nextAttempt')::date > v_today then
        raise exception '%: the customer asked for %. Take it out on that day.', p.awb, to_char((p.meta->>'nextAttempt')::date, 'DD Mon');
      end if;
    end if;
    if target = 'Delivered' and coalesce(p.cod_amount,0) > 0
       and (btrim(coalesce(p.meta->>'paymentMode','')) ~* v_pat or btrim(coalesce(p.meta->>'payment_mode','')) ~* v_pat) then
      raise exception '%: COD/prepaid conflict. Contact the office.', p.awb;
    end if;
    if p_action = 'delivered' and coalesce(p.meta->>'swapLeg','') = 'out' then
      raise exception '%: this is a Nova Swap. Use Exchange done.', p.awb;
    end if;
    if p_action = 'transit' then
      v_from := case when target = 'Return in transit' then d else o end;
      if not (v_from = any(v_froms)) then v_froms := v_froms || v_from; end if;
    end if;
    targets := targets || target;
  end loop;

  if p_action = 'transit' then
    v_kind := case when targets[1] = 'Return in transit' then 'return' else 'forward' end;
    if exists (select 1 from unnest(targets) t where (t = 'Return in transit') <> (v_kind = 'return')) then
      raise exception 'Send returns and new parcels as separate batches.';
    end if;
    if cardinality(v_froms) <> 1 then
      raise exception 'These parcels are at different stations (%). Send one batch per city.', array_to_string(array(select initcap(x) from unnest(v_froms) x), ', ');
    end if;
    v_from := v_froms[1];
    select count(*) + 1 into v_n from public.nv_transit_batches b where (b.sent_at at time zone 'Asia/Karachi')::date = v_today;
    loop
      v_batch := upper(left(regexp_replace(v_from,'[^a-z]','','g'),3)) || '-' || upper(left(regexp_replace(v_to,'[^a-z]','','g'),3)) || '-' ||
                 to_char(now() at time zone 'Asia/Karachi','MMDD') || '-' || lpad(v_n::text, greatest(2, length(v_n::text)), '0');
      exit when not exists (select 1 from public.nv_transit_batches b where b.code = v_batch);
      v_n := v_n + 1;
    end loop;
    insert into public.nv_transit_batches (code, kind, from_city, to_city, rider_id, reference, awbs)
    values (v_batch, v_kind, initcap(v_from), initcap(v_to), r, v_ref, codes);
  end if;

  perform set_config('novax.rider_write','1',true);
  foreach code in array codes loop
    i := i + 1;
    select * into p from public.parcels where upper(awb) = code;
    target := targets[i];
    if p.rider_id is distinct from r then
      perform set_config('novax.swap_assign','1',true);
      update public.parcels set rider_id = r where id = p.id;
      perform set_config('novax.swap_assign','',true);
    end if;
    m := coalesce(p.meta,'{}');
    h := (case when jsonb_typeof(m->'processHistory') = 'array' then m->'processHistory' else '[]'::jsonb end)
      || jsonb_build_array(jsonb_build_object('at', to_char(now() at time zone 'Asia/Karachi','YYYY-MM-DD HH24:MI:SS'), 'by', 'Rider', 'rider', r,
                                              'to', target, 'status', target, 'reason', coalesce(p_reason,''),
                                              'branch', initcap(case when target in ('Collected by rider','Parcel now in transit','Return received at origin','Return out for delivery','Return to shipper') then public.nv_parcel_origin(p) else public.nv_parcel_dest(p) end) || ' Hub'));
    select coalesce(jsonb_agg(e order by k),'[]') into h from jsonb_array_elements(h) with ordinality t(e,k) where k > greatest(jsonb_array_length(h)-30,0);
    steps := case when jsonb_typeof(m->'steps') = 'array' then m->'steps' else '[]'::jsonb end;
    if not steps @> jsonb_build_array(target) then steps := steps || jsonb_build_array(target); end if;
    m := m || jsonb_build_object('processHistory', h, 'steps', steps);
    if target = 'Parcel received at destination' and nullif(m->>'destinationArrivedAt','') is null then m := m || jsonb_build_object('destinationArrivedAt', now()); end if;
    if p_action = 'transit' then m := m || jsonb_build_object('transitBatch', v_batch, 'transitRef', v_ref); end if;
    if p_action = 'reattempt' then m := m || jsonb_build_object('nextAttempt', v_next, 'lastAttemptReason', p_reason); end if;
    if target = 'Delivered' then
      m := m || jsonb_build_object('deliveredBy', r, 'cashReceived', coalesce(p.cod_amount,0) = 0,
        'cashDepositStatus', case when coalesce(p.cod_amount,0) = 0 then 'not_required' else 'not_deposited' end,
        'deliveryLocation', coalesce(p_loc, jsonb_build_object('unavailable', true, 'at', now())));
    end if;
    update public.parcels
       set status = target,
           exception = case when target in ('Refused','Consignee not available','Reattempt') or (p_action = 'not_available') then coalesce(p_reason,'') else '' end,
           meta = m, updated_at = now()
     where id = p.id;
    insert into public.scans(parcel_id, rider_id, type, status, lat, lng, note)
    values (p.id, r, 'status', target, case when target = 'Delivered' then lat end, case when target = 'Delivered' then lng end, coalesce(p_reason,''));
    if target = 'Delivered' and coalesce(p.cod_amount,0) > 0 then
      insert into public.cod_ledger(parcel_id, client_id, rider_id, direction, amount, reference)
      select p.id, p.client_id, r, 'in', p.cod_amount, p.awb
       where not exists (select 1 from public.cod_ledger where parcel_id = p.id and direction = 'in');
    end if;
    if p_action = 'receive' and nullif(p.meta->>'transitBatch','') is not null then
      update public.nv_transit_batches b
         set received_awbs = (select array_agg(distinct x) from unnest(b.received_awbs || array[upper(p.awb)]) x),
             received_at = now()
       where b.code = p.meta->>'transitBatch';
      update public.nv_transit_batches b
         set status = case when (select count(*) from unnest(b.awbs) a where a <> all(b.received_awbs)) = 0 then 'Received' else 'Partly received' end
       where b.code = p.meta->>'transitBatch';
    end if;
    moved := moved || p.awb;
  end loop;

  res := jsonb_build_object('action', p_action, 'count', cardinality(moved), 'moved', to_jsonb(moved), 'batch', v_batch);
  insert into public.rider_batches(batch_key, rider_id, result) values (p_key, r, res);
  return res;
end $$;

-- ---- RIDER-014: head-office dispatches get a batch too ------------------------
-- Karachi moves parcels to "in transit" from admin, with no batch, so the
-- receiving rider had no expected count and no missing list. Any parcel that
-- enters transit without a batch joins the day's head-office batch for its
-- route. A rider's own transit already carries its batch and is left alone.
create or replace function public.nv_auto_transit_batch()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_from text; v_to text; v_code text; v_kind text;
begin
  if new.status not in ('Parcel now in transit','Return in transit') or old.status is not distinct from new.status then return new; end if;
  if coalesce(new.meta->>'transitBatch','') <> '' then return new; end if;
  v_kind := case when new.status = 'Return in transit' then 'return' else 'forward' end;
  v_from := case when v_kind = 'return' then lower(btrim(coalesce(new.city,''))) else lower(coalesce(nullif(btrim(new.meta->>'pickupCity'),''),'karachi')) end;
  v_to   := case when v_kind = 'return' then lower(coalesce(nullif(btrim(new.meta->>'pickupCity'),''),'karachi')) else lower(btrim(coalesce(new.city,''))) end;
  if v_from = '' or v_to = '' or v_from = v_to then return new; end if;
  v_code := upper(left(regexp_replace(v_from,'[^a-z]','','g'),3)) || '-' || upper(left(regexp_replace(v_to,'[^a-z]','','g'),3)) || '-' ||
            to_char(now() at time zone 'Asia/Karachi','MMDD') || '-HO' || case when v_kind = 'return' then 'R' else '' end;
  insert into public.nv_transit_batches (code, kind, from_city, to_city, rider_id, reference, awbs)
  values (v_code, v_kind, initcap(v_from), initcap(v_to), null, 'Head office dispatch', array[upper(new.awb)])
  on conflict (code) do update
     set awbs = (select array_agg(distinct x) from unnest(public.nv_transit_batches.awbs || array[upper(new.awb)]) x),
         status = case when public.nv_transit_batches.status = 'Received' then 'Partly received' else public.nv_transit_batches.status end;
  new.meta := coalesce(new.meta,'{}'::jsonb) || jsonb_build_object('transitBatch', v_code, 'transitRef', 'Head office dispatch');
  return new;
end $$;
drop trigger if exists nv_auto_transit_batch_trg on public.parcels;
create trigger nv_auto_transit_batch_trg before update of status on public.parcels
  for each row execute function public.nv_auto_transit_batch();
revoke all on function public.nv_auto_transit_batch() from public, anon, authenticated;

-- backfill: parcels already in transit without a batch, one batch per route and day sent
do $$
declare g record; v_code text;
begin
  for g in
    select case when p.status = 'Return in transit' then 'return' else 'forward' end as kind,
           case when p.status = 'Return in transit' then lower(btrim(p.city)) else public.nv_parcel_origin(p) end as f,
           case when p.status = 'Return in transit' then public.nv_parcel_origin(p) else lower(btrim(p.city)) end as t,
           (coalesce(p.status_since, p.updated_at) at time zone 'Asia/Karachi')::date as day,
           array_agg(upper(p.awb) order by p.awb) as awbs, min(coalesce(p.status_since, p.updated_at)) as sent
      from public.parcels p
     where p.status in ('Parcel now in transit','Return in transit') and coalesce(p.meta->>'transitBatch','') = ''
     group by 1,2,3,4
  loop
    continue when g.f = '' or g.t = '' or g.f = g.t;
    v_code := upper(left(regexp_replace(g.f,'[^a-z]','','g'),3)) || '-' || upper(left(regexp_replace(g.t,'[^a-z]','','g'),3)) || '-' ||
              to_char(g.day,'MMDD') || '-HO' || case when g.kind = 'return' then 'R' else '' end;
    insert into public.nv_transit_batches (code, kind, from_city, to_city, rider_id, reference, awbs, sent_at)
    values (v_code, g.kind, initcap(g.f), initcap(g.t), null, 'Head office dispatch', g.awbs, g.sent)
    on conflict (code) do update set awbs = (select array_agg(distinct x) from unnest(public.nv_transit_batches.awbs || excluded.awbs) x);
    update public.parcels p set meta = coalesce(p.meta,'{}'::jsonb) || jsonb_build_object('transitBatch', v_code, 'transitRef', 'Head office dispatch')
     where upper(p.awb) = any(g.awbs);
  end loop;
end $$;

grant execute on function public.rider_station_view() to authenticated;
grant execute on function public.rider_station_action(text[],text,text,text,jsonb,jsonb) to authenticated;
grant execute on function public.rider_add_expense(text,text,numeric,text) to authenticated;
grant execute on function public.rider_deposit_cash_v2(text,numeric,numeric,numeric,text,text) to authenticated;
grant execute on function public.rider_queue_discard(text,text,jsonb) to authenticated;
revoke all on function public.rider_queue_discard(text,text,jsonb) from public, anon;
revoke all on function public.nv_rider_expenses(uuid) from public, anon, authenticated;
