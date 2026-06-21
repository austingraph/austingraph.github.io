-- scripts/load_flum.sql
--
-- Background loader for the City of Austin Future Land Use Map (FLUM),
-- ArcGIS REST layer PropertyProfile/LongRangePlanning/MapServer/4
-- (~79,836 polygons, verified live 2026-06).
--
-- Same scaffolding as scripts/load_zoning.sql (pgsql-http + pg_cron +
-- load-state row + advisory lock + ST_MakeValid/ST_Multi), but the source is
-- ArcGIS, not Socrata: paging is resultOffset / resultRecordCount with
-- orderByFields=OBJECTID (supportsPagination = true), output f=geojson, outSR
-- 4326. OBJECTID is requested explicitly in outFields and read from
-- properties.OBJECTID (it also appears as the GeoJSON feature `id`).
--
-- How to run:
--   1. First run scripts/flum_schema.sql (one-time).
--   2. Paste this entire file in the SQL Editor, click Run.
--   3. Come back in ~40 minutes (79.8k polygons at 2000/min).
--
-- Progress:
--   select * from public.flum_load_state;
--   select count(*) from public.flum;          -- expect ~79,836
--
-- When completed = true:
--   select cron.unschedule('flum-load');
--
-- Idempotent: safe to re-run (upserts on flum_id); re-running RESTARTS paging
-- from offset 0 (the state reset below).

set statement_timeout = 0;

create extension if not exists http;
create extension if not exists pg_cron;

create table if not exists public.flum_load_state (
  id          int primary key default 1 check (id = 1),
  next_offset int not null default 0,
  completed   boolean not null default false,
  last_result text,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.flum_load_state (id) values (1)
on conflict (id) do nothing;

update public.flum_load_state
  set next_offset = 0,
      completed   = false,
      last_result = 'reset',
      updated_at  = now()
  where id = 1;

create or replace function public.flum_load_step(p_limit int default 2000)
returns text
language plpgsql
as $$
declare
  v_lock     bigint := 7424246;
  v_offset   int;
  v_done     boolean;
  v_url      text;
  v_resp     record;
  v_features jsonb;
  v_feature  jsonb;
  v_id       bigint;
  v_g        geometry;
  v_fetched  int;
  v_upserted int := 0;
  v_skipped  int := 0;
begin
  if not pg_try_advisory_lock(v_lock) then
    return 'skipped: prior run still holding lock';
  end if;

  perform http_set_curlopt('CURLOPT_TIMEOUT',        '120');
  perform http_set_curlopt('CURLOPT_CONNECTTIMEOUT', '10');

  select next_offset, completed into v_offset, v_done
    from public.flum_load_state where id = 1;

  if v_done then
    perform pg_advisory_unlock(v_lock);
    return 'already complete';
  end if;

  -- ArcGIS GeoJSON paging. where=1=1 url-encoded; orderByFields makes paging
  -- stable; outSR=4326 returns lon/lat to match the rest of the schema.
  v_url := 'https://maps.austintexas.gov/arcgis/rest/services'
        || '/PropertyProfile/LongRangePlanning/MapServer/4/query'
        || '?where=1%3D1'
        || '&outFields=OBJECTID,FUTURE_LAND_USE,ORDINANCE_NUMBER'
        || '&outSR=4326'
        || '&orderByFields=OBJECTID'
        || '&resultRecordCount=' || p_limit
        || '&resultOffset='      || v_offset
        || '&f=geojson';

  select status, content::jsonb as body into v_resp from http_get(v_url);

  if v_resp.status <> 200 then
    perform pg_advisory_unlock(v_lock);
    raise exception 'arcgis http %: %', v_resp.status, left(v_resp.body::text, 300);
  end if;

  -- ArcGIS sometimes returns an error envelope with HTTP 200; surface it.
  if v_resp.body ? 'error' then
    perform pg_advisory_unlock(v_lock);
    raise exception 'arcgis error: %', left((v_resp.body->'error')::text, 300);
  end if;

  v_features := v_resp.body -> 'features';

  if v_features is null or jsonb_typeof(v_features) <> 'array' then
    perform pg_advisory_unlock(v_lock);
    raise exception 'arcgis response missing features array: %', left(v_resp.body::text, 300);
  end if;

  v_fetched := jsonb_array_length(v_features);

  if v_fetched = 0 then
    update public.flum_load_state
      set completed = true,
          last_result = 'done at offset=' || v_offset,
          updated_at = now()
      where id = 1;
    perform pg_advisory_unlock(v_lock);
    return 'complete';
  end if;

  for v_feature in select jsonb_array_elements(v_features) loop
    begin
      v_id := (v_feature->'properties'->>'OBJECTID')::numeric::bigint;

      if v_id is null
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

      insert into public.flum (flum_id, geom, flum_code, ordinance_number)
      values (
        v_id,
        v_g::geometry(MultiPolygon, 4326),
        nullif(v_feature->'properties'->>'FUTURE_LAND_USE', '')::numeric::int,
        v_feature->'properties'->>'ORDINANCE_NUMBER'
      )
      on conflict (flum_id) do update
        set geom             = excluded.geom,
            flum_code        = excluded.flum_code,
            ordinance_number = excluded.ordinance_number;

      v_upserted := v_upserted + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  update public.flum_load_state
    set next_offset = v_offset + p_limit,
        last_result = format('offset=%s fetched=%s upserted=%s skipped=%s',
                              v_offset, v_fetched, v_upserted, v_skipped),
        updated_at = now()
    where id = 1;

  perform pg_advisory_unlock(v_lock);
  return format('offset=%s fetched=%s upserted=%s skipped=%s',
                 v_offset, v_fetched, v_upserted, v_skipped);
end $$;

select cron.unschedule('flum-load') where exists (
  select 1 from cron.job where jobname = 'flum-load'
);

select cron.schedule(
  'flum-load',
  '* * * * *',
  $cron$ select public.flum_load_step(2000); $cron$
);

select * from public.flum_load_state;
