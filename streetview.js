// austingraph.chat — street-level view (panel, top)
// Listens for parcel:select / parcel:deselect from app.js, computes the parcel
// centroid from the cached geometry (window.AG.lastPanelData.geometry), finds the
// nearest Mapillary image, and shows an interactive mapillary-js panorama at the
// top of the left panel.
//
// Why Mapillary: open (CC-BY-SA) street-level imagery, open-data friendly. The
// access token below is a FREE client token (just an app identifier — not billed),
// which is the intended client-side usage.
//
// A "Google street view" deep link sits under this panel (#sv-google); it is
// populated by renderLinks() in app.js, independent of Mapillary coverage.

(() => {
  // ── Mapillary client access token ─────────────────────────────────────────────
  // Free, PUBLIC, client-side token. Register an application at mapillary.com to get
  // one (Settings → Developers → Register application), then paste it below (or set
  // window.AG.MAPILLARY_TOKEN before this script loads). It's an app identifier, not
  // a billable key, so it's safe to ship in this static site.
  const MAPILLARY_TOKEN =
    (window.AG && window.AG.MAPILLARY_TOKEN) || 'MLY|27548508281437137|ecf9f705d577342fd10429e8d8991fbf';

  const elWrap   = document.getElementById('panel-streetview');
  const elFrame  = document.getElementById('sv-frame');   // mapillary-js renders here
  const elDate   = document.getElementById('sv-date');
  const elStatus = document.getElementById('sv-status');
  if (!elWrap || !elFrame) return;

  const tokenMissing = !MAPILLARY_TOKEN || MAPILLARY_TOKEN.indexOf('REPLACE_WITH') === 0;

  // Average-of-coordinates centroid (same approach as centroid() in report.js).
  // Returns [lon, lat] or null. geom is a GeoJSON Polygon / MultiPolygon.
  function centroid(geom) {
    if (!geom || !geom.coordinates) return null;
    let sx = 0, sy = 0, n = 0;
    const walk = (c) => {
      if (typeof c[0] === 'number') { sx += c[0]; sy += c[1]; n++; return; }
      for (const x of c) walk(x);
    };
    walk(geom.coordinates);
    return n ? [sx / n, sy / n] : null;
  }

  const status = (msg) => { if (elStatus) elStatus.textContent = msg || ''; };

  function setDate(ms) {
    if (!elDate) return;
    if (ms) {
      const d = new Date(ms);
      const s = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      elDate.textContent = 'Imagery: ' + s;
      elDate.style.display = 'block';
    } else {
      elDate.style.display = 'none';
      elDate.textContent = '';
    }
  }

  function hideViewer() {
    elFrame.style.display = 'none';
    setDate(null);
  }

  let viewer = null;          // panel mapillary.Viewer, created lazily and reused
  let token  = 0;             // stale-selection guard

  // Create the viewer once (container must be visible + sized first), or move an
  // existing one to the new image.
  function showImage(imageId) {
    elFrame.style.display = 'block';
    if (viewer) {
      viewer.moveTo(imageId).catch(() => {});
      if (viewer.resize) viewer.resize();
      return true;
    }
    if (!window.mapillary || !window.mapillary.Viewer) {
      hideViewer();
      status('Street-view library failed to load.');
      return false;
    }
    viewer = new window.mapillary.Viewer({
      accessToken: MAPILLARY_TOKEN,
      container: elFrame,
      imageId,
      component: { cover: false },   // auto-load (skip the click-to-activate cover)
    });
    return true;
  }

  function update() {
    const t = ++token;
    setDate(null);

    if (tokenMissing) {
      hideViewer();
      status('Street view needs a free Mapillary token (set it in streetview.js).');
      return;
    }

    const c = centroid(window.AG && window.AG.lastPanelData && window.AG.lastPanelData.geometry);
    if (!c) {
      hideViewer();
      status('No location available for street view.');
      return;
    }
    const lon = c[0], lat = c[1];
    status('Loading street view…');

    // Nearest Mapillary image to the parcel centroid (radius max 50m).
    fetch('https://graph.mapillary.com/images?fields=id,captured_at' +
      '&lat=' + lat + '&lng=' + lon + '&radius=50&limit=1' +
      '&access_token=' + encodeURIComponent(MAPILLARY_TOKEN))
      .then((r) => r.json())
      .then((d) => {
        if (t !== token) return;                 // a newer parcel was selected
        const img = d && d.data && d.data[0];
        if (!img || !img.id) {
          hideViewer();
          status('No street-level view available here.');
          return;
        }
        if (showImage(img.id)) {
          status('');
          setDate(img.captured_at);
        }
      })
      .catch(() => {
        if (t !== token) return;
        hideViewer();
        status('Could not load street view.');
      });
  }

  window.addEventListener('parcel:select', update);
  window.addEventListener('parcel:deselect', () => {
    ++token;
    hideViewer();
    status('Select a parcel to see a street-level view.');
  });
})();
