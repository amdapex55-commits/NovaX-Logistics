-- 19 Oct 2026: planned in the 2 Oct safety pass ("drop after ~9 Oct if still
-- unused"). 0 scans since then; the API looks up by key (nv_api_request_log_key_time_idx)
-- and by time (nv_api_request_log_time_idx). Undo:
--   create index concurrently nv_api_request_log_client_idx on public.nv_api_request_log (client_id, created_at desc);
drop index concurrently if exists public.nv_api_request_log_client_idx;
