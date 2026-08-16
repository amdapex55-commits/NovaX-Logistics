-- ============================================================================
-- NovaX -- Karachi area coverage top-up (v2)   [APPLIED 2026-08-16]
--
-- WHY: merchants reported their address not appearing in the booking form's
-- pickup/delivery area picker. The picker is populated entirely from
-- novax_areas via novax_areas_list('Karachi') -- there is no hardcoded list in
-- client.html -- so an address with no row here cannot be selected at all, and
-- for pickup it leaves the client unmapped, which means distance pricing has
-- no origin and cannot quote their parcels.
--
-- Distance pricing itself was already correctly configured and enabled
-- (base 120 / included 6km / 20 per km / max 320 / road factor 1.35,
-- set by sql:v3_enable on 2026-08-13). Missing areas were the real blocker.
--
-- SCHEMA NOTES (verified against the live table, do not guess these):
--   columns: id, city, name, aliases text[], lat, lng, active, sort,
--            created_at, auto_match, harbour_side
--   * the boolean is `active`, NOT `is_active`
--   * there is NO unique constraint on (city, name), so `on conflict do
--     nothing` silently inserts duplicates -- this uses an anti-join instead
--   * harbour_side is only partially populated across the table; many
--     pre-existing rows are null, so null is normal rather than a defect
--
-- Section 2 is the cleanup pass: the first run of section 1 introduced rows
-- that duplicated existing areas held under a different name (e.g. this
-- script's "Bin Qasim Town" vs the existing "Bin Qasim"), which matters
-- because the typeahead matches on aliases and two rows sharing an alias make
-- the picker ambiguous. Both sections are re-runnable.
-- ============================================================================


-- ============================================================================
-- 1. Add missing Karachi areas
-- ============================================================================
with incoming(city, name, aliases, lat, lng) as (values
  -- ---- DHA / Clifton / Cantt belt ----
  ('Karachi', 'DHA Phase 1',            array['dha 1','dha phase i','defence phase 1','defence 1'],                       24.8443, 67.0435),
  ('Karachi', 'DHA Phase 2',            array['dha 2','dha phase ii','defence phase 2','defence 2'],                      24.8360, 67.0555),
  ('Karachi', 'DHA Phase 3',            array['dha 3','dha phase iii','defence phase 3','defence 3'],                     24.8285, 67.0410),
  ('Karachi', 'DHA Phase 4',            array['dha 4','dha phase iv','defence phase 4','defence 4'],                      24.8060, 67.0640),
  ('Karachi', 'DHA Phase 5',            array['dha 5','dha phase v','phase v','defence phase 5','defence 5','khayaban'],  24.8010, 67.0480),
  ('Karachi', 'DHA Phase 6',            array['dha 6','dha phase vi','phase vi','defence phase 6','defence 6'],           24.8085, 67.0705),
  ('Karachi', 'DHA Phase 7',            array['dha 7','dha phase vii','phase vii','defence phase 7','defence 7'],         24.7930, 67.0730),
  ('Karachi', 'DHA Phase 8',            array['dha 8','dha phase viii','phase viii','defence phase 8','defence 8'],       24.7830, 67.0530),
  ('Karachi', 'DHA City',               array['dha city karachi','dha city'],                                             25.0100, 67.3200),
  ('Karachi', 'Clifton Block 1',        array['clifton 1','clifton block one'],                                           24.8180, 67.0290),
  ('Karachi', 'Clifton Block 2',        array['clifton 2'],                                                               24.8140, 67.0300),
  ('Karachi', 'Clifton Block 4',        array['clifton 4','schon circle'],                                                24.8130, 67.0330),
  ('Karachi', 'Clifton Block 5',        array['clifton 5','kehkashan'],                                                   24.8090, 67.0290),
  ('Karachi', 'Clifton Block 7',        array['clifton 7'],                                                               24.8215, 67.0345),
  ('Karachi', 'Clifton Block 8',        array['clifton 8'],                                                               24.8175, 67.0380),
  ('Karachi', 'Clifton Block 9',        array['clifton 9','bilawal house area'],                                          24.8110, 67.0250),
  ('Karachi', 'Saddar',                 array['saddar town','empress market','sadar'],                                    24.8600, 67.0220),

  -- ---- Gulshan / Gulistan / University Road belt ----
  ('Karachi', 'Gulshan-e-Iqbal Block 3',   array['gulshan 3','gulshan block 3'],                                          24.9250, 67.0900),
  ('Karachi', 'Gulshan-e-Iqbal Block 5',   array['gulshan 5','gulshan block 5'],                                          24.9290, 67.0840),
  ('Karachi', 'Gulistan-e-Jauhar Block 7', array['jauhar 7','johar 7'],                                                   24.9180, 67.1350),
  ('Karachi', 'Gulistan-e-Jauhar Block 12',array['jauhar 12','johar 12'],                                                 24.9240, 67.1420),
  ('Karachi', 'Gulistan-e-Jauhar Block 17',array['jauhar 17','johar 17','pehalwan goth'],                                 24.9300, 67.1480),
  ('Karachi', 'Safoora Goth',              array['safoora','safora','safoora chowrangi'],                                 24.9400, 67.1550),
  ('Karachi', 'Scheme 33',                 array['scheme 33','scheme thirty three'],                                      24.9450, 67.1300),

  -- ---- North Karachi / North Nazimabad / Nazimabad belt ----
  ('Karachi', 'North Nazimabad Block A', array['north naz a','nn block a','north nazimabad a'],                           24.9450, 67.0380),
  ('Karachi', 'North Nazimabad Block B', array['north naz b','nn block b'],                                               24.9480, 67.0340),
  ('Karachi', 'North Nazimabad Block D', array['north naz d','nn block d'],                                               24.9420, 67.0300),
  ('Karachi', 'North Nazimabad Block H', array['north naz h','nn block h'],                                               24.9370, 67.0420),
  ('Karachi', 'North Nazimabad Block L', array['north naz l','nn block l'],                                               24.9520, 67.0450),
  ('Karachi', 'Nazimabad No. 1',         array['nazimabad 1','nazimabad one'],                                            24.9080, 67.0300),
  ('Karachi', 'Nazimabad No. 3',         array['nazimabad 3'],                                                            24.9120, 67.0260),
  ('Karachi', 'Nazimabad No. 5',         array['nazimabad 5','paposh nagar','paposh'],                                    24.9180, 67.0330),
  ('Karachi', 'North Karachi Sector 5',  array['north karachi 5','nk 5','sector 5'],                                      24.9880, 67.0620),
  ('Karachi', 'North Karachi Sector 11-B',array['north karachi 11b','nk 11 b','sector 11 b'],                             24.9920, 67.0680),
  ('Karachi', 'New Karachi',             array['new karachi'],                                                            25.0050, 67.0720),
  ('Karachi', 'Bufferzone Sector 16-A',  array['sector 16 a','16 a','bufferzone 16a'],                                    24.9760, 67.0690),

  -- ---- Korangi / Landhi / Malir / east belt ----
  ('Karachi', 'Korangi No. 1',           array['korangi 1','korangi one'],                                                24.8420, 67.1330),
  ('Karachi', 'Korangi No. 5',           array['korangi 5'],                                                              24.8290, 67.1520),
  ('Karachi', 'Shah Faisal Colony',      array['shah faisal','faisal colony','shah faisal town'],                         24.8760, 67.1600),
  ('Karachi', 'Quaidabad',               array['quaidabad','qaidabad'],                                                   24.8600, 67.2400),

  -- ---- Central / west / old city belt ----
  ('Karachi', 'PECHS Block 2',           array['pechs 2','pechs block 2','tariq road'],                                   24.8720, 67.0620),
  ('Karachi', 'PECHS Block 6',           array['pechs 6','pechs block 6'],                                                24.8680, 67.0690),
  ('Karachi', 'Bahadurabad Chowrangi',   array['bahadurabad chorangi'],                                                   24.8790, 67.0680),
  ('Karachi', 'Dhoraji Colony',          array['dhoraji','dhoraji colony'],                                               24.8830, 67.0640),
  ('Karachi', 'Soldier Bazaar',          array['soldier bazaar','soldier bazar'],                                         24.8720, 67.0250),
  ('Karachi', 'Kharadar',                array['kharadar','khara dar'],                                                   24.8500, 66.9950),
  ('Karachi', 'Mithadar',                array['mithadar','mitha dar'],                                                   24.8530, 66.9990),
  ('Karachi', 'Ranchore Line',           array['ranchore line','ranchor line'],                                           24.8640, 67.0100),
  ('Karachi', 'Jamshed Road',            array['jamshed road','jamshed quarters'],                                        24.8790, 67.0400),
  ('Karachi', 'KDA Scheme 1',            array['kda 1','kda scheme 1'],                                                   24.8900, 67.0700),

  -- ---- North-west / Orangi / SITE belt ----
  ('Karachi', 'Orangi Town',             array['orangi','orangi town'],                                                   24.9500, 66.9880),
  ('Karachi', 'SITE Area',               array['site','site area','site industrial'],                                     24.9080, 66.9980),
  ('Karachi', 'Surjani Town',            array['surjani','surjani town'],                                                 25.0350, 67.0500),
  ('Karachi', 'Taiser Town',             array['taiser','taiser town'],                                                   25.0600, 67.0300),
  ('Karachi', 'Naya Nazimabad',          array['naya nazimabad','new nazimabad'],                                         24.9600, 67.0250),

  -- ---- Northern / Super Highway growth belt ----
  ('Karachi', 'Scheme 45',               array['scheme 45'],                                                              25.0200, 67.2000),
  ('Karachi', 'Sadaf Society',           array['sadaf','sadaf society'],                                                  24.9350, 67.1450),
  ('Karachi', 'Yaseenabad',              array['yaseenabad','yasinabad'],                                                 24.9330, 67.0680),
  ('Karachi', 'Shadman Town',            array['shadman','shadman town'],                                                 24.9800, 67.0620),
  ('Karachi', 'Sakhi Hassan',            array['sakhi hassan','sakhi hasan'],                                             24.9500, 67.0400)
)
insert into public.novax_areas (city, name, aliases, lat, lng)
select i.city, i.name, i.aliases, i.lat::numeric, i.lng::numeric
  from incoming i
 where not exists (
   select 1 from public.novax_areas a
    where a.city = i.city and lower(a.name) = lower(i.name)
 );


-- ============================================================================
-- 2. Cleanup: drop rows duplicating an existing area under a different name,
--    and backfill harbour_side on the rows this script added.
-- ============================================================================
delete from public.novax_areas
 where city = 'Karachi' and harbour_side is null
   and name in (
     'Bin Qasim Town',             -- existing: Bin Qasim
     'Karachi Cantt',              -- existing: Cantt Station
     'Garden East',                -- existing: Garden
     'Gulshan-e-Iqbal Block 2',    -- existing: Gulshan Block 2
     'Gulshan-e-Iqbal Block 6',    -- existing: Gulshan Block 6
     'Gulshan-e-Iqbal Block 13-D', -- existing: Gulshan Block 13
     'Malir Cantt',                -- existing: Malir
     'Gulshan-e-Iqbal Block 1',    -- existing: Gulshan-e-Iqbal
     'Gulistan-e-Jauhar Block 1'   -- existing: Gulistan-e-Johar
   );

-- 'boat basin' belongs to the existing Boat Basin row, not to Clifton Block 4.
update public.novax_areas
   set aliases = array_remove(aliases, 'boat basin')
 where city = 'Karachi' and name = 'Clifton Block 4';

update public.novax_areas set harbour_side = 'south_east'
 where city = 'Karachi' and harbour_side is null
   and (name like 'DHA%' or name like 'Clifton%' or name like 'Korangi%'
        or name in ('Quaidabad','Shah Faisal Colony','Model Colony','Landhi'));

update public.novax_areas set harbour_side = 'west'
 where city = 'Karachi' and harbour_side is null
   and name in ('Orangi Town','SITE Area','Baldia Town','Manghopir','Lyari','Kharadar','Mithadar');


-- ============================================================================
-- 3. Verify
-- ============================================================================
-- select count(*) from public.novax_areas where city = 'Karachi' and active;
-- select name, aliases, harbour_side from public.novax_areas
--  where city = 'Karachi' and active order by name;
--
-- Duplicate-alias check -- should return no rows:
-- select a.name, b.name, a.aliases && b.aliases as shared
--   from public.novax_areas a join public.novax_areas b
--     on a.city = b.city and a.id < b.id
--  where a.city = 'Karachi' and a.aliases && b.aliases;
--
-- REMAINING MANUAL STEP: adding areas makes them selectable but does not
-- assign anyone a pickup area. Clients still unmapped must be assigned in
-- Admin > Dashboard > Distance Pricing (Karachi) > coverage panel, or their
-- bookings still get no distance quote.
--
-- Coordinates here are approximate (good enough for picker selection).
-- Replace them with surveyed values for any area you actually bill distance on.
