-- scripts/load_streets.sql
--
-- Background loader for the City of Austin "Street Centerline" layer
-- (Socrata dataset 8hf2-pdmb, ~68.5k segments, verified live 2026-06).
-- NOTE: the map-view id m5w3-uea6 looks like the same layer but its resource
-- endpoint returns empty features — do not use it.
--
-- compute_envelope() uses these to classify parcel edges as front /
-- street-side / interior-side / rear. All segments are loaded; ramp /
-- unbuilt / alley exclusion happens at query time inside compute_envelope()
-- so it can be tuned without reloading.
--
-- Same scaffolding as scripts/load_parcels_from_tcad.sql.
--
-- How to run:
--   1. First run scripts/zoning_schema.sql (one-time).
--   2. Paste this entire file in the SQL Editor, click Run.
--   3. Come back in ~35 minutes (68.5k segments at 2000/min).
--
-- Progress:
--   select * from public.streets_load_state;
--   select count(*) from public.streets;       -- expect ~68,500
--
-- When completed = true:
--   select cron.unschedule('streets-load');
--
-- Idempotent: safe to re-run (upserts on segment_id), but re-running RESTARTS
-- paging from offset 0 (the state reset below clears any progress recorded
-- against the old empty m5w3-uea6 dataset).

set statement_timeout = 0;

create extension if not exists http;
create extension if not exists pg_cron;

-- Earlier revision of this loader pointed at the empty m5w3-uea6 dataset and
-- may have marked itself complete with zero rows; make sure the column and a
-- clean state exist before (re)starting.
alter table if exists public.streets
  add column if not exists built_status int;

create table if not exists public.streets_load_state (
  id          int primary key default 1 check (id = 1),
  next_offset int not null default 0,
  completed   boolean not null default false,
  last_result text,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.streets_load_state (id) values (1)
on conflict (id) do nothing;

update public.streets_load_state
  set next_offset = 0,
      completed   = false,
      last_result = 'reset (dataset changed to 8hf2-pdmb)',
      updated_at  = now()
  where id = 1;

create or replace function public.streets_load_step(p_limit int default 2000)
returns text
language plpgsql
as $$
declare
  v_lock     bigint := 7424244;
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

  perform http_set_curlopt('CURLOPT_TIMEOUT',        '90');
  perform http_set_curlopt('CURLOPT_CONNECTTIMEOUT', '10');

  select next_offset, completed into v_offset, v_done
    from public.streets_load_state where id = 1;

  if v_done then
    perform pg_advisory_unlock(v_lock);
    return 'already complete';
  end if;

  v_url := 'https://data.austintexas.gov/resource/8hf2-pdmb.geojson'
        || '?$order=segment_id'
        || '&$limit='  || p_limit
        || '&$offset=' || v_offset;

  select status, content::jsonb as body into v_resp from http_get(v_url);

  if v_resp.status <> 200 then
    perform pg_advisory_unlock(v_lock);
    raise exception 'socrata http %: %', v_resp.status, left(v_resp.body::text, 300);
  end if;

  v_features := v_resp.body -> 'features';

  if v_features is null or jsonb_typeof(v_features) <> 'array' then
    perform pg_advisory_unlock(v_lock);
    raise exception 'socrata response missing features array: %', left(v_resp.body::text, 300);
  end if;

  v_fetched := jsonb_array_length(v_features);

  if v_fetched = 0 then
    update public.streets_load_state
      set completed = true,
          last_result = 'done at offset=' || v_offset,
          updated_at = now()
      where id = 1;
    perform pg_advisory_unlock(v_lock);
    return 'complete';
  end if;

  for v_feature in select jsonb_array_elements(v_features) loop
    begin
      v_id := (v_feature->'properties'->>'segment_id')::numeric::bigint;

      if v_id is null
         or v_feature->'geometry' is null
         or jsonb_typeof(v_feature->'geometry') <> 'object' then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_g := st_setsrid(st_geomfromgeojson(v_feature->'geometry'), 4326);
      v_g := st_multi(st_linemerge(st_makevalid(v_g)));
      if v_g is null or st_geometrytype(v_g) <> 'ST_MultiLineString' then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      insert into public.streets (segment_id, geom, full_street_name, road_class, built_status)
      values (
        v_id,
        v_g::geometry(MultiLineString, 4326),
        v_feature->'properties'->>'full_street_name',
        nullif(v_feature->'properties'->>'road_class', '')::numeric::int,
        nullif(v_feature->'properties'->>'built_status', '')::numeric::int
      )
      on conflict (segment_id) do update
        set geom             = excluded.geom,
            full_street_name = excluded.full_street_name,
            road_class       = excluded.road_class,
            built_status     = excluded.built_status;

      v_upserted := v_upserted + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  update public.streets_load_state
    set next_offset = v_offset + p_limit,
        last_result = format('offset=%s fetched=%s upserted=%s skipped=%s',
                              v_offset, v_fetched, v_upserted, v_skipped),
        updated_at = now()
    where id = 1;

  perform pg_advisory_unlock(v_lock);
  return format('offset=%s fetched=%s upserted=%s skipped=%s',
                 v_offset, v_fetched, v_upserted, v_skipped);
end $$;

select cron.unschedule('streets-load') where exists (
  select 1 from cron.job where jobname = 'streets-load'
);

select cron.schedule(
  'streets-load',
  '* * * * *',
  $cron$ select public.streets_load_step(2000); $cron$
);

select * from public.streets_load_state;
