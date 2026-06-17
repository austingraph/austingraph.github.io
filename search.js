// austingraph.chat — address search control
// Queries parcels.metadata->>'situs_address' via PostgREST ilike filter.
// On selection dispatches parcel:select via window.AG.selectParcelById.

(() => {
  const { SUPABASE_URL, SUPABASE_KEY } = window.AG;

  // Build DOM
  const bar = document.createElement('div');
  bar.id = 'search-bar';

  const input = document.createElement('input');
  input.id = 'search-input';
  input.type = 'search';
  input.placeholder = 'Search address…';
  input.autocomplete = 'off';
  input.spellcheck = false;

  const results = document.createElement('ul');
  results.id = 'search-results';
  results.setAttribute('role', 'listbox');
  results.hidden = true;

  bar.appendChild(input);
  bar.appendChild(results);
  document.getElementById('map').appendChild(bar);

  let debounceTimer = null;
  let activeIndex = -1;

  function hideResults() {
    results.hidden = true;
    activeIndex = -1;
  }

  function renderResults(items) {
    results.innerHTML = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'search-no-results';
      li.textContent = 'No results';
      results.appendChild(li);
    } else {
      items.forEach((item) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.dataset.parcelId = item.parcel_id;
        li.textContent = item.metadata?.situs_address || item.parcel_id;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault(); // keep input focused
          selectItem(item.parcel_id);
        });
        results.appendChild(li);
      });
    }
    results.hidden = false;
    activeIndex = -1;
  }

  function selectItem(parcel_id) {
    input.value = '';
    hideResults();
    window.AG.selectParcelById(parcel_id);
  }

  function setActive(index) {
    const items = results.querySelectorAll('li[role="option"]');
    items.forEach((li, i) => li.classList.toggle('active', i === index));
    activeIndex = index;
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 3) { hideResults(); return; }
    debounceTimer = setTimeout(() => search(q), 250);
  });

  input.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('li[role="option"]');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && items[activeIndex]) {
        selectItem(items[activeIndex].dataset.parcelId);
      }
    } else if (e.key === 'Escape') {
      hideResults();
      input.blur();
    }
  });

  document.addEventListener('click', (e) => {
    if (!bar.contains(e.target)) hideResults();
  });

  async function search(q) {
    const encoded = encodeURIComponent(`*${q}*`);
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/parcels?select=parcel_id,metadata&metadata->>situs_address=ilike.${encoded}&limit=8`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      if (!res.ok) { hideResults(); return; }
      const data = await res.json();
      renderResults(Array.isArray(data) ? data : []);
    } catch (_) {
      hideResults();
    }
  }
})();
