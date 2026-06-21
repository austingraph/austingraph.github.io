# Architecture — how Claude fits the compliance pipeline

The goal is a **defensible, cited compliance flag per parcel**, not a vibe check.
That splits cleanly into two jobs with different tools:

- **Measurement is deterministic.** Footprint polygons and distances are computed
  by self-hosted geometry models (SAM 2 / GroundingDINO) and PostGIS. These
  numbers are ground truth; an LLM never produces them.
- **Judgement is semantic.** "Is this structure consistent with the permit
  record? Which measured violation actually matters? How do I explain it without
  overstating?" — that's where Claude reads the chip + the measured metrics and
  writes the cited narrative.

The contract between the two halves: **PostGIS measures, Claude reasons over the
measurements.** Claude receives numbers as structured tool input and is
instructed to cite them and never invent them. That single rule is what makes
the output legally defensible instead of a hallucinated guess.

All model IDs below are current as of this writing — default reasoning model
`claude-opus-4-8`, bulk/cheap pass `claude-sonnet-4-6`, classification
`claude-haiku-4-5`. Confirm against the `claude-api` skill before building.

---

## Where each Claude capability earns its place

### 1. Vision pass — semantic read of the parcel chip
Claude's vision is excellent at *what is this* questions. Send the per-parcel RGB
chip (base64 or via the **Files API** so the same chip is reused across the
metric pass and the writeup pass without re-upload) and ask for a structured read:
what structures are present, are they consistent with the permit record, what
looks recently added or suspicious. This is **semantic context**, explicitly
*not* measurement — the prompt forbids the model from estimating distances.

### 2. Structured outputs — the machine-readable verdict
The flag that gets stored and rendered must be schema-valid every time. Use
`output_config.format` with a JSON schema (issue type, severity enum, confidence,
which footprints are implicated). No prose-parsing, no prefill. The sample shape
the dashboard renders lives in [`data/results.sample.json`](data/results.sample.json).

### 3. Tool use — measurements as typed input, not narrative
The PostGIS numbers (lot coverage %, impervious %, per-edge setback distances,
permit-match results) are handed to Claude as a tool result / structured input.
The system prompt makes the rule explicit:

> Every numeric claim in your writeup must come from a value in `measurements`.
> If a measurement is absent, say it is unmeasured — do not estimate it.

This is the load-bearing instruction. It converts Claude from "an AI guessing at
a photo" into "an analyst writing up numbers an engine computed."

### 4. Batches API — bulk economics at 374k parcels
Compliance scanning is not latency-sensitive, and the county is large. The
**Message Batches API** runs the bulk semantic + writeup passes at **50% of
standard price**, up to 100k requests per batch. Run the whole zoning district
overnight as one batch; poll for completion; write results to Supabase.

### 5. Prompt caching — the shared prefix is huge and stable
Every parcel request shares the same large prefix: the system prompt, the zoning
rule table ([`data/zoning_rules.sample.json`](data/zoning_rules.sample.json)),
the citation rules, the output schema. Put a `cache_control` breakpoint at the
end of that shared block and only the per-parcel chip + metrics vary. Across a
county-wide batch this is the difference between paying for the rulebook 374k
times and paying for it roughly once.

### 6. Two-model tiering
- `claude-haiku-4-5` — cheap first-pass triage: "is there anything here worth a
  full analysis?" Skip clean parcels.
- `claude-sonnet-4-6` — bulk semantic read + draft writeup for flagged parcels.
- `claude-opus-4-8` — final narrative on the high-severity parcels that a human
  will actually read, where the wording has to be careful and exact.

---

## Two ways to run the reasoning layer

### Option A — Claude API + your own loop (recommended to start)
A plain Python job (the [`pipeline/`](pipeline/) scripts) calls the Messages API
directly. You own tiling, segmentation, PostGIS, and the batch submission. This
is the simplest thing that works and the right altitude for the first milestone.
Adaptive thinking on (`thinking: {"type": "adaptive"}`), effort tuned per tier.

### Option B — Managed Agents for the autonomous, scheduled version
Once the pipeline is proven, a **Managed Agent** can own the end-to-end run: a
persisted agent config (model, system prompt, the geometry tools exposed as
custom tools) plus a **scheduled deployment** (cron) that fires a session nightly
to scan the next batch of parcels and write findings back. Anthropic runs the
loop; the agent calls your measurement tools and Supabase. This is the path to
"it just runs every night and surfaces new flags" without standing up your own
orchestrator. Pair with **outcomes** (a gradeable rubric: "every flag cites a
measured number, severity matches the magnitude") so the agent self-checks its
own writeups.

### MCP surface
Expose the civic data already in this repo's Supabase (parcels, permits, zoning
cases, council votes — see the root `scripts/ingest/`) through an **MCP server**
so the reasoning layer can pull permit history and prior zoning cases for a
parcel on demand, rather than pre-stuffing everything into the prompt. Credentials
live in a vault, never in the agent config.

---

## Data contract (per parcel)

```
parcel_id, geometry            ← TCAD (already in Supabase)
chip_rgb, chip_ir, capture_date, imagery_vintage   ← tiling step
footprints[]                   ← SAM 2 (building / driveway / pool, georeferenced)
measurements{                  ← PostGIS
  lot_coverage_pct, impervious_pct,
  setbacks_ft{front,side,rear}, footprint_areas_sqft
}
permit_matches[]               ← spatial join vs Austin permits
zoning_rule                    ← Austin zoning layer + rule table
──────────────────────────────────────────────
→ Claude → { issue, severity, confidence, citations[], writeup }   ← stored, served
```

Every writeup is stamped with `imagery_vintage` + `capture_date` so conclusions
are time-bounded. Flags are advisory, never determinations — see the disclaimer
on the landing page.

---

## Deferred / adjacent tracks
- **Nano Banana (Gemini 2.5 Flash Image)** belongs to a *scenario visualization*
  track (rendering hypothetical buildouts), not this compliance track.
- **Change detection** (comparing 2020 vs a newer vintage to catch *new*
  unpermitted construction) is a natural follow-on once two vintages are tiled.
