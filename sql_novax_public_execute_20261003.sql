-- 3 Oct 2026: the last functions anyone could call with the public key.
-- 40 functions still carried PUBLIC EXECUTE (82 on 26 Sep). Kept for the
-- public on purpose: tracking by AWB or token (no names, phones or
-- addresses), the tracking assistant, the self-scoped helpers used inside
-- RLS policies (is_admin, my_client_id, ...), pure text/number helpers,
-- and trigger functions (PostgREST cannot call those).

-- 1. Page error logger: anonymous callers could write unlimited distinct
--    rows (only exact repeats within a minute were skipped). Same
--    per-connection limit as the public signup form: 30 an hour, extra
--    reports dropped silently -- a logger must never throw at the page.
do $$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.log_portal_error(text,text,text,text,text)'::regprocedure);
  if position('nv_client_net_key(''porterr'')' in v_def) > 0 then return; end if;  -- already applied
  v_new := replace(v_def,
    E'  if auth.uid() is null then\n    select count(*) into v_recent_count',
    E'  if auth.uid() is null and public.nv_client_net_key(''porterr'') <> ''''\n' ||
    E'     and not public.nv_track_rate_ok(public.nv_client_net_key(''porterr''), 30, interval ''1 hour'') then\n' ||
    E'    return;\n' ||
    E'  end if;\n' ||
    E'  if auth.uid() is null then\n    select count(*) into v_recent_count');
  if v_new = v_def then raise exception 'log_portal_error: anchor not found'; end if;
  execute v_new;
end $$;

-- 2. Signed-in or server use only. They run with the caller's rights, so
--    the public could not read anything through them, but nothing public
--    needs them either.
do $$
declare f text;
begin
  foreach f in array array[
    'public.ai_action_request_reattempt(text,text)',
    'public.ai_tool_raise_ticket(text,text,text,text)',
    'public.generate_channel_awb(uuid,text)',
    'public.nv_parcel_journey(uuid)',
    'public.ticket_effective_tier(public.tickets)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
