-- Census demographic tables for austingraph.chat
-- Run once in Supabase SQL editor (or via psql) before ingest_census.py.

-- 2020 Decennial DHC — block level (16,906 blocks in Travis County)
-- Headcount data only: population, housing occupancy, basic race/ethnicity
create table if not exists public.census_blocks (
  geoid          text primary key,               -- 15-digit FIPS (state+county+tract+block)
  geom           geometry(MultiPolygon, 4326) not null,
  total_pop      integer,
  housing_units  integer,
  occupied_units integer,
  vacant_units   integer,
  pop_white      integer,
  pop_black      integer,
  pop_hisp       integer,
  pop_asian      integer
);

create index if not exists census_blocks_geom_idx on public.census_blocks using gist(geom);

-- ACS 5-year (2022) — block group level (~700 block groups in Travis County)
-- Socioeconomic variables: income, tenure, rent, cost burden, age, race, commute
create table if not exists public.census_block_groups (
  geoid                text primary key,          -- 12-digit FIPS (state+county+tract+bg)
  geom                 geometry(MultiPolygon, 4326) not null,
  acs_vintage          smallint not null,         -- e.g. 2022 for ACS 2022 5-year
  -- Housing tenure (B25003)
  owner_occ            integer,
  renter_occ           integer,
  -- Income (B19013)
  median_hh_income     integer,
  -- Rent (B25064)
  median_gross_rent    integer,
  -- Cost burden (B25070): renters paying 30%+ of income
  cost_burden_pct      numeric(5,1),
  -- Age (B01001 + B01002)
  median_age           numeric(4,1),
  youth_pct            numeric(5,1),              -- under 18
  senior_pct           numeric(5,1),              -- 65+
  prime_pct            numeric(5,1),              -- 25–64
  -- Race/ethnicity (B03002)
  white_pct            numeric(5,1),
  black_pct            numeric(5,1),
  hispanic_pct         numeric(5,1),
  asian_pct            numeric(5,1),
  -- Commute (B08301): public transit + walk + bike + WFH
  transit_pct          numeric(5,1)
);

create index if not exists census_bg_geom_idx on public.census_block_groups using gist(geom);

-- Allow anonymous reads via PostgREST (matches pattern of other tables)
grant select on public.census_blocks      to anon, authenticated;
grant select on public.census_block_groups to anon, authenticated;
