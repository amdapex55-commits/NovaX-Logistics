begin;

-- NovaX, 11 Sep 2026: a duplicate ticket reply within 30s is the same reply.
CREATE OR REPLACE FUNCTION public.novax_ticket_client_reply(p_ticket_id uuid, p_body text)
 RETURNS novax_ticket_replies
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_client uuid; v_t public.novax_tickets; v_row public.novax_ticket_replies; v_name text;
begin
  v_client := public.my_client_id();
  if v_client is null then raise exception 'Your account is not linked to a client workspace yet.'; end if;
  if coalesce(btrim(p_body),'') = '' then raise exception 'Reply cannot be empty.'; end if;

  select * into v_t from public.novax_tickets where id = p_ticket_id and client_id = v_client;
  if not found then raise exception 'Ticket not found on your account.'; end if;

  select name into v_name from public.clients where id = v_client;

  -- The same text twice within 30s is a double-click, not a second reply.
  -- The portal now disables the button while sending; this is the backstop
  -- for a retry, a slow network, or any other caller.
  select * into v_row from public.novax_ticket_replies r
   where r.ticket_id = p_ticket_id and r.by_side = 'client'
     and btrim(r.body) = btrim(p_body)
     and r.created_at > now() - interval '30 seconds'
   order by r.created_at desc limit 1;
  if found then
    return v_row;
  end if;

  insert into public.novax_ticket_replies (ticket_id, body, by_name, by_side)
  values (p_ticket_id, btrim(p_body), coalesce(v_name,''), 'client')
  returning * into v_row;

  -- A client reply reopens a ticket that was waiting on them.
  update public.novax_tickets
     set status = case when status = 'pending_client' then 'open' else status end,
         updated_at = now()
   where id = p_ticket_id;

  return v_row;
end $function$;

commit;
