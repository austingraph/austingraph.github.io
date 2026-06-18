# Aerial Compliance-Detection Pipeline (blueprint)

**Goal:** From high-res GeoTIFF aerials + TCAD parcel data, detect likely
compliance issues (unpermitted structures, setback / lot-coverage / impervious-cover
violations) and produce a defensible, cited writeup per parcel.

**Decisions locked:**
- First focus = **compliance detection**.
- Reasoning/writeups = **Anthropic (Claude)**, with self-hosted geometry models
  for measurement.

This is a research/prototyping effort. Most real work happens in a *new* session;
this document is the blueprint.

## Why a hybrid (not VLM-only)

VLMs are excellent at *semantic* questions ("there's a pool + detached ADU") but
unreliable at *metric* ones ("3.2 ft from the property line"). Compliance needs
metric proof, so:

- **Geometry (precise):** SAM 2 / GroundingDINO → footprint polygons → overlay
  parcel + zoning → measure coverage/setbacks in PostGIS.
- **Semantics (context):** Claude vision → "what is this, is it consistent with the
  permit record, what's suspicious."
- **Output:** Claude → compliance narrative citing the measured numbers.

## Inputs to gather

1. **Aerials:** CAPCOG GeoTIFFs (3-inch West Lake Hills / 6-inch Austin) from
   data.tnris.org 2020 collection; NAIP 2022 as a lower-res complement.
2. **Parcels:** TCAD boundaries (already in Supabase) + 2026 preliminary appraisal
   roll (land/improvement/year-built) once ingested.
3. **Zoning:** City of Austin zoning layer (GeoHub) for setback/coverage rules.
4. **Permits:** Austin open-data permit records (to flag unpermitted structures).

## Pipeline steps

1. **Tiling:** rasterio + geopandas → clip GeoTIFF to each parcel polygon, export
   per-parcel image chips (RGB and, where available, the IR band for NDVI
   vegetation/impervious split).
2. **Footprint segmentation:** run SAM 2 on each chip → building/driveway/pool
   polygons; georeference back to map coords.
3. **Metric checks (PostGIS):** lot coverage %, impervious %, distance from each
   footprint edge to parcel boundary (setbacks); compare to a zoning rule table →
   boolean flags + magnitudes.
4. **Permit cross-check:** spatial join detected footprints vs permitted structures
   → "structure with no matching permit" flag.
5. **Claude semantic + writeup pass:** send chip + measured metrics + permit context
   → structured JSON (issue type, severity, confidence) + a human-readable narrative
   that cites the numbers (never invents measurements).
6. **Store/serve:** results table in Supabase (PostGIS); optionally surface in the
   austingraph map as a parcel overlay.

## Suggested stack

- **Python notebook (Jupyter):** rasterio, geopandas, shapely, scikit-image.
- **Segmentation:** SAM 2 (self-hosted GPU) or GroundingDINO for prompted detection.
- **Reasoning/writeups:** Claude (Sonnet for bulk, Opus for final narratives) via the
  Anthropic API, using tool-use to pass measured metrics as structured input.
- **Storage:** Supabase + PostGIS; serve via Edge Function / FastAPI.

## First milestone (do in the new session, small + cheap)

1. Download a handful of 2020 3-inch Travis tiles for a known block.
2. Tile to 5–10 parcels using existing TCAD boundaries.
3. Run SAM 2 on those chips; eyeball footprint quality.
4. Hand-compute lot coverage for one parcel; verify against a Claude writeup pass.
   Decide if SAM quality is good enough before building the full pipeline.

## Notes / open items for the new session

- Confirm whether a newer CAPCOG vintage (2021+) is downloadable on
  data.geographic.texas.gov before settling on 2020.
- Nano Banana (Gemini 2.5 Flash Image) is deferred to the *scenario visualization*
  track (rendering buildouts), not this compliance track.
- **Legal/ToS:** compliance flags are advisory; keep imagery vintage + capture date
  in every writeup so conclusions are time-stamped.
</content>
</invoke>
