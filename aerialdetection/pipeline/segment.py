"""Stage 2 — Footprint segmentation (GPU).

Run SAM 2 (or GroundingDINO for prompted detection) on each parcel chip to get
building / driveway / pool polygons, then georeference them back to map
coordinates using the chip's affine transform.

Runs on a GPU host (self-hosted runner or a hosted GPU service), NOT in the
default GitHub-hosted Action — install torch + segment-anything-2 there.

First-milestone check (../PLAN.md): eyeball footprint quality on 5–10 parcels
before trusting the metrics downstream.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Footprint:
    parcel_id: str
    kind: str          # "building" | "driveway" | "pool" | ...
    geom_wkt: str      # polygon in the parcel CRS (georeferenced)
    area_sqft: float
    mask_confidence: float


def segment_chip(chip, prompts: list[str] | None = None) -> list[Footprint]:
    """Return georeferenced footprints for one chip from tile.tile_parcels()."""
    raise NotImplementedError("Implement with SAM 2 / GroundingDINO on GPU")
