#!/usr/bin/env python3
"""
scripts/ingest/load_tcad_ears_history.py

Loads PRIOR-YEAR appraisal values into public.parcel_appraisal_history from
TCAD's free EARS (Electronic Appraisal Roll Submission) files, so the report can
show a value-over-time trend. Phase C of the value-representation work.

The current/most-recent roll is loaded by load_tcad_appraisal.py (PACS export).
Older years (2021-2024) are only published as EARS — the Texas Comptroller's PTD
format: a nested ZIP containing one big CSV of "AJR" records (one per property ×
category × taxing unit). Column order is the AJR record layout (Appendix 1 of the
Comptroller's "Electronic Appraisal Roll Submission Record Layout" manual):

  [0]  AJR01 Record Type ('AJR'; file also has AUD/TU2 records we skip)
  [1]  AJR02 PVS Year
  [7]  AJR08 Short Account  -> parcel_id
  [30] AJR31 Category (e.g. A1, F1)            -> dedup key with parcel_id
  [34] AJR35 Land Market Value (before cap)
  [35] AJR36 Improvement Market Value (before cap)
  [36] AJR37 Mineral Market Value (before cap)
  [37] AJR38 Personal Property Market Value (before cap)
  [66] AJR67 Cap on Homestead Increase Amount  -> homestead cap loss

Per parcel: market = sum over its categories of (land+impr+mineral+pp);
appraised = market - cap_loss. Rows repeat per taxing unit, so we dedup by
(parcel_id, category) before summing. Column mapping verified against the 2024
file (parcel 100008 = $4,331,821 market, $0 cap).

Usage:
  python3 load_tcad_ears_history.py --year 2024 [--inspect|--dry-run]
  python3 load_tcad_ears_history.py --year 2024 --zip local.zip --dry-run

Environment:
  DATABASE_URL  Supabase session-pooler Postgres connection string (service role)
"""

import argparse
import csv
import io
import os
import sys
import tempfile
import time
import urllib.request
import zipfile

# ── EARS download URLs (TCAD public information page) ──────────────────────────
URLS = {
    "2021": "https://traviscad.org/wp-content/largefiles/2021EARS092521.zip",
    "2022": "https://traviscad.org/wp-content/largefiles/227EARS092822%20%282%29.zip",
    "2023": "https://traviscad.org/wp-content/largefiles/227EARS082923%20%282%29.zip",
    "2024": "https://traviscad.org/wp-content/largefiles/227EARS082824%20%282%29.zip",
    "2025": "https://traviscad.org/wp-content/largefiles/227EARS090425.zip",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; austingraph-ingest/1.0)",
    "Referer": "https://traviscad.org/publicinformation",
}

# AJR column indices (0-based)
C_TYPE, C_YEAR, C_PID, C_CAT = 0, 1, 7, 30
C_LAND, C_IMPR, C_MIN, C_PP, C_CAP = 34, 35, 36, 37, 66
MIN_COLS = C_CAP + 1
BATCH = 1000


def download(url, dest):
    print(f"Downloading {url} …", flush=True)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=180) as resp, open(dest, "wb") as out:
        total = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            total += len(chunk)
            print(f"  {total / 1e6:.1f} MB", end="\r", flush=True)
    print(f"\n  done ({total / 1e6:.1f} MB)")


def open_ears_csv(zip_path):
    """Return a text stream over the AJR CSV nested inside the EARS package.

    Outer ZIP holds PDFs + one inner ZIP; the inner ZIP holds one .csv.
    """
    outer = zipfile.ZipFile(zip_path)
    # The package holds small PTD-report zips plus the big AJR-roll zip; pick the
    # LARGEST .zip entry (the appraisal roll is by far the biggest).
    zips = sorted((i for i in outer.infolist() if i.filename.lower().endswith(".zip")),
                  key=lambda i: i.file_size, reverse=True)
    if not zips:
        sys.exit("No inner .zip found in the EARS package. Contents: "
                 + ", ".join(outer.namelist()))
    inner_name = zips[0].filename
    inner = zipfile.ZipFile(io.BytesIO(outer.read(inner_name)))
    csvs = sorted((i for i in inner.infolist() if i.filename.lower().endswith(".csv")),
                  key=lambda i: i.file_size, reverse=True)
    if not csvs:
        sys.exit("No .csv found inside " + inner_name + ". Contents: "
                 + ", ".join(inner.namelist()))
    csv_name = csvs[0].filename
    print(f"  EARS data file: {inner_name} -> {csv_name}", flush=True)
    return io.TextIOWrapper(inner.open(csv_name), encoding="latin-1", errors="replace")


def aggregate(stream, target_yr):
    """Stream AJR rows → per-parcel aggregated values.

    Dedup by (parcel_id, category) so per-taxing-unit/fund repeats aren't summed,
    then sum across a parcel's categories. Returns {pid: {market,land,impr,cap}}.
    """
    seen = set()                 # (pid, category) already counted
    agg = {}
    rows = ajr = 0
    for rec in csv.reader(stream):
        rows += 1
        if not rec or rec[0] != "AJR" or len(rec) < MIN_COLS:
            continue
        if rec[C_YEAR].strip() != str(target_yr):
            continue
        pid_raw = rec[C_PID].strip()
        if not pid_raw:
            continue
        try:
            pid = str(int(pid_raw))
        except ValueError:
            continue
        key = (pid, rec[C_CAT].strip())
        if key in seen:
            continue
        seen.add(key)
        ajr += 1

        def num(i):
            try:
                return int(float(rec[i] or 0))
            except (ValueError, IndexError):
                return 0

        land = num(C_LAND); impr = num(C_IMPR)
        market = land + impr + num(C_MIN) + num(C_PP)
        cap = num(C_CAP)
        a = agg.get(pid)
        if a is None:
            agg[pid] = {"market": market, "land": land, "impr": impr, "cap": cap}
        else:
            a["market"] += market; a["land"] += land; a["impr"] += impr; a["cap"] += cap
    print(f"  Parsed {rows:,} rows; {ajr:,} unique (parcel, category) for {target_yr}; "
          f"{len(agg):,} parcels", flush=True)
    return agg


HIST_SQL = """
    insert into public.parcel_appraisal_history
      (parcel_id, yr, market_val, land_val, impr_val,
       appraised_val, assessed_val, taxable_val, cap_loss)
    select %(parcel_id)s, %(yr)s, %(market)s, %(land)s, %(impr)s,
           %(appraised)s, %(appraised)s, %(appraised)s, %(cap)s
    where exists (select 1 from public.parcels where parcel_id = %(parcel_id)s)
    on conflict (parcel_id, yr) do update set
      market_val    = excluded.market_val,
      land_val      = excluded.land_val,
      impr_val      = excluded.impr_val,
      appraised_val = excluded.appraised_val,
      assessed_val  = excluded.assessed_val,
      taxable_val   = excluded.taxable_val,
      cap_loss      = excluded.cap_loss
"""


def upsert(conn, batch):
    with conn.cursor() as cur:
        cur.executemany(HIST_SQL, batch)
    conn.commit()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", default="2024", choices=sorted(URLS))
    ap.add_argument("--url", help="Override the download URL")
    ap.add_argument("--zip", help="Use a local EARS zip instead of downloading")
    ap.add_argument("--inspect", action="store_true", help="Show record types + 3 sample parcels; no write")
    ap.add_argument("--dry-run", action="store_true", help="Parse + aggregate, report counts; no write")
    args = ap.parse_args()
    dry = args.dry_run or args.inspect
    target_yr = int(args.year)

    conn = None
    if not dry:
        db = os.environ.get("DATABASE_URL")
        if not db:
            sys.exit("DATABASE_URL is not set")
        import psycopg
        conn = psycopg.connect(db, autocommit=False)
        print("Connected to database", flush=True)

    tmp = None
    try:
        if args.zip:
            zip_path = args.zip
        else:
            tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False).name
            download(args.url or URLS[args.year], tmp)
            zip_path = tmp

        t0 = time.time()
        agg = aggregate(open_ears_csv(zip_path), target_yr)

        if args.inspect or args.dry_run:
            sample = list(agg.items())[:3]
            for pid, a in sample:
                print(f"  {pid}: market={a['market']:,} land={a['land']:,} "
                      f"impr={a['impr']:,} cap_loss={a['cap']:,} "
                      f"appraised={a['market'] - a['cap']:,}")
            print(f"\nDry run: {len(agg):,} parcels for {target_yr} in {time.time() - t0:.1f}s (no DB writes)")
            return

        batch, n = [], 0
        for pid, a in agg.items():
            batch.append({"parcel_id": pid, "yr": target_yr,
                          "market": a["market"] or None, "land": a["land"] or None,
                          "impr": a["impr"] or None, "cap": a["cap"] or None,
                          "appraised": (a["market"] - a["cap"]) or None})
            if len(batch) >= BATCH:
                upsert(conn, batch); n += len(batch); batch = []
                if n % 50000 == 0:
                    print(f"  {n:,} history rows written ({time.time() - t0:.0f}s)", flush=True)
        if batch:
            upsert(conn, batch); n += len(batch)
        print(f"\nDone: wrote {n:,} history rows for {target_yr} in {time.time() - t0:.1f}s")
        conn.close()
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


if __name__ == "__main__":
    main()
