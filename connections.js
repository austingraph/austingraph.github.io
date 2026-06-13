// austingraph.chat — civic connections (knowledge graph)
// Listens for parcel:select / parcel:deselect from app.js and fetches the
// parcel_graph view from PostgREST (anon key), rendering connected zoning
// cases (with council votes) and permits in the panel "Connections" section.

(() => {
  const { SUPABASE_URL, SUPABASE_KEY } = window.AG;

  const elStatus  = document.getElementById('conn-status');
  const elCases   = document.getElementById('conn-cases');
  const elPermits = document.getElementById('conn-permits');

  let fetchToken = 0;

  function clear() {
    elCases.innerHTML = '';
    elPermits.innerHTML = '';
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderCases(cases) {
    if (!cases.length) return;
    const group = el('div');
    group.appendChild(el('h3', 'conn-heading', `Zoning cases (${cases.length})`));
    for (const c of cases) {
      const item = el('div', 'conn-item');
      const head = el('div', 'conn-item-head');
      const num = el('span', 'conn-title', c.case_number);
      head.appendChild(num);
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

  function renderPermits(permits) {
    if (!permits.length) return;
    const group = el('div');
    group.appendChild(el('h3', 'conn-heading', `Permits (${permits.length})`));
    for (const p of permits) {
      const item = el('div', 'conn-item');
      const head = el('div', 'conn-item-head');
      head.appendChild(el('span', 'conn-title', p.type || p.permit_number));
      if (p.status) head.appendChild(el('span', 'conn-badge', p.status));
      item.appendChild(head);
      const meta = [p.permit_number, p.issue_date].filter(Boolean).join(' · ');
      if (meta) item.appendChild(el('div', 'conn-meta', meta));
      group.appendChild(item);
    }
    elPermits.appendChild(group);
  }

  window.addEventListener('parcel:select', (e) => {
    const parcelId = e.detail.parcel_id;
    clear();
    elStatus.textContent = 'Loading civic records…';
    const token = ++fetchToken;

    fetch(`${SUPABASE_URL}/rest/v1/parcel_graph?parcel_id=eq.${encodeURIComponent(parcelId)}&select=cases,permits`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
      .then((r) => r.json())
      .then((rows) => {
        if (token !== fetchToken) return; // stale
        const row = rows && rows[0];
        const cases = (row && row.cases) || [];
        const permits = (row && row.permits) || [];
        if (!cases.length && !permits.length) {
          elStatus.textContent = 'No zoning cases, votes, or permits linked yet.';
          return;
        }
        elStatus.textContent = '';
        renderCases(cases);
        renderPermits(permits);
      })
      .catch(() => {
        if (token !== fetchToken) return;
        elStatus.textContent = 'Could not load civic records.';
      });
  });

  window.addEventListener('parcel:deselect', () => {
    ++fetchToken;
    clear();
    elStatus.textContent = 'Select a parcel to see civic records.';
  });
})();
