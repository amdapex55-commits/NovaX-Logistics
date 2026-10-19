-- 19 Oct 2026: the rider app's "Today" list -- every status this rider set
-- today (Pakistan time), newest first, and for Refused / Not available whether
-- a voice note was sent or the microphone was reported blocked.
create or replace function public.rider_today()
returns table (awb text, consignee text, city text, from_status text, to_status text, changed_at timestamptz, voice text)
language sql stable security definer set search_path = '' as $$
  select l.awb, p.consignee, p.city, l.from_status, l.to_status, l.changed_at,
         case when l.to_status not in ('Refused', 'Consignee not available') then null
              when exists (select 1 from public.nv_parcel_voice v where v.parcel_id = l.parcel_id and v.status = l.to_status
                             and v.created_at >= l.changed_at - interval '5 minutes') then 'sent'
              when exists (select 1 from public.nv_parcel_voice_skip k where k.parcel_id = l.parcel_id and k.status = l.to_status
                             and k.created_at >= l.changed_at - interval '5 minutes') then 'skipped'
              else 'missing' end
    from public.nv_parcel_status_log l
    left join public.parcels p on p.id = l.parcel_id
   where public.my_rider_id() is not null
     and l.actor = auth.uid()
     and l.changed_at >= ((now() at time zone 'Asia/Karachi')::date::timestamp at time zone 'Asia/Karachi')
   order by l.changed_at desc
   limit 300;
$$;
revoke all on function public.rider_today() from public, anon;
grant execute on function public.rider_today() to authenticated;
