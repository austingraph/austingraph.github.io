-- scripts/zoning_schema.sql
--
-- One-time setup for the development-envelope feature. Run in the Supabase
-- SQL Editor AFTER scripts/parcels_schema.sql.
--
-- Creates:
--   public.zoning        — City of Austin zoning district polygons
--   public.streets       — City of Austin street centerlines
--   public.zoning_rules  — LDC site-development regulations as DATA
-- and adds zoning columns to public.parcels.
--
-- Rule values are seeded from LDC § 25-2-492 (site development regulations),
-- LDC § 25-2-779 (HOME Phase 2 small-lot single family, Ord. 20240516-005),
-- and HOME Phase 1 (Ord. 20231207-001, up to 3 units on SF-1/2/3 lots).
-- Rows marked VERIFY in notes were seeded from secondary sources and must be
-- audited against Municode before relying on them.
--
-- Idempotent: safe to re-run (zoning_rules is truncated and reseeded).

set statement_timeout = 0;

-- ── City of Austin zoning districts ──────────────────────────────────────────
-- Source: Socrata "Zoning (Small Map Scale)" dataset rwvf-3qkm (~22.5k rows).
-- zoning_base is the base district pre-parsed by the city (e.g. 'SF-3' from
-- 'SF-3-NP'), so combining districts (-NP, -CO, -V…) need no parsing here.
create table if not exists public.zoning (
  zoning_id    bigint primary key,
  geom         geometry(MultiPolygon, 4326) not null,
  zoning_ztype text,   -- full string, e.g. 'SF-3-NP'
  zoning_base  text    -- base district, e.g. 'SF-3'
);

create index if not exists zoning_geom_idx on public.zoning using gist (geom);
create index if not exists zoning_base_idx on public.zoning (zoning_base);

alter table public.zoning enable row level security;
drop policy if exists "anon read zoning" on public.zoning;
create policy "anon read zoning" on public.zoning
  for select using (true);

-- ── City of Austin street centerlines ────────────────────────────────────────
-- Source: Socrata "Street Centerline" dataset m5w3-uea6.
-- Used by compute_envelope() to classify parcel edges (front / side / rear).
-- All road classes are loaded; alleys/driveways are excluded at query time so
-- the filter stays tunable without reloading.
create table if not exists public.streets (
  segment_id       bigint primary key,
  geom             geometry(MultiLineString, 4326) not null,
  full_street_name text,
  road_class       int
);

create index if not exists streets_geom_idx on public.streets using gist (geom);

alter table public.streets enable row level security;
drop policy if exists "anon read streets" on public.streets;
create policy "anon read streets" on public.streets
  for select using (true);

-- ── Zoning rules: regulations as data ────────────────────────────────────────
-- One row per (district, variant). variant 'base' is LDC § 25-2-492;
-- 'home_small_lot' is LDC § 25-2-779 and applies when the lot area falls in
-- [min_lot_sqft, max_lot_sqft). Null max_far/max_units = no cap encoded.
create table if not exists public.zoning_rules (
  district                 text not null,            -- matches zoning.zoning_base
  variant                  text not null default 'base',
  min_lot_sqft             numeric,
  max_lot_sqft             numeric,                  -- only for home_small_lot
  front_setback_ft         numeric,
  street_side_setback_ft   numeric,
  interior_side_setback_ft numeric,
  rear_setback_ft          numeric,
  max_height_ft            numeric,
  max_building_cover_pct   numeric,
  max_impervious_pct       numeric,
  max_far                  numeric,
  max_units                int,
  notes                    text,
  source                   text,
  primary key (district, variant)
);

alter table public.zoning_rules enable row level security;
drop policy if exists "anon read zoning_rules" on public.zoning_rules;
create policy "anon read zoning_rules" on public.zoning_rules
  for select using (true);

truncate table public.zoning_rules;

insert into public.zoning_rules
  (district, variant, min_lot_sqft, max_lot_sqft,
   front_setback_ft, street_side_setback_ft, interior_side_setback_ft, rear_setback_ft,
   max_height_ft, max_building_cover_pct, max_impervious_pct, max_far, max_units,
   notes, source)
values
  -- Single family — base districts (HOME Phase 1: up to 3 units; FAR 0.4 per Subchapter F as amended)
  ('SF-1', 'base', 10000, null, 25, 15, 5, 10, 35, 35, 40, 0.4, 3,
   'HOME Phase 1 allows up to 3 units on a single-family lot.',
   'LDC 25-2-492; 25-2 Subch. F; Ord. 20231207-001'),
  ('SF-2', 'base', 5750, null, 25, 15, 5, 10, 35, 40, 45, 0.4, 3,
   'HOME Phase 1 allows up to 3 units on a single-family lot.',
   'LDC 25-2-492; 25-2 Subch. F; Ord. 20231207-001'),
  ('SF-3', 'base', 5750, null, 25, 15, 5, 10, 35, 40, 45, 0.4, 3,
   'HOME Phase 1 allows up to 3 units on a single-family lot.',
   'LDC 25-2-492; 25-2 Subch. F; Ord. 20231207-001'),

  -- HOME Phase 2 small-lot single family (lots >= 1,800 and < 5,750 sq ft).
  -- Min 1,800 per Ord. 20240516-005; one codification source says 2,000 — VERIFY vs Municode.
  ('SF-1', 'home_small_lot', 1800, 5750, 15, 10, 5, 5, 35, 55, 65, 0.4, 1,
   'Small-lot single family (HOME Phase 2). VERIFY min lot (1,800 vs 2,000).',
   'LDC 25-2-779; Ord. 20240516-005'),
  ('SF-2', 'home_small_lot', 1800, 5750, 15, 10, 5, 5, 35, 55, 65, 0.4, 1,
   'Small-lot single family (HOME Phase 2). VERIFY min lot (1,800 vs 2,000).',
   'LDC 25-2-779; Ord. 20240516-005'),
  ('SF-3', 'home_small_lot', 1800, 5750, 15, 10, 5, 5, 35, 55, 65, 0.4, 1,
   'Small-lot single family (HOME Phase 2). VERIFY min lot (1,800 vs 2,000).',
   'LDC 25-2-779; Ord. 20240516-005'),

  -- Other residential — VERIFY all values against Municode § 25-2-492
  ('SF-4A', 'base', 3600, null, 15, 10, 5, 10, 35, 45, 55, 0.4, 1,
   'VERIFY against Municode.', 'LDC 25-2-492'),
  ('SF-5', 'base', 5750, null, 25, 15, 5, 10, 35, 40, 50, null, 2,
   'Urban family residence. VERIFY against Municode.', 'LDC 25-2-492'),
  ('SF-6', 'base', 5750, null, 25, 15, 5, 10, 35, 40, 55, null, null,
   'Townhouse/condominium; site-plan driven. VERIFY against Municode.', 'LDC 25-2-492'),
  ('MF-1', 'base', 8000, null, 25, 15, 5, 10, 40, 45, 55, null, null,
   'VERIFY against Municode.', 'LDC 25-2-492'),
  ('MF-2', 'base', 8000, null, 25, 15, 5, 10, 40, 50, 60, null, null,
   'VERIFY against Municode.', 'LDC 25-2-492'),
  ('MF-3', 'base', 8000, null, 25, 15, 5, 10, 40, 55, 65, null, null,
   'VERIFY against Municode.', 'LDC 25-2-492'),
  ('MF-4', 'base', 8000, null, 25, 15, 5, 10, 60, 60, 70, null, null,
   'VERIFY against Municode.', 'LDC 25-2-492'),
  ('MF-5', 'base', 8000, null, 25, 15, 5, 10, 60, 65, 70, null, null,
   'VERIFY against Municode.', 'LDC 25-2-492'),
  ('MF-6', 'base', 8000, null, 10, 10, 5, 10, 90, 70, 80, null, null,
   'VERIFY against Municode.', 'LDC 25-2-492'),

  -- Commercial — compatibility standards deferred; side/rear setbacks shown
  -- are base values without residential adjacency triggers
  ('LR', 'base', null, null, 25, 15, 0, 0, 40, 50, 80, 0.5, null,
   'Neighborhood commercial. Compatibility deferred. VERIFY against Municode.', 'LDC 25-2-492'),
  ('GR', 'base', null, null, 10, 10, 0, 0, 60, 75, 90, 1.0, null,
   'Community commercial. Compatibility deferred. VERIFY against Municode.', 'LDC 25-2-492'),
  ('CS', 'base', null, null, 10, 10, 0, 0, 60, 95, 95, 2.0, null,
   'General commercial services. Compatibility standards deferred.', 'LDC 25-2-492'),
  ('CS-1', 'base', null, null, 10, 10, 0, 0, 60, 95, 95, 2.0, null,
   'Commercial-liquor sales. Compatibility standards deferred.', 'LDC 25-2-492');

-- ── Zoning columns on parcels ────────────────────────────────────────────────
-- Populated by scripts/apply_zoning_to_parcels.sql (precomputed spatial join,
-- so per-click envelope cost never includes a parcel↔zoning join).
alter table public.parcels
  add column if not exists zoning_ztype text,
  add column if not exists zoning_base  text,
  add column if not exists multi_zoned  boolean not null default false;

create index if not exists parcels_zoning_base_idx on public.parcels (zoning_base);
