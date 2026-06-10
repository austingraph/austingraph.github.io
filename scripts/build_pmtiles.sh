#!/usr/bin/env bash
# build_pmtiles.sh — export parcels from Supabase, build PMTiles, upload to Storage.
#
# Prerequisites (set as env vars or edit inline):
#   DATABASE_URL      — postgresql://postgres:PASSWORD@db.aqbyxpiwugcvoephsvpm.supabase.co:5432/postgres
#   SUPABASE_SERVICE_KEY — service_role key (never commit this)
#
# Usage:
#   DATABASE_URL="postgresql://postgres:YOURPASSWORD@db.aqbyxpiwugcvoephsvpm.supabase.co:5432/postgres" \
#   SUPABASE_SERVICE_KEY="your-service-role-key" \
#   ./scripts/build_pmtiles.sh

set -euo pipefail

SUPABASE_URL="https://aqbyxpiwugcvoephsvpm.supabase.co"
OUTPUT="/tmp/parcels.pmtiles"
NDJSON="/tmp/parcels.ndjson"

: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${SUPABASE_SERVICE_KEY:?SUPABASE_SERVICE_KEY must be set}"

# ── 1. Install tippecanoe if not present ──────────────────────────────────────
if ! command -v tippecanoe &>/dev/null; then
  echo "Installing tippecanoe via go install..."
  go install github.com/felt/tippecanoe@latest
  export PATH="$PATH:$(go env GOPATH)/bin"
fi

# ── 2. Export parcels as newline-delimited GeoJSON ────────────────────────────
echo "Exporting parcels to ${NDJSON}..."
psql "$DATABASE_URL" -f "$(dirname "$0")/export_parcels.sql"
echo "Exported $(wc -l < "$NDJSON") parcels."

# ── 3. Build PMTiles ──────────────────────────────────────────────────────────
echo "Building PMTiles..."
# Tile-size caps matter: unlimited tiles reach ~3 MB at z10 (all 375k
# parcels in a handful of tiles) and stall the browser on first paint.
tippecanoe \
  -o "$OUTPUT" \
  --force \
  --minimum-zoom=10 \
  --maximum-zoom=14 \
  --drop-densest-as-needed \
  --coalesce-densest-as-needed \
  --detect-shared-borders \
  --simplification=10 \
  --maximum-tile-bytes=300000 \
  --layer=parcels \
  "$NDJSON"

echo "Built $(du -sh "$OUTPUT" | cut -f1) PMTiles file."

# ── 4. Upload to Supabase Storage (public bucket: tiles) ──────────────────────
echo "Uploading to Supabase Storage..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${SUPABASE_URL}/storage/v1/object/tiles/parcels.pmtiles" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${OUTPUT}")

if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "201" ]; then
  echo "Upload succeeded (HTTP $HTTP_STATUS)."
  echo "PMTiles URL: ${SUPABASE_URL}/storage/v1/object/public/tiles/parcels.pmtiles"
else
  # Try upsert if object already exists
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT "${SUPABASE_URL}/storage/v1/object/tiles/parcels.pmtiles" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
    -H "Content-Type: application/octet-stream" \
    -H "x-upsert: true" \
    --data-binary "@${OUTPUT}")
  if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "201" ]; then
    echo "Upsert succeeded (HTTP $HTTP_STATUS)."
    echo "PMTiles URL: ${SUPABASE_URL}/storage/v1/object/public/tiles/parcels.pmtiles"
  else
    echo "Upload failed (HTTP $HTTP_STATUS). Create the 'tiles' public bucket in Supabase Storage first."
    exit 1
  fi
fi
