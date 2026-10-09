-- 10 Oct 2026: Nova Recover cases with no phone number to call.
--
-- Parcels booked before 19 Aug 2026 never had the customer's phone number or
-- address saved (298 parcels, 45 merchants). Nova Recover has no age limit,
-- so a merchant could send those parcels to the desk: 23 of the first 29
-- cases arrived with nothing to dial. The agent saw a blank phone and a
-- "Call customer" button that went nowhere.
--
--   1. A merchant must type the customer's number to send a parcel that has
--      none, and can add it to a case already sent.
--   2. The desk can save a number the merchant gives them, or correct one.
--   3. The desk's "to call" count leaves out cases with no number.
--   4. A parcel that is delivered after it was sent here leaves the queue by
--      itself (one such case on 9 Oct: sent at 5:42 pm, delivered 5:56 pm).
--   5. Home notices list up to 100 tracking numbers, not 10; the portal folds
--      the list and offers "Show all".
--
-- The parcel itself is never changed: the number lives on the case. Functions
-- are patched in place from their live definitions, one asserted replacement
-- each, so nothing else in them can drift. Safe to run twice.

set local lock_timeout = '8s';

alter table public.nv_recover_cases
  add column if not exists phone_source   text,
  add column if not exists phone_added_by uuid,
  add column if not exists phone_added_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'nv_recover_cases_phone_source_check') then
    alter table public.nv_recover_cases
      add constraint nv_recover_cases_phone_source_check check (phone_source is null or phone_source in ('parcel', 'merchant', 'desk'));
  end if;
end $$;

-- A phone number as typed, kept only if it can be dialled: 10 to 13 digits.
create or replace function public.nv_recover_phone(p text)
returns text
language sql
immutable
set search_path to ''
as $$
  select case when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) between 10 and 13
              then left(btrim(regexp_replace(p, '[^0-9+ -]', '', 'g')), 20) end
$$;
revoke all on function public.nv_recover_phone(text) from public, anon, authenticated;

-- Small helper for the patches below: one exact replacement, or stop.
create or replace function pg_temp.swap1(v_def text, v_old text, v_new text, v_what text)
returns text
language plpgsql
as $$
begin
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception '%: the live function does not have the line this file expects; nothing was changed', v_what;
  end if;
  return replace(v_def, v_old, v_new);
end $$;

-- What both the merchant and the desk are told about a case.
do $patch$
declare v_def text := pg_get_functiondef('public.nv_recover_case_json(public.nv_recover_cases)'::regprocedure);
begin
  if position('''no_phone''' in v_def) > 0 then raise notice 'nv_recover_case_json already says when a number is missing'; return; end if;
  execute pg_temp.swap1(v_def,
    $o$'new_awb', k.new_awb, 'fee', k.fee, 'mode', k.mode)$o$,
    $n$'new_awb', k.new_awb, 'fee', k.fee, 'mode', k.mode, 'no_phone', coalesce(btrim(k.phone), '') = '')$n$,
    'nv_recover_case_json');
end $patch$;

-- The merchant's list: which parcels have no number, and no case shown as
-- waiting once its parcel has been delivered.
do $patch$
declare v_def text := pg_get_functiondef('public.client_recover_list()'::regprocedure);
begin
  if position('''no_phone''' in v_def) > 0 then raise notice 'client_recover_list already says when a number is missing'; return; end if;
  v_def := pg_temp.swap1(v_def,
    $o$'block', public.nv_recover_block(p.id)) as x$o$,
    $n$'block', public.nv_recover_block(p.id), 'no_phone', coalesce(btrim(p.phone), '') = '') as x$n$,
    'client_recover_list (parcels)');
  v_def := pg_temp.swap1(v_def,
    $o$from public.nv_recover_cases k where k.client_id = v_client and k.status <> 'withdrawn'));$o$,
    $n$from public.nv_recover_cases k where k.client_id = v_client and k.status <> 'withdrawn'
                 and not (k.status in ('waiting', 'calling', 'callback')
                          and exists (select 1 from public.parcels dp where dp.id = k.parcel_id and dp.status = 'Delivered'))));$n$,
    'client_recover_list (cases)');
  execute v_def;
end $patch$;

-- Sending parcels: a parcel with no number needs one typed by the merchant.
do $patch$
declare
  v_old regprocedure := to_regprocedure('public.client_recover_push(uuid[], numeric, boolean, jsonb, text, text)');
  v_def text;
begin
  if to_regprocedure('public.client_recover_push(uuid[], numeric, boolean, jsonb, text, text, jsonb)') is not null then
    raise notice 'client_recover_push already takes phone numbers'; return;
  end if;
  if v_old is null then raise exception 'client_recover_push was not found with the arguments this file expects'; end if;
  v_def := pg_get_functiondef(v_old);
  v_def := pg_temp.swap1(v_def,
    $o$p_key text DEFAULT NULL::text)$o$,
    $n$p_key text DEFAULT NULL::text, p_phones jsonb DEFAULT '{}'::jsonb)$n$, 'client_recover_push (arguments)');
  v_def := pg_temp.swap1(v_def,
    E'    raise exception ''These can no longer be sent: %. Refresh the list and try again.'', v_bad;\n  end if;\n',
    E'    raise exception ''These can no longer be sent: %. Refresh the list and try again.'', v_bad;\n  end if;\n'
    || E'  -- 10 Oct 2026: parcels booked before 19 Aug carry no phone number. The\n'
    || E'  -- merchant types it; without one there is nobody for the desk to call.\n'
    || E'  select string_agg(p.awb, '', '') into v_bad\n'
    || E'    from public.parcels p\n'
    || E'   where p.id = any(v_ids) and p.client_id = v_client and coalesce(btrim(p.phone), '''') = ''''\n'
    || E'     and public.nv_recover_phone(coalesce(p_phones, ''{}''::jsonb)->>(p.id::text)) is null;\n'
    || E'  if v_bad is not null then\n'
    || E'    raise exception ''Add the customer''''s phone number for: %. We need it to call them.'', v_bad;\n'
    || E'  end if;\n',
    'client_recover_push (check)');
  v_def := pg_temp.swap1(v_def,
    $o$max_discount, item_note, merchant_note, push_key, pushed_by)$o$,
    $n$max_discount, item_note, merchant_note, push_key, pushed_by, phone_source, phone_added_by, phone_added_at)$n$,
    'client_recover_push (columns)');
  v_def := pg_temp.swap1(v_def,
    $o$p.consignee, p.phone, p.city, p.address, coalesce(p.cod_amount, 0),$o$,
    $n$p.consignee, coalesce(nullif(btrim(p.phone), ''), public.nv_recover_phone(coalesce(p_phones, '{}'::jsonb)->>(p.id::text))),
           p.city, p.address, coalesce(p.cod_amount, 0),$n$,
    'client_recover_push (phone)');
  v_def := pg_temp.swap1(v_def,
    $o$nullif(left(btrim(coalesce(p_note, '')), 300), ''), v_key, auth.uid()$o$,
    $n$nullif(left(btrim(coalesce(p_note, '')), 300), ''), v_key, auth.uid(),
           case when coalesce(btrim(p.phone), '') = '' then 'merchant' else 'parcel' end,
           case when coalesce(btrim(p.phone), '') = '' then auth.uid() end,
           case when coalesce(btrim(p.phone), '') = '' then now() end$n$,
    'client_recover_push (who added it)');
  execute 'drop function ' || v_old::text;
  execute v_def;
end $patch$;
revoke all on function public.client_recover_push(uuid[], numeric, boolean, jsonb, text, text, jsonb) from public, anon;
grant execute on function public.client_recover_push(uuid[], numeric, boolean, jsonb, text, text, jsonb) to authenticated;

-- A merchant adds the number to a case already with the desk. Only where the
-- case has none: a number on file is never replaced from the portal.
create or replace function public.client_recover_add_phone(p_case uuid, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare v_client uuid := public.my_client_id(); k public.nv_recover_cases; v_phone text := public.nv_recover_phone(p_phone);
begin
  if v_client is null then raise exception 'No client account linked to this session.' using errcode = '42501'; end if;
  if not public.nv_recover_visible(v_client) then raise exception 'Nova Recover is not open for this account yet.' using errcode = '42501'; end if;
  if not public.nv_recover_seat_ok(v_client) then
    raise exception 'Your team role cannot change Nova Recover. Ask the account owner or a warehouse login.' using errcode = '42501';
  end if;
  if v_phone is null then raise exception 'Check the phone number. It should look like 0300 1234567.'; end if;
  select * into k from public.nv_recover_cases x where x.id = p_case and x.client_id = v_client for update;
  if not found then raise exception 'That parcel is not with Nova Recover.'; end if;
  if k.status not in ('waiting', 'calling', 'callback') then raise exception 'This case is already closed.'; end if;
  if coalesce(btrim(k.phone), '') <> '' then
    raise exception 'We already have a number for this customer. Message NovaX support if it is wrong.';
  end if;
  update public.nv_recover_cases
     set phone = v_phone, phone_source = 'merchant', phone_added_by = auth.uid(), phone_added_at = now()
   where id = k.id;
  return jsonb_build_object('ok', true, 'awb', k.awb);
end $$;
revoke all on function public.client_recover_add_phone(uuid, text) from public, anon;
grant execute on function public.client_recover_add_phone(uuid, text) to authenticated;

-- The desk saves a number the merchant gave them, or corrects a wrong one.
create or replace function public.cs_recover_set_phone(p_case uuid, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare v_mode text := public.cs_recover_access(); k public.nv_recover_cases; v_phone text := public.nv_recover_phone(p_phone);
begin
  if v_phone is null then raise exception 'Check the phone number. It should look like 0300 1234567.'; end if;
  select * into k from public.nv_recover_cases x where x.id = p_case for update;
  if not found then raise exception 'That case no longer exists. Refresh the list.'; end if;
  if k.status not in ('waiting', 'calling', 'callback') then raise exception 'This case is already closed.'; end if;
  if k.held_by is not null and k.held_by <> auth.uid() and k.held_until > now() then
    raise exception '% is on this call. Pick another parcel.', public.nv_recover_agent_name(k.held_by) using errcode = '55P03';
  end if;
  update public.nv_recover_cases
     set phone = v_phone, phone_source = 'desk', phone_added_by = auth.uid(), phone_added_at = now()
   where id = k.id;
  return jsonb_build_object('ok', true, 'phone', v_phone);
end $$;
revoke all on function public.cs_recover_set_phone(uuid, text) from public, anon;
grant execute on function public.cs_recover_set_phone(uuid, text) to authenticated;

-- The desk's queue.
do $patch$
declare v_def text := pg_get_functiondef('public.cs_recover_queue()'::regprocedure);
begin
  if position('Delivered before we called' in v_def) > 0 then raise notice 'cs_recover_queue is already patched'; return; end if;
  v_def := pg_temp.swap1(v_def,
    E'   where k.status = ''calling'' and (k.held_until is null or k.held_until < now());\n',
    E'   where k.status = ''calling'' and (k.held_until is null or k.held_until < now());\n'
    || E'\n  -- 10 Oct 2026: a parcel delivered after it was sent here needs no call.\n'
    || E'  update public.nv_recover_cases k\n'
    || E'     set status = ''withdrawn'', withdrawn_at = now(), held_by = null, held_until = null, reason = ''Delivered before we called''\n'
    || E'    from public.parcels dp\n'
    || E'   where dp.id = k.parcel_id and dp.status = ''Delivered'' and k.status in (''waiting'', ''callback'');\n',
    'cs_recover_queue (delivered)');
  v_def := pg_temp.swap1(v_def,
    $o$'to_call', (select count(*) from public.nv_recover_cases k where k.status in ('waiting', 'calling')
                     or (k.status = 'callback' and coalesce(k.callback_at, now()) <= now())),$o$,
    $n$'to_call', (select count(*) from public.nv_recover_cases k where coalesce(btrim(k.phone), '') <> ''
                     and (k.status in ('waiting', 'calling') or (k.status = 'callback' and coalesce(k.callback_at, now()) <= now()))),
      'no_phone', (select count(*) from public.nv_recover_cases k where coalesce(btrim(k.phone), '') = ''
                     and k.status in ('waiting', 'calling', 'callback')),$n$,
    'cs_recover_queue (counts)');
  execute v_def;
end $patch$;

-- Home notices: name up to 100 parcels. The portal shows ten and "Show all".
do $patch$
declare v_def text; v_n int;
begin
  if to_regprocedure('public.client_smart_insights()') is null then raise notice 'client_smart_insights is not installed here; skipped'; return; end if;
  v_def := pg_get_functiondef('public.client_smart_insights()'::regprocedure);
  if position('limit 100 )' in v_def) > 0 then raise notice 'client_smart_insights already lists up to 100'; return; end if;
  v_n := (length(v_def) - length(replace(v_def, 'limit 10 )', ''))) / length('limit 10 )');
  if v_n <> 3 or (length(v_def) - length(replace(v_def, ') > 10', ''))) / length(') > 10') <> 3
              or (length(v_def) - length(replace(v_def, ') - 10)', ''))) / length(') - 10)') <> 3 then
    raise exception 'client_smart_insights does not have the three lists this file expects; nothing was changed';
  end if;
  execute replace(replace(replace(v_def, 'limit 10 )', 'limit 100 )'), ') > 10', ') > 100'), ') - 10)', ') - 100)');
end $patch$;

notify pgrst, 'reload schema';
