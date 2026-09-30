-- ═══ Shopify connect codes: one per store, not one per account (30 Sep 2026) ══
-- Shopify's reviewers install on two test stores at once (29 Sep: paymenttestapps
-- and app-review-...-r124849; 28 Sep: ...-r122379-primary and -victim). Each
-- "Get my code" arrival called nvsh_link_code_issue(p_force => true), which
-- DELETED every other unused code on the account -- so the code fetched for
-- the first store was gone by the time it was pasted, and the app answered
-- "That code is not valid." four times across two reviews. One store was never
-- connected; the reviewer uninstalled with "Testing multiple apps".
--
-- Now a fresh code is issued on every arrival but earlier codes stay valid for
-- their own 20 minutes (single use, as before). At most 5 live codes per account;
-- beyond that the oldest are retired. A code that is missing -- replaced, expired
-- and cleaned up, or mistyped -- gets a message that says what to do.

create or replace function public.nvsh_link_code_issue(p_force boolean default false)
returns table(code text, expires_at timestamp with time zone)
language plpgsql security definer set search_path to 'public' as $function$
declare v_client uuid := public.my_client_id(); v_code text; v_exp timestamptz;
begin
  if v_client is null then
    raise exception 'Sign in to a NovaX merchant account first.';
  end if;
  if not public.is_client_owner_seat() then
    raise exception 'Only an account owner can connect a Shopify store.';
  end if;

  -- One writer at a time, so two tabs cannot both mint.
  perform pg_advisory_xact_lock(hashtext('nvsh_link_code:' || v_client::text));

  if not coalesce(p_force,false) then
    select c.code, c.expires_at into v_code, v_exp
      from public.nvsh_link_code c
     where c.client_id = v_client and c.used_at is null and c.expires_at > now()
     order by c.issued_at desc limit 1;
    if v_code is not null then
      return query select v_code, v_exp; return;
    end if;
  end if;

  -- Expired unused codes are useless; live ones may already be on their way
  -- into another store's "Connect" box, so they are kept.
  delete from public.nvsh_link_code c
   where c.client_id = v_client and c.used_at is null and c.expires_at <= now();
  -- Keep at most 4 live ones before adding the new one (5 in all).
  delete from public.nvsh_link_code c
   where c.client_id = v_client and c.used_at is null
     and c.code in (select x.code from public.nvsh_link_code x
                     where x.client_id = v_client and x.used_at is null
                     order by x.issued_at desc offset 4);

  loop
    v_code := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',(floor(random()*32)+1)::int,1),'')
                 from generate_series(1,8));
    exit when not exists (select 1 from public.nvsh_link_code x where x.code = v_code);
  end loop;
  insert into public.nvsh_link_code (code, client_id, issued_by, expires_at)
  values (v_code, v_client, auth.uid(), now() + interval '20 minutes');
  return query select v_code, now() + interval '20 minutes';
end $function$;

-- Claim: same checks, clearer answers, and a pasted code with a space or dash still works.
CREATE OR REPLACE FUNCTION public.nvsh_link_claim(p_shop text, p_code text)
 RETURNS TABLE(ok boolean, client_name text, released integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.nvsh_link_code; v_name text; v_released integer := 0;
  v_existing uuid; v_status text; v_hit int;
begin
  -- Lock the SHOP, not just the code. This is the row two racers contend for.
  select client_id, status into v_existing, v_status
    from public.nvsh_shop where shop_domain = p_shop for update;
  if not found then
    return query select false, null::text, 0, 'This store is not installed.'; return;
  end if;
  if v_status = 'blocked' then
    return query select false, null::text, 0,
      'This store is blocked. Contact NovaX support.'; return;
  end if;
  if v_existing is not null then
    select name into v_name from public.clients where id = v_existing;
    return query select false, v_name, 0,
      'This store is already connected to ' || coalesce(v_name,'a NovaX account') || '.'; return;
  end if;

  select * into v_row from public.nvsh_link_code
   where code = upper(regexp_replace(coalesce(p_code,''),'[^A-Za-z0-9]','','g')) for update;

  if not found then
    return query select false, null::text, 0,
      'That code was not recognised. Codes are 8 letters and numbers and work for 20 minutes. In NovaX, press Get my code and paste the newest code here.'; return;
  end if;
  if v_row.used_at is not null then
    return query select false, null::text, 0,
      'That code has already connected a store. Each store needs its own code: in NovaX, press Get my code again.'; return;
  end if;
  if v_row.expires_at < now() then
    return query select false, null::text, 0,
      'That code has expired (codes work for 20 minutes). In NovaX, press Get my code for a new one.'; return;
  end if;

  update public.nvsh_shop
     set client_id = v_row.client_id, status = 'active',
         linked_at = now(), updated_at = now()
   where shop_domain = p_shop
     and client_id is null          -- compare-and-set
     and status <> 'blocked';
  get diagnostics v_hit = row_count;
  if v_hit <> 1 then
    return query select false, null::text, 0,
      'This store was connected by someone else a moment ago.'; return;
  end if;

  update public.nvsh_link_code
     set used_at = now(), used_by_shop = p_shop
   where code = v_row.code;

  update public.nvsh_order
     set status = 'received', client_id = v_row.client_id, updated_at = now()
   where shop_domain = p_shop and status = 'pending_link';
  get diagnostics v_released = row_count;

  select name into v_name from public.clients where id = v_row.client_id;
  return query select true, v_name, v_released,
    'Connected to ' || coalesce(v_name,'your NovaX account') || '.';
end $function$;

