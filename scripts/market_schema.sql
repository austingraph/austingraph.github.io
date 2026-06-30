-- ═══════════════════════════════════════════════════════════════════════════
-- market_schema.sql — neighborhood market context (sale $/sqft + market rent)
-- ═══════════════════════════════════════════════════════════════════════════
-- Texas is a non-disclosure state, so there are no public per-parcel sale
-- prices. As a defensible proxy we load free AGGREGATE market data keyed by ZIP:
--   • Redfin Data Center  → median sale price per sqft  (median_sale_ppsf)
--   • Zillow ZORI         → typical observed market rent (zori_rent)
-- load_market_context.py spatial-joins each parcel's centroid to a ZIP polygon
-- (parcels.zip) and upserts market_context. The RPC below joins a parcel → ZIP →
-- market row so the report/feasibility tool can seed Sale-price and Rent defaults.
--
-- Applied automatically by .github/workflows/load_market_data.yml before the load.

-- Title: Per-ZIP market context table (source of truth)
create table if not exists public.market_context (
  zip               text primary key,
  median_sale_ppsf  numeric,     -- Redfin median sale $/sqft (All Residential)
  median_sale_price bigint,      -- Redfin median sale price
  zori_rent         numeric,     -- Zillow Observed Rent Index ($/mo, typical home)
  redfin_period     date,        -- month the Redfin figures cover
  zori_period       date,        -- month the ZORI figure covers
  updated_at        timestamptz default now()
);

-- Title: Public (anon) read access to market_context
alter table public.market_context enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'market_context'
       and policyname = 'market_context anon read'
  ) then
    create policy "market_context anon read" on public.market_context
      for select to anon using (true);
  end if;
end $$;
grant select on public.market_context to anon, authenticated;

-- Title: ZIP column on parcels (set by the loader's centroid-in-ZIP join)
alter table public.parcels add column if not exists zip text;
create index if not exists parcels_zip_idx on public.parcels (zip);

-- Title: parcel_market_context(parcel_id) — parcel → ZIP → market row
create or replace function public.parcel_market_context(p_parcel_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object(
       'status',            'ok',
       'zip',               m.zip,
       'median_sale_ppsf',  m.median_sale_ppsf,
       'median_sale_price', m.median_sale_price,
       'zori_rent',         m.zori_rent,
       'redfin_period',     m.redfin_period,
       'zori_period',       m.zori_period)
       from public.parcels p
       join public.market_context m on m.zip = p.zip
      where p.parcel_id = p_parcel_id),
    jsonb_build_object('status', 'no_data'));
$$;
grant execute on function public.parcel_market_context(text) to anon, authenticated;
