// austingraph.chat — development envelope (text panel)
// Listens for parcel:select / parcel:deselect from app.js, calls the
// compute_envelope PostgREST RPC, and updates the "Development potential"
// text fields in the left panel. Visual overlays (setback zone, buildable
// footprint, 3D massing) live in the Parcel Report mini-map (report.js).

(() => {
  const { SUPABASE_URL, SUPABASE_KEY } = window.AG;

  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  const elZoning     = document.getElementById('env-zoning');
  const elSetbacks   = document.getElementById('env-setbacks');
  const elBuildable  = document.getElementById('env-buildable');
  const elFar        = document.getElementById('env-far');
  const elImpervious = document.getElementById('env-impervious');
  const elHeight     = document.getElementById('env-height');
  const elUnits      = document.getElementById('env-units');
  const elStatus     = document.getElementById('env-status');

  function fmtSqft(n) {
    return `${Math.round(n).toLocaleString()} sq ft`;
  }

  function resetFields(msg) {
    for (const el of [elZoning, elSetbacks, elBuildable, elFar, elImpervious, elHeight, elUnits]) {
      el.textContent = '—';
    }
    elStatus.textContent = msg || '';
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

    const notes = [...(d.notes || [])];
    if ((d.edges?.features || []).some((f) => f.properties.class === 'street_side')) {
      notes.push('Corner lot: second street frontage uses street-side setback.');
    }
    elStatus.textContent = notes.join(' ');

    window.AG.lastEnvelope = d;
    window.dispatchEvent(new CustomEvent('envelope:ready', { detail: { envelope: d } }));
  }

  let fetchToken = 0;

  window.addEventListener('parcel:select', (e) => {
    const token = ++fetchToken;
    resetFields('Computing development envelope…');

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
        if (token !== fetchToken) return;
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
    window.AG.lastEnvelope = null;
  });
})();
