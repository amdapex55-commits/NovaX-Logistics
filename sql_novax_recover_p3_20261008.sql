-- Nova Recover, phase 3 (8 Oct 2026). Run after the phase 1 and phase 2 files.
-- Launch controls and what happens once the desk stops calling for free:
--   * the Settings screen's functions (the three switches, chosen merchants);
--   * the merchant is told when a parcel is refused (portal notice and one
--     email a day) and when an order is recovered (one email each);
--   * a period summary for the merchant's Reports.
--
-- Outside Nova Recover's own tables this file:
--   1. widens nv_email_queue's kind check by two kinds (recover_refused,
--      recover_won), from its live definition;
--   2. adds one trigger on parcels (status becomes Refused) and one on
--      nv_recover_cases (status becomes recovered). Both only queue an
--      email and swallow every error, so a parcel update can never fail
--      because of them.
-- Emails are a fourth switch (nv_recover_config.emails), OFF to start. Turn
-- it on only after novax-email-drain is deployed with the two new templates:
-- the sender that is live today does not know these kinds.
-- Safe to run twice.

alter table public.nv_recover_config add column if not exists emails boolean not null default false;

-- ── the desk asks this on every load ───────────────────────────────────
-- Now always says whether free calls are still on, even to a login that
-- does not have Resell, because the old queue changes with that switch.
create or replace function public.cs_recover_peek() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.nv_recover_config := public.nv_recover_cfg(); v_admin boolean := public.is_admin();
begin
  if auth.uid() is null then return jsonb_build_object('show', false, 'free_calls', true); end if;
  if not v_admin and (c.desk <> 'agents' or not exists (
       select 1 from public.cs_agents a where a.auth_user_id = auth.uid() and a.status = 'Active')) then
    return jsonb_build_object('show', false, 'free_calls', c.free_calls, 'merchant_tab', c.merchant_tab);
  end if;
  return jsonb_build_object('show', true, 'mode', case when v_admin then 'admin' else 'agent' end,
    'locked_for_agents', c.desk <> 'agents', 'free_calls', c.free_calls, 'merchant_tab', c.merchant_tab,
    'waiting', (select count(*) from public.nv_recover_cases k where k.status in ('waiting', 'calling')
                   or (k.status = 'callback' and coalesce(k.callback_at, now()) <= now())));
end $$;

-- ── Settings (admin) ───────────────────────────────────────────────────
-- Every merchant with something to recover, or already chosen, or already
-- using it: for the "chosen merchants" list.
create or replace function public.cs_recover_merchants() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.nv_recover_config;
begin
  perform public.cs_require_admin();
  c := public.nv_recover_cfg();
  return (select coalesce(jsonb_agg(x order by (x->>'chosen')::boolean desc, (x->>'to_recover')::int desc, x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object('id', cl.id, 'name', cl.name, 'city', cl.city,
             'chosen', cl.id = any(c.chosen_clients),
             'accepted', exists (select 1 from public.nv_recover_accept a where a.client_id = cl.id and a.version = c.terms_version),
             'to_recover', t.n, 'with_novax', k.open_n, 'recovered', k.won_n) as x
      from public.clients cl
      left join lateral (select count(*)::int as n from public.parcels p where p.client_id = cl.id and p.status in ('Refused', 'Return to shipper')) t on true
      left join lateral (select count(*) filter (where q.status in ('waiting', 'calling', 'callback'))::int as open_n,
                                count(*) filter (where q.status = 'recovered')::int as won_n
                           from public.nv_recover_cases q where q.client_id = cl.id) k on true
     where t.n > 0 or cl.id = any(c.chosen_clients) or k.open_n > 0 or k.won_n > 0) s);
end $$;

-- The switches, with plain refusals instead of constraint errors. A new fee
-- gets a new wording version that carries the price itself, so every merchant
-- sees the pop-up with the new price and agrees again before sending more
-- parcels, however quickly the fee is changed twice.
create or replace function public.cs_recover_config_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_chosen uuid[]; c public.nv_recover_config; v_fee numeric; v_n numeric;
begin
  perform public.cs_require_admin();
  c := public.nv_recover_cfg();
  if p ? 'merchant_tab' and (p->>'merchant_tab') not in ('off', 'chosen', 'all') then raise exception 'Merchant tab must be off, chosen or all.' using errcode = '22023'; end if;
  if p ? 'desk' and (p->>'desk') not in ('admin', 'agents') then raise exception 'Resell must be for admins only, or for agents too.' using errcode = '22023'; end if;
  if p ? 'fee' then
    v_fee := (p->>'fee')::numeric;
    if v_fee is null or v_fee < 0 or v_fee > 5000 or v_fee <> round(v_fee) then raise exception 'The fee must be a whole number of rupees, up to Rs 5,000.' using errcode = '22023'; end if;
  end if;
  if p ? 'max_tries' then v_n := (p->>'max_tries')::numeric;
    if v_n is null or v_n < 1 or v_n > 10 or v_n <> round(v_n) then raise exception 'Tries must be between 1 and 10.' using errcode = '22023'; end if; end if;
  if p ? 'max_push' then v_n := (p->>'max_push')::numeric;
    if v_n is null or v_n < 1 or v_n > 200 or v_n <> round(v_n) then raise exception 'Parcels per send must be between 1 and 200.' using errcode = '22023'; end if; end if;
  if p ? 'retry_days' then v_n := (p->>'retry_days')::numeric;
    if v_n is null or v_n < 0 or v_n > 90 or v_n <> round(v_n) then raise exception 'Days before sending again must be between 0 and 90.' using errcode = '22023'; end if; end if;
  if p ? 'wallet_floor' then v_n := (p->>'wallet_floor')::numeric;
    if v_n is null or v_n > 0 or v_n < -100000 then raise exception 'The wallet limit must be zero or below, down to Rs -100,000.' using errcode = '22023'; end if; end if;
  if p ? 'chosen_clients' then
    select coalesce(array_agg(distinct (e)::uuid), '{}') into v_chosen from jsonb_array_elements_text(p->'chosen_clients') e;
  end if;
  update public.nv_recover_config k set
    merchant_tab   = coalesce(p->>'merchant_tab', k.merchant_tab),
    chosen_clients = case when p ? 'chosen_clients' then v_chosen else k.chosen_clients end,
    desk           = coalesce(p->>'desk', k.desk),
    free_calls     = coalesce((p->>'free_calls')::boolean, k.free_calls),
    emails         = coalesce((p->>'emails')::boolean, k.emails),
    fee            = coalesce(v_fee, k.fee),
    wallet_floor   = coalesce((p->>'wallet_floor')::numeric, k.wallet_floor),
    max_push       = coalesce((p->>'max_push')::int, k.max_push),
    max_tries      = coalesce((p->>'max_tries')::int, k.max_tries),
    retry_days     = coalesce((p->>'retry_days')::int, k.retry_days),
    terms_version  = case when v_fee is not null and v_fee <> k.fee
                          -- The price is part of the version, so two changes in the same moment still differ.
                          then 'fee' || v_fee::text || '@' || to_char(clock_timestamp() at time zone 'Asia/Karachi', 'YYYY-MM-DD"T"HH24:MI:SS.US')
                          else coalesce(nullif(p->>'terms_version', ''), k.terms_version) end,
    updated_at = now(), updated_by = auth.uid()
  where k.id;
  return public.cs_recover_config_get();
end $$;

-- ── merchant ───────────────────────────────────────────────────────────
-- Adds "refused": refused parcels still waiting for the merchant's decision
-- (not sent to Recover, no reattempt or return asked for), for the notice on
-- Home, and whether NovaX still calls refusals for free.
create or replace function public.client_recover_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id(); c public.nv_recover_config; v_bal numeric; v_acc public.nv_recover_accept;
begin
  if v_client is null or not public.nv_recover_visible(v_client) then
    return jsonb_build_object('visible', false);
  end if;
  c := public.nv_recover_cfg();
  select coalesce(cl.wallet_balance, 0) into v_bal from public.clients cl where cl.id = v_client;
  select * into v_acc from public.nv_recover_accept a where a.client_id = v_client;
  return jsonb_build_object(
    'visible', true,
    'accepted', v_acc.client_id is not null and v_acc.version = c.terms_version,
    'terms_version', c.terms_version,
    'fee', c.fee, 'wallet_floor', c.wallet_floor, 'max_push', c.max_push,
    'wallet_balance', v_bal,
    'wallet_low', v_bal < c.wallet_floor,
    'may_push', public.nv_recover_seat_ok(v_client),
    'free_calls', c.free_calls,
    'unseen', (select count(*) from public.nv_recover_cases k where k.client_id = v_client and k.status = 'recovered'
                 and k.closed_at > coalesce(v_acc.seen_at, v_acc.accepted_at, '-infinity'::timestamptz)),
    'refused', (select coalesce(jsonb_agg(x order by (x->>'came_back_at') desc), '[]'::jsonb) from (
        select jsonb_build_object('parcel_id', p.id, 'awb', p.awb, 'consignee', p.consignee, 'city', p.city,
                 'cod', coalesce(p.cod_amount, 0), 'came_back_at', coalesce(p.status_since, p.updated_at),
                 'reason', coalesce(nullif(p.exception, ''), p.meta->>'exception', '')) as x
          from public.parcels p
         where p.client_id = v_client and p.status = 'Refused'
           and nullif(p.meta->>'reattemptRequestedAt', '') is null and nullif(p.meta->>'returnRequestedAt', '') is null
           and public.nv_recover_block(p.id) is null
         order by coalesce(p.status_since, p.updated_at) desc limit 6) t),
    'to_recover_cod', (select coalesce(sum(p.cod_amount), 0) from public.parcels p where p.client_id = v_client
                       and p.status in ('Refused', 'Return to shipper') and public.nv_recover_block(p.id) is null),
    'counts', jsonb_build_object(
      'to_recover', (select count(*) from public.parcels p where p.client_id = v_client
                       and p.status in ('Refused', 'Return to shipper') and public.nv_recover_block(p.id) is null),
      'with_novax', (select count(*) from public.nv_recover_cases k where k.client_id = v_client and k.status in ('waiting', 'calling', 'callback')),
      'recovered',  (select count(*) from public.nv_recover_cases k where k.client_id = v_client and k.status = 'recovered')));
end $$;

-- For Reports: what Nova Recover did for this merchant between two days
-- (Pakistan time, by the day the order was recovered).
create or replace function public.client_recover_summary(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid := public.my_client_id();
  v_from timestamptz := case when p_from is null then '-infinity'::timestamptz else (p_from::text || ' 00:00 Asia/Karachi')::timestamptz end;
  v_to timestamptz := case when p_to is null then 'infinity'::timestamptz else ((p_to + 1)::text || ' 00:00 Asia/Karachi')::timestamptz end;
begin
  if v_client is null or not public.nv_recover_visible(v_client) then return jsonb_build_object('visible', false); end if;
  return (select jsonb_build_object('visible', true,
      'recovered', count(*),
      'cod', coalesce(sum(k.agreed_cod), 0),
      'fees', coalesce(sum(k.fee), 0),
      'delivered', count(*) filter (where t.status = 'Delivered' and (k.mode = 'rebook' or t.delivered_at > k.closed_at)),
      'delivered_cod', coalesce(sum(k.agreed_cod) filter (where t.status = 'Delivered' and (k.mode = 'rebook' or t.delivered_at > k.closed_at)), 0))
    from public.nv_recover_cases k
    left join public.parcels t on t.id = coalesce(k.new_parcel_id, k.parcel_id)
   where k.client_id = v_client and k.status = 'recovered' and k.closed_at >= v_from and k.closed_at < v_to);
end $$;

-- ── emails ─────────────────────────────────────────────────────────────
-- Three more kinds, added to whatever the check allows today.
do $kinds$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.nv_email_queue'::regclass and conname = 'nv_email_queue_kind_check';
  if v_def is null then raise notice 'nv_email_queue_kind_check not found; Nova Recover emails are not enabled.'; return; end if;
  if position('recover_launch' in v_def) > 0 then return; end if;
  if position('ARRAY[' in v_def) = 0 then raise exception 'nv_email_queue_kind_check is not the shape Nova Recover expects. Nothing was changed.'; end if;
  if position('recover_refused' in v_def) > 0 then
    v_def := replace(v_def, 'ARRAY[', 'ARRAY[''recover_launch''::text, ');
  else
    v_def := replace(v_def, 'ARRAY[', 'ARRAY[''recover_refused''::text, ''recover_won''::text, ''recover_launch''::text, ');
  end if;
  execute 'alter table public.nv_email_queue drop constraint nv_email_queue_kind_check, add constraint nv_email_queue_kind_check ' || v_def;
end $kinds$;

-- Does this merchant take email, and this kind of news? Read from their
-- own notification choices (client_notification_prefs.email_enabled, and
-- the "events" list when an event is named). No saved choice means yes, the
-- default. If the choice cannot be read at all, the answer is no: an email
-- is never sent on a guess.
drop function if exists public.nv_recover_email_ok(uuid);
create or replace function public.nv_recover_email_ok(p_client uuid, p_event text default null) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_on boolean; v_events jsonb; v_found boolean := false;
begin
  begin
    execute 'select true, n.email_enabled, n.events from public.client_notification_prefs n where n.client_id = $1'
      into v_found, v_on, v_events using p_client;
  exception when others then return false; end;
  if not coalesce(v_found, false) then return true; end if;
  if v_on is not true then return false; end if;
  if p_event is not null and v_events is not null and jsonb_typeof(v_events) = 'array' and not (v_events ? p_event) then return false; end if;
  return true;
end $$;

-- A parcel was refused and NovaX no longer calls for free: tell the merchant
-- once a day, with a link to decide. Never blocks the parcel update.
create or replace function public.nv_recover_email_on_refused() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c public.nv_recover_config; v_business text;
begin
  c := public.nv_recover_cfg();
  if not c.emails or c.free_calls or new.client_id is null or not public.nv_recover_visible(new.client_id)
     or not public.nv_recover_email_ok(new.client_id, 'refused') then return new; end if;
  select name into v_business from public.clients where id = new.client_id;
  perform public.nv_email_enqueue(
    'recover_refused:' || new.client_id || ':' || to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD'),
    'recover_refused', public.nv_email_owner(new.client_id),
    jsonb_build_object('business', v_business, 'awb', new.awb, 'customer', new.consignee, 'city', new.city,
                       'cod', coalesce(new.cod_amount, 0), 'fee', c.fee, 'refused_at', now(),
                       'reason', coalesce(nullif(new.exception, ''), new.meta->>'exception', '')));
  return new;
exception when others then
  raise warning 'NovaX email enqueue failed (recover_refused), SQLSTATE %', SQLSTATE; return new;
end $$;
drop trigger if exists nv_recover_email_refused on public.parcels;
create trigger nv_recover_email_refused after update of status on public.parcels
  for each row when (new.status = 'Refused' and old.status is distinct from 'Refused')
  execute function public.nv_recover_email_on_refused();

-- An order was recovered: tell the merchant.
create or replace function public.nv_recover_email_on_won() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_business text;
begin
  if not (public.nv_recover_cfg()).emails or not public.nv_recover_email_ok(new.client_id) then return new; end if;
  select name into v_business from public.clients where id = new.client_id;
  perform public.nv_email_enqueue('recover_won:' || new.id, 'recover_won', public.nv_email_owner(new.client_id),
    jsonb_build_object('business', v_business, 'awb', coalesce(new.new_awb, new.awb), 'was_awb', new.awb, 'mode', new.mode,
                       'customer', new.consignee, 'city', new.city, 'cod', coalesce(new.agreed_cod, new.cod), 'was_cod', new.cod,
                       'fee', coalesce(new.fee, 0), 'deliver_on', new.agreed_date, 'recovered_at', new.closed_at));
  return new;
exception when others then
  raise warning 'NovaX email enqueue failed (recover_won), SQLSTATE %', SQLSTATE; return new;
end $$;
drop trigger if exists nv_recover_email_won on public.nv_recover_cases;
create trigger nv_recover_email_won after update of status on public.nv_recover_cases
  for each row when (new.status = 'recovered' and old.status is distinct from 'recovered')
  execute function public.nv_recover_email_on_won();

-- The launch email: once per merchant, to those who can see the tab and have
-- something to recover. p_send false only counts. At most 60 in one go,
-- because the mail provider allows 100 a day for everything NovaX sends.
create or replace function public.cs_recover_announce(p_send boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.nv_recover_config; r record; v_ready int := 0; v_sent int := 0; v_done int := 0; v_noemail int := 0;
begin
  perform public.cs_require_admin();
  c := public.nv_recover_cfg();
  if coalesce(p_send, false) and not c.emails then
    raise exception 'Turn on "Emails to merchants" first.' using errcode = '22023';
  end if;
  for r in
    select cl.id, cl.name, t.n, t.cod, t.recent, public.nv_email_owner(cl.id) as email,
           exists (select 1 from public.nv_email_milestones m where m.event_key = 'recover_launch:' || cl.id) as already
      from public.clients cl
      join lateral (select count(*)::int as n, coalesce(sum(p.cod_amount), 0) as cod,
                           count(*) filter (where coalesce(p.status_since, p.updated_at) > now() - interval '30 days')::int as recent
                      from public.parcels p where p.client_id = cl.id and p.status in ('Refused', 'Return to shipper')
                       and public.nv_recover_block(p.id) is null) t on t.n > 0
     where public.nv_recover_visible(cl.id)
       and not exists (select 1 from public.nv_recover_accept a where a.client_id = cl.id)
     order by t.recent desc, t.n desc
  loop
    if r.already then v_done := v_done + 1; continue; end if;
    if nullif(btrim(coalesce(r.email, '')), '') is null or not public.nv_recover_email_ok(r.id) then v_noemail := v_noemail + 1; continue; end if;
    v_ready := v_ready + 1;
    if coalesce(p_send, false) and v_sent < 60 then
      perform public.nv_email_enqueue('recover_launch:' || r.id, 'recover_launch', r.email,
        jsonb_build_object('business', r.name, 'count', r.n, 'cod', r.cod, 'recent', r.recent, 'fee', c.fee));
      v_sent := v_sent + 1;
    end if;
  end loop;
  return jsonb_build_object('ready', v_ready, 'sent', v_sent, 'already_sent', v_done, 'no_email', v_noemail, 'emails_on', c.emails);
end $$;

revoke all on function public.cs_recover_announce(boolean) from public, anon, authenticated;
grant execute on function public.cs_recover_announce(boolean) to authenticated;

revoke all on function
  public.cs_recover_peek(), public.cs_recover_merchants(), public.cs_recover_config_set(jsonb),
  public.client_recover_state(), public.client_recover_summary(date, date),
  public.nv_recover_email_ok(uuid, text), public.nv_recover_email_on_refused(), public.nv_recover_email_on_won()
from public, anon, authenticated;
grant execute on function
  public.cs_recover_peek(), public.cs_recover_merchants(), public.cs_recover_config_set(jsonb),
  public.client_recover_state(), public.client_recover_summary(date, date)
to authenticated;
