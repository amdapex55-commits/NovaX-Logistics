-- NovaX: make the rider cash deposit atomic and retry-safe.
--
-- Before: the phone stamped each parcel's meta one at a time in chunks of 12,
-- and on failure tried to put the old meta back with a second round of
-- writes. That compensation is not a rollback -- it is itself a network call
-- that can fail, and when it did the rider was left with some parcels stuck
-- in pending_confirmation and no way to finish the handover.
--
-- Worse on retry: the eligible list excludes anything already
-- pending_confirmation, so a retry after a partial success deposited only the
-- remainder, under a DIFFERENT batch id. One physical handover of cash became
-- two batches in the books, neither matching what the rider actually handed
-- over.
--
-- Also moved server-side: gross, expenses and net. The browser used to
-- compute the money and write its own numbers into the parcel rows.

create table if not exists public.rider_cash_deposits (
  batch_key   text primary key,
  rider_id    uuid not null references public.riders(id) on delete cascade,
  gross       numeric not null,
  expenses    numeric not null,
  net         numeric not null,
  parcel_ids  uuid[] not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_rider_cash_deposits_rider
  on public.rider_cash_deposits (rider_id, created_at desc);

alter table public.rider_cash_deposits enable row level security;

drop policy if exists rider_cash_deposits_own on public.rider_cash_deposits;
create policy rider_cash_deposits_own on public.rider_cash_deposits
  for select using (rider_id = public.my_rider_id() or public.is_admin());

create or replace function public.rider_deposit_cash(p_batch_key text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rider    uuid;
  v_key      text := nullif(btrim(coalesce(p_batch_key, '')), '');
  v_gross    numeric := 0;
  v_expenses numeric := 0;
  v_net      numeric := 0;
  v_ids      uuid[] := '{}';
  v_now      timestamptz := now();
  v_existing public.rider_cash_deposits;
  v_result   jsonb;
begin
  v_rider := public.my_rider_id();
  if v_rider is null then
    raise exception 'Not signed in as a rider.' using errcode = '42501';
  end if;
  if v_key is null or length(v_key) < 12 or length(v_key) > 200 or v_key ~ '[[:cntrl:]]' then
    raise exception 'Deposit reference is invalid.';
  end if;

  -- A replay of the same handover returns the original figures. This is what
  -- stops one physical deposit becoming two batches in the books.
  select * into v_existing
    from public.rider_cash_deposits
   where batch_key = v_key and rider_id = v_rider;
  if found then
    return jsonb_build_object(
      'batch',    v_existing.batch_key,
      'gross',    v_existing.gross,
      'expenses', v_existing.expenses,
      'net',      v_existing.net,
      'count',    coalesce(array_length(v_existing.parcel_ids, 1), 0),
      'replayed', true);
  end if;

  -- Everything this rider still owes, locked for the duration.
  -- Locked in a subquery, then aggregated: FOR UPDATE cannot be combined with
  -- aggregate functions in one statement.
  select coalesce(array_agg(t.id), '{}')
    into v_ids
    from (
      select p.id
        from public.parcels p
       where p.rider_id = v_rider
         and p.status = 'Delivered'
         and coalesce((p.meta->>'cashReceived')::boolean, false) = false
         and coalesce(p.meta->>'cashDepositStatus', '') <> 'pending_confirmation'
       order by p.id
         for update
    ) t;

  select coalesce(sum(p.cod_amount), 0)
    into v_gross
    from public.parcels p
   where p.id = any(v_ids);

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'No undeposited deliveries are waiting.';
  end if;

  -- Route expenses live in meta.riderExpenses on whichever parcel the phone
  -- picked as an anchor, so they are summed across this rider's parcels
  -- rather than read from one row.
  select coalesce(sum((e->>'amount')::numeric), 0)
    into v_expenses
    from public.parcels p
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(p.meta->'riderExpenses') = 'array'
           then p.meta->'riderExpenses' else '[]'::jsonb end) e
   where p.rider_id = v_rider
     and coalesce((e->>'settled')::boolean, false) = false;

  v_net := greatest(0, v_gross - v_expenses);

  update public.parcels p
     set meta = coalesce(p.meta, '{}'::jsonb) || jsonb_build_object(
           'cashDepositStatus',   'pending_confirmation',
           'cashDepositedAt',     to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'cashDepositBatchId',  v_key,
           'cashDepositGross',    v_gross,
           'cashDepositExpenses', v_expenses,
           'cashDepositNet',      v_net)
   where p.id = any(v_ids)
     and p.rider_id = v_rider;

  insert into public.rider_cash_deposits (batch_key, rider_id, gross, expenses, net, parcel_ids)
  values (v_key, v_rider, v_gross, v_expenses, v_net, v_ids);

  v_result := jsonb_build_object(
    'batch',    v_key,
    'gross',    v_gross,
    'expenses', v_expenses,
    'net',      v_net,
    'count',    coalesce(array_length(v_ids, 1), 0),
    'replayed', false);

  return v_result;
end;
$function$;

revoke all on function public.rider_deposit_cash(text) from public, anon;
grant execute on function public.rider_deposit_cash(text) to authenticated, service_role;
