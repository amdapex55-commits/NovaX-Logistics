-- The homepage no longer shows network figures (Aisha, 1 Oct 2026), so the
-- function that published them is removed: no totals left on the public API.
drop function if exists public.public_home_stats();
