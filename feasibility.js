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
    { key: 'duplex',   label: 'Duplex / Tri-plex',     hardMin: 160, hardMax: 240, softPct: 0.20, defUse: 'sale'   },
    { key: 'small_mf', label: 'Small MF (5–20 units)', hardMin: 155, hardMax: 225, softPct: 0.22, defUse: 'rental' },
    { key: 'mixed',    label: 'Mixed-use / Concrete',  hardMin: 250, hardMax: 400, softPct: 0.25, defUse: 'rental' },
  ];

  // Cap rates: Marcus & Millichap Austin Q1 2025
  const DEFAULT_CAP = { sf: 0.055, adu: 0.0575, duplex: 0.055, small_mf: 0.055, mixed: 0.0675 };

  // Typical built unit size (SF) for seeding a REALISTIC program — the FAR maximum
  // is usually a big overbuild for the allowed unit count (e.g. 3 units ≠ 13,000 SF).
  // null → size by FAR (commercial/mixed, where unit count isn't the right basis).
  const UNIT_SF = { sf: 2200, adu: 800, duplex: 1600, small_mf: 950, mixed: null };

  // Multi-year hold model constants: selling costs at exit (commission + closing)
  // and the IRS straight-line schedule for residential rental improvements.
  const SELL_COST = 0.06;
  const DEP_YEARS = 27.5;

  // Plain-language explanations shown in the per-line ⓘ tooltips (demo helper).
  const INFO = {
    lotArea:      'Total land area of the parcel, from TCAD records.',
    buildable:    'Floor area you plan to build. Pre-filled with the maximum the zoning’s FAR and lot-coverage allow — edit it down to a realistic program (e.g. three 1,800 SF townhomes ≈ 5,400 SF).',
    existingArea: 'Living area of the building currently on the lot (TCAD). Editable.',
    maxUnits:     'Maximum dwelling units the zoning allows here (includes Austin’s HOME rules).',
    unitsExisting:'Treated as one existing structure for the hold scenario.',
    land:         'What you pay for the land. Seeded from the TCAD land value — change it to your purchase price.',
    currentValue: 'Today’s value (or your purchase price). Seeded from the TCAD market value.',
    hardPsf:      'Construction cost per square foot — labor and materials. Varies by building type.',
    hardTotal:    'Floor area × hard cost per square foot.',
    softPct:      'Design, engineering, permits and fees, as a percent of hard costs.',
    softTotal:    'Hard cost total × the soft-cost percent.',
    contingency:  'A buffer for cost overruns (5% of hard + soft costs).',
    holdMonths:   'How long construction takes — used to size the loan interest.',
    constrRate:   'Annual interest rate on the construction loan.',
    ltc:          'Loan-to-cost: the share of project cost the loan covers; the rest is your equity.',
    finCost:      'Estimated construction-loan interest over the build period.',
    totalCost:    'Everything in: land + construction + soft costs + contingency + financing.',
    totalBasis:   'Your all-in cost to own — here, the acquisition value.',
    equity:       'Cash you put in — the part of cost the loan doesn’t cover.',
    loan:         'The borrowed portion of project cost.',
    rent:         'Expected monthly rent per unit. Seeded from the neighborhood median.',
    vacancy:      'Share of potential rent lost to empty units.',
    opex:         'Operating costs (taxes, insurance, maintenance) as a percent of rent.',
    noi:          'Net operating income — rent left after vacancy and operating expenses.',
    cap:          'Capitalization rate — the market yield used to value the income. Lower cap = higher value.',
    salePsf:      'Expected sale price per square foot of finished space. Pre-filled from the ZIP’s Redfin median sale $/sqft when available (else a generic default) — verify against the Comps & listings links and adjust.',
    exitValue:    'What the finished project is worth: NOI ÷ cap rate (rental) or area × sale price (for-sale).',
    impliedValue: 'Value of the income at the chosen cap rate (NOI ÷ cap rate).',
    profit:       'Exit value minus total project cost.',
    roc:          'Return on cost — profit ÷ total project cost.',
    roe:          'Return on equity — profit ÷ the cash you invested.',
    yieldU:       'Unleveraged yield — NOI ÷ total cost, ignoring debt.',
    annualNoi:    'Yearly income after vacancy and operating expenses.',
    yieldOnValue: 'NOI ÷ value — your income return on what it’s worth.',
    valueVsBasis: 'Income-based value minus what you paid.',
    targetRoc:    'The return you want to earn. It drives the land price you can afford to pay.',
    residualLand: 'The most you could pay for the land and still hit your target return.',
    vsTcadLand:   'TCAD’s land value, shown for comparison.',
    holdYears:    'How many years you keep the property before selling.',
    rentGrowth:   'How fast rents (and so income) grow per year. Austin has averaged ~2–4% long-run.',
    exitCap:      'Cap rate used to value the property when you sell. A higher exit cap = a lower sale price (conservative).',
    ltv:          'Loan-to-value: the share of the purchase financed with a mortgage; the rest is your cash.',
    mortRate:     'Interest rate on a 30-year fixed investment mortgage. Seeded from the live FRED average.',
    mortLoan:     'The mortgage amount: value × loan-to-value.',
    equityIn:     'Cash you put in at purchase: value minus the mortgage.',
    debtService:  'Yearly mortgage payment (principal + interest, 30-year amortization).',
    cashOnCash:   'Year-1 cash flow (NOI minus mortgage payments) ÷ the cash you invested. The income return on your actual cash.',
    dscr:         'Debt-service coverage ratio: NOI ÷ annual mortgage payment. Lenders typically want 1.20–1.25+.',
    saleProceeds: 'Estimated cash from selling at the end of the hold: exit-year income ÷ exit cap, minus ~6% selling costs and the remaining loan balance.',
    irr:          'Internal rate of return on your cash — the annualized return counting every year’s cash flow plus the sale. The headline metric investors screen with.',
    equityMult:   'Total cash back (all cash flows + sale proceeds) ÷ cash invested. 2.0× means you doubled your money over the hold.',
    taxBracket:   'Your marginal income-tax rate — used only to estimate the depreciation tax shield.',
    depreciation: 'Simplified straight-line deduction: the building share of your basis spread over 27.5 years (land is not depreciable; the split uses TCAD’s land/building ratio). Consult a CPA — real schedules, recapture, and passive-loss rules vary.',
    taxShield:    'Income tax the depreciation deduction saves each year: deduction × your tax bracket. Reduces taxes on rental income; not included in the IRR above.',
  };

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

    // Residual land value: the land price at which return-on-cost equals target.
    // total*(1+target)=exit ⇒ land = exit/(1+target) − (build costs, land-independent).
    const targetRoc    = s.targetRoc != null ? s.targetRoc : 0.15;
    const buildCosts   = hardCosts + softCosts + contingency + finCost;
    const residualLand = exitValue / (1 + targetRoc) - buildCosts;

    return {
      hardCosts, softCosts, contingency, finCost, loanAmt,
      totalCost, equity, exitValue, noi, profit,
      retOnCost, retOnEquity, yieldUnlev, residualLand,
    };
  }

  // ── Multi-year hold math (Hold scenario only) ─────────────────────────────
  // IRR by bisection on NPV. cashflows[0] is the (negative) initial equity;
  // returns null when no root exists in (−95%, +100%) — e.g. a total-loss deal.
  function irr(cashflows) {
    const npv = (r) => cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0);
    let lo = -0.95, hi = 1.0;
    let fLo = npv(lo), fHi = npv(hi);
    if (!isFinite(fLo) || !isFinite(fHi) || fLo * fHi > 0) return null;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2, fMid = npv(mid);
      if (fLo * fMid <= 0) { hi = mid; } else { lo = mid; fLo = fMid; }
    }
    return (lo + hi) / 2;
  }

  // 30-year-mortgage hold: buy at s.landCost (the basis), finance at s.ltv /
  // s.mortRate, grow NOI at s.rentGrowth, sell in year s.holdYears at s.exitCap.
  // Returns null when the model can't run (no income / no basis / no equity).
  function computeHold10(s, noi) {
    const basis = s.landCost || 0;
    const N = Math.max(2, Math.round(s.holdYears || 10));
    if (!(noi > 0) || !(basis > 0)) return null;

    const loan = basis * (s.ltv || 0);
    const equity0 = basis - loan;
    if (equity0 <= 0) return null;

    // Monthly amortization over 30 years; r=0 degrades to straight principal.
    const months = 360;
    const r = (s.mortRate || 0) / 100 / 12;
    const pay = loan <= 0 ? 0
      : r > 0 ? loan * r / (1 - Math.pow(1 + r, -months))
      : loan / months;
    const ads = pay * 12;
    const m = N * 12;
    const balance = loan <= 0 ? 0
      : r > 0 ? loan * (Math.pow(1 + r, months) - Math.pow(1 + r, m)) / (Math.pow(1 + r, months) - 1)
      : loan * (1 - m / months);

    const g = s.rentGrowth || 0;
    const noiAt = (t) => noi * Math.pow(1 + g, t - 1);          // year t income
    const exitCap = s.exitCap || 0;
    const sale = exitCap > 0 ? noiAt(N + 1) / exitCap : 0;
    const saleNet = sale * (1 - SELL_COST) - balance;

    const flows = [-equity0];
    let totalCF = 0;
    for (let t = 1; t <= N; t++) {
      const cf = noiAt(t) - ads;
      totalCF += cf;
      flows.push(t === N ? cf + saleNet : cf);
    }

    const coc1 = (noiAt(1) - ads) / equity0;
    const dscr1 = ads > 0 ? noi / ads : null;
    const irrVal = irr(flows);
    const equityMult = (totalCF + saleNet) / equity0;

    // Depreciation (screening estimate): building share of basis over 27.5 years.
    const share = s.imprShare;
    const annualDep = (share > 0) ? basis * share / DEP_YEARS : null;
    const taxShield = (annualDep != null) ? annualDep * (s.taxBracket || 0) : null;

    return { N, loan, equity0, ads, coc1, dscr1, saleNet, irrVal, equityMult, annualDep, taxShield };
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
    const isInput = opts.node && opts.node.tagName === 'INPUT';
    div.className = 'report-row' + (opts.strong ? ' report-row--strong' : '') +
      (opts.indent ? ' report-row--indent' : '') +
      (opts.sep ? ' report-row--sep' : '') +
      (isInput ? ' report-row--input' : '');
    const dt = document.createElement('dt');
    dt.textContent = label;
    if (opts.info) {
      const ic = document.createElement('span');
      ic.className = 'info-icon';
      ic.setAttribute('data-tip', opts.info);
      ic.setAttribute('aria-label', opts.info);
      ic.setAttribute('tabindex', '0');
      ic.textContent = 'i';
      dt.appendChild(ic);
    }
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
  // Branches by state.mode: 'build' (default — by-right / max-density), 'hold'
  // (own + rent the existing building, no construction), 'residual' (build, but
  // solve for the land price that hits a target return).
  function render(container, state) {
    container.innerHTML = '';
    const c = compute(state);
    const mode = state.mode || 'build';
    const isHold = mode === 'hold';
    const isResidual = mode === 'residual';
    const h10 = isHold ? computeHold10(state, c.noi) : null;

    // ── Result banner (plain-language headline for the active scenario) ──
    let bigLabel, bigVal, subText, sign;
    if (isResidual) {
      bigLabel = 'You could pay up to';
      bigVal   = fmt$(c.residualLand);
      subText  = `for the land to earn a ${fmtPct(state.targetRoc != null ? state.targetRoc : 0.15)} return on cost`;
      sign     = c.residualLand;
    } else if (isHold) {
      bigLabel = 'Annual income (NOI)';
      bigVal   = fmt$(c.noi);
      subText  = `${fmtPct(c.yieldUnlev)} yield on current value` +
        (h10 && h10.irrVal != null ? ` · ${fmtPct(h10.irrVal)} ${h10.N}-yr IRR` : '');
      sign     = c.noi;
    } else {
      bigLabel = 'Estimated profit';
      bigVal   = fmt$(c.profit);
      subText  = `${fmtPct(c.retOnCost)} return on cost · ${fmtPct(c.retOnEquity)} on equity`;
      sign     = c.profit;
    }
    const banner = document.createElement('div');
    banner.className = 'feasibility-result ' +
      (sign > 0 ? 'feasibility-result--pos' : sign < 0 ? 'feasibility-result--neg' : 'feasibility-result--neutral');
    const bL = document.createElement('div'); bL.className = 'feasibility-result-label'; bL.textContent = bigLabel;
    const bV = document.createElement('div'); bV.className = 'feasibility-result-value'; bV.textContent = bigVal;
    const bS = document.createElement('div'); bS.className = 'feasibility-result-sub'; bS.textContent = subText;
    banner.appendChild(bL); banner.appendChild(bV); banner.appendChild(bS);
    container.appendChild(banner);

    // ── Site summary ──
    const { wrap: siteSec, dl: siteDl } = dlSection('Site');
    siteDl.appendChild(row('Lot area', fmtSF(state.lotSqft), { info: INFO.lotArea }));
    // Floor area is pre-filled from the zoning envelope but is editable: developers
    // routinely build less than the FAR maximum, and the seeded max can be an
    // unrealistic overbuild for a low unit count.
    const faInp = numInput(Math.round(state.floorArea || 0), { min: 0, step: 100 });
    faInp.addEventListener('change', () => { state.floorArea = parseFloat(faInp.value) || 0; render(container, state); });
    siteDl.appendChild(row(isHold ? 'Existing building area (SF)' : 'Buildable floor area (SF)', '', { node: faInp, info: isHold ? INFO.existingArea : INFO.buildable }));
    siteDl.appendChild(row(isHold ? 'Units (existing)' : 'Max units', state.units != null ? String(state.units) : '—', { info: isHold ? INFO.unitsExisting : INFO.maxUnits }));
    container.appendChild(siteSec);

    if (isHold) {
      // ── Basis (no construction) ──
      const { wrap, dl } = dlSection('Basis');
      const valInp = numInput(state.landCost || '', { min: 0, step: 10000, placeholder: 'Current / acquisition value' });
      valInp.addEventListener('change', () => { state.landCost = parseFloat(valInp.value) || 0; render(container, state); });
      dl.appendChild(row('Current value / acquisition', '', { node: valInp, info: INFO.currentValue }));
      dl.appendChild(row('Total basis', fmt$(c.totalCost), { strong: true, sep: true, info: INFO.totalBasis }));
      container.appendChild(wrap);
    } else {
      // ── Uses (costs) ── (build / residual)
      const { wrap: costSec, dl: costDl } = dlSection('Uses (costs)');
      const landInp = numInput(state.landCost || '', { min: 0, step: 10000, placeholder: 'Enter acquisition cost' });
      landInp.addEventListener('change', () => { state.landCost = parseFloat(landInp.value) || 0; render(container, state); });
      costDl.appendChild(row('Land / acquisition', '', { node: landInp, info: INFO.land }));
      const hardInp = numInput(state.costPerSqft, { min: 50, max: 800, step: 5 });
      hardInp.addEventListener('change', () => { state.costPerSqft = parseFloat(hardInp.value) || state.costPerSqft; render(container, state); });
      costDl.appendChild(row('Hard cost ($/SF)', '', { node: hardInp, info: INFO.hardPsf }));
      costDl.appendChild(row('Hard cost total', fmt$(c.hardCosts), { indent: true, info: INFO.hardTotal }));
      const softInp = numInput(fmtPctInput(state.softPct), { min: 0, max: 50, step: 1 });
      softInp.addEventListener('change', () => { state.softPct = (parseFloat(softInp.value) || 0) / 100; render(container, state); });
      costDl.appendChild(row('Soft costs (%)', '', { node: softInp, info: INFO.softPct }));
      costDl.appendChild(row('Soft cost total', fmt$(c.softCosts), { indent: true, info: INFO.softTotal }));
      costDl.appendChild(row('Contingency (5%)', fmt$(c.contingency), { indent: true, info: INFO.contingency }));
      const holdInp = numInput(state.holdMonths, { min: 6, max: 60, step: 1 });
      holdInp.addEventListener('change', () => { state.holdMonths = parseInt(holdInp.value) || state.holdMonths; render(container, state); });
      costDl.appendChild(row('Construction hold (months)', '', { node: holdInp, info: INFO.holdMonths }));
      const rateInp = numInput(state.constrRate, { min: 1, max: 25, step: 0.25 });
      rateInp.addEventListener('change', () => { state.constrRate = parseFloat(rateInp.value) || state.constrRate; render(container, state); });
      costDl.appendChild(row('Construction rate (%)', '', { node: rateInp, info: INFO.constrRate }));
      const ltcInp = numInput(Math.round(state.ltc * 100), { min: 0, max: 90, step: 5 });
      ltcInp.addEventListener('change', () => { state.ltc = (parseFloat(ltcInp.value) || 0) / 100; render(container, state); });
      costDl.appendChild(row('Loan-to-cost (%)', '', { node: ltcInp, info: INFO.ltc }));
      costDl.appendChild(row('Financing cost', fmt$(c.finCost), { indent: true, info: INFO.finCost }));
      costDl.appendChild(row('Total project cost', fmt$(c.totalCost), { strong: true, sep: true, info: INFO.totalCost }));
      costDl.appendChild(row('  Equity', fmt$(c.equity), { indent: true, info: INFO.equity }));
      costDl.appendChild(row('  Construction loan', fmt$(c.loanAmt), { indent: true, info: INFO.loan }));
      container.appendChild(costSec);
    }

    // ── Exit / income ──
    const { wrap: exitSec, dl: exitDl } = dlSection(isHold ? 'Income' : 'Exit / income');

    if (!isHold) {
      // Use type toggle (build / residual)
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
    }

    if (isHold || state.useType === 'rental') {
      const rentInp = numInput(state.rentPerUnit, { min: 0, step: 50 });
      rentInp.addEventListener('change', () => { state.rentPerUnit = parseFloat(rentInp.value) || state.rentPerUnit; render(container, state); });
      exitDl.appendChild(row('Rent / unit / month ($)', '', { node: rentInp, info: INFO.rent }));
      const vacInp = numInput(Math.round(state.vacancyPct * 100), { min: 0, max: 30, step: 1 });
      vacInp.addEventListener('change', () => { state.vacancyPct = (parseFloat(vacInp.value) || 0) / 100; render(container, state); });
      exitDl.appendChild(row('Vacancy rate (%)', '', { node: vacInp, info: INFO.vacancy }));
      const expInp = numInput(Math.round(state.expensePct * 100), { min: 0, max: 60, step: 1 });
      expInp.addEventListener('change', () => { state.expensePct = (parseFloat(expInp.value) || 0) / 100; render(container, state); });
      exitDl.appendChild(row('Operating expenses (%)', '', { node: expInp, info: INFO.opex }));
      exitDl.appendChild(row('NOI', fmt$(c.noi), { indent: true, info: INFO.noi }));
      const capInp = numInput(fmtPctInput(state.capRate), { min: 1, max: 15, step: 0.25 });
      capInp.addEventListener('change', () => { state.capRate = (parseFloat(capInp.value) || 0) / 100; render(container, state); });
      exitDl.appendChild(row('Cap rate (%)', '', { node: capInp, info: INFO.cap }));
    } else {
      const psfInp = numInput(state.salePsf, { min: 50, step: 10 });
      psfInp.addEventListener('change', () => { state.salePsf = parseFloat(psfInp.value) || state.salePsf; render(container, state); });
      exitDl.appendChild(row('Sale price ($/SF)', '', { node: psfInp, info: INFO.salePsf }));
    }
    exitDl.appendChild(row(isHold ? 'Implied value (@ cap)' : 'Exit value', fmt$(c.exitValue), { strong: true, sep: true, info: isHold ? INFO.impliedValue : INFO.exitValue }));
    container.appendChild(exitSec);

    // ── Multi-year hold & exit (hold only) ──
    // Mortgage-financed hold: yearly cash flow at growing rents, sale at exit →
    // IRR / equity multiple / cash-on-cash — the metrics investors screen with.
    if (isHold && h10) {
      const { wrap: hSec, dl: hDl } = dlSection(`${h10.N}-year hold & exit`);

      const yrsInp = numInput(state.holdYears, { min: 2, max: 30, step: 1 });
      yrsInp.addEventListener('change', () => { state.holdYears = parseInt(yrsInp.value) || state.holdYears; render(container, state); });
      hDl.appendChild(row('Hold period (years)', '', { node: yrsInp, info: INFO.holdYears }));

      const growInp = numInput(fmtPctInput(state.rentGrowth), { min: 0, max: 10, step: 0.5 });
      growInp.addEventListener('change', () => { state.rentGrowth = (parseFloat(growInp.value) || 0) / 100; render(container, state); });
      hDl.appendChild(row('Rent growth (%/yr)', '', { node: growInp, info: INFO.rentGrowth }));

      const xcapInp = numInput(fmtPctInput(state.exitCap), { min: 1, max: 15, step: 0.25 });
      xcapInp.addEventListener('change', () => { state.exitCap = (parseFloat(xcapInp.value) || 0) / 100; render(container, state); });
      hDl.appendChild(row('Exit cap rate (%)', '', { node: xcapInp, info: INFO.exitCap }));

      const ltvInp = numInput(Math.round(state.ltv * 100), { min: 0, max: 90, step: 5 });
      ltvInp.addEventListener('change', () => { state.ltv = (parseFloat(ltvInp.value) || 0) / 100; render(container, state); });
      hDl.appendChild(row('Loan-to-value (%)', '', { node: ltvInp, info: INFO.ltv }));

      const mrateInp = numInput(state.mortRate, { min: 1, max: 15, step: 0.25 });
      mrateInp.addEventListener('change', () => { state.mortRate = parseFloat(mrateInp.value) || state.mortRate; render(container, state); });
      hDl.appendChild(row('Mortgage rate (%)', '', { node: mrateInp, info: INFO.mortRate }));

      hDl.appendChild(row('Mortgage loan', fmt$(h10.loan), { indent: true, info: INFO.mortLoan }));
      hDl.appendChild(row('Equity invested', fmt$(h10.equity0), { indent: true, info: INFO.equityIn }));
      hDl.appendChild(row('Annual debt service', fmt$(h10.ads), { indent: true, info: INFO.debtService }));
      hDl.appendChild(row('Cash-on-cash (yr 1)', fmtPct(h10.coc1), { info: INFO.cashOnCash }));
      hDl.appendChild(row('DSCR (yr 1)', h10.dscr1 != null ? h10.dscr1.toFixed(2) + '×' : '—', { info: INFO.dscr }));
      hDl.appendChild(row(`Net sale proceeds (yr ${h10.N})`, fmt$(h10.saleNet), { sep: true, info: INFO.saleProceeds }));
      hDl.appendChild(row('IRR (levered)', fmtPct(h10.irrVal), { strong: true, info: INFO.irr }));
      hDl.appendChild(row('Equity multiple', isFinite(h10.equityMult) ? h10.equityMult.toFixed(2) + '×' : '—', { strong: true, info: INFO.equityMult }));

      // Depreciation tax shield — screening estimate, only when TCAD gives us a
      // land/building split to base the depreciable basis on.
      if (h10.annualDep != null) {
        const braInp = numInput(Math.round(state.taxBracket * 100), { min: 0, max: 50, step: 1 });
        braInp.addEventListener('change', () => { state.taxBracket = (parseFloat(braInp.value) || 0) / 100; render(container, state); });
        hDl.appendChild(row('Tax bracket (%)', '', { node: braInp, sep: true, info: INFO.taxBracket }));
        hDl.appendChild(row('Depreciation deduction (/yr)', fmt$(h10.annualDep), { indent: true, info: INFO.depreciation }));
        hDl.appendChild(row('Est. tax shield (/yr)', fmt$(h10.taxShield), { indent: true, info: INFO.taxShield }));
      }
      container.appendChild(hSec);
    }

    // ── Returns ──
    const { wrap: retSec, dl: retDl } = dlSection('Returns');
    if (isResidual) {
      const tgtInp = numInput(fmtPctInput(state.targetRoc != null ? state.targetRoc : 0.15), { min: 0, max: 100, step: 1 });
      tgtInp.addEventListener('change', () => { state.targetRoc = (parseFloat(tgtInp.value) || 0) / 100; render(container, state); });
      retDl.appendChild(row('Target return on cost (%)', '', { node: tgtInp, info: INFO.targetRoc }));
      retDl.appendChild(row('Residual land value', fmt$(c.residualLand), { strong: true, info: INFO.residualLand }));
      if (state.tcadLandVal) {
        const ratio = state.tcadLandVal > 0 ? c.residualLand / state.tcadLandVal : null;
        retDl.appendChild(row('vs TCAD land value',
          `${fmt$(state.tcadLandVal)}${ratio != null ? ` (${fmtPct(ratio)})` : ''}`, { indent: true, info: INFO.vsTcadLand }));
      }
      retDl.appendChild(row('At current land cost:', '', { sep: true }));
      retDl.appendChild(row('  Profit / (loss)', fmt$(c.profit), { indent: true, info: INFO.profit }));
      retDl.appendChild(row('  Return on cost', fmtPct(c.retOnCost), { indent: true, info: INFO.roc }));
    } else if (isHold) {
      retDl.appendChild(row('Annual NOI (cash flow)', fmt$(c.noi), { strong: true, info: INFO.annualNoi }));
      retDl.appendChild(row('Yield on value', fmtPct(c.yieldUnlev), { info: INFO.yieldOnValue }));
      retDl.appendChild(row('Implied value vs basis', fmt$(c.profit), { info: INFO.valueVsBasis }));
    } else {
      retDl.appendChild(row('Profit / (loss)', fmt$(c.profit), { strong: true, info: INFO.profit }));
      retDl.appendChild(row('Return on cost', fmtPct(c.retOnCost), { info: INFO.roc }));
      retDl.appendChild(row('Return on equity', fmtPct(c.retOnEquity), { info: INFO.roe }));
      if (c.yieldUnlev != null) retDl.appendChild(row('Unleveraged yield', fmtPct(c.yieldUnlev), { info: INFO.yieldU }));
    }
    const headline = isResidual ? c.residualLand : (isHold ? c.noi : c.profit);
    const profitClass = headline > 0 ? 'feasibility-positive' : headline < 0 ? 'feasibility-negative' : '';
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

    // Proof-of-concept framing: defaults are generic, so most scenarios show a
    // loss until tailored to a real deal. Hover any ⓘ for what a line means.
    const poc = document.createElement('p');
    poc.className = 'feasibility-poc-note';
    poc.innerHTML = '<b>Screening estimate.</b> Figures use generic cost and interest-rate ' +
      'assumptions with neighborhood market $/sqft and rent — a starting point, not an appraisal. ' +
      'Every tinted input is editable; tailor them to a real deal. Hover the ' +
      '<b>ⓘ</b> on any line for what it means.';
    outer.appendChild(poc);

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
    const lotSqft      = envelope?.lot_sqft     || 0;
    const floorAreaMax = Math.round(envelope?.max_far_sqft || envelope?.buildable_sqft || 0);
    const maxUnits     = envelope?.max_units    ?? null;

    // Neighborhood market context (Redfin sale $/sqft + Zillow ZORI rent) by ZIP,
    // fetched by app.js. Texas is non-disclosure, so these aggregate medians are
    // the best available defaults for Sale price and Rent (override the generics).
    const mkt        = window.AG?.lastPanelData?.market;
    const hasMkt     = mkt && mkt.status === 'ok';
    const medRent    = (hasMkt && mkt.zori_rent) ? Math.round(mkt.zori_rent)
                     : (demographics?.median_gross_rent || 1800);
    const salePsfSeed = (hasMkt && mkt.median_sale_ppsf) ? Math.round(mkt.median_sale_ppsf) : 280;

    // Appraisal values (from the row app.js stashed) seed scenario defaults.
    const appr       = window.AG?.lastPanelData?.dbRow || {};
    const landVal    = appr.appr_land_val    || 0;
    const marketVal  = appr.appr_market_val  || 0;
    const livingSqft = appr.appr_living_sqft || 0;
    const zoningBase = envelope?.zoning_base || appr.zoning_base || '';

    // Realistic floor-area program: units × typical unit size, capped by the FAR
    // maximum. Falls back to the FAR max when units or unit size are unknown
    // (commercial/mixed). Keeps the seeded build from defaulting to a huge overbuild.
    function programFloor(typoKey) {
      const us = UNIT_SF[typoKey];
      if (maxUnits && us) return Math.min(maxUnits * us, floorAreaMax || maxUnits * us);
      return floorAreaMax;
    }

    // Existing-building unit count for the Hold scenario: a single-family / small
    // building is one rental; a larger multifamily building is ~living ÷ 1,000 SF.
    function holdUnits() {
      if (/^SF/i.test(zoningBase) || (livingSqft || 0) <= 2500) return 1;
      return Math.max(1, Math.round((livingSqft || 0) / 1000));
    }

    const state = {
      scenario: 'by_right',
      mode: 'build',
      typology: typo,
      lotSqft,
      floorArea: programFloor(typo.key),
      units: maxUnits ?? 1,
      landCost: landVal,
      costPerSqft: Math.round((typo.hardMin + typo.hardMax) / 2),
      softPct: typo.softPct,
      contingencyPct: 0.05,
      holdMonths: 18,
      constrRate: parseFloat(((rates.prime || 7.5) + 2).toFixed(2)),
      ltc: 0.70,
      // Commercial/MF with no unit count can't be modeled as a 1-unit rental —
      // exit on for-sale $/sqft instead (avoids the degenerate single-unit NOI).
      useType: maxUnits == null ? 'sale' : typo.defUse,
      capRate: DEFAULT_CAP[typo.key],
      rentPerUnit: medRent,
      vacancyPct: 0.05,
      expensePct: 0.35,
      salePsf: salePsfSeed,
      targetRoc: 0.15,
      tcadLandVal: landVal,
      rates,
      // Multi-year hold model (Hold scenario). Exit cap defaults 50bps above the
      // going-in cap (a conservative standard); mortgage from the live FRED 30-yr.
      holdYears: 10,
      rentGrowth: 0.03,
      exitCap: DEFAULT_CAP.sf + 0.005,
      ltv: 0.70,
      mortRate: parseFloat((rates.mortgage30 || 6.5).toFixed(2)),
      taxBracket: 0.32,
      // Building share of value (depreciable basis split) from TCAD's own
      // land/improvement ratio; null hides the depreciation lines.
      imprShare: (marketVal > 0 && appr.appr_impr_val > 0) ? appr.appr_impr_val / marketVal : null,
    };

    // Densest typology the unit count allows (for the Max-density scenario).
    function densestTypology(units) {
      if (units >= 5) return TYPOLOGIES.find(t => t.key === 'small_mf');
      if (units >= 2) return TYPOLOGIES.find(t => t.key === 'duplex');
      return TYPOLOGIES[0];
    }

    function seedFromTypology(t) {
      state.typology = t;
      state.costPerSqft = Math.round((t.hardMin + t.hardMax) / 2);
      state.softPct = t.softPct;
      state.capRate = DEFAULT_CAP[t.key];
      state.useType = t.defUse;
    }

    // ── Scenario presets (seed `state`, set mode) ──
    const SCENARIOS = [
      { key: 'by_right', label: 'By-right' },
      { key: 'max_home', label: 'Max density' },
      { key: 'hold',     label: 'Hold as-is' },
      { key: 'residual', label: 'Residual land' },
    ];
    const SCEN_DESC = {
      by_right: 'Tear down and rebuild what the zoning allows by right. Land basis = TCAD land value.',
      max_home: 'Build the most units the lot allows (including HOME rules), at the densest building type.',
      hold:     'Keep and rent the existing building — no construction. Models a mortgage-financed multi-year hold: yearly cash flow, then a sale at exit → IRR and equity multiple.',
      residual: 'Works backwards: the most you could pay for the land and still hit your target return.',
    };

    function applyScenario(key) {
      state.scenario = key;
      if (key === 'hold') {
        state.mode = 'hold';
        state.floorArea = livingSqft || floorAreaMax || 0;
        state.units = holdUnits();   // multi-unit buildings rent more than one unit
        state.costPerSqft = 0;
        state.landCost = marketVal || 0;
        state.useType = 'rental';
        state.capRate = DEFAULT_CAP.sf;
        state.rentPerUnit = medRent;
      } else if (key === 'max_home') {
        state.mode = 'build';
        const dt = densestTypology(maxUnits ?? 1);
        seedFromTypology(dt);
        state.units = maxUnits ?? 1;
        state.floorArea = programFloor(dt.key);
        state.landCost = landVal;
        if (maxUnits == null) state.useType = 'sale';
      } else if (key === 'residual') {
        state.mode = 'residual';
        seedFromTypology(typo);
        state.units = maxUnits ?? 1;
        state.floorArea = programFloor(typo.key);
        state.landCost = landVal;
        if (maxUnits == null) state.useType = 'sale';
      } else { // by_right
        state.mode = 'build';
        seedFromTypology(typo);
        state.units = maxUnits ?? 1;
        state.floorArea = programFloor(typo.key);
        state.landCost = landVal;
        if (maxUnits == null) state.useType = 'sale';
      }
    }

    // Scenario selector (reuses typology-button styling for a consistent look).
    const scenWrap = document.createElement('div');
    scenWrap.className = 'feasibility-typo-selector';
    const scenLabel = document.createElement('span');
    scenLabel.className = 'feasibility-typo-label';
    scenLabel.textContent = 'Scenario:';
    scenWrap.appendChild(scenLabel);

    // Building-type selector (build / residual only; hidden for hold).
    const typoWrap = document.createElement('div');
    typoWrap.className = 'feasibility-typo-selector';
    const typoLabel = document.createElement('span');
    typoLabel.className = 'feasibility-typo-label';
    typoLabel.textContent = 'Building type:';
    typoWrap.appendChild(typoLabel);

    // Plain-language description of the selected scenario.
    const scenDesc = document.createElement('p');
    scenDesc.className = 'feasibility-scen-desc';

    // Editable-cells legend.
    const legend = document.createElement('p');
    legend.className = 'feasibility-legend';
    legend.innerHTML = '<b>Tinted cells</b> are editable — change any assumption to update the numbers.';

    const contentDiv = document.createElement('div');

    function syncChrome() {
      scenWrap.querySelectorAll('.feasibility-typo-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.scen === state.scenario);
      });
      typoWrap.querySelectorAll('.feasibility-typo-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.typo === state.typology.key);
      });
      typoWrap.style.display = state.mode === 'hold' ? 'none' : '';
      scenDesc.textContent = SCEN_DESC[state.scenario] || '';
    }

    SCENARIOS.forEach(sc => {
      const btn = document.createElement('button');
      btn.className = 'feasibility-typo-btn' + (sc.key === 'by_right' ? ' active' : '');
      btn.dataset.scen = sc.key;
      btn.textContent = sc.label;
      btn.addEventListener('click', () => {
        applyScenario(sc.key);
        syncChrome();
        render(contentDiv, state);
      });
      scenWrap.appendChild(btn);
    });

    TYPOLOGIES.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'feasibility-typo-btn' + (t.key === typo.key ? ' active' : '');
      btn.dataset.typo = t.key;
      btn.textContent = t.label;
      btn.addEventListener('click', () => {
        seedFromTypology(t);
        syncChrome();
        render(contentDiv, state);
      });
      typoWrap.appendChild(btn);
    });

    outer.appendChild(scenWrap);
    outer.appendChild(scenDesc);
    outer.appendChild(typoWrap);
    outer.appendChild(legend);
    outer.appendChild(contentDiv);
    syncChrome();
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
