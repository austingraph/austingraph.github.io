#!/usr/bin/env python3
"""
scripts/ingest/load_tcad_appraisal.py

Downloads the TCAD appraisal roll ZIP from traviscad.org, parses the
fixed-width export files, and upserts appraisal/owner/improvement data
into public.parcels via a direct Postgres connection.

Usage:
  python3 load_tcad_appraisal.py [--year 2026|2025] [--url URL] [--inspect] [--dry-run]

  --year      Which roll to download (default: 2026)
  --url       Override the download URL entirely
  --inspect   List files in the ZIP and print 3 sample rows; do NOT write to DB
  --dry-run   Parse fully and report counts; do NOT write to DB

Environment:
  DATABASE_URL          Supabase session-pooler Postgres connection string (service role)

Field layout source: Website_Legacy8.0.32-AppraisalExportLayout.xlsx (TCAD public)
  APPRAISAL_INFO.TXT   (short: PROP.TXT)         — property values & owner
  APPRAISAL_IMPROVEMENT_DETAIL.TXT (IMP_DET.TXT) — yr_built, improvement area
"""

import argparse
import io
import os
import sys
import tempfile
import time
import urllib.request
import zipfile

# ── Field positions (1-indexed start, 1-indexed end) from layout XLSX ────────
# All come from the "Property" sheet (APPRAISAL_INFO.TXT / PROP.TXT).
# Python slice: line[start-1 : end]
P = {
    "prop_id":          (1,  12),
    "prop_type_cd":     (13, 17),
    "prop_val_yr":      (18, 22),
    "py_owner_name":    (609, 678),
    "py_addr_state":    (924, 973),
    "land_hstd_val":    (1796, 1810),
    "land_non_hstd_val":(1811, 1825),
    "imprv_hstd_val":   (1826, 1840),
    "imprv_non_hstd_val":(1841, 1855),
    "ag_use_val":       (1856, 1870),
    "ag_market":        (1871, 1885),
    "appraised_val":    (1916, 1930),
    "ten_percent_cap":  (1931, 1945),
    "assessed_val":     (1946, 1960),
    "market_value":     (4214, 4227),
    # Exemption flags — 'T' = True, 'F' / ' ' = False
    "hs_exempt":        (2609, 2609),
    "ov65_exempt":      (2610, 2610),
    "ov65s_exempt":     (2661, 2661),
    "dp_exempt":        (2662, 2662),
    "dv1_exempt":       (2663, 2663),   # 10-30%
    "dv2_exempt":       (2665, 2665),   # 31-50%
    "dv3_exempt":       (2667, 2667),   # 51-70%
    "dv4_exempt":       (2669, 2669),   # 71-100%
    "dvhs_exempt":      (7184, 7184),   # 100% DV homestead
    "ab_exempt":        (2723, 2723),   # Abatement
    "ex_exempt":        (2671, 2671),   # Total exemption
}

# ImprovementDetail (APPRAISAL_IMPROVEMENT_DETAIL.TXT / IMP_DET.TXT)
# Positions computed from layout (Excel formulas resolved manually).
D = {
    "prop_id":          (1,  12),
    "prop_val_yr":      (13, 16),
    "imprv_id":         (17, 28),
    "imprv_det_id":     (29, 40),
    "type_cd":          (41, 50),
    "type_desc":        (51, 75),
    "class_cd":         (76, 85),
    "yr_built":         (86, 89),
    "imprv_det_area":   (94, 108),
}

# ── Download URLs ─────────────────────────────────────────────────────────────
URLS = {
    "2026": "https://traviscad.org/wp-content/largefiles/2026%20Preliminary%20Appraisal%20Export%20Supp%200_06092026.zip",
    "2025": "https://traviscad.org/wp-content/largefiles/2025%20Certified%20Appraisal%20Export%20Supp%200_07202025.zip",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; austingraph-ingest/1.0)",
    "Referer": "https://traviscad.org/publicinformation",
}

BATCH = 1000


def fld(line, spec, key):
    s, e = spec[key]
    return line[s - 1: e]


def int_fld(line, spec, key, default=0):
    try:
        v = fld(line, spec, key).strip()
        return int(v) if v else default
    except ValueError:
        return default


def flag(line, spec, key):
    return fld(line, spec, key).strip().upper() == "T"


# ── Streaming download ────────────────────────────────────────────────────────
def download(url, dest):
    print(f"Downloading {url} …", flush=True)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as out:
        total = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            total += len(chunk)
            print(f"  {total / 1e6:.1f} MB", end="\r", flush=True)
    print(f"\n  done ({total / 1e6:.1f} MB)")


# ── Find file in ZIP by pattern ───────────────────────────────────────────────
def find_file(zf, *patterns):
    names = zf.namelist()
    for pat in patterns:
        pat_up = pat.upper()
        for name in names:
            if pat_up in name.upper():
                return name
    return None


# ── Parse APPRAISAL_IMPROVEMENT_DETAIL.TXT ───────────────────────────────────
def load_impr_detail(zf, fname, target_yr):
    """Return dict: prop_id_str → (yr_built, total_area)."""
    print(f"  Parsing {fname} …", flush=True)
    result = {}
    with zf.open(fname) as fh:
        for raw in io.TextIOWrapper(fh, encoding="latin-1", errors="replace"):
            line = raw.rstrip("\r\n")
            if len(line) < D["imprv_det_area"][1]:
                continue
            yr = fld(line, D, "prop_val_yr").strip()
            if yr and yr != str(target_yr):
                continue
            pid_raw = fld(line, D, "prop_id").strip()
            if not pid_raw:
                continue
            try:
                pid = str(int(pid_raw))
            except ValueError:
                continue
            yr_built_raw = fld(line, D, "yr_built").strip()
            area_raw = fld(line, D, "imprv_det_area").strip()
            try:
                yr_built = int(yr_built_raw) if yr_built_raw and yr_built_raw != "0" else None
            except ValueError:
                yr_built = None
            try:
                area = int(float(area_raw)) if area_raw else 0
            except ValueError:
                area = 0
            if pid in result:
                existing_yr, existing_area = result[pid]
                new_yr = min(filter(None, [existing_yr, yr_built])) if (existing_yr or yr_built) else None
                result[pid] = (new_yr, existing_area + area)
            else:
                result[pid] = (yr_built, area)
    print(f"  Improvement details: {len(result):,} properties", flush=True)
    return result


# ── Parse APPRAISAL_INFO.TXT and yield rows ───────────────────────────────────
def iter_property_rows(zf, fname, target_yr, impr_map):
    min_len = P["market_value"][1]
    with zf.open(fname) as fh:
        for raw in io.TextIOWrapper(fh, encoding="latin-1", errors="replace"):
            line = raw.rstrip("\r\n")
            if len(line) < min_len:
                continue

            prop_type = fld(line, P, "prop_type_cd").strip()
            if prop_type not in ("R", "M"):   # Real + Mobile Home
                continue

            yr = fld(line, P, "prop_val_yr").strip()
            if yr and int(yr) != target_yr:   # field is 5-char "02026"; compare as int
                continue

            pid_raw = fld(line, P, "prop_id").strip()
            if not pid_raw:
                continue
            try:
                pid = str(int(pid_raw))
            except ValueError:
                continue

            # Values
            market_val = int_fld(line, P, "market_value")
            land_val = int_fld(line, P, "land_hstd_val") + int_fld(line, P, "land_non_hstd_val")
            impr_val = int_fld(line, P, "imprv_hstd_val") + int_fld(line, P, "imprv_non_hstd_val")
            appraised_val = int_fld(line, P, "appraised_val")
            assessed_val = int_fld(line, P, "assessed_val")

            # If ag land, market_value reflects FMV; use it.
            # For non-ag, market_value == land_val + impr_val (they should agree).
            if market_val == 0:
                market_val = land_val + impr_val

            # Owner
            owner_name = fld(line, P, "py_owner_name").strip()
            owner_state_raw = fld(line, P, "py_addr_state").strip()
            # Normalize state: take first token, map "Texas" → "TX"
            if owner_state_raw:
                first = owner_state_raw.split()[0].upper() if owner_state_raw else ""
                if first in ("TEXAS", "TEXA"):
                    owner_state = "TX"
                elif len(first) == 2 and first.isalpha():
                    owner_state = first
                else:
                    owner_state = owner_state_raw[:2].upper() if len(owner_state_raw) >= 2 else owner_state_raw
            else:
                owner_state = None

            # Exemptions
            exemptions = []
            if flag(line, P, "hs_exempt"):
                exemptions.append("HS")
            if flag(line, P, "ov65_exempt") or flag(line, P, "ov65s_exempt"):
                exemptions.append("OV65")
            if flag(line, P, "dp_exempt"):
                exemptions.append("DP")
            if any(flag(line, P, k) for k in ("dv1_exempt", "dv2_exempt", "dv3_exempt", "dv4_exempt", "dvhs_exempt")):
                exemptions.append("VET")
            if int_fld(line, P, "ag_use_val") > 0:
                exemptions.append("AG")
            if flag(line, P, "ab_exempt"):
                exemptions.append("AB")
            if flag(line, P, "ex_exempt"):
                exemptions.append("EX")

            # Improvement detail (yr_built + area)
            impr_yr, impr_area = impr_map.get(pid, (None, None))

            yield {
                "parcel_id":        pid,
                "appr_market_val":  market_val or None,
                "appr_land_val":    land_val or None,
                "appr_impr_val":    impr_val or None,
                "appr_assessed_val": assessed_val or None,
                "appr_taxable_val": assessed_val or None,
                "appr_exemptions":  exemptions if exemptions else None,
                "appr_yr_built":    impr_yr,
                "appr_living_sqft": impr_area or None,
                "appr_owner_name":  owner_name or None,
                "appr_owner_state": owner_state,
                "appr_data_yr":     int(yr) if yr else target_yr,
            }


# ── DB upsert ─────────────────────────────────────────────────────────────────
def upsert_batch(conn, batch):
    sql = """
        update public.parcels set
          appr_market_val   = %(appr_market_val)s,
          appr_land_val     = %(appr_land_val)s,
          appr_impr_val     = %(appr_impr_val)s,
          appr_assessed_val = %(appr_assessed_val)s,
          appr_taxable_val  = %(appr_taxable_val)s,
          appr_exemptions   = %(appr_exemptions)s,
          appr_yr_built     = %(appr_yr_built)s,
          appr_living_sqft  = %(appr_living_sqft)s,
          appr_owner_name   = %(appr_owner_name)s,
          appr_owner_state  = %(appr_owner_state)s,
          appr_data_yr      = %(appr_data_yr)s
        where parcel_id = %(parcel_id)s
    """
    with conn.cursor() as cur:
        cur.executemany(sql, batch)
    conn.commit()


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", default="2026", choices=sorted(URLS), help="Roll year (default: 2026)")
    ap.add_argument("--url", help="Override download URL")
    ap.add_argument("--inspect", action="store_true", help="List files and print 3 sample rows; don't write")
    ap.add_argument("--dry-run", action="store_true", help="Parse fully, print counts; don't write")
    args = ap.parse_args()

    url = args.url or URLS.get(args.year)
    if not url:
        sys.exit(f"No URL for year {args.year}; use --url to override")

    dry = args.dry_run or args.inspect

    if not dry:
        DATABASE_URL = os.environ.get("DATABASE_URL")
        if not DATABASE_URL:
            sys.exit("DATABASE_URL is not set (Supabase session-pooler connection string, service role)")
        import psycopg
        conn = psycopg.connect(DATABASE_URL, autocommit=False)
        print("Connected to database", flush=True)

    # Download
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        tmppath = tmp.name
    try:
        download(url, tmppath)

        with zipfile.ZipFile(tmppath) as zf:
            names = zf.namelist()
            print(f"\nFiles in ZIP ({len(names)}):")
            for n in names:
                info = zf.getinfo(n)
                print(f"  {n:60s} {info.file_size / 1e6:8.2f} MB")

            prop_file = find_file(zf, "APPRAISAL_INFO", "PROP.TXT")
            impr_file = find_file(zf, "IMPROVEMENT_DETAIL", "IMP_DET.TXT")

            if args.inspect:
                for label, fname in [("PROPERTY", prop_file), ("IMPR DETAIL", impr_file)]:
                    if not fname:
                        print(f"\n{label}: file not found")
                        continue
                    print(f"\n=== {label}: {fname} — first 3 rows ===")
                    with zf.open(fname) as fh:
                        for i, raw in enumerate(io.TextIOWrapper(fh, encoding="latin-1", errors="replace")):
                            if i >= 3:
                                break
                            print(repr(raw[:200]))
                return

            if not prop_file:
                sys.exit("Cannot find APPRAISAL_INFO.TXT / PROP.TXT in ZIP. Run --inspect to list files.")

            target_yr = int(args.year)

            # Load improvement details first (smaller file)
            impr_map = {}
            if impr_file:
                impr_map = load_impr_detail(zf, impr_file, target_yr)
            else:
                print("WARNING: IMP_DET.TXT not found; yr_built and area will be null", flush=True)

            # Stream property file, batch upsert
            print(f"\nParsing {prop_file} …", flush=True)
            batch = []
            total = updated = 0
            t0 = time.time()

            for row in iter_property_rows(zf, prop_file, target_yr, impr_map):
                total += 1
                if dry:
                    if total <= 3:
                        print(row)
                    continue
                batch.append(row)
                if len(batch) >= BATCH:
                    upsert_batch(conn, batch)
                    updated += len(batch)
                    batch = []
                    if updated % 10000 == 0:
                        elapsed = time.time() - t0
                        print(f"  {updated:,} rows updated ({elapsed:.0f}s)", flush=True)

            if not dry and batch:
                upsert_batch(conn, batch)
                updated += len(batch)

    finally:
        try:
            os.unlink(tmppath)
        except OSError:
            pass

    elapsed = time.time() - t0
    if dry:
        print(f"\nDry run: parsed {total:,} real-property rows in {elapsed:.1f}s (no DB writes)")
    else:
        print(f"\nDone: {updated:,} parcels updated in {elapsed:.1f}s")
        conn.close()


if __name__ == "__main__":
    main()
