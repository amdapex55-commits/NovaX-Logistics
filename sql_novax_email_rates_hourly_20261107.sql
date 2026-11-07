-- 7 Nov 2026 (owner: "send 80 now"): the rates email batch runs every hour
-- instead of once a day, and fills only what the free plan's 100-a-day leaves
-- free (ceiling 80 by default, so ~20 stay for account emails). One manual
-- run at ceiling 90 queued today's batch.
begin;
drop function if exists public.nv_email_rates_batch();
CREATE OR REPLACE FUNCTION public.nv_email_rates_batch(p_ceiling integer DEFAULT 80)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_now timestamptz := now(); v_room integer; v_token uuid; v_n integer := 0; v_left integer := 0; r record;
begin
  -- 7 Nov 2026: runs hourly. The free plan sends 100 a day; everything sent
  -- in the last 24 hours (and anything waiting) counts, and this never takes
  -- the queue above p_ceiling, so the rest stays free for signup, CNIC and
  -- payout emails. The drain itself has no daily cap.
  select greatest(0, least(80, least(coalesce(p_ceiling, 80), 95) - count(*))) into v_room from public.nv_email_queue
  where accepted_at > v_now - interval '24 hours' or state = 'pending';
  for r in
    with owners as (
      select c.id as client_id, c.name as business, btrim(u.email) as email,
        coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''), nullif(btrim(to_jsonb(p)->>'full_name'), ''), '') as name,
        (select count(*) from public.parcels x where x.client_id = c.id) as parcels,
        (select max(x.booked_at) from public.parcels x where x.client_id = c.id) as last_booked
      from public.clients c
      join public.profiles p on p.client_id = c.id and p.role::text = 'client'
      join auth.users u on u.id = p.id
      where lower(coalesce(c.status, 'active')) = 'active'
        and public.nv_promo_standard_card(c.rate_card)
        and u.email ~ '^[^[:space:]<>@,;]+@[^[:space:]<>@,;]+[.][^[:space:]<>@,;]+$'
        and lower(u.email) = lower(public.nv_email_owner(c.id))
    )
    select o.*, case when o.parcels > 0 and o.last_booked > v_now - interval '30 days' then 1 when o.parcels > 0 then 2 else 3 end as grp
    from owners o
    where not exists (select 1 from public.nv_email_reminders s where s.client_id = o.client_id and s.stopped_at is not null)
      and not exists (select 1 from public.client_notification_prefs n where n.client_id = o.client_id and n.email_enabled is false)
      and not exists (select 1 from public.nv_email_milestones m where m.event_key = 'rates_launch:' || o.client_id)
      and not exists (select 1 from public.nv_email_queue q where q.event_key = 'rates_launch:' || o.client_id)
    order by grp, o.last_booked desc nulls last, o.parcels desc, o.client_id
  loop
    if v_n >= v_room then v_left := v_left + 1; continue; end if;
    if exists (select 1 from public.nv_email_queue q where lower(btrim(q.recipient)) = lower(r.email) and q.created_at > v_now - interval '20 hours') then
      v_left := v_left + 1; continue;   -- emailed recently: next batch
    end if;
    insert into public.nv_email_reminders(client_id) values (r.client_id) on conflict (client_id) do nothing;
    select token into v_token from public.nv_email_reminders where client_id = r.client_id;
    perform public.nv_email_enqueue('rates_launch:' || r.client_id, 'rates_launch', r.email,
      jsonb_strip_nulls(jsonb_build_object('name', nullif(r.name, ''), 'business', r.business, 'token', v_token)));
    v_n := v_n + 1;
  end loop;
  if v_left = 0 then
    begin perform cron.unschedule('novax-rates-launch'); exception when others then null; end;
  end if;
  return jsonb_build_object('queued', v_n, 'left', v_left, 'room', v_room);
end $function$;
revoke all on function public.nv_email_rates_batch(integer) from public, anon, authenticated;
select cron.unschedule('novax-rates-launch');
select cron.schedule('novax-rates-launch', '15 * * * *', 'select public.nv_email_rates_batch();');
commit;
