-- 4 Nov 2026: linking a Shopify store lets a merchant in from the signup queue.
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

  -- 4 Nov 2026: a merchant who links a real Shopify store is let in from the
  -- signup queue (nv_client_queue), so Shopify orders can be booked at once.
  update public.nv_client_queue
     set status = 'approved', approved_at = now()
   where client_id = v_row.client_id and status = 'waiting';

  select name into v_name from public.clients where id = v_row.client_id;
  return query select true, v_name, v_released,
    'Connected to ' || coalesce(v_name,'your NovaX account') || '.';
end $function$;
