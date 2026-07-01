#!/usr/bin/env python3
"""Generate ar/models/calibration-cube.usdz — a 1-meter cube for validating the
AR Quick Look chain (link → Safari → AR placement → true-world scale) before any
real building model exists.

The cube sits ON the ground plane (bottom at y=0), is authored in meters with
Y-up — the conventions ARKit/AR Quick Look expect — and carries a
UsdPreviewSurface material (Quick Look ignores plain displayColor on some iOS
versions, so a real material is the safe choice).

Usage (from repo root):
    pip install usd-core
    python3 scripts/ar/make_test_cube.py

Reuse this file as the template for envelope_to_usdz.py: swap the 8 cube points
for an extruded parcel-envelope footprint and keep everything else.
"""
import os
import tempfile

from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdUtils

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "ar", "models",
                   "calibration-cube.usdz")
SIZE = 1.0  # meters


def build_stage(path):
    stage = Usd.Stage.CreateNew(path)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)

    root = UsdGeom.Xform.Define(stage, "/Root")
    stage.SetDefaultPrim(root.GetPrim())

    # Explicit mesh (not a Cube gprim) — RealityKit/Quick Look support for gprims
    # is spotty; meshes always work.
    h = SIZE / 2.0
    mesh = UsdGeom.Mesh.Define(stage, "/Root/Cube")
    mesh.CreatePointsAttr([
        Gf.Vec3f(-h, 0.0, -h), Gf.Vec3f(h, 0.0, -h),
        Gf.Vec3f(h, 0.0, h), Gf.Vec3f(-h, 0.0, h),
        Gf.Vec3f(-h, SIZE, -h), Gf.Vec3f(h, SIZE, -h),
        Gf.Vec3f(h, SIZE, h), Gf.Vec3f(-h, SIZE, h),
    ])
    # 6 quad faces, outward-facing (right-handed winding).
    mesh.CreateFaceVertexCountsAttr([4] * 6)
    mesh.CreateFaceVertexIndicesAttr([
        3, 2, 1, 0,   # bottom (y=0)
        4, 5, 6, 7,   # top
        0, 1, 5, 4,   # -z
        2, 3, 7, 6,   # +z
        1, 2, 6, 5,   # +x
        3, 0, 4, 7,   # -x
    ])
    mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    mesh.CreateExtentAttr([Gf.Vec3f(-h, 0.0, -h), Gf.Vec3f(h, SIZE, h)])

    material = UsdShade.Material.Define(stage, "/Root/Materials/Orange")
    shader = UsdShade.Shader.Define(stage, "/Root/Materials/Orange/Preview")
    shader.CreateIdAttr("UsdPreviewSurface")
    shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(
        Gf.Vec3f(0.91, 0.66, 0.22))  # site accent orange (#e8a838)
    shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(0.6)
    material.CreateSurfaceOutput().ConnectToSource(
        shader.ConnectableAPI(), "surface")
    UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(material)

    stage.GetRootLayer().Save()


def main():
    out = os.path.abspath(OUT)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        usdc = os.path.join(tmp, "calibration-cube.usdc")
        build_stage(usdc)
        ok = UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(usdc), out)
    if not ok:
        raise SystemExit("usdz packaging failed")
    print("wrote", out, os.path.getsize(out), "bytes")


if __name__ == "__main__":
    main()
