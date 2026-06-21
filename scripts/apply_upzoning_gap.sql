-- scripts/apply_upzoning_gap.sql  (Phase 2)
--
-- Precomputes parcels.upzoning_gap / upzoning_flag: the difference between the
-- FLUM's intended development intensity and the parcel's current zoning
-- intensity. A positive gap means the City's adopted Future Land Use Map
-- intends MORE intensity than the parcel is zoned for today — i.e. a candidate
-- for rezoning / redevelopment. This is the monetizable signal layered on top
-- of the planning-context panel.
--
--   upzoning_gap  = flum_intensity_rank - zoning_intensity_rank
--   upzoning_flag = (upzoning_gap > 0)
--
-- Both ranks come from the editorial scales seeded in scripts/flum_schema.sql
-- (flum_categories.intensity_rank, zoning_intensity.intensity_rank). Parcels
-- missing either rank (no FLUM, unranked district, or a non-comparable category
-- like Open Space / Civic / PUD) get null gap and null flag — excluded, not
-- flagged.
--
-- Prerequisites:
--   - scripts/apply_flum_to_parcels.sql complete (parcels.flum_code populated)
--   - parcels.zoning_base populated (scripts/apply_zoning_to_parcels.sql)
--
-- How to run:
--   Paste this entire file in the SQL Editor, click Run. Single UPDATE over
--   ~374k parcels on indexed columns; expect a couple of minutes.
--
-- Re-runnable any time the intensity scales are retuned.

set statement_timeout = 0;

update public.parcels p
set upzoning_gap  = fc.intensity_rank - zi.intensity_rank,
    upzoning_flag = (fc.intensity_rank - zi.intensity_rank) > 0
from public.flum_categories fc,
     public.zoning_intensity zi
where fc.code     = p.flum_code
  and zi.district = p.zoning_base;

-- Parcels that don't satisfy the join above keep whatever they had; clear any
-- stale values where a rank is now unavailable so the flag never lies.
update public.parcels p
set upzoning_gap  = null,
    upzoning_flag = null
where (p.flum_code is null
       or p.zoning_base is null
       or not exists (select 1 from public.flum_categories fc
                       where fc.code = p.flum_code and fc.intensity_rank is not null)
       or not exists (select 1 from public.zoning_intensity zi
                       where zi.district = p.zoning_base))
  and (p.upzoning_gap is not null or p.upzoning_flag is not null);

-- Verification: distribution of the gap, and the headline candidate count.
select upzoning_gap, count(*)
from public.parcels
where upzoning_gap is not null
group by upzoning_gap
order by upzoning_gap;

select count(*) filter (where upzoning_flag) as upzoning_candidates,
       count(*) filter (where upzoning_gap is not null) as comparable_parcels
from public.parcels;
