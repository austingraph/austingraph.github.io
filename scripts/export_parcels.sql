-- export_parcels.sql
-- Exports all parcels as newline-delimited GeoJSON for tippecanoe.
-- Run via: psql "$DATABASE_URL" -f scripts/export_parcels.sql
\copy (
  select jsonb_build_object(
    'type',       'Feature',
    'id',         parcel_id,
    'geometry',   st_asgeojson(geom)::jsonb,
    'properties', jsonb_build_object('parcel_id', parcel_id)
  )
  from public.parcels
) to '/tmp/parcels.ndjson'
