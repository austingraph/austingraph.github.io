// austingraph.chat — on-site AR (panel section)
// Listens for parcel:select / parcel:deselect from app.js and, when the selected
// parcel has an entry in ar/manifest.json (or the manifest has a "default" test
// entry), shows launchers in the left panel:
//   • "View on site in AR" — Apple AR Quick Look via <a rel="ar"><img></a>.
//     Safari on iPhone/iPad opens the USDZ full-screen in the camera at true
//     real-world scale; #allowsContentScaling=0 locks pinch-zoom so a building
//     stays building-sized. On non-iOS browsers the link would just download,
//     so we show a hint instead of the badge.
//   • "360° view" — gyro-driven panorama page (panorama.html, Pannellum).
//   • "Geo-anchored scene" — external Hoverlay scene URL, if authored.
// Content workflow, model specs, and on-site checklist: ar/GUIDE.md.

(() => {
  const elWrap = document.getElementById('panel-ar');
  const elBox  = document.getElementById('ar-content');
  const elNote = document.getElementById('ar-note');
  if (!elWrap || !elBox) return;

  // iPadOS 13+ reports as "MacIntel" desktop; the touch-points check catches it.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  let manifest;            // fetched lazily, then cached (null = fetch failed)
  const getManifest = () => {
    if (manifest !== undefined) return Promise.resolve(manifest);
    return fetch('ar/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => (manifest = m))
      .catch(() => (manifest = null));
  };

  const hide = () => { elWrap.style.display = 'none'; elBox.innerHTML = ''; };

  function render(entry, isDefault) {
    elBox.innerHTML = '';

    if (entry.model) {
      const url = 'ar/' + entry.model + '#allowsContentScaling=0';
      if (isIOS) {
        // rel="ar" + first-child <img> is Apple's trigger for AR Quick Look.
        const a = document.createElement('a');
        a.rel = 'ar';
        a.href = url;
        a.className = 'ar-quicklook';
        const img = document.createElement('img');
        img.src = 'ar/ar-badge.svg';
        img.alt = 'View on site in AR';
        a.appendChild(img);
        elBox.appendChild(a);
      }
    }

    const links = document.createElement('div');
    links.className = 'panel-links';
    if (entry.model && !isIOS) {
      const a = document.createElement('a');
      a.href = 'ar/' + entry.model;
      a.textContent = 'Download AR model (.usdz)';
      links.appendChild(a);
    }
    if (entry.pano) {
      const a = document.createElement('a');
      a.href = 'panorama.html?pano=' + encodeURIComponent('ar/' + entry.pano) +
        '&title=' + encodeURIComponent(entry.title || '360° view');
      a.target = '_blank'; a.rel = 'noopener';
      a.textContent = '360° view ↗';
      links.appendChild(a);
    }
    if (entry.hoverlay) {
      const a = document.createElement('a');
      a.href = entry.hoverlay;
      a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'Geo-anchored scene (Hoverlay) ↗';
      links.appendChild(a);
    }
    const all = document.createElement('a');
    all.href = 'ar/'; all.target = '_blank'; all.rel = 'noopener';
    all.textContent = 'All AR sites + QR codes ↗';
    links.appendChild(all);
    elBox.appendChild(links);

    if (elNote) {
      const parts = [];
      if (entry.title) parts.push(entry.title + (isDefault ? ' (test model — shown on every parcel)' : ''));
      if (entry.notes) parts.push(entry.notes);
      if (entry.model && !isIOS) parts.push('AR view opens on an iPhone or iPad in Safari.');
      elNote.textContent = parts.join(' ');
    }
    elWrap.style.display = '';
  }

  function update() {
    const data = window.AG && window.AG.lastPanelData;
    const parcelId = data && data.parcelId != null ? String(data.parcelId) : null;
    if (!parcelId) { hide(); return; }
    getManifest().then((m) => {
      if (!m) { hide(); return; }
      const cur = window.AG.lastPanelData;
      if (!cur || String(cur.parcelId) !== parcelId) return; // stale selection
      const entry = (m.parcels && m.parcels[parcelId]) || m.default;
      if (entry && (entry.model || entry.pano || entry.hoverlay)) {
        render(entry, entry === m.default);
      } else {
        hide();
      }
    });
  }

  window.addEventListener('parcel:select', update);
  window.addEventListener('parcel:deselect', hide);
})();
