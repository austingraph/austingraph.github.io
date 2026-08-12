# austingraph → React Native app — plan (DRAFT)

_Drafted 2026-08-11 by Claude as a **reconstruction**: the original conversion
plan was discussed on another surface and never committed. If that plan
surfaces (check the desktop app), paste it in and reconcile this draft against
it. Until then, treat every decision below as proposed, not settled._

## What we're converting

The live product: a vanilla-JS static site (austingraph.chat) — MapLibre map
over 374k Travis County parcels (PMTiles from Supabase Storage), click →
parcel panel (zoning, envelope, Site Check, appraisal, comps, permits), full
feasibility pro-forma with three scenarios, printable report, AR Quick Look
per parcel. All data via Supabase PostgREST RPCs; no server of our own.

**Good news baked into the current architecture:** the heavy lifting is
server-side (Postgres RPCs) and the business logic (`envelope.js`,
`feasibility.js`) is plain framework-free JavaScript — it ports to RN nearly
verbatim. The conversion is mostly a UI rebuild, not a logic rewrite.

## Proposed stack (matches the house pattern)

- **Expo + expo-router**, same major as the tour apps. Own repo, own app
  identity (`com.austingraph.app` or similar), own EAS project — one repo =
  one app, per the C:\Dev rules. **New repo under the `austingraph` account**;
  this Pages repo stays as-is (the web app keeps running — the app is a
  second surface, not a replacement).
- **@maplibre/maplibre-react-native** for the map (proven pattern in-house).
  Open question to verify early: PMTiles support in MapLibre *Native* differs
  from maplibre-gl-js — spike this first; fallback is serving vector tiles
  from Supabase Storage in a format Native accepts, or a tile proxy.
- **supabase-js** works in RN unchanged (anon key, RPC calls identical).
- **expo-print / expo-sharing** for the feasibility report (replaces the
  browser print pipeline in `report.js` — the biggest UI rework, 1,074 lines).
- AR Quick Look: iOS gets it nearly free (open USDZ URL); Android equivalent
  is Scene Viewer. Port last.
- Street view / panorama: WebView wrapper first, native later if ever.

## Phases (each ends demoable)

- **P0 — scaffold + map**: Expo app, MapLibre view, parcel tiles rendering,
  tap → parcel_id. *The PMTiles spike lives here and gates everything.*
- **P1 — parcel panel**: tap → RPC → the core data panel (zoning, envelope
  numbers, Site Check flags, appraisal). Port `envelope.js` as-is.
- **P2 — feasibility**: port `feasibility.js` + the three-scenario UI.
- **P3 — report**: expo-print PDF of the feasibility report; share sheet.
- **P4 — search + filters**: address/owner search, map filters, FLUM overlay.
- **P5 — extras + business**: AR, street view, auth/subscription gating
  (the $39–59/mo model implies accounts + paywall — decide where auth lives
  before P5, it touches RPC permissions).

## Open questions the original plan may have answered

1. Repo/app name under `austingraph`?
2. Web app and RN app share the anon-key RPC surface — is any of it supposed
   to go behind auth for the paid tier, and when?
3. Offline expectations? (Field use on-site suggests at least tile caching.)
4. iOS, Android, or both first? (AR Quick Look favors iOS-first.)
5. Does the RN app reuse any austin-tour-kit code, or stay independent?
   (Draft assumes independent — different product line.)
