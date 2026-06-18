"""Stage 3 — Metric checks (PostGIS).

The deterministic half of the system. Compute the numbers Claude will later
cite — Claude never produces these:

  - lot coverage %        = sum(building footprint area) / parcel area
  - impervious %          = (buildings + driveways + pool decks) / parcel area
                            (refine with the IR/NDVI split from tiling)
  - setbacks (ft)         = min distance from each footprint edge to the
                            matching parcel boundary (front/side/rear)

Compare against the zoning rule table (see ../data/zoning_rules.sample.json),
honouring the per-vintage measurement tolerance, and emit boolean flags +
magnitudes.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Measurements:
    parcel_id: str
    zoning_rule: str
    lot_coverage_pct: float
    impervious_pct: float
    setbacks_ft: dict          # {"front": .., "side": .., "rear": ..}
    footprint_areas_sqft: dict
    tolerance_ft: float
    flags: dict = field(default_factory=dict)  # {"lot_coverage": True, ...}


def measure_parcel(parcel_id: str, footprints, zoning_rules: dict,
                   imagery_vintage: str, conn) -> Measurements:
    """Run the PostGIS measurements + rule comparison for one parcel."""
    raise NotImplementedError("Implement with PostGIS ST_Area / ST_Distance")
