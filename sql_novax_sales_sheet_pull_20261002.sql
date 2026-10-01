-- NovaX Sales: read leads straight from a Google Sheet (2 Oct 2026).
-- Aisha keeps the lead list in a Google Sheet shared as "anyone with the link
-- can view". NovaX reads its "Leads" tab every 15 minutes (and on "Import
-- now") and upserts the rows into sales_prospects. Nothing is written back to
-- the sheet and no Apps Script is needed. Replaces the Apps Script key sync.

create extension if not exists http with schema extensions;

begin;

-- The Apps Script path is retired: its key no longer opens anything.
delete from public.sales_settings where key = 'sheet_token_hash';

-- Reads the sheet and imports it. Called by cron and by the admin buttons.
create or replace function public.sales_sheet_pull()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id text := (select value from public.sales_settings where key = 'sheet_id');
  v_tab text := coalesce((select value from public.sales_settings where key = 'sheet_tab'), 'Leads');
  v_resp record; v_body text; v_json jsonb; v_cols jsonb; v_idx jsonb := '{}'::jsonb; v_rows jsonb := '[]'::jsonb;
  v_row jsonb; v_cells jsonb; v_out jsonb; v_code text; v_ref text; v_phone text; v_res jsonb; v_notes jsonb := '[]'::jsonb;
  v_i int; v_n int := 0; v_label text; v_key text;
  -- heading in the sheet → field NovaX imports
  v_map jsonb := '{"lead id":"lead_ref","store name":"store_name","contact person":"contact_name","phone":"phone","city":"city",
                   "category":"category","where found":"source","store link":"store_link","orders per month":"est_orders","assign to":"assign_to"}';
  v_pos text[] := array['lead_ref','store_name','contact_name','phone','city','category','source','store_link','est_orders','assign_to'];
begin
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'No sheet linked yet.'); end if;
  if not pg_try_advisory_xact_lock(hashtext('novax-sales-sheet-pull')) then
    return jsonb_build_object('ok', false, 'error', 'An import is already running. Try again in a minute.');
  end if;
  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '25');
    select * into v_resp from extensions.http_get(
      'https://docs.google.com/spreadsheets/d/' || v_id || '/gviz/tq?tqx=out:json&headers=1&sheet=' || replace(v_tab, ' ', '%20'));
    if v_resp.status <> 200 then
      raise exception 'Google answered %. Check the link and that sharing is "Anyone with the link".', v_resp.status;
    end if;
    v_body := v_resp.content;
    if v_body !~ 'setResponse\(' then
      raise exception 'The sheet is private. Set Share → General access → Anyone with the link → Viewer.';
    end if;
    -- gviz wraps JSON in a callback and writes dates as new Date(...): neither is JSON.
    v_body := substring(v_body from position('setResponse(' in v_body) + 12);
    v_body := left(v_body, length(v_body) - position(')' in reverse(v_body)));
    v_body := regexp_replace(v_body, 'new Date\([^)]*\)', 'null', 'g');
    v_json := v_body::jsonb;
    if v_json->>'status' = 'error' then
      raise exception 'Google could not read the tab "%": %. Make sure the tab is named exactly %.', v_tab,
        coalesce(v_json->'errors'->0->>'detailed_message', v_json->'errors'->0->>'message', 'unknown error'), v_tab;
    end if;
    v_cols := v_json->'table'->'cols';
    -- Match columns by their heading; fall back to the standard A–J order.
    for v_i in 0 .. coalesce(jsonb_array_length(v_cols), 0) - 1 loop
      v_label := lower(regexp_replace(btrim(coalesce(v_cols->v_i->>'label', '')), '\s+', ' ', 'g'));
      v_key := v_map->>v_label;
      if v_key is not null and not v_idx ? v_key then v_idx := v_idx || jsonb_build_object(v_key, v_i); end if;
    end loop;
    if not (v_idx ? 'store_name' and v_idx ? 'phone') then
      v_idx := '{}'::jsonb;
      for v_i in 1 .. 10 loop v_idx := v_idx || jsonb_build_object(v_pos[v_i], v_i - 1); end loop;
    end if;
    for v_row in select value from jsonb_array_elements(coalesce(v_json->'table'->'rows', '[]'::jsonb)) loop
      v_cells := v_row->'c'; v_out := '{}'::jsonb;
      for v_key in select jsonb_object_keys(v_idx) loop
        -- prefer the value as shown in the sheet ("f"), so 0300 1234567 keeps its 0
        v_out := v_out || jsonb_build_object(v_key, btrim(coalesce(v_cells->((v_idx->>v_key)::int)->>'f', v_cells->((v_idx->>v_key)::int)->>'v', '')));
      end loop;
      if coalesce(v_out->>'store_name', '') = '' and coalesce(v_out->>'phone', '') = '' then continue; end if;   -- blank row
      v_n := v_n + 1;
      if v_n > 2000 then exit; end if;
      v_phone := public.sales_norm_phone(v_out->>'phone');
      v_ref := nullif(left(btrim(coalesce(v_out->>'lead_ref', '')), 60), '');
      if v_ref is null and v_phone ~ '^03[0-9]{9}$' then v_ref := 'S' || v_phone; v_out := v_out || jsonb_build_object('lead_ref', v_ref); end if;
      -- "Assign to" only places a lead that has no rep yet; a move made in the
      -- portal is never undone by the sheet. An unknown code imports unassigned.
      v_code := upper(btrim(coalesce(v_out->>'assign_to', '')));
      if v_code <> '' then
        if not exists (select 1 from public.sales_reps where code = v_code and status <> 'Removed') then
          v_notes := v_notes || jsonb_build_object('row', v_n + 1, 'lead_ref', v_ref, 'reason', 'No active rep with code ' || v_code || ', imported unassigned');
          v_out := v_out - 'assign_to';
        elsif exists (select 1 from public.sales_prospects p where ((v_ref is not null and p.lead_ref = v_ref) or p.phone = v_phone) and p.rep_id is not null) then
          v_out := v_out - 'assign_to';
        end if;
      else
        v_out := v_out - 'assign_to';
      end if;
      v_rows := v_rows || v_out;
    end loop;
    v_res := public.sales_upsert_leads(v_rows);
    -- sheet row numbers in skip reasons (row 1 is the headings)
    v_res := jsonb_set(v_res, '{skipped}', coalesce((select jsonb_agg(s || jsonb_build_object('row', (s->>'row')::int + 1)) from jsonb_array_elements(v_res->'skipped') s), '[]'::jsonb));
    v_res := jsonb_build_object('ok', true, 'at', now(), 'rows', jsonb_array_length(v_rows), 'notes', v_notes) || v_res;
  exception when others then
    v_res := jsonb_build_object('ok', false, 'at', now(), 'error', sqlerrm);
  end;
  insert into public.sales_settings(key, value) values ('sheet_last', v_res::text)
  on conflict (key) do update set value = excluded.value;
  return v_res;
end $$;

create or replace function public.sales_admin_sheet_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_id text := (select value from public.sales_settings where key = 'sheet_id');
begin
  perform public.sales_require_admin();
  return jsonb_build_object('sheet_id', v_id,
    'sheet_url', case when v_id is not null then 'https://docs.google.com/spreadsheets/d/' || v_id || '/edit' end,
    'tab', coalesce((select value from public.sales_settings where key = 'sheet_tab'), 'Leads'),
    'last', (select value::jsonb from public.sales_settings where key = 'sheet_last'));
end $$;

create or replace function public.sales_admin_set_sheet(p_url text, p_tab text default 'Leads')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id text := coalesce(substring(coalesce(p_url, '') from '/spreadsheets/d/([A-Za-z0-9_-]{20,})'), substring(btrim(coalesce(p_url, '')) from '^([A-Za-z0-9_-]{20,})$'));
  v_tab text := btrim(coalesce(nullif(p_tab, ''), 'Leads'));
begin
  perform public.sales_require_admin();
  if v_id is null then raise exception 'Paste the full Google Sheet link (it starts with https://docs.google.com/spreadsheets/d/).' using errcode = '22023'; end if;
  if v_tab !~ '^[A-Za-z0-9 _-]{1,40}$' then raise exception 'Use a simple tab name, like Leads.' using errcode = '22023'; end if;
  insert into public.sales_settings(key, value) values ('sheet_id', v_id), ('sheet_tab', v_tab)
  on conflict (key) do update set value = excluded.value;
  delete from public.sales_settings where key = 'sheet_last';
  return public.sales_sheet_pull();
end $$;

create or replace function public.sales_admin_pull_sheet()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.sales_require_admin();
  return public.sales_sheet_pull();
end $$;

revoke all on function public.sales_sheet_pull(), public.sales_admin_sheet_status(), public.sales_admin_set_sheet(text, text),
  public.sales_admin_pull_sheet() from public, anon, authenticated;
grant execute on function public.sales_admin_sheet_status(), public.sales_admin_set_sheet(text, text), public.sales_admin_pull_sheet() to authenticated;

commit;

select cron.schedule('novax-sales-sheet-pull', '*/15 * * * *', 'select public.sales_sheet_pull()')
where not exists (select 1 from cron.job where jobname = 'novax-sales-sheet-pull');
