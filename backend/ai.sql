-- =====================================================================
-- NovaX backend -- ai
--
-- GENERATED from the live database, 2026-08-24. Do not hand-edit: change the
-- function in Supabase, then re-export so this file stays truthful.
--
-- This exists because 71 of the 88 RPCs the portals call had no source
-- anywhere outside the deployed database. That is what made every question
-- -- "is per-km still on?", "does the money tab count new bookings?",
-- "what does that trigger do?" -- an archaeological dig instead of a diff.
--
-- 20 function(s) in this file.
-- =====================================================================

CREATE FUNCTION public.ai_action_fix_address(p_awb text, p_address text DEFAULT NULL::text, p_phone text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare c uuid; cur record; new_addr text; new_phone text;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('ok',false,'reason','no_client'); end if;

  select awb, address, phone into cur from public.parcels
   where client_id = c and upper(awb) = upper(btrim(coalesce(p_awb,'')))
   for update;
  if not found then return jsonb_build_object('ok',false,'reason','not_your_parcel'); end if;

  new_addr  := nullif(btrim(coalesce(p_address,'')),'');
  new_phone := nullif(btrim(coalesce(p_phone,'')),'');

  update public.parcels
     set address = case when coalesce(btrim(address),'') = '' and new_addr is not null
                        then new_addr else address end,
         phone   = case when coalesce(btrim(phone),'') = '' and new_phone is not null
                        then new_phone else phone end,
         updated_at = now()
   where client_id = c and upper(awb) = upper(btrim(p_awb));

  return jsonb_build_object('ok',true,'awb',cur.awb,
    'address_written', coalesce(btrim(cur.address),'') = '' and new_addr is not null,
    'phone_written',   coalesce(btrim(cur.phone),'')   = '' and new_phone is not null);
end
$$;

CREATE FUNCTION public.ai_action_request_reattempt(p_awb text, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare res jsonb; a text;
begin
  a := upper(btrim(coalesce(p_awb,'')));
  if a = '' then return jsonb_build_object('ok',false,'reason','no_awb'); end if;
  select to_jsonb(public.novax_ticket_open(
    p_subject := 'Reattempt requested - ' || a,
    p_body    := coalesce(nullif(btrim(p_note),''),
                          'Merchant requested a delivery reattempt via NovaX AI.'),
    p_awb     := a,
    p_priority:= 'High')) into res;
  return jsonb_build_object('ok',true,'ticket',res);
end
$$;

CREATE FUNCTION public.ai_context_digest() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_conv_start(p_title text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare c uuid; new_id uuid;
begin
  c := public.nv_ai_my_client();
  if c is null then raise exception 'no client linked to this account'; end if;
  insert into public.nv_ai_conversations (client_id, title)
  values (c, nullif(btrim(coalesce(p_title,'')),''))
  returning id into new_id;
  return new_id;
end
$$;

CREATE FUNCTION public.ai_history(p_conv uuid, p_limit integer DEFAULT 20) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_msg_log(p_conv uuid, p_role text, p_content text, p_tools text[] DEFAULT NULL::text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_public_parcel(p_token text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r jsonb; tok text;
begin
  tok := btrim(coalesce(p_token,''));
  if tok = '' then return jsonb_build_object('error','no_token'); end if;

  select jsonb_build_object(
           'awb', p.awb,
           'status', p.status,
           'city', p.city,
           'consignee', p.consignee,
           'cod_amount', coalesce(p.cod_amount,0),
           'booked_at', p.booked_at,
           'last_update', p.updated_at,
           'hours_since_update',
             round(extract(epoch from (now() - p.updated_at)) / 3600.0, 1),
           'merchant', c.name)
    into r
    from public.parcels p
    left join public.clients c on c.id = p.client_id
   where p.meta->>'trackingToken' = tok
   limit 1;

  if r is null then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'parcel', r);
end
$$;

CREATE FUNCTION public.ai_quota_consume() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_quota_request_reset(p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_quota_status() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_tool_consignee_history(p_phone text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare c uuid; digits text; rows jsonb; total int; deliv int; ref int; ret int;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;

  digits := right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10);
  if digits = '' then return jsonb_build_object('error','no_phone_given'); end if;

  select count(*),
         count(*) filter (where p.status = 'Delivered'),
         count(*) filter (where p.status = 'Refused'),
         count(*) filter (where p.status in ('Return to shipper',
                                             'Parcel returned to consignee'))
    into total, deliv, ref, ret
    from public.parcels p
   where p.client_id = c and p.phone like '%' || digits;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into rows
    from (
      select jsonb_build_object('awb', p.awb, 'status', p.status,
                                'city', p.city, 'booked_at', p.booked_at) as x
        from public.parcels p
       where p.client_id = c and p.phone like '%' || digits
       order by p.booked_at desc
       limit 8
    ) s;

  return jsonb_build_object(
    'total_parcels', total, 'delivered', deliv,
    'refused', ref, 'returned', ret, 'recent', rows);
end
$$;

CREATE FUNCTION public.ai_tool_exceptions() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_tool_get_parcel(p_awb text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_tool_list_invoices(p_limit integer DEFAULT 10) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_tool_list_parcels(p_status text DEFAULT NULL::text, p_limit integer DEFAULT 20) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_tool_raise_ticket(p_subject text, p_body text, p_awb text DEFAULT ''::text, p_priority text DEFAULT 'Normal'::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.ai_tool_rate_card() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare c uuid; r jsonb;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;
  select jsonb_build_object('base_rate', cl.rate, 'rate_card', cl.rate_card,
                            'city', cl.city)
    into r from public.clients cl where cl.id = c;
  return coalesce(r, jsonb_build_object('error','client_not_found'));
end
$$;

CREATE FUNCTION public.ai_tool_remember(p_fact text, p_source text DEFAULT 'chat'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare c uuid;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('ok',false,'reason','no_client'); end if;
  if coalesce(btrim(p_fact),'') = '' then
    return jsonb_build_object('ok',false,'reason','empty_fact');
  end if;

  /* This is the one AI write-tool the model calls directly -- every other
     write is propose-then-human-tap. Whatever lands here is re-injected into
     the system prompt of every future conversation for this merchant, so a
     fact containing instruction-shaped text would quietly steer the model
     from then on. The tool results the model reads include rider-written
     exception notes and merchant-written consignee names, so that text is
     reachable from outside.

     Full propose/confirm is the proper fix and needs a frontend change.
     This is the proportionate half: strip the framing a payload needs and
     cap the length, so a remembered fact can be wrong but cannot issue
     orders. Blast radius stays inside this merchant''s own context either
     way -- nv_ai_memory is never read across clients. */
  p_fact := btrim(p_fact);
  p_fact := regexp_replace(p_fact, '[\u0000-\u001F\u007F]', ' ', 'g');
  p_fact := regexp_replace(p_fact, '`{2,}', '''', 'g');
  p_fact := regexp_replace(p_fact, '(Human|Assistant|System)\s*:', '-', 'gi');
  p_fact := regexp_replace(p_fact, '</?\s*(system|instructions?|prompt)[^>]*>', '', 'gi');
  p_fact := btrim(regexp_replace(p_fact, '\s{2,}', ' ', 'g'));
  if length(p_fact) > 240 then p_fact := left(p_fact, 240); end if;
  if p_fact = '' then
    return jsonb_build_object('ok',false,'reason','empty_fact');
  end if;

  insert into public.nv_ai_memory (client_id, fact, source)
  values (c, p_fact, coalesce(p_source,'chat'))
  on conflict (client_id, fact) do nothing;
  return jsonb_build_object('ok',true,'remembered',p_fact);
end
$$;

CREATE FUNCTION public.ai_tool_search_parcels(p_status text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_consignee text DEFAULT NULL::text, p_days integer DEFAULT NULL::integer, p_stale_hours integer DEFAULT NULL::integer, p_limit integer DEFAULT 15) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare c uuid; rows jsonb; n integer;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no_client'); end if;

  select coalesce(jsonb_agg(x), '[]'::jsonb), count(*) into rows, n
    from (
      select jsonb_build_object(
               'awb', p.awb, 'status', p.status, 'city', p.city,
               'consignee', p.consignee,
               'cod_amount', coalesce(p.cod_amount,0),
               'delivery_fee', coalesce(p.fee,0),
               'booked_at', p.booked_at,
               'hours_since_update',
                 round(extract(epoch from (now() - p.updated_at)) / 3600.0),
               'has_exception', coalesce(btrim(p.exception),'') <> '') as x
        from public.parcels p
       where p.client_id = c
         and (p_status    is null or p.status ilike p_status)
         and (p_city      is null or p.city ilike '%' || p_city || '%')
         and (p_consignee is null or p.consignee ilike '%' || p_consignee || '%')
         and (p_days      is null or p.booked_at >= now() - (p_days || ' days')::interval)
         and (p_stale_hours is null
              or p.updated_at <= now() - (p_stale_hours || ' hours')::interval)
       order by p.booked_at desc
       limit least(greatest(coalesce(p_limit,15),1), 25)
    ) s;

  return jsonb_build_object('count', n, 'parcels', rows);
end
$$;

CREATE FUNCTION public.nv_ai_my_client() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.client_id from public.profiles p where p.id = auth.uid();
$$;
