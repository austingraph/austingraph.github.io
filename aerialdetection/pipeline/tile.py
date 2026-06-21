"""Stage 1 — Tiling.

Clip a high-res GeoTIFF aerial to each parcel polygon and export per-parcel
image chips (RGB, and the IR band where available for an NDVI vegetation /
impervious split).

Implementation notes for the build session:
  - Use rasterio.mask.mask() with the parcel geometry (reprojected to the
    raster CRS) to clip; pad the bbox slightly so edges aren't cut tight.
  - Keep the affine transform / CRS alongside each chip so segment.py can
    georeference footprints back to map coordinates.
  - Emit a small sidecar JSON per chip: parcel_id, capture_date,
    imagery_vintage, transform, crs.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Chip:
    parcel_id: str
    rgb_path: str
    ir_path: str | None
    capture_date: str
    imagery_vintage: str
    crs: str
    transform: tuple  # affine (a, b, c, d, e, f)


def tile_parcels(geotiff_path: str, parcels, out_dir: str) -> list[Chip]:
    """Clip `geotiff_path` to each parcel polygon, write chips under `out_dir`."""
    raise NotImplementedError("Implement with rasterio.mask + geopandas")
