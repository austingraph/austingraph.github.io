"""Stage 4 — Permit cross-check.

Spatial-join detected footprints against permitted structures (Austin
open-data permit records, already ingested into Supabase by the root
scripts/ingest/ingest_permits.py). A detected structure with no spatially
matching permit is the strongest unpermitted-construction signal.

Returns one record per footprint: matched permit (if any) + a boolean
unpermitted flag, which feeds writeup.py as context.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class PermitMatch:
    parcel_id: str
    footprint_kind: str
    matched_permit_id: str | None
    matched_permit_year: int | None
    unpermitted: bool


def cross_check_permits(parcel_id: str, footprints, conn) -> list[PermitMatch]:
    """Spatial-join footprints vs permits; flag structures with no match."""
    raise NotImplementedError("Implement with a PostGIS spatial join vs permits")
