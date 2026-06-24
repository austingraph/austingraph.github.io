// austingraph.chat — Redevelopment / teardown finder
// Adds a "Redevelopment finder" section to the map-tools panel
// (#map-tools-content). Ranks parcels by redevelopment potential (land share of
// value + improvement age + upzoning gap) via the public.redev_candidates_geojson
// RPC, highlights matches on the map (color ramp by score), and exports the
// ranked lead list as CSV. Mirrors flum_overlay.js.
//
// Requires scripts/redev_candidates.sql to be applied in Supabase. Degrades to a
// "run the SQL" note until then.

(() => {
  const { map, SUPABASE_URL, SUPABASE_KEY } = window.AG;

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  let features = [];     // last result set (for CSV export)
  let noteEl, csvBtn;
  let fetchToken = 0;

  // Filter state (defaults match the RPC defaults).
  const state = { minLandSharePct: 50, builtBefore: 1990, upzoningOnly: false, zoningPrefix: null };

  // ── Map highlight layers ────────────────────────────────────────────────────
  function initLayers() {
    map.addSource('redev-highlight', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    const beforeId = map.getLayer('parcels-outline') ? 'parcels-outline' : undefined;
    // Fill colored by score: amber (lower) → red (higher).
    map.addLayer({
      id: 'redev-highlight-fill',
      type: 'fill',
      source: 'redev-highlight',
      paint: {
        'fill-color': ['interpolate', ['linear'], ['get', 'score'],
          50, '#f6c026', 75, '#ef7a1a', 100, '#c0392b'],
        'fill-opacity': 0.5,
      },
    }, beforeId);
    map.addLayer({
      id: 'redev-highlight-line',
      type: 'line',
      source: 'redev-highlight',
      paint: { 'line-color': '#7a2418', 'line-width': 0.6, 'line-opacity': 0.85 },
    }, beforeId);
  }

  // ── Fetch + highlight ───────────────────────────────────────────────────────
  function runSearch() {
    const token = ++fetchToken;
    if (noteEl) noteEl.textContent = 'Searching…';
    if (csvBtn) csvBtn.disabled = true;

    fetch(`${SUPABASE_URL}/rest/v1/rpc/redev_candidates_geojson`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_min_land_share: state.minLandSharePct / 100,
        p_built_before: state.builtBefore,
        p_upzoning_only: state.upzoningOnly,
        p_zoning_prefix: state.zoningPrefix,
        p_limit: 5000,
      }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('rpc missing'))))
      .then((fc) => {
        if (token !== fetchToken) return; // stale
        features = (fc && fc.features) || [];
        map.getSource('redev-highlight')?.setData({ type: 'FeatureCollection', features });
        if (noteEl) {
          const n = features.length;
          noteEl.textContent = n
            ? `${n.toLocaleString()}${n >= 5000 ? '+ (capped)' : ''} candidates — ranked by score`
            : 'No parcels match these filters.';
        }
        if (csvBtn) csvBtn.disabled = features.length === 0;
      })
      .catch(() => {
        if (token !== fetchToken) return;
        features = [];
        if (noteEl) noteEl.textContent = 'Run scripts/redev_candidates.sql to enable.';
        if (csvBtn) csvBtn.disabled = true;
      });
  }

  function clearSearch() {
    ++fetchToken;
    features = [];
    map.getSource('redev-highlight')?.setData({ type: 'FeatureCollection', features: [] });
    if (noteEl) noteEl.textContent = '';
    if (csvBtn) csvBtn.disabled = true;
  }

  // ── CSV export of the ranked lead list ───────────────────────────────────────
  function downloadCsv() {
    if (!features.length) return;
    const cols = ['score', 'parcel_id', 'address', 'zoning_base', 'market_val',
      'land_val', 'impr_val', 'land_share', 'yr_built', 'upzoning_gap'];
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = features
      .map((f) => f.properties)
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const lines = [cols.join(',')];
    for (const p of rows) {
      lines.push(cols.map((c) => esc(c === 'tcad' ? '' : p[c])).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'redevelopment_candidates.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ── UI (appended to the map-tools panel) ─────────────────────────────────────
  function numberInput(value, onChange, opts = {}) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'filter-num';
    input.value = value;
    if (opts.min != null) input.min = opts.min;
    if (opts.max != null) input.max = opts.max;
    if (opts.step != null) input.step = opts.step;
    input.addEventListener('input', function () {
      const v = this.value.trim();
      onChange(v === '' ? null : parseFloat(v));
    });
    return input;
  }

  function labeledRow(labelText, node) {
    const row = document.createElement('div');
    row.className = 'filter-row';
    const span = document.createElement('span');
    span.className = 'filter-inline-label';
    span.textContent = labelText;
    row.appendChild(span);
    row.appendChild(node);
    return row;
  }

  function buildUI() {
    const content = document.getElementById('map-tools-content');
    if (!content) return;

    const wrap = document.createElement('div');
    wrap.className = 'redev-section';

    const sep = document.createElement('hr');
    sep.className = 'tools-panel-sep';
    wrap.appendChild(sep);

    const h = document.createElement('div');
    h.className = 'tools-panel-heading';
    h.textContent = 'Redevelopment finder';
    wrap.appendChild(h);

    // Min land share (%)
    wrap.appendChild(labeledRow('Min land share %',
      numberInput(state.minLandSharePct, (v) => { state.minLandSharePct = v != null ? v : 0; },
        { min: 0, max: 100, step: 5 })));

    // Built before (year)
    wrap.appendChild(labeledRow('Built before',
      numberInput(state.builtBefore, (v) => { state.builtBefore = v != null ? v : 9999; },
        { min: 1900, max: 2026, step: 1 })));

    // Zoning
    const zoneSel = document.createElement('select');
    zoneSel.className = 'filter-select';
    [['', 'All zoning'], ['SF', 'Single-family (SF)'], ['MF', 'Multifamily (MF)']].forEach(([val, lbl]) => {
      const o = document.createElement('option'); o.value = val; o.textContent = lbl; zoneSel.appendChild(o);
    });
    zoneSel.addEventListener('change', function () { state.zoningPrefix = this.value || null; });
    wrap.appendChild(labeledRow('Zoning', zoneSel));

    // Upzoning only
    const upLbl = document.createElement('label');
    upLbl.className = 'filter-check';
    const upCb = document.createElement('input');
    upCb.type = 'checkbox';
    const upSpan = document.createElement('span');
    upSpan.textContent = 'Upzoning candidates only';
    upLbl.appendChild(upCb); upLbl.appendChild(upSpan);
    upCb.addEventListener('change', function () { state.upzoningOnly = this.checked; });
    wrap.appendChild(upLbl);

    // Find button
    const findBtn = document.createElement('button');
    findBtn.className = 'filter-clear';
    findBtn.style.background = '#b8860b';
    findBtn.style.color = '#fff';
    findBtn.style.borderColor = '#b8860b';
    findBtn.textContent = 'Find candidates';
    findBtn.addEventListener('click', runSearch);
    wrap.appendChild(findBtn);

    noteEl = document.createElement('p');
    noteEl.className = 'filter-note';
    wrap.appendChild(noteEl);

    // CSV + clear
    csvBtn = document.createElement('button');
    csvBtn.className = 'filter-clear';
    csvBtn.textContent = '⬇ Download CSV';
    csvBtn.disabled = true;
    csvBtn.addEventListener('click', downloadCsv);
    wrap.appendChild(csvBtn);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'filter-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', clearSearch);
    wrap.appendChild(clearBtn);

    content.appendChild(wrap);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  map.on('load', () => {
    initLayers();
    buildUI();
  });
})();
