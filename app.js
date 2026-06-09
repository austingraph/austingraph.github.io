// austingraph.chat — parcel substrate
// Renders Travis County parcels from PMTiles hosted in Supabase Storage.
// On click, dispatches window CustomEvent('parcel:select', { detail: { parcel_id } })
// for the graph/RAG layer to consume.

const SUPABASE_URL = 'https://aqbyxpiwugcvoephsvpm.supabase.co';
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

map.addControl(new maplibregl.NavigationControl(), 'top-right');

let selectedParcelId = null;

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
    minzoom: 10,
    paint: {
      'line-color': '#e8a838',
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        10, 0.2,
        14, 0.8,
      ],
      'line-opacity': 0.5,
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

    // Clear previous selection
    if (selectedParcelId !== null) {
      map.setFeatureState(
        { source: 'parcels', sourceLayer: 'parcels', id: selectedParcelId },
        { selected: false }
      );
    }

    if (selectedParcelId === featureId) {
      // Clicking the same parcel deselects it
      selectedParcelId = null;
      window.dispatchEvent(new CustomEvent('parcel:deselect', { detail: { parcel_id } }));
    } else {
      selectedParcelId = featureId;
      map.setFeatureState(
        { source: 'parcels', sourceLayer: 'parcels', id: featureId },
        { selected: true }
      );
      window.dispatchEvent(new CustomEvent('parcel:select', { detail: { parcel_id } }));
    }
  });
});
