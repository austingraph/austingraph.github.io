// austingraph.chat — Parcel Report
// Opens a modal with a map snapshot the user can draw and measure on (mouse or
// touch), a parcel data summary, a notes field, and a print button. Annotations
// are drawn onto an HTML5 canvas overlaid on the snapshot, so they appear in the
// printed/PDF document. Triggered from the left detail panel.

(() => {
  const { map } = window.AG;

  const modal     = document.getElementById('report-modal');
  const closeBtn  = document.getElementById('report-close');
  const toolbar   = document.getElementById('report-toolbar');
  const snapshot  = document.getElementById('report-snapshot');
  const dataEl    = document.getElementById('report-data');
  const notesEl   = document.getElementById('report-notes');
  const footerEl  = document.getElementById('report-footer-bar');
  const titleEl   = document.getElementById('report-title');
  const reportBtn = document.getElementById('panel-report-btn');

  const FT_PER_M = 3.280839895;
  const M2_PER_ACRE = 4046.8564224;

  // Drawing state
  let imgEl = null;          // <img> map snapshot
  let canvas = null;         // overlay <canvas>
  let ctx = null;
  let strokes = [];          // committed strokes
  let current = null;        // in-progress stroke
  let drawing = false;
  let mode = 'pen';          // 'pen' | 'measure'
  let snapMeta = null;       // { metersPerMapCssPx, mapCssWidth }

  // ── Formatting ───────────────────────────────────────────────────────────────
  function fmtArea(m2) {
    const acres = m2 / M2_PER_ACRE;
    const sqft  = m2 * FT_PER_M * FT_PER_M;
    if (acres >= 0.5) return `${acres.toFixed(2)} ac (${Math.round(sqft).toLocaleString()} sq ft)`;
    return `${Math.round(sqft).toLocaleString()} sq ft (${acres.toFixed(3)} ac)`;
  }
  function fmtFeet(m) {
    const ft = m * FT_PER_M;
    if (ft >= 1000) return `${ft.toLocaleString(undefined, { maximumFractionDigits: 0 })} ft (${(ft / 5280).toFixed(2)} mi)`;
    return `${ft.toLocaleString(undefined, { maximumFractionDigits: 0 })} ft`;
  }

  // ── Geometry helpers ─────────────────────────────────────────────────────────
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

  // ── Map snapshot + drawing canvas ─────────────────────────────────────────────
  function takeSnapshot() {
    const data = window.AG.lastPanelData;
    if (!data) { snapshot.innerHTML = '<div class="report-snap-loading">No parcel selected.</div>'; return; }
    snapshot.innerHTML = '<div class="report-snap-loading">Rendering map…</div>';

    map.fitBounds(bboxFromGeometry(data.geometry), { padding: 60, maxZoom: 19, animate: false });

    let done = false;
    const render = () => {
      if (done) return;
      done = true;
      const c = map.getCanvas();
      const lat = map.getCenter().lat;
      const zoom = map.getZoom();
      // meters per CSS pixel in the map viewport (512-tile web-mercator convention)
      snapMeta = {
        metersPerMapCssPx: 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom + 9),
        mapCssWidth: c.clientWidth,
      };
      let url;
      try { url = c.toDataURL('image/png'); }
      catch (e) { snapshot.innerHTML = '<div class="report-snap-loading">Snapshot unavailable (browser blocked canvas export).</div>'; return; }

      snapshot.innerHTML = '';
      imgEl = document.createElement('img');
      imgEl.alt = `Map snapshot for parcel ${data.parcelId}`;
      canvas = document.createElement('canvas');
      canvas.id = 'report-draw-canvas';
      snapshot.appendChild(imgEl);
      snapshot.appendChild(canvas);

      imgEl.onload = () => {
        // Canvas internal resolution = snapshot's natural (device) resolution, so
        // it stays pixel-aligned with the image at any CSS display size.
        canvas.width = imgEl.naturalWidth;
        canvas.height = imgEl.naturalHeight;
        ctx = canvas.getContext('2d');
        attachDrawHandlers();
        redraw();
      };
      imgEl.src = url;
    };

    map.once('idle', render);
    setTimeout(render, 1200); // fallback if the view didn't change (idle won't fire)
  }

  // Pointer (CSS) → canvas-internal coordinates
  function toCanvasXY(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }
  function metersPerCanvasPx() {
    if (!snapMeta || !canvas) return 0;
    return snapMeta.metersPerMapCssPx * snapMeta.mapCssWidth / canvas.width;
  }

  function drawStroke(s) {
    if (!s.points.length) return;
    const lw = Math.max(2, Math.round(canvas.width / 320));
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = s.type === 'measure' ? '#0a66ff' : '#e01010';
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.stroke();

    if (s.type === 'measure' && s.points.length >= 2) {
      const a = s.points[0], b = s.points[s.points.length - 1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y) * metersPerCanvasPx();
      const label = fmtFeet(dist);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const fpx = Math.max(15, Math.round(canvas.width / 48));
      ctx.font = `bold ${fpx}px -apple-system, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillRect(mx - tw / 2 - 6, my - fpx * 0.75, tw + 12, fpx * 1.5);
      ctx.fillStyle = '#0a3aa0';
      ctx.fillText(label, mx, my);
    }
  }

  function redraw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) drawStroke(s);
    if (current) drawStroke(current);
  }

  let handlersAttached = false;
  function attachDrawHandlers() {
    if (handlersAttached) return; // canvas element is recreated per snapshot; guard re-binding within one
    handlersAttached = true;
  }

  function onPointerDown(e) {
    if (!canvas) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    drawing = true;
    current = { type: mode, points: [toCanvasXY(e)] };
    redraw();
  }
  function onPointerMove(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = toCanvasXY(e);
    if (mode === 'pen') current.points.push(p);
    else current.points = [current.points[0], p]; // measure: straight segment
    redraw();
  }
  function onPointerUp(e) {
    if (!drawing) return;
    drawing = false;
    if (current && current.points.length) strokes.push(current);
    current = null;
    redraw();
  }

  // Delegated pointer events on the snapshot wrap (canvas is recreated each open)
  snapshot.addEventListener('pointerdown', (e) => { if (e.target === canvas) onPointerDown(e); });
  snapshot.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  snapshot.addEventListener('pointercancel', onPointerUp);

  // ── Data section ─────────────────────────────────────────────────────────────
  function el(id) { const n = document.getElementById(id); return (n && n.textContent.trim()) || '—'; }
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
      ['TCAD ID', el('panel-parcel-id')],
      ['Address', el('meta-address')],
      ['Legal', el('meta-legal')],
      ['TCAD Acres', el('meta-acres')],
      ['Geo ID', el('meta-geoid')],
    ]));
    dataEl.appendChild(makeSection('Dimensions', [
      ['Area', fmtArea(s.areaM2)],
      ['Perimeter', fmtFeet(s.perimM)],
      ['Width', fmtFeet(s.widthM)],
      ['Height', fmtFeet(s.heightM)],
    ]));
    dataEl.appendChild(makeSection('Development potential', [
      ['Zoning', el('env-zoning')],
      ['Setbacks', el('env-setbacks')],
      ['Buildable ft²', el('env-buildable')],
      ['Max FAR', el('env-far')],
      ['Impervious cap', el('env-impervious')],
      ['Max height', el('env-height')],
      ['Max units', el('env-units')],
    ]));
    const casesEl = document.getElementById('conn-cases');
    const permitsEl = document.getElementById('conn-permits');
    const firstCase = casesEl?.querySelector('.conn-title')?.textContent || '—';
    const caseStatus = casesEl?.querySelector('.conn-badge')?.textContent || '';
    const permitCount = permitsEl?.querySelectorAll('.conn-item').length ?? 0;
    dataEl.appendChild(makeSection('Civic connections', [
      ['Latest case', firstCase + (caseStatus ? ` (${caseStatus})` : '')],
      ['Permit count', permitCount > 0 ? String(permitCount) : '—'],
    ]));
  }

  // ── Toolbar ──────────────────────────────────────────────────────────────────
  function buildToolbar() {
    toolbar.innerHTML = '';
    mode = 'pen';

    const lbl = document.createElement('span');
    lbl.className = 'report-tool-label';
    lbl.textContent = 'Draw:';
    toolbar.appendChild(lbl);

    const penBtn = document.createElement('button');
    penBtn.textContent = '✏️ Pen';
    penBtn.className = 'active';
    const measureBtn = document.createElement('button');
    measureBtn.textContent = '📏 Measure';

    function setMode(m) {
      mode = m;
      penBtn.classList.toggle('active', m === 'pen');
      measureBtn.classList.toggle('active', m === 'measure');
    }
    penBtn.addEventListener('click', () => setMode('pen'));
    measureBtn.addEventListener('click', () => setMode('measure'));
    toolbar.appendChild(penBtn);
    toolbar.appendChild(measureBtn);

    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', () => { strokes.pop(); redraw(); });
    toolbar.appendChild(undoBtn);

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => { strokes = []; current = null; redraw(); });
    toolbar.appendChild(clearBtn);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    toolbar.appendChild(spacer);

    const printBtn = document.createElement('button');
    printBtn.className = 'primary';
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
      `<span><a href="${tcadUrl}" target="_blank" rel="noopener" style="color:#b8860b">TCAD record →</a></span>`;
  }

  // ── Open / close ─────────────────────────────────────────────────────────────
  function openReport() {
    const data = window.AG.lastPanelData;
    if (!data) return;
    titleEl.textContent = `Parcel Report — ${data.parcelId}`;
    notesEl.value = '';
    strokes = [];
    current = null;

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
    drawing = false;
  }

  reportBtn.addEventListener('click', openReport);
  closeBtn.addEventListener('click', closeReport);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeReport(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('open')) closeReport(); });
})();
