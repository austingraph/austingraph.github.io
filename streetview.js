// austingraph.chat — street-level view (panel, top)
// Listens for parcel:select / parcel:deselect from app.js, computes the parcel
// centroid from the cached geometry (window.AG.lastPanelData.geometry), and shows
// an interactive Google Maps Embed API Street View panorama at the top of the left
// panel.
//
// Cost note: the Maps Embed API (/maps/embed/v1/streetview) is FREE with unlimited
// usage. The Street View *metadata* endpoint used for the coverage pre-check is also
// free and off-quota. We never use the billed Street View Static (image) API.

(() => {
  // ── Google Maps API key ───────────────────────────────────────────────────────
  // PUBLIC, client-side key. This is a static site, so any key here is visible in
  // source — protect it in the Google Cloud console, NOT by hiding it:
  //   • Application restriction → HTTP referrers:
  //       austingraph.chat/*, *.austingraph.chat/*   (+ localhost:*, 127.0.0.1:* to test)
  //   • API restriction → "Maps Embed API" (+ "Street View Static API" so the free
  //       coverage pre-check works).
  // The Embed API cannot run up a bill, so a referrer-locked key is safe to ship.
  // Paste your key below (or set window.AG.GOOGLE_MAPS_KEY before this script loads).
  const GOOGLE_MAPS_KEY =
    (window.AG && window.AG.GOOGLE_MAPS_KEY) || 'REPLACE_WITH_YOUR_GOOGLE_MAPS_API_KEY';

  const elWrap   = document.getElementById('panel-streetview');
  const elFrame  = document.getElementById('sv-frame');
  const elDate   = document.getElementById('sv-date');
  const elStatus = document.getElementById('sv-status');
  if (!elWrap || !elFrame) return;

  const keyMissing = !GOOGLE_MAPS_KEY || GOOGLE_MAPS_KEY.indexOf('REPLACE_WITH') === 0;

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

  function hideFrame() {
    elFrame.style.display = 'none';
    elFrame.removeAttribute('src');
    if (elDate) { elDate.style.display = 'none'; elDate.textContent = ''; }
  }

  function showPano(lat, lon) {
    elFrame.src =
      'https://www.google.com/maps/embed/v1/streetview?key=' +
      encodeURIComponent(GOOGLE_MAPS_KEY) +
      '&location=' + encodeURIComponent(lat + ',' + lon) +
      '&fov=80&pitch=0';
    elFrame.style.display = 'block';
    if (elStatus) elStatus.textContent = '';
  }

  function setDate(date) {
    if (!elDate) return;
    if (date) { elDate.textContent = 'Imagery: ' + date; elDate.style.display = 'block'; }
    else { elDate.style.display = 'none'; elDate.textContent = ''; }
  }

  let token = 0;

  function update() {
    const t = ++token;
    setDate(null);

    if (keyMissing) {
      hideFrame();
      if (elStatus) elStatus.textContent =
        'Street view needs a Google Maps API key (set it in streetview.js).';
      return;
    }

    const c = centroid(window.AG && window.AG.lastPanelData && window.AG.lastPanelData.geometry);
    if (!c) {
      hideFrame();
      if (elStatus) elStatus.textContent = 'No location available for street view.';
      return;
    }
    const lon = c[0], lat = c[1];

    if (elStatus) elStatus.textContent = 'Loading street view…';

    // Free, off-quota coverage pre-check. If it's blocked (e.g. CORS), fall back to
    // embedding the panorama directly — Google shows its own "no imagery" panel for
    // uncovered spots, so the feature still works without the pre-check.
    fetch('https://maps.googleapis.com/maps/api/streetview/metadata?location=' +
      lat + ',' + lon + '&key=' + encodeURIComponent(GOOGLE_MAPS_KEY))
      .then((r) => r.json())
      .then((m) => {
        if (t !== token) return; // a newer parcel was selected
        if (m && m.status === 'OK') {
          showPano(lat, lon);
          setDate(m.date);
        } else {
          hideFrame();
          if (elStatus) elStatus.textContent = 'No street-level view available here.';
        }
      })
      .catch(() => {
        if (t !== token) return;
        showPano(lat, lon); // metadata unreachable — embed directly
      });
  }

  window.addEventListener('parcel:select', update);
  window.addEventListener('parcel:deselect', () => {
    ++token;
    hideFrame();
    if (elStatus) elStatus.textContent = 'Select a parcel to see a street-level view.';
  });
})();
