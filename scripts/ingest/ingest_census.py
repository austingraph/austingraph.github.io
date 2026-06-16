#!/usr/bin/env python3
"""
ingest_census.py — Load Census demographics into Supabase for austingraph.chat

Sources:
  • 2020 Decennial DHC (block level) via Census API + TIGERweb geometries
  • ACS 2022 5-year (block group level) via Census API + TIGER cartographic boundary

Run once (or annually when new ACS vintage is released):
  DATABASE_URL=<supabase-pooler-url> CENSUS_API_KEY=<key> python3 ingest_census.py

Prerequisites (pip install geopandas psycopg2-binary requests pyproj shapely):
  pip install geopandas psycopg2-binary requests pyproj shapely

Travis County FIPS: state=48, county=453
"""

import io
import json
import math
import os
import time
import zipfile
from urllib.request import urlretrieve

import geopandas as gpd
import psycopg2
import requests
from psycopg2.extras import execute_values
from shapely.geometry import mapping

CENSUS_KEY = os.environ["CENSUS_API_KEY"]
DATABASE_URL = os.environ["DATABASE_URL"]
STATE = "48"
COUNTY = "453"
ACS_VINTAGE = 2022

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def census_get(url, params=None):
    r = requests.get(url, params=params, timeout=60)
    r.raise_for_status()
    rows = r.json()
    headers = rows[0]
    return [dict(zip(headers, row)) for row in rows[1:]]

def census_get_chunked(url, var_list, geo_params, chunk_size=49):
    """Fetch >50 variables across multiple <=50-var requests (Census API limit)
    and merge the returned rows by their geography columns."""
    merged = {}
    for i in range(0, len(var_list), chunk_size):
        chunk = var_list[i:i + chunk_size]
        rows = census_get(url, params={"get": ",".join(chunk), **geo_params})
        for r in rows:
            geo_cols = [k for k in r if k not in chunk]
            key = tuple(r[c] for c in geo_cols)
            merged.setdefault(key, {}).update(r)
    return list(merged.values())

def nullify(val, sentinel=-666666666):
    """Census API returns -666666666 for missing/suppressed values."""
    try:
        v = int(val)
        return None if v == sentinel or v < 0 else v
    except (TypeError, ValueError):
        return None

def pct(num, denom):
    """Safe percentage: returns None if denom is 0 or either is None."""
    if num is None or denom is None or denom == 0:
        return None
    return round(100.0 * num / denom, 1)

def download_zip(url, dest):
    print(f"  Downloading {url} …")
    urlretrieve(url, dest)
    print(f"  Saved → {dest}")

# ---------------------------------------------------------------------------
# 1. Block groups: geometry + ACS
# ---------------------------------------------------------------------------

def load_block_groups(conn):
    print("\n=== Block Groups ===")

    # --- Geometry (cartographic boundary, 7 MB) ---
    bg_zip = "/tmp/cb_2022_48_bg_500k.zip"
    if not os.path.exists(bg_zip):
        download_zip(
            "https://www2.census.gov/geo/tiger/GENZ2022/shp/cb_2022_48_bg_500k.zip",
            bg_zip
        )
    gdf = gpd.read_file(f"zip://{bg_zip}").to_crs("EPSG:4326")
    # Filter to Travis County
    gdf = gdf[gdf["COUNTYFP"] == COUNTY].copy()
    gdf["GEOID"] = gdf["GEOID"].str.strip()
    print(f"  {len(gdf)} block groups in Travis County")

    # --- ACS variables ---
    acs_var_list = [
        "B19013_001E",          # median HH income
        "B25003_002E",          # owner-occupied
        "B25003_003E",          # renter-occupied
        "B25064_001E",          # median gross rent
        # Cost burden (renters 30%+)
        "B25070_007E",          # 30–34.9%
        "B25070_008E",          # 35–39.9%
        "B25070_009E",          # 40–49.9%
        "B25070_010E",          # 50%+
        "B25070_001E",          # total renters with rent paid
        # Age
        "B01002_001E",          # median age
        "B01001_001E",          # total population (for pct calcs)
        # Under 18: male 003-006, female 027-030
        "B01001_003E","B01001_004E","B01001_005E","B01001_006E",
        "B01001_027E","B01001_028E","B01001_029E","B01001_030E",
        # 65+: male 020-025, female 044-049
        "B01001_020E","B01001_021E","B01001_022E","B01001_023E","B01001_024E","B01001_025E",
        "B01001_044E","B01001_045E","B01001_046E","B01001_047E","B01001_048E","B01001_049E",
        # 25-64: male 010-019, female 034-043
        "B01001_010E","B01001_011E","B01001_012E","B01001_013E","B01001_014E",
        "B01001_015E","B01001_016E","B01001_017E","B01001_018E","B01001_019E",
        "B01001_034E","B01001_035E","B01001_036E","B01001_037E","B01001_038E",
        "B01001_039E","B01001_040E","B01001_041E","B01001_042E","B01001_043E",
        # Race/ethnicity (B03002 — Hispanic-origin based)
        "B03002_001E",          # total
        "B03002_003E",          # non-Hispanic white
        "B03002_004E",          # non-Hispanic Black
        "B03002_006E",          # non-Hispanic Asian
        "B03002_012E",          # Hispanic or Latino
        # Commute (B08301)
        "B08301_001E",          # total workers
        "B08301_010E",          # public transit
        "B08301_018E",          # bicycle
        "B08301_019E",          # walked
        "B08301_021E",          # worked at home
    ]

    rows = census_get_chunked(
        f"https://api.census.gov/data/{ACS_VINTAGE}/acs/acs5",
        acs_var_list,
        {
            "for": "block group:*",
            "in": f"state:{STATE} county:{COUNTY}",
            "key": CENSUS_KEY,
        },
    )
    print(f"  {len(rows)} ACS rows fetched")

    # Build lookup keyed by 12-digit GEOID
    acs = {}
    for r in rows:
        geoid = r["state"] + r["county"] + r["tract"] + r["block group"]
        acs[geoid] = r

    # --- Build records ---
    records = []
    for _, row in gdf.iterrows():
        geoid = row["GEOID"]
        a = acs.get(geoid, {})

        def ai(k): return nullify(a.get(k))

        total_pop = ai("B01001_001E") or 0
        owner     = ai("B25003_002E")
        renter    = ai("B25003_003E")

        # Youth (<18)
        youth = sum(filter(None, [
            ai("B01001_003E"), ai("B01001_004E"), ai("B01001_005E"), ai("B01001_006E"),
            ai("B01001_027E"), ai("B01001_028E"), ai("B01001_029E"), ai("B01001_030E"),
        ]))

        # Seniors (65+)
        seniors = sum(filter(None, [
            ai("B01001_020E"), ai("B01001_021E"), ai("B01001_022E"), ai("B01001_023E"),
            ai("B01001_024E"), ai("B01001_025E"),
            ai("B01001_044E"), ai("B01001_045E"), ai("B01001_046E"), ai("B01001_047E"),
            ai("B01001_048E"), ai("B01001_049E"),
        ]))

        # Prime age (25-64)
        prime = sum(filter(None, [
            ai("B01001_010E"), ai("B01001_011E"), ai("B01001_012E"), ai("B01001_013E"),
            ai("B01001_014E"), ai("B01001_015E"), ai("B01001_016E"), ai("B01001_017E"),
            ai("B01001_018E"), ai("B01001_019E"),
            ai("B01001_034E"), ai("B01001_035E"), ai("B01001_036E"), ai("B01001_037E"),
            ai("B01001_038E"), ai("B01001_039E"), ai("B01001_040E"), ai("B01001_041E"),
            ai("B01001_042E"), ai("B01001_043E"),
        ]))

        # Cost burden: % of renters with rent >= 30% of income
        cb_total = nullify(a.get("B25070_001E")) or 0
        cb_burdened = sum(filter(None, [
            ai("B25070_007E"), ai("B25070_008E"), ai("B25070_009E"), ai("B25070_010E"),
        ]))
        cost_burden_pct = pct(cb_burdened, cb_total)

        # Transit / alt commute
        workers    = ai("B08301_001E") or 0
        transit    = sum(filter(None, [
            ai("B08301_010E"), ai("B08301_018E"), ai("B08301_019E"), ai("B08301_021E"),
        ]))
        transit_pct = pct(transit, workers)

        # Race
        race_total = ai("B03002_001E") or 0

        # Median age: Census API returns a float string
        median_age = None
        try:
            v = float(a.get("B01002_001E", -1))
            if v > 0:
                median_age = round(v, 1)
        except (TypeError, ValueError):
            pass

        geom_wkt = row.geometry.wkt

        records.append((
            geoid,
            geom_wkt,
            ACS_VINTAGE,
            owner,
            renter,
            nullify(a.get("B19013_001E")),
            nullify(a.get("B25064_001E")),
            cost_burden_pct,
            median_age,
            pct(youth,   total_pop),
            pct(seniors, total_pop),
            pct(prime,   total_pop),
            pct(nullify(a.get("B03002_003E")), race_total),  # white
            pct(nullify(a.get("B03002_004E")), race_total),  # black
            pct(nullify(a.get("B03002_012E")), race_total),  # hispanic
            pct(nullify(a.get("B03002_006E")), race_total),  # asian
            transit_pct,
        ))

    # --- Upsert ---
    with conn.cursor() as cur:
        execute_values(cur, """
            insert into census_block_groups (
              geoid, geom, acs_vintage, owner_occ, renter_occ,
              median_hh_income, median_gross_rent, cost_burden_pct,
              median_age, youth_pct, senior_pct, prime_pct,
              white_pct, black_pct, hispanic_pct, asian_pct,
              transit_pct
            )
            values %s
            on conflict (geoid) do update set
              geom              = excluded.geom,
              acs_vintage       = excluded.acs_vintage,
              owner_occ         = excluded.owner_occ,
              renter_occ        = excluded.renter_occ,
              median_hh_income  = excluded.median_hh_income,
              median_gross_rent = excluded.median_gross_rent,
              cost_burden_pct   = excluded.cost_burden_pct,
              median_age        = excluded.median_age,
              youth_pct         = excluded.youth_pct,
              senior_pct        = excluded.senior_pct,
              prime_pct         = excluded.prime_pct,
              white_pct         = excluded.white_pct,
              black_pct         = excluded.black_pct,
              hispanic_pct      = excluded.hispanic_pct,
              asian_pct         = excluded.asian_pct,
              transit_pct       = excluded.transit_pct
        """, [(
            r[0],
            f"SRID=4326;{r[1]}",  # WKT with SRID
            *r[2:]
        ) for r in records])
    conn.commit()
    print(f"  ✓ Upserted {len(records)} block groups")


# ---------------------------------------------------------------------------
# 2. Blocks: geometry (TIGERweb) + Decennial DHC headcounts
# ---------------------------------------------------------------------------

def load_blocks(conn):
    print("\n=== Blocks ===")

    # --- Geometries from TIGERweb REST API (avoids 408 MB state shapefile) ---
    print("  Fetching block geometries from TIGERweb …")
    base = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/2/query"
    offset = 0
    page_size = 5000
    features = []
    while True:
        r = requests.get(base, params={
            "where": f"COUNTY='{COUNTY}' AND STATE='{STATE}'",
            "outFields": "GEOID,AREALAND",
            "geometryType": "esriGeometryPolygon",
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": page_size,
        }, timeout=120)
        r.raise_for_status()
        data = r.json()
        batch = data.get("features", [])
        features.extend(batch)
        print(f"    …{len(features)} blocks retrieved")
        if len(batch) < page_size:
            break
        offset += page_size
        time.sleep(0.5)

    # Build GEOID → geometry mapping
    geom_map = {}
    for f in features:
        geoid = f["properties"].get("GEOID", "").strip()
        if geoid:
            geom_map[geoid] = f["geometry"]
    print(f"  {len(geom_map)} block geometries")

    # --- Decennial DHC headcounts (P1, P9, H1) ---
    # Fetch all tracts in Travis County first, then query blocks per tract
    print("  Fetching Decennial 2020 block headcounts …")
    dec_vars = "P1_001N,H1_001N,P9_002N,P9_006N,P9_012N"
    # Census API allows block:* within a single tract, so we need to loop tracts
    tracts_r = census_get(
        f"https://api.census.gov/data/2020/dec/dhc",
        params={
            "get": "NAME",
            "for": "tract:*",
            "in": f"state:{STATE} county:{COUNTY}",
            "key": CENSUS_KEY,
        },
    )
    tract_ids = [r["tract"] for r in tracts_r]
    print(f"  {len(tract_ids)} tracts to query …")

    dec_data = {}
    for i, tract in enumerate(tract_ids):
        if i % 50 == 0:
            print(f"    tract {i}/{len(tract_ids)} …")
        try:
            rows = census_get(
                f"https://api.census.gov/data/2020/dec/dhc",
                params={
                    "get": dec_vars,
                    "for": "block:*",
                    "in": f"state:{STATE} county:{COUNTY} tract:{tract}",
                    "key": CENSUS_KEY,
                },
            )
            for r in rows:
                geoid = r["state"] + r["county"] + r["tract"] + r["block"]
                dec_data[geoid] = r
        except Exception as e:
            print(f"    ⚠ tract {tract}: {e}")
        time.sleep(0.05)  # be polite to Census API

    print(f"  {len(dec_data)} block headcount rows")

    # --- Build records ---
    # Use the intersection of geometries + headcounts
    all_geoids = set(geom_map) | set(dec_data)
    records = []
    for geoid in all_geoids:
        geom = geom_map.get(geoid)
        d = dec_data.get(geoid, {})
        if geom is None:
            continue  # skip if no geometry (e.g., water blocks)

        # Convert ArcGIS GeoJSON geometry to WKT via shapely
        from shapely.geometry import shape
        shp = shape(geom)
        if shp.is_empty:
            continue
        if shp.geom_type == "Polygon":
            from shapely.geometry import MultiPolygon
            shp = MultiPolygon([shp])

        total_pop     = nullify(d.get("P1_001N"))
        housing_units = nullify(d.get("H1_001N"))
        # P9: Hispanic origin table — _002 non-Hispanic, _006 non-Hisp Black alone, _012 Hispanic
        pop_white = None  # Not in block-level P9; would need P3
        pop_black = nullify(d.get("P9_006N"))
        pop_hisp  = nullify(d.get("P9_012N"))

        records.append((
            geoid,
            f"SRID=4326;{shp.wkt}",
            total_pop,
            housing_units,
            None,          # occupied_units (not in DHC P1/H1 at block level)
            None,          # vacant_units
            pop_white,
            pop_black,
            pop_hisp,
            None,          # pop_asian (not in P9)
        ))

    # --- Upsert ---
    with conn.cursor() as cur:
        execute_values(cur, """
            insert into census_blocks (
              geoid, geom, total_pop, housing_units,
              occupied_units, vacant_units,
              pop_white, pop_black, pop_hisp, pop_asian
            )
            values %s
            on conflict (geoid) do update set
              geom           = excluded.geom,
              total_pop      = excluded.total_pop,
              housing_units  = excluded.housing_units,
              occupied_units = excluded.occupied_units,
              vacant_units   = excluded.vacant_units,
              pop_white      = excluded.pop_white,
              pop_black      = excluded.pop_black,
              pop_hisp       = excluded.pop_hisp,
              pop_asian      = excluded.pop_asian
        """, records)
    conn.commit()
    print(f"  ✓ Upserted {len(records)} blocks")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Connecting to database …")
    conn = psycopg2.connect(DATABASE_URL)
    try:
        load_block_groups(conn)
        load_blocks(conn)
        print("\n✓ Census ingest complete.")
    finally:
        conn.close()
