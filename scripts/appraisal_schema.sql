-- scripts/appraisal_schema.sql
--
-- Adds TCAD appraisal roll columns to public.parcels so a single-row SELECT
-- returns all financial data without a join at read time.
-- Populated by: scripts/ingest/load_tcad_appraisal.py (run locally, annually).
--
-- Idempotent: safe to re-run.

alter table public.parcels
  add column if not exists appr_market_val   bigint,       -- total market value (land + impr); bigint: large parcels exceed $2.1B int max
  add column if not exists appr_land_val     bigint,       -- land value only
  add column if not exists appr_impr_val     bigint,       -- improvement (building) value
  add column if not exists appr_appraised_val bigint,      -- appraised value (post-cap, pre-exemption)
  add column if not exists appr_assessed_val bigint,       -- after 10% homestead cap
  add column if not exists appr_taxable_val  bigint,       -- assessed_val (exemption amounts vary by entity)
  add column if not exists appr_cap_loss     bigint,       -- homestead 10% cap loss (market − appraised); equity/tenure signal
  add column if not exists appr_exemptions   text[],       -- e.g. '{HS,OV65}'
  add column if not exists appr_yr_built     smallint,     -- year improvements built
  add column if not exists appr_living_sqft  bigint,       -- finished floor area (sq ft); excludes garage/porch/etc.
  add column if not exists appr_class        text,         -- construction class/quality of the main improvement
  add column if not exists appr_neighborhood text,         -- TCAD mass-appraisal neighborhood code (hood_cd)
  add column if not exists appr_state_cd     text,         -- PTAD state category (A1 single-fam, B multifam, C vacant, F commercial, …)
  add column if not exists appr_land_sqft    bigint,       -- land-segment size in SQUARE FEET (authoritative lot size; bigint for large tracts)
  add column if not exists appr_deed_date    date,         -- last recorded deed date (transfer signal; NOT a sale price)
  add column if not exists appr_owner_name   text,         -- owner name as of Jan 1
  add column if not exists appr_owner_state  text,         -- owner mailing state ('TX' vs other)
  add column if not exists appr_data_yr      smallint;     -- roll year (2025, 2026, …)

-- If the columns were already created as int (first schema version), widen them.
-- No-op if they are already bigint.
alter table public.parcels
  alter column appr_market_val   type bigint,
  alter column appr_land_val     type bigint,
  alter column appr_impr_val     type bigint,
  alter column appr_assessed_val type bigint,
  alter column appr_taxable_val  type bigint,
  alter column appr_living_sqft  type bigint,
  alter column appr_land_sqft    type bigint;

comment on column public.parcels.appr_market_val   is 'TCAD market value (land + improvements)';
comment on column public.parcels.appr_appraised_val is 'Appraised value: market value after caps (10% homestead, ag productivity), before exemptions';
comment on column public.parcels.appr_assessed_val is 'Assessed value after 10% homestead cap; before dollar-amount exemptions';
comment on column public.parcels.appr_taxable_val  is 'Proxy for taxable value (= assessed_val); actual varies by taxing entity';
comment on column public.parcels.appr_cap_loss     is 'Homestead 10% cap loss (market − appraised); larger = longer-held / more suppressed below market';
comment on column public.parcels.appr_exemptions   is 'Exemption codes: HS, OV65, DP, VET, AG, AB, EX';
comment on column public.parcels.appr_living_sqft  is 'Finished floor area (sq ft); excludes garage/porch/etc. Use for building $/sqft';
comment on column public.parcels.appr_neighborhood is 'TCAD mass-appraisal neighborhood code (hood_cd); the truest comp cohort';
comment on column public.parcels.appr_state_cd     is 'PTAD state category code (A1, B, C1, F1, …) — land-use classification';
comment on column public.parcels.appr_deed_date    is 'Last recorded deed date — a transfer (not sale-price) signal; Texas is non-disclosure';
comment on column public.parcels.appr_owner_state  is '2-char state of owner mailing address; TX = local, other = absentee';

-- Year-over-year value history (Phase C — value trends). Populated per roll year
-- by load_tcad_appraisal.py / the historical EARS loader.
create table if not exists public.parcel_appraisal_history (
  parcel_id     text       not null references public.parcels(parcel_id) on delete cascade,
  yr            smallint   not null,
  market_val    bigint,
  land_val      bigint,
  impr_val      bigint,
  appraised_val bigint,
  assessed_val  bigint,
  taxable_val   bigint,
  cap_loss      bigint,
  primary key (parcel_id, yr)
);
-- Widen / add columns if the table predates this revision (no-op otherwise).
alter table public.parcel_appraisal_history
  add column if not exists land_val      bigint,
  add column if not exists impr_val      bigint,
  add column if not exists appraised_val bigint,
  add column if not exists cap_loss      bigint;
alter table public.parcel_appraisal_history enable row level security;
-- CREATE POLICY has no IF NOT EXISTS in Postgres, so guard it (idempotent re-runs).
do $$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'parcel_appraisal_history'
       and policyname = 'anon read'
  ) then
    create policy "anon read" on public.parcel_appraisal_history
      for select using (true);
  end if;
end $$;
grant select on public.parcel_appraisal_history to anon, authenticated;
