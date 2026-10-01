-- Homepage hardening (1 Oct 2026), from the index-v3 review.
-- 1. public_home_stats(): the figures the page shows, and nothing else.
--    Totals only. No parcel counts (the page no longer shows them), and growth
--    comes back as a ratio, never as the counts behind it.
-- 2. Sales call-back form: the page inserts into sales_leads straight from the
--    browser, and the policy allowed any row from anyone. A guard trigger now
--    validates, dedupes and rate-limits every anonymous insert, which protects
--    the live page today without changing it.
begin;

create or replace function public.public_home_stats()
returns jsonb language sql stable security definer set search_path = '' as $$
  with m as (
    select date_trunc('month', now() at time zone 'Asia/Karachi') as this_month
  ), g as (
    select
      (select count(*) from public.parcels p, m where p.status = 'Delivered'
         and p.delivered_at at time zone 'Asia/Karachi' >= m.this_month - interval '1 month'
         and p.delivered_at at time zone 'Asia/Karachi' <  m.this_month) as last_month,
      (select count(*) from public.parcels p, m where p.status = 'Delivered'
         and p.delivered_at at time zone 'Asia/Karachi' >= m.this_month - interval '2 months'
         and p.delivered_at at time zone 'Asia/Karachi' <  m.this_month - interval '1 month') as month_before
  )
  select jsonb_build_object(
    'paid_out_total', coalesce((select round(sum(w.net)) from public.withdrawals w where w.status = 'Paid'), 0),
    'payouts_paid', (select count(*) from public.withdrawals w where w.status = 'Paid'),
    'cod_collected_total', coalesce((select round(sum(p.cod_amount)) from public.parcels p where p.status = 'Delivered'), 0),
    -- Every workspace except the team's own test accounts.
    'stores_signed_up', (select count(*) from public.clients c
       where c.name !~* '^\s*(test|testt|test account|test accoiunt|test client|test store|novax merchant)\s*$'),
    -- Last full Pakistan month over the one before; only once there is enough to compare.
    'growth_last_month', (select case when g.month_before >= 20 then round(g.last_month::numeric / g.month_before, 1) end from g),
    'as_of', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'));
$$;
revoke all on function public.public_home_stats() from public, anon, authenticated, service_role;
grant execute on function public.public_home_stats() to anon, authenticated;

create or replace function public.nv_sales_lead_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_phone text;
  v_ip text := '';
  v_hdrs jsonb;
begin
  -- NovaX staff adding a lead by hand are not throttled.
  if (select public.is_admin()) then return new; end if;

  new.name := left(btrim(regexp_replace(coalesce(new.name, ''), '\s+', ' ', 'g')), 80);
  if char_length(new.name) < 2 then
    raise exception 'Please enter your name.' using errcode = '22023';
  end if;

  -- Same normalisation as the page: +92 300 1234567, 0092..., 0300-1234567.
  v_phone := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
  if v_phone ~ '^0092' then v_phone := substr(v_phone, 5);
  elsif v_phone ~ '^92' and char_length(v_phone) >= 12 then v_phone := substr(v_phone, 3);
  elsif v_phone ~ '^0' then v_phone := substr(v_phone, 2);
  end if;
  if v_phone !~ '^3[0-9]{9}$' then
    raise exception 'Enter a Pakistani mobile number, like 0300 1234567.' using errcode = '22023';
  end if;
  new.phone := '0' || v_phone;

  if coalesce(new.parcels_per_month, '') not in ('1-10', '11-50', '51-200', '201-500', '500+') then
    new.parcels_per_month := '1-10';
  end if;
  new.status := 'New';
  new.created_at := now();

  -- One number asking twice in a day is one lead: keep the first, quietly.
  if exists (select 1 from public.sales_leads l
             where l.phone = new.phone and l.created_at > now() - interval '24 hours') then
    return null;
  end if;

  -- Ceilings: five a network an hour, thirty for everyone every ten minutes.
  -- The network is hashed before it is used as a key; it is never stored on the lead.
  begin v_hdrs := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then v_hdrs := null; end;
  v_ip := coalesce(nullif(v_hdrs->>'cf-connecting-ip', ''), nullif(btrim(split_part(coalesce(v_hdrs->>'x-forwarded-for', ''), ',', 1)), ''), '');
  if v_ip <> '' and not public.nv_track_rate_ok('sales:' || md5(v_ip || ':novax-sales'), 5, interval '1 hour') then
    raise exception 'Too many requests from this connection. Please try again later, or message us on WhatsApp.' using errcode = '54000';
  end if;
  if not public.nv_track_rate_ok('sales:all', 30, interval '10 minutes') then
    raise exception 'We are getting a lot of requests right now. Please try again in a few minutes, or message us on WhatsApp.' using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.nv_sales_lead_guard() from public, anon, authenticated, service_role;

drop trigger if exists nv_sales_lead_guard on public.sales_leads;
create trigger nv_sales_lead_guard before insert on public.sales_leads
  for each row execute function public.nv_sales_lead_guard();

-- The page only ever inserts. Reading, changing and deleting leads is for staff.
revoke select, update, delete on public.sales_leads from anon;

commit;
-- Undo:
--   drop trigger nv_sales_lead_guard on public.sales_leads; drop function public.nv_sales_lead_guard();
