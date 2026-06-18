# Pipeline scaffolding

Stubs for the compliance-detection pipeline. These define the **interfaces and
data contract** so the build session can fill in implementations one stage at a
time. Nothing here is wired to run automatically — the GitHub Action that calls
it is a no-op until secrets are set (see top-level README → *How it works*).

Stage order (each consumes the previous stage's output):

| File | Stage | Input → Output |
|---|---|---|
| `tile.py` | Tiling | GeoTIFF + TCAD polygon → per-parcel RGB/IR chips |
| `segment.py` | Footprints | chip → georeferenced building/driveway/pool polygons (SAM 2, GPU) |
| `measure.py` | Metrics | footprints + parcel + zoning → coverage %, impervious %, setbacks (PostGIS) |
| `permit_check.py` | Cross-check | footprints vs Austin permits → unpermitted-structure flags |
| `writeup.py` | Reasoning | chip + measurements + permits → Claude → cited JSON finding |

First milestone (from `../PLAN.md`): run `tile.py` → `segment.py` on 5–10 parcels
of a known block, hand-compute lot coverage for one, and verify a `writeup.py`
pass against it before building the rest.

## Environment

```
ANTHROPIC_API_KEY   # writeup.py
DATABASE_URL        # measure.py, permit_check.py (Supabase / PostGIS)
```

`writeup.py` is the only stage with a concrete reference implementation, because
the Claude call shape (structured outputs, prompt caching on the shared rulebook,
the "cite, never invent" system prompt) is the part most worth pinning down
early. The geometry stages are intentionally left as typed stubs.
