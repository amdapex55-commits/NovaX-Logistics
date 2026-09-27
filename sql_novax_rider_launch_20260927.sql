-- Rider launch hardening. No historical parcels or cash balances are backfilled.
begin;

create or replace function public.my_rider_id() returns uuid
language sql stable security definer set search_path = public as $$
  select rider_id from public.profiles
  where id = auth.uid() and lower(role::text) = 'rider'
    and lower(status::text) = 'active';
$$;

create or replace function public.nv_require_rider() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare r uuid;
begin
  r := public.my_rider_id();
  if r is null then raise exception 'Not signed in as an active rider.' using errcode = '42501'; end if;
  return r;
end $$;
revoke all on function public.nv_require_rider() from public, anon, authenticated;

create table if not exists public.rider_expense_requests (
  request_key text primary key, rider_id uuid not null references public.riders(id),
  result jsonb not null, created_at timestamptz not null default now()
);
alter table public.rider_expense_requests enable row level security;
revoke all on public.rider_expense_requests from public, anon, authenticated;

create or replace function public.nv_rider_expenses(p_rider uuid)
returns table(expense_id text, anchor_id uuid, entry jsonb, amount numeric, invalid boolean)
language sql stable security definer set search_path = public as $$
  select distinct on (e->>'id') e->>'id', p.id, e,
    case when e->>'amount' ~ '^[0-9]+([.][0-9]{1,2})?$' then (e->>'amount')::numeric else 0 end,
    coalesce(e->>'amount','') !~ '^[0-9]+([.][0-9]{1,2})?$'
    or case when e->>'amount' ~ '^[0-9]+([.][0-9]{1,2})?$' then (e->>'amount')::numeric <= 0 else true end
  from public.parcels p cross join lateral jsonb_array_elements(
    case when jsonb_typeof(p.meta->'riderExpenses')='array' then p.meta->'riderExpenses' else '[]'::jsonb end) e
  where coalesce(nullif(e->>'riderId',''),p.rider_id::text)=p_rider::text
    and coalesce(e->>'id','') <> ''
  order by e->>'id', (e->>'settled'='true') desc nulls last, p.id;
$$;
revoke all on function public.nv_rider_expenses(uuid) from public, anon, authenticated;

create or replace function public.rider_cash_summary() returns jsonb
language plpgsql security definer set search_path = public as $$
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
  return jsonb_build_object('gross',g,'expenses',x,'net',greatest(0,g-x),'count',n,
    'pending',pending,'review',bad or bad_payment or x>g,'expense_rows',expenses);
end $$;

create or replace function public.nv_rider_write_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if public.is_admin() or public.can_process_orders()
     or coalesce(current_setting('novax.rider_write',true),'')='1' then return new; end if;
  foreach k in array array['riderExpenses','cashDepositStatus','cashDepositedAt','cashDepositBatchId','cashDepositGross','cashDepositExpenses','cashDepositNet'] loop
    if new.meta->k is distinct from old.meta->k then
      raise exception 'Cash and route expenses must use the secure action service.' using errcode='42501';
    end if;
  end loop;
  if exists(select 1 from public.profiles where id=auth.uid() and lower(role::text)='rider') then
    if public.my_rider_id() is null then raise exception 'Rider account is inactive.' using errcode='42501'; end if;
    if new.status is distinct from old.status or new.meta is distinct from old.meta then
      raise exception 'Use the secure rider action service.' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists nv_rider_write_guard on public.parcels;
create trigger nv_rider_write_guard before update on public.parcels
for each row execute function public.nv_rider_write_guard();

create or replace function public.nv_rider_evidence_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists(select 1 from public.profiles where id=auth.uid() and lower(role::text)='rider')
    and coalesce(current_setting('novax.rider_write',true),'')<>'1'
    and not public.is_admin() and not public.can_process_orders() then
    raise exception 'Use the secure rider action service.' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists nv_rider_evidence_guard on public.scans;
create trigger nv_rider_evidence_guard before insert or update or delete on public.scans for each row execute function public.nv_rider_evidence_guard();
drop trigger if exists nv_rider_evidence_guard on public.cod_ledger;
create trigger nv_rider_evidence_guard before insert or update or delete on public.cod_ledger for each row execute function public.nv_rider_evidence_guard();

create or replace function public.rider_add_expense(p_key text,p_category text,p_amount numeric,p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r uuid := public.nv_require_rider(); p public.parcels; result jsonb; e jsonb; rider public.riders;
begin
  if p_key is null or length(p_key)<16 or length(p_key)>200 or p_key ~ '[[:cntrl:]]' then raise exception 'Expense reference is invalid.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select q.result into result from public.rider_expense_requests q where request_key=p_key and rider_id=r;
  if found then return result; end if;
  if p_amount is null or p_amount<=0 or p_amount>100000 or p_amount<>round(p_amount,2)
    or p_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid expense amount.'; end if;
  if p_category is null or p_category not in ('Fuel','Toll','Bike repair','Meal','Other') then raise exception 'Invalid expense category.'; end if;
  if length(coalesce(p_note,''))>160 then raise exception 'Expense note is too long.'; end if;
  select * into p from public.parcels where rider_id=r order by id limit 1 for update;
  if not found then raise exception 'No assigned parcel is available to link this route expense.'; end if;
  select * into rider from public.riders where id=r;
  e := jsonb_build_object('id',p_key,'riderId',r,'category',p_category,'amount',p_amount,
    'note',coalesce(nullif(btrim(p_note),''),p_category||' rider expense'),
    'name',p_category||' - '||coalesce(rider.name,'Rider'),'branch',rider.branch,
    'expenseDate',to_char(now() at time zone 'Asia/Karachi','YYYY-MM-DD'),
    'createdAt',now(),'status','Rider submitted','settled',false);
  perform set_config('novax.rider_write','1',true);
  update public.parcels set meta=coalesce(meta,'{}') || jsonb_build_object('riderExpenses',
    (case when jsonb_typeof(meta->'riderExpenses')='array' then meta->'riderExpenses' else '[]'::jsonb end)||jsonb_build_array(e)) where id=p.id;
  result := jsonb_build_object('id',p_key,'amount',p_amount);
  insert into public.rider_expense_requests values(p_key,r,result,now());
  return result;
end $$;

create or replace function public.rider_batch_update_status(p_awbs text[],p_to text,p_reason text default '',p_batch_key text default null,p_delivery_loc jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r uuid := public.nv_require_rider(); result jsonb; codes text[]; code text;
  p public.parcels; m jsonb; h jsonb; steps jsonb; allowed boolean; moved text[] := '{}'; changed integer := 0;
  lat numeric; lng numeric;
begin
  if p_batch_key is null or length(p_batch_key)<16 or length(p_batch_key)>200 or p_batch_key ~ '[[:cntrl:]]' then raise exception 'Batch reference is invalid.'; end if;
  if p_awbs is null or cardinality(p_awbs)<1 or cardinality(p_awbs)>200 then raise exception 'Enter between 1 and 200 AWBs.'; end if;
  select array_agg(distinct upper(btrim(a)) order by upper(btrim(a))) into codes from unnest(p_awbs) a;
  if exists(select 1 from unnest(codes) c where c is null or c='') then raise exception 'An AWB is empty.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select b.result into result from public.rider_batches b where batch_key=p_batch_key and rider_id=r;
  if found then return result; end if;
  if p_to in ('Refused','Consignee not available') and nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'A reason is required.'; end if;
  if length(coalesce(p_reason,''))>160 then raise exception 'Reason is too long.'; end if;
  if p_delivery_loc is not null and coalesce(p_delivery_loc->>'unavailable','false')<>'true' then
    if jsonb_typeof(p_delivery_loc->'lat')<>'number' or jsonb_typeof(p_delivery_loc->'lng')<>'number'
       or p_delivery_loc->'lat' is null or p_delivery_loc->'lng' is null then raise exception 'Invalid GPS coordinates.'; end if;
    lat := (p_delivery_loc->>'lat')::numeric; lng := (p_delivery_loc->>'lng')::numeric;
    if abs(lat)>90 or abs(lng)>180 then raise exception 'GPS coordinates are out of range.'; end if;
  end if;
  -- Deterministic row order and one rider lock shared with expenses/handovers.
  perform id from public.parcels where upper(awb)=any(codes) order by id for update;
  foreach code in array codes loop
    select * into p from public.parcels where upper(awb)=code;
    if not found or p.rider_id is distinct from r then raise exception '%: not assigned to you.',code; end if;
    allowed := case p.status
      when 'New booked' then p_to='Collected by rider'
      when 'Collected by rider' then p_to='Arrived at warehouse'
      when 'Parcel now in transit' then p_to='Parcel received at destination'
      when 'Parcel received at destination' then p_to='Parcel out for delivery'
      when 'Reattempt' then p_to='Parcel out for delivery'
      when 'Reassigned' then p_to='Parcel out for delivery'
      when 'Parcel out for delivery' then p_to in ('Delivered','Refused','Consignee not available')
      when 'Ready for return' then p_to='Return in transit'
      when 'Return in transit' then p_to='Return received at origin'
      when 'Return received at origin' then p_to='Return out for delivery'
      when 'Return out for delivery' then p_to in ('Return to shipper','Consignee not available')
      else false end;
    if p.status is distinct from p_to and not allowed then raise exception '%: cannot move from % to %.',code,p.status,p_to; end if;
    if p_to='Delivered' and coalesce(p.cod_amount,0)>0
       and btrim(coalesce(p.meta->>'paymentMode',p.meta->>'payment_mode','')) ~* '(non\s*-?\s*cod|prepaid|^paid$)' then raise exception '%: COD/prepaid conflict. Contact the office.',code; end if;
  end loop;
  perform set_config('novax.rider_write','1',true);
  foreach code in array codes loop
    select * into p from public.parcels where upper(awb)=code;
    moved := moved || p.awb;
    if p.status=p_to then continue; end if;
    m := coalesce(p.meta,'{}');
    h := (case when jsonb_typeof(m->'processHistory')='array' then m->'processHistory' else '[]'::jsonb end)
      || jsonb_build_array(jsonb_build_object('at',now(),'by','Rider','to',p_to,'status',p_to,'reason',coalesce(p_reason,'')));
    select coalesce(jsonb_agg(e order by i),'[]') into h from jsonb_array_elements(h) with ordinality t(e,i) where i>greatest(jsonb_array_length(h)-30,0);
    steps := case when jsonb_typeof(m->'steps')='array' then m->'steps' else '[]'::jsonb end;
    if not steps @> jsonb_build_array(p_to) then steps := steps || jsonb_build_array(p_to); end if;
    m := m || jsonb_build_object('processHistory',h,'steps',steps);
    if p_to='Parcel received at destination' and nullif(m->>'destinationArrivedAt','') is null then m := m || jsonb_build_object('destinationArrivedAt',now()); end if;
    if p_to='Delivered' then m := m || jsonb_build_object('deliveredBy',r,'cashReceived',coalesce(p.cod_amount,0)=0,
      'cashDepositStatus',case when coalesce(p.cod_amount,0)=0 then 'not_required' else 'not_deposited' end,'deliveryLocation',coalesce(p_delivery_loc,jsonb_build_object('unavailable',true,'at',now()))); end if;
    update public.parcels set status=p_to,exception=case when p_to in ('Refused','Consignee not available') then coalesce(p_reason,'') else '' end,meta=m,updated_at=now() where id=p.id;
    insert into public.scans(parcel_id,rider_id,type,status,lat,lng,note) values(p.id,r,'status',p_to,lat,lng,coalesce(p_reason,''));
    if p_to='Delivered' and coalesce(p.cod_amount,0)>0 then
      insert into public.cod_ledger(parcel_id,client_id,rider_id,direction,amount,reference)
      select p.id,p.client_id,r,'in',p.cod_amount,p.awb where not exists(select 1 from public.cod_ledger where parcel_id=p.id and direction='in');
    end if;
    changed := changed+1;
  end loop;
  result := jsonb_build_object('count',changed,'moved',to_jsonb(moved),'status',p_to);
  insert into public.rider_batches(batch_key,rider_id,result) values(p_batch_key,r,result);
  return result;
end $$;

create or replace function public.rider_deposit_cash_checked(p_batch_key text,p_expected_gross numeric,p_expected_expenses numeric,p_expected_net numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r uuid := public.nv_require_rider(); d public.rider_cash_deposits; c jsonb; ids uuid[]; xids text[]; result jsonb;
begin
  if p_batch_key is null or length(p_batch_key)<12 or length(p_batch_key)>200 or p_batch_key ~ '[[:cntrl:]]' then raise exception 'Deposit reference is invalid.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  select * into d from public.rider_cash_deposits where batch_key=p_batch_key and rider_id=r;
  if found then return jsonb_build_object('batch',d.batch_key,'gross',d.gross,'expenses',d.expenses,'net',d.net,'count',cardinality(d.parcel_ids),'replayed',true); end if;
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
  insert into public.rider_cash_deposits(batch_key,rider_id,gross,expenses,net,parcel_ids)
    values(p_batch_key,r,(c->>'gross')::numeric,(c->>'expenses')::numeric,(c->>'net')::numeric,ids);
  result := c || jsonb_build_object('batch',p_batch_key,'replayed',false);
  return result;
end $$;

-- Preserve the old API, but route it through the same atomic accounting rules.
create or replace function public.rider_deposit_cash(p_batch_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.nv_require_rider(); c jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('novax-rider:'||r::text,0));
  c := public.rider_cash_summary();
  return public.rider_deposit_cash_checked(p_batch_key,(c->>'gross')::numeric,(c->>'expenses')::numeric,(c->>'net')::numeric);
end $$;

revoke all on function public.rider_cash_summary() from public, anon;
revoke all on function public.rider_add_expense(text,text,numeric,text) from public, anon;
revoke all on function public.rider_deposit_cash_checked(text,numeric,numeric,numeric) from public, anon;
revoke all on function public.rider_batch_update_status(text[],text,text,text,jsonb) from public, anon;
revoke all on function public.rider_deposit_cash(text) from public, anon;
grant execute on function public.rider_cash_summary(), public.rider_add_expense(text,text,numeric,text),
  public.rider_deposit_cash_checked(text,numeric,numeric,numeric),
  public.rider_batch_update_status(text[],text,text,text,jsonb),public.rider_deposit_cash(text) to authenticated;
commit;
