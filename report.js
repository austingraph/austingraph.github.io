// austingraph.chat — Parcel Report
// Opens a modal with a map snapshot, parcel data summary, draw/measure annotation
// tools, a notes field, and a print button. Triggered from the left detail panel.

(() => {
  const { map } = window.AG;

  const modal      = document.getElementById('report-modal');
  const inner      = document.getElementById('report-modal-inner');
  const closeBtn   = document.getElementById('report-close');
  const toolbar    = document.getElementById('report-toolbar');
  const snapshot   = document.getElementById('report-snapshot');
  const dataEl     = document.getElementById('report-data');
  const notesEl    = document.getElementById('report-notes');
  const footerEl   = document.getElementById('report-footer-bar');
  const titleEl    = document.getElementById('report-title');
  const reportBtn  = document.getElementById('panel-report-btn');

  let drawInstance = null;
  let measureActive = false;
  let measurePoints = [];
  let measureLayersAdded = false;

  const M2_PER_ACRE = 4046.8564224;
  const FT_PER_M    = 3.280839895;
  const EARTH_R     = 6378137;

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function fmtArea(m2) {
    const acres = m2 / M2_PER_ACRE;
    const sqft  = m2 * FT_PER_M * FT_PER_M;
    if (acres >= 0.5) return `${acres.toFixed(2)} ac (${Math.round(sqft).toLocaleString()} sq ft)`;
    return `${Math.round(sqft).toLocaleString()} sq ft (${acres.toFixed(3)} ac)`;
  }

  function fmtFeet(m) {
    return `${Math.round(m * FT_PER_M).toLocaleString()} ft`;
  }

  function haversine([lon1, lat1], [lon2, lat2]) {
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.sqrt(a));
  }

  function bboxFromGeometry(geometry) {
    const coords = [];
    function collect(c) {
      if (typeof c[0] === 'number') { coords.push(c); return; }
      c.forEach(collect);
    }
    collect(geometry.coordinates);
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of coords) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return [[minLon, minLat], [maxLon, maxLat]];
  }

  function centroid(geometry) {
    const coords = [];
    function collect(c) {
      if (typeof c[0] === 'number') { coords.push(c); return; }
      c.forEach(collect);
    }
    collect(geometry.coordinates);
    const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    return [lon, lat];
  }

  // ── Map snapshot ─────────────────────────────────────────────────────────────
  function takeSnapshot() {
    snapshot.textContent = 'Loading map snapshot…';
    const data = window.AG.lastPanelData;
    if (!data) { snapshot.textContent = 'No parcel selected.'; return; }

    const bbox = bboxFromGeometry(data.geometry);
    map.fitBounds(bbox, { padding: 80, animate: false });

    map.once('idle', () => {
      try {
        const dataUrl = map.getCanvas().toDataURL('image/png');
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = `Map snapshot for parcel ${data.parcelId}`;
        snapshot.innerHTML = '';
        snapshot.appendChild(img);
      } catch (e) {
        snapshot.textContent = 'Map snapshot unavailable (cross-origin canvas).';
      }
    });
  }

  // ── Data section ─────────────────────────────────────────────────────────────
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
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value || '—';
      div.appendChild(dt);
      div.appendChild(dd);
      dl.appendChild(div);
    }
    sec.appendChild(dl);
    return sec;
  }

  function el(id) { return document.getElementById(id)?.textContent?.trim() || '—'; }

  function populateData(data) {
    dataEl.innerHTML = '';

    // Parcel identity — read from already-rendered panel DOM
    dataEl.appendChild(makeSection('Parcel identity', [
      ['TCAD ID',  el('panel-parcel-id')],
      ['Address',  el('meta-address')],
      ['Legal',    el('meta-legal')],
      ['TCAD Acres', el('meta-acres')],
      ['Geo ID',   el('meta-geoid')],
    ]));

    // Dimensions — from stats computed at click time
    const s = data.stats;
    dataEl.appendChild(makeSection('Dimensions', [
      ['Area',      fmtArea(s.areaM2)],
      ['Perimeter', fmtFeet(s.perimM)],
      ['Width',     fmtFeet(s.widthM)],
      ['Height',    fmtFeet(s.heightM)],
    ]));

    // Development envelope — read rendered panel DOM
    dataEl.appendChild(makeSection('Development potential', [
      ['Zoning',         el('env-zoning')],
      ['Setbacks',       el('env-setbacks')],
      ['Buildable ft²',  el('env-buildable')],
      ['Max FAR',        el('env-far')],
      ['Impervious cap', el('env-impervious')],
      ['Max height',     el('env-height')],
      ['Max units',      el('env-units')],
    ]));

    // Civic connections — summarise first case + permit count from panel DOM
    const casesEl  = document.getElementById('conn-cases');
    const permitsEl = document.getElementById('conn-permits');
    const firstCase = casesEl?.querySelector('.conn-title')?.textContent || '—';
    const caseStatus = casesEl?.querySelector('.conn-badge')?.textContent || '';
    const permitCount = permitsEl?.querySelectorAll('.conn-item').length ?? 0;
    dataEl.appendChild(makeSection('Civic connections', [
      ['Latest case',   firstCase + (caseStatus ? ` (${caseStatus})` : '')],
      ['Permit count',  permitCount > 0 ? String(permitCount) : '—'],
    ]));
  }

  // ── Measure tool ─────────────────────────────────────────────────────────────
  function initMeasureLayers() {
    if (measureLayersAdded) return;
    if (!map.getSource('measure-pts')) {
      map.addSource('measure-pts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('measure-line', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer('measure-line-layer')) {
      map.addLayer({ id: 'measure-line-layer', type: 'line', source: 'measure-line',
        paint: { 'line-color': '#e8a838', 'line-width': 2, 'line-dasharray': [2, 2] } });
      map.addLayer({ id: 'measure-pts-layer', type: 'circle', source: 'measure-pts',
        paint: { 'circle-color': '#e8a838', 'circle-radius': 5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
    }
    measureLayersAdded = true;
  }

  function updateMeasureDisplay() {
    const ptFeats = measurePoints.map((pt) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: pt } }));
    map.getSource('measure-pts')?.setData({ type: 'FeatureCollection', features: ptFeats });
    if (measurePoints.length >= 2) {
      map.getSource('measure-line')?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: measurePoints } }],
      });
      let dist = 0;
      for (let i = 0; i < measurePoints.length - 1; i++) dist += haversine(measurePoints[i], measurePoints[i + 1]);
      const distEl = document.getElementById('report-measure-dist');
      if (distEl) distEl.textContent = `${fmtFeet(dist)} (${(dist * FT_PER_M / 5280).toFixed(3)} mi)`;
    }
  }

  function clearMeasure() {
    measurePoints = [];
    if (measureLayersAdded) {
      map.getSource('measure-pts')?.setData({ type: 'FeatureCollection', features: [] });
      map.getSource('measure-line')?.setData({ type: 'FeatureCollection', features: [] });
    }
    const distEl = document.getElementById('report-measure-dist');
    if (distEl) distEl.textContent = '—';
  }

  function onMapClickMeasure(e) {
    if (!measureActive) return;
    measurePoints.push([e.lngLat.lng, e.lngLat.lat]);
    updateMeasureDisplay();
  }

  function enableMeasure(btn) {
    initMeasureLayers();
    measureActive = true;
    btn.classList.add('active');
    map.getCanvas().style.cursor = 'crosshair';
    map.on('click', onMapClickMeasure);
  }

  function disableMeasure(btn) {
    measureActive = false;
    btn.classList.remove('active');
    map.getCanvas().style.cursor = '';
    map.off('click', onMapClickMeasure);
  }

  // ── Toolbar ──────────────────────────────────────────────────────────────────
  function buildToolbar() {
    toolbar.innerHTML = '';

    const lbl = document.createElement('span');
    lbl.className = 'report-tool-label';
    lbl.textContent = 'Measure:';
    toolbar.appendChild(lbl);

    const measureBtn = document.createElement('button');
    measureBtn.className = 'draw-tb-btn';
    measureBtn.textContent = 'Click to measure';
    measureBtn.title = 'Click points on the map to measure distance';
    let measuring = false;
    measureBtn.addEventListener('click', () => {
      measuring = !measuring;
      if (measuring) enableMeasure(measureBtn);
      else disableMeasure(measureBtn);
    });
    toolbar.appendChild(measureBtn);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'draw-tb-btn';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      disableMeasure(measureBtn);
      measuring = false;
      clearMeasure();
    });
    toolbar.appendChild(clearBtn);

    const distWrap = document.createElement('span');
    distWrap.style.cssText = 'font-size:12px;color:#555;margin-left:4px;';
    distWrap.innerHTML = 'Distance: <strong id="report-measure-dist">—</strong>';
    toolbar.appendChild(distWrap);

    // Spacer
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    toolbar.appendChild(spacer);

    const snapshotBtn = document.createElement('button');
    snapshotBtn.className = 'draw-tb-btn';
    snapshotBtn.textContent = 'Refresh snapshot';
    snapshotBtn.addEventListener('click', takeSnapshot);
    toolbar.appendChild(snapshotBtn);

    const printBtn = document.createElement('button');
    printBtn.className = 'draw-tb-btn';
    printBtn.style.cssText = 'background:#e8a838;color:#111;border-color:#e8a838;';
    printBtn.textContent = 'Print / Save PDF';
    printBtn.addEventListener('click', () => window.print());
    toolbar.appendChild(printBtn);
  }

  // ── Footer ───────────────────────────────────────────────────────────────────
  function buildFooter(data) {
    const [lon, lat] = centroid(data.geometry);
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const tcadUrl = `https://travis.prodigycad.com/property-detail/${data.parcelId}`;
    footerEl.innerHTML =
      `<span>Generated ${date}</span>` +
      `<span>Centroid: ${lat.toFixed(5)}°N, ${Math.abs(lon).toFixed(5)}°W</span>` +
      `<span><a href="${tcadUrl}" target="_blank" rel="noopener" style="color:#e8a838">TCAD record →</a></span>`;
  }

  // ── Open / close ─────────────────────────────────────────────────────────────
  function openReport() {
    const data = window.AG.lastPanelData;
    if (!data) return;

    titleEl.textContent = `Parcel Report — ${data.parcelId}`;
    notesEl.value = '';

    buildToolbar();
    populateData(data);
    buildFooter(data);

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');

    takeSnapshot();
  }

  function closeReport() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    disableMeasure(toolbar.querySelector('.draw-tb-btn'));
    clearMeasure();
    map.getCanvas().style.cursor = '';
  }

  // ── Event wiring ──────────────────────────────────────────────────────────────
  reportBtn.addEventListener('click', openReport);
  closeBtn.addEventListener('click', closeReport);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeReport(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('open')) closeReport(); });
})();
