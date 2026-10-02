-- 2 Oct 2026: charge every started kg above 1 kg, with no 5 kg ceiling.
-- Pricing (settled 14 Sep): Rs 225 Zone A / Rs 250 Zone B + Rs 85 per extra kg.
-- The 5 kg "normal slab" cap billed a 10 kg parcel (N6750001) as 5 kg: Rs 590
-- instead of Rs 1,015. Aisha approved removing it on 2 Oct.
-- Rewrites only the cap expression in each live function body, so nothing
-- else in them changes. CREATE OR REPLACE keeps owners and grants.
do $$
declare
  r record; v_def text; v_new text;
begin
  for r in
    select p.oid, p.oid::regprocedure as sig from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('novax_quote_fee','client_book_parcel','nv_book_parcel_core','nv_swap_fee')
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, 'least\((v_weight_kg|v_kg), 5\)', '\1', 'g');
    if v_new = v_def then
      raise exception 'No 5 kg cap found in %', r.sig;
    end if;
    if v_new ~ 'least\(v_(weight_)?kg' then
      raise exception 'Cap still present in %', r.sig;
    end if;
    execute v_new;
    raise notice 'uncapped %', r.sig;
  end loop;
end $$;

notify pgrst, 'reload schema';
