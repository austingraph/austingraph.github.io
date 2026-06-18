// austingraph.chat — development feasibility calculator
// Builds an interactive pro forma section for the Parcel Report modal.
// Called by report.js as window.AG.buildFeasibilitySection(parcelId, envelope, demographics).
//
// Data sources:
//   Zoning / buildable area : compute_envelope RPC (window.AG.lastEnvelope)
//   Interest rates          : FRED CSV endpoint (no API key required)
//   Construction costs      : RSMeans 2024 SW region proxy (hardcoded lookup)
//   Cap rates               : Marcus & Millichap Austin Q1 2025 (hardcoded)
//   Land cost               : user-entered acquisition price

(() => {
  // ── Typology lookup ───────────────────────────────────────────────────────
  // Hard costs per GBA sqft (includes MEP, site work; excludes land & soft costs)
  const TYPOLOGIES = [
    { key: 'sf',       label: 'SF Detached',          hardMin: 175, hardMax: 260, softPct: 0.20, defUse: 'sale'   },
    { key: 'adu',      label: 'ADU / Cottage',         hardMin: 210, hardMax: 300, softPct: 0.22, defUse: 'rental' },
    { key: 'duplex',   label: 'Duplex / Tri-plex',     hardMin: 160, hardMax: 240, softPct: 0.20, defUse: 'rental' },
    { key: 'small_mf', label: 'Small MF (5–20 units)', hardMin: 155, hardMax: 225, softPct: 0.22, defUse: 'rental' },
    { key: 'mixed',    label: 'Mixed-use / Concrete',  hardMin: 250, hardMax: 400, softPct: 0.25, defUse: 'rental' },
  ];

  // Cap rates: Marcus & Millichap Austin Q1 2025
  const DEFAULT_CAP = { sf: 0.055, adu: 0.0575, duplex: 0.055, small_mf: 0.055, mixed: 0.0675 };

  let cachedRates = null;

  async function fetchRates() {
    if (cachedRates) return cachedRates;
    try {
      const [r1, r2] = await Promise.all([
        fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US'),
        fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DPRIME'),
      ]);
      const parseCsv = async (r) => {
        const text = await r.text();
        const lines = text.trim().split('\n');
        const [date, val] = lines[lines.length - 1].split(',');
        return { date, val: parseFloat(val) };
      };
      const [m, p] = await Promise.all([parseCsv(r1), parseCsv(r2)]);
      cachedRates = { mortgage30: m.val, prime: p.val, rateDate: m.date };
    } catch {
      cachedRates = { mortgage30: 6.5, prime: 7.5, rateDate: null };
    }
    return cachedRates;
  }

  // ── Default typology from zoning ─────────────────────────────────────────
  function defaultTypology(env) {
    const z = env?.zoning_base || '';
    const units = env?.max_units;
    if (/^(CS|GR|MF-6|MF5|MU|CH|CBD)/.test(z)) return TYPOLOGIES.find(t => t.key === 'mixed');
    if (units >= 5) return TYPOLOGIES.find(t => t.key === 'small_mf');
    if (units >= 2) return TYPOLOGIES.find(t => t.key === 'duplex');
    return TYPOLOGIES[0];
  }

  // ── Pro forma math ────────────────────────────────────────────────────────
  function compute(s) {
    const floorArea  = s.floorArea || 0;
    const hardCosts  = floorArea * s.costPerSqft;
    const softCosts  = hardCosts * s.softPct;
    const contingency = (hardCosts + softCosts) * s.contingencyPct;
    const preLand    = hardCosts + softCosts + contingency;
    const loanBase   = preLand;
    const loanAmt    = loanBase * s.ltc;
    const finCost    = loanAmt * (s.constrRate / 100) * (s.holdMonths / 12);
    const totalCost  = s.landCost + hardCosts + softCosts + contingency + finCost;
    const equity     = s.landCost + preLand * (1 - s.ltc) + finCost;

    let exitValue, noi = null;
    if (s.useType === 'rental') {
      const grossRents = s.units * s.rentPerUnit * 12;
      const egi  = grossRents * (1 - s.vacancyPct);
      noi        = egi * (1 - s.expensePct);
      exitValue  = s.capRate > 0 ? noi / s.capRate : 0;
    } else {
      exitValue  = floorArea * s.salePsf;
    }

    const profit      = exitValue - totalCost;
    const retOnCost   = totalCost > 0 ? profit / totalCost : null;
    const retOnEquity = equity > 0 ? profit / equity : null;
    const yieldUnlev  = (noi != null && totalCost > 0) ? noi / totalCost : null;

    return {
      hardCosts, softCosts, contingency, finCost, loanAmt,
      totalCost, equity, exitValue, noi, profit,
      retOnCost, retOnEquity, yieldUnlev,
    };
  }

  // ── Formatting helpers ────────────────────────────────────────────────────
  const fmt$ = (n) => n == null ? '—' :
    '$' + Math.round(n).toLocaleString();
  const fmtPct = (n) => n == null ? '—' :
    (n * 100).toFixed(1) + '%';
  const fmtPctInput = (n) => (n * 100).toFixed(1);
  const fmtSF = (n) => n ? Math.round(n).toLocaleString() + ' SF' : '—';

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function row(label, value, opts = {}) {
    const div = document.createElement('div');
    div.className = 'report-row' + (opts.strong ? ' report-row--strong' : '') +
      (opts.indent ? ' report-row--indent' : '') +
      (opts.sep ? ' report-row--sep' : '');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (opts.node) {
      dd.appendChild(opts.node);
    } else {
      dd.textContent = value;
    }
    div.appendChild(dt); div.appendChild(dd);
    return div;
  }

  function numInput(val, opts = {}) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'feasibility-input';
    inp.value = val;
    if (opts.min != null) inp.min = opts.min;
    if (opts.max != null) inp.max = opts.max;
    if (opts.step != null) inp.step = opts.step;
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    return inp;
  }

  function dlSection(title) {
    const wrap = document.createElement('div');
    wrap.className = 'feasibility-subsection';
    const h = document.createElement('div');
    h.className = 'feasibility-sub-title';
    h.textContent = title;
    wrap.appendChild(h);
    const dl = document.createElement('dl');
    wrap.appendChild(dl);
    return { wrap, dl };
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render(container, state) {
    container.innerHTML = '';
    const c = compute(state);

    // ── Site summary ──
    const { wrap: siteSec, dl: siteDl } = dlSection('Site');
    siteDl.appendChild(row('Lot area', fmtSF(state.lotSqft)));
    siteDl.appendChild(row('Buildable floor area', fmtSF(state.floorArea)));
    siteDl.appendChild(row('Max units', state.units != null ? String(state.units) : '—'));
    container.appendChild(siteSec);

    // ── Uses (costs) ──
    const { wrap: costSec, dl: costDl } = dlSection('Uses (costs)');
    const landInp = numInput(state.landCost || '', { min: 0, step: 10000, placeholder: 'Enter acquisition cost' });
    landInp.addEventListener('change', () => { state.landCost = parseFloat(landInp.value) || 0; render(container, state); });
    costDl.appendChild(row('Land / acquisition', '', { node: landInp }));
    const hardInp = numInput(state.costPerSqft, { min: 50, max: 800, step: 5 });
    hardInp.addEventListener('change', () => { state.costPerSqft = parseFloat(hardInp.value) || state.costPerSqft; render(container, state); });
    costDl.appendChild(row('Hard cost ($/SF)', '', { node: hardInp }));
    costDl.appendChild(row('Hard cost total', fmt$(c.hardCosts), { indent: true }));
    const softInp = numInput(fmtPctInput(state.softPct), { min: 0, max: 50, step: 1 });
    softInp.addEventListener('change', () => { state.softPct = (parseFloat(softInp.value) || 0) / 100; render(container, state); });
    costDl.appendChild(row('Soft costs (%)', '', { node: softInp }));
    costDl.appendChild(row('Soft cost total', fmt$(c.softCosts), { indent: true }));
    costDl.appendChild(row('Contingency (5%)', fmt$(c.contingency), { indent: true }));
    const holdInp = numInput(state.holdMonths, { min: 6, max: 60, step: 1 });
    holdInp.addEventListener('change', () => { state.holdMonths = parseInt(holdInp.value) || state.holdMonths; render(container, state); });
    costDl.appendChild(row('Construction hold (months)', '', { node: holdInp }));
    const rateInp = numInput(state.constrRate, { min: 1, max: 25, step: 0.25 });
    rateInp.addEventListener('change', () => { state.constrRate = parseFloat(rateInp.value) || state.constrRate; render(container, state); });
    costDl.appendChild(row('Construction rate (%)', '', { node: rateInp }));
    const ltcInp = numInput(Math.round(state.ltc * 100), { min: 0, max: 90, step: 5 });
    ltcInp.addEventListener('change', () => { state.ltc = (parseFloat(ltcInp.value) || 0) / 100; render(container, state); });
    costDl.appendChild(row('Loan-to-cost (%)', '', { node: ltcInp }));
    costDl.appendChild(row('Financing cost', fmt$(c.finCost), { indent: true }));
    costDl.appendChild(row('Total project cost', fmt$(c.totalCost), { strong: true, sep: true }));
    costDl.appendChild(row('  Equity', fmt$(c.equity), { indent: true }));
    costDl.appendChild(row('  Construction loan', fmt$(c.loanAmt), { indent: true }));
    container.appendChild(costSec);

    // ── Exit / income ──
    const { wrap: exitSec, dl: exitDl } = dlSection('Exit / income');

    // Use type toggle
    const toggleWrap = document.createElement('div');
    toggleWrap.className = 'feasibility-toggle';
    ['rental', 'sale'].forEach(u => {
      const btn = document.createElement('button');
      btn.className = 'feasibility-toggle-btn' + (state.useType === u ? ' active' : '');
      btn.textContent = u === 'rental' ? 'Rental' : 'For-sale';
      btn.addEventListener('click', () => { state.useType = u; render(container, state); });
      toggleWrap.appendChild(btn);
    });
    const toggleRow = document.createElement('div');
    toggleRow.className = 'report-row';
    const toggleDt = document.createElement('dt'); toggleDt.textContent = 'Use type';
    const toggleDd = document.createElement('dd'); toggleDd.appendChild(toggleWrap);
    toggleRow.appendChild(toggleDt); toggleRow.appendChild(toggleDd);
    exitDl.appendChild(toggleRow);

    if (state.useType === 'rental') {
      const rentInp = numInput(state.rentPerUnit, { min: 0, step: 50 });
      rentInp.addEventListener('change', () => { state.rentPerUnit = parseFloat(rentInp.value) || state.rentPerUnit; render(container, state); });
      exitDl.appendChild(row('Rent / unit / month ($)', '', { node: rentInp }));
      const vacInp = numInput(Math.round(state.vacancyPct * 100), { min: 0, max: 30, step: 1 });
      vacInp.addEventListener('change', () => { state.vacancyPct = (parseFloat(vacInp.value) || 0) / 100; render(container, state); });
      exitDl.appendChild(row('Vacancy rate (%)', '', { node: vacInp }));
      const expInp = numInput(Math.round(state.expensePct * 100), { min: 0, max: 60, step: 1 });
      expInp.addEventListener('change', () => { state.expensePct = (parseFloat(expInp.value) || 0) / 100; render(container, state); });
      exitDl.appendChild(row('Operating expenses (%)', '', { node: expInp }));
      exitDl.appendChild(row('NOI', fmt$(c.noi), { indent: true }));
      const capInp = numInput(fmtPctInput(state.capRate), { min: 1, max: 15, step: 0.25 });
      capInp.addEventListener('change', () => { state.capRate = (parseFloat(capInp.value) || 0) / 100; render(container, state); });
      exitDl.appendChild(row('Cap rate (%)', '', { node: capInp }));
    } else {
      const psfInp = numInput(state.salePsf, { min: 50, step: 10 });
      psfInp.addEventListener('change', () => { state.salePsf = parseFloat(psfInp.value) || state.salePsf; render(container, state); });
      exitDl.appendChild(row('Sale price ($/SF)', '', { node: psfInp }));
    }
    exitDl.appendChild(row('Exit value', fmt$(c.exitValue), { strong: true, sep: true }));
    container.appendChild(exitSec);

    // ── Returns ──
    const { wrap: retSec, dl: retDl } = dlSection('Returns');
    retDl.appendChild(row('Profit / (loss)', fmt$(c.profit), { strong: true }));
    retDl.appendChild(row('Return on cost', fmtPct(c.retOnCost)));
    retDl.appendChild(row('Return on equity', fmtPct(c.retOnEquity)));
    if (c.yieldUnlev != null) retDl.appendChild(row('Unleveraged yield', fmtPct(c.yieldUnlev)));
    const profitClass = c.profit > 0 ? 'feasibility-positive' : c.profit < 0 ? 'feasibility-negative' : '';
    if (profitClass) retSec.querySelector('.feasibility-sub-title')?.classList.add(profitClass);
    container.appendChild(retSec);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  async function buildFeasibilitySection(parcelId, envelope, demographics) {
    const outer = document.createElement('div');
    outer.className = 'report-section feasibility-section';
    const h = document.createElement('div');
    h.className = 'report-section-title';
    h.textContent = 'Development feasibility';
    outer.appendChild(h);

    const loading = document.createElement('p');
    loading.className = 'report-env-note';
    loading.textContent = 'Loading market rates…';
    outer.appendChild(loading);

    const rates = await fetchRates();
    loading.remove();

    if (!envelope || envelope.status !== 'ok') {
      const msg = document.createElement('p');
      msg.className = 'report-env-note';
      msg.textContent = envelope?.status === 'no_zoning'
        ? 'County/ETJ parcel — enter buildable area manually below.'
        : 'Zoning envelope unavailable; enter assumptions manually.';
      outer.appendChild(msg);
    }

    const typo = defaultTypology(envelope);
    const lotSqft   = envelope?.lot_sqft    || 0;
    const floorArea  = envelope?.max_far_sqft || envelope?.buildable_sqft || 0;
    const maxUnits   = envelope?.max_units   ?? null;
    const medRent    = demographics?.median_gross_rent || 1800;

    const state = {
      typology: typo,
      lotSqft,
      floorArea: Math.round(floorArea),
      units: maxUnits ?? 1,
      landCost: 0,
      costPerSqft: Math.round((typo.hardMin + typo.hardMax) / 2),
      softPct: typo.softPct,
      contingencyPct: 0.05,
      holdMonths: 18,
      constrRate: parseFloat(((rates.prime || 7.5) + 2).toFixed(2)),
      ltc: 0.70,
      useType: typo.defUse,
      capRate: DEFAULT_CAP[typo.key],
      rentPerUnit: medRent,
      vacancyPct: 0.05,
      expensePct: 0.35,
      salePsf: 280,
      rates,
    };

    // Typology selector
    const typoWrap = document.createElement('div');
    typoWrap.className = 'feasibility-typo-selector';
    const typoLabel = document.createElement('span');
    typoLabel.className = 'feasibility-typo-label';
    typoLabel.textContent = 'Building type:';
    typoWrap.appendChild(typoLabel);
    const contentDiv = document.createElement('div');

    TYPOLOGIES.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'feasibility-typo-btn' + (t.key === typo.key ? ' active' : '');
      btn.textContent = t.label;
      btn.addEventListener('click', () => {
        state.typology = t;
        state.costPerSqft = Math.round((t.hardMin + t.hardMax) / 2);
        state.softPct = t.softPct;
        state.capRate = DEFAULT_CAP[t.key];
        state.useType = t.defUse;
        typoWrap.querySelectorAll('.feasibility-typo-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        render(contentDiv, state);
      });
      typoWrap.appendChild(btn);
    });
    outer.appendChild(typoWrap);
    outer.appendChild(contentDiv);
    render(contentDiv, state);

    // Source footnote
    const src = document.createElement('p');
    src.className = 'feasibility-sources';
    const rateNote = rates.rateDate
      ? `FRED ${rates.rateDate}: 30yr fixed ${rates.mortgage30}%, prime ${rates.prime}%.`
      : `Rates: FRED (unavailable, using defaults).`;
    src.textContent = `${rateNote} Hard costs: RSMeans 2024 SW proxy. Cap rates: Marcus & Millichap Austin Q1 2025. Screening estimates only — not investment advice.`;
    outer.appendChild(src);

    return outer;
  }

  window.AG.buildFeasibilitySection = buildFeasibilitySection;
})();
