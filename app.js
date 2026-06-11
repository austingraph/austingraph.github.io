// austingraph.chat — parcel substrate
// Renders Travis County parcels from PMTiles hosted in Supabase Storage.
// On click, dispatches window CustomEvent('parcel:select', { detail: { parcel_id } })
// for the graph/RAG layer to consume, and opens the detail panel.

const SUPABASE_URL = 'https://aqbyxpiwugcvoephsvpm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QMWSj0CLYe3k3XSGCsWOhw_5RsI-nmN';
const PMTILES_URL  = `${SUPABASE_URL}/storage/v1/object/public/tiles/parcels.pmtiles`;

// Register the PMTiles protocol with MapLibre
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile.bind(protocol));

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [-97.7431, 30.2672],  // Austin, TX
  zoom: 11,
  minZoom: 9,
  maxZoom: 19,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

// Shared handles for sibling modules (envelope.js)
window.AG = { map, SUPABASE_URL, SUPABASE_KEY };

let selectedParcelId = null;      // MapLibre feature id (for feature-state)
let selectedParcelPropId = null;  // TCAD parcel_id (for events)

// ── Geometry helpers (spherical, WGS84) ──────────────────────────────────────
const EARTH_R = 6378137; // meters

function ringArea(ring) {
  // Spherical excess approximation (same approach as turf.js)
  let total = 0;
  const len = ring.length;
  if (len < 3) return 0;
  for (let i = 0; i < len; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % len];
    total += (lon2 - lon1) * Math.PI / 180 *
             (2 + Math.sin(lat1 * Math.PI / 180) + Math.sin(lat2 * Math.PI / 180));
  }
  return Math.abs(total * EARTH_R * EARTH_R / 2);
}

function haversine([lon1, lat1], [lon2, lat2]) {
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

function geometryStats(geometry) {
  // Normalize Polygon/MultiPolygon into a list of polygons
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates]
              : geometry.type === 'MultiPolygon' ? geometry.coordinates
              : [];
  let areaM2 = 0;
  let perimM = 0;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;

  for (const poly of polys) {
    poly.forEach((ring, idx) => {
      const a = ringArea(ring);
      areaM2 += idx === 0 ? a : -a;   // subtract holes
      if (idx === 0) {
        for (let i = 0; i < ring.length - 1; i++) {
          perimM += haversine(ring[i], ring[i + 1]);
        }
      }
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    });
  }

  const midLat = (minLat + maxLat) / 2;
  return {
    areaM2,
    perimM,
    widthM:  haversine([minLon, midLat], [maxLon, midLat]),
    heightM: haversine([(minLon + maxLon) / 2, minLat], [(minLon + maxLon) / 2, maxLat]),
  };
}

const M2_PER_ACRE = 4046.8564224;
const FT_PER_M    = 3.280839895;

function fmtArea(m2) {
  const acres = m2 / M2_PER_ACRE;
  const sqft  = m2 * FT_PER_M * FT_PER_M;
  if (acres >= 0.5) return `${acres.toFixed(2)} ac (${Math.round(sqft).toLocaleString()} sq ft)`;
  return `${Math.round(sqft).toLocaleString()} sq ft (${acres.toFixed(3)} ac)`;
}

function fmtFeet(m) {
  return `${Math.round(m * FT_PER_M).toLocaleString()} ft`;
}

// ── Detail panel ─────────────────────────────────────────────────────────────
const panel    = document.getElementById('panel');
const elId     = document.getElementById('panel-parcel-id');
const elArea   = document.getElementById('dim-area');
const elPerim  = document.getElementById('dim-perimeter');
const elExtent = document.getElementById('dim-extent');
const elAddr   = document.getElementById('meta-address');
const elLegal  = document.getElementById('meta-legal');
const elAcres  = document.getElementById('meta-acres');
const elGeoId  = document.getElementById('meta-geoid');
const elMetaSt = document.getElementById('meta-status');
const elTcad   = document.getElementById('panel-tcad-link');

let metaFetchToken = 0;

function openPanel(parcelId, geometry) {
  elId.textContent = parcelId;
  elTcad.href = `https://travis.prodigycad.com/property-detail/${parcelId}`;

  const s = geometryStats(geometry);
  elArea.textContent   = fmtArea(s.areaM2);
  elPerim.textContent  = fmtFeet(s.perimM);
  elExtent.textContent = `${fmtFeet(s.widthM)} × ${fmtFeet(s.heightM)}`;

  // Reset metadata fields, then fetch from Supabase
  elAddr.textContent = elLegal.textContent = elAcres.textContent = elGeoId.textContent = '—';
  elMetaSt.textContent = 'Loading…';

  const token = ++metaFetchToken;
  fetch(`${SUPABASE_URL}/rest/v1/parcels?parcel_id=eq.${encodeURIComponent(parcelId)}&select=metadata`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
    .then((r) => r.json())
    .then((rows) => {
      if (token !== metaFetchToken) return; // stale response
      const meta = rows?.[0]?.metadata;
      if (meta) {
        elAddr.textContent  = meta.situs_address || '—';
        elLegal.textContent = meta.legal_desc    || '—';
        elAcres.textContent = meta.tcad_acres != null ? String(meta.tcad_acres) : '—';
        elGeoId.textContent = meta.geo_id        || '—';
        elMetaSt.textContent = '';
      } else {
        elMetaSt.textContent = 'No property record in database yet.';
      }
    })
    .catch(() => {
      if (token !== metaFetchToken) return;
      elMetaSt.textContent = 'Could not load property record.';
    });

  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
}

function closePanel() {
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
}

document.getElementById('panel-close').addEventListener('click', () => {
  clearSelection();
  closePanel();
});

function clearSelection() {
  if (selectedParcelId !== null) {
    map.setFeatureState(
      { source: 'parcels', sourceLayer: 'parcels', id: selectedParcelId },
      { selected: false }
    );
    selectedParcelId = null;
  }
  if (selectedParcelPropId !== null) {
    const parcel_id = selectedParcelPropId;
    selectedParcelPropId = null;
    window.dispatchEvent(new CustomEvent('parcel:deselect', { detail: { parcel_id } }));
  }
}

// ── Map layers & interaction ─────────────────────────────────────────────────
map.on('load', () => {
  map.addSource('parcels', {
    type: 'vector',
    url: `pmtiles://${PMTILES_URL}`,
  });

  // Base fill — transparent, just to capture pointer events
  map.addLayer({
    id: 'parcels-fill',
    type: 'fill',
    source: 'parcels',
    'source-layer': 'parcels',
    paint: {
      'fill-color': '#e8a838',
      'fill-opacity': 0,
    },
  });

  // Parcel outlines
  map.addLayer({
    id: 'parcels-outline',
    type: 'line',
    source: 'parcels',
    'source-layer': 'parcels',
    minzoom: 11,
    paint: {
      'line-color': '#000000',
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        11, 0.5,
        14, 1.2,
        17, 2.5,
      ],
      'line-opacity': [
        'interpolate', ['linear'], ['zoom'],
        11, 0.6,
        14, 0.9,
      ],
    },
  });

  // Hover highlight
  map.addLayer({
    id: 'parcels-hover',
    type: 'fill',
    source: 'parcels',
    'source-layer': 'parcels',
    paint: {
      'fill-color': '#e8a838',
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hovered'], false],
        0.25,
        0,
      ],
    },
  });

  // Selected highlight
  map.addLayer({
    id: 'parcels-selected',
    type: 'fill',
    source: 'parcels',
    'source-layer': 'parcels',
    paint: {
      'fill-color': '#e8a838',
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        0.5,
        0,
      ],
    },
  });

  // ── Hover interaction ────────────────────────────────────────────────────
  let hoveredId = null;

  map.on('mousemove', 'parcels-fill', (e) => {
    if (!e.features.length) return;
    map.getCanvas().style.cursor = 'pointer';
    const id = e.features[0].id;
    if (hoveredId !== null && hoveredId !== id) {
      map.setFeatureState(
        { source: 'parcels', sourceLayer: 'parcels', id: hoveredId },
        { hovered: false }
      );
    }
    hoveredId = id;
    map.setFeatureState(
      { source: 'parcels', sourceLayer: 'parcels', id: hoveredId },
      { hovered: true }
    );
  });

  map.on('mouseleave', 'parcels-fill', () => {
    map.getCanvas().style.cursor = '';
    if (hoveredId !== null) {
      map.setFeatureState(
        { source: 'parcels', sourceLayer: 'parcels', id: hoveredId },
        { hovered: false }
      );
    }
    hoveredId = null;
  });

  // ── Click / select interaction ───────────────────────────────────────────
  map.on('click', 'parcels-fill', (e) => {
    if (!e.features.length) return;

    const feature   = e.features[0];
    const parcel_id = feature.properties.parcel_id;
    const featureId = feature.id;

    if (selectedParcelId === featureId) {
      // Clicking the same parcel deselects it (clearSelection dispatches parcel:deselect)
      clearSelection();
      closePanel();
      return;
    }

    clearSelection();
    selectedParcelId = featureId;
    selectedParcelPropId = parcel_id;
    map.setFeatureState(
      { source: 'parcels', sourceLayer: 'parcels', id: featureId },
      { selected: true }
    );

    openPanel(parcel_id, feature.geometry);
    window.dispatchEvent(new CustomEvent('parcel:select', { detail: { parcel_id } }));
  });
});
