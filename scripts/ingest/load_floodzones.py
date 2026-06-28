#!/usr/bin/env python3
"""
scripts/ingest/load_floodzones.py

Site Check (phase 3a): flag parcels that fall in a FEMA flood hazard zone.
Loads shared/floodzone.geojson into public.flood_zones, then spatial-joins the
most-severe intersecting zone onto public.parcels.sitecheck_flood:
  A / AE / AO  → Special Flood Hazard Area (1% annual chance) — high
  ".2 PCT …"   → 0.2% annual chance — moderate
  (X PROTECTED / AREA NOT INCLUDED are ignored)

Idempotent: re-running reloads the polygons and recomputes the flag.

Environment: DATABASE_URL (Supabase session-pooler, service role).
"""

import json
import os
import sys
import time

GEOJSON = os.path.join(os.path.dirname(__file__), "..", "..", "shared", "floodzone.geojson")
HAZARD = ["A", "AE", "AO", "AH", "VE", "A99", "AR"]   # FEMA 1%-annual SFHA codes
BATCH = 1000


def main():
    db = os.environ.get("DATABASE_URL")
    if not db:
        sys.exit("DATABASE_URL is not set")
    import psycopg

    with open(GEOJSON) as f:
        feats = json.load(f).get("features", [])
    print(f"Loaded {len(feats):,} flood features from {os.path.basename(GEOJSON)}", flush=True)

    t0 = time.time()
    conn = psycopg.connect(db, autocommit=False)
    with conn.cursor() as cur:
        cur.execute("""
            create table if not exists public.flood_zones (
              id         bigserial primary key,
              flood_zone text,
              geom       geometry(Geometry, 4326)
            );
        """)
        cur.execute("truncate public.flood_zones restart identity;")
        conn.commit()

        rows, n = [], 0
        for ft in feats:
            geom = ft.get("geometry")
            if not geom:
                continue
            rows.append({"fz": (ft.get("properties") or {}).get("flood_zone"),
                         "g": json.dumps(geom)})
            if len(rows) >= BATCH:
                _insert(cur, rows); n += len(rows); rows = []
        if rows:
            _insert(cur, rows); n += len(rows)
        conn.commit()
        print(f"  inserted {n:,} polygons ({time.time()-t0:.0f}s)", flush=True)

        cur.execute("create index if not exists flood_zones_geom_idx on public.flood_zones using gist (geom);")
        cur.execute("analyze public.flood_zones;")
        cur.execute("alter table public.parcels add column if not exists sitecheck_flood text;")
        cur.execute("update public.parcels set sitecheck_flood = null where sitecheck_flood is not null;")
        conn.commit()

        print("  spatial-joining onto parcels …", flush=True)
        cur.execute("""
            with hits as (
              select p.parcel_id, fz.flood_zone,
                     case when fz.flood_zone = any(%s)        then 3
                          when fz.flood_zone like '.2 PCT%%'  then 2
                          else 0 end as sev
              from public.parcels p
              join public.flood_zones fz on st_intersects(p.geom, fz.geom)
            ),
            best as (
              select distinct on (parcel_id) parcel_id, flood_zone
              from hits where sev > 0
              order by parcel_id, sev desc
            )
            update public.parcels p
               set sitecheck_flood = best.flood_zone
              from best
             where p.parcel_id = best.parcel_id;
        """, (HAZARD,))
        conn.commit()

        cur.execute("select count(*) from public.parcels where sitecheck_flood is not null;")
        flagged = cur.fetchone()[0]
    conn.close()
    print(f"Done: {flagged:,} parcels in a flood zone ({time.time()-t0:.0f}s)", flush=True)


def _insert(cur, rows):
    cur.executemany(
        "insert into public.flood_zones (flood_zone, geom) "
        "values (%(fz)s, st_setsrid(st_geomfromgeojson(%(g)s), 4326))",
        rows,
    )


if __name__ == "__main__":
    main()
