-- scripts/load_parcels_from_tcad.sql
--
-- Background loader for the Travis County TNR "TCAD Parcels" ArcGIS layer
-- (the TCAD-backed authoritative parcel polygons). Uses PROP_ID (TCAD
-- Property ID) as parcel_id so the value matches what shows up on TCAD
-- esearch, appraisal notices, tax bills, and the IDs referenced in
-- planning/zoning documents.
--
-- Source endpoint (verified live, supportsPagination=true, maxRecordCount=2000,
-- supportedQueryFormats includes geoJSON):
--   https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/MapServer/0
--
-- Same scaffolding as scripts/load_parcels_from_socrata.sql:
--   - pgsql-http + pg_cron
--   - parcels_load_state table + advisory lock
--   - per-feature geometry validation (MakeValid + multi cast)
--   - one chunk per minute
-- Only the URL/pagination and field mapping are TCAD-specific.
--
-- How to run (new paid Supabase project aqbyxpiwugcvoephsvpm):
--   1. Open the SQL Editor for the new project.
--   2. First run scripts/parcels_schema.sql (one-time).
--   3. Paste this entire file, click Run. Installs extensions + cron in
--      ~5 seconds; the actual load runs server-side, no browser needed.
--   4. Come back in ~30-45 minutes (Travis County has ~400k parcels at
--      2000/min ≈ 200 minutes worst case; typical batches insert faster).
--
-- Progress:
--   select * from public.parcels_load_state;
--   select count(*) from public.parcels;
--
-- When completed = true:
--   select cron.unschedule('parcels-load');
--
-- Idempotent: safe to re-run.

set statement_timeout = 0;

create extension if not exists http;
create extension if not exists pg_cron;

create table if not exists public.parcels_load_state (
  id          int primary key default 1 check (id = 1),
  next_offset int not null default 0,
  completed   boolean not null default false,
  last_result text,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.parcels_load_state (id) values (1)
on conflict (id) do nothing;

create or replace function public.parcels_load_step(p_limit int default 2000)
returns text
language plpgsql
as $$
declare
  v_lock     bigint := 7424242;
  v_offset   int;
  v_done     boolean;
  v_url      text;
  v_resp     record;
  v_body     jsonb;
  v_features jsonb;
  v_feature  jsonb;
  v_prop_id  text;
  v_g        geometry;
  v_fetched  int;
  v_inserted int := 0;
  v_skipped  int := 0;
begin
  if not pg_try_advisory_lock(v_lock) then
    return 'skipped: prior run still holding lock';
  end if;

  -- pgsql-http defaults to 5s; ArcGIS GeoJSON pages can be ~20-40 MB.
  perform http_set_curlopt('CURLOPT_TIMEOUT',        '90');
  perform http_set_curlopt('CURLOPT_CONNECTTIMEOUT', '10');
  -- The county GIS server drops connections from default curl UAs
  -- (SSL_ERROR_SYSCALL); present a browser UA and pin TLS 1.2.
  perform http_set_curlopt('CURLOPT_USERAGENT',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
  perform http_set_curlopt('CURLOPT_SSLVERSION', '6');  -- CURL_SSLVERSION_TLSv1_2

  select next_offset, completed into v_offset, v_done
    from public.parcels_load_state where id = 1;

  if v_done then
    perform pg_advisory_unlock(v_lock);
    return 'already complete';
  end if;

  -- ArcGIS REST /query. resultOffset + resultRecordCount drive paging.
  -- f=geojson returns features in the same shape as Socrata (properties +
  -- geometry), so the per-row processing below stays identical in spirit.
  v_url := 'https://gis.traviscountytx.gov/server1/rest/services/'
        || 'Boundaries_and_Jurisdictions/TCAD_public/MapServer/0/query'
        || '?where=1%3D1'
        || '&outFields=PROP_ID,geo_id,situs_address,legal_desc,tcad_acres'
        || '&returnGeometry=true'
        || '&outSR=4326'
        || '&f=geojson'
        -- NOTE: orderByFields=PROP_ID triggers a server bug that nulls every
        -- attribute in the response; OBJECTID ordering works (verified 2026-06).
        || '&orderByFields=OBJECTID'
        || '&resultRecordCount=' || p_limit
        || '&resultOffset='      || v_offset;

  select status, content::jsonb as body into v_resp from http_get(v_url);

  if v_resp.status <> 200 then
    perform pg_advisory_unlock(v_lock);
    raise exception 'tcad http %: %', v_resp.status, left(v_resp.body::text, 300);
  end if;

  v_body     := v_resp.body;
  v_features := v_body -> 'features';

  if v_features is null or jsonb_typeof(v_features) <> 'array' then
    perform pg_advisory_unlock(v_lock);
    raise exception 'tcad response missing features array: %', left(v_body::text, 300);
  end if;

  v_fetched := jsonb_array_length(v_features);

  if v_fetched = 0 then
    update public.parcels_load_state
      set completed = true,
          last_result = 'done at offset=' || v_offset,
          updated_at = now()
      where id = 1;
    perform pg_advisory_unlock(v_lock);
    return 'complete';
  end if;

  for v_feature in select jsonb_array_elements(v_features) loop
    begin
      -- PROP_ID arrives as a JSON number; ->> coerces to text and we keep
      -- it as text to match parcels.parcel_id (text primary key).
      v_prop_id := v_feature->'properties'->>'PROP_ID';

      if v_prop_id is null
         or v_feature->'geometry' is null
         or jsonb_typeof(v_feature->'geometry') <> 'object' then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_g := st_setsrid(st_geomfromgeojson(v_feature->'geometry'), 4326);
      v_g := st_multi(st_makevalid(v_g));
      if v_g is null or st_geometrytype(v_g) <> 'ST_MultiPolygon' then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      insert into public.parcels (parcel_id, geom, centroid, metadata)
      values (
        v_prop_id,
        v_g::geometry(MultiPolygon, 4326),
        st_pointonsurface(v_g),
        jsonb_strip_nulls(jsonb_build_object(
          'geo_id',         v_feature->'properties'->>'geo_id',
          'situs_address',  v_feature->'properties'->>'situs_address',
          'legal_desc',     v_feature->'properties'->>'legal_desc',
          'tcad_acres',     v_feature->'properties'->'tcad_acres'
        ))
      )
      on conflict (parcel_id) do nothing;

      v_inserted := v_inserted + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  update public.parcels_load_state
    set next_offset = v_offset + p_limit,
        last_result = format('offset=%s fetched=%s inserted=%s skipped=%s',
                              v_offset, v_fetched, v_inserted, v_skipped),
        updated_at = now()
    where id = 1;

  perform pg_advisory_unlock(v_lock);
  return format('offset=%s fetched=%s inserted=%s skipped=%s',
                 v_offset, v_fetched, v_inserted, v_skipped);
end $$;

select cron.unschedule('parcels-load') where exists (
  select 1 from cron.job where jobname = 'parcels-load'
);

select cron.schedule(
  'parcels-load',
  '* * * * *',
  $cron$ select public.parcels_load_step(2000); $cron$
);

select * from public.parcels_load_state;
