-- scripts/parcel_value_context.sql
-- RPC: public.parcel_value_context(p_parcel_id text) -> jsonb
--
-- Phase B of the "value representation" work. Returns a parcel's building and
-- land $/sqft together with where each ranks among the NEAREST same-zoning
-- parcels (a PostGIS KNN cohort). This is the "honest comps" substitute for
-- sale prices, which Texas (a non-disclosure state) does not make public.
--
-- Cohort = the up-to-300 nearest parcels sharing this parcel's TCAD neighborhood
-- (hood_cd / appr_neighborhood), ordered by centroid distance (uses the
-- parcels_centroid_idx GIST KNN index). Falls back to zoning_base when the
-- neighborhood isn't populated yet. Percentile is the share of the cohort at or
-- below this parcel's $/sqft (higher = pricier than its neighbors).
--
-- NOTE: re-run this after load_tcad_appraisal.py populates appr_neighborhood /
-- appr_land_sqft so the neighborhood cohort + authoritative lot sizes take effect.
--
-- Run once in the Supabase SQL editor. Safe to re-run (create or replace).
-- Mirrors the security pattern of public.parcel_demographics.

create or replace function public.parcel_value_context(p_parcel_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ctr     geometry;
  v_zoning  text;
  v_hood    text;
  v_land    bigint;
  v_impr    bigint;
  v_sqft    int;
  v_lotsqft numeric;
  v_bpsf    numeric;
  v_lpsf    numeric;
  v_basis   text;
  v_bldg    jsonb := null;
  v_landj   jsonb := null;
  v_limit   int   := 300;     -- nearest-N comparables
begin
  -- Target parcel: centroid, zoning, TCAD neighborhood, value parts, and lot size
  -- (land-segment acres if present, else TCAD acres, else the geodesic polygon area).
  select centroid, zoning_base, appr_neighborhood, appr_land_val, appr_impr_val, appr_living_sqft,
         coalesce(nullif(appr_land_sqft, 0),
                  nullif((metadata->>'tcad_acres')::numeric, 0) * 43560,
                  nullif(st_area(geom::geography) * 10.7639104, 0))
    into v_ctr, v_zoning, v_hood, v_land, v_impr, v_sqft, v_lotsqft
    from public.parcels
   where parcel_id = p_parcel_id;

  -- Cohort basis: prefer TCAD's mass-appraisal neighborhood (truest comps);
  -- fall back to zoning until the appraisal re-load populates neighborhoods.
  v_basis := case when coalesce(v_hood, '') <> '' then 'neighborhood ' || v_hood
                  else 'zoning ' || coalesce(v_zoning, '(none)') end;

  if v_ctr is null then
    return jsonb_build_object('status', 'error',
                              'message', 'parcel not found or missing centroid');
  end if;

  -- Building $/sqft vs the nearest same-zoning parcels that have a building.
  if coalesce(v_impr, 0) > 0 and coalesce(v_sqft, 0) > 0 then
    v_bpsf := v_impr::numeric / v_sqft;
    with cohort as (
      select appr_impr_val::numeric / appr_living_sqft as psf
        from public.parcels
       where case when coalesce(v_hood, '') <> ''
                  then appr_neighborhood is not distinct from v_hood
                  else zoning_base is not distinct from v_zoning end
         and centroid is not null
         and appr_impr_val > 0
         and appr_living_sqft > 0
       order by centroid <-> v_ctr
       limit v_limit
    )
    select jsonb_build_object(
             'value',      round(v_bpsf, 2),
             'percentile', round(100.0 * count(*) filter (where psf <= v_bpsf)
                                  / nullif(count(*), 0)),
             'median',     round(percentile_cont(0.5) within group (order by psf)::numeric, 2),
             'n',          count(*))
      into v_bldg
      from cohort;
  end if;

  -- Land $/sqft vs the nearest same-zoning parcels with a land value + lot size.
  if coalesce(v_land, 0) > 0 and coalesce(v_lotsqft, 0) > 0 then
    v_lpsf := v_land::numeric / v_lotsqft;
    with cohort as (
      select appr_land_val::numeric /
             coalesce(nullif(appr_land_sqft, 0),
                      nullif((metadata->>'tcad_acres')::numeric, 0) * 43560,
                      nullif(st_area(geom::geography) * 10.7639104, 0)) as psf
        from public.parcels
       where case when coalesce(v_hood, '') <> ''
                  then appr_neighborhood is not distinct from v_hood
                  else zoning_base is not distinct from v_zoning end
         and centroid is not null
         and appr_land_val > 0
       order by centroid <-> v_ctr
       limit v_limit
    )
    select jsonb_build_object(
             'value',      round(v_lpsf, 2),
             'percentile', round(100.0 * count(*) filter (where psf is not null and psf <= v_lpsf)
                                  / nullif(count(*) filter (where psf is not null), 0)),
             'median',     round(percentile_cont(0.5) within group (order by psf)::numeric, 2),
             'n',          count(*) filter (where psf is not null))
      into v_landj
      from cohort;
  end if;

  return jsonb_build_object(
    'status',       'ok',
    'parcel_id',    p_parcel_id,
    'zoning_base',  v_zoning,
    'neighborhood', v_hood,
    'cohort',       v_basis,   -- which basis the comps used (neighborhood vs zoning)
    'building_psf', v_bldg,    -- {value, percentile, median, n} or null
    'land_psf',     v_landj);  -- {value, percentile, median, n} or null

exception when others then
  return jsonb_build_object('status', 'error', 'message', sqlerrm);
end $$;

grant execute on function public.parcel_value_context(text) to anon, authenticated;

-- ── Test (optional) ────────────────────────────────────────────────────────────
-- Grab a parcel id that has a building, then call the function:
--   select parcel_id from public.parcels
--    where appr_impr_val > 0 and appr_living_sqft > 0 limit 1;
--   select public.parcel_value_context('PASTE_PARCEL_ID_HERE');
