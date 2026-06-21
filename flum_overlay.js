// austingraph.chat — Future Land Use parcel selector
// Adds a "Future land use" section to the right-side map-tools panel
// (#map-tools-content, built by maptools.js) that highlights parcels by
// future-land-use category and/or upzoning-candidate status. Parcels are
// fetched live from Supabase (public.flum_select_geojson, server-simplified
// geometry) and drawn as a highlight layer — no FLUM columns are required in
// the PMTiles. Category counts come from the public.parcel_flum_counts view.

(() => {
  const { map, SUPABASE_URL, SUPABASE_KEY } = window.AG;

  const selectedCodes = new Set();   // selected flum_code values
  let upzoningOnly = false;
  let listEl, noteEl;
  let fetchToken = 0;

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  // ── Map highlight layers ───────────────────────────────────────────────────
  function initLayers() {
    map.addSource('flum-highlight', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    // Upzoning candidates render green; other category selections render violet.
    const beforeId = map.getLayer('parcels-outline') ? 'parcels-outline' : undefined;
    map.addLayer({
      id: 'flum-highlight-fill',
      type: 'fill',
      source: 'flum-highlight',
      paint: {
        'fill-color': ['case', ['get', 'upzoning_flag'], '#2e9e6a', '#7a4fc0'],
        'fill-opacity': 0.4,
      },
    }, beforeId);
    map.addLayer({
      id: 'flum-highlight-line',
      type: 'line',
      source: 'flum-highlight',
      paint: {
        'line-color': ['case', ['get', 'upzoning_flag'], '#1d6b46', '#532f8a'],
        'line-width': 0.6,
        'line-opacity': 0.8,
      },
    }, beforeId);
  }

  // ── Selection → fetch → highlight ──────────────────────────────────────────
  function refresh() {
    const token = ++fetchToken;
    const codes = [...selectedCodes];
    if (!codes.length && !upzoningOnly) {
      map.getSource('flum-highlight')?.setData({ type: 'FeatureCollection', features: [] });
      if (noteEl) noteEl.textContent = '';
      return;
    }
    if (noteEl) noteEl.textContent = 'Loading…';
    fetch(`${SUPABASE_URL}/rest/v1/rpc/flum_select_geojson`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_flum_codes: codes.length ? codes : null,
        p_upzoning_only: upzoningOnly,
      }),
    })
      .then((r) => r.json())
      .then((fc) => {
        if (token !== fetchToken) return; // stale
        const features = fc?.features || [];
        map.getSource('flum-highlight')?.setData({ type: 'FeatureCollection', features });
        if (noteEl) {
          const n = features.length;
          noteEl.textContent = n >= 25000
            ? '25,000+ parcels (capped) — narrow the selection'
            : `${n.toLocaleString()} parcel${n === 1 ? '' : 's'} highlighted`;
        }
      })
      .catch(() => {
        if (token !== fetchToken) return;
        if (noteEl) noteEl.textContent = 'Could not load selection.';
      });
  }

  // ── UI (appended into the top Overlays menu) ───────────────────────────────
  function buildUI() {
    // Lives in the right-side map-tools panel (#map-tools-content), in the
    // space the base map / overlay toggles used to occupy. Inserted at the top
    // so it sits above the parcel filter (filters.js), which carries its own
    // leading separator.
    const content = document.getElementById('map-tools-content');
    if (!content) return;

    const wrap = document.createElement('div');
    wrap.className = 'flum-section';

    const h = document.createElement('div');
    h.className = 'tools-panel-heading';
    h.textContent = 'Future land use';
    wrap.appendChild(h);

    // Upzoning candidates group toggle
    const upLbl = document.createElement('label');
    upLbl.className = 'tools-panel-label flum-upzoning';
    const upCb = document.createElement('input');
    upCb.type = 'checkbox';
    const upSpan = document.createElement('span');
    upSpan.textContent = 'Upzoning candidates';
    upLbl.appendChild(upCb);
    upLbl.appendChild(upSpan);
    wrap.appendChild(upLbl);
    upCb.addEventListener('change', function () { upzoningOnly = this.checked; refresh(); });

    const catHead = document.createElement('div');
    catHead.className = 'filter-subheading';
    catHead.textContent = 'By future land use category';
    wrap.appendChild(catHead);

    listEl = document.createElement('div');
    listEl.className = 'filter-zoning-list';
    wrap.appendChild(listEl);

    noteEl = document.createElement('p');
    noteEl.className = 'filter-note';
    wrap.appendChild(noteEl);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'filter-clear';
    clearBtn.textContent = 'Clear selection';
    clearBtn.addEventListener('click', () => {
      selectedCodes.clear();
      upzoningOnly = false;
      upCb.checked = false;
      listEl.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false; });
      refresh();
    });
    wrap.appendChild(clearBtn);

    content.insertBefore(wrap, content.firstChild);
    populateCategories(upSpan);
  }

  function addCategory(code, label, n) {
    const lbl = document.createElement('label');
    lbl.className = 'filter-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(code);
    cb.addEventListener('change', function () {
      if (this.checked) selectedCodes.add(code);
      else selectedCodes.delete(code);
      refresh();
    });
    const span = document.createElement('span');
    span.textContent = n != null ? `${label} (${n.toLocaleString()})` : label;
    lbl.appendChild(cb);
    lbl.appendChild(span);
    listEl.appendChild(lbl);
  }

  function populateCategories(upSpan) {
    fetch(`${SUPABASE_URL}/rest/v1/parcel_flum_counts?select=flum_code,label,n,upzoning_n&order=n.desc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('view missing'))))
      .then((rows) => {
        if (!Array.isArray(rows) || !rows.length) throw new Error('empty');
        listEl.innerHTML = '';
        let upTotal = 0;
        for (const row of rows) {
          addCategory(row.flum_code, row.label, row.n);
          upTotal += row.upzoning_n || 0;
        }
        if (upTotal && upSpan) upSpan.textContent = `Upzoning candidates (${upTotal.toLocaleString()})`;
      })
      .catch(() => {
        listEl.innerHTML = '';
        const note = document.createElement('p');
        note.className = 'filter-note';
        note.textContent = 'Run scripts/flum_map_select.sql to enable category selection.';
        listEl.appendChild(note);
      });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  map.on('load', () => {
    initLayers();
    buildUI();
  });
})();
