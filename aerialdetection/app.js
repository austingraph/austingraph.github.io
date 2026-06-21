/* Aerial Compliance Detection — landing dashboard.
 *
 * Renders the sample findings from data/results.sample.json. This is a static
 * preview: once the pipeline writes real results to Supabase, swap the fetch
 * URL for the results endpoint (or a generated results.json baked at build
 * time by the GitHub Action). Degrades gracefully when opened from file://,
 * where fetch() of a local path is blocked by the browser.
 */
(function () {
  "use strict";

  const SEV_ORDER = { high: 0, medium: 1, low: 2 };
  const resultsEl = document.getElementById("results");
  const statusEl = document.getElementById("results-status");
  const metaEl = document.getElementById("data-meta");

  fetch("data/results.sample.json")
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(render)
    .catch((err) => {
      statusEl.textContent =
        "Sample data couldn't load (" + err.message +
        "). View it directly at data/results.sample.json.";
    });

  function render(doc) {
    const parcels = (doc.parcels || []).slice().sort(
      (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]
    );
    statusEl.textContent =
      parcels.length + " sample parcels · imagery " + (doc.imagery_vintage || "—");
    if (doc.generated_by) metaEl.textContent = "writeups: " + doc.generated_by;

    resultsEl.innerHTML = "";
    parcels.forEach((p) => resultsEl.appendChild(card(p)));
  }

  function card(p) {
    const el = document.createElement("article");
    el.className = "card";

    const metrics = (p.metrics || [])
      .map((m) => `<span class="metric"><b>${esc(m.value)}</b> ${esc(m.label)}</span>`)
      .join("");

    el.innerHTML = `
      <div class="card-top">
        <div>
          <div class="card-id">${esc(p.parcel_id)}</div>
          <div class="card-addr">${esc(p.address || "")}</div>
        </div>
        <span class="sev sev-${esc(p.severity)}">${esc(p.severity)}</span>
      </div>
      <div class="card-issue">${esc(p.issue)}</div>
      <div class="metrics">${metrics}</div>
      <div class="card-writeup">${esc(p.writeup || "")}</div>
      <div class="card-foot">
        <span>${esc(p.capture_date || "")}</span>
        <span class="confidence">confidence ${Math.round((p.confidence || 0) * 100)}%</span>
      </div>`;
    return el;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
})();
