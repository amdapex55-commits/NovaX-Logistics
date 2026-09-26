-- ---------------------------------------------------------------------------
-- A18 and A22 from the second audit pass.
-- ---------------------------------------------------------------------------

begin;

-- A18 -- the cancel path read the parcel's status, then wrote by AWB with no
-- predicate. A rider collecting between the read and the write had the parcel
-- voided out from under them: physically in the network, 'Cancelled by client'
-- in the database, and nothing to reconcile it against. The UPDATE now carries
-- `status = 'New booked'` and the row count is what decides the outcome, so
-- the database itself performs the compare-and-set.
create or replace function public.nvsh_cancel_or_recall(p_shop text, p_order_id text)
returns table(ok boolean, outcome text, message text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_awb text; v_extra text[]; v_all text[]; v_pstatus text;
  v_cancelled int := 0; v_recalled int := 0; v_awb2 text; v_found boolean; v_hit int;
begin
  select true, o.awb, coalesce(o.extra_awbs,'{}')
    into v_found, v_awb, v_extra
    from public.nvsh_order o
   where o.shop_domain = p_shop and o.shopify_order_id = p_order_id
   for update;

  if not coalesce(v_found,false) then
    insert into public.nvsh_order (shop_domain, shopify_order_id, status, error, received_at, updated_at)
    values (p_shop, p_order_id, 'cancelled',
            'Cancelled in Shopify before the order reached NovaX', now(), now())
    on conflict (shop_domain, shopify_order_id) do nothing;
    return query select true, 'tombstone',
      'Cancelled before we received the order. It will not be booked.';
    return;
  end if;

  if v_awb is null then
    update public.nvsh_order
       set status='cancelled', error='Cancelled in Shopify before booking', updated_at=now()
     where shop_domain=p_shop and shopify_order_id=p_order_id;
    return query select true, 'cancelled', 'Cancelled before it was booked.'; return;
  end if;

  v_all := array_prepend(v_awb, v_extra);

  foreach v_awb2 in array v_all loop
    -- Lock the parcel row, so its status cannot change while we decide.
    select status into v_pstatus from public.parcels where awb = v_awb2 for update;
    if v_pstatus is null then continue; end if;

    if v_pstatus in ('Cancelled by client','Delivered','Return to shipper') then
      continue;
    end if;

    -- Compare-and-set. If a rider moved it in the meantime the predicate does
    -- not match, nothing is written, and it is treated as a recall instead.
    update public.parcels
       set status='Cancelled by client', updated_at=now()
     where awb = v_awb2 and status = 'New booked';
    get diagnostics v_hit = row_count;

    if v_hit = 1 then
      v_cancelled := v_cancelled + 1;
    else
      insert into public.operations_issues (branch, urgency, problem, awb, meta)
      values ('Karachi','High',
              'Shopify recall request: order cancelled after pickup (' || v_pstatus || ')',
              v_awb2,
              jsonb_build_object('source','shopify_app','shop',p_shop,'shopifyOrderId',p_order_id));
      v_recalled := v_recalled + 1;
    end if;
  end loop;

  if v_recalled > 0 then
    update public.nvsh_order
       set recall_requested_at=now(),
           error='Recall requested for '||v_recalled||' parcel(s) already picked up',
           updated_at=now()
     where shop_domain=p_shop and shopify_order_id=p_order_id;
    return query select true, 'recall',
      'Recall raised for ' || v_recalled || ' parcel(s) already with a rider' ||
      case when v_cancelled>0 then '; '||v_cancelled||' cancelled before pickup.' else '.' end;
    return;
  end if;

  if v_cancelled > 0 then
    perform public.nvsh_drop_from_pickup(
      (select client_id from public.nvsh_shop where shop_domain = p_shop), v_all);
    update public.nvsh_order
       set status='cancelled', error='Cancelled in Shopify before pickup', updated_at=now()
     where shop_domain=p_shop and shopify_order_id=p_order_id;
    return query select true, 'cancelled', v_cancelled || ' parcel(s) cancelled before pickup.'; return;
  end if;

  return query select false, 'none', 'Nothing left to cancel on this order.';
end $$;

revoke all on function public.nvsh_cancel_or_recall(text,text) from public, anon, authenticated;

-- A22 -- customers/data_request was answered with a 200 and a truncated copy of
-- the payload in an event log. Passing the HMAC test is not fulfilling the
-- request: Shopify gives 30 days, and nothing recorded a deadline, an owner or
-- a completion. This is the queue, with a due date and a status somebody can be
-- held to.
create table if not exists public.nvsh_privacy_request (
  id           uuid primary key default gen_random_uuid(),
  shop_domain  text not null,
  kind         text not null check (kind in ('customers/data_request','customers/redact','shop/redact')),
  shopify_customer_id text,
  orders_requested text[],
  payload      jsonb,
  status       text not null default 'open' check (status in ('open','in_progress','fulfilled','not_applicable')),
  due_at       timestamptz not null,
  completed_at timestamptz,
  completed_by text,
  note         text,
  created_at   timestamptz not null default now()
);

alter table public.nvsh_privacy_request enable row level security;
alter table public.nvsh_privacy_request force row level security;

create index if not exists nvsh_privacy_open_idx
  on public.nvsh_privacy_request (due_at)
  where status in ('open','in_progress');

create or replace function public.nvsh_privacy_log(
  p_shop text, p_kind text, p_customer text, p_orders text[], p_payload jsonb)
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare v_id uuid;
begin
  insert into public.nvsh_privacy_request
    (shop_domain, kind, shopify_customer_id, orders_requested, payload, due_at)
  values (p_shop, p_kind, p_customer, p_orders, p_payload, now() + interval '30 days')
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.nvsh_privacy_log(text,text,text,text[],jsonb)
  from public, anon, authenticated;

-- Overdue requests reach the same operations queue everything else does, so an
-- unanswered one becomes somebody's problem before the deadline passes.
create or replace function public.nvsh_privacy_due_tick()
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  insert into public.operations_issues (branch, urgency, problem, awb, meta)
  select 'Karachi', 'High',
         'Shopify privacy request due in under 7 days: ' || r.kind || ' for ' || r.shop_domain,
         null,
         jsonb_build_object('source','shopify_app','privacyRequestId', r.id, 'dueAt', r.due_at)
    from public.nvsh_privacy_request r
   where r.status in ('open','in_progress')
     and r.due_at < now() + interval '7 days'
     and not exists (
       select 1 from public.operations_issues i
        where i.meta->>'privacyRequestId' = r.id::text and not i.resolved);
end $$;

revoke all on function public.nvsh_privacy_due_tick() from public, anon, authenticated;

select cron.unschedule('novax-shopify-privacy-due')
 where exists (select 1 from cron.job where jobname='novax-shopify-privacy-due');
select cron.schedule('novax-shopify-privacy-due', '0 9 * * *', 'select public.nvsh_privacy_due_tick();');

commit;

select 'privacy queue' as check, to_regclass('public.nvsh_privacy_request')::text as detail
union all select 'cron', jobname from cron.job where jobname='novax-shopify-privacy-due';
