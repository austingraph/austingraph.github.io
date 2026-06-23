// austingraph.chat — neighborhood profile (panel)
// Listens for parcel:select / parcel:deselect from app.js, calls the
// parcel_demographics PostgREST RPC, and renders the (zoning-contextual)
// neighborhood profile in the panel "Neighborhood profile" section.
//
// Also exposes window.AG.demographicsRows(p) — the single source of truth for
// the lens → {title, rows} mapping — so report.js renders the same data without
// duplicating the field list.

(() => {
  const { SUPABASE_URL, SUPABASE_KEY } = window.AG;

  const elDl     = document.getElementById('panel-demo');
  const elTitle  = document.getElementById('panel-demo-title');
  const elStatus = document.getElementById('panel-demo-status');

  // ── Formatting ──────────────────────────────────────────────────────────────
  const fmt$  = (n) => n != null ? `$${Number(n).toLocaleString()}` : '—';
  const fmtPct = (n) => n != null ? `${n}%` : '—';
  const fmtN  = (n) => n != null ? Number(n).toLocaleString() : '—';

  // ── Lens → {title, rows} (shared with report.js) ─────────────────────────────
  function demographicsRows(p) {
    const lensConfig = {
      residential: {
        title: 'Neighborhood profile',
        rows: [
          ['Population (block)',  fmtN(p.total_pop)],
          ['Housing units',       fmtN(p.housing_units)],
          ['Owner occupied',      fmtPct(p.owner_pct)],
          ['Renter occupied',     fmtPct(p.renter_pct)],
          ['Median income',       fmt$(p.median_hh_income)],
          ['Median age',          p.median_age != null ? `${p.median_age} yrs` : '—'],
          ['Youth (<18)',         fmtPct(p.youth_pct)],
          ['Seniors (65+)',       fmtPct(p.senior_pct)],
          ['Hispanic/Latino',     fmtPct(p.hispanic_pct)],
          ['Black/African Am.',   fmtPct(p.black_pct)],
          ['White (non-Hisp.)',   fmtPct(p.white_pct)],
          ['Data source',         `ACS ${p.acs_vintage} 5-yr`],
        ],
      },
      rental: {
        title: 'Renter market profile',
        rows: [
          ['Renter share',        fmtPct(p.renter_pct)],
          ['Median gross rent',   p.median_gross_rent != null ? `${fmt$(p.median_gross_rent)}/mo` : '—'],
          ['Cost burdened (30%+)',fmtPct(p.cost_burden_pct)],
          ['Median income',       fmt$(p.median_hh_income)],
          ['Median age',          p.median_age != null ? `${p.median_age} yrs` : '—'],
          ['Prime-age (25–64)',   fmtPct(p.prime_pct)],
          ['Vacancy rate',        p.occupied_units != null && p.housing_units
            ? fmtPct(Math.round(100 - 100 * p.occupied_units / p.housing_units)) : '—'],
          ['Population (block)',  fmtN(p.total_pop)],
          ['Data source',         `ACS ${p.acs_vintage} 5-yr`],
        ],
      },
      commercial: {
        title: 'Trade area profile',
        rows: [
          ['Population (block)',  fmtN(p.total_pop)],
          ['Median income',       fmt$(p.median_hh_income)],
          ['Prime consumers (25–64)', fmtPct(p.prime_pct)],
          ['Owner share',         fmtPct(p.owner_pct)],
          ['Transit / walk / bike', fmtPct(p.transit_pct)],
          ['Hispanic/Latino',     fmtPct(p.hispanic_pct)],
          ['Data source',         `ACS ${p.acs_vintage} 5-yr`],
        ],
      },
      workforce: {
        title: 'Workforce context',
        rows: [
          ['Population (block)',  fmtN(p.total_pop)],
          ['Median income',       fmt$(p.median_hh_income)],
          ['Transit commuters',   fmtPct(p.transit_pct)],
          ['Owner / renter split', p.owner_pct != null
            ? `${p.owner_pct}% / ${p.renter_pct}%` : '—'],
          ['Median age',          p.median_age != null ? `${p.median_age} yrs` : '—'],
          ['Data source',         `ACS ${p.acs_vintage} 5-yr`],
        ],
      },
    };
    return lensConfig[p.lens] || lensConfig.residential;
  }

  window.AG.demographicsRows = demographicsRows;

  // ── Panel rendering ───────────────────────────────────────────────────────────
  function clear() {
    elDl.innerHTML = '';
  }

  function render(p) {
    clear();
    const cfg = demographicsRows(p);
    if (elTitle) elTitle.textContent = cfg.title;
    for (const [label, value] of cfg.rows) {
      const div = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value || '—';
      div.appendChild(dt); div.appendChild(dd);
      elDl.appendChild(div);
    }
    elStatus.textContent = '';
  }

  let fetchToken = 0;

  window.addEventListener('parcel:select', (e) => {
    const parcelId = e.detail.parcel_id;
    clear();
    if (elTitle) elTitle.textContent = 'Neighborhood profile';
    elStatus.textContent = 'Loading neighborhood data…';
    const token = ++fetchToken;

    fetch(`${SUPABASE_URL}/rest/v1/rpc/parcel_demographics`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_parcel_id: parcelId }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (token !== fetchToken) return; // stale
        // Cache for the report so it doesn't re-fetch.
        if (window.AG.lastPanelData) window.AG.lastPanelData.demographics = (d && d.status === 'ok') ? d : null;
        if (d && d.status === 'ok') {
          render(d);
        } else {
          clear();
          elStatus.textContent = 'Census data not available for this parcel (outside City limits or county parcel).';
        }
      })
      .catch(() => {
        if (token !== fetchToken) return;
        clear();
        elStatus.textContent = 'Could not load neighborhood data.';
      });
  });

  window.addEventListener('parcel:deselect', () => {
    ++fetchToken;
    clear();
    if (elTitle) elTitle.textContent = 'Neighborhood profile';
    elStatus.textContent = 'Select a parcel to see neighborhood data.';
  });
})();
