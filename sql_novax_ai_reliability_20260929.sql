-- 29 Sep 2026: AI reliability.
-- 1. ai_conv_start reuses a conversation this merchant started in the last
--    60 s, under a per-merchant lock. A double tap, a retry after a slow reply
--    or the second chat widget used to open a twin conversation (9 pairs).
-- 2. ai_tool_get_invoice / ai_tool_account: invoice lines and account facts the
--    assistant could not read before ("what's in INV-...?", "what's my pickup city?").
create or replace function public.ai_conv_start(p_title text default null)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare c uuid; new_id uuid;
begin
  c := public.nv_ai_my_client();
  if c is null then raise exception 'no client linked to this account'; end if;
  perform pg_advisory_xact_lock(hashtext('nv_ai_conv_' || c::text));
  select id into new_id from public.nv_ai_conversations
   where client_id = c and started_at > now() - interval '60 seconds'
   order by started_at desc limit 1;
  if new_id is not null then return new_id; end if;
  insert into public.nv_ai_conversations (client_id, title)
  values (c, nullif(btrim(coalesce(p_title,'')),'')) returning id into new_id;
  return new_id;
end $$;

create or replace function public.ai_tool_get_invoice(p_code text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare c uuid; i public.invoices; lines jsonb;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no client linked'); end if;
  select * into i from public.invoices
   where client_id = c and upper(code) = upper(btrim(coalesce(p_code,''))) limit 1;
  if i.id is null then return jsonb_build_object('error','No invoice with that code on this account.'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('awb',p.awb,'consignee',p.consignee,'city',p.city,
           'status',p.status,'cod',p.cod_amount,'fee',p.fee) order by p.awb),'[]'::jsonb)
    into lines from public.parcels p where p.invoice_id = i.id and p.client_id = c;
  return jsonb_build_object('code',i.code,'type',i.invoice_type,'status',i.status,
    'created',to_char(i.created_at at time zone 'Asia/Karachi','DD Mon YYYY'),
    'cod_total',i.cod_total,'charges',i.fee_total,'paid_to_you',i.net_payable,'owed_to_novax',i.due_to_novax,
    'parcels',jsonb_array_length(lines),'lines',lines);
end $$;

create or replace function public.ai_tool_account()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare c uuid; r public.clients; n int; first_at timestamptz;
begin
  c := public.nv_ai_my_client();
  if c is null then return jsonb_build_object('error','no client linked'); end if;
  select * into r from public.clients where id = c;
  select count(*), min(booked_at) into n, first_at from public.parcels where client_id = c;
  return jsonb_build_object('business_name',r.name,'account_code','CL-'||upper(left(replace(r.id::text,'-',''),6)),
    'phone',r.phone,'pickup_city',coalesce(r.meta->>'pickupCity','Karachi'),'pickup_address',r.address,
    'joined',to_char(r.created_at at time zone 'Asia/Karachi','DD Mon YYYY'),
    'parcels_booked',n,'first_booking',to_char(first_at at time zone 'Asia/Karachi','DD Mon YYYY'),
    'wallet_balance',r.wallet_balance,'status',r.status);
end $$;

revoke all on function public.ai_tool_get_invoice(text) from public, anon;
revoke all on function public.ai_tool_account() from public, anon;
grant execute on function public.ai_tool_get_invoice(text) to authenticated;
grant execute on function public.ai_tool_account() to authenticated;
