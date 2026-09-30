-- Wallet statement built by the server (30 Sep 2026).
-- The portal used to work statements out from its own copy of the ledger,
-- loaded when the page opened. This computes one from the database in a
-- single snapshot: month boundaries in Pakistan time, balances worked back
-- from the wallet balance, a running balance on every line.
-- Also: "paid this month" in client_wallet_summary now uses Pakistan months
-- (it used UTC, so a payout at 1 am on the 1st counted in the month before).
begin;

create or replace function public.client_wallet_statement(p_period text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_client uuid := public.my_client_id();
  v_from timestamptz;
  v_to timestamptz;
  v_out jsonb;
begin
  if v_client is null then
    raise exception 'No client account linked to this session.';
  end if;
  if p_period = 'all' then
    v_from := '-infinity'; v_to := 'infinity';
  elsif p_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    v_from := (p_period || '-01')::timestamp at time zone 'Asia/Karachi';
    v_to := ((p_period || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
  else
    raise exception 'Pick a month to see its statement.';
  end if;

  -- One statement, one snapshot: the balance and the ledger cannot drift apart.
  with c as (
    select coalesce(wallet_balance, 0) as now_balance from public.clients where id = v_client
  ), l as (
    select id, created_at, entry_type, amount, reference_type, reference_id, reference_code, note
    from public.wallet_ledger
    where client_id = v_client and affects_balance
  ), t as (
    select (select now_balance from c) as now_balance,
      coalesce((select sum(amount) from l where created_at >= v_to), 0) as after_period,
      coalesce((select sum(amount) from l where created_at >= v_from and created_at < v_to), 0) as in_period,
      coalesce((select sum(amount) from l where created_at >= v_from and created_at < v_to and amount > 0), 0) as money_in,
      coalesce((select -sum(amount) from l where created_at >= v_from and created_at < v_to and amount < 0), 0) as money_out
  ), lines as (
    select l.*, (t.now_balance - t.after_period - t.in_period)
      + sum(l.amount) over (order by l.created_at, l.id rows unbounded preceding) as balance
    from l, t
    where l.created_at >= v_from and l.created_at < v_to
  )
  select jsonb_build_object(
    'period', p_period,
    'opening', t.now_balance - t.after_period - t.in_period,
    'closing', t.now_balance - t.after_period,
    'money_in', t.money_in,
    'money_out', t.money_out,
    'balance_now', t.now_balance,
    'first_day', case when p_period = 'all'
      then (select to_char(min(created_at) at time zone 'Asia/Karachi', 'YYYY-MM-DD') from l)
      else p_period || '-01' end,
    'last_day', to_char(least(v_to - interval '1 microsecond', now()) at time zone 'Asia/Karachi', 'YYYY-MM-DD'),
    'generated_at', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id,
        'at', to_char(created_at at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
        'entry_type', entry_type, 'amount', amount,
        'reference_type', reference_type, 'reference_id', reference_id,
        'reference_code', reference_code, 'note', note,
        'balance', balance) order by created_at, id) from lines), '[]'::jsonb))
  into v_out
  from t;
  return v_out;
end;
$$;
revoke all on function public.client_wallet_statement(text) from public, anon, service_role;
grant execute on function public.client_wallet_statement(text) to authenticated;

create or replace function public.client_wallet_summary()
 returns table(available_balance numeric, pending_payout numeric, paid_this_month numeric, lifetime_withdrawn numeric)
 language plpgsql security definer set search_path to 'public' as $function$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  select coalesce(c.wallet_balance,0),
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Pending admin payout'), 0),
    -- Pakistan months, like every date the merchant sees.
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Paid'
      and date_trunc('month', coalesce(w.paid_at, w.created_at) at time zone 'Asia/Karachi')
        = date_trunc('month', now() at time zone 'Asia/Karachi')), 0),
    coalesce((select sum(w.net) from public.withdrawals w where w.client_id = v_client_id and w.status = 'Paid'), 0)
  into available_balance, pending_payout, paid_this_month, lifetime_withdrawn
  from public.clients c where c.id = v_client_id;

  return next;
end;
$function$;

commit;
