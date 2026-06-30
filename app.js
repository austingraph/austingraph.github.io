// austingraph.chat — parcel substrate
// Renders Travis County parcels from PMTiles hosted in Supabase Storage.
// On click, dispatches window CustomEvent('parcel:select', { detail: { parcel_id } })
// for the graph/RAG layer to consume, and opens the detail panel.

const SUPABASE_URL = 'https://aqbyxpiwugcvoephsvpm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QMWSj0CLYe3k3XSGCsWOhw_5RsI-nmN';
const PMTILES_URL  = `${SUPABASE_URL}/storage/v1/object/public/tiles/parcels.pmtiles?v=20260614`;

// Register the PMTiles protocol with MapLibre
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile.bind(protocol));

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [-97.7440, 30.2580],  // South Congress / Bouldin — data-rich parcels
  zoom: 16,
  minZoom: 9,
  maxZoom: 19,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

// GPS / "find me" button (top-left). Geolocation is requested ONLY when the user
// clicks this button — never on page load — then the device location is shown
// and tracked on the map.
map.addControl(new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showUserHeading: true,
}), 'top-left');

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
  if (!geometry) return { areaM2: 0, perimM: 0, widthM: 0, heightM: 0 };
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
const elFlum     = document.getElementById('plan-flum');
const elPlanZone = document.getElementById('plan-zoning');
const elUpzone   = document.getElementById('plan-upzoning');
const elPlanSt   = document.getElementById('plan-status');

// Panel shows a 4-field summary; the full appraisal set lives in the Parcel Report.
const elApprMarket  = document.getElementById('appr-market');
const elApprAssessed= document.getElementById('appr-assessed');
const elApprTax     = document.getElementById('appr-tax');
const elApprOwner   = document.getElementById('appr-owner');
const elApprStatus  = document.getElementById('appr-status');

// Approximate combined tax rate for Austin-proper parcels (2025 rates).
// Travis County 0.3758 + City of Austin 0.5240 + AISD 0.9252 + ACC+Health ~0.18 ≈ 2.00%.
// Actual rate varies by school district, MUD, and special districts.
const APPROX_TAX_RATE = 0.020;

// Representative combined property-tax rate, chosen by jurisdiction. TCAD's roll
// carries no per-parcel taxing units, so we approximate from sitecheck_jurisdiction:
// full-purpose Austin parcels pay city+county+ISD+college+health (~2.0%); ETJ /
// limited-purpose parcels pay no city tax (~1.6%). A true bill needs the exact
// overlapping taxing units (county, city, ISD, MUD, ESD …).
function taxRateForRow(row) {
  const j = String((row && row.sitecheck_jurisdiction) || '').toUpperCase();
  if (/FULL PURPOSE/.test(j)) return 0.020;
  if (/ETJ|LIMITED|LTD|\bMILE\b/.test(j)) return 0.016;
  return APPROX_TAX_RATE;
}

const EXEMPTION_LABELS = {
  HS: 'Homestead', OV65: 'Over-65 freeze', DP: 'Disabled person',
  VET: 'Veteran', AG: 'Ag use', AB: 'Abatement', EX: 'Total exemption',
};

// PTAD state category codes (TCAD appr_state_cd) → plain-language land use.
// Match the full code first (e.g. A1), then fall back to the letter class.
const STATE_CD_LABELS = {
  A: 'Residential — single-family', A1: 'Residential — single-family',
  A2: 'Residential — mobile home', A3: 'Residential — condo',
  B: 'Residential — multifamily', B1: 'Multifamily (apartments)', B2: 'Duplex/triplex/quadplex',
  C: 'Vacant land', C1: 'Vacant lot', C2: 'Vacant commercial lot', C3: 'Vacant rural land',
  D: 'Rural / ag land', D1: 'Qualified ag land', D2: 'Farm/ranch improvements',
  E: 'Rural land + non-ag improvements', E1: 'Rural homesite',
  F: 'Commercial / industrial', F1: 'Commercial real property', F2: 'Industrial real property',
  G: 'Oil, gas & minerals', J: 'Utility', L: 'Personal property',
  L1: 'Commercial personal property', L2: 'Industrial personal property',
  M: 'Mobile home / tangible', O: 'Residential inventory (developer)',
  S: 'Special inventory', X: 'Exempt',
};

function stateCdLabel(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  return STATE_CD_LABELS[c] || STATE_CD_LABELS[c[0]] || c;
}

// Shared with report.js (full appraisal block reuses the tax rate + labels).
window.AG.APPROX_TAX_RATE = APPROX_TAX_RATE;
window.AG.taxRateForRow = taxRateForRow;
window.AG.EXEMPTION_LABELS = EXEMPTION_LABELS;
window.AG.stateCdLabel = stateCdLabel;

function fmtUSD(n) {
  if (n == null || n === 0) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

// Land-vs-building value-composition bar. Returns an HTML string (a stacked bar
// + captioned legend) or '' when there's nothing to show. Shared with report.js
// via window.AG so the panel and the report render the same visual.
function makeValueSplit(land, impr) {
  const l = +land || 0, b = +impr || 0, t = l + b;
  if (t <= 0) return '';
  const lp = Math.round((l / t) * 100), bp = 100 - lp;
  return (
    `<div class="value-bar">` +
      `<span class="seg-land" style="width:${lp}%"></span>` +
      `<span class="seg-bldg" style="width:${bp}%"></span>` +
    `</div>` +
    `<div class="vs-cap">` +
      `<span><i class="vs-dot land"></i>Land ${lp}%</span>` +
      `<span><i class="vs-dot bldg"></i>Building ${bp}%</span>` +
    `</div>`
  );
}
window.AG.makeValueSplit = makeValueSplit;

function renderAppraisal(row) {
  const dash = '—';
  const elApprSplit = document.getElementById('appr-split');
  // Stash the full DB row so the Parcel Report can build the complete
  // appraisal/tax block + derived investor signals without re-fetching.
  if (window.AG.lastPanelData) window.AG.lastPanelData.dbRow = row || null;

  if (!row || row.appr_market_val == null) {
    [elApprMarket, elApprAssessed, elApprTax, elApprOwner]
      .forEach((el) => { el.textContent = dash; });
    elApprStatus.textContent = row ? 'No appraisal data for this parcel.' : '';
    if (elApprSplit) { elApprSplit.style.display = 'none'; elApprSplit.innerHTML = ''; }
    return;
  }

  // Land-vs-building composition bar (hidden when the split can't be computed).
  if (elApprSplit) {
    const html = makeValueSplit(row.appr_land_val, row.appr_impr_val);
    elApprSplit.innerHTML = html;
    elApprSplit.style.display = html ? 'block' : 'none';
  }

  const assessed = row.appr_assessed_val;
  const market   = row.appr_market_val;

  elApprMarket.textContent = fmtUSD(market) || dash;

  // Assessed value — flag homestead cap if meaningfully below market
  if (assessed != null && market != null && assessed < market * 0.95) {
    elApprAssessed.textContent = `${fmtUSD(assessed)} (homestead cap)`;
  } else {
    elApprAssessed.textContent = fmtUSD(assessed) || dash;
  }

  // Estimated tax — assessed value × the jurisdiction's representative rate
  const taxBase = assessed || market;
  const taxRate = taxRateForRow(row);
  elApprTax.textContent = taxBase
    ? `${fmtUSD(Math.round(taxBase * taxRate))}/yr (est. ~${(taxRate * 100).toFixed(1)}%)`
    : dash;

  // Owner — name is intentionally not displayed; available from TCAD on request.
  // The out-of-state signal (state code, not a name) is kept as an investor cue.
  let ownerText = 'Available from TCAD appraisal roll';
  if (row.appr_owner_state && row.appr_owner_state !== 'TX') {
    ownerText += ` (owner out-of-state: ${row.appr_owner_state})`;
  }
  elApprOwner.textContent = ownerText;

  elApprStatus.textContent = row.appr_data_yr
    ? `Source: TCAD ${row.appr_data_yr} appraisal roll`
    : '';
}

let metaFetchToken = 0;

function renderPlanning(row) {
  if (!row) {
    elFlum.textContent = elPlanZone.textContent = '—';
    return;
  }
  elFlum.textContent     = row.flum_label || (row.flum_code != null ? `Code ${row.flum_code}` : null)
                         || 'Outside any adopted Future Land Use Map';
  elPlanZone.textContent = row.zoning_ztype || row.zoning_base || 'Outside City of Austin zoning';

  // Upzoning signal: FLUM intends more intensity than current zoning.
  if (row.upzoning_flag && row.upzoning_gap > 0) {
    elUpzone.textContent =
      `Future land use intends higher intensity than current zoning ` +
      `(+${row.upzoning_gap} on the intensity scale) — potential upzoning / redevelopment candidate.`;
    elUpzone.classList.add('flag-upzoning');
  } else {
    elUpzone.textContent = '';
    elUpzone.classList.remove('flag-upzoning');
  }
}

// Centroid [lon,lat] from a GeoJSON geometry (vertex average) — for deep links.
function panelCentroid(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  let sx = 0, sy = 0, n = 0;
  const walk = (c) => {
    if (typeof c[0] === 'number') { sx += c[0]; sy += c[1]; n++; return; }
    c.forEach(walk);
  };
  walk(geometry.coordinates);
  return n ? [sx / n, sy / n] : null;
}

// "Look it up" launcher — one-click jumps to authoritative external systems for
// the selected parcel (TCAD, Austin permits/zoning/flood, maps, deed records).
function renderLinks(parcelId, geometry) {
  const box = document.getElementById('panel-links');
  if (!box) return;
  const c = panelCentroid(geometry);
  const ll = c ? `${c[1].toFixed(6)},${c[0].toFixed(6)}` : null;
  const links = [
    ['TCAD record', `https://travis.prodigycad.com/property-detail/${encodeURIComponent(parcelId)}`],
    ['City permits (AB+C)', 'https://abc.austintexas.gov/web/permit/public-search-other'],
    ['Zoning · flood · historic (Property Profile)', 'https://maps.austintexas.gov/GIS/PropertyProfile/'],
    ll && ['Aerial', `https://www.google.com/maps/search/?api=1&query=${ll}`],
    ['Deed records', 'https://www.traviscountytx.gov/county-clerk/recording'],
  ].filter(Boolean);
  box.innerHTML = links
    .map(([t, h]) => `<a href="${h}" target="_blank" rel="noopener">${t} ↗</a>`)
    .join('');

  // Google Street View link under the street-level panel (replaces the old
  // full-screen popup button). Shown only when we have a centroid to point at.
  const sg = document.getElementById('sv-google');
  if (sg) {
    if (ll) {
      sg.href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll}`;
      sg.style.display = 'block';
    } else {
      sg.style.display = 'none';
    }
  }
}

// Site Check — pre-development flags for the selected parcel (precomputed columns
// + existing data). status: ok | warn | alert | info.
function renderSiteCheck(row) {
  const box = document.getElementById('sitecheck-list');
  if (!box) return;
  box.innerHTML = '';
  const add = (status, label, detail) => {
    const r = document.createElement('div');
    r.className = `sc-row sc-${status}`;
    const dot = document.createElement('span'); dot.className = 'sc-dot';
    const txt = document.createElement('div');
    const l = document.createElement('div'); l.className = 'sc-label'; l.textContent = label;
    const d = document.createElement('div'); d.className = 'sc-detail'; d.textContent = detail;
    txt.appendChild(l); txt.appendChild(d);
    r.appendChild(dot); r.appendChild(txt);
    box.appendChild(r);
  };

  // Floodplain (FEMA, precomputed by load_floodzones.py)
  const fz = row && row.sitecheck_flood;
  if (fz && /^\.2/.test(fz)) add('warn', 'Floodplain', `0.2% annual chance (moderate) — FEMA zone ${fz}`);
  else if (fz)              add('alert', 'Floodplain', `In FEMA floodplain — 1% annual chance (SFHA), zone ${fz}`);
  else                      add('ok', 'Floodplain', 'Not in a mapped FEMA flood hazard zone');

  // Watershed regulation → approximate impervious-cover cap (Austin LDC 25-8)
  const ws = row && row.sitecheck_watershed;
  const WS = {
    'URBAN':                 ['ok',    'Urban watershed — up to ~80% impervious cover'],
    'SUBURBAN':              ['info',  'Suburban watershed — ~55% impervious cap'],
    'WATER SUPPLY SUBURBAN': ['warn',  'Water Supply Suburban — ~30% impervious cap (water quality)'],
    'WATER SUPPLY RURAL':    ['warn',  'Water Supply Rural — ~20% impervious cap (water quality)'],
    'BSZ':                   ['alert', 'Barton Springs Zone — strict water-quality limits'],
  };
  if (ws && WS[ws]) add(WS[ws][0], 'Watershed', WS[ws][1]);
  else if (ws)      add('info', 'Watershed', `${ws} watershed regulation area`);

  // Jurisdiction — authoritative (sitecheck_jurisdiction), else fall back to zoning hint
  const j = row && row.sitecheck_jurisdiction;
  if (j && /FULL PURPOSE/i.test(j))   add('ok',   'Jurisdiction', 'City of Austin full-purpose — city permits & zoning');
  else if (j && /LTD|LIMITED/i.test(j)) add('info', 'Jurisdiction', 'Limited-purpose annexation — city zoning, county building permits');
  else if (j && /ETJ/i.test(j))        add('info', 'Jurisdiction', `Extraterritorial jurisdiction (${j}) — county permits, no city zoning`);
  else if (j)                          add('info', 'Jurisdiction', j);
  else {
    const zb = row && row.zoning_base;
    if (zb) add('ok', 'Jurisdiction', `City of Austin zoning on file (${zb})`);
    else    add('info', 'Jurisdiction', 'No city zoning on file — likely ETJ or county (different permitting)');
  }
}

function openPanel(parcelId, geometry) {
  elId.textContent = parcelId;
  elTcad.href = `https://travis.prodigycad.com/property-detail/${parcelId}`;

  const s = geometryStats(geometry);
  window.AG.lastPanelData = { parcelId, geometry, stats: s };
  renderLinks(parcelId, geometry);
  const reportBtn = document.getElementById('panel-report-btn');
  if (reportBtn) reportBtn.style.display = '';
  const centerBtn = document.getElementById('panel-center-btn');
  if (centerBtn) centerBtn.style.display = '';
  elArea.textContent   = geometry ? fmtArea(s.areaM2)  : '—';
  elPerim.textContent  = geometry ? fmtFeet(s.perimM)  : '—';
  elExtent.textContent = geometry ? `${fmtFeet(s.widthM)} × ${fmtFeet(s.heightM)}` : '—';

  // Reset metadata + planning fields, then fetch from Supabase
  elAddr.textContent = elLegal.textContent = elAcres.textContent = elGeoId.textContent = '—';
  elMetaSt.textContent = 'Loading…';
  elFlum.textContent = elPlanZone.textContent = '—';
  elUpzone.textContent = elPlanSt.textContent = '';

  // Reset appraisal summary fields
  [elApprMarket, elApprAssessed, elApprTax, elApprOwner]
    .forEach((el) => { el.textContent = '—'; });
  elApprStatus.textContent = '';
  const scList = document.getElementById('sitecheck-list');
  if (scList) scList.innerHTML = '';

  const token = ++metaFetchToken;
  // appr_owner_name is intentionally NOT requested — the owner name stays in the
  // database (for case-by-case lookup in Supabase) and never reaches the browser.
  // appr_owner_state is kept: it's a derived signal (state code), not a name.
  const apprCols = 'appr_market_val,appr_land_val,appr_impr_val,appr_appraised_val,appr_assessed_val,'
    + 'appr_taxable_val,appr_cap_loss,appr_exemptions,appr_yr_built,appr_living_sqft,appr_class,'
    + 'appr_neighborhood,appr_state_cd,appr_land_sqft,appr_owner_state,appr_data_yr';
  const cols = `metadata,flum_label,flum_code,zoning_ztype,zoning_base,upzoning_gap,upzoning_flag,`
    + `sitecheck_flood,sitecheck_watershed,sitecheck_jurisdiction,${apprCols}`;
  fetch(`${SUPABASE_URL}/rest/v1/parcels?parcel_id=eq.${encodeURIComponent(parcelId)}&select=${cols}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
    .then((r) => r.json())
    .then((rows) => {
      if (token !== metaFetchToken) return; // stale response
      const row = rows?.[0];
      const meta = row?.metadata;
      if (meta) {
        elAddr.textContent  = meta.situs_address || '—';
        elLegal.textContent = meta.legal_desc    || '—';
        elAcres.textContent = meta.tcad_acres != null ? String(meta.tcad_acres) : '—';
        elGeoId.textContent = meta.geo_id        || '—';
        elMetaSt.textContent = '';
      } else {
        elMetaSt.textContent = 'No property record in database yet.';
      }
      renderPlanning(row);
      renderAppraisal(row);
      renderSiteCheck(row);
    })
    .catch(() => {
      if (token !== metaFetchToken) return;
      elMetaSt.textContent = 'Could not load property record.';
      elPlanSt.textContent = 'Could not load planning context.';
      elApprStatus.textContent = 'Could not load appraisal data.';
    });

  // Neighborhood market context (Redfin sale $/sqft + Zillow ZORI rent) by ZIP.
  // Separate, fault-tolerant fetch so a missing table/RPC never breaks the panel;
  // stashed for the report + feasibility seeding (Sale-price / Rent defaults).
  if (window.AG.lastPanelData) window.AG.lastPanelData.market = null;
  fetch(`${SUPABASE_URL}/rest/v1/rpc/parcel_market_context`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_parcel_id: parcelId }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (token !== metaFetchToken) return;
      if (d && d.status === 'ok' && window.AG.lastPanelData) window.AG.lastPanelData.market = d;
    })
    .catch(() => {});

  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
}

function closePanel() {
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  const reportBtn = document.getElementById('panel-report-btn');
  if (reportBtn) reportBtn.style.display = 'none';
  const centerBtn = document.getElementById('panel-center-btn');
  if (centerBtn) centerBtn.style.display = 'none';
  window.AG.lastPanelData = null;
}

document.getElementById('panel-close').addEventListener('click', () => {
  clearSelection();
  closePanel();
});

document.getElementById('panel-center-btn').addEventListener('click', () => {
  const data = window.AG.lastPanelData;
  if (!data) return;
  if (data.geometry) {
    map.fitBounds(bboxOfGeometry(data.geometry),
      { padding: 80, maxZoom: 18, pitch: 0, bearing: 0, duration: 900 });
  } else {
    window.dispatchEvent(new CustomEvent('parcel:select',
      { detail: { parcel_id: data.parcelId } }));
  }
});

function clearSelection() {
  if (selectedParcelId !== null) {
    map.setFeatureState(
      { source: 'parcels', sourceLayer: 'parcels', id: selectedParcelId },
      { selected: false }
    );
    selectedParcelId = null;
  }
  // Clear the search-selection GeoJSON highlight too.
  map.getSource('selected-parcel-geojson')?.setData(
    { type: 'FeatureCollection', features: [] }
  );
  if (selectedParcelPropId !== null) {
    const parcel_id = selectedParcelPropId;
    selectedParcelPropId = null;
    window.dispatchEvent(new CustomEvent('parcel:deselect', { detail: { parcel_id } }));
  }
}

// Bounding box [[minLon,minLat],[maxLon,maxLat]] of a GeoJSON geometry.
function bboxOfGeometry(geometry) {
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
  return [[minLon, minLat], [maxLon, maxLat]];
}

// Programmatic parcel selection by TCAD parcel_id (used by address search).
// Fetches geometry from Supabase, opens the panel, and fires parcel:select.
async function selectParcelById(parcel_id) {
  clearSelection();
  closePanel();
  selectedParcelPropId = parcel_id;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/parcel_geojson`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_parcel_id: parcel_id }),
      }
    );
    const geom = await res.json();
    if (geom && geom.type) {
      openPanel(parcel_id, geom);
      // Highlight + fly using the real geometry (no tile feature id needed).
      map.getSource('selected-parcel-geojson')?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: geom }],
      });
      map.fitBounds(bboxOfGeometry(geom), {
        padding: 80, maxZoom: 18, pitch: 0, bearing: 0, duration: 900,
      });
    } else {
      // Open panel without geometry stats if RPC unavailable
      openPanel(parcel_id, null);
    }
  } catch (_) {
    openPanel(parcel_id, null);
  }

  window.dispatchEvent(new CustomEvent('parcel:select', { detail: { parcel_id } }));
}
window.AG.selectParcelById = selectParcelById;

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

  // Search-selected highlight — drawn from real geometry (no tile feature id
  // available when selecting by address), so it works regardless of tiles.
  map.addSource('selected-parcel-geojson', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'selected-parcel-fill',
    type: 'fill',
    source: 'selected-parcel-geojson',
    paint: { 'fill-color': '#e8a838', 'fill-opacity': 0.5 },
  });
  map.addLayer({
    id: 'selected-parcel-outline',
    type: 'line',
    source: 'selected-parcel-geojson',
    paint: { 'line-color': '#e8a838', 'line-width': 2 },
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
