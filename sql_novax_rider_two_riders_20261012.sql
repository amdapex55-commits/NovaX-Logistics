-- Two riders working one city (12 Oct 2026).
--
-- The station is shared: every rider of a city sees the same Pickup, Arriving
-- and At-station lists, and whoever marks a parcel takes it. That already
-- worked. What did not read well was the refusal when the other rider got
-- there first:
--     N123: cannot do "out" -- it is "Parcel out for delivery" (from Karachi to Lahore).
-- It now says who has the parcel, or that the step is already done, and to
-- refresh. Nothing about what is allowed changes: the same actions are
-- refused as before, with a sentence a rider can act on.
do $$
declare v_def text; v_old text; v_new text; n int;
begin
  v_def := pg_get_functiondef('public.rider_station_action(text[],text,text,text,jsonb,jsonb)'::regprocedure);
  v_old := $o$    if target is null then
      raise exception '%: cannot do "%" -- it is "%" (from % to %).', p.awb, p_action, p.status, initcap(o), initcap(d);
    end if;$o$;
  v_new := $n$    if target is null then
      -- two riders, one station: say who has it, or that the step is already done
      if p.status in ('Parcel out for delivery','Return out for delivery') and p_action in ('out','delivered','reattempt','refused','not_available') then
        if p.rider_id = r then raise exception '%: you already have this parcel out for delivery. Refresh your list.', p.awb; end if;
        raise exception '%: % has this parcel out for delivery. Refresh your list.', p.awb,
          coalesce((select x.name from public.riders x where x.id = p.rider_id), 'Another rider');
      end if;
      if p_action = 'collect' and p.status in ('Collected by rider','Arrived at warehouse','Parcel received at destination','Parcel now in transit','Parcel out for delivery') then
        raise exception '%: already collected. Refresh your list.', p.awb;
      end if;
      if p_action = 'receive' and p.status in ('Parcel received at destination','Return received at origin','Parcel out for delivery','Return out for delivery') then
        raise exception '%: already received at the station. Refresh your list.', p.awb;
      end if;
      if p_action = 'transit' and p.status in ('Parcel now in transit','Return in transit') then
        raise exception '%: already sent in a batch. Refresh your list.', p.awb;
      end if;
      raise exception '%: cannot do "%" -- it is "%" (from % to %).', p.awb, p_action, p.status, initcap(o), initcap(d);
    end if;$n$;
  n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if n = 0 and position('has this parcel out for delivery' in v_def) > 0 then raise notice 'already applied: nothing to do'; return; end if;
  if n <> 1 then raise exception 'expected the refusal once in rider_station_action, found %', n; end if;
  execute replace(v_def, v_old, v_new);
end $$;
notify pgrst, 'reload schema';
