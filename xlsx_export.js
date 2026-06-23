// austingraph.chat — Excel export for the Parcel Report
// window.AG.exportReport() assembles a multi-sheet .xlsx workbook from the data
// already cached on window.AG (lastPanelData.dbRow, lastEnvelope,
// lastPanelData.demographics, feasibilityState). The Feasibility sheet is built
// with LIVE Excel formulas so a user can edit any assumption in Excel and have
// cost / NOI / profit / returns recalculate.
//
// Depends on SheetJS (XLSX global, loaded from CDN in index.html).

(() => {
  const Z_MONEY = '$#,##0';
  const Z_NUM   = '#,##0';
  const Z_PCT   = '0.0%';
  const Z_PSF   = '$#,##0.00';

  // ── Cell builders ─────────────────────────────────────────────────────────
  const money   = (v) => v == null ? null : { t: 'n', v: Math.round(v), z: Z_MONEY };
  const num     = (v) => v == null ? null : { t: 'n', v, z: Z_NUM };
  const pct     = (v) => v == null ? null : { t: 'n', v, z: Z_PCT };          // v is a fraction
  const psf     = (v) => v == null ? null : { t: 'n', v, z: Z_PSF };
  const text    = (v) => v == null ? null : { t: 's', v: String(v) };
  const fml     = (f, z) => ({ t: 'n', f, z });

  // Build a worksheet from a 2-D array of cells (primitives or {t,...} objects).
  function makeSheet(rows, colWidths) {
    const ws = {};
    let maxC = 0;
    rows.forEach((row, i) => {
      (row || []).forEach((cell, j) => {
        if (cell == null) return;
        const addr = XLSX.utils.encode_cell({ r: i, c: j });
        ws[addr] = (typeof cell === 'object')
          ? cell
          : { t: typeof cell === 'number' ? 'n' : 's', v: cell };
        if (j > maxC) maxC = j;
      });
    });
    ws['!ref'] = XLSX.utils.encode_range({ r: 0, c: 0 }, { r: Math.max(0, rows.length - 1), c: maxC });
    ws['!cols'] = (colWidths || [26, 18, 18, 18, 18]).map((w) => ({ wch: w }));
    return ws;
  }

  // ── Lot size helper (sq ft) ─────────────────────────────────────────────────
  function lotSqft(data) {
    const acres = parseFloat(data?.dbRow?.metadata?.tcad_acres) || 0;
    if (acres > 0) return acres * 43560;
    const m2 = data?.stats?.areaM2 || 0;
    return m2 * 10.7639104;
  }

  // ── Summary sheet ────────────────────────────────────────────────────────────
  function summarySheet(data) {
    const row  = data.dbRow || {};
    const meta = row.metadata || {};
    const s    = data.stats || {};
    const FT2  = 10.7639104, AC = 4046.8564224;
    const rows = [
      [text('PARCEL SUMMARY')],
      [],
      [text('TCAD Property ID'), text(data.parcelId)],
      [text('Address'),          text(meta.situs_address || '—')],
      [text('Legal'),            text(meta.legal_desc || '—')],
      [text('Geo ID'),           text(meta.geo_id || '—')],
      [text('TCAD acres'),       meta.tcad_acres != null ? num(Number(meta.tcad_acres)) : null],
      [],
      [text('Lot area (sq ft)'), s.areaM2 ? num(Math.round(s.areaM2 * FT2)) : null],
      [text('Lot area (acres)'), s.areaM2 ? { t: 'n', v: +(s.areaM2 / AC).toFixed(3), z: '0.000' } : null],
      [text('Width (ft)'),       s.widthM ? num(Math.round(s.widthM * 3.280839895)) : null],
      [text('Depth (ft)'),       s.heightM ? num(Math.round(s.heightM * 3.280839895)) : null],
      [],
      [text('Future land use'),  text(row.flum_label || (row.flum_code != null ? `Code ${row.flum_code}` : '—'))],
      [text('Current zoning'),   text(row.zoning_ztype || row.zoning_base || '—')],
      [text('Owner'),            text(row.appr_owner_name || '—')],
      [],
      [text('Generated'),        text(new Date().toLocaleDateString('en-US'))],
      [text('Source'),           text('Travis CAD appraisal roll · austingraph.chat')],
    ];
    return makeSheet(rows, [26, 40]);
  }

  // ── Appraisal & Tax sheet (static values + derived ratios) ───────────────────
  function appraisalSheet(data) {
    const row     = data.dbRow || {};
    const labels  = window.AG.EXEMPTION_LABELS || {};
    const taxRate = window.AG.APPROX_TAX_RATE || 0.02;
    const market  = row.appr_market_val, land = row.appr_land_val, impr = row.appr_impr_val;
    const assessed = row.appr_assessed_val;
    const lot      = lotSqft(data);
    const taxBase  = assessed || market;
    const estTax   = taxBase != null ? Math.round(taxBase * taxRate) : null;
    const codes    = Array.isArray(row.appr_exemptions) ? row.appr_exemptions : [];
    const thisYear = new Date().getFullYear();

    const rows = [
      [text('APPRAISAL & TAX')],
      [],
      [text('Market value'),       money(market)],
      [text('Land value'),         money(land)],
      [text('Improvement value'),  money(impr)],
      [text('Assessed value'),     money(assessed)],
      [text('Taxable value'),      money(row.appr_taxable_val)],
      [text('Exemptions'),         text(codes.length ? codes.map((c) => labels[c] || c).join(', ') : 'None')],
      [],
      [text('DERIVED SIGNALS')],
      [text(`Est. annual tax (~${(taxRate * 100).toFixed(1)}%)`), money(estTax)],
      [text('Tax as % of market'), (estTax != null && market) ? pct(estTax / market) : null],
      [text('Land share of value'),(land && market) ? pct(land / market) : null],
      [text('Land $/sqft'),        (land && lot > 0) ? psf(land / lot) : null],
      [text('Building $/sqft'),    (impr && row.appr_living_sqft) ? psf(impr / row.appr_living_sqft) : null],
      [text('Year built'),         row.appr_yr_built ? num(row.appr_yr_built) : null],
      [text('Improvement age (yrs)'), row.appr_yr_built ? num(thisYear - row.appr_yr_built) : null],
      [text('Living area (sq ft)'),row.appr_living_sqft ? num(row.appr_living_sqft) : null],
      [text('Owner'),              text(row.appr_owner_name || '—')],
      [text('Owner state'),        text(row.appr_owner_state || '—')],
      [text('Absentee owner'),     text(row.appr_owner_state && row.appr_owner_state !== 'TX' ? 'Yes' : 'No')],
      [text('Roll year'),          row.appr_data_yr ? num(row.appr_data_yr) : null],
    ];
    return makeSheet(rows, [28, 18]);
  }

  // ── Development potential sheet ───────────────────────────────────────────────
  function envelopeSheet(env) {
    if (!env || env.status !== 'ok') {
      return makeSheet([[text('DEVELOPMENT POTENTIAL')], [], [text('No zoning envelope (county/ETJ parcel or rules unavailable).')]], [34, 18]);
    }
    const sb = env.setbacks_ft || {};
    const rows = [
      [text('DEVELOPMENT POTENTIAL')],
      [],
      [text('Zoning'),             text(env.zoning_ztype + (env.variant === 'home_small_lot' ? ' · small-lot (HOME)' : ''))],
      [text('Front setback (ft)'),       sb.front != null ? num(sb.front) : null],
      [text('Street-side setback (ft)'), sb.street_side != null ? num(sb.street_side) : null],
      [text('Interior-side setback (ft)'), sb.interior_side != null ? num(sb.interior_side) : null],
      [text('Rear setback (ft)'),        sb.rear != null ? num(sb.rear) : null],
      [text('Buildable footprint (sq ft)'), env.buildable_sqft != null ? num(Math.round(env.buildable_sqft)) : null],
      [text('Max floor area / FAR (sq ft)'), env.max_far_sqft != null ? num(Math.round(env.max_far_sqft)) : null],
      [text('FAR ratio'),          env.max_far != null ? num(env.max_far) : null],
      [text('Max impervious (sq ft)'), env.max_impervious_sqft != null ? num(Math.round(env.max_impervious_sqft)) : null],
      [text('Impervious cap (%)'), env.max_impervious_pct != null ? num(env.max_impervious_pct) : null],
      [text('Max height (ft)'),    env.max_height_ft != null ? num(env.max_height_ft) : null],
      [text('Max units'),          env.max_units != null ? num(env.max_units) : null],
    ];
    return makeSheet(rows, [34, 18]);
  }

  // ── Neighborhood sheet (reuses shared lens mapping) ──────────────────────────
  function neighborhoodSheet(demo) {
    if (!demo) {
      return makeSheet([[text('NEIGHBORHOOD')], [], [text('Census data not available for this parcel.')]], [28, 22]);
    }
    const cfg = (window.AG.demographicsRows && window.AG.demographicsRows(demo)) || { title: 'Neighborhood', rows: [] };
    const rows = [[text(cfg.title.toUpperCase())], []];
    cfg.rows.forEach(([label, value]) => rows.push([text(label), text(value)]));
    return makeSheet(rows, [28, 22]);
  }

  // ── Feasibility sheet (LIVE Excel formulas) ──────────────────────────────────
  function feasibilitySheet(state) {
    if (!state) {
      return makeSheet([[text('DEVELOPMENT FEASIBILITY')], [], [text('Open a parcel with a zoning envelope to populate the pro forma.')]], [28, 18]);
    }
    const rental = state.useType === 'rental';
    const rows = [];
    const ref = {};
    // push a [label, valueCell] row; record the value cell's address under `name`.
    const put = (label, cell, name) => {
      rows.push([label == null ? null : text(label), cell]);
      if (name) ref[name] = `B${rows.length}`; // value cell is column B, row = rows.length
    };
    const head = (t) => rows.push([text(t)]);

    head('DEVELOPMENT FEASIBILITY');
    put(`Scenario`, text(state.typology ? state.typology.label : 'Custom'));
    put(`Use type`, text(rental ? 'Rental (income)' : 'For-sale'));
    rows.push([]);

    head('SITE');
    put('Lot area (sq ft)', num(Math.round(state.lotSqft || 0)), 'LOT');
    put('Buildable floor area (sq ft)', num(Math.round(state.floorArea || 0)), 'FLOOR');
    put('Max units', num(state.units || 0), 'UNITS');
    rows.push([]);

    head('USES (COSTS)');
    put('Land / acquisition', money(state.landCost || 0), 'LAND');
    put('Hard cost ($/SF)', psf(state.costPerSqft || 0), 'HARDPSF');
    put('Hard cost total', fml(`${ref.FLOOR}*${ref.HARDPSF}`, Z_MONEY), 'HARD');
    put('Soft costs (%)', pct(state.softPct || 0), 'SOFTPCT');
    put('Soft cost total', fml(`${ref.HARD}*${ref.SOFTPCT}`, Z_MONEY), 'SOFT');
    put('Contingency (%)', pct(state.contingencyPct || 0), 'CONTPCT');
    put('Contingency', fml(`(${ref.HARD}+${ref.SOFT})*${ref.CONTPCT}`, Z_MONEY), 'CONT');
    put('Construction hold (months)', num(state.holdMonths || 0), 'HOLD');
    put('Construction rate (%)', pct((state.constrRate || 0) / 100), 'CRATE');
    put('Loan-to-cost (%)', pct(state.ltc || 0), 'LTC');
    put('Construction loan', fml(`(${ref.HARD}+${ref.SOFT}+${ref.CONT})*${ref.LTC}`, Z_MONEY), 'LOAN');
    put('Financing cost', fml(`${ref.LOAN}*${ref.CRATE}*(${ref.HOLD}/12)`, Z_MONEY), 'FIN');
    put('Total project cost', fml(`${ref.LAND}+${ref.HARD}+${ref.SOFT}+${ref.CONT}+${ref.FIN}`, Z_MONEY), 'TOTAL');
    put('Equity required', fml(`${ref.LAND}+(${ref.HARD}+${ref.SOFT}+${ref.CONT})*(1-${ref.LTC})+${ref.FIN}`, Z_MONEY), 'EQUITY');
    rows.push([]);

    head('EXIT / INCOME');
    if (rental) {
      put('Rent / unit / month', money(state.rentPerUnit || 0), 'RENT');
      put('Vacancy (%)', pct(state.vacancyPct || 0), 'VAC');
      put('Operating expenses (%)', pct(state.expensePct || 0), 'EXP');
      put('Gross rent (annual)', fml(`${ref.UNITS}*${ref.RENT}*12`, Z_MONEY), 'GROSS');
      put('Effective gross income', fml(`${ref.GROSS}*(1-${ref.VAC})`, Z_MONEY), 'EGI');
      put('Net operating income', fml(`${ref.EGI}*(1-${ref.EXP})`, Z_MONEY), 'NOI');
      put('Cap rate (%)', pct(state.capRate || 0), 'CAP');
      put('Exit value', fml(`IF(${ref.CAP}>0,${ref.NOI}/${ref.CAP},0)`, Z_MONEY), 'EXIT');
    } else {
      put('Sale price ($/SF)', psf(state.salePsf || 0), 'SALEPSF');
      put('Exit value', fml(`${ref.FLOOR}*${ref.SALEPSF}`, Z_MONEY), 'EXIT');
    }
    rows.push([]);

    head('RETURNS');
    put('Profit / (loss)', fml(`${ref.EXIT}-${ref.TOTAL}`, Z_MONEY), 'PROFIT');
    put('Return on cost', fml(`IF(${ref.TOTAL}>0,(${ref.EXIT}-${ref.TOTAL})/${ref.TOTAL},"")`, Z_PCT));
    put('Return on equity', fml(`IF(${ref.EQUITY}>0,(${ref.EXIT}-${ref.TOTAL})/${ref.EQUITY},"")`, Z_PCT));
    if (rental) put('Unleveraged yield', fml(`IF(${ref.TOTAL}>0,${ref.NOI}/${ref.TOTAL},"")`, Z_PCT));
    rows.push([]);
    rows.push([text('Screening estimate only — not investment advice. Edit any input (column B) to recalculate.')]);

    return makeSheet(rows, [28, 16]);
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  function exportReport() {
    if (typeof XLSX === 'undefined') {
      alert('Excel library still loading — please try again in a moment.');
      return;
    }
    const data = window.AG?.lastPanelData;
    if (!data) { alert('Select a parcel first.'); return; }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, summarySheet(data),              'Summary');
    XLSX.utils.book_append_sheet(wb, appraisalSheet(data),           'Appraisal & Tax');
    XLSX.utils.book_append_sheet(wb, envelopeSheet(window.AG.lastEnvelope), 'Development');
    XLSX.utils.book_append_sheet(wb, feasibilitySheet(window.AG.feasibilityState), 'Feasibility');
    XLSX.utils.book_append_sheet(wb, neighborhoodSheet(data.demographics), 'Neighborhood');

    XLSX.writeFile(wb, `feasibility_${data.parcelId}.xlsx`);
  }

  window.AG.exportReport = exportReport;
})();
