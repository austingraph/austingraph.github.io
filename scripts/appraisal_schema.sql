-- scripts/appraisal_schema.sql
--
-- Adds TCAD appraisal roll columns to public.parcels so a single-row SELECT
-- returns all financial data without a join at read time.
-- Populated by: scripts/ingest/load_tcad_appraisal.py (run locally, annually).
--
-- Idempotent: safe to re-run.

alter table public.parcels
  add column if not exists appr_market_val   int,          -- total market value (land + impr)
  add column if not exists appr_land_val     int,          -- land value only
  add column if not exists appr_impr_val     int,          -- improvement (building) value
  add column if not exists appr_assessed_val int,          -- after 10% homestead cap
  add column if not exists appr_taxable_val  int,          -- assessed_val (exemption amounts vary by entity)
  add column if not exists appr_exemptions   text[],       -- e.g. '{HS,OV65}'
  add column if not exists appr_yr_built     smallint,     -- year improvements built
  add column if not exists appr_living_sqft  int,          -- total improvement area (sq ft)
  add column if not exists appr_owner_name   text,         -- owner name as of Jan 1
  add column if not exists appr_owner_state  text,         -- owner mailing state ('TX' vs other)
  add column if not exists appr_data_yr      smallint;     -- roll year (2025, 2026, …)

comment on column public.parcels.appr_market_val   is 'TCAD market value (land + improvements)';
comment on column public.parcels.appr_assessed_val is 'Assessed value after 10% homestead cap; before dollar-amount exemptions';
comment on column public.parcels.appr_taxable_val  is 'Proxy for taxable value (= assessed_val); actual varies by taxing entity';
comment on column public.parcels.appr_exemptions   is 'Exemption codes: HS, OV65, DP, VET, AG, AB, EX';
comment on column public.parcels.appr_owner_state  is '2-char state of owner mailing address; TX = local, other = absentee';

-- Optional history table for year-over-year value trend (Phase 2).
create table if not exists public.parcel_appraisal_history (
  parcel_id    text        not null references public.parcels(parcel_id) on delete cascade,
  yr           smallint    not null,
  market_val   int,
  assessed_val int,
  taxable_val  int,
  primary key (parcel_id, yr)
);
alter table public.parcel_appraisal_history enable row level security;
create policy if not exists "anon read" on public.parcel_appraisal_history
  for select using (true);
grant select on public.parcel_appraisal_history to anon, authenticated;
