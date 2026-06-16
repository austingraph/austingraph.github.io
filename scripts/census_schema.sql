-- Census block and block-group tables for demographic profiles.
-- Run once in Supabase SQL editor before running ingest_census.py.
-- Data sources:
--   Block groups: ACS 2022 5-year + TIGER/Line cartographic boundary
--   Blocks:       2020 Decennial DHC + TIGERweb REST API

-- ── Block groups (ACS 5-year, ~700 in Travis County) ────────────────────────

create table if not exists public.census_block_groups (
  geoid               text primary key,           -- 12-digit FIPS
  geom                geometry(MultiPolygon, 4326) not null,
  acs_vintage         smallint not null,           -- e.g. 2022
  -- Housing tenure (B25003)
  owner_occ           integer,
  renter_occ          integer,
  -- Income (B19013)
  median_hh_income    integer,
  -- Rent (B25064)
  median_gross_rent   integer,
  -- Cost burden (B25070): renter households paying 30%+ of income on housing
  cost_burden_pct     numeric(5,1),
  -- Age (B01001)
  median_age          numeric(4,1),
  youth_pct           numeric(5,1),               -- under 18
  senior_pct          numeric(5,1),               -- 65+
  prime_pct           numeric(5,1),               -- 25–64
  -- Race / ethnicity (B03002 — "alone or in combination" for multiracial)
  white_pct           numeric(5,1),               -- non-Hispanic white
  black_pct           numeric(5,1),
  hispanic_pct        numeric(5,1),
  asian_pct           numeric(5,1),
  -- Commute (B08301)
  transit_pct         numeric(5,1)                -- transit + walk + bike
);

create index if not exists census_block_groups_geom_idx
  on public.census_block_groups using gist(geom);

-- ── Blocks (2020 Decennial DHC, ~16k in Travis County) ──────────────────────

create table if not exists public.census_blocks (
  geoid           text primary key,               -- 15-digit FIPS
  geom            geometry(MultiPolygon, 4326) not null,
  total_pop       integer,
  housing_units   integer,                        -- H1_001N (total units)
  -- Race / Hispanic origin (P1 + P9 tables from 2020 DHC)
  pop_white       integer,
  pop_black       integer,
  pop_hisp        integer,
  pop_asian       integer
);

create index if not exists census_blocks_geom_idx
  on public.census_blocks using gist(geom);

-- Grant anon read for PostgREST (not strictly needed since access is via RPC only)
grant select on public.census_block_groups to anon, authenticated;
grant select on public.census_blocks       to anon, authenticated;
