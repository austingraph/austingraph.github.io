-- scripts/lead_lists.sql
--
-- Sellable lead-list queries built ONLY from data already in public.parcels
-- (TCAD appraisal roll + zoning/FLUM). These are NOT wired into the website —
-- run each query in the Supabase SQL editor and click "Download CSV" to get a
-- one-off list you can clean up and sell.
--
-- Why SQL editor (not the app): these queries return owner names and full
-- candidate lists — the sellable product. They run as your authenticated
-- Supabase role, so the data stays private. Do NOT expose them through the
-- site's public/anon key.
--
-- Each query is self-contained (no views/grants created — nothing persists).
-- Tunable thresholds are marked « EDIT ». TCAD source records are public.

-- ════════════════════════════════════════════════════════════════════════════
-- A. REDEVELOPMENT / TEARDOWN CANDIDATES
--    Buyers: developers, land brokers, flippers.
--    Score 0–100 = 45% land share of value (high = building barely matters)
--                + 30% improvement age (older = more likely teardown; vacant = max)
--                + 25% upzoning gap (entitlement upside).
-- ════════════════════════════════════════════════════════════════════════════
select
  round(100 * (
      0.45 * least(coalesce(appr_land_val, 0)::numeric / nullif(appr_market_val, 0), 1.0)
    + 0.30 * (case when appr_yr_built is null then 1.0
                   else least(greatest((coalesce(appr_data_yr, 2026) - appr_yr_built), 0) / 80.0, 1.0) end)
    + 0.25 * (least(coalesce(upzoning_gap, 0), 5) / 5.0)
  ), 1)                                                                  as redev_score,
  parcel_id,
  metadata->>'situs_address'                                             as situs_address,
  zoning_base,
  appr_market_val                                                        as market_val,
  appr_land_val                                                          as land_val,
  appr_impr_val                                                          as impr_val,
  round(coalesce(appr_land_val, 0)::numeric / nullif(appr_market_val, 0), 3) as land_share,
  appr_yr_built                                                          as year_built,
  upzoning_gap,
  round(st_y(st_centroid(geom))::numeric, 6)                             as latitude,
  round(st_x(st_centroid(geom))::numeric, 6)                             as longitude,
  'https://travis.prodigycad.com/property-detail/' || parcel_id          as tcad_url
from public.parcels
where appr_market_val is not null and appr_market_val > 0
  and (coalesce(appr_land_val, 0)::numeric / nullif(appr_market_val, 0)) >= 0.50  -- « EDIT » min land share (0.50 = 50%)
  and (appr_yr_built is null or appr_yr_built <= 1990)                            -- « EDIT » built on/before, or vacant
  -- and zoning_base like 'SF%'                                                   -- « EDIT » uncomment to limit to single-family
order by redev_score desc;
-- Tip: add `limit 2000;` for a smaller top-tier list.


-- ════════════════════════════════════════════════════════════════════════════
-- B. ABSENTEE / OUT-OF-STATE OWNERS
--    Buyers: wholesalers, agents (direct-mail). Note: only owner mailing STATE
--    is stored, not the full mailing address.
-- ════════════════════════════════════════════════════════════════════════════
select
  parcel_id,
  metadata->>'situs_address'                                    as situs_address,
  appr_owner_name                                               as owner_name,
  appr_owner_state                                              as owner_state,
  zoning_base,
  appr_market_val                                               as market_val,
  appr_land_val                                                 as land_val,
  appr_impr_val                                                 as impr_val,
  appr_yr_built                                                 as year_built,
  round(st_y(st_centroid(geom))::numeric, 6)                    as latitude,
  round(st_x(st_centroid(geom))::numeric, 6)                    as longitude,
  'https://travis.prodigycad.com/property-detail/' || parcel_id as tcad_url
from public.parcels
where appr_owner_state is not null
  and appr_owner_state <> 'TX'
  -- and zoning_base like 'SF%'                                  -- « EDIT » uncomment for SF rentals only
order by appr_market_val desc nulls last;


-- ════════════════════════════════════════════════════════════════════════════
-- C. MISSING HOMESTEAD EXEMPTION (likely owner-occupied, no HS on file)
--    Buyers: exemption-filing services, tax-protest firms.
--    Heuristic: single-family + TX owner + has a building + no 'HS' exemption.
--    (Catches some rentals — they're investor leads either way.)
-- ════════════════════════════════════════════════════════════════════════════
select
  parcel_id,
  metadata->>'situs_address'                                    as situs_address,
  appr_owner_name                                               as owner_name,
  zoning_base,
  appr_market_val                                               as market_val,
  appr_assessed_val                                             as assessed_val,
  round(coalesce(appr_assessed_val, appr_market_val) * 0.02)    as est_annual_tax,  -- « EDIT » ~2% Austin-proper
  appr_yr_built                                                 as year_built,
  appr_living_sqft                                              as living_sqft,
  appr_exemptions                                               as exemptions,
  round(st_y(st_centroid(geom))::numeric, 6)                    as latitude,
  round(st_x(st_centroid(geom))::numeric, 6)                    as longitude,
  'https://travis.prodigycad.com/property-detail/' || parcel_id as tcad_url
from public.parcels
where appr_market_val is not null and appr_market_val > 0
  and zoning_base like 'SF%'                                    -- « EDIT » single-family residential
  and appr_owner_state = 'TX'                                   -- in-state owner = more likely owner-occupied
  and appr_yr_built is not null                                 -- has an actual building
  and (appr_exemptions is null or not (appr_exemptions @> array['HS']))
order by appr_market_val desc;
