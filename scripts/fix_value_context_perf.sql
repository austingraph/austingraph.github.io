-- ═══════════════════════════════════════════════════════════════════════════
-- fix_value_context_perf.sql — stop parcel_value_context() from timing out
-- ═══════════════════════════════════════════════════════════════════════════
-- parcel_value_context() builds a comparable cohort by filtering parcels on
-- appr_neighborhood (TCAD's mass-appraisal neighborhood) and then ordering by
-- centroid distance. There is currently NO index on appr_neighborhood, so every
-- call sequentially scans all ~374k parcels just to find the cohort — which
-- trips the statement timeout (SQLSTATE 57014) on single-family parcels (the
-- $/sqft percentile bars then silently fail to render in the report).
--
-- The btree index below lets the planner pull a neighborhood's parcels directly;
-- ANALYZE refreshes the planner statistics so it actually chooses that path.
--
-- Run once in the Supabase SQL editor (service role). Safe to re-run.
-- Optional cleanup afterward (run on its own, NOT inside a transaction):
--   vacuum analyze public.parcels;

-- Title: Index parcels by TCAD neighborhood (the value-context cohort filter)
create index if not exists parcels_appr_neighborhood_idx
  on public.parcels (appr_neighborhood)
  where appr_neighborhood is not null;

-- Title: Refresh planner statistics on parcels so the new index gets used
analyze public.parcels;
