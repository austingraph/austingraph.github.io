# On-site AR — how it works and how to add a site

Stand at a real parcel with an iPhone/iPad and see a simulated development anchored in
place — it stays locked to the world as you walk around. This folder holds the models and
the manifest that connects them to parcels on the map.

**The tech in one paragraph:** this is *augmented reality* (AR), not VR. Tapping a `.usdz`
model link in Safari opens **AR Quick Look** — built into every iPhone/iPad, no app, no
account, no cost. ARKit's world tracking keeps the model fixed in space once placed; on a
LiDAR device (your iPhone) real people/cars automatically pass **in front of** the model
(occlusion), which is what sells the illusion. You align the model to the parcel by hand
once when you arrive (~30 seconds); everything after that is automatic.

## The three experience types

| Want | Use | Where |
|---|---|---|
| Proposed building on a parcel | AR Quick Look (`model` in manifest) | This folder |
| 360° view of an area | Gyro panorama page (`pano` in manifest) | `/panorama.html` |
| Animated historical scene, geo-anchored multi-object scenes | Hoverlay free tier (`hoverlay` URL in manifest) | hoverlay.com |

## Adding an AR site (parcel → building model)

1. **Model the building in Blender** (free, blender.org) on the ThinkPad.
   - Work in **meters at real-world scale** (a 2-story house ≈ 8 m tall). Scene
     Properties → Units → Metric.
   - Put the model's **origin at ground level, centered on the footprint** — that's the
     point AR Quick Look sets on the ground when you place it.
   - Keep it light: < ~100k triangles and < ~25 MB total, or phones struggle.
   - Optional site context: scan the parcel with **Scaniverse** (free) on the LiDAR
     iPhone, export OBJ/PLY, import into Blender as a reference so the design meets the
     real grade/neighbors, then delete the scan before export.
2. **Export USDZ**: File → Export → Universal Scene Description, filename ending in
   `.usdz`. Check *Selection Only* if reference junk is still in the scene. Y-up and
   meters are Blender's USD defaults — leave them.
3. **Drop the file in `ar/models/`** and add a manifest entry keyed by the TCAD property
   ID (the number in the panel header):

   ```json
   "parcels": {
     "123456": {
       "title": "1234 E 5th St — proposed fourplex",
       "model": "models/e5th-fourplex.usdz",
       "notes": "Align the long side to the street; door faces E 5th."
     }
   }
   ```
4. Commit + push to `main`. The AR button appears in that parcel's panel, and the site
   shows up with a QR code on [`/ar/`](index.html).

`scripts/ar/make_test_cube.py` generated the calibration cube and is the template for a
future `envelope_to_usdz.py` (auto-massing from the parcel envelope math in
`envelope.js`).

## Adding a 360° view

1. In Blender: Render Properties → Cycles; Camera → Panoramic → Equirectangular; put the
   camera at eye height (1.6 m) at the chosen viewpoint; render ~8192×4096 PNG/JPG.
   (Or start from a real 360 photo taken at the spot.)
2. Save it under `ar/panos/` and add `"pano": "panos/<file>.jpg"` to the manifest entry.
3. On site: open the 360° link, tap **Enable motion**, and turn in place.

## Adding a geo-anchored / historical scene (Hoverlay)

1. Free account at hoverlay.com — the free tier includes **5 geo-located spaces**, so
   spend them on showcase sites only.
2. Author in the web studio on the ThinkPad: import the same Blender models (glTF),
   360s, green-screen video people, ambient audio; pin the space to the parcel's
   lat/long.
3. Install the free Hoverlay app on the iPhone/iPad (you're the one demoing, so an app
   is fine) and add the scene URL to the manifest as `"hoverlay": "https://…"`.

## On-site demo checklist

- Before leaving: open the parcel on austingraph.chat on the device, tap the AR badge
  **once at home** to confirm the model loads (it caches).
- At the site: stand where the viewer will stand → tap the AR badge → slowly pan the
  camera across the ground until the model drops in → one-finger drag to move it onto
  the parcel, two-finger rotate to face the street → walk. Don't pinch — scaling is
  locked to true size on purpose.
- Overcast light tracks better than harsh noon shadows; avoid big blank surfaces.
- If the model swims/drifts: point the camera at textured ground for a few seconds.

## Later upgrades (all still $0)

- **Auto-placement that survives return visits**: a small ARKit/RealityKit app built in
  **Swift Playgrounds on the iPad** (no Mac needed) using `ARWorldMap` — scan the site
  once, save the map, and every later session relocalizes to centimeter accuracy.
- **Public self-serve** (visitors' own phones via QR): works today for iPhone users via
  the QR codes on `/ar/`; Android would need glTF models + `<model-viewer>`'s Scene
  Viewer, or a paid WebAR platform.
