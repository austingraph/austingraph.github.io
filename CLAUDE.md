# Working agreements for this repo

## ⚠️ ALWAYS merge and push before switching branches
**Every time** work on a branch is finished, before moving on to anything else:
1. Commit all changes.
2. Push the branch.
3. Merge it into `main` (squash) and confirm `main` is green.
4. Delete the merged branch so GitHub stops showing "had recent pushes" /
   "compare & pull request" banners. Those banners are **not errors** — they are
   GitHub prompting to open a PR for a freshly-pushed branch — but leaving stale
   branches around causes confusing clutter.

Do not leave a branch un-merged and start another one. The default end state of
any task is: changes on `main`, branch deleted, no dangling work.

## Project shape
- Static site on GitHub Pages at **austingraph.chat** (`index.html`, `app.js`,
  `style.css`, `envelope.js`, `connections.js`). Pages auto-deploys on push to
  `main` via `.github/workflows/pages.yml`.
- Parcel data: 374k Travis County parcels in Supabase (project
  `aqbyxpiwugcvoephsvpm`), served to the map as PMTiles from Supabase Storage.
- Knowledge graph + civic data: `scripts/kg_schema.sql` plus the nightly
  `.github/workflows/ingest.yml` pipeline (`scripts/ingest/`). The ingest job is
  a **clean no-op** until the `DATABASE_URL` and `OPENAI_API_KEY` repo secrets
  are set, so the schedule never emails failures before it's configured.
