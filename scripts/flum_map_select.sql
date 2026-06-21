-- scripts/flum_map_select.sql
--
-- Backs the "Future land use" parcel selector in the Overlays menu (frontend:
-- flum_overlay.js). Two pieces, both anon-readable:
--
--   1. public.parcel_flum_counts  — one row per future-land-use category with a
--      parcel count and an upzoning-candidate count, to populate the category
--      checkbox list (mirrors the parcel_zoning_bases view used by filters.js).
--
--   2. public.flum_select_geojson(p_flum_codes int[], p_upzoning_only boolean)
--      — returns the selected parcels as a GeoJSON FeatureCollection with
--      server-simplified geometry, so the map can highlight them WITHOUT the
--      FLUM columns being baked into the PMTiles. Geometry is simplified to
--      ~2 m and the result is capped so a huge category can't return a payload
--      that stalls the browser.
--
-- Idempotent: safe to re-run.

set statement_timeout = 0;

-- ── Category counts for the checkbox list ─────────────────────────────────────
create or replace view public.parcel_flum_counts
with (security_invoker = true) as
  select p.flum_code,
         c.label,
         c.intensity_rank,
         count(*)::int                                   as n,
         count(*) filter (where p.upzoning_flag)::int    as upzoning_n
  from public.parcels p
  join public.flum_categories c on c.code = p.flum_code
  where p.flum_code is not null
  group by p.flum_code, c.label, c.intensity_rank;

grant select on public.parcel_flum_counts to anon, authenticated;

-- ── Selected parcels as simplified GeoJSON ────────────────────────────────────
-- Pass an array of FLUM codes and/or p_upzoning_only=true; a parcel is included
-- if it matches the code set OR (when requested) is an upzoning candidate.
create or replace function public.flum_select_geojson(
  p_flum_codes    int[]   default null,
  p_upzoning_only boolean default false,
  p_limit         int     default 25000
)
returns jsonb
language sql
stable
as $$
  with sel as (
    select parcel_id, flum_code, flum_label, upzoning_gap, upzoning_flag, geom
    from public.parcels
    where (p_flum_codes is not null and flum_code = any (p_flum_codes))
       or (p_upzoning_only and upzoning_flag)
    limit greatest(p_limit, 0)
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'Feature',
      'id', parcel_id,
      'properties', jsonb_build_object(
        'parcel_id',     parcel_id,
        'flum_code',     flum_code,
        'flum_label',    flum_label,
        'upzoning_gap',  upzoning_gap,
        'upzoning_flag', upzoning_flag),
      'geometry', st_asgeojson(
        st_simplifypreservetopology(geom, 0.00002), 6)::jsonb
    )), '[]'::jsonb)
  )
  from sel;
$$;

grant execute on function public.flum_select_geojson(int[], boolean, int)
  to anon, authenticated;
