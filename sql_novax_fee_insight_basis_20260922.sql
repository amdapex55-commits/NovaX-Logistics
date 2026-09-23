-- NovaX: the dashboard's monthly delivery fees were ~1% of the real figure.
--
-- client_fee_insights() summed p.fee only where delivery_charge_posted_at was
-- set. That column is almost never written: 39 of 632 delivered parcels
-- account-wide, and 2 of 153 for KKM SWEETS & NIMCO. So a merchant who paid
-- Rs 40,810 in delivery charges was shown Rs 520, and the "fees this month"
-- figure looked impossible beside their own parcel list -- which is exactly
-- how it was reported.
--
-- A delivery charge is incurred when the parcel is delivered, so delivered_at
-- is the honest basis. Where delivery_charge_posted_at exists it still wins,
-- so nothing already posted changes month.

CREATE OR REPLACE FUNCTION public.client_fee_insights()
 RETURNS TABLE(payout_fees_month numeric, delivery_fees_month numeric, total_fees_month numeric, withdrawn_month numeric, cost_if_all_standard numeric, cost_if_all_instant numeric, potential_saving numeric, best_speed text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_id uuid;
begin
  v_client_id := public.my_client_id();
  if v_client_id is null then
    raise exception 'No client account linked to this session.';
  end if;

  -- Payout fees actually charged this calendar month.
  -- AUDIT FIX (medium): this had no status filter, so REJECTED withdrawals
  -- counted as fees charged -- but admin_reject_wallet_withdrawal() refunds
  -- the full amount INCLUDING the fee back to wallet_balance. Pending ones
  -- have not been paid at all. Overstating fees to a paying merchant is
  -- exactly the trust failure this card exists to prevent, and it also
  -- inflated the "you would have saved Rs X" nudge. Paid only.
  select coalesce(sum(w.fee), 0), coalesce(sum(w.amount), 0)
    into payout_fees_month, withdrawn_month
    from public.withdrawals w
   where w.client_id = v_client_id
     and w.status = 'Paid'
     and date_trunc('month', w.created_at) = date_trunc('month', now());

  -- Delivery charges booked against this merchant this month.
  --
  -- This used to require delivery_charge_posted_at, a column that is almost
  -- never populated: across the whole production table only 39 of 632
  -- delivered parcels carry it, and for KKM SWEETS & NIMCO just 2 of 153. The
  -- month's delivery fees were therefore reported as Rs 520 against Rs 40,810
  -- actually charged -- about 1% -- which is what made the dashboard's fee
  -- insight look impossible next to the parcel list.
  --
  -- A delivery charge is incurred when the parcel is delivered, so delivered_at
  -- is the honest basis. delivery_charge_posted_at still wins where it exists,
  -- so nothing that IS posted moves month.
  select coalesce(sum(p.fee), 0)
    into delivery_fees_month
    from public.parcels p
   where p.client_id = v_client_id
     and coalesce(p.delivery_charge_posted_at, p.delivered_at) is not null
     and date_trunc('month', coalesce(p.delivery_charge_posted_at, p.delivered_at))
         = date_trunc('month', now());

  total_fees_month := coalesce(payout_fees_month, 0) + coalesce(delivery_fees_month, 0);

  -- What the SAME withdrawal volume would have cost at each speed.
  cost_if_all_standard := round(coalesce(withdrawn_month, 0) * 0.001);
  cost_if_all_instant  := round(coalesce(withdrawn_month, 0) * 0.007);

  potential_saving := greatest(coalesce(payout_fees_month, 0) - coalesce(cost_if_all_standard, 0), 0);

  best_speed := case
    when coalesce(withdrawn_month, 0) = 0 then null
    when payout_fees_month <= cost_if_all_standard then 'already_optimal'
    else 'standard'
  end;

  return next;
end;
$function$;
