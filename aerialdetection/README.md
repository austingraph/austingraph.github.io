# Aerial Compliance Detection

Detecting likely **code violations and bad planning** across Austin / Travis
County by measuring high-resolution aerial imagery against the 374k-parcel TCAD
database, and producing a **defensible, cited writeup per parcel** authored by
Claude.

This folder is the project home. It is served as a page and is where all of this
project's work lives.

- **Live page:** `https://austingraph.chat/aerialdetection/` (once the domain /
  Pages path is confirmed — see *Publishing* below).
- **Blueprint:** [`PLAN.md`](PLAN.md) — the locked plan and first milestone.
- **Architecture:** [`ARCHITECTURE.md`](ARCHITECTURE.md) — how Claude (API,
  skills, MCP, Managed Agents) fits the geometry pipeline.

## Folder layout

```
aerialdetection/
├── index.html              landing / findings dashboard (self-contained, dark theme)
├── style.css               page styling (no dependency on the root site)
├── app.js                  loads data/results.sample.json and renders finding cards
├── PLAN.md                 the blueprint (locked decisions + first milestone)
├── ARCHITECTURE.md         Claude-centred design: vision, structured outputs,
│                           tool use, batches, caching, Managed Agents, MCP
├── data/
│   ├── results.sample.json sample per-parcel findings (drives the dashboard UI)
│   └── zoning_rules.sample.json  illustrative zoning rule table the engine checks against
└── pipeline/               Python pipeline scaffolding (stubs for the new session)
    ├── requirements.txt
    ├── README.md
    ├── tile.py             clip GeoTIFF → per-parcel chips
    ├── segment.py          SAM 2 footprints
    ├── measure.py          PostGIS coverage / impervious / setbacks
    ├── permit_check.py     spatial join vs Austin permits
    └── writeup.py          Claude: metrics → structured JSON + cited narrative
```

## How it works on GitHub (Pages + Actions)

This repo is a static GitHub Pages site that auto-deploys on push to `main`
(`.github/workflows/pages.yml`), and runs data jobs from `.github/workflows/`.
The project follows the same shape:

1. **The page is static.** `index.html` / `style.css` / `app.js` are deployed
   as-is by the existing Pages workflow — no build step. Pushing to `main`
   publishes this folder.
2. **The dashboard reads JSON.** Today it loads `data/results.sample.json`. When
   the pipeline produces real findings, a GitHub Action writes the results JSON
   (or the page fetches a Supabase endpoint) and the same UI renders them.
3. **The pipeline runs in Actions.** Heavy work (tiling, segmentation, Claude
   passes) runs as a scheduled workflow, mirroring the existing nightly
   `ingest.yml`. A scaffold lives at
   `.github/workflows/aerial-detection.yml` — it is a **clean no-op until the
   `ANTHROPIC_API_KEY` and `DATABASE_URL` repo secrets are set**, and is only
   triggered manually (`workflow_dispatch`) so the schedule never emails
   failures before it's configured. GPU-bound segmentation (SAM 2) is expected
   to run on a self-hosted runner or be called out to a hosted GPU; the hosted
   Action orchestrates and stores results.

> Development, scaffolding, and the deploying actions all happen on GitHub —
> there is no separate server to operate. Commit to `main`, Pages publishes the
> page, and the workflow runs the data jobs.

## Publishing the URL

The page is reachable at `/aerialdetection/` under whatever host Pages serves.
Once the custom-domain / path is confirmed for `austingraph.chat`, link it from
the main site nav. No redirect or config is required for the subfolder itself —
GitHub Pages serves `aerialdetection/index.html` at `/aerialdetection/`
automatically.

## Status

Research / prototyping. The dashboard renders **illustrative sample data**, not
real findings. Real measurement, model runs, and ingest happen in the dedicated
build session described in [`PLAN.md`](PLAN.md). Every flag is **advisory** and
time-stamped to its imagery vintage — never a determination.
