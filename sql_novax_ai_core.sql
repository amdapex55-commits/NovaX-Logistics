-- =====================================================================
-- NovaX AI — core schema, quota, memory and grounded tool RPCs
--
-- Security model: every tool resolves the caller's client through
-- profiles.client_id = auth.uid(). The Edge Function forwards the USER'S
-- JWT, never the service-role key, so a prompt-injected model still
-- cannot reach another merchant's data -- the database refuses.
--
-- Run in the Supabase SQL editor. Split at the ---- PART ---- markers
-- if the dashboard mangles a function body.
-- =====================================================================

---- PART 1: identity helper ----------------------------------------

create or replace function public.nv_ai_my_client()
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select p.client_id from public.profiles p where p.id = auth.uid();
$fn$;

---- PART 2: tables --------------------------------------------------

create table if not exists public.nv_ai_conversations (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null,
  started_at  timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  title       text,
  resolved    boolean not null default false
);

create table if not exists public.nv_ai_messages (
  id          bigserial primary key,
  conv_id     uuid not null references public.nv_ai_conversations(id) on delete cascade,
  client_id   uuid not null,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  tools_used  text[],
  created_at  timestamptz not null default now()
);

-- The 50-message cap. `used` only resets when an admin approves a request.
create table if not exists public.nv_ai_usage (
  client_id     uuid primary key,
  used          integer not null default 0,
  cap           integer not null default 50,
  cycle_started timestamptz not null default now(),
  last_reset_by uuid,
  last_reset_at timestamptz
);

create table if not exists public.nv_ai_quota_requests (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null,
  reason       text,
  status       text not null default 'pending' check (status in ('pending','approved','denied')),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid,
  admin_note   text
);

-- Facts NovaX AI has learned about this merchant, injected into the
-- system prompt on later conversations. This is the "memory".
create table if not exists public.nv_ai_memory (
  id         bigserial primary key,
  client_id  uuid not null,
  fact       text not null,
  source     text,
  created_at timestamptz not null default now(),
  unique (client_id, fact)
);

create index if not exists idx_nvai_msg_conv on public.nv_ai_messages(conv_id, created_at);
create index if not exists idx_nvai_conv_client on public.nv_ai_conversations(client_id, last_at desc);
create index if not exists idx_nvai_qr_status on public.nv_ai_quota_requests(status, requested_at desc);
create index if not exists idx_nvai_mem_client on public.nv_ai_memory(client_id);

---- PART 3: RLS -----------------------------------------------------

alter table public.nv_ai_conversations  enable row level security;
alter table public.nv_ai_messages       enable row level security;
alter table public.nv_ai_usage          enable row level security;
alter table public.nv_ai_quota_requests enable row level security;
alter table public.nv_ai_memory         enable row level security;

drop policy if exists nvai_conv_own on public.nv_ai_conversations;
create policy nvai_conv_own on public.nv_ai_conversations
  for select to authenticated using (client_id = public.nv_ai_my_client());

drop policy if exists nvai_msg_own on public.nv_ai_messages;
create policy nvai_msg_own on public.nv_ai_messages
  for select to authenticated using (client_id = public.nv_ai_my_client());

drop policy if exists nvai_usage_own on public.nv_ai_usage;
create policy nvai_usage_own on public.nv_ai_usage
  for select to authenticated using (client_id = public.nv_ai_my_client());

drop policy if exists nvai_qr_own on public.nv_ai_quota_requests;
create policy nvai_qr_own on public.nv_ai_quota_requests
  for select to authenticated using (client_id = public.nv_ai_my_client());

-- Admin/staff read everything (for the approval queue and ticket context)
drop policy if exists nvai_qr_admin on public.nv_ai_quota_requests;
create policy nvai_qr_admin on public.nv_ai_quota_requests
  for select to authenticated using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and lower(p.role::text) in ('admin','owner','staff')));

drop policy if exists nvai_conv_admin on public.nv_ai_conversations;
create policy nvai_conv_admin on public.nv_ai_conversations
  for select to authenticated using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and lower(p.role::text) in ('admin','owner','staff')));

drop policy if exists nvai_msg_admin on public.nv_ai_messages;
create policy nvai_msg_admin on public.nv_ai_messages
  for select to authenticated using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and lower(p.role::text) in ('admin','owner','staff')));

---- PART 4: quota -- the 50-message cap -----------------------------

create or replace function public.ai_quota_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare c uuid; u public.nv_ai_usage%rowtype; pending boolean;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;
  select * into u from public.nv_ai_usage where client_id = c;
  if not found then
    return jsonb_build_object('used',0,'cap',50,'remaining',50,'blocked',false,'pending_request',false);
  end if;
  select exists(select 1 from public.nv_ai_quota_requests
                 where client_id = c and status = 'pending') into pending;
  return jsonb_build_object(
    'used', u.used, 'cap', u.cap,
    'remaining', greatest(0, u.cap - u.used),
    'blocked', u.used >= u.cap,
    'pending_request', pending);
end
$fn$;

-- Called by the Edge Function before every model turn. Returns false and
-- consumes nothing once the cap is reached.
create or replace function public.ai_quota_consume()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare c uuid; u public.nv_ai_usage%rowtype;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('ok',false,'reason','no_client'); end if;

  insert into public.nv_ai_usage (client_id) values (c)
    on conflict (client_id) do nothing;

  select * into u from public.nv_ai_usage where client_id = c for update;

  if u.used >= u.cap then
    return jsonb_build_object('ok',false,'reason','cap_reached',
                              'used',u.used,'cap',u.cap);
  end if;

  update public.nv_ai_usage
     set used = used + 1
   where client_id = c
  returning * into u;

  return jsonb_build_object('ok',true,'used',u.used,'cap',u.cap,
                            'remaining',greatest(0,u.cap-u.used));
end
$fn$;

create or replace function public.ai_quota_request_reset(p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare c uuid; existing uuid; new_id uuid;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('ok',false,'reason','no_client'); end if;

  select id into existing from public.nv_ai_quota_requests
   where client_id = c and status = 'pending' limit 1;
  if existing is not null then
    return jsonb_build_object('ok',true,'already_pending',true,'id',existing);
  end if;

  insert into public.nv_ai_quota_requests (client_id, reason)
  values (c, nullif(btrim(coalesce(p_reason,'')),''))
  returning id into new_id;

  return jsonb_build_object('ok',true,'already_pending',false,'id',new_id);
end
$fn$;

-- Admin approves or denies. Approving zeroes the counter.
create or replace function public.admin_ai_quota_decide(
  p_request_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare is_admin boolean; req public.nv_ai_quota_requests%rowtype;
begin
  select exists(select 1 from public.profiles p
                 where p.id = auth.uid()
                   and lower(p.role::text) in ('admin','owner')) into is_admin;
  if not is_admin then
    raise exception 'admin access required to decide AI quota requests';
  end if;

  select * into req from public.nv_ai_quota_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if req.status <> 'pending' then
    return jsonb_build_object('ok',false,'reason','already_decided','status',req.status);
  end if;

  update public.nv_ai_quota_requests
     set status = case when p_approve then 'approved' else 'denied' end,
         decided_at = now(), decided_by = auth.uid(),
         admin_note = nullif(btrim(coalesce(p_note,'')),'')
   where id = p_request_id;

  if p_approve then
    update public.nv_ai_usage
       set used = 0, cycle_started = now(),
           last_reset_by = auth.uid(), last_reset_at = now()
     where client_id = req.client_id;
  end if;

  return jsonb_build_object('ok',true,'approved',p_approve,'client_id',req.client_id);
end
$fn$;

create or replace function public.admin_ai_quota_pending()
returns table (
  id uuid, client_id uuid, client_name text, reason text,
  requested_at timestamptz, used integer, cap integer)
language sql
stable
security definer
set search_path = public
as $fn$
  select r.id, r.client_id, c.name, r.reason, r.requested_at,
         coalesce(u.used,0), coalesce(u.cap,50)
    from public.nv_ai_quota_requests r
    left join public.clients c on c.id = r.client_id
    left join public.nv_ai_usage u on u.client_id = r.client_id
   where r.status = 'pending'
     and exists (select 1 from public.profiles p
                  where p.id = auth.uid()
                    and lower(p.role::text) in ('admin','owner','staff'))
   order by r.requested_at asc;
$fn$;

---- PART 5: grounded tools ------------------------------------------
-- Every tool filters on nv_ai_my_client(). The model can only ever see
-- the calling merchant's own rows. Wallet/insight tools are NOT
-- redefined here -- the Edge Function calls the existing
-- client_wallet_summary / client_smart_insights / client_fee_insights
-- RPCs directly, so money logic is never written twice.

create or replace function public.ai_tool_get_parcel(p_awb text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare c uuid; r jsonb; needle text;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;

  -- Tolerant matching: "1900021", "n1900021", "AWB N1900021" all resolve.
  needle := upper(regexp_replace(coalesce(p_awb,''), '[^A-Za-z0-9]', '', 'g'));
  if needle = '' then return jsonb_build_object('error','no_awb_given'); end if;
  if needle !~ '^N' then needle := 'N' || regexp_replace(needle, '^[A-Z]+', ''); end if;

  select jsonb_build_object(
           'awb', p.awb, 'status', p.status, 'consignee', p.consignee,
           'city', p.city, 'address', p.address, 'phone', p.phone,
           'cod_amount', p.cod_amount, 'fee', p.fee,
           'exception', nullif(p.exception,''),
           'booked_at', p.booked_at, 'last_update', p.updated_at,
           'hours_since_update',
             round(extract(epoch from (now() - p.updated_at)) / 3600.0, 1))
    into r
    from public.parcels p
   where p.client_id = c and upper(p.awb) = needle
   limit 1;

  if r is null then
    return jsonb_build_object('found', false, 'searched_for', needle);
  end if;
  return jsonb_build_object('found', true, 'parcel', r);
end
$fn$;

create or replace function public.ai_tool_list_parcels(
  p_status text default null, p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare c uuid; rows jsonb; total integer;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;

  select count(*) into total from public.parcels p
   where p.client_id = c
     and (p_status is null or lower(p.status) = lower(p_status));

  select coalesce(jsonb_agg(x order by x->>'last_update' desc), '[]'::jsonb)
    into rows
    from (
      select jsonb_build_object(
               'awb', p.awb, 'status', p.status, 'consignee', p.consignee,
               'city', p.city, 'cod_amount', p.cod_amount,
               'last_update', p.updated_at) as x
        from public.parcels p
       where p.client_id = c
         and (p_status is null or lower(p.status) = lower(p_status))
       order by p.updated_at desc
       limit least(greatest(coalesce(p_limit,20),1), 50)
    ) s;

  return jsonb_build_object('total_matching', total, 'showing', rows);
end
$fn$;

-- Parcels that are open and have not moved in 72h, or carry an exception.
create or replace function public.ai_tool_exceptions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare c uuid; rows jsonb;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into rows
    from (
      select jsonb_build_object(
               'awb', p.awb, 'status', p.status, 'consignee', p.consignee,
               'city', p.city, 'cod_amount', p.cod_amount,
               'exception', nullif(p.exception,''),
               'hours_stuck',
                 round(extract(epoch from (now() - p.updated_at)) / 3600.0, 1)) as x
        from public.parcels p
       where p.client_id = c
         and p.status not in ('Delivered','Return to shipper',
                              'Parcel returned to consignee','Cancelled')
         and (coalesce(btrim(p.exception),'') <> ''
              or p.updated_at < now() - interval '72 hours')
       order by p.updated_at asc
       limit 25
    ) s;

  return jsonb_build_object('count', jsonb_array_length(rows), 'parcels', rows);
end
$fn$;

create or replace function public.ai_tool_list_invoices(p_limit integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare c uuid; rows jsonb;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;

  -- to_jsonb(i) so this never breaks if the invoices table gains columns.
  select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) into rows
    from (select * from public.invoices
           where client_id = c
           order by created_at desc
           limit least(greatest(coalesce(p_limit,10),1), 25)) i;

  return jsonb_build_object('invoices', rows);
end
$fn$;

create or replace function public.ai_tool_rate_card()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare c uuid; r jsonb;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;
  select jsonb_build_object('base_rate', cl.rate, 'rate_card', cl.rate_card,
                            'city', cl.city)
    into r from public.clients cl where cl.id = c;
  return coalesce(r, jsonb_build_object('error','client_not_found'));
end
$fn$;

-- Files through the EXISTING ticket system so AI inquiries land in the
-- same inbox as everything else. SECURITY INVOKER on purpose: it runs
-- exactly as the merchant, inheriting novax_ticket_open's own checks.
create or replace function public.ai_tool_raise_ticket(
  p_subject text, p_body text,
  p_awb text default '', p_priority text default 'Normal')
returns jsonb
language plpgsql
security invoker
set search_path = public
as $fn$
declare res jsonb;
begin
  if coalesce(btrim(p_subject),'') = '' then
    return jsonb_build_object('ok',false,'reason','subject_required');
  end if;
  select to_jsonb(public.novax_ticket_open(
           p_subject := btrim(p_subject),
           p_body    := coalesce(btrim(p_body),''),
           p_awb     := upper(coalesce(btrim(p_awb),'')),
           p_priority:= coalesce(nullif(btrim(p_priority),''),'Normal')))
    into res;
  return jsonb_build_object('ok',true,'ticket',res);
end
$fn$;

-- Lets NovaX AI remember a durable fact about this merchant.
create or replace function public.ai_tool_remember(p_fact text, p_source text default 'chat')
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare c uuid;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('ok',false,'reason','no_client'); end if;
  if coalesce(btrim(p_fact),'') = '' then
    return jsonb_build_object('ok',false,'reason','empty_fact');
  end if;
  insert into public.nv_ai_memory (client_id, fact, source)
  values (c, btrim(p_fact), coalesce(p_source,'chat'))
  on conflict (client_id, fact) do nothing;
  return jsonb_build_object('ok',true,'remembered',btrim(p_fact));
end
$fn$;

---- PART 6: proactive digest + conversation memory ------------------

-- One call that gives NovaX AI everything it needs to OPEN the
-- conversation with something useful instead of "how can I help?".
create or replace function public.ai_context_digest()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare c uuid; nm text; by_status jsonb; stuck integer;
        delivered_30 integer; open_cnt integer; cod_pending numeric;
        facts jsonb; unpaid integer;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;

  select name into nm from public.clients where id = c;

  select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb) into by_status
    from (select p.status, count(*) n from public.parcels p
           where p.client_id = c group by p.status) s;

  select count(*) into open_cnt from public.parcels p
   where p.client_id = c
     and p.status not in ('Delivered','Return to shipper',
                          'Parcel returned to consignee','Cancelled');

  select count(*) into stuck from public.parcels p
   where p.client_id = c
     and p.status not in ('Delivered','Return to shipper',
                          'Parcel returned to consignee','Cancelled')
     and (coalesce(btrim(p.exception),'') <> ''
          or p.updated_at < now() - interval '72 hours');

  select count(*) into delivered_30 from public.parcels p
   where p.client_id = c and p.status = 'Delivered'
     and p.updated_at > now() - interval '30 days';

  select coalesce(sum(p.cod_amount),0) into cod_pending from public.parcels p
   where p.client_id = c
     and p.status not in ('Delivered','Return to shipper',
                          'Parcel returned to consignee','Cancelled');

  begin
    select count(*) into unpaid from public.invoices
     where client_id = c and coalesce(lower(status::text),'') <> 'paid';
  exception when others then unpaid := null;
  end;

  select coalesce(jsonb_agg(m.fact order by m.created_at desc), '[]'::jsonb)
    into facts
    from (select fact, created_at from public.nv_ai_memory
           where client_id = c order by created_at desc limit 15) m;

  return jsonb_build_object(
    'merchant',            nm,
    'open_parcels',        open_cnt,
    'needs_attention',     stuck,
    'delivered_last_30d',  delivered_30,
    'cod_in_flight',       cod_pending,
    'unpaid_invoices',     unpaid,
    'status_breakdown',    by_status,
    'remembered_facts',    facts,
    'quota',               public.ai_quota_status());
end
$fn$;

create or replace function public.ai_conv_start(p_title text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare c uuid; new_id uuid;
begin
  c := public.nv_ai_my_client();
  if c is null then raise exception 'no client linked to this account'; end if;
  insert into public.nv_ai_conversations (client_id, title)
  values (c, nullif(btrim(coalesce(p_title,'')),''))
  returning id into new_id;
  return new_id;
end
$fn$;

create or replace function public.ai_msg_log(
  p_conv uuid, p_role text, p_content text, p_tools text[] default null)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare c uuid;
begin
  c := public.nv_ai_my_client();
  if c is null then return; end if;
  if not exists (select 1 from public.nv_ai_conversations
                  where id = p_conv and client_id = c) then
    raise exception 'conversation does not belong to this account';
  end if;
  insert into public.nv_ai_messages (conv_id, client_id, role, content, tools_used)
  values (p_conv, c, p_role, p_content, p_tools);
  update public.nv_ai_conversations set last_at = now() where id = p_conv;
end
$fn$;

create or replace function public.ai_history(p_conv uuid, p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare c uuid; rows jsonb;
begin
  c := public.nv_ai_my_client();
  if c is null then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content)
                            order by m.created_at asc), '[]'::jsonb)
    into rows
    from (select role, content, created_at from public.nv_ai_messages
           where conv_id = p_conv and client_id = c
           order by created_at desc
           limit least(greatest(coalesce(p_limit,20),1), 40)) m;
  return rows;
end
$fn$;

---- PART 7: grants --------------------------------------------------

grant execute on function public.nv_ai_my_client()            to authenticated;
grant execute on function public.ai_quota_status()            to authenticated;
grant execute on function public.ai_quota_consume()           to authenticated;
grant execute on function public.ai_quota_request_reset(text) to authenticated;
grant execute on function public.admin_ai_quota_decide(uuid, boolean, text) to authenticated;
grant execute on function public.admin_ai_quota_pending()     to authenticated;
grant execute on function public.ai_tool_get_parcel(text)               to authenticated;
grant execute on function public.ai_tool_list_parcels(text, integer)    to authenticated;
grant execute on function public.ai_tool_exceptions()                   to authenticated;
grant execute on function public.ai_tool_list_invoices(integer)         to authenticated;
grant execute on function public.ai_tool_rate_card()                    to authenticated;
grant execute on function public.ai_tool_raise_ticket(text, text, text, text) to authenticated;
grant execute on function public.ai_tool_remember(text, text)           to authenticated;
grant execute on function public.ai_context_digest()          to authenticated;
grant execute on function public.ai_conv_start(text)          to authenticated;
grant execute on function public.ai_msg_log(uuid, text, text, text[]) to authenticated;
grant execute on function public.ai_history(uuid, integer)    to authenticated;

revoke all on function public.admin_ai_quota_decide(uuid, boolean, text) from anon;
revoke all on function public.nv_ai_my_client() from anon;
