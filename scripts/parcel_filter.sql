-- parcel_filter.sql
-- Anon-readable view backing the left-side parcel filter UI's zoning dropdown.
-- Lists every base zoning district present in the parcels table with a count,
-- so the UI can populate real options (with fallbacks hardcoded client-side).
--
-- Apply once in the Supabase SQL editor (same as kg_schema.sql / parcel_graph).
create or replace view public.parcel_zoning_bases as
  select zoning_base, count(*)::int as n
  from public.parcels
  where zoning_base is not null
  group by 1
  order by 1;

grant select on public.parcel_zoning_bases to anon;
