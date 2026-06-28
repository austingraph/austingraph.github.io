#!/usr/bin/env python3
"""
scripts/ingest/load_overlay.py

Generic Site Check overlay loader (phases 3b-3c): downloads a City of Austin
ArcGIS feature layer as GeoJSON, loads it into a PostGIS table, and spatial-joins
a classification onto a public.parcels column. Austin's ArcGIS REST is queried
server-side (it isn't browser-CORS friendly), mirroring apply_flum_to_parcels.sql.

Layers (Austin AGOL feature services, queried synchronously):
  watershed    BOUNDARIES_watershed_regulation_areas -> parcels.sitecheck_watershed
               (WATERSHED_DEVELOPMENT_TYPE: URBAN/SUBURBAN/WATER SUPPLY …/BSZ → impervious cap)
  jurisdiction BOUNDARIES_jurisdictions              -> parcels.sitecheck_jurisdiction
               (JURISDICTION_LABEL: FULL PURPOSE / LTD / 2-MILE ETJ / … → who permits)

Both are joined by parcel-centroid containment (a parcel sits in one area).

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

ORG = "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services"
LAYERS = {
    "watershed":    {"svc": "BOUNDARIES_watershed_regulation_areas", "col": "sitecheck_watershed",    "prop": "WATERSHED_DEVELOPMENT_TYPE"},
    "jurisdiction": {"svc": "BOUNDARIES_jurisdictions",              "col": "sitecheck_jurisdiction", "prop": "JURISDICTION_LABEL"},
}
BATCH = 1000


def fetch_features(svc):
    """Page an ArcGIS FeatureServer layer 0 as GeoJSON (synchronous, reliable)."""
    base = f"{ORG}/{svc}/FeatureServer/0/query"
    out, offset = [], 0
    while True:
        url = (f"{base}?where=1%3D1&outFields=*&outSR=4326&f=geojson"
               f"&resultOffset={offset}&resultRecordCount=2000")
        req = urllib.request.Request(url, headers={"User-Agent": "austingraph-ingest/1.0"})
        with urllib.request.urlopen(req, timeout=180) as r:
            gj = json.loads(r.read())
        feats = gj.get("features") or []
        out.extend(feats)
        if len(feats) < 2000:
            break
        offset += len(feats)
    if not out:
        sys.exit(f"No features returned for {svc}")
    print(f"  fetched {len(out):,} features", flush=True)
    return out


def inspect(feats):
    from collections import Counter
    print("geom:", feats[0]["geometry"]["type"])
    keys = list((feats[0].get("properties") or {}).keys())
    print("props:", keys)
    for k in keys:
        vals = Counter(str((f.get("properties") or {}).get(k)) for f in feats)
        if 1 < len(vals) <= 25:
            print(f"  {k}: {dict(vals.most_common(20))}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--layer", required=True, choices=sorted(LAYERS))
    ap.add_argument("--inspect", action="store_true", help="fetch + report fields; no DB write")
    args = ap.parse_args()
    cfg = LAYERS[args.layer]

    print(f"Fetching {args.layer} ({cfg['svc']})…", flush=True)
    feats = fetch_features(cfg["svc"])

    if args.inspect:
        inspect(feats)
        return

    db = os.environ.get("DATABASE_URL")
    if not db:
        sys.exit("DATABASE_URL is not set")
    import psycopg
    tbl, col = f"overlay_{args.layer}", cfg["col"]
    t0 = time.time()
    conn = psycopg.connect(db, autocommit=False)
    with conn.cursor() as cur:
        cur.execute("set statement_timeout = 0;")
        cur.execute(f"""
            create table if not exists public.{tbl} (
              id bigserial primary key, val text, geom geometry(Geometry, 4326)
            );
        """)
        cur.execute(f"truncate public.{tbl} restart identity;")
        conn.commit()

        rows, n = [], 0
        for ft in feats:
            g = ft.get("geometry")
            if not g:
                continue
            rows.append({"v": (ft.get("properties") or {}).get(cfg["prop"]), "g": json.dumps(g)})
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

        print(f"  loaded {n:,} features; joining onto parcels (centroid-in)…", flush=True)
        cur.execute(f"""
            update public.parcels p set {col} = o.val
            from public.{tbl} o
            where o.val is not null and st_contains(o.geom, p.centroid);
        """)
        conn.commit()
        cur.execute(f"select count(*) from public.parcels where {col} is not null;")
        flagged = cur.fetchone()[0]
    conn.close()
    print(f"Done: {flagged:,} parcels classified for {args.layer} ({time.time()-t0:.0f}s)", flush=True)


def _ins(cur, tbl, rows):
    cur.executemany(
        f"insert into public.{tbl} (val, geom) values (%(v)s, st_setsrid(st_geomfromgeojson(%(g)s), 4326))",
        rows,
    )


if __name__ == "__main__":
    main()
