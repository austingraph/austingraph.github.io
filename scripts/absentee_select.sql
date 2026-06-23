-- scripts/absentee_select.sql
--
-- Backs the "Out-of-state owned" parcel highlight in the map-tools panel
-- (frontend: absentee_overlay.js). Selects parcels whose TCAD owner mailing
-- state is set and not Texas — an absentee / out-of-state-investor signal.
-- Both pieces are anon-readable and mirror scripts/flum_map_select.sql:
--
--   1. public.parcel_absentee_count — single count for the checkbox label.
--   2. public.absentee_select_geojson(p_limit) — the selected parcels as a
--      GeoJSON FeatureCollection with server-simplified geometry, so the map
--      can highlight them WITHOUT owner columns being baked into the PMTiles.
--      Geometry is simplified to ~2 m and the result is capped.
--
-- Note: owner NAMES are never exposed by the site; only the mailing-state code
-- (a derived signal) leaves the database here.
--
-- Idempotent: safe to re-run.

set statement_timeout = 0;

-- ── Count for the checkbox label ──────────────────────────────────────────────
create or replace view public.parcel_absentee_count
with (security_invoker = true) as
  select count(*)::int as n
  from public.parcels
  where appr_owner_state is not null and appr_owner_state <> 'TX';

grant select on public.parcel_absentee_count to anon, authenticated;

-- ── Selected parcels as simplified GeoJSON ────────────────────────────────────
create or replace function public.absentee_select_geojson(
  p_limit int default 25000
)
returns jsonb
language sql
stable
as $$
  with sel as (
    select parcel_id, appr_owner_state, geom
    from public.parcels
    where appr_owner_state is not null and appr_owner_state <> 'TX'
    limit greatest(p_limit, 0)
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'Feature',
      'id', parcel_id,
      'properties', jsonb_build_object(
        'parcel_id',        parcel_id,
        'appr_owner_state', appr_owner_state),
      'geometry', st_asgeojson(
        st_simplifypreservetopology(geom, 0.00002), 6)::jsonb
    )), '[]'::jsonb)
  )
  from sel;
$$;

grant execute on function public.absentee_select_geojson(int) to anon, authenticated;
