// austingraph.chat — development envelope overlay
// Listens for parcel:select / parcel:deselect from app.js, calls the
// compute_envelope PostgREST RPC, and renders the setback zone, buildable
// footprint, and a max-height 3D massing (fill-extrusion) plus the
// "Development potential" panel section.

(() => {
  const { map, SUPABASE_URL, SUPABASE_KEY } = window.AG;

  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  const elZoning     = document.getElementById('env-zoning');
  const elSetbacks   = document.getElementById('env-setbacks');
  const elBuildable  = document.getElementById('env-buildable');
  const elFar        = document.getElementById('env-far');
  const elImpervious = document.getElementById('env-impervious');
  const elHeight     = document.getElementById('env-height');
  const elUnits      = document.getElementById('env-units');
  const elStatus     = document.getElementById('env-status');

  map.on('load', () => {
    map.addSource('envelope-setback',   { type: 'geojson', data: EMPTY_FC });
    map.addSource('envelope-buildable', { type: 'geojson', data: EMPTY_FC });

    map.addLayer({
      id: 'envelope-setback-fill',
      type: 'fill',
      source: 'envelope-setback',
      paint: { 'fill-color': '#d9534f', 'fill-opacity': 0.25 },
    });
    map.addLayer({
      id: 'envelope-buildable-fill',
      type: 'fill',
      source: 'envelope-buildable',
      paint: { 'fill-color': '#4caf7d', 'fill-opacity': 0.18 },
    });
    map.addLayer({
      id: 'envelope-buildable-outline',
      type: 'line',
      source: 'envelope-buildable',
      paint: { 'line-color': '#4caf7d', 'line-width': 1.5 },
    });
    map.addLayer({
      id: 'envelope-massing',
      type: 'fill-extrusion',
      source: 'envelope-buildable',
      paint: {
        'fill-extrusion-color': '#e8a838',
        'fill-extrusion-height': ['coalesce', ['get', 'height_m'], 0],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.55,
      },
    });
  });

  function fmtSqft(n) {
    return `${Math.round(n).toLocaleString()} sq ft`;
  }

  function resetFields(msg) {
    for (const el of [elZoning, elSetbacks, elBuildable, elFar, elImpervious, elHeight, elUnits]) {
      el.textContent = '—';
    }
    elStatus.textContent = msg || '';
  }

  function clearLayers() {
    map.getSource('envelope-setback')?.setData(EMPTY_FC);
    map.getSource('envelope-buildable')?.setData(EMPTY_FC);
  }

  function bboxCenter(geometry) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        if (c[0] < minLon) minLon = c[0];
        if (c[0] > maxLon) maxLon = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
      } else {
        c.forEach(walk);
      }
    };
    walk(geometry.coordinates);
    return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  }

  function render(d) {
    if (!d || d.status !== 'ok') {
      const messages = {
        no_zoning: 'Outside City of Austin zoning (county/ETJ parcel — no envelope available).',
        no_rules: `District ${d?.zoning_base ?? '?'} is not in the rules table yet.`,
        not_found: 'Parcel not found in database.',
        error: 'Envelope computation failed.',
      };
      resetFields(messages[d?.status] || 'Could not compute envelope.');
      if (d?.zoning_ztype) elZoning.textContent = d.zoning_ztype;
      return;
    }

    elZoning.textContent = d.zoning_ztype +
      (d.variant === 'home_small_lot' ? ' · small-lot (HOME)' : '');

    const sb = d.setbacks_ft || {};
    elSetbacks.textContent =
      `F ${sb.front ?? '—'} / SS ${sb.street_side ?? '—'} / S ${sb.interior_side ?? '—'} / R ${sb.rear ?? '—'} ft`;

    elBuildable.textContent  = fmtSqft(d.buildable_sqft || 0);
    elFar.textContent        = d.max_far_sqft != null ? `${fmtSqft(d.max_far_sqft)} (FAR ${d.max_far})` : '—';
    elImpervious.textContent = d.max_impervious_sqft != null
      ? `${fmtSqft(d.max_impervious_sqft)} (${d.max_impervious_pct}%)` : '—';
    elHeight.textContent     = d.max_height_ft != null ? `${d.max_height_ft} ft` : '—';
    elUnits.textContent      = d.max_units != null ? String(d.max_units) : '—';

    const notes = [...(d.notes || [])];
    if (d.classification === 'fallback_uniform') {
      // already noted server-side, but keep edge-classification caveat visible
    } else if ((d.edges?.features || []).some((f) => f.properties.class === 'street_side')) {
      notes.push('Corner lot: second street frontage uses street-side setback.');
    }
    elStatus.textContent = notes.join(' ');

    map.getSource('envelope-setback')?.setData(
      d.setback_zone ? { type: 'FeatureCollection', features: [d.setback_zone] } : EMPTY_FC
    );
    map.getSource('envelope-buildable')?.setData(
      d.buildable ? { type: 'FeatureCollection', features: [d.buildable] } : EMPTY_FC
    );

    const target = d.buildable || d.setback_zone;
    if (target) {
      map.easeTo({
        center: bboxCenter(target.geometry),
        zoom: 17.2,
        pitch: 55,
        bearing: -17,
        duration: 900,
      });
    }
  }

  let fetchToken = 0;

  window.addEventListener('parcel:select', (e) => {
    const token = ++fetchToken;
    resetFields('Computing development envelope…');
    clearLayers();

    fetch(`${SUPABASE_URL}/rest/v1/rpc/compute_envelope`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_parcel_id: e.detail.parcel_id }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (token !== fetchToken) return; // stale response
        render(d);
      })
      .catch(() => {
        if (token !== fetchToken) return;
        resetFields('Could not compute envelope.');
      });
  });

  window.addEventListener('parcel:deselect', () => {
    fetchToken++;
    resetFields('');
    clearLayers();
    map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  });
})();
