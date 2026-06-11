-- scripts/apply_zoning_to_parcels.sql
--
-- Precomputes parcels.zoning_ztype / zoning_base / multi_zoned by spatially
-- joining parcels to the City of Austin zoning polygons, so compute_envelope()
-- never pays a parcel↔zoning join per click.
--
-- parcels.zoning_base is the TRUE base district parsed from the full zoning
-- string via public.zoning_district() ('SF-3-NP' → 'SF-3'); the city's own
-- zoning_base field is only the coarse family ('SF') and is never used here.
--
-- Two passes per batch:
--   1. Point containment: zoning polygon containing the parcel centroid
--      (centroid is ST_PointOnSurface, guaranteed interior).
--   2. Refinement: parcels whose geometry significantly intersects (>10% of
--      parcel area) more than one district get the dominant-area district and
--      multi_zoned = true.
-- Parcels matching nothing stay null (outside City of Austin zoning — ETJ /
-- county). Waits until the zoning load is complete before starting.
--
-- How to run:
--   1. scripts/zoning_schema.sql and scripts/load_zoning.sql must be done
--      (zoning_load_state.completed = true).
--   2. Paste this entire file in the SQL Editor, click Run.
--   3. ~400k parcels at 5000/min ≈ 80 minutes.
--
-- Progress:
--   select * from public.zoning_join_state;
--   select count(*) from public.parcels where zoning_base is not null;
--
-- When completed = true:
--   select cron.unschedule('zoning-join');
--
-- Re-running this script RESTARTS the join from the first parcel (the state
-- reset below). That is intentional: it recomputes every parcel with the
-- current parsing logic, overwriting older values.

set statement_timeout = 0;

create extension if not exists pg_cron;

-- District parser (also in zoning_schema.sql; repeated here so this script is
-- self-contained for databases where the schema predates the function).
create or replace function public.zoning_district(p_ztype text)
returns text
language sql
immutable
as $fn$
  select (regexp_match(
    upper(regexp_replace(coalesce(p_ztype, ''), '^I-', '')),
    '^(SF-4A|SF-4B|SF-[1-6]|MF-[1-6]|CS-1|CS|GR|LR|LO|GO|NO|LI|LA|MH|RR|DR|CBD|DMU|PUD|AG|AV|CH|IP|MI|ERC|TOD|TND|UNZ|NBG|W/LO|R&D|CR|P|L)(-|$)'
  ))[1]
$fn$;

create table if not exists public.zoning_join_state (
  id             int primary key default 1 check (id = 1),
  last_parcel_id text not null default '',
  completed      boolean not null default false,
  last_result    text,
  started_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

insert into public.zoning_join_state (id) values (1)
on conflict (id) do nothing;

update public.zoning_join_state
  set last_parcel_id = '',
      completed      = false,
      last_result    = 'reset (recomputing with zoning_district parser)',
      updated_at     = now()
  where id = 1;

create or replace function public.zoning_join_step(p_limit int default 5000)
returns text
language plpgsql
as $$
declare
  v_lock    bigint := 7424245;
  v_last    text;
  v_done    boolean;
  v_count   int;
  v_max     text;
  v_matched int := 0;
  v_split   int := 0;
  v_note    text := '';
begin
  if not pg_try_advisory_lock(v_lock) then
    return 'skipped: prior run still holding lock';
  end if;

  if not exists (select 1 from public.zoning_load_state where completed) then
    perform pg_advisory_unlock(v_lock);
    return 'waiting: zoning load not complete';
  end if;

  select last_parcel_id, completed into v_last, v_done
    from public.zoning_join_state where id = 1;

  if v_done then
    perform pg_advisory_unlock(v_lock);
    return 'already complete';
  end if;

  drop table if exists _zj_batch;
  create temp table _zj_batch as
    select parcel_id, geom, centroid
    from public.parcels
    where parcel_id > v_last
    order by parcel_id
    limit p_limit;

  select count(*), max(parcel_id) into v_count, v_max from _zj_batch;

  if v_count = 0 then
    update public.zoning_join_state
      set completed = true,
          last_result = 'done at parcel_id=' || v_last,
          updated_at = now()
      where id = 1;
    perform pg_advisory_unlock(v_lock);
    return 'complete';
  end if;

  -- Pass 1: point containment. coalesce guards against parcels loaded
  -- without a centroid (see scripts/backfill_centroids.sql) — a null
  -- centroid would silently match nothing.
  update public.parcels p
  set zoning_ztype = z.zoning_ztype,
      zoning_base  = public.zoning_district(z.zoning_ztype),
      multi_zoned  = false
  from _zj_batch b
  cross join lateral (
    select zoning_ztype
    from public.zoning z
    where st_contains(z.geom, coalesce(b.centroid, st_pointonsurface(b.geom)))
    limit 1
  ) z
  where p.parcel_id = b.parcel_id;

  get diagnostics v_matched = row_count;

  -- Pass 2: dominant district for split-zoned parcels. ST_Intersection can
  -- fail on pathological geometry; if it does, keep pass-1 results for the
  -- batch and note it rather than stalling the loader.
  begin
    with inter as (
      select b.parcel_id, z.zoning_ztype,
             st_area(st_intersection(b.geom, z.geom)) as a,
             st_area(b.geom) as total
      from _zj_batch b
      join public.zoning z on st_intersects(b.geom, z.geom)
    ),
    sig as (
      select * from inter where total > 0 and a / total > 0.10
    ),
    split as (
      select parcel_id from sig group by parcel_id having count(*) > 1
    ),
    dominant as (
      select distinct on (s.parcel_id) s.parcel_id, s.zoning_ztype
      from sig s
      join split using (parcel_id)
      order by s.parcel_id, s.a desc
    )
    update public.parcels p
    set zoning_ztype = d.zoning_ztype,
        zoning_base  = public.zoning_district(d.zoning_ztype),
        multi_zoned  = true
    from dominant d
    where p.parcel_id = d.parcel_id;

    get diagnostics v_split = row_count;
  exception when others then
    v_note := ' pass2_error=' || left(sqlerrm, 120);
  end;

  update public.zoning_join_state
    set last_parcel_id = v_max,
        last_result = format('batch=%s matched=%s split=%s last=%s%s',
                              v_count, v_matched, v_split, v_max, v_note),
        updated_at = now()
    where id = 1;

  perform pg_advisory_unlock(v_lock);
  return format('batch=%s matched=%s split=%s last=%s%s',
                 v_count, v_matched, v_split, v_max, v_note);
end $$;

select cron.unschedule('zoning-join') where exists (
  select 1 from cron.job where jobname = 'zoning-join'
);

select cron.schedule(
  'zoning-join',
  '* * * * *',
  $cron$ select public.zoning_join_step(5000); $cron$
);

select * from public.zoning_join_state;
