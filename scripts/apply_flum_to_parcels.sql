-- scripts/apply_flum_to_parcels.sql
--
-- Precomputes parcels.flum_code / flum_label by spatially joining parcels to
-- the FLUM polygons, so the planning-context panel never pays a parcel↔FLUM
-- join per click. Mirrors scripts/apply_zoning_to_parcels.sql.
--
-- Two passes per batch:
--   1. Point containment: the FLUM polygon containing the parcel centroid
--      (centroid is ST_PointOnSurface, guaranteed interior; coalesce guards
--      any parcel still missing a centroid).
--   2. Refinement: parcels straddling >1 FLUM category by >10% of their area
--      get the dominant-area category.
-- Parcels matching nothing stay null (outside any adopted neighborhood plan /
-- FLUM coverage). Waits until the FLUM load is complete before starting.
--
-- flum_label is denormalized from public.flum_categories so the panel read is a
-- single parcels row with no join.
--
-- How to run:
--   1. scripts/flum_schema.sql and scripts/load_flum.sql must be done
--      (flum_load_state.completed = true).
--   2. Paste this entire file in the SQL Editor, click Run.
--   3. ~374k parcels at 5000/min ≈ 75 minutes.
--
-- Progress:
--   select * from public.flum_join_state;
--   select count(*) from public.parcels where flum_code is not null;
--
-- When completed = true:
--   select cron.unschedule('flum-join');
--
-- Re-running RESTARTS the join from the first parcel (state reset below).

set statement_timeout = 0;

create extension if not exists pg_cron;

create table if not exists public.flum_join_state (
  id             int primary key default 1 check (id = 1),
  last_parcel_id text not null default '',
  completed      boolean not null default false,
  last_result    text,
  started_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

insert into public.flum_join_state (id) values (1)
on conflict (id) do nothing;

update public.flum_join_state
  set last_parcel_id = '',
      completed      = false,
      last_result    = 'reset',
      updated_at     = now()
  where id = 1;

create or replace function public.flum_join_step(p_limit int default 5000)
returns text
language plpgsql
as $$
#variable_conflict use_column
declare
  v_lock    bigint := 7424247;
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

  if not exists (select 1 from public.flum_load_state where completed) then
    perform pg_advisory_unlock(v_lock);
    return 'waiting: flum load not complete';
  end if;

  select last_parcel_id, completed into v_last, v_done
    from public.flum_join_state where id = 1;

  if v_done then
    perform pg_advisory_unlock(v_lock);
    return 'already complete';
  end if;

  drop table if exists _fj_batch;
  create temp table _fj_batch as
    select parcel_id, geom, centroid
    from public.parcels
    where parcel_id > v_last
    order by parcel_id
    limit p_limit;

  select count(*), max(parcel_id) into v_count, v_max from _fj_batch;

  if v_count = 0 then
    update public.flum_join_state
      set completed = true,
          last_result = 'done at parcel_id=' || v_last,
          updated_at = now()
      where id = 1;
    perform pg_advisory_unlock(v_lock);
    return 'complete';
  end if;

  -- Pass 1: point containment.
  update public.parcels p
  set flum_code  = f.flum_code,
      flum_label = c.label
  from _fj_batch b
  cross join lateral (
    select flum_code
    from public.flum z
    where st_contains(z.geom, coalesce(b.centroid, st_pointonsurface(b.geom)))
    order by z.flum_code nulls last
    limit 1
  ) f
  left join public.flum_categories c on c.code = f.flum_code
  where p.parcel_id = b.parcel_id;

  get diagnostics v_matched = row_count;

  -- Pass 2: dominant FLUM category for parcels straddling a boundary.
  begin
    with inter as (
      select b.parcel_id, z.flum_code,
             st_area(st_intersection(b.geom, z.geom)) as a,
             st_area(b.geom) as total
      from _fj_batch b
      join public.flum z on st_intersects(b.geom, z.geom)
    ),
    sig as (
      select * from inter where total > 0 and a / total > 0.10
    ),
    split as (
      select parcel_id from sig group by parcel_id having count(distinct flum_code) > 1
    ),
    dominant as (
      select distinct on (s.parcel_id) s.parcel_id, s.flum_code
      from sig s
      join split using (parcel_id)
      order by s.parcel_id, s.a desc
    )
    update public.parcels p
    set flum_code  = d.flum_code,
        flum_label = c.label
    from dominant d
    left join public.flum_categories c on c.code = d.flum_code
    where p.parcel_id = d.parcel_id;

    get diagnostics v_split = row_count;
  exception when others then
    v_note := ' pass2_error=' || left(sqlerrm, 120);
  end;

  update public.flum_join_state
    set last_parcel_id = v_max,
        last_result = format('batch=%s matched=%s split=%s last=%s%s',
                              v_count, v_matched, v_split, v_max, v_note),
        updated_at = now()
    where id = 1;

  perform pg_advisory_unlock(v_lock);
  return format('batch=%s matched=%s split=%s last=%s%s',
                 v_count, v_matched, v_split, v_max, v_note);
end $$;

select cron.unschedule('flum-join') where exists (
  select 1 from cron.job where jobname = 'flum-join'
);

select cron.schedule(
  'flum-join',
  '* * * * *',
  $cron$ select public.flum_join_step(5000); $cron$
);

select * from public.flum_join_state;
