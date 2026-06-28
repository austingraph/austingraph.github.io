// austingraph.chat — civic connections
// On parcel:select, shows the parcel's civic records in the panel "Connections"
// section:
//   • Permits  — LIVE from the City of Austin open-data portal (Socrata), matched
//                by tcad_id = the parcel's geo_id. Always current, no ingest.
//   • Zoning cases (+ council votes) — from the parcel_graph knowledge-graph view
//                (populated by scripts/ingest/); renders nothing until ingested.

(() => {
  const { SUPABASE_URL, SUPABASE_KEY } = window.AG;
  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const PERMITS_URL = 'https://data.austintexas.gov/resource/3syk-w9eu.json';  // Issued construction permits
  const MAX_SHOWN = 12;

  const elStatus  = document.getElementById('conn-status');
  const elCases   = document.getElementById('conn-cases');
  const elPermits = document.getElementById('conn-permits');

  let fetchToken = 0;
  const enc = encodeURIComponent;

  function clear() { elCases.innerHTML = ''; elPermits.innerHTML = ''; }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ── Fetchers (each resolves to a safe default; never rejects) ─────────────────
  function fetchCases(parcelId) {
    return fetch(`${SUPABASE_URL}/rest/v1/parcel_graph?parcel_id=eq.${enc(parcelId)}&select=cases`,
      { headers: SB_HEADERS })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => (rows && rows[0] && rows[0].cases) || [])
      .catch(() => []);
  }

  function fetchGeoId(parcelId) {
    return fetch(`${SUPABASE_URL}/rest/v1/parcels?parcel_id=eq.${enc(parcelId)}&select=metadata`,
      { headers: SB_HEADERS })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => (rows && rows[0] && rows[0].metadata && rows[0].metadata.geo_id) || null)
      .catch(() => null);
  }

  function fetchPermits(geoId) {
    if (!geoId) return Promise.resolve([]);
    const q = `tcad_id=${enc(geoId)}`
      + '&$select=permit_number,permit_type_desc,work_class,status_current,issue_date,description'
      + '&$order=issue_date%20DESC&$limit=50';
    return fetch(`${PERMITS_URL}?${q}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => (Array.isArray(d) ? d : []))
      .catch(() => []);
  }

  // ── Renderers ────────────────────────────────────────────────────────────────
  function renderCases(cases) {
    if (!cases.length) return;
    const group = el('div');
    group.appendChild(el('h3', 'conn-heading', `Zoning cases (${cases.length})`));
    for (const c of cases) {
      const item = el('div', 'conn-item');
      const head = el('div', 'conn-item-head');
      head.appendChild(el('span', 'conn-title', c.case_number));
      if (c.status) head.appendChild(el('span', 'conn-badge', c.status));
      item.appendChild(head);
      if (c.zoning) item.appendChild(el('div', 'conn-detail', c.zoning));
      const meta = [c.district ? `District ${c.district}` : null, c.approval_date]
        .filter(Boolean).join(' · ');
      if (meta) item.appendChild(el('div', 'conn-meta', meta));
      const votes = (c.votes || []).filter((v) => v.voter);
      if (votes.length) {
        const vl = el('ul', 'conn-votes');
        for (const v of votes) {
          const li = el('li');
          li.appendChild(el('span', 'conn-voter', v.voter));
          li.appendChild(el('span', `conn-vote conn-vote-${(v.vote || '').toLowerCase()}`, v.vote || '—'));
          vl.appendChild(li);
        }
        item.appendChild(vl);
      }
      group.appendChild(item);
    }
    elCases.appendChild(group);
  }

  const OPEN_RE = /active|review|pending|submitted|hold|issued/i;
  const fmtDate = (s) => (s || '').slice(0, 10);

  function renderPermits(permits) {
    if (!permits.length) return;
    const open = permits.filter((p) => OPEN_RE.test(p.status_current || '')).length;
    const group = el('div');
    group.appendChild(el('h3', 'conn-heading',
      `Permits (${permits.length}${permits.length === 50 ? '+' : ''}${open ? ` · ${open} open` : ''})`));
    for (const p of permits.slice(0, MAX_SHOWN)) {
      const item = el('div', 'conn-item');
      const head = el('div', 'conn-item-head');
      head.appendChild(el('span', 'conn-title', p.permit_type_desc || p.permit_number || 'Permit'));
      if (p.status_current) head.appendChild(el('span', 'conn-badge', p.status_current));
      item.appendChild(head);
      const sub = [p.work_class, p.permit_number].filter(Boolean).join(' · ');
      if (sub) item.appendChild(el('div', 'conn-detail', sub));
      if (fmtDate(p.issue_date)) item.appendChild(el('div', 'conn-meta', fmtDate(p.issue_date)));
      group.appendChild(item);
    }
    if (permits.length > MAX_SHOWN) {
      group.appendChild(el('div', 'conn-meta',
        `+${permits.length - MAX_SHOWN} more — see "City permits" under Look it up`));
    }
    elPermits.appendChild(group);
  }

  // ── Events ───────────────────────────────────────────────────────────────────
  window.addEventListener('parcel:select', (e) => {
    const parcelId = e.detail.parcel_id;
    clear();
    elStatus.textContent = 'Loading civic records…';
    const token = ++fetchToken;

    Promise.all([
      fetchCases(parcelId),
      fetchGeoId(parcelId).then(fetchPermits),
    ]).then(([cases, permits]) => {
      if (token !== fetchToken) return;             // a newer parcel was selected
      renderCases(cases);
      renderPermits(permits);
      elStatus.textContent = (cases.length || permits.length)
        ? '' : 'No permits or zoning cases on record.';
    });
  });

  window.addEventListener('parcel:deselect', () => {
    ++fetchToken;
    clear();
    elStatus.textContent = 'Select a parcel to see civic records.';
  });
})();
