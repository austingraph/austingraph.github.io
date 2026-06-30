#!/usr/bin/env python3
"""
scripts/ingest/load_market_context.py

Loads free AGGREGATE market data (keyed by ZIP) as a defensible substitute for
Texas's non-disclosure sale prices, and joins each parcel to its ZIP:

  1. ZIP join   shared/SecondData.geojson ZIP polygons -> public.zip_codes,
                then parcels.zip = centroid-in-ZIP (mirrors load_overlay.py).
  2. Redfin     Data Center national ZIP market tracker (gzipped TSV) ->
                median sale $/sqft + median sale price, latest period per ZIP.
  3. Zillow     ZORI ZIP CSV -> typical observed market rent, latest month.
  4. Upsert     public.market_context (zip, median_sale_ppsf, median_sale_price,
                zori_rent, redfin_period, zori_period).

Only ZIPs we actually have parcels in are kept (small, relevant table).

Usage:
  python3 load_market_context.py --inspect        # fetch + report samples, no DB write
  python3 load_market_context.py                  # full load (zip join + redfin + zillow)
  python3 load_market_context.py --skip-zip       # skip the parcel<->ZIP join (reuse existing)

Environment: DATABASE_URL (Supabase session-pooler, service role).
Source URLs can be overridden with REDFIN_ZIP_URL / ZILLOW_ZORI_URL env vars.
"""

import argparse
import csv
import gzip
import io
import json
import os
import re
import sys
import urllib.request

REDFIN_ZIP_URL = os.environ.get(
    "REDFIN_ZIP_URL",
    "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/zip_code_market_tracker.tsv000.gz",
)
ZILLOW_ZORI_URL = os.environ.get(
    "ZILLOW_ZORI_URL",
    "https://files.zillowstatic.com/research/public_csvs/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv",
)
GEOJSON = os.path.join(os.path.dirname(__file__), "..", "..", "shared", "SecondData.geojson")
UA = {"User-Agent": "austingraph-ingest/1.0"}
ZIP_RE = re.compile(r"(\d{5})")
DATE_COL_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ── ZIP polygons → parcels.zip ────────────────────────────────────────────────
def load_zip_join(cur, conn):
    with open(GEOJSON) as f:
        gj = json.load(f)
    feats = gj.get("features") or []
    rows = []
    for ft in feats:
        z = (ft.get("properties") or {}).get("zipcode")
        g = ft.get("geometry")
        if z is None or not g:
            continue
        rows.append({"z": str(int(z)) if isinstance(z, (int, float)) else str(z).strip(),
                     "g": json.dumps(g)})
    if not rows:
        sys.exit("No ZIP polygons in SecondData.geojson")
    cur.execute("""
        create table if not exists public.zip_codes (
          zipcode text primary key, geom geometry(Geometry, 4326)
        );""")
    cur.execute("truncate public.zip_codes;")
    cur.executemany(
        "insert into public.zip_codes (zipcode, geom) values "
        "(%(z)s, st_setsrid(st_geomfromgeojson(%(g)s), 4326)) "
        "on conflict (zipcode) do update set geom = excluded.geom",
        rows,
    )
    cur.execute("create index if not exists zip_codes_geom_idx on public.zip_codes using gist (geom);")
    cur.execute("analyze public.zip_codes;")
    cur.execute("alter table public.parcels add column if not exists zip text;")
    conn.commit()
    print(f"  loaded {len(rows)} ZIP polygons; joining onto parcels…", flush=True)
    cur.execute("""
        update public.parcels p set zip = z.zipcode
        from public.zip_codes z
        where st_contains(z.geom, p.centroid);""")
    conn.commit()
    cur.execute("create index if not exists parcels_zip_idx on public.parcels (zip);")
    cur.execute("select count(*) from public.parcels where zip is not null;")
    print(f"  parcels with a ZIP: {cur.fetchone()[0]:,}", flush=True)


def target_zips(cur):
    """ZIPs we have parcels in — keeps market_context small and relevant."""
    cur.execute("select distinct zip from public.parcels where zip is not null;")
    return {r[0] for r in cur.fetchall()}


# ── Redfin: median sale $/sqft + price, latest period per ZIP ─────────────────
def fetch_redfin(keep_zips, inspect=False):
    print(f"Fetching Redfin ZIP market tracker (large, streaming)…\n  {REDFIN_ZIP_URL}", flush=True)
    req = urllib.request.Request(REDFIN_ZIP_URL, headers=UA)
    out = {}   # zip -> (period_begin, median_ppsf, median_sale_price)
    n = 0
    with urllib.request.urlopen(req, timeout=300) as resp:
        gz = gzip.GzipFile(fileobj=resp)
        text = io.TextIOWrapper(gz, encoding="utf-8", errors="replace")
        reader = csv.reader(text, delimiter="\t")
        header = next(reader)
        # Redfin headers are UPPERCASE and fields are double-quoted in a way csv
        # doesn't auto-strip — normalise names (and values) by stripping quotes.
        norm = lambda s: s.strip().strip('"')
        idx = {norm(name).lower(): i for i, name in enumerate(header)}
        need = ("period_begin", "region", "state_code", "property_type", "median_ppsf", "median_sale_price")
        missing = [c for c in need if c not in idx]
        if missing:
            print(f"  ! Redfin columns missing {missing}; header was: {header[:20]}", flush=True)
            return out
        def cell(r, k):
            i = idx[k]
            return norm(r[i]) if i < len(r) else ""
        for r in reader:
            n += 1
            if n % 2_000_000 == 0:
                print(f"    …scanned {n:,} rows, {len(out)} matching ZIPs", flush=True)
            try:
                if cell(r, "state_code") != "TX" or cell(r, "property_type") != "All Residential":
                    continue
                m = ZIP_RE.search(cell(r, "region"))
                if not m:
                    continue
                z = m.group(1)
                if keep_zips and z not in keep_zips:
                    continue
                period = cell(r, "period_begin")
                ppsf = cell(r, "median_ppsf")
                price = cell(r, "median_sale_price")
                if not ppsf:
                    continue
                prev = out.get(z)
                if prev is None or period > prev[0]:
                    out[z] = (period, float(ppsf), int(float(price)) if price else None)
            except (ValueError, IndexError):
                continue
    print(f"  Redfin: {len(out)} ZIPs (scanned {n:,} rows)", flush=True)
    if inspect:
        for z, v in list(out.items())[:8]:
            print(f"    {z}: period={v[0]} ppsf={v[1]} price={v[2]}")
    return out


# ── Zillow ZORI: latest observed rent per ZIP ─────────────────────────────────
def fetch_zillow(keep_zips, inspect=False):
    print(f"Fetching Zillow ZORI ZIP series…\n  {ZILLOW_ZORI_URL}", flush=True)
    req = urllib.request.Request(ZILLOW_ZORI_URL, headers=UA)
    out = {}   # zip -> (period, rent)
    with urllib.request.urlopen(req, timeout=120) as resp:
        text = io.TextIOWrapper(resp, encoding="utf-8", errors="replace")
        reader = csv.reader(text)
        header = next(reader)
        idx = {name: i for i, name in enumerate(header)}
        if "RegionName" not in idx:
            print(f"  ! ZORI header unexpected: {header[:12]}", flush=True)
            return out
        date_cols = [(i, h) for i, h in enumerate(header) if DATE_COL_RE.match(h)]
        state_i = idx.get("State") or idx.get("StateName")
        for r in reader:
            try:
                z = str(r[idx["RegionName"]]).strip().zfill(5)
                if keep_zips and z not in keep_zips:
                    continue
                if state_i is not None and r[state_i] not in ("TX", "Texas"):
                    continue
                rent, period = None, None
                for i, h in reversed(date_cols):       # latest non-empty month
                    if i < len(r) and r[i] not in ("", None):
                        rent, period = float(r[i]), h
                        break
                if rent is not None:
                    out[z] = (period, round(rent, 2))
            except (ValueError, IndexError):
                continue
    print(f"  Zillow ZORI: {len(out)} ZIPs", flush=True)
    if inspect:
        for z, v in list(out.items())[:8]:
            print(f"    {z}: period={v[0]} rent={v[1]}")
    return out


def upsert_market(cur, conn, redfin, zillow):
    cur.execute("""
        create table if not exists public.market_context (
          zip text primary key, median_sale_ppsf numeric, median_sale_price bigint,
          zori_rent numeric, redfin_period date, zori_period date,
          updated_at timestamptz default now()
        );""")
    zips = set(redfin) | set(zillow)
    rows = []
    for z in zips:
        rf = redfin.get(z)
        zl = zillow.get(z)
        rows.append({
            "z": z,
            "ppsf": rf[1] if rf else None,
            "price": rf[2] if rf else None,
            "rent": zl[1] if zl else None,
            "rfp": rf[0] if rf else None,
            "zlp": zl[0] if zl else None,
        })
    cur.executemany("""
        insert into public.market_context
          (zip, median_sale_ppsf, median_sale_price, zori_rent, redfin_period, zori_period, updated_at)
        values (%(z)s, %(ppsf)s, %(price)s, %(rent)s, %(rfp)s, %(zlp)s, now())
        on conflict (zip) do update set
          median_sale_ppsf = excluded.median_sale_ppsf,
          median_sale_price = excluded.median_sale_price,
          zori_rent = excluded.zori_rent,
          redfin_period = excluded.redfin_period,
          zori_period = excluded.zori_period,
          updated_at = now();""", rows)
    conn.commit()
    print(f"Upserted {len(rows)} ZIPs into market_context", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--inspect", action="store_true", help="fetch + print samples; no DB write")
    ap.add_argument("--skip-zip", action="store_true", help="skip the parcel<->ZIP spatial join")
    args = ap.parse_args()

    if args.inspect:
        rf = fetch_redfin(None, inspect=True)
        zl = fetch_zillow(None, inspect=True)
        print(f"\nInspect only — Redfin {len(rf)} ZIPs, Zillow {len(zl)} ZIPs; nothing written.")
        return

    db = os.environ.get("DATABASE_URL")
    if not db:
        sys.exit("DATABASE_URL is not set")
    import psycopg
    conn = psycopg.connect(db, autocommit=False)
    with conn.cursor() as cur:
        cur.execute("set statement_timeout = 0;")
        if not args.skip_zip:
            load_zip_join(cur, conn)
        keep = target_zips(cur)
        print(f"Target ZIPs (have parcels): {len(keep)}", flush=True)
        redfin = fetch_redfin(keep)
        zillow = fetch_zillow(keep)
        if not redfin and not zillow:
            sys.exit("No market data fetched — check REDFIN_ZIP_URL / ZILLOW_ZORI_URL")
        upsert_market(cur, conn, redfin, zillow)
        # Denormalized convenience: how many parcels now resolve to a market row.
        cur.execute("""select count(*) from public.parcels p
                       join public.market_context m on m.zip = p.zip;""")
        print(f"Parcels with market context: {cur.fetchone()[0]:,}", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
