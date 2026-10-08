-- 9 Oct 2026: payout fees are flat. No fee is a share of the amount any more.
--
--   code       name           reaches the bank    fee
--   24h        Nova Saver     48-72 hours         free
--   12h        Nova Express   within 24 hours     Rs 100
--   instant    Nova Bolt      6-12 hours          Rs 500
--
-- The stored codes do not change, so nothing that reads withdrawals.speed
-- moves. A withdrawal already requested keeps the fee it was charged: fee and
-- net are stored on the row and are never worked out again.
--
-- The two functions that charge a fee are patched in place from their live
-- definitions (one asserted replacement each) instead of being retyped, so
-- nothing else in them can drift. Safe to run twice.

create or replace function public.nv_payout_fee(p_speed text)
returns numeric
language sql
immutable
set search_path to 'public'
as $$
  select (case p_speed when 'instant' then 500 when '12h' then 100 else 0 end)::numeric
$$;

comment on function public.nv_payout_fee(text) is
  'Flat payout fee in rupees for a speed code. The one place the fee lives (9 Oct 2026).';

-- Called only from SECURITY DEFINER functions, which run as the owner.
revoke all on function public.nv_payout_fee(text) from public, anon, authenticated;

do $patch$
declare
  v_old text := E'  v_rate := case p_speed when ''instant'' then 0.007 when ''12h'' then 0.003 else 0.001 end;\n  v_fee := round(p_amount * v_rate, 2);\n  v_net := p_amount - v_fee;';
  v_new text := E'  -- 9 Oct 2026: a flat fee for each withdrawal, never a share of the amount.\n  v_fee := public.nv_payout_fee(p_speed);\n  if v_fee > 0 and p_amount < v_fee + 1 then\n    raise exception ''This payout speed costs Rs %. Withdraw at least Rs %, or choose Nova Saver, which is free.'', v_fee, v_fee + 1;\n  end if;\n  v_net := p_amount - v_fee;';
  v_fn  regprocedure;
  v_def text;
begin
  foreach v_fn in array array[
    'public.nv_request_wallet_withdrawal_core(numeric,text,text,text)'::regprocedure,
    'public.admin_request_wallet_withdrawal(uuid,numeric,text,text)'::regprocedure
  ] loop
    v_def := pg_get_functiondef(v_fn);
    if position('public.nv_payout_fee(p_speed)' in v_def) > 0 then
      raise notice '% already charges flat fees', v_fn;
    elsif (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) = 1 then
      execute replace(v_def, v_old, v_new);
      raise notice '% now charges flat fees', v_fn;
    else
      raise exception '% does not have the fee lines this file expects; nothing was changed', v_fn;
    end if;
  end loop;
end
$patch$;

-- The wallet's "fees this month" card compared the month against the cheapest
-- and dearest speed using the old percentages.
do $patch$
declare
  v_old text := E'  cost_if_all_standard := round(coalesce(withdrawn_month, 0) * 0.001);\n  cost_if_all_instant  := round(coalesce(withdrawn_month, 0) * 0.007);';
  v_new text := E'  -- 9 Oct 2026: fees are flat for each withdrawal. Nova Saver is free, so the\n  -- cheapest a month can cost is nothing; the dearest is Nova Bolt every time.\n  cost_if_all_standard := 0;\n  cost_if_all_instant  := public.nv_payout_fee(''instant'') * (\n    select count(*) from public.withdrawals w\n     where w.client_id = v_client_id\n       and w.status = ''Paid''\n       and date_trunc(''month'', w.created_at) = date_trunc(''month'', now()));';
  v_def text := pg_get_functiondef('public.client_fee_insights()'::regprocedure);
begin
  if position('public.nv_payout_fee(''instant'')' in v_def) > 0 then
    raise notice 'client_fee_insights already uses flat fees';
  elsif (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) = 1 then
    execute replace(v_def, v_old, v_new);
    raise notice 'client_fee_insights now uses flat fees';
  else
    raise exception 'client_fee_insights does not have the lines this file expects; nothing was changed';
  end if;
end
$patch$;

-- The three saved assistant answers that quote the speeds or the fee. The
-- "within 15 minutes" COD-to-wallet sentence is left exactly as it was.
update public.nv_ai_answers set
  answer_en = 'The COD your customer pays is credited to your NovaX wallet within 15 minutes of delivery. Moving it to your bank is a withdrawal you request: Nova Saver, 48-72 hours, free; Nova Express, within 24 hours, Rs 100; or Nova Bolt, 6-12 hours, Rs 500.',
  answer_ur = 'Customer jo COD deta hai woh delivery ke 15 minute ke andar aapke NovaX wallet mein aa jata hai. Bank mein bhejna ek withdrawal hai jo aap khud request karte hain: Nova Saver, 48-72 ghante, free; Nova Express, 24 ghante ke andar, Rs 100; ya Nova Bolt, 6-12 ghante, Rs 500.'
where id = '9385f9bf-e32d-4bea-8e94-1866394d987d';

update public.nv_ai_answers set
  answer_en = 'Withdrawing your wallet to your bank has three speeds, each with a flat fee whatever the amount: Nova Saver (48-72 hours) is free, Nova Express (within 24 hours) is Rs 100, and Nova Bolt (6-12 hours) is Rs 500. Shipping itself has no hidden charges; this is the only fee on your money.',
  answer_ur = 'Wallet se bank mein paise bhejne ki teen speeds hain, aur har ek ki fee fixed hai, raqam jitni bhi ho: Nova Saver (48-72 ghante) free hai, Nova Express (24 ghante ke andar) Rs 100, aur Nova Bolt (6-12 ghante) Rs 500. Shipping mein koi hidden charge nahi; aapke paison par sirf yahi fee hai.'
where id = '069539ec-cacc-4309-9527-d92d5b9a442b';

update public.nv_ai_answers set
  answer_en = 'No. There is no GST and no COD withholding tax on NovaX shipping, and no hidden charges; the rate quoted is the rate you pay. Withdrawing your wallet to a bank is free with Nova Saver; the faster speeds cost a flat Rs 100 (Nova Express) or Rs 500 (Nova Bolt).',
  answer_ur = 'Nahi. NovaX shipping par koi GST nahi, koi COD withholding tax nahi, aur koi hidden charge nahi; jo rate bataya woh hi lagta hai. Wallet se bank mein paise nikalna Nova Saver se free hai; tez speed ki fixed fee hai: Nova Express Rs 100 ya Nova Bolt Rs 500.'
where id = 'fd89911c-25d4-4fca-b6af-31095f2f8d05';
