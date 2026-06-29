# austingraph — Data Architecture Overview

_Reference for marketing content · June 2026_

---

## Section 1: Parcel Database Schema (Supabase / PostGIS)

The core database holds **374,000 Travis County parcels** in a single Supabase (PostgreSQL + PostGIS) project. Every parcel is a row with geometry, appraisal data, zoning, planning, and site flags pre-joined so a single click returns instant results — no joins at query time.

---

### **The `parcels` Table — One Row Per Parcel**

| Column Group | What It Stores |
|---|---|
| **Geometry** | Parcel boundary polygon + interior centroid (EPSG:4326) |
| **Identity** | `parcel_id` (TCAD PROP_ID), `metadata` JSONB (address, legal desc, geo_id, acreage) |
| **Appraisal Values** | Market value, land value, improvement value, assessed value, taxable value, homestead cap loss |
| **Improvement Details** | Year built, living sq ft, construction class, lot sq ft |
| **Exemptions & Ownership** | Exemption codes (HS, OV65, AG…), owner state (TX vs. absentee), deed date |
| **Zoning** | Full zoning string (e.g. SF-3-NP), base district (SF-3), multi-zoned flag |
| **Future Land Use** | FLUM category code + label (Single-Family, Multifamily, Activity Center…) |
| **Upzoning Signal** | Upzoning gap (intensity rank difference: FLUM vs. zoning), upzoning flag |
| **Site Check Flags** | `sitecheck_flood` (FEMA zone), `sitecheck_watershed` (impervious cap class), `sitecheck_jurisdiction` (Full Purpose / ETJ / County) |

---

### **Supporting Tables**

| Table | Purpose | Rows (approx.) |
|---|---|---|
| `parcel_appraisal_history` | Year-over-year value snapshots (2021–2026) for trend sparklines | Up to 6 rows × 374k parcels |
| `zoning` | City of Austin zoning district polygons | ~22,500 |
| `zoning_rules` | LDC site-development regulations as data (setbacks, FAR, max units, height) | ~60 district variants |
| `flum` + `flum_categories` | Future Land Use Map polygons + intensity ranking | ~79,800 polygons |
| `streets` | Street centerlines — used to classify parcel edges (front/side/rear) | ~68,500 segments |
| `census_block_groups` | ACS 2022 5-year socioeconomic data (income, rent, cost burden, demographics) | ~700 in Travis County |
| `census_blocks` | 2020 Decennial headcount + race/ethnicity at block level | ~16,000 |
| `kg_nodes` | Knowledge graph entities: zoning cases, permits, documents, persons | Growing |
| `kg_edges` | Relationships between entities (parcel → case → vote) | Growing |
| `parcel_documents` | Full-text civic records (permits, zoning cases, council actions) for RAG | Growing |
| `parcel_embeddings` | OpenAI 1536-dim vector embeddings of parcel documents (semantic search) | Growing |

---

### **Server-Side Functions (RPCs)**

These run inside Postgres and are called by the browser via PostgREST. No raw SQL leaves the server.

| Function | What It Does |
|---|---|
| `compute_envelope()` | Calculates buildable footprint, setbacks, max FAR/units/height from zoning rules + street geometry |
| `parcel_demographics()` | Returns ACS + Decennial neighborhood profile for any parcel (income, rent, tenure, age, race) |
| `parcel_value_context()` | Ranks a parcel's $/sqft vs. 300 nearest comparable parcels — substitute for non-disclosure sale prices |
| `parcel_value_history()` | Returns year-by-year value trend for sparkline charts |
| `parcel_graph` (view) | Returns linked zoning cases + council votes + permits for a parcel |
| `match_parcel_documents()` | Semantic RAG search: finds most relevant civic documents by vector similarity |
| `link_point_to_parcel()` | Point-in-polygon geocoder (lat/lng → parcel_id) |
| `flum_select_geojson()` | Streams filtered parcel geometries for map highlight overlays |

---

---

## Section 2: Data Sources

The app pulls from **9 distinct data sources** — some precomputed nightly into the database, others fetched live in the browser.

---

### **Precomputed into the Database (Server-Side Pipelines)**

These run via GitHub Actions using a Supabase service-role key. No browser request; results are stored as columns on the `parcels` table.

| Source | What We Pull | Frequency |
|---|---|---|
| **Travis CAD (TCAD)** | Annual appraisal export: property values, year built, living sqft, owner info, exemptions, construction class | Annual (+ as-needed) |
| **TCAD EARS History** | Prior-year appraisal roll exports (2021–2025) for value trend analysis | Once per year added |
| **City of Austin Socrata — Zoning Cases** | All CoA zoning cases (case #, status, existing/proposed zoning, district, coordinates) | Weekly |
| **City of Austin Socrata — Council Votes** | Council member votes on zoning items (voter, vote, meeting date) | Weekly |
| **City of Austin ArcGIS — Watershed Zones** | Watershed regulation areas → impervious cover cap classification | On demand |
| **City of Austin ArcGIS — Jurisdiction Boundaries** | Full Purpose / Limited Purpose / ETJ / County boundaries | On demand |
| **U.S. Census Bureau — ACS 2022 5-Year** | 39 demographic variables at block-group level (income, rent, cost burden, age, race, commute) | Annual |
| **U.S. Census Bureau — Decennial 2020** | Block-level population and housing counts | Once |
| **OpenAI Embeddings API** | Converts civic documents to 1536-dim vectors for semantic search | Nightly (new docs) |

---

### **Fetched Live in the Browser**

These are called directly from the user's browser when they click a parcel.

| Source | What We Pull | Used For |
|---|---|---|
| **Supabase PostgREST** | Parcel row (appraisal, zoning, sitecheck flags), RPC results (envelope, demographics, value context) | Entire panel + report |
| **City of Austin Socrata — Permits** | Live construction permits by `tcad_id` (permit type, status, issue date, description) | "Connections" panel |
| **Mapillary Graph API** | Nearest street-level image to parcel centroid (within 50m radius) | Street-view panel |
| **Mapillary Viewer (mapillary-js)** | Interactive 360° panorama viewer | Street-view panel |

---

### **Map Tile Sources (Rendered in the Browser)**

| Source | What It Renders |
|---|---|
| **Supabase Storage — PMTiles** | 374k parcel boundary polygons as vector tiles (custom-built from TCAD geometry) |
| **OpenFreeMap (Liberty style)** | Default base map (streets, labels, buildings, parks) |
| **Esri World Imagery** | Aerial / satellite photography (Aerial basemap toggle) |
| **Esri World Street Map** | Street-level raster basemap (Street toggle in report) |
| **OpenFreeMap Planet Tiles** | 3D building footprints (Buildings toggle in report) |
| **AWS Terrain Tiles (Terrarium)** | Digital elevation model for hillshade + contour lines (Topo toggle) |

---

### **Local GeoJSON Overlays (Bundled in the Repo)**

These files live in `/shared/` and are loaded client-side when the user toggles an overlay.

| File | Layer | Source |
|---|---|---|
| `floodzone.geojson` | FEMA Flood Zones (A, AE, AO, 0.2%) | FEMA National Flood Hazard Layer |
| `Council_Districts.geojson` | Austin City Council Districts (10 districts) | City of Austin open data |
| `SecondData.geojson` | ZIP Code boundaries for Austin area | City of Austin open data |

---

### **At a Glance**

```
PRECOMPUTED (nightly/annual)          LIVE (per click)
─────────────────────────────         ─────────────────────────
Travis CAD        → values            Supabase PostgREST → parcel row
City of Austin    → permits           Austin Socrata     → live permits
                  → zoning cases      Mapillary          → street view
                  → council votes
                  → watershed/ETJ
U.S. Census       → demographics
OpenAI            → embeddings

MAP TILES (continuous)
───────────────────────────────────────────────────────────────
Supabase PMTiles → parcel boundaries (374k)
OpenFreeMap      → base map + 3D buildings
Esri             → aerial + street imagery
AWS Terrarium    → elevation / topo
```

---

_All precomputed data ingestion runs via GitHub Actions using secrets — no local environment required. The browser uses only the Supabase anon key (read-only, public)._
