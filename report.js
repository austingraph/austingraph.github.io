// austingraph.chat — Parcel Report
// Live MapLibre mini-map in the report popup, showing the selected parcel
// outline over aerial/street imagery. Supports terra-draw annotation, distance
// measurement, and PDF/print export via canvas snapshot. The development
// envelope (setback / buildable / 3D massing) is visualized on the MAIN map by
// envelope.js; the report focuses on the parcel, its data, and annotations.

(() => {
  const reportBtn = document.getElementById('panel-report-btn');
  const modal     = document.getElementById('report-modal');
  const closeBtn  = document.getElementById('report-close');
  const toolbar   = document.getElementById('report-toolbar');
  const mapEl     = document.getElementById('report-map');
  const locatorEl = document.getElementById('report-locator');
  const printImg    = document.getElementById('report-print-img');
  const printImgLoc = document.getElementById('report-print-img-locator');
  const dataEl    = document.getElementById('report-data');
  const notesEl   = document.getElementById('report-notes');
  const footerEl  = document.getElementById('report-footer-bar');
  const titleEl   = document.getElementById('report-title');
  const subtitleEl = document.getElementById('report-subtitle');

  // ── Module state ─────────────────────────────────────────────────────────────
  let reportMap    = null;   // MapLibre instance, created lazily and reused
  // Resets the on-map basemap control (Aerial active, Buildings off, flat pitch);
  // assigned when attachBasemapControl runs. No-op until then.
  let resetBasemapControl = () => {};
  let sourcesReady = false;  // true once load handler has added sources+layers
  let pendingGeom  = null;   // parcel geometry waiting to be drawn

  let locatorMap    = null;  // small city-context map, created lazily and reused
  let locatorMarker = null;  // marker pinning the parcel within Austin

  let draw       = null;
  let measuring  = false;
  let measurePts = [];
  let demoCtr    = 0;        // stale-fetch guard for demographics
  let valCtr     = 0;        // stale-fetch guard for value-context ($/sqft percentiles)
  let histCtr    = 0;        // stale-fetch guard for value history (trend sparkline)

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
      // Vector buildings (same source the main map uses) for the Buildings toggle.
      openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'bg-aerial', type: 'raster', source: 'aerial' },
      { id: 'bg-street', type: 'raster', source: 'street', layout: { visibility: 'none' } },
      // Extruded 3D building footprints — hidden until the Buildings button is pressed.
      {
        id: 'rp-buildings-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13,
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': 'hsl(35, 8%, 75%)',
          'fill-extrusion-height': ['get', 'render_height'],
          'fill-extrusion-base': ['get', 'render_min_height'],
          'fill-extrusion-opacity': 0.85,
        },
      },
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

  // ── Apply pending parcel geometry to the map ──────────────────────────────────
  // Called from the map load handler and from openReport() on re-open.
  function applyPending() {
    if (!sourcesReady || !reportMap) return;

    const EMPTY = { type: 'FeatureCollection', features: [] };

    reportMap.getSource('rp-parcel')?.setData(
      pendingGeom
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: pendingGeom }] }
        : EMPTY
    );

    if (pendingGeom) {
      reportMap.fitBounds(bboxFromGeometry(pendingGeom),
        { padding: 80, maxZoom: 19, pitch: 0, bearing: 0, animate: false });
    }
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
    // Lock zoom: the report focuses on a single parcel, so zooming in/out
    // doesn't make sense. Disable all zoom interactions; panning stays enabled.
    reportMap.scrollZoom.disable();
    reportMap.boxZoom.disable();
    reportMap.doubleClickZoom.disable();
    reportMap.touchZoomRotate.disableRotation();
    reportMap.touchZoomRotate.disable();
    // NavigationControl with zoom buttons omitted on purpose (zoom is locked).

    reportMap.on('load', () => {
      const EMPTY = { type: 'FeatureCollection', features: [] };

      reportMap.addSource('rp-parcel', { type: 'geojson', data: EMPTY });

      // Parcel outline
      reportMap.addLayer({ id: 'rp-parcel-outline', type: 'line', source: 'rp-parcel',
        paint: { 'line-color': '#000', 'line-width': 2.5 } });

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

      attachOverlayControl(reportMap, mapEl, 'rp-parcel-outline');
      attachBasemapControl(reportMap, mapEl);

      sourcesReady = true;
      reportMap.resize();
      applyPending();
    });
  }

  // ── City locator map (1/3) ─────────────────────────────────────────────────────
  // A simple, non-interactive map of Austin (Esri street basemap shows I-35,
  // US-183/Research, MoPac and city labels) with a marker on the parcel, so the
  // reader sees where in the city the parcel sits.
  const AUSTIN_CENTER = [-97.78, 30.30];
  const LOCATOR_STYLE = {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      locator: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Tiles &copy; Esri',
      },
    },
    layers: [{ id: 'locator-bg', type: 'raster', source: 'locator' }],
  };

  function updateLocator() {
    if (!locatorMap || !pendingGeom) return;
    const [lon, lat] = centroid(pendingGeom);
    if (!locatorMarker) {
      locatorMarker = new maplibregl.Marker({ color: '#c0392b' }).setLngLat([lon, lat]).addTo(locatorMap);
    } else {
      locatorMarker.setLngLat([lon, lat]);
    }
  }

  function createLocatorMap() {
    locatorMap = new maplibregl.Map({
      container: locatorEl,
      style: LOCATOR_STYLE,
      center: AUSTIN_CENTER,
      zoom: 9.3,
      interactive: false,
      attributionControl: false,
      preserveDrawingBuffer: true,   // so its canvas can be baked for printing
    });
    locatorMap.on('load', () => {
      locatorMap.resize();
      updateLocator();
      attachOverlayControl(locatorMap, locatorEl);
    });
  }

  // ── Overlay control (reused on each report map) ────────────────────────────────
  // Reuses window.AG.OVERLAYS (defined in maptools.js) — the same GeoJSON files /
  // color properties the main map uses. Builds a small floating "Overlays" button
  // + checkbox dropdown over the given map and lazy-loads each overlay onto it.
  function attachOverlayControl(targetMap, container, beforeId) {
    const overlays = window.AG.OVERLAYS || [];
    if (!overlays.length || !container) return;
    const palette = ['#4285f4', '#ea4335', '#fbbc04', '#34a853', '#ff6d00', '#46bdc6', '#7b1fa2', '#f06292'];

    const ctrl = document.createElement('div');
    ctrl.className = 'report-ovl-ctrl';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'report-ovl-btn';
    btn.textContent = 'Overlays ▾';
    const menu = document.createElement('div');
    menu.className = 'report-ovl-menu';
    menu.hidden = true;
    ctrl.appendChild(btn);
    ctrl.appendChild(menu);
    container.appendChild(ctrl);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.classList.toggle('open', !menu.hidden);
    });
    document.addEventListener('click', (e) => {
      if (!ctrl.contains(e.target)) { menu.hidden = true; btn.classList.remove('open'); }
    });

    overlays.forEach((ov, i) => {
      const id = 'rovl' + i;
      let loaded = false;
      const lbl = document.createElement('label');
      lbl.className = 'report-ovl-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const span = document.createElement('span');
      span.textContent = ov.label;
      lbl.appendChild(cb); lbl.appendChild(span);
      menu.appendChild(lbl);

      cb.addEventListener('change', async () => {
        if (!loaded) {
          cb.disabled = true; span.textContent = ov.label + ' (loading…)';
          try {
            const data = await (await fetch(ov.file)).json();
            let colorExpr = '#4285f4';
            if (ov.colorProperty) {
              const vals = [...new Set(data.features.map((f) => f.properties[ov.colorProperty]))];
              const m = ['match', ['get', ov.colorProperty]];
              vals.forEach((v, idx) => m.push(v, palette[idx % palette.length]));
              m.push('#888');
              colorExpr = m;
            }
            const before = (beforeId && targetMap.getLayer(beforeId)) ? beforeId : undefined;
            targetMap.addSource(id, { type: 'geojson', data });
            targetMap.addLayer({ id: id + '-fill', type: 'fill', source: id,
              layout: { visibility: 'none' },
              paint: { 'fill-color': colorExpr, 'fill-opacity': 0.35 } }, before);
            targetMap.addLayer({ id: id + '-line', type: 'line', source: id,
              layout: { visibility: 'none' },
              paint: { 'line-color': '#222', 'line-width': 1.5, 'line-opacity': 0.85 } }, before);
            if (ov.labelField) {
              targetMap.addLayer({ id: id + '-label', type: 'symbol', source: id,
                layout: {
                  visibility: 'none',
                  'text-field': ['to-string', ['get', ov.labelField]],
                  'text-size': 12,
                  'text-font': ['Noto Sans Regular'],
                  'text-max-width': 8,
                },
                paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 2 } }, before);
            }
            loaded = true;
          } catch (err) {
            console.error('Report overlay load error:', ov.file, err);
            span.textContent = ov.label + ' (error)'; cb.disabled = false; cb.checked = false; return;
          }
          span.textContent = ov.label; cb.disabled = false;
        }
        const vis = cb.checked ? 'visible' : 'none';
        if (targetMap.getLayer(id + '-fill')) targetMap.setLayoutProperty(id + '-fill', 'visibility', vis);
        if (targetMap.getLayer(id + '-line')) targetMap.setLayoutProperty(id + '-line', 'visibility', vis);
        if (targetMap.getLayer(id + '-label')) targetMap.setLayoutProperty(id + '-label', 'visibility', vis);
      });
    });
  }

  // ── On-map basemap control (Aerial / Street / Buildings) ──────────────────────
  // A floating button row in the map's top-left corner (the Overlays control sits
  // top-right). Aerial/Street are a mutually-exclusive pair; Buildings is an
  // independent toggle that shows extruded 3D footprints — and tilts the map so the
  // extrusions are actually visible (they don't render at pitch 0).
  function attachBasemapControl(targetMap, container) {
    if (!container) return;

    const ctrl = document.createElement('div');
    ctrl.className = 'report-basemap-ctrl';

    const mkBtn = (text, active, extraClass) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'report-basemap-btn' + (extraClass ? ' ' + extraClass : '');
      b.textContent = text;
      if (active) b.classList.add('active');
      return b;
    };

    const aerialBtn = mkBtn('Aerial', true);
    const streetBtn = mkBtn('Street', false);
    const bldgBtn   = mkBtn('Buildings', false, 'report-basemap-sep');

    const showAerial = (aerial) => {
      if (targetMap.getLayer('bg-aerial')) targetMap.setLayoutProperty('bg-aerial', 'visibility', aerial ? 'visible' : 'none');
      if (targetMap.getLayer('bg-street')) targetMap.setLayoutProperty('bg-street', 'visibility', aerial ? 'none' : 'visible');
      aerialBtn.classList.toggle('active', aerial);
      streetBtn.classList.toggle('active', !aerial);
    };
    const setBuildings = (on) => {
      bldgBtn.classList.toggle('active', on);
      if (targetMap.getLayer('rp-buildings-3d')) {
        targetMap.setLayoutProperty('rp-buildings-3d', 'visibility', on ? 'visible' : 'none');
      }
      targetMap.easeTo({ pitch: on ? 50 : 0, duration: 500 });
    };

    aerialBtn.addEventListener('click', () => showAerial(true));
    streetBtn.addEventListener('click', () => showAerial(false));
    bldgBtn.addEventListener('click', () => setBuildings(!bldgBtn.classList.contains('active')));

    ctrl.appendChild(aerialBtn);
    ctrl.appendChild(streetBtn);
    ctrl.appendChild(bldgBtn);
    container.appendChild(ctrl);

    // Each report opens flat, aerial, buildings off.
    resetBasemapControl = () => { showAerial(true); setBuildings(false); };
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

  // Bake a live map's canvas into an <img> for printing (the maps themselves are
  // hidden at @media print). Resolves when the image is ready — or on any failure,
  // so a missing/empty map never hangs the print. Needs preserveDrawingBuffer.
  function snapshotMap(map, img) {
    return new Promise((resolve) => {
      if (!map || !img) { if (img) { img.src = ''; img.style.display = 'none'; } resolve(); return; }
      map.once('idle', () => {
        try {
          img.onload = () => resolve();
          img.onerror = () => { img.style.display = 'none'; resolve(); };
          img.style.display = '';
          img.src = map.getCanvas().toDataURL('image/jpeg', 0.92);
        } catch {
          img.src = '';
          img.style.display = 'none';
          resolve();
        }
      });
      map.triggerRepaint();
    });
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────────
  function buildToolbar() {
    toolbar.innerHTML = '';

    // Basemap (Aerial/Street) + Buildings now live on the map itself
    // (attachBasemapControl); the toolbar is just annotation tools + print.
    const row2 = document.createElement('div');
    row2.className = 'report-tb-row';

    const modes = [
      { label: 'Polygon', mode: 'polygon' },
      { label: 'Line',    mode: 'linestring' },
      { label: 'Pin',     mode: 'point' },
    ];
    const modeBtns = {};
    modes.forEach(({ label, mode }) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        measuring = false;
        if (reportMap) reportMap.getCanvas().style.cursor = '';
        measureBtn.classList.remove('active');
        if (draw) draw.setMode(mode);
        Object.values(modeBtns).forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
      modeBtns[mode] = btn;
      row2.appendChild(btn);
    });

    const measureBtn = document.createElement('button');
    measureBtn.textContent = 'Measure';
    measureBtn.addEventListener('click', () => {
      measuring = !measuring;
      measureBtn.classList.toggle('active', measuring);
      if (reportMap) reportMap.getCanvas().style.cursor = measuring ? 'crosshair' : '';
      if (measuring && draw) {
        draw.setMode('select');
        Object.values(modeBtns).forEach((b) => b.classList.remove('active'));
      }
    });
    row2.appendChild(measureBtn);

    const clearAnnotBtn = document.createElement('button');
    clearAnnotBtn.textContent = 'Clear';
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
    printBtn.textContent = 'Print/Save PDF';
    printBtn.addEventListener('click', () => {
      // Bake BOTH live maps into their print <img>s, then print. The maps are
      // hidden at @media print and these snapshots are shown side by side.
      Promise.all([
        snapshotMap(reportMap, printImg),
        snapshotMap(locatorMap, printImgLoc),
      ]).then(() => window.print());
    });
    row2.appendChild(printBtn);
    toolbar.appendChild(row2);
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
    for (const [label, value, info] of rows) {
      const div = document.createElement('div');
      div.className = 'report-row';
      const dt = document.createElement('dt'); dt.textContent = label;
      if (info) {
        const ic = document.createElement('span');
        ic.className = 'info-icon';
        ic.setAttribute('data-tip', info);
        ic.setAttribute('aria-label', info);
        ic.setAttribute('tabindex', '0');
        ic.textContent = 'i';
        dt.appendChild(ic);
      }
      const dd = document.createElement('dd'); dd.textContent = value || '—';
      div.appendChild(dt); div.appendChild(dd); dl.appendChild(div);
    }
    sec.appendChild(dl);
    return sec;
  }

  function populateData(data) {
    dataEl.innerHTML = '';
    // Single-column body: Appraisal & Tax (the facts) reads first, then the
    // Development-feasibility ledger (the analysis). Parcel id/address live in
    // the report title, so the old "Parcel identity" card is dropped as redundant.
    const detailCol = document.createElement('div');
    detailCol.className = 'report-col';
    detailCol.id = 'report-detail-col';
    const feasCol = document.createElement('div');
    feasCol.className = 'report-col';
    feasCol.id = 'report-feas-col';
    dataEl.appendChild(detailCol);
    dataEl.appendChild(feasCol);

    detailCol.appendChild(buildAppraisalSection(data));
    const aff = buildAffordabilitySection(data);
    if (aff) detailCol.appendChild(aff);
  }

  // Full appraisal/tax block + derived investor signals, from the row stashed by
  // app.js (window.AG.lastPanelData.dbRow). Mirrors the panel summary but complete.
  function buildAppraisalSection(data) {
    const row     = data.dbRow || {};
    const labels  = window.AG.EXEMPTION_LABELS || {};
    const taxRate = (window.AG.taxRateForRow ? window.AG.taxRateForRow(row) : null) || window.AG.APPROX_TAX_RATE || 0.02;
    const usd = (n) => (n != null && n !== 0) ? '$' + Math.round(n).toLocaleString() : '—';

    const market   = row.appr_market_val;
    const land     = row.appr_land_val;
    const impr     = row.appr_impr_val;
    const assessed = row.appr_assessed_val;

    if (market == null) {
      return makeSection('Appraisal & Tax', [['Status', 'No appraisal data for this parcel.']]);
    }

    const tcadAcres = parseFloat(row.metadata?.tcad_acres) || 0;
    // Prefer the authoritative TCAD land-segment size; fall back to acreage, then geometry.
    const lotSqft   = (row.appr_land_sqft > 0) ? row.appr_land_sqft
                    : tcadAcres > 0 ? tcadAcres * 43560
                    : (data.stats?.areaM2 || 0) * 10.7639104;
    const taxBase   = assessed || market;
    const estTax    = Math.round(taxBase * taxRate);
    const thisYear  = new Date().getFullYear();
    const codes     = Array.isArray(row.appr_exemptions) ? row.appr_exemptions : [];

    const rows = [];
    rows.push(['Market value',      usd(market),
      "TCAD's total market value — land plus improvements."]);
    rows.push(['Land value',        usd(land),
      "TCAD's value of the land alone."]);
    rows.push(['Improvement value', usd(impr),
      "TCAD's value of the building(s) on the land."]);
    const landUse = (window.AG.stateCdLabel ? window.AG.stateCdLabel(row.appr_state_cd) : null);
    if (landUse) rows.push(['Land use', `${landUse}${row.appr_state_cd ? ` (${row.appr_state_cd})` : ''}`,
      'TCAD/PTAD state category — how the property is classified for appraisal.']);
    if (row.appr_appraised_val != null && row.appr_appraised_val < market) {
      rows.push(['Appraised value', usd(row.appr_appraised_val),
        'Market value after caps (e.g. the homestead 10% cap) — the basis before exemptions.']);
    }
    rows.push(['Assessed value',
      (assessed != null && assessed < market * 0.95) ? `${usd(assessed)} (homestead cap)` : usd(assessed),
      'Value used for taxes. May sit below market when a homestead 10% cap applies.']);
    if (row.appr_cap_loss) rows.push(['Homestead cap savings', usd(row.appr_cap_loss),
      'How far the 10% homestead cap holds the taxable value below market — a long-tenure / equity signal.']);
    if (row.appr_taxable_val != null) rows.push(['Taxable value', usd(row.appr_taxable_val),
      'The value the tax bill is actually computed on, after exemptions.']);
    rows.push(['Exemptions', codes.length ? codes.map((c) => labels[c] || c).join(', ') : 'None',
      'Tax exemptions on record (e.g. homestead, over-65, disabled veteran).']);
    rows.push(['Est. annual tax', `${usd(estTax)}/yr (~${(taxRate * 100).toFixed(1)}% combined)`,
      'Estimate = assessed value × a representative combined rate chosen by jurisdiction (full-purpose Austin ≈ 2.0%, ETJ/limited ≈ 1.6%). A true bill depends on the exact overlapping taxing units (county, city, ISD, MUD, ESD).']);
    rows.push(['Tax as % of market', `${(estTax / market * 100).toFixed(2)}%`,
      'Estimated annual tax divided by market value.']);
    // Neighborhood market context (Redfin sale $/sqft + Zillow ZORI rent) by ZIP.
    const mkt = data.market || (window.AG.lastPanelData && window.AG.lastPanelData.market);
    if (mkt && mkt.status === 'ok') {
      if (mkt.median_sale_ppsf) rows.push(['Neighborhood sale $/sqft',
        `$${Math.round(mkt.median_sale_ppsf).toLocaleString()}/sqft (ZIP ${mkt.zip})`,
        'Redfin median sale price per sqft for this ZIP — the market benchmark behind the feasibility Sale-price default. Aggregate (non-disclosure state), so use the Comps links to refine.']);
      if (mkt.zori_rent) rows.push(['Neighborhood market rent',
        `$${Math.round(mkt.zori_rent).toLocaleString()}/mo (ZIP ${mkt.zip})`,
        'Zillow Observed Rent Index (ZORI) for this ZIP — typical asking rent, behind the feasibility Rent default.']);
    }
    if (land && market)        rows.push(['Land share of value', `${Math.round(land / market * 100)}% (redevelopment signal)`,
      'Land value ÷ market value. A high share can signal a tear-down / redevelopment candidate.']);
    if (land && lotSqft > 0)   rows.push(['Land $/sqft', `$${(land / lotSqft).toFixed(2)}`,
      'Land value divided by lot size — a land-price benchmark.']);
    if (impr && row.appr_living_sqft) rows.push(['Building $/sqft', `$${Math.round(impr / row.appr_living_sqft).toLocaleString()}`,
      'Improvement value ÷ finished floor area.']);
    if (lotSqft > 0) rows.push(['Lot size', `${Math.round(lotSqft).toLocaleString()} sq ft (${(lotSqft / 43560).toFixed(3)} ac)`,
      'Land area (TCAD land segments where available, else parcel geometry).']);
    if (row.appr_yr_built)     rows.push(['Year built', `${row.appr_yr_built} (${thisYear - row.appr_yr_built} yrs old)`,
      'Year the main improvement was built, with its age.']);
    if (row.appr_living_sqft)  rows.push(['Living area', `${row.appr_living_sqft.toLocaleString()} sq ft`,
      'Finished floor area from TCAD (excludes garage, porch, etc.).']);
    if (row.appr_class)        rows.push(['Construction class', row.appr_class,
      'TCAD construction-class / quality grade of the main improvement.']);
    if (row.appr_neighborhood) rows.push(['TCAD neighborhood', row.appr_neighborhood,
      "TCAD's mass-appraisal neighborhood — the comparison group used for the $/sqft percentiles above."]);
    // Owner name intentionally withheld; available from the TCAD appraisal roll.
    rows.push(['Owner', 'Available from TCAD appraisal roll',
      'Owner names are not shown on the site; look the parcel up at TCAD if you need ownership.']);
    const ownerState = row.appr_owner_state;
    if (ownerState) {
      rows.push(['Owner location', ownerState !== 'TX' ? `Out-of-state (${ownerState})` : `In-state (${ownerState})`,
        "The owner's mailing-address state. Out-of-state can signal an absentee investor."]);
    }
    if (row.appr_data_yr) rows.push(['Source', `TCAD ${row.appr_data_yr} appraisal roll`,
      'The TCAD appraisal-roll year these figures come from.']);

    const sec = makeSection('Appraisal & Tax', rows);

    // Land-vs-building value-composition bar, just under the section title.
    const splitHtml = window.AG.makeValueSplit ? window.AG.makeValueSplit(land, impr) : '';
    if (splitHtml) {
      const bar = document.createElement('div');
      bar.className = 'value-split report-value-split';
      bar.innerHTML = splitHtml;
      sec.insertBefore(bar, sec.children[1]); // after title, before the <dl>
    }

    // Placeholder for the $/sqft neighborhood-percentile bars, filled async by
    // fetchValueContext(). Stays empty (and invisible) if the RPC isn't present.
    const vctx = document.createElement('div');
    vctx.className = 'value-context';
    vctx.id = 'report-value-ctx';
    sec.insertBefore(vctx, sec.children[splitHtml ? 2 : 1]); // after the split bar (or title)

    // Placeholder for the value-over-time sparkline, filled async by
    // fetchValueHistory(). Stays empty until ≥2 years of history are present.
    const vhist = document.createElement('div');
    vhist.className = 'value-history';
    vhist.id = 'report-value-history';
    sec.insertBefore(vhist, vctx.nextSibling);

    // Comps & listings: deep links to live market data so the user can sanity-
    // check the appraised values and the feasibility Sale-price / Rent inputs.
    // Texas is a non-disclosure state, so these portals are the practical place
    // to see real prices for the parcel's area.
    const compsRow = buildCompsLinks(data, row);
    if (compsRow) sec.appendChild(compsRow);
    return sec;
  }

  // External market-comp + listings links for the parcel: sale comps, rent comps,
  // and the city permit/fee portal. Built from the situs address + zip + centroid.
  function buildCompsLinks(data, row) {
    const addr = (row.metadata?.situs_address || '').trim();
    const zip  = (addr.match(/\b(\d{5})\b/) || [])[1] || '';
    const comm = /^(CS|GR|CH|CBD|MU|MF|DMU|CR|W\/|L[IR])/i.test(row.zoning_base || '');

    // Address slug for portals that geocode a free-form address (Zillow _rb).
    let slug = addr;
    if (slug && !/austin/i.test(slug)) slug += ' Austin';
    if (slug && !/\bTX\b/i.test(slug)) slug += ' TX';
    slug = slug.trim().replace(/\s+/g, '-');

    const links = [];
    if (slug) {
      links.push(['Zillow (for sale)', `https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`]);
      links.push(['Zillow (rentals)',  `https://www.zillow.com/homes/for_rent/${encodeURIComponent(slug)}_rb/`]);
    }
    if (zip) {
      links.push(['Redfin',      `https://www.redfin.com/zipcode/${zip}`]);
      links.push(['Realtor.com', `https://www.realtor.com/realestateandhomes-search/${zip}`]);
    }
    if (comm) links.push(['LoopNet (commercial)', 'https://www.loopnet.com/search/commercial-real-estate/austin-tx/for-sale/']);
    links.push(['Austin permits & fees', 'https://www.austintexas.gov/department/development-services']);

    if (!links.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'report-links-wrap';
    const lbl = document.createElement('div');
    lbl.className = 'report-links-label';
    lbl.textContent = 'Comps & listings';
    const box = document.createElement('div');
    box.className = 'report-links';
    box.innerHTML = links
      .map(([t, h]) => `<a href="${h}" target="_blank" rel="noopener">${t} ↗</a>`)
      .join('');
    wrap.appendChild(lbl); wrap.appendChild(box);
    return wrap;
  }

  // ── $/sqft neighborhood percentile (parcel_value_context RPC) ────────────────
  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  function makePercentileBar(label, m, zoning) {
    if (!m || m.value == null || m.percentile == null) return null;
    const pct = Math.max(0, Math.min(100, Math.round(m.percentile)));
    const usd = (n) => '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

    const row = document.createElement('div');
    row.className = 'pctl-row';

    const lab = document.createElement('div');
    lab.className = 'pctl-label';
    lab.textContent = label;
    const ic = document.createElement('span');
    ic.className = 'info-icon';
    const tip = `Where this parcel's ${label.toLowerCase()} falls among the ${m.n} nearest ${zoning || 'same-zoning'} parcels. Higher = pricier than neighbors; a low building $/sqft percentile can flag an older or under-built improvement (a redevelopment signal).`;
    ic.setAttribute('data-tip', tip);
    ic.setAttribute('aria-label', tip);
    ic.setAttribute('tabindex', '0');
    ic.textContent = 'i';
    lab.appendChild(ic);

    const track = document.createElement('div');
    track.className = 'pctl-track';
    track.innerHTML =
      `<span class="pctl-fill" style="width:${pct}%"></span>` +
      `<span class="pctl-median" title="cohort median"></span>` +
      `<span class="pctl-mark" style="left:${pct}%"></span>`;

    const cap = document.createElement('div');
    cap.className = 'pctl-cap';
    cap.textContent = `${usd(m.value)}/sqft · ${ordinal(pct)} percentile · median ${usd(m.median)} · ${m.n} nearby ${zoning || ''}`.trim();

    row.appendChild(lab);
    row.appendChild(track);
    row.appendChild(cap);
    return row;
  }

  function renderValueContext(d) {
    const box = document.getElementById('report-value-ctx');
    if (!box) return;
    const bars = [
      makePercentileBar('Building $/sqft', d.building_psf, d.zoning_base),
      makePercentileBar('Land $/sqft', d.land_psf, d.zoning_base),
    ].filter(Boolean);
    if (!bars.length) return;            // nothing to show; leave hidden

    box.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'value-context-title';
    h.textContent = `Value vs. nearby ${d.zoning_base || 'parcels'}`;
    box.appendChild(h);
    bars.forEach((b) => box.appendChild(b));
    box.classList.add('has-data');
  }

  function fetchValueContext(parcelId, token) {
    fetch(`${window.AG.SUPABASE_URL}/rest/v1/rpc/parcel_value_context`, {
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
        if (token !== valCtr) return;                  // a newer parcel was opened
        if (!modal.classList.contains('open')) return;
        if (d && d.status === 'ok') renderValueContext(d);
      })
      .catch(() => {});                                // RPC absent / offline: stay hidden
  }

  // ── Value-over-time sparkline (parcel_value_history RPC) ─────────────────────
  // Builds a small inline SVG line of market value by year, with endpoint labels
  // and total change. Returns null with < 2 years (no trend to show).
  function makeSparkline(series) {
    const pts = (series || [])
      .filter((d) => d && d.yr && d.market != null && d.market > 0)
      .sort((a, b) => a.yr - b.yr);
    if (pts.length < 2) return null;

    const W = 280, H = 54, pad = 4;
    const ys = pts.map((p) => p.market);
    const min = Math.min(...ys), max = Math.max(...ys), span = (max - min) || 1;
    const x = (i) => pad + (i * (W - 2 * pad)) / (pts.length - 1);
    const y = (v) => H - pad - ((v - min) / span) * (H - 2 * pad);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.market).toFixed(1)}`).join(' ');
    const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.market).toFixed(1)}" r="2" />`).join('');

    const first = pts[0], last = pts[pts.length - 1];
    const usd = (n) => '$' + Math.round(n).toLocaleString();
    const pctChange = ((last.market - first.market) / first.market) * 100;
    const sign = pctChange >= 0 ? '+' : '';
    const cls = pctChange >= 0 ? 'up' : 'down';

    const wrap = document.createElement('div');
    wrap.className = 'spark';
    wrap.innerHTML =
      `<div class="value-context-title">Market value trend</div>` +
      `<svg class="spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
        `<path d="${line}" fill="none" />${dots}</svg>` +
      `<div class="spark-cap">${first.yr} ${usd(first.market)} → ${last.yr} ${usd(last.market)} ` +
        `<span class="spark-chg ${cls}">${sign}${pctChange.toFixed(0)}%</span></div>`;
    return wrap;
  }

  function fetchValueHistory(parcelId, token) {
    fetch(`${window.AG.SUPABASE_URL}/rest/v1/rpc/parcel_value_history`, {
      method: 'POST',
      headers: {
        apikey: window.AG.SUPABASE_KEY,
        Authorization: `Bearer ${window.AG.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_parcel_id: parcelId }),
    })
      .then((r) => r.json())
      .then((series) => {
        if (token !== histCtr) return;
        if (!modal.classList.contains('open')) return;
        const box = document.getElementById('report-value-history');
        const spark = makeSparkline(series);
        if (box && spark) { box.innerHTML = ''; box.appendChild(spark); box.classList.add('has-data'); }
      })
      .catch(() => {});                                // RPC absent / offline: stay hidden
  }

  // Affordability lens — reframes value in housing-affordability terms (planner
  // view) and valuation context (RE-pro view), from the parcel value + the ACS
  // demographics neighborhood.js cached on lastPanelData. Returns null when there
  // are no neighborhood inputs to compute.
  function buildAffordabilitySection(data) {
    const row = data.dbRow || {};
    const market = row.appr_market_val;
    if (market == null) return null;

    const demo   = (window.AG && window.AG.lastPanelData && window.AG.lastPanelData.demographics) || null;
    const income = demo && demo.median_hh_income;
    const rent   = demo && demo.median_gross_rent;

    const taxRate = (window.AG.taxRateForRow ? window.AG.taxRateForRow(row) : null) || window.AG.APPROX_TAX_RATE || 0.02;
    const estTax  = Math.round((row.appr_assessed_val || market) * taxRate);
    const usd = (n) => (n != null && isFinite(n)) ? '$' + Math.round(n).toLocaleString() : '—';

    // Transparent ownership-cost assumptions (surfaced in the tooltip).
    const RATE = 0.065, DOWN = 0.20, TERM = 360, INS = 0.005;
    const monthlyPI = (principal) => {
      const r = RATE / 12;
      return principal * r / (1 - Math.pow(1 + r, -TERM));
    };

    const rows = [];
    if (income) {
      rows.push(['Price-to-income', `${(market / income).toFixed(1)}× median local income`,
        'Market value ÷ neighborhood median household income (ACS). A standard affordability gauge — roughly 3–5× is generally considered affordable; higher means pricier relative to local incomes.']);
      rows.push(['Tax burden vs income', `${(estTax / income * 100).toFixed(1)}% of median income`,
        'Estimated annual property tax ÷ neighborhood median household income (ACS).']);
    }
    if (rent) {
      const own = monthlyPI(market * (1 - DOWN)) + estTax / 12 + (market * INS) / 12;
      rows.push(['Own vs. rent (monthly)', `Own ≈ ${usd(own)}/mo vs. rent ≈ ${usd(rent)}/mo`,
        `Rough monthly cost to own (20% down, ${(RATE * 100).toFixed(1)}% / 30-yr mortgage, plus est. tax & insurance; excludes maintenance, HOA & PMI) vs. neighborhood median gross rent (ACS).`]);
    }
    if (demo && demo.cost_burden_pct != null) {
      rows.push(['Neighborhood cost burden', `${demo.cost_burden_pct}% of renters`,
        'Share of local renters paying 30%+ of income on rent (ACS) — a cost-burden measure.']);
    }
    if (!rows.length) return null;

    if (demo && demo.acs_vintage) {
      rows.push(['Source', `Incomes & rents: ACS ${demo.acs_vintage} 5-yr (block group)`,
        'Affordability inputs come from the U.S. Census ACS for the block group containing this parcel; value & tax are TCAD/parcel-level.']);
    }
    return makeSection('Affordability', rows);
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

  // ── Seed feasibility with demographics (for the rent assumption) ─────────────
  // Neighborhood profile renders in the panel (neighborhood.js); the report only
  // needs the demographics object to seed the pro-forma's default rent. Reuse the
  // value neighborhood.js already cached on lastPanelData; fall back to a fetch.
  function seedFeasibility(parcelId, token) {
    const pd = window.AG?.lastPanelData;
    if (pd && 'demographics' in pd) {
      appendFeasibility(parcelId, pd.demographics);
      return;
    }
    fetch(`${window.AG.SUPABASE_URL}/rest/v1/rpc/parcel_demographics`, {
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
        if (token !== demoCtr) return;
        if (!modal.classList.contains('open')) return;
        appendFeasibility(parcelId, d?.status === 'ok' ? d : null);
      })
      .catch(() => {
        if (token !== demoCtr) return;
        appendFeasibility(parcelId, null);
      });
  }

  function appendFeasibility(parcelId, demographics) {
    if (typeof window.AG.buildFeasibilitySection !== 'function') return;
    const feasCol = document.getElementById('report-feas-col') || dataEl;
    const envelope = window.AG.lastEnvelope;
    window.AG.buildFeasibilitySection(parcelId, envelope, demographics)
      .then((sec) => {
        if (!modal.classList.contains('open')) return;
        feasCol.appendChild(sec);
      });
  }

  // ── Open / close ──────────────────────────────────────────────────────────────
  function openReport() {
    const data = window.AG?.lastPanelData;
    if (!data) return;

    const rawAddr = document.getElementById('meta-address')?.textContent?.trim();
    const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
    const addr = (rawAddr && rawAddr !== '—') ? titleCase(rawAddr) : '';
    // Address is the headline; the subtitle names the report and the parcel.
    titleEl.textContent = addr || `Parcel ${data.parcelId}`;
    if (subtitleEl) {
      subtitleEl.textContent = `Feasibility & Appraisal Report · Parcel ${data.parcelId}`;
    }
    notesEl.value = '';
    printImg.src = '';
    printImg.style.display = 'none';
    if (printImgLoc) { printImgLoc.src = ''; printImgLoc.style.display = 'none'; }
    measuring = false;
    measurePts = [];

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');

    buildToolbar();
    populateData(data);
    buildFooter(data);

    const demoToken = ++demoCtr;
    seedFeasibility(data.parcelId, demoToken);
    fetchValueContext(data.parcelId, ++valCtr);
    fetchValueHistory(data.parcelId, ++histCtr);

    pendingGeom = data.geometry;

    if (!reportMap) {
      // Double rAF: first frame commits display:flex layout; second reads correct dimensions.
      requestAnimationFrame(() => requestAnimationFrame(() => createReportMap()));
    } else {
      reportMap.resize();
      if (draw) draw.clear();
      clearMeasure();
      resetBasemapControl();   // back to flat / aerial / buildings off
      applyPending();
    }

    if (!locatorMap) {
      requestAnimationFrame(() => requestAnimationFrame(() => createLocatorMap()));
    } else {
      locatorMap.resize();
      updateLocator();
    }
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
