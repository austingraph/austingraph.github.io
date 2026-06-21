-- parcel_demographics(p_parcel_id) → jsonb
-- Returns a zoning-contextual demographic profile for a parcel by joining
-- the parcel centroid to census_blocks (2020 Decennial) and
-- census_block_groups (ACS 2022 5-year).
--
-- The `lens` field tells the frontend which profile framing to use:
--   residential → who lives here (SF-* zoning)
--   rental      → renter demand context (MF-* zoning)
--   commercial  → trade area / consumer profile (GR/CS/LR etc.)
--   workforce   → labor shed context (IP/LI/industrial/other)
--
-- Run after census_schema.sql and after ingest_census.py has loaded data.

create or replace function public.parcel_demographics(p_parcel_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_geom   geometry;
  v_ctr    geometry;
  v_zbase  text;
  v_lens   text;
  v_bg     record;
  v_blk    record;
  v_cost_b numeric;
  v_total  integer;
begin
  -- Fetch parcel geometry + precomputed zoning base (same source as compute_envelope)
  select geom, zoning_base into v_geom, v_zbase
  from parcels where parcel_id = p_parcel_id;
  if not found then
    return jsonb_build_object('status', 'not_found', 'parcel_id', p_parcel_id);
  end if;

  v_ctr := st_centroid(v_geom);

  -- Map zoning → lens
  v_lens := case
    when v_zbase like 'SF-%' or v_zbase like 'RR%' or v_zbase = 'SF' then 'residential'
    when v_zbase like 'MF-%' or v_zbase = 'MF'                        then 'rental'
    when v_zbase in ('LR','GR','CS','CS-1','CR','GO','W','CH','CBD',
                     'DMU','TOD-NP','TOD-UC','TOD-MU')                 then 'commercial'
    else 'workforce'
  end;

  -- Point-in-polygon → block group (ACS socioeconomic data)
  select * into v_bg
  from census_block_groups
  where st_within(v_ctr, geom)
  limit 1;

  if not found then
    return jsonb_build_object(
      'status',      'no_census',
      'parcel_id',   p_parcel_id,
      'zoning_base', v_zbase,
      'lens',        v_lens
    );
  end if;

  -- Point-in-polygon → block (Decennial headcounts)
  select * into v_blk
  from census_blocks
  where st_within(v_ctr, geom)
  limit 1;

  -- Compute renter cost-burden share (% of renters paying 30%+)
  -- B25070: _007 30-34.9%, _008 35-39.9%, _009 40-49.9%, _010 50%+
  -- stored already as cost_burden_pct in the table

  -- Total population for context (block is more precise than block group)
  v_total := coalesce(v_blk.total_pop, null);

  return jsonb_strip_nulls(jsonb_build_object(
    'status',             'ok',
    'parcel_id',          p_parcel_id,
    'zoning_base',        v_zbase,
    'lens',               v_lens,
    'geoid_block_group',  v_bg.geoid,
    'geoid_block',        v_blk.geoid,
    'acs_vintage',        v_bg.acs_vintage,
    -- Block-level headcounts (2020 Decennial)
    'total_pop',          v_blk.total_pop,
    'housing_units',      v_blk.housing_units,
    -- Block-group ACS: housing tenure
    'owner_occ',          v_bg.owner_occ,
    'renter_occ',         v_bg.renter_occ,
    'owner_pct',          case when (v_bg.owner_occ + v_bg.renter_occ) > 0
                          then round(100.0 * v_bg.owner_occ / (v_bg.owner_occ + v_bg.renter_occ))
                          end,
    'renter_pct',         case when (v_bg.owner_occ + v_bg.renter_occ) > 0
                          then round(100.0 * v_bg.renter_occ / (v_bg.owner_occ + v_bg.renter_occ))
                          end,
    -- Income & rent
    'median_hh_income',   case when v_bg.median_hh_income > 0 then v_bg.median_hh_income end,
    'median_gross_rent',  case when v_bg.median_gross_rent > 0 then v_bg.median_gross_rent end,
    'cost_burden_pct',    v_bg.cost_burden_pct,
    -- Age
    'median_age',         v_bg.median_age,
    'youth_pct',          v_bg.youth_pct,
    'senior_pct',         v_bg.senior_pct,
    'prime_pct',          v_bg.prime_pct,
    -- Race / ethnicity
    'white_pct',          v_bg.white_pct,
    'black_pct',          v_bg.black_pct,
    'hispanic_pct',       v_bg.hispanic_pct,
    'asian_pct',          v_bg.asian_pct,
    -- Commute
    'transit_pct',        v_bg.transit_pct
  ));

exception when others then
  return jsonb_build_object(
    'status',    'error',
    'parcel_id', p_parcel_id,
    'message',   sqlerrm
  );
end;
$$;

grant execute on function public.parcel_demographics(text) to anon, authenticated;
