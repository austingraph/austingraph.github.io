-- scripts/parcel_geojson.sql
--
-- public.parcel_geojson(parcel_id) — returns a parcel's polygon as GeoJSON,
-- exposed to the static frontend via PostgREST RPC (anon, read-only).
--
-- Used by the address-search control (search.js → app.js selectParcelById):
-- when a parcel is selected by address rather than by clicking the map, the
-- frontend has no tile geometry, so it fetches the polygon here to drive the
-- detail-panel dimensions, the gold selection highlight, the camera fly-to, and
-- the parcel-report mini-map.
--
-- Mirrors the geometry output of compute_envelope.sql:
-- st_asgeojson(st_transform(geom, 4326), 7) → a GeoJSON Polygon/MultiPolygon.
--
--   curl -s "$SUPABASE_URL/rest/v1/rpc/parcel_geojson" \
--     -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--     -H "Content-Type: application/json" -d '{"p_parcel_id":"123456"}'

create or replace function public.parcel_geojson(p_parcel_id text)
returns json
language sql
stable
as $$
  select st_asgeojson(st_transform(geom, 4326), 7)::json
    from parcels
   where parcel_id = p_parcel_id;
$$;
