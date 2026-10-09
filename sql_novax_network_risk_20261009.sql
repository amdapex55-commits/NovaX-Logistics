-- 9 Oct 2026: a shared risk flag at booking.
--
-- When a seller types a customer's phone number, the portal can now say
-- "this number has had a parcel come back from another NovaX seller".
-- Until now each seller saw only their own history with a number, on purpose
-- (ai_tool_consignee_history). Aisha decided on 9 Oct to share the signal.
--
-- What crosses between sellers is one word and nothing else:
--   none   nothing came back elsewhere, or more was delivered than came back
--   some   at least one parcel came back elsewhere, and no more were delivered
--   high   two or more came back elsewhere, more than were delivered
-- Never which seller, what was ordered, where it went, the customer's name,
-- a count or a date. Parcels from the last 180 days only.
--
-- A signed-in seller could type numbers just to see who refuses parcels, so
-- every lookup is counted and a seller gets 300 a day; after that the answer
-- is "none" until tomorrow.
--
-- Safe to run twice.

create table if not exists public.nv_risk_lookups (
  client_id uuid not null,
  day       date not null,
  n         integer not null default 0,
  primary key (client_id, day)
);
alter table public.nv_risk_lookups enable row level security;
revoke all on table public.nv_risk_lookups from public, anon, authenticated;

-- The last ten digits of a phone number, however it was typed.
create index if not exists parcels_phone_last10_idx
  on public.parcels (right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10));

create or replace function public.client_phone_network_risk(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c uuid := public.my_client_id();
  v_digits text;
  v_n int; v_back int; v_deliv int;
begin
  if c is null then
    raise exception 'No client account linked to this session.' using errcode = '42501';
  end if;
  v_digits := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  if length(v_digits) < 10 then
    return jsonb_build_object('level', 'none');
  end if;

  insert into public.nv_risk_lookups as l (client_id, day, n)
  values (c, (now() at time zone 'Asia/Karachi')::date, 1)
  on conflict (client_id, day) do update set n = l.n + 1
  returning l.n into v_n;
  if v_n > 300 then
    return jsonb_build_object('level', 'none', 'limited', true);
  end if;

  select count(*) filter (where p.status in ('Refused', 'Return to shipper', 'Parcel returned to consignee',
                                             'Ready for return', 'Return in transit',
                                             'Return received at origin', 'Return out for delivery')),
         count(*) filter (where p.status = 'Delivered')
    into v_back, v_deliv
    from public.parcels p
   where p.client_id <> c
     and p.booked_at > now() - interval '180 days'
     and right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = v_digits;

  return jsonb_build_object('level',
    case when v_back >= 2 and v_back > v_deliv then 'high'
         when v_back >= 1 and v_back >= v_deliv then 'some'
         else 'none' end);
end
$$;
revoke all on function public.client_phone_network_risk(text) from public, anon;
grant execute on function public.client_phone_network_risk(text) to authenticated;
