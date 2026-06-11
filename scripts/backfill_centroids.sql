-- scripts/backfill_centroids.sql
--
-- One-time repair: parcels loaded before the current TCAD loader were
-- inserted without a centroid, and the zoning spatial join (pass 1) matches
-- on st_contains(zoning.geom, parcels.centroid) — a null centroid silently
-- matches nothing. Backfill ST_PointOnSurface for every parcel missing one.
--
-- How to run:
--   1. Paste this entire file in the SQL Editor, click Run.
--      (~370k ST_PointOnSurface computations + gist index updates; expect a
--      few minutes. statement_timeout is lifted below.)
--   2. Verify null_centroids = 0 in the result.
--   3. Re-run scripts/apply_zoning_to_parcels.sql to redo the zoning join
--      (it resets itself and resweeps all parcels).
--
-- If your SQL editor kills the long single UPDATE, run this batched variant
-- repeatedly until it reports 0 rows updated:
--
--   update public.parcels p
--   set centroid = st_pointonsurface(geom)
--   where parcel_id in (
--     select parcel_id from public.parcels
--     where centroid is null
--     limit 50000
--   );

set statement_timeout = 0;

update public.parcels
set centroid = st_pointonsurface(geom)
where centroid is null;

select count(*) as total,
       count(*) filter (where centroid is null) as null_centroids
from public.parcels;
