-- scripts/compute_envelope.sql
--
-- public.compute_envelope(parcel_id) — development-envelope calculator,
-- exposed to the static frontend via PostgREST RPC (anon, read-only).
--
-- Given a parcel, looks up its precomputed zoning district (see
-- scripts/apply_zoning_to_parcels.sql), picks the applicable zoning_rules row
-- (HOME Phase 2 small-lot variant when the lot qualifies, else base),
-- classifies parcel edges as front / street_side / interior side / rear using
-- street-centerline proximity, subtracts per-edge setback buffers, and
-- returns the buildable footprint plus development stats as jsonb:
--
--   {
--     status: 'ok' | 'not_found' | 'no_zoning' | 'no_rules' | 'error',
--     zoning_ztype, zoning_base, variant, classification, multi_zoned,
--     lot_sqft, buildable_sqft, setbacks_ft {front, street_side,
--       interior_side, rear}, max_height_ft, max_far, max_far_sqft,
--     max_building_cover_pct/sqft, max_impervious_pct/sqft, max_units,
--     notes [], rules_source, rules_notes,
--     buildable:    GeoJSON Feature (props height_ft, height_m) | absent,
--     setback_zone: GeoJSON Feature | absent,
--     edges:        GeoJSON FeatureCollection (per-edge class — debug/UI)
--   }
--
-- All geometry math runs in EPSG:2277 (NAD83 / Texas Central, US survey feet)
-- so setbacks apply in feet directly; outputs are transformed back to 4326.
--
-- Deferred (MVP scope): compatibility standards (25-2-1051 ff.), Subchapter F
-- 45° height tent (massing is a flat prism at the district cap), easements and
-- utility setbacks, HOME preservation/sustainability FAR bonuses, small-lot
-- re-subdivision, overlay districts (NCCD, historic, airport), interior rings.
--
-- Test:
--   select compute_envelope('123456');
-- or over HTTP:
--   curl -s "$SUPABASE_URL/rest/v1/rpc/compute_envelope" \
--     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
--     -H "Content-Type: application/json" -d '{"p_parcel_id":"123456"}'

set statement_timeout = 0;

create or replace function public.compute_envelope(p_parcel_id text)
returns jsonb
language plpgsql
stable
as $$
-- Several embedded queries below iterate edge arrays via `generate_series` /
-- `generate_subscripts(...) i`, whose output column `i` collides with the
-- PL/pgSQL loop variable `i`. Without this directive PostgreSQL raises
-- "column reference \"i\" is ambiguous" at runtime; in every such query the
-- subscript column is what's intended, so resolve conflicts to the column.
#variable_conflict use_column
declare
  c_srid       constant int     := 2277;  -- NAD83 / Texas Central (ftUS)
  c_street_max constant numeric := 120;   -- ft: max edge→street distance to count as street-facing
  c_front_band constant numeric := 10;    -- ft: edges within (min dist + band) are street-facing
  c_front_cap  constant numeric := 60;    -- ft: absolute street-facing distance cap
  c_search_deg constant numeric := 0.0008; -- ~80 m candidate-street search radius in 4326
  -- road_class 10 = highway ramps/turnarounds (verified on dataset 8hf2-pdmb)
  c_excluded_road_classes constant int[] := array[10];
  c_buf       constant text := 'side=both endcap=flat join=mitre mitre_limit=2.0';
  c_mitre     constant text := 'join=mitre mitre_limit=2.0';

  v_parcel record;
  v_rules  record;
  v_found  boolean;
  v_lot_sqft numeric;
  v_g      geometry;   -- largest parcel polygon, EPSG:2277
  v_g4326  geometry;
  v_ring   geometry;

  -- per-edge working arrays (parallel)
  v_e     geometry[] := '{}';
  v_len   numeric[]  := '{}';
  v_d     numeric[]  := '{}';   -- distance to nearest street; null if > c_street_max
  v_sname text[]     := '{}';
  v_az    numeric[]  := '{}';
  v_class text[]     := '{}';
  v_dd    numeric[];            -- distance from edge midpoint to front line
  v_par   boolean[];            -- roughly parallel to front?
  v_n     int;

  v_min_d     numeric;
  v_front_cut numeric;
  v_front     geometry;
  v_front_az  numeric;
  v_names     text[];
  v_primary_name text;
  v_max_dd    numeric := 0;
  v_rear_i    int;
  v_diff      numeric;

  v_classification text := 'edges';
  v_zone      geometry;
  v_setback   numeric;
  v_buildable geometry;
  v_buildable_sqft numeric := 0;
  v_edges_fc  jsonb := jsonb_build_object('type', 'FeatureCollection', 'features', '[]'::jsonb);
  v_notes     text[] := '{}';
  r record;
  i int;
begin
  select geom, zoning_ztype, zoning_base, coalesce(multi_zoned, false) as multi_zoned
    into v_parcel
    from public.parcels
    where parcel_id = p_parcel_id;

  if not found then
    return jsonb_build_object('status', 'not_found', 'parcel_id', p_parcel_id);
  end if;

  if v_parcel.zoning_base is null then
    return jsonb_build_object('status', 'no_zoning', 'parcel_id', p_parcel_id);
  end if;

  v_lot_sqft := st_area(st_transform(v_parcel.geom, c_srid));

  -- Rules: HOME Phase 2 small-lot variant first, else base district row
  select * into v_rules
    from public.zoning_rules
    where district = v_parcel.zoning_base
      and variant = 'home_small_lot'
      and v_lot_sqft >= coalesce(min_lot_sqft, 0)
      and v_lot_sqft <  coalesce(max_lot_sqft, 1e12);
  v_found := found;
  if not v_found then
    select * into v_rules
      from public.zoning_rules
      where district = v_parcel.zoning_base and variant = 'base';
    v_found := found;
  end if;
  if not v_found then
    return jsonb_build_object(
      'status', 'no_rules', 'parcel_id', p_parcel_id,
      'zoning_ztype', v_parcel.zoning_ztype,
      'zoning_base',  v_parcel.zoning_base);
  end if;

  -- Largest polygon (multi-part parcels: envelope on the largest part only)
  select geom into v_g
    from (select (st_dump(st_makevalid(st_transform(v_parcel.geom, c_srid)))).geom as geom) parts
    where st_geometrytype(geom) = 'ST_Polygon'
    order by st_area(geom) desc
    limit 1;

  if v_g is null then
    return jsonb_build_object('status', 'error', 'parcel_id', p_parcel_id,
                              'message', 'no polygonal geometry');
  end if;

  if st_numgeometries(v_parcel.geom) > 1 then
    v_notes := v_notes || 'Multi-part parcel; envelope computed on largest part.';
  end if;
  if v_parcel.multi_zoned then
    v_notes := v_notes || 'Parcel spans multiple zoning districts; dominant district applied.';
  end if;

  v_g4326 := st_transform(v_g, 4326);
  -- Merge near-collinear vertices so each lot line becomes one edge
  v_ring := st_exteriorring(st_simplifypreservetopology(v_g, 1.0));

  -- Edges + nearest non-alley street per edge
  for r in
    with edges as (
      select i, st_makeline(st_pointn(v_ring, i), st_pointn(v_ring, i + 1)) as e
      from generate_series(1, st_npoints(v_ring) - 1) as i
    ),
    nearby as (
      select st_transform(s.geom, c_srid) as g, s.full_street_name
      from public.streets s
      where st_dwithin(s.geom, v_g4326, c_search_deg)
        and (s.road_class is null or not (s.road_class = any (c_excluded_road_classes)))
        and coalesce(s.built_status, 2) <> 0   -- skip unbuilt "paper" streets
        and (s.full_street_name is null or s.full_street_name not ilike '%alley%')
    )
    select e.i, e.e, st_length(e.e) as len,
           n.d, n.full_street_name,
           case when st_length(e.e) > 0.5
                then st_azimuth(st_startpoint(e.e), st_endpoint(e.e)) end as az
    from edges e
    left join lateral (
      select s.full_street_name,
             st_distance(st_lineinterpolatepoint(e.e, 0.5), s.g) as d
      from nearby s
      order by st_distance(st_lineinterpolatepoint(e.e, 0.5), s.g)
      limit 1
    ) n on true
    order by e.i
  loop
    continue when r.len < 1;  -- drop micro edges
    v_e     := v_e     || r.e;
    v_len   := v_len   || r.len;
    v_d     := v_d     || (case when r.d <= c_street_max then r.d end);
    v_sname := v_sname || coalesce(r.full_street_name, '');
    v_az    := v_az    || r.az;
    v_class := v_class || 'side';
  end loop;

  v_n := coalesce(array_length(v_e, 1), 0);
  select min(x) into v_min_d from unnest(v_d) x;

  if v_n < 3 or v_min_d is null then
    -- Flag lot / data gap: no mapped street near any edge → uniform interior buffer
    v_classification := 'fallback_uniform';
    v_notes := v_notes || 'No mapped street within 120 ft; uniform interior setback applied.';
    v_setback := coalesce(v_rules.interior_side_setback_ft, 0);
    if v_setback > 0 then
      v_zone := st_difference(v_g, st_buffer(v_g, -v_setback, c_mitre));
    else
      v_zone := st_setsrid(st_geomfromtext('POLYGON EMPTY'), c_srid);
    end if;
  else
    -- Front: edges near the closest street
    v_front_cut := least(v_min_d + c_front_band, c_front_cap);
    for i in 1 .. v_n loop
      if v_d[i] is not null and v_d[i] <= v_front_cut then
        v_class[i] := 'front';
      end if;
    end loop;

    -- Corner lot: street-facing edges on 2+ distinct streets → the street
    -- group with greater total edge length keeps 'front', others 'street_side'
    select array_agg(distinct v_sname[i]) into v_names
      from generate_subscripts(v_e, 1) i
      where v_class[i] = 'front' and v_sname[i] <> '';
    if coalesce(array_length(v_names, 1), 0) >= 2 then
      select nm into v_primary_name
        from (
          select v_sname[i] as nm, sum(v_len[i]) as tot
          from generate_subscripts(v_e, 1) i
          where v_class[i] = 'front' and v_sname[i] <> ''
          group by 1
          order by 2 desc
          limit 1
        ) s;
      for i in 1 .. v_n loop
        if v_class[i] = 'front' and v_sname[i] <> v_primary_name then
          v_class[i] := 'street_side';
        end if;
      end loop;
    end if;

    select st_union(v_e[i]) into v_front
      from generate_subscripts(v_e, 1) i
      where v_class[i] = 'front';
    select v_az[i] into v_front_az
      from generate_subscripts(v_e, 1) i
      where v_class[i] = 'front' and v_az[i] is not null
      order by v_len[i] desc
      limit 1;

    -- Rear: farthest near-parallel edges from the front line
    v_dd  := array_fill(null::numeric, array[v_n]);
    v_par := array_fill(false, array[v_n]);
    for i in 1 .. v_n loop
      if v_class[i] = 'side' then
        v_dd[i] := st_distance(st_lineinterpolatepoint(v_e[i], 0.5), v_front);
        if v_az[i] is not null and v_front_az is not null then
          v_diff := abs(v_az[i] - v_front_az);
          v_diff := v_diff - pi() * floor(v_diff / pi());   -- mod π (lines are undirected)
          if v_diff > pi() / 2 then v_diff := pi() - v_diff; end if;
          v_par[i] := v_diff < pi() / 4;
        end if;
        if v_par[i] and v_dd[i] > v_max_dd then
          v_max_dd := v_dd[i];
        end if;
      end if;
    end loop;

    if v_max_dd > 0 then
      for i in 1 .. v_n loop
        if v_class[i] = 'side' and v_par[i] and v_dd[i] >= 0.9 * v_max_dd then
          v_class[i] := 'rear';
        end if;
      end loop;
    else
      select i into v_rear_i
        from generate_subscripts(v_e, 1) i
        where v_class[i] = 'side' and v_dd[i] is not null
        order by v_dd[i] desc
        limit 1;
      if v_rear_i is not null then
        v_class[v_rear_i] := 'rear';
      end if;
    end if;

    -- Setback zone: union of two-sided flat-cap mitre buffers per edge,
    -- clipped to the parcel (the half outside the lot is discarded)
    select st_union(st_buffer(v_e[i], sb.s, c_buf)) into v_zone
      from generate_subscripts(v_e, 1) i
      cross join lateral (
        select case v_class[i]
                 when 'front'       then v_rules.front_setback_ft
                 when 'street_side' then v_rules.street_side_setback_ft
                 when 'rear'        then v_rules.rear_setback_ft
                 else                    v_rules.interior_side_setback_ft
               end as s
      ) sb
      where coalesce(sb.s, 0) > 0;
    v_zone := coalesce(v_zone, st_setsrid(st_geomfromtext('POLYGON EMPTY'), c_srid));
    v_zone := st_intersection(st_makevalid(v_zone), v_g);
  end if;

  -- Buildable footprint: parcel minus setbacks, deslivered (±1 ft), parts ≥ 100 sq ft
  v_buildable := st_makevalid(st_difference(v_g, v_zone));
  v_buildable := st_buffer(st_buffer(v_buildable, -1.0, c_mitre), 1.0, c_mitre);
  select st_union(geom) into v_buildable
    from (select (st_dump(st_collectionextract(st_makevalid(v_buildable), 3))).geom as geom) parts
    where st_area(geom) >= 100;
  v_buildable_sqft := coalesce(st_area(v_buildable), 0);

  if v_buildable_sqft = 0 then
    v_notes := v_notes || 'Setbacks consume the entire lot.';
  end if;

  if v_n > 0 then
    select jsonb_build_object(
             'type', 'FeatureCollection',
             'features', coalesce(jsonb_agg(jsonb_build_object(
               'type', 'Feature',
               'properties', jsonb_strip_nulls(jsonb_build_object(
                 'class', v_class[i],
                 'street', nullif(v_sname[i], ''),
                 'street_dist_ft', round(v_d[i], 1))),
               'geometry', st_asgeojson(st_transform(v_e[i], 4326), 7)::jsonb
             )), '[]'::jsonb))
      into v_edges_fc
      from generate_subscripts(v_e, 1) i;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'status', 'ok',
    'parcel_id', p_parcel_id,
    'zoning_ztype', v_parcel.zoning_ztype,
    'zoning_base',  v_parcel.zoning_base,
    'variant', v_rules.variant,
    'classification', v_classification,
    'multi_zoned', v_parcel.multi_zoned,
    'lot_sqft', round(v_lot_sqft),
    'buildable_sqft', round(v_buildable_sqft),
    'setbacks_ft', jsonb_build_object(
      'front',         v_rules.front_setback_ft,
      'street_side',   v_rules.street_side_setback_ft,
      'interior_side', v_rules.interior_side_setback_ft,
      'rear',          v_rules.rear_setback_ft),
    'max_height_ft', v_rules.max_height_ft,
    'max_far', v_rules.max_far,
    'max_far_sqft', case when v_rules.max_far is not null
                         then round(v_lot_sqft * v_rules.max_far) end,
    'max_building_cover_pct', v_rules.max_building_cover_pct,
    'max_building_cover_sqft', case when v_rules.max_building_cover_pct is not null
                                    then round(v_lot_sqft * v_rules.max_building_cover_pct / 100) end,
    'max_impervious_pct', v_rules.max_impervious_pct,
    'max_impervious_sqft', case when v_rules.max_impervious_pct is not null
                                then round(v_lot_sqft * v_rules.max_impervious_pct / 100) end,
    'max_units', v_rules.max_units,
    'rules_source', v_rules.source,
    'rules_notes',  v_rules.notes,
    'notes', case when array_length(v_notes, 1) is not null then to_jsonb(v_notes) end,
    'buildable', case when v_buildable_sqft > 0 then jsonb_build_object(
      'type', 'Feature',
      'properties', jsonb_strip_nulls(jsonb_build_object(
        'height_ft', v_rules.max_height_ft,
        'height_m',  case when v_rules.max_height_ft is not null
                          then round(v_rules.max_height_ft * 0.3048, 2) end)),
      'geometry', st_asgeojson(st_transform(v_buildable, 4326), 7)::jsonb) end,
    'setback_zone', case when v_zone is not null and not st_isempty(v_zone) then jsonb_build_object(
      'type', 'Feature',
      'properties', '{}'::jsonb,
      'geometry', st_asgeojson(st_transform(v_zone, 4326), 7)::jsonb) end,
    'edges', v_edges_fc
  ));
exception when others then
  return jsonb_build_object('status', 'error', 'parcel_id', p_parcel_id,
                            'message', sqlerrm);
end $$;

grant execute on function public.compute_envelope(text) to anon, authenticated;
