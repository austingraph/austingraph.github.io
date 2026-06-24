-- scripts/redev_candidates.sql
--
-- Backs the "Redevelopment finder" in the map-tools panel (frontend:
-- redev_finder.js). Ranks parcels by redevelopment / teardown potential from
-- data already in public.parcels — no new sources needed:
--   • land share of value  (appr_land_val / appr_market_val) — a high share means
--     the building contributes little, so the value is in the land (teardown).
--   • improvement age       (appr_data_yr - appr_yr_built)    — older = more likely.
--   • upzoning gap          (upzoning_gap)                    — entitlement upside.
-- Vacant land (no improvement value) scores as pure land.
--
-- Two anon-readable pieces, mirroring scripts/flum_map_select.sql:
--   1. public.redev_candidates_geojson(...) — top-N scored parcels as a GeoJSON
--      FeatureCollection (server-simplified geometry) for map highlight + CSV.
--   2. public.redev_candidate_count(...)    — count for the given filters.
--
-- Idempotent: safe to re-run.

set statement_timeout = 0;

-- Shared scoring expression as an inlined SQL helper (0–100 composite).
create or replace function public.redev_score(
  p_market bigint, p_land bigint, p_impr bigint,
  p_yr_built smallint, p_data_yr smallint, p_upzoning_gap int
)
returns numeric
language sql
immutable
as $$
  with v as (
    select
      least(coalesce(p_land,0)::numeric / nullif(p_market,0), 1.0)          as land_share,
      case when p_yr_built is null then 1.0   -- vacant / unknown = treat as old
           else least(greatest((coalesce(p_data_yr,2026) - p_yr_built), 0) / 80.0, 1.0)
      end                                                                    as age_frac,
      least(coalesce(p_upzoning_gap,0), 5) / 5.0                             as up_frac
  )
  select round(100 * (0.45 * land_share + 0.30 * age_frac + 0.25 * up_frac), 1)
  from v;
$$;

grant execute on function public.redev_score(bigint, bigint, bigint, smallint, smallint, int)
  to anon, authenticated;

-- ── Candidate count (for the panel label) ─────────────────────────────────────
create or replace function public.redev_candidate_count(
  p_min_land_share numeric default 0.5,
  p_built_before   int     default 1990,
  p_upzoning_only  boolean default false,
  p_zoning_prefix  text    default null
)
returns int
language sql
stable
as $$
  select count(*)::int
  from public.parcels
  where appr_market_val is not null and appr_market_val > 0
    and (coalesce(appr_land_val,0)::numeric / nullif(appr_market_val,0)) >= p_min_land_share
    and (appr_yr_built is null or appr_yr_built <= p_built_before)
    and (not p_upzoning_only or upzoning_flag)
    and (p_zoning_prefix is null or zoning_base like p_zoning_prefix || '%');
$$;

grant execute on function public.redev_candidate_count(numeric, int, boolean, text)
  to anon, authenticated;

-- ── Ranked candidates as simplified GeoJSON ───────────────────────────────────
create or replace function public.redev_candidates_geojson(
  p_min_land_share numeric default 0.5,
  p_built_before   int     default 1990,
  p_upzoning_only  boolean default false,
  p_zoning_prefix  text    default null,
  p_limit          int     default 5000
)
returns jsonb
language sql
stable
as $$
  with sel as (
    select
      parcel_id,
      metadata->>'situs_address'                                    as address,
      zoning_base,
      appr_market_val, appr_land_val, appr_impr_val, appr_yr_built,
      upzoning_gap,
      round(coalesce(appr_land_val,0)::numeric / nullif(appr_market_val,0), 3) as land_share,
      public.redev_score(appr_market_val, appr_land_val, appr_impr_val,
                         appr_yr_built, appr_data_yr, upzoning_gap)  as score,
      geom
    from public.parcels
    where appr_market_val is not null and appr_market_val > 0
      and (coalesce(appr_land_val,0)::numeric / nullif(appr_market_val,0)) >= p_min_land_share
      and (appr_yr_built is null or appr_yr_built <= p_built_before)
      and (not p_upzoning_only or upzoning_flag)
      and (p_zoning_prefix is null or zoning_base like p_zoning_prefix || '%')
    order by score desc
    limit greatest(p_limit, 0)
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'Feature',
      'id', parcel_id,
      'properties', jsonb_build_object(
        'parcel_id',    parcel_id,
        'address',      address,
        'zoning_base',  zoning_base,
        'market_val',   appr_market_val,
        'land_val',     appr_land_val,
        'impr_val',     appr_impr_val,
        'land_share',   land_share,
        'yr_built',     appr_yr_built,
        'upzoning_gap', upzoning_gap,
        'score',        score),
      'geometry', st_asgeojson(
        st_simplifypreservetopology(geom, 0.00002), 6)::jsonb
    )), '[]'::jsonb)
  )
  from sel;
$$;

grant execute on function public.redev_candidates_geojson(numeric, int, boolean, text, int)
  to anon, authenticated;
