-- Codex caution #1 from "15 - Codex Second Review of Claude Fixes".
-- anon held DELETE and SELECT on signup_leads. Neither is an active hole today
-- (RLS has no anon policy for either, and a live anon read returns []), but the
-- grants make the table depend entirely on policy hygiene. The public signup
-- flow uses only INSERT (index.html:3161, index-v2.html:1048) and UPDATE
-- (index-v2.html:1055/1067/1072), so these two can go.
revoke delete on public.signup_leads from anon;
revoke select on public.signup_leads from anon;
-- authenticated keeps its grants: admin policies (is_admin()) gate them.
