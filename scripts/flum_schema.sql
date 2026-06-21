-- scripts/flum_schema.sql
--
-- One-time setup for the Future Land Use Map (FLUM) integration. Run in the
-- Supabase SQL Editor AFTER scripts/zoning_schema.sql.
--
-- FLUM is the City of Austin's *intended* future land use, adopted through
-- neighborhood plans. Unlike Imagine Austin (which is area-level and explicitly
-- "not parcel specific"), the FLUM is granular enough to attach to a parcel by
-- point-in-polygon — the same connector used for zoning. It answers "what does
-- the city WANT here", complementing zoning's "what may be built here".
--
-- Source: City of Austin ArcGIS REST service
--   PropertyProfile/LongRangePlanning/MapServer  layer 4 = Future Land Use Map
-- (~79.8k polygons, field FUTURE_LAND_USE is an integer category code).
--
-- Creates:
--   public.flum             — FLUM polygons
--   public.flum_categories  — FUTURE_LAND_USE code -> label + intensity rank
--   public.zoning_intensity — base zoning district -> intensity rank (Phase 2)
-- and adds flum_code / flum_label / upzoning_gap / upzoning_flag to parcels.
--
-- intensity_rank (both tables) is an ordinal "development intensity" scale used
-- by Phase 2 (scripts/apply_upzoning_gap.sql) to flag parcels whose intended
-- future use outranks current zoning. The ranks are EDITORIAL judgments seeded
-- here so they can be audited/tuned without code changes; VERIFY before relying.
--
-- Idempotent: safe to re-run (lookup tables are truncated and reseeded).

set statement_timeout = 0;

-- ── FLUM polygons ─────────────────────────────────────────────────────────────
create table if not exists public.flum (
  flum_id          bigint primary key,   -- ArcGIS OBJECTID
  geom             geometry(MultiPolygon, 4326) not null,
  flum_code        int,                  -- FUTURE_LAND_USE category code
  ordinance_number text
);

create index if not exists flum_geom_idx on public.flum using gist (geom);
create index if not exists flum_code_idx on public.flum (flum_code);

alter table public.flum enable row level security;
drop policy if exists "anon read flum" on public.flum;
create policy "anon read flum" on public.flum for select using (true);

-- ── FLUM category codes ───────────────────────────────────────────────────────
-- code -> label is verified from the layer's renderer (uniqueValueInfos).
-- intensity_rank: 1 rural .. 6 highest-intensity mixed-use/activity center;
-- null = not comparable on the residential→commercial intensity axis
-- (open space, civic, transportation, water, special/PUD), excluded from the gap.
create table if not exists public.flum_categories (
  code           int primary key,
  label          text not null,
  intensity_rank int,
  notes          text
);

alter table public.flum_categories enable row level security;
drop policy if exists "anon read flum_categories" on public.flum_categories;
create policy "anon read flum_categories" on public.flum_categories for select using (true);

truncate table public.flum_categories;
insert into public.flum_categories (code, label, intensity_rank, notes) values
  (10,  'Agriculture',                     null, null),
  (50,  'Rural Residential',               1,    null),
  (100, 'Single-Family',                   2,    null),
  (113, 'Mobile Homes',                    2,    null),
  (111, 'Higher-Density Single-Family',    3,    null),
  (130, 'Mixed Residential',               3,    null),
  (270, 'Neighborhood Transition',         3,    'Transition between SF and more intense uses.'),
  (200, 'Multifamily',                     4,    null),
  (370, 'Neighborhood Node',               4,    null),
  (315, 'Neighborhood Commercial',         4,    null),
  (170, 'Residential Core',                5,    null),
  (325, 'Neighborhood Mixed Use',          5,    null),
  (330, 'Mixed Use',                       5,    null),
  (430, 'Mixed Use/Office',                5,    null),
  (400, 'Office',                          5,    null),
  (300, 'Commercial',                      5,    null),
  (305, 'Commerce',                        5,    null),
  (350, 'Warehouse/Limited Office',        5,    null),
  (500, 'Industry',                        5,    'Industrial: high intensity but distinct use class.'),
  (335, 'High Density Mixed Use',          6,    null),
  (380, 'Mixed-use Activity Hub/Corridor', 6,    null),
  (390, 'Activity Center',                 6,    null),
  (340, 'Specific Regulating District',    null, 'Governed by a regulating plan; rank undefined.'),
  (490, 'Major Planned Development',       null, 'PUD-style; site-specific.'),
  (680, 'Special District',                null, null),
  (560, 'Major Impact Facilities',         null, null),
  (600, 'Civic',                           null, null),
  (700, 'Recreation & Open Space',         null, null),
  (750, 'Environmental Conservation',      null, null),
  (800, 'Transportation',                  null, null),
  (860, 'Roads',                           null, 'In data, not in renderer; matches Land Use Inventory 860. VERIFY.'),
  (870, 'Utilities',                       null, null),
  (900, 'Undeveloped',                     null, 'In data, not in renderer; matches Land Use Inventory 900. VERIFY.'),
  (940, 'Water',                           null, null),
  (999, 'Unknown',                         null, 'In data, not in renderer. VERIFY.'),
  (108, 'Single-Family (108)',             2,    'In data, not in renderer; assumed single-family subtype. VERIFY.');

-- ── Zoning district intensity (Phase 2 input) ─────────────────────────────────
-- Same ordinal scale as flum_categories.intensity_rank, keyed on the base
-- district parsed by public.zoning_district() (e.g. 'SF-3'). VERIFY editorial.
create table if not exists public.zoning_intensity (
  district       text primary key,
  intensity_rank int,          -- null = intensity undefined (e.g. PUD); excluded from gap
  notes          text
);

alter table public.zoning_intensity enable row level security;
drop policy if exists "anon read zoning_intensity" on public.zoning_intensity;
create policy "anon read zoning_intensity" on public.zoning_intensity for select using (true);

truncate table public.zoning_intensity;
insert into public.zoning_intensity (district, intensity_rank, notes) values
  ('LA',   1, 'Lake Austin residential.'),
  ('RR',   1, 'Rural residence.'),
  ('AG',   1, 'Agricultural.'),
  ('MH',   2, 'Mobile home.'),
  ('SF-1', 2, null), ('SF-2', 2, null), ('SF-3', 2, null),
  ('SF-4A',3, null), ('SF-4B',3, null), ('SF-5', 3, null), ('SF-6', 3, null),
  ('MF-1', 4, null), ('MF-2', 4, null), ('MF-3', 4, null),
  ('MF-5', 5, null), ('MF-4', 5, null),
  ('MF-6', 6, null),
  ('NO',   5, 'Neighborhood office.'), ('LO', 5, null), ('GO', 5, null),
  ('LR',   4, 'Neighborhood commercial.'),
  ('GR',   5, 'Community commercial.'),
  ('CS',   5, 'General commercial services.'), ('CS-1', 5, null),
  ('CH',   5, 'Commercial highway.'),
  ('LI',   5, 'Limited industrial.'), ('IP', 5, null), ('MI', 5, null),
  ('CBD',  7, 'Central business district.'),
  ('DMU',  7, 'Downtown mixed use.'),
  ('PUD',  null, 'Planned unit development; site-specific.'),
  ('DR',   null, 'Development reserve.');

-- ── FLUM + upzoning columns on parcels ────────────────────────────────────────
-- flum_code / flum_label: written by scripts/apply_flum_to_parcels.sql
--   (precomputed point-in-polygon join, so the panel read is one row).
-- upzoning_gap / upzoning_flag: written by scripts/apply_upzoning_gap.sql (Ph 2).
alter table public.parcels
  add column if not exists flum_code     int,
  add column if not exists flum_label    text,
  add column if not exists upzoning_gap  int,
  add column if not exists upzoning_flag boolean;

create index if not exists parcels_flum_code_idx     on public.parcels (flum_code);
create index if not exists parcels_upzoning_flag_idx on public.parcels (upzoning_flag);
