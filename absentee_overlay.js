// austingraph.chat — out-of-state (absentee) owner highlight
// Adds an "Ownership" toggle to the right-side map-tools panel
// (#map-tools-content, built by maptools.js) that highlights parcels whose TCAD
// owner mailing state is not Texas. Parcels are fetched live from Supabase
// (public.absentee_select_geojson, server-simplified geometry) and drawn as a
// highlight layer — no owner columns are required in the PMTiles, and owner
// NAMES are never fetched. The count comes from public.parcel_absentee_count.
//
// Mirrors flum_overlay.js.

(() => {
  const { map, SUPABASE_URL, SUPABASE_KEY } = window.AG;

  let active = false;
  let noteEl = null;
  let fetchToken = 0;

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  // ── Map highlight layers ───────────────────────────────────────────────────
  function initLayers() {
    map.addSource('absentee-highlight', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    const beforeId = map.getLayer('parcels-outline') ? 'parcels-outline' : undefined;
    map.addLayer({
      id: 'absentee-highlight-fill',
      type: 'fill',
      source: 'absentee-highlight',
      paint: { 'fill-color': '#e8731a', 'fill-opacity': 0.4 },
    }, beforeId);
    map.addLayer({
      id: 'absentee-highlight-line',
      type: 'line',
      source: 'absentee-highlight',
      paint: { 'line-color': '#b5550e', 'line-width': 0.6, 'line-opacity': 0.85 },
    }, beforeId);
  }

  // ── Toggle → fetch → highlight ──────────────────────────────────────────────
  function refresh() {
    const token = ++fetchToken;
    if (!active) {
      map.getSource('absentee-highlight')?.setData({ type: 'FeatureCollection', features: [] });
      if (noteEl) noteEl.textContent = '';
      return;
    }
    if (noteEl) noteEl.textContent = 'Loading…';
    fetch(`${SUPABASE_URL}/rest/v1/rpc/absentee_select_geojson`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('rpc missing'))))
      .then((fc) => {
        if (token !== fetchToken) return; // stale
        const features = fc?.features || [];
        map.getSource('absentee-highlight')?.setData({ type: 'FeatureCollection', features });
        if (noteEl) {
          const n = features.length;
          noteEl.textContent = n >= 25000
            ? '25,000+ parcels (capped)'
            : `${n.toLocaleString()} out-of-state-owned parcel${n === 1 ? '' : 's'}`;
        }
      })
      .catch(() => {
        if (token !== fetchToken) return;
        if (noteEl) noteEl.textContent = 'Run scripts/absentee_select.sql to enable.';
      });
  }

  // ── UI (appended into the map-tools panel) ──────────────────────────────────
  function buildUI() {
    const content = document.getElementById('map-tools-content');
    if (!content) return;

    const wrap = document.createElement('div');
    wrap.className = 'absentee-section';

    const sep = document.createElement('hr');
    sep.className = 'tools-panel-sep';
    wrap.appendChild(sep);

    const h = document.createElement('div');
    h.className = 'tools-panel-heading';
    h.textContent = 'Ownership';
    wrap.appendChild(h);

    const lbl = document.createElement('label');
    lbl.className = 'filter-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const span = document.createElement('span');
    span.textContent = 'Out-of-state owned';
    lbl.appendChild(cb);
    lbl.appendChild(span);
    cb.addEventListener('change', function () { active = this.checked; refresh(); });
    wrap.appendChild(lbl);

    noteEl = document.createElement('p');
    noteEl.className = 'filter-note';
    wrap.appendChild(noteEl);

    content.appendChild(wrap);
    populateCount(span);
  }

  function populateCount(span) {
    fetch(`${SUPABASE_URL}/rest/v1/parcel_absentee_count?select=n`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('view missing'))))
      .then((rows) => {
        const n = rows && rows[0] && rows[0].n;
        if (n != null) span.textContent = `Out-of-state owned (${Number(n).toLocaleString()})`;
      })
      .catch(() => { /* leave default label until SQL is applied */ });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  map.on('load', () => {
    initLayers();
    buildUI();
  });
})();
