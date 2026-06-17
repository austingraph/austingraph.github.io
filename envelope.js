// austingraph.chat — development envelope overlay
// Listens for parcel:select / parcel:deselect from app.js, calls the
// compute_envelope PostgREST RPC, and renders (flat, 2D) the setback zone,
// buildable footprint ("available land"), and the max-coverage footprint on the
// MAIN map, plus the "Development potential" panel fields and capacity headline.

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
  const elCapacity   = document.getElementById('env-capacity');
  const elStatus     = document.getElementById('env-status');

  map.on('load', () => {
    map.addSource('envelope-setback',   { type: 'geojson', data: EMPTY_FC });
    map.addSource('envelope-buildable', { type: 'geojson', data: EMPTY_FC });
    map.addSource('envelope-coverage',  { type: 'geojson', data: EMPTY_FC });

    map.addLayer({
      id: 'envelope-setback-fill',
      type: 'fill',
      source: 'envelope-setback',
      paint: { 'fill-color': '#d9534f', 'fill-opacity': 0.25 },
    });
    // Buildable footprint reads as "available land" — faint fill + green outline.
    map.addLayer({
      id: 'envelope-buildable-fill',
      type: 'fill',
      source: 'envelope-buildable',
      paint: { 'fill-color': '#4caf7d', 'fill-opacity': 0.06 },
    });
    map.addLayer({
      id: 'envelope-buildable-outline',
      type: 'line',
      source: 'envelope-buildable',
      paint: { 'line-color': '#4caf7d', 'line-width': 1.5 },
    });
    // Max-coverage footprint — the focal shape: how much ground you can cover.
    map.addLayer({
      id: 'envelope-coverage-fill',
      type: 'fill',
      source: 'envelope-coverage',
      paint: { 'fill-color': '#2e8b57', 'fill-opacity': 0.35 },
    });
  });

  function fmtSqft(n) {
    return `${Math.round(n).toLocaleString()} sq ft`;
  }

  const FLOOR_HT_FT = 11; // assumed feet per story for floor-count estimate

  // Plain-language "what you can build" headline + the binding constraint.
  function capacityText(d) {
    const buildable = d.buildable_sqft || 0;
    const coverCap  = d.max_building_cover_sqft;
    // Ground floor you can actually cover (coverage cap or, if looser, setbacks).
    const coverFootprint = coverCap != null ? Math.min(coverCap, buildable) : buildable;
    if (!coverFootprint) return 'No buildable area after setbacks.';

    const floorsByHeight = d.max_height_ft != null
      ? Math.max(1, Math.floor(d.max_height_ft / FLOOR_HT_FT)) : null;
    const areaByCover = floorsByHeight != null ? coverFootprint * floorsByHeight : null;
    const areaByFar   = d.max_far_sqft != null ? d.max_far_sqft : null;

    const candidates = [areaByFar, areaByCover].filter((v) => v != null);
    const floorArea  = candidates.length ? Math.min(...candidates) : coverFootprint;

    let binding;
    if (areaByFar != null && (areaByCover == null || areaByFar <= areaByCover)) {
      binding = `FAR (${d.max_far})`;
    } else if (areaByCover != null) {
      binding = `lot coverage (${d.max_building_cover_pct}%) + height`;
    } else {
      binding = 'setbacks';
    }

    const floors = coverFootprint ? Math.round((floorArea / coverFootprint) * 2) / 2 : null;
    const parts = [`~${Math.round(floorArea).toLocaleString()} ft² buildable floor area`];
    if (d.max_units != null) parts.push(`up to ${d.max_units} unit${d.max_units === 1 ? '' : 's'}`);
    if (floors != null) parts.push(`~${floors} floor${floors === 1 ? '' : 's'}`);
    parts.push(`limited by ${binding}`);
    return parts.join(' · ');
  }

  function resetFields(msg) {
    for (const el of [elZoning, elSetbacks, elBuildable, elFar, elImpervious, elHeight, elUnits]) {
      el.textContent = '—';
    }
    if (elCapacity) elCapacity.textContent = '—';
    elStatus.textContent = msg || '';
  }

  function clearLayers() {
    map.getSource('envelope-setback')?.setData(EMPTY_FC);
    map.getSource('envelope-buildable')?.setData(EMPTY_FC);
    map.getSource('envelope-coverage')?.setData(EMPTY_FC);
  }

  // Scale a GeoJSON geometry's coordinates about a center point by factor k.
  // Uniform scaling changes area by exactly k², so a coverage footprint sized
  // to k = sqrt(cover/buildable) renders the allowable ground coverage to scale.
  function scaleGeometry(geometry, center, k) {
    const [cx, cy] = center;
    const scale = (c) => {
      if (typeof c[0] === 'number') {
        return [cx + (c[0] - cx) * k, cy + (c[1] - cy) * k];
      }
      return c.map(scale);
    };
    return { ...geometry, coordinates: scale(geometry.coordinates) };
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
      clearLayers();
      window.AG.lastEnvelope = null;
      window.dispatchEvent(new CustomEvent('envelope:ready', { detail: { envelope: null } }));
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
    if (elCapacity) elCapacity.textContent = capacityText(d);

    const notes = [...(d.notes || [])];
    if ((d.edges?.features || []).some((f) => f.properties.class === 'street_side')) {
      notes.push('Corner lot: second street frontage uses street-side setback.');
    }
    elStatus.textContent = notes.join(' ');

    map.getSource('envelope-setback')?.setData(
      d.setback_zone ? { type: 'FeatureCollection', features: [d.setback_zone] } : EMPTY_FC
    );
    map.getSource('envelope-buildable')?.setData(
      d.buildable ? { type: 'FeatureCollection', features: [d.buildable] } : EMPTY_FC
    );

    // Max-coverage footprint: shrink the buildable shape to the coverage cap area.
    let coverageFC = EMPTY_FC;
    if (d.buildable && d.buildable_sqft > 0) {
      const cover = d.max_building_cover_sqft;
      const k = cover != null ? Math.sqrt(Math.min(1, cover / d.buildable_sqft)) : 1;
      const center = bboxCenter(d.buildable.geometry);
      coverageFC = {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: {},
          geometry: scaleGeometry(d.buildable.geometry, center, k),
        }],
      };
    }
    map.getSource('envelope-coverage')?.setData(coverageFC);

    // Move envelope layers to top of stack so hillshade/other layers don't occlude them.
    for (const id of ['envelope-setback-fill', 'envelope-buildable-fill', 'envelope-buildable-outline', 'envelope-coverage-fill']) {
      if (map.getLayer(id)) map.moveLayer(id);
    }

    window.AG.lastEnvelope = d;
    window.dispatchEvent(new CustomEvent('envelope:ready', { detail: { envelope: d } }));

    const target = d.buildable || d.setback_zone;
    if (target) {
      map.easeTo({
        center: bboxCenter(target.geometry),
        zoom: 17.2,
        pitch: 0,
        bearing: 0,
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
    window.AG.lastEnvelope = null;
    map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  });
})();
