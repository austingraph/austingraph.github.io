#!/usr/bin/env python3
"""
scripts/ingest/load_overlay.py

Generic Site Check overlay loader (phases 3b-3d): downloads a City of Austin
geospatial dataset as GeoJSON, loads it into a PostGIS table, and spatial-joins a
classification onto a public.parcels column. Austin ArcGIS is not CORS-enabled,
so this precomputes the flags server-side (mirrors apply_flum_to_parcels.sql).

Layers (Socrata map datasets, exported via /api/geospatial):
  watershed    2xkn-3rmn  -> parcels.sitecheck_watershed     (centroid-in)
  jurisdiction 3pzb-6mbr  -> parcels.sitecheck_jurisdiction  (centroid-in)
  historic     vvuz-m3y4  -> parcels.sitecheck_historic      (parcel contains landmark)

Usage:
  python3 load_overlay.py --layer watershed --inspect   # fetch + report fields, no DB
  python3 load_overlay.py --layer watershed             # load + spatial-join

Environment: DATABASE_URL (Supabase session-pooler, service role).
"""

import argparse
import json
import os
import sys
import time
import urllib.request

LAYERS = {
    "watershed":    {"dataset": "2xkn-3rmn", "col": "sitecheck_watershed",    "mode": "centroid_in",    "prop": "watershed_classification"},
    "jurisdiction": {"dataset": "3pzb-6mbr", "col": "sitecheck_jurisdiction", "mode": "centroid_in",    "prop": "jurisdictions"},
    "historic":     {"dataset": "vvuz-m3y4", "col": "sitecheck_historic",     "mode": "contains_point", "prop": None},
}
BATCH = 1000


def fetch_geojson(dataset, tries=15, wait=6):
    """Socrata geospatial export is async: the first request kicks off generation
    and returns an empty/stub FeatureCollection; retry until features appear."""
    url = f"https://data.austintexas.gov/api/geospatial/{dataset}?method=export&format=GeoJSON"
    req = urllib.request.Request(url, headers={"User-Agent": "austingraph-ingest/1.0"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                gj = json.loads(r.read())
        except Exception as e:
            print(f"  attempt {i+1}: {e}", flush=True)
            gj = {}
        feats = gj.get("features") or []
        if any(f.get("geometry") for f in feats):
            print(f"  fetched {len(feats):,} features (attempt {i+1})", flush=True)
            return feats
        print(f"  attempt {i+1}: not ready ({len(feats)} stub features); waiting {wait}s…", flush=True)
        time.sleep(wait)
    sys.exit(f"Could not fetch {dataset} GeoJSON after {tries} tries")


def inspect(feats):
    from collections import Counter
    print(f"geom types: {Counter(f['geometry']['type'] for f in feats if f.get('geometry'))}")
    keys = list((feats[0].get("properties") or {}).keys())
    print(f"property keys: {keys}")
    for k in keys:
        vals = Counter(str((f.get('properties') or {}).get(k)) for f in feats)
        if 1 < len(vals) <= 25:
            print(f"  {k}: {dict(vals.most_common(20))}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--layer", required=True, choices=sorted(LAYERS))
    ap.add_argument("--inspect", action="store_true", help="fetch + report fields; no DB write")
    args = ap.parse_args()
    cfg = LAYERS[args.layer]

    print(f"Fetching {args.layer} ({cfg['dataset']})…", flush=True)
    feats = fetch_geojson(cfg["dataset"])

    if args.inspect:
        inspect(feats)
        return

    db = os.environ.get("DATABASE_URL")
    if not db:
        sys.exit("DATABASE_URL is not set")
    import psycopg
    tbl = f"overlay_{args.layer}"
    col = cfg["col"]
    t0 = time.time()
    conn = psycopg.connect(db, autocommit=False)
    with conn.cursor() as cur:
        cur.execute("set statement_timeout = 0;")
        cur.execute(f"""
            create table if not exists public.{tbl} (
              id bigserial primary key, val text, geom geometry(Geometry, 4326)
            );
            truncate public.{tbl} restart identity;
        """)
        conn.commit()
        rows, n = [], 0
        for ft in feats:
            g = ft.get("geometry")
            if not g:
                continue
            val = (ft.get("properties") or {}).get(cfg["prop"]) if cfg["prop"] else None
            rows.append({"v": val, "g": json.dumps(g)})
            if len(rows) >= BATCH:
                _ins(cur, tbl, rows); n += len(rows); rows = []
        if rows:
            _ins(cur, tbl, rows); n += len(rows)
        conn.commit()
        cur.execute(f"create index if not exists {tbl}_geom_idx on public.{tbl} using gist (geom);")
        cur.execute(f"analyze public.{tbl};")
        cur.execute(f"alter table public.parcels add column if not exists {col} text;")
        cur.execute(f"update public.parcels set {col} = null where {col} is not null;")
        conn.commit()
        print(f"  loaded {n:,} features; joining onto parcels ({cfg['mode']})…", flush=True)

        if cfg["mode"] == "centroid_in":
            cur.execute(f"""
                update public.parcels p set {col} = o.val
                from public.{tbl} o
                where o.val is not null and st_contains(o.geom, p.centroid);
            """)
        else:  # contains_point — parcel polygon contains an overlay point (e.g. a landmark)
            cur.execute(f"""
                update public.parcels p set {col} = 'yes'
                where exists (select 1 from public.{tbl} o where st_intersects(p.geom, o.geom));
            """)
        conn.commit()
        cur.execute(f"select count(*) from public.parcels where {col} is not null;")
        flagged = cur.fetchone()[0]
    conn.close()
    print(f"Done: {flagged:,} parcels flagged for {args.layer} ({time.time()-t0:.0f}s)", flush=True)


def _ins(cur, tbl, rows):
    cur.executemany(
        f"insert into public.{tbl} (val, geom) values (%(v)s, st_setsrid(st_geomfromgeojson(%(g)s), 4326))",
        rows,
    )


if __name__ == "__main__":
    main()
