begin;

-- One-time existing-client welcome campaign. Never change signup or payout data.
with campaign as (
  insert into public.nv_email_milestones(event_key)
  values ('campaign:welcome-existing:20260927')
  on conflict do nothing returning event_key
), owners as (
  select distinct on (lower(btrim(u.email)))
    u.id as user_id, btrim(u.email) as email, u.created_at as signup_at,
    coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
      nullif(btrim(to_jsonb(p)->>'full_name'), ''), '') as name,
    c.name as business
  from public.clients c
  join public.profiles p on p.client_id = c.id and p.role::text = 'client'
  join auth.users u on u.id = p.id
  where lower(u.email) = lower(public.nv_email_owner(c.id))
    and lower(coalesce(to_jsonb(c)->>'status', 'active')) = 'active'
    and u.created_at <= timestamptz '2026-09-27 16:42:03.907654+00'
    and u.email ~ '^[^[:space:]<>@,;]+@[^[:space:]<>@,;]+[.][^[:space:]<>@,;]+$'
    and not exists (
      select 1 from public.nv_email_queue q
      where q.kind = 'welcome' and lower(btrim(q.recipient)) = lower(btrim(u.email))
    )
    and not exists (
      select 1 from public.nv_email_milestones m where m.event_key = 'welcome:' || u.id
    )
  order by lower(btrim(u.email)), u.created_at desc, u.id, c.id
), ranked as (
  select *, row_number() over (order by signup_at desc, user_id) as priority
  from owners where exists (select 1 from campaign)
), milestones as (
  insert into public.nv_email_milestones(event_key)
  select 'welcome:' || user_id from ranked
  on conflict do nothing returning event_key
), queued as (
  insert into public.nv_email_queue(event_key, kind, recipient, payload, next_attempt_at)
  select m.event_key, 'welcome', r.email,
    jsonb_build_object('name', r.name, 'business', r.business,
      'campaign', 'existing-clients-20260927', 'priority', r.priority,
      'batch', ((r.priority - 1) / 75) + 1),
    now() + ((r.priority - 1) / 75) * interval '25 hours'
      + ((r.priority - 1) % 75) * interval '2 seconds'
  from ranked r join milestones m on m.event_key = 'welcome:' || r.user_id
  returning payload, next_attempt_at
)
select payload->>'batch' as batch, count(*) as queued,
  min(next_attempt_at) as starts_at, max(next_attempt_at) as last_due_at
from queued group by payload->>'batch' order by batch;

commit;
