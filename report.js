// austingraph.chat — Parcel Report
// Live MapLibre mini-map in the report popup. Fetches compute_envelope
// independently so setback/buildable overlays are reliable regardless of
// main-map timing. Supports terra-draw annotation, distance measurement,
// and PDF/print export via canvas snapshot.

(() => {
  const reportBtn = document.getElementById('panel-report-btn');
  const modal     = document.getElementById('report-modal');
  const closeBtn  = document.getElementById('report-close');
  const toolbar   = document.getElementById('report-toolbar');
  const mapEl     = document.getElementById('report-map');
  const printImg  = document.getElementById('report-print-img');
  const dataEl    = document.getElementById('report-data');
  const notesEl   = document.getElementById('report-notes');
  const footerEl  = document.getElementById('report-footer-bar');
  const titleEl   = document.getElementById('report-title');

  // ── Module state ─────────────────────────────────────────────────────────────
  let reportMap    = null;   // MapLibre instance, created lazily and reused
  let sourcesReady = false;  // true once load handler has added sources+layers
  let pendingGeom  = null;   // parcel geometry waiting to be drawn
  let pendingEnv   = null;   // envelope data waiting to be drawn (null until fetch)
  let envToken     = 0;      // stale-fetch guard

  let draw       = null;
  let measuring  = false;
  let measurePts = [];

  const checks = { setback: null, buildable: null };

  // ── Basemap style ─────────────────────────────────────────────────────────────
  const REPORT_STYLE = {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      aerial: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Tiles &copy; Esri',
      },
      street: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Tiles &copy; Esri',
      },
    },
    layers: [
      { id: 'bg-aerial', type: 'raster', source: 'aerial' },
      { id: 'bg-street', type: 'raster', source: 'street', layout: { visibility: 'none' } },
    ],
  };

  // ── Geometry helpers ──────────────────────────────────────────────────────────
  function eachCoord(geometry, fn) {
    (function walk(c) {
      if (typeof c[0] === 'number') { fn(c); return; }
      c.forEach(walk);
    })(geometry.coordinates);
  }

  function bboxFromGeometry(geometry) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    eachCoord(geometry, ([lon, lat]) => {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    });
    return [[minLon, minLat], [maxLon, maxLat]];
  }

  function centroid(geometry) {
    let sx = 0, sy = 0, n = 0;
    eachCoord(geometry, ([lon, lat]) => { sx += lon; sy += lat; n++; });
    return [sx / n, sy / n];
  }

  // ── Formatting ────────────────────────────────────────────────────────────────
  const FT_PER_M   = 3.280839895;
  const M2_PER_ACRE = 4046.8564224;

  function fmtArea(m2) {
    const acres = m2 / M2_PER_ACRE;
    const sqft  = m2 * FT_PER_M * FT_PER_M;
    if (acres >= 0.5) return `${acres.toFixed(2)} ac (${Math.round(sqft).toLocaleString()} sq ft)`;
    return `${Math.round(sqft).toLocaleString()} sq ft (${acres.toFixed(3)} ac)`;
  }

  function fmtFeet(m) {
    const ft = m * FT_PER_M;
    if (ft >= 1000) return `${Math.round(ft).toLocaleString()} ft (${(ft / 5280).toFixed(2)} mi)`;
    return `${Math.round(ft).toLocaleString()} ft`;
  }

  // ── Layer visibility ──────────────────────────────────────────────────────────
  const SETBACK_LAYERS   = ['rp-setback-fill', 'rp-setback-outline'];
  const BUILDABLE_LAYERS = ['rp-buildable-fill', 'rp-buildable-outline'];

  function setVisible(ids, visible) {
    for (const id of ids) {
      if (reportMap?.getLayer(id))
        reportMap.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  function syncLayers() {
    if (!sourcesReady || !reportMap) return;
    setVisible(SETBACK_LAYERS,   !!checks.setback?.checked);
    setVisible(BUILDABLE_LAYERS, !!checks.buildable?.checked);
  }

  // ── Apply pending data to the map ─────────────────────────────────────────────
  // Called from: (1) map load handler, (2) envelope fetch callback.
  // Both just set pendingGeom/pendingEnv then call applyPending().
  function applyPending() {
    if (!sourcesReady || !reportMap) return;

    const EMPTY = { type: 'FeatureCollection', features: [] };

    reportMap.getSource('rp-parcel')?.setData(
      pendingGeom
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: pendingGeom }] }
        : EMPTY
    );

    const sz = pendingEnv?.setback_zone;
    reportMap.getSource('rp-setback')?.setData(
      sz ? { type: 'FeatureCollection', features: [sz] } : EMPTY
    );

    const bl = pendingEnv?.buildable;
    reportMap.getSource('rp-buildable')?.setData(
      bl ? { type: 'FeatureCollection', features: [bl] } : EMPTY
    );

    if (pendingGeom) {
      reportMap.fitBounds(bboxFromGeometry(pendingGeom),
        { padding: 80, maxZoom: 19, pitch: 0, bearing: 0, animate: false });
    }

    syncLayers();
  }

  // ── Create the mini-map (once) ────────────────────────────────────────────────
  function createReportMap() {
    reportMap = new maplibregl.Map({
      container: mapEl,
      style: REPORT_STYLE,
      preserveDrawingBuffer: true,
      attributionControl: false,
      pitch: 0,
      bearing: 0,
    });
    reportMap.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');

    reportMap.on('load', () => {
      const EMPTY = { type: 'FeatureCollection', features: [] };

      reportMap.addSource('rp-parcel',    { type: 'geojson', data: EMPTY });
      reportMap.addSource('rp-setback',   { type: 'geojson', data: EMPTY });
      reportMap.addSource('rp-buildable', { type: 'geojson', data: EMPTY });

      // Parcel outline
      reportMap.addLayer({ id: 'rp-parcel-outline', type: 'line', source: 'rp-parcel',
        paint: { 'line-color': '#000', 'line-width': 2.5 } });

      // Setback zone
      reportMap.addLayer({ id: 'rp-setback-fill', type: 'fill', source: 'rp-setback',
        paint: { 'fill-color': '#d9534f', 'fill-opacity': 0.3 } });
      reportMap.addLayer({ id: 'rp-setback-outline', type: 'line', source: 'rp-setback',
        paint: { 'line-color': '#d9534f', 'line-width': 1.2 } });

      // Buildable footprint
      reportMap.addLayer({ id: 'rp-buildable-fill', type: 'fill', source: 'rp-buildable',
        paint: { 'fill-color': '#4caf7d', 'fill-opacity': 0.25 } });
      reportMap.addLayer({ id: 'rp-buildable-outline', type: 'line', source: 'rp-buildable',
        paint: { 'line-color': '#4caf7d', 'line-width': 1.5 } });

      // Measure layers
      reportMap.addSource('rp-measure-pts',  { type: 'geojson', data: EMPTY });
      reportMap.addSource('rp-measure-line', { type: 'geojson', data: EMPTY });
      reportMap.addLayer({ id: 'rp-measure-line', type: 'line', source: 'rp-measure-line',
        paint: { 'line-color': '#0a66ff', 'line-width': 2, 'line-dasharray': [3, 2] } });
      reportMap.addLayer({ id: 'rp-measure-pts', type: 'circle', source: 'rp-measure-pts',
        paint: { 'circle-radius': 5, 'circle-color': '#0a66ff',
                 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      reportMap.addLayer({ id: 'rp-measure-labels', type: 'symbol', source: 'rp-measure-pts',
        layout: { 'text-field': ['get', 'label'], 'text-size': 13,
                  'text-offset': [0, -1.3], 'text-anchor': 'bottom',
                  'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': '#0a3aa0', 'text-halo-color': '#fff', 'text-halo-width': 2 } });

      initDraw();
      reportMap.on('click', onMeasureClick);

      sourcesReady = true;
      reportMap.resize();
      applyPending();
    });
  }

  // ── Terra-draw annotation ─────────────────────────────────────────────────────
  function initDraw() {
    const TD  = window.terraDraw;
    const TDA = window.terraDrawMaplibreGlAdapter;
    if (!TD || !TDA) return;
    draw = new TD.TerraDraw({
      adapter: new TDA.TerraDrawMapLibreGLAdapter({ map: reportMap, lib: maplibregl }),
      modes: [
        new TD.TerraDrawSelectMode(),
        new TD.TerraDrawLineStringMode(),
        new TD.TerraDrawPolygonMode(),
        new TD.TerraDrawFreehandMode(),
        new TD.TerraDrawPointMode(),
      ],
    });
    draw.start();
    draw.setMode('select');
  }

  // ── Measure ───────────────────────────────────────────────────────────────────
  function haversine(a, b) {
    const R = 6378137, toRad = (x) => x * Math.PI / 180;
    const dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
    const x = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  function redrawMeasure() {
    let total = 0;
    reportMap.getSource('rp-measure-pts')?.setData({
      type: 'FeatureCollection',
      features: measurePts.map((pt, i) => {
        if (i > 0) total += haversine(measurePts[i - 1], pt);
        const label = i === 0 ? 'Start' : fmtFeet(total);
        return { type: 'Feature', geometry: { type: 'Point', coordinates: pt }, properties: { label } };
      }),
    });
    reportMap.getSource('rp-measure-line')?.setData({
      type: 'FeatureCollection',
      features: measurePts.length > 1
        ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: measurePts } }]
        : [],
    });
  }

  function clearMeasure() {
    measurePts = [];
    const EMPTY = { type: 'FeatureCollection', features: [] };
    reportMap?.getSource('rp-measure-pts')?.setData(EMPTY);
    reportMap?.getSource('rp-measure-line')?.setData(EMPTY);
  }

  function onMeasureClick(e) {
    if (!measuring) return;
    measurePts.push([e.lngLat.lng, e.lngLat.lat]);
    redrawMeasure();
  }

  // ── Fetch envelope for the report ─────────────────────────────────────────────
  function fetchEnvelope(parcelId, envNoteEl) {
    const token = ++envToken;
    if (envNoteEl) envNoteEl.textContent = 'Loading development envelope…';

    fetch(`${window.AG.SUPABASE_URL}/rest/v1/rpc/compute_envelope`, {
      method: 'POST',
      headers: {
        apikey: window.AG.SUPABASE_KEY,
        Authorization: `Bearer ${window.AG.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_parcel_id: parcelId }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (token !== envToken) return;
        if (!modal.classList.contains('open')) return;

        pendingEnv = d?.status === 'ok' ? d : null;

        if (envNoteEl) {
          if (pendingEnv) {
            envNoteEl.textContent = '';
          } else {
            const msgs = {
              no_zoning: 'Outside City of Austin zoning — no envelope available.',
              no_rules:  `Zoning ${d?.zoning_base} not yet in rules table.`,
              not_found: 'Parcel not found in database.',
            };
            envNoteEl.textContent = msgs[d?.status] || 'Development envelope not available for this parcel.';
          }
        }

        applyPending();
      })
      .catch(() => {
        if (token !== envToken) return;
        if (envNoteEl) envNoteEl.textContent = 'Could not fetch development envelope.';
      });
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────────
  function buildToolbar() {
    toolbar.innerHTML = '';

    const row1 = document.createElement('div');
    row1.className = 'report-tb-row';

    const layerLbl = document.createElement('span');
    layerLbl.className = 'report-tool-label';
    layerLbl.textContent = 'Layers:';
    row1.appendChild(layerLbl);

    function layerToggle(text, key) {
      const lbl = document.createElement('label');
      lbl.className = 'report-layer-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      checks[key] = cb;
      cb.addEventListener('change', syncLayers);
      const sp = document.createElement('span');
      sp.textContent = text;
      lbl.appendChild(cb); lbl.appendChild(sp);
      return lbl;
    }

    row1.appendChild(layerToggle('Setback',   'setback'));
    row1.appendChild(layerToggle('Buildable', 'buildable'));

    const baseLbl = document.createElement('span');
    baseLbl.className = 'report-tool-label';
    baseLbl.style.marginLeft = '12px';
    baseLbl.textContent = 'Map:';
    row1.appendChild(baseLbl);

    const aerialBtn = document.createElement('button');
    aerialBtn.textContent = 'Aerial';
    aerialBtn.className = 'active';
    const streetBtn = document.createElement('button');
    streetBtn.textContent = 'Street';
    aerialBtn.addEventListener('click', () => {
      if (reportMap) {
        reportMap.setLayoutProperty('bg-aerial', 'visibility', 'visible');
        reportMap.setLayoutProperty('bg-street', 'visibility', 'none');
      }
      aerialBtn.classList.add('active'); streetBtn.classList.remove('active');
    });
    streetBtn.addEventListener('click', () => {
      if (reportMap) {
        reportMap.setLayoutProperty('bg-aerial', 'visibility', 'none');
        reportMap.setLayoutProperty('bg-street', 'visibility', 'visible');
      }
      streetBtn.classList.add('active'); aerialBtn.classList.remove('active');
    });
    row1.appendChild(aerialBtn); row1.appendChild(streetBtn);
    toolbar.appendChild(row1);

    // Row 2: annotation tools + print
    const row2 = document.createElement('div');
    row2.className = 'report-tb-row';

    const annotLbl = document.createElement('span');
    annotLbl.className = 'report-tool-label';
    annotLbl.textContent = 'Draw:';
    row2.appendChild(annotLbl);

    const modes = [
      { label: '↖ Select',    mode: 'select' },
      { label: '✏️ Freehand', mode: 'freehand' },
      { label: '📏 Line',     mode: 'linestring' },
      { label: '⬡ Area',     mode: 'polygon' },
      { label: '📌 Marker',   mode: 'point' },
    ];
    const modeBtns = {};
    modes.forEach(({ label, mode }) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      if (mode === 'select') btn.classList.add('active');
      btn.addEventListener('click', () => {
        measuring = false;
        reportMap?.getCanvas().style.cursor === '' || (reportMap.getCanvas().style.cursor = '');
        measureBtn.classList.remove('active');
        if (draw) draw.setMode(mode);
        Object.values(modeBtns).forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
      modeBtns[mode] = btn;
      row2.appendChild(btn);
    });

    const measureBtn = document.createElement('button');
    measureBtn.textContent = '📐 Measure';
    measureBtn.addEventListener('click', () => {
      measuring = !measuring;
      measureBtn.classList.toggle('active', measuring);
      if (reportMap) reportMap.getCanvas().style.cursor = measuring ? 'crosshair' : '';
      if (measuring && draw) {
        draw.setMode('select');
        Object.values(modeBtns).forEach((b) => b.classList.remove('active'));
        modeBtns.select?.classList.add('active');
      }
    });
    row2.appendChild(measureBtn);

    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', () => {
      if (draw) {
        const ids = draw.getSnapshot().map((f) => f.id);
        if (ids.length) draw.removeFeatures([ids[ids.length - 1]]);
      }
    });
    row2.appendChild(undoBtn);

    const clearAnnotBtn = document.createElement('button');
    clearAnnotBtn.textContent = 'Clear all';
    clearAnnotBtn.addEventListener('click', () => {
      if (draw) draw.clear();
      clearMeasure();
    });
    row2.appendChild(clearAnnotBtn);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    row2.appendChild(spacer);

    const printBtn = document.createElement('button');
    printBtn.className = 'primary';
    printBtn.textContent = 'Print / Save PDF';
    printBtn.addEventListener('click', () => {
      reportMap.once('idle', () => {
        try {
          printImg.src = reportMap.getCanvas().toDataURL('image/jpeg', 0.92);
          printImg.onload = () => window.print();
        } catch {
          window.print();
        }
      });
      reportMap.triggerRepaint();
    });
    row2.appendChild(printBtn);
    toolbar.appendChild(row2);

    const envNoteEl = document.createElement('p');
    envNoteEl.className = 'report-env-note';
    toolbar.appendChild(envNoteEl);

    return envNoteEl;
  }

  // ── Data summary ──────────────────────────────────────────────────────────────
  function el(id) {
    const n = document.getElementById(id);
    return (n && n.textContent.trim()) || '—';
  }

  function makeSection(title, rows) {
    const sec = document.createElement('div');
    sec.className = 'report-section';
    const h = document.createElement('div');
    h.className = 'report-section-title';
    h.textContent = title;
    sec.appendChild(h);
    const dl = document.createElement('dl');
    for (const [label, value] of rows) {
      const div = document.createElement('div');
      div.className = 'report-row';
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value || '—';
      div.appendChild(dt); div.appendChild(dd); dl.appendChild(div);
    }
    sec.appendChild(dl);
    return sec;
  }

  function populateData(data) {
    dataEl.innerHTML = '';
    const s = data.stats;
    dataEl.appendChild(makeSection('Parcel identity', [
      ['TCAD ID',    el('panel-parcel-id')],
      ['Address',    el('meta-address')],
      ['Legal',      el('meta-legal')],
      ['TCAD Acres', el('meta-acres')],
      ['Geo ID',     el('meta-geoid')],
    ]));
    dataEl.appendChild(makeSection('Dimensions', [
      ['Area',      fmtArea(s.areaM2)],
      ['Perimeter', fmtFeet(s.perimM)],
      ['Width',     fmtFeet(s.widthM)],
      ['Height',    fmtFeet(s.heightM)],
    ]));
    dataEl.appendChild(makeSection('Development potential', [
      ['Zoning',         el('env-zoning')],
      ['Setbacks',       el('env-setbacks')],
      ['Buildable ft²',  el('env-buildable')],
      ['Max FAR',        el('env-far')],
      ['Impervious cap', el('env-impervious')],
      ['Max height',     el('env-height')],
      ['Max units',      el('env-units')],
    ]));
    const casesEl   = document.getElementById('conn-cases');
    const permitsEl = document.getElementById('conn-permits');
    const firstCase  = casesEl?.querySelector('.conn-title')?.textContent || '—';
    const caseStatus = casesEl?.querySelector('.conn-badge')?.textContent  || '';
    const permitCount = permitsEl?.querySelectorAll('.conn-item').length ?? 0;
    dataEl.appendChild(makeSection('Civic connections', [
      ['Latest case',  firstCase + (caseStatus ? ` (${caseStatus})` : '')],
      ['Permit count', permitCount > 0 ? String(permitCount) : '—'],
    ]));
  }

  function buildFooter(data) {
    const [lon, lat] = centroid(data.geometry);
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const tcadUrl = `https://travis.prodigycad.com/property-detail/${data.parcelId}`;
    footerEl.innerHTML =
      `<span>Generated ${date}</span>` +
      `<span>Centroid: ${lat.toFixed(5)}°N, ${Math.abs(lon).toFixed(5)}°W</span>` +
      `<span><a href="${tcadUrl}" target="_blank" rel="noopener" style="color:#b8860b">TCAD record →</a></span>`;
  }

  // ── Open / close ──────────────────────────────────────────────────────────────
  function openReport() {
    const data = window.AG?.lastPanelData;
    if (!data) return;

    titleEl.textContent = `Parcel Report — ${data.parcelId}`;
    notesEl.value = '';
    printImg.src = '';
    printImg.style.display = 'none';
    measuring = false;
    measurePts = [];

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');

    const envNoteEl = buildToolbar();
    populateData(data);
    buildFooter(data);

    pendingGeom = data.geometry;
    pendingEnv  = null;

    if (!reportMap) {
      // Double rAF: first frame commits display:flex layout; second reads correct dimensions.
      requestAnimationFrame(() => requestAnimationFrame(() => createReportMap()));
    } else {
      reportMap.resize();
      if (draw) draw.clear();
      clearMeasure();
      applyPending();
    }

    fetchEnvelope(data.parcelId, envNoteEl);
  }

  function closeReport() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    measuring = false;
    if (reportMap) reportMap.getCanvas().style.cursor = '';
  }

  reportBtn.addEventListener('click', openReport);
  closeBtn.addEventListener('click', closeReport);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeReport(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeReport();
  });
})();
