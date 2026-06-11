-- scripts/load_zoning.sql
--
-- Background loader for the City of Austin "Zoning (Small Map Scale)" layer
-- (Socrata dataset rwvf-3qkm, ~22.5k MultiPolygon rows). The city pre-parses
-- the base district into zoning_base (e.g. 'SF-3' from 'SF-3-NP'), so no
-- combining-district parsing is needed here.
--
-- Same scaffolding as scripts/load_parcels_from_tcad.sql:
--   - pgsql-http + pg_cron
--   - zoning_load_state table + advisory lock
--   - per-feature geometry validation (MakeValid + multi cast)
--   - one chunk per minute (~23 ticks for the full layer)
--
-- How to run:
--   1. First run scripts/zoning_schema.sql (one-time).
--   2. Paste this entire file in the SQL Editor, click Run.
--   3. Come back in ~25 minutes.
--
-- Progress:
--   select * from public.zoning_load_state;
--   select count(*) from public.zoning;        -- expect ~22,500
--
-- When completed = true:
--   select cron.unschedule('zoning-load');
--
-- Idempotent: safe to re-run (upserts on zoning_id).

set statement_timeout = 0;

create extension if not exists http;
create extension if not exists pg_cron;

create table if not exists public.zoning_load_state (
  id          int primary key default 1 check (id = 1),
  next_offset int not null default 0,
  completed   boolean not null default false,
  last_result text,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.zoning_load_state (id) values (1)
on conflict (id) do nothing;

create or replace function public.zoning_load_step(p_limit int default 1000)
returns text
language plpgsql
as $$
declare
  v_lock     bigint := 7424243;
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
    from public.zoning_load_state where id = 1;

  if v_done then
    perform pg_advisory_unlock(v_lock);
    return 'already complete';
  end if;

  -- Socrata GeoJSON paging. $order makes paging stable.
  v_url := 'https://data.austintexas.gov/resource/rwvf-3qkm.geojson'
        || '?$order=zoning_id'
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
    update public.zoning_load_state
      set completed = true,
          last_result = 'done at offset=' || v_offset,
          updated_at = now()
      where id = 1;
    perform pg_advisory_unlock(v_lock);
    return 'complete';
  end if;

  for v_feature in select jsonb_array_elements(v_features) loop
    begin
      v_id := (v_feature->'properties'->>'zoning_id')::numeric::bigint;

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

      insert into public.zoning (zoning_id, geom, zoning_ztype, zoning_base)
      values (
        v_id,
        v_g::geometry(MultiPolygon, 4326),
        v_feature->'properties'->>'zoning_ztype',
        v_feature->'properties'->>'zoning_base'
      )
      on conflict (zoning_id) do update
        set geom         = excluded.geom,
            zoning_ztype = excluded.zoning_ztype,
            zoning_base  = excluded.zoning_base;

      v_upserted := v_upserted + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  update public.zoning_load_state
    set next_offset = v_offset + p_limit,
        last_result = format('offset=%s fetched=%s upserted=%s skipped=%s',
                              v_offset, v_fetched, v_upserted, v_skipped),
        updated_at = now()
    where id = 1;

  perform pg_advisory_unlock(v_lock);
  return format('offset=%s fetched=%s upserted=%s skipped=%s',
                 v_offset, v_fetched, v_upserted, v_skipped);
end $$;

select cron.unschedule('zoning-load') where exists (
  select 1 from cron.job where jobname = 'zoning-load'
);

select cron.schedule(
  'zoning-load',
  '* * * * *',
  $cron$ select public.zoning_load_step(1000); $cron$
);

select * from public.zoning_load_state;
