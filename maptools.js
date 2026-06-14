(function () {
  var map = window.AG.map;
  var draw;
  var measuring = false;
  var measurePts = [];
  var contourDemSource;
  var buildingLayers = [];

  // Contour source must be set up before map load. Guarded so any CDN/API
  // issue degrades to "no Topo" instead of taking down the whole toolbar.
  if (window.mlcontour) {
    try {
      contourDemSource = new mlcontour.DemSource({
        url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
        encoding: "terrarium",
        maxzoom: 14,
      });
      contourDemSource.setupMaplibre(maplibregl);
    } catch (e) {
      console.warn("maplibre-contour setup failed; Topo disabled:", e);
      contourDemSource = undefined;
    }
  }

  var OVERLAYS = [
    { label: "Zip Codes",    file: "/shared/SecondData.geojson",        colorProperty: "zipcode"       },
    { label: "Flood Zone",   file: "/shared/floodzone.geojson",         colorProperty: "flood_zone"    },
    { label: "City Council", file: "/shared/Council_Districts.geojson", colorProperty: "district_name" },
  ];

  // ── Satellite ────────────────────────────────────────────────────────────────

  function initSatellite() {
    map.addSource("satellite", {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      attribution: "Tiles &copy; Esri"
    });
    map.addLayer({
      id: "satellite-layer",
      type: "raster",
      source: "satellite",
      layout: { visibility: "none" }
    }, map.getStyle().layers[1].id);
  }

  // ── Terrain + hillshade (always on) ─────────────────────────────────────────

  function initDefaultTerrain() {
    map.addSource("terrain-dem", {
      type: "raster-dem",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      tileSize: 256,
      encoding: "terrarium",
      maxzoom: 14
    });
    map.addLayer({
      id: "hillshade-layer",
      type: "hillshade",
      source: "terrain-dem",
      layout: { visibility: "visible" },
      paint: {
        "hillshade-shadow-color": "#473B24",
        "hillshade-highlight-color": "#ffffff",
        "hillshade-accent-color": "#5a714c",
        "hillshade-illumination-direction": 335,
        "hillshade-exaggeration": 0.3
      }
    });
    function enableTerrain() {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1 });
    }
    if (map.isSourceLoaded("terrain-dem")) {
      enableTerrain();
    } else {
      map.on("sourcedata", function onDemReady(e) {
        if (e.sourceId === "terrain-dem" && map.isSourceLoaded("terrain-dem")) {
          map.off("sourcedata", onDemReady);
          enableTerrain();
        }
      });
    }
  }

  // ── Topo overlay (contour lines — layers only, no control) ──────────────────

  function initTopoOverlay() {
    if (!contourDemSource) return;
    map.addSource("contour-source", {
      type: "vector",
      tiles: [contourDemSource.contourProtocolUrl({
        multiplier: 3.28084,
        overzoom: 1,
        thresholds: {
          11: [200, 1000],
          12: [100, 500],
          13: [100, 500],
          14: [50, 200],
          15: [20, 100]
        },
        elevationKey: "ele",
        levelKey: "level",
        contourLayer: "contours"
      })],
      maxzoom: 15
    });
    map.addLayer({
      id: "contour-lines",
      type: "line",
      source: "contour-source",
      "source-layer": "contours",
      layout: { visibility: "none" },
      paint: {
        "line-color": "#5a3a1a",
        "line-opacity": 0.7,
        "line-width": ["match", ["get", "level"], 1, 2, 0.8]
      }
    });
    map.addLayer({
      id: "contour-labels",
      type: "symbol",
      source: "contour-source",
      "source-layer": "contours",
      filter: [">", ["get", "level"], 0],
      layout: {
        visibility: "none",
        "symbol-placement": "line",
        "text-size": 12,
        "text-field": ["concat", ["number-format", ["get", "ele"], {}], "'"],
        "text-font": ["Noto Sans Regular"]
      },
      paint: {
        "text-color": "#5a3a1a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.5
      }
    });
  }

  // ── Buildings (layers only, no control) ──────────────────────────────────────

  function initBuildingsLayers() {
    buildingLayers = map.getStyle().layers
      .filter(function (l) { return l.id.includes("building"); })
      .map(function (l) { return l.id; });
    if (map.getLayer("3d-buildings")) buildingLayers.push("3d-buildings");
    buildingLayers.forEach(function (id) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
    });
  }

  // ── Right-side map tools panel ───────────────────────────────────────────────

  function initMapPanel() {
    var panel = document.createElement("div");
    panel.id = "map-tools-panel";

    var tab = document.createElement("button");
    tab.id = "map-tools-tab";
    tab.setAttribute("aria-label", "Toggle map tools");
    tab.innerHTML = "&#8249;"; // ‹

    var content = document.createElement("div");
    content.id = "map-tools-content";

    panel.appendChild(tab);
    panel.appendChild(content);
    document.body.appendChild(panel);

    tab.addEventListener("click", function () {
      var open = panel.classList.toggle("open");
      tab.innerHTML = open ? "&#8250;" : "&#8249;"; // › when open, ‹ when closed
    });

    function addHeading(text) {
      var h = document.createElement("div");
      h.className = "tools-panel-heading";
      h.textContent = text;
      content.appendChild(h);
    }

    function addCheckbox(labelText, onChange) {
      var lbl = document.createElement("label");
      lbl.className = "tools-panel-label";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      var span = document.createElement("span");
      span.textContent = labelText;
      lbl.appendChild(cb);
      lbl.appendChild(span);
      content.appendChild(lbl);
      cb.addEventListener("change", onChange);
      return { cb: cb, span: span };
    }

    // Base map section
    addHeading("Base map");

    addCheckbox("Satellite", function () {
      map.setLayoutProperty("satellite-layer", "visibility", this.checked ? "visible" : "none");
    });

    addCheckbox("Topo", function () {
      var vis = this.checked ? "visible" : "none";
      if (map.getLayer("contour-lines"))  map.setLayoutProperty("contour-lines",  "visibility", vis);
      if (map.getLayer("contour-labels")) map.setLayoutProperty("contour-labels", "visibility", vis);
      map.setTerrain({ source: "terrain-dem", exaggeration: this.checked ? 2 : 1 });
    });

    addCheckbox("Buildings", function () {
      var vis = this.checked ? "visible" : "none";
      buildingLayers.forEach(function (id) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
      });
    });

    // Overlays section
    var sep = document.createElement("hr");
    sep.className = "tools-panel-sep";
    content.appendChild(sep);
    addHeading("Overlays");

    OVERLAYS.forEach(function (ov, i) {
      var sourceId = "overlay" + i;
      var loaded = false;
      var refs = addCheckbox(ov.label, function () { /* wired below */ });
      var cb = refs.cb, span = refs.span;

      cb.addEventListener("change", async function () {
        if (!loaded) {
          cb.disabled = true;
          span.textContent = ov.label + " (loading…)";
          try {
            var res = await fetch(ov.file);
            var data = await res.json();

            var palette = ["#4285f4","#ea4335","#fbbc04","#34a853","#ff6d00","#46bdc6","#7b1fa2","#f06292"];
            var colorExpr = "#4285f4";
            if (ov.colorProperty) {
              var uniqueVals = [...new Set(data.features.map(function (f) { return f.properties[ov.colorProperty]; }))];
              var matchExpr = ["match", ["get", ov.colorProperty]];
              uniqueVals.forEach(function (val, idx) { matchExpr.push(val, palette[idx % palette.length]); });
              matchExpr.push("#888");
              colorExpr = matchExpr;
            }
            var firstLabel = map.getStyle().layers.find(function (l) {
              return l.type === "symbol" && l.layout && l.layout["text-field"];
            });
            var beforeLayer = firstLabel ? firstLabel.id : undefined;

            map.addSource(sourceId, { type: "geojson", data: data });
            map.addLayer({ id: sourceId + "-fill", type: "fill", source: sourceId,
              layout: { visibility: "none" },
              paint: { "fill-color": colorExpr, "fill-opacity": 0.35 }
            }, beforeLayer);
            map.addLayer({ id: sourceId + "-line", type: "line", source: sourceId,
              layout: { visibility: "none" },
              paint: { "line-color": "#222", "line-width": 2, "line-opacity": 0.85 }
            }, beforeLayer);
            if (ov.colorProperty) {
              map.addLayer({ id: sourceId + "-labels", type: "symbol", source: sourceId,
                layout: {
                  visibility: "none",
                  "text-field": ["get", ov.colorProperty],
                  "text-size": 13,
                  "text-font": ["Noto Sans Regular"],
                  "text-max-width": 8
                },
                paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 2 }
              }, beforeLayer);
            }

            // Fit map to show the overlay on first enable
            var minLon=Infinity, maxLon=-Infinity, minLat=Infinity, maxLat=-Infinity;
            data.features.forEach(function(f) {
              var walk = function(c) {
                if (typeof c[0]==='number') {
                  if (c[0]<minLon) minLon=c[0]; if (c[0]>maxLon) maxLon=c[0];
                  if (c[1]<minLat) minLat=c[1]; if (c[1]>maxLat) maxLat=c[1];
                } else { c.forEach(walk); }
              };
              if (f.geometry) walk(f.geometry.coordinates);
            });
            if (minLon!==Infinity) {
              map.fitBounds([[minLon,minLat],[maxLon,maxLat]], { padding: 40, duration: 800, maxZoom: 14 });
            }

            loaded = true;
          } catch (e) {
            console.error("Overlay load error:", sourceId, e);
            span.textContent = ov.label + " (error)";
            cb.disabled = false;
            return;
          }
          span.textContent = ov.label;
          cb.disabled = false;
        }

        var vis = this.checked ? "visible" : "none";
        map.setLayoutProperty(sourceId + "-fill", "visibility", vis);
        map.setLayoutProperty(sourceId + "-line", "visibility", vis);
        if (ov.colorProperty && map.getLayer(sourceId + "-labels")) {
          map.setLayoutProperty(sourceId + "-labels", "visibility", vis);
        }
      });
    });
  }

  // ── Draw (terra-draw) ────────────────────────────────────────────────────────

  function initDraw() {
    var TD = window.terraDraw;
    var TDA = window.terraDrawMaplibreGlAdapter;
    if (!TD || !TDA) return;

    draw = new TD.TerraDraw({
      adapter: new TDA.TerraDrawMapLibreGLAdapter({ map: map, lib: maplibregl }),
      modes: [new TD.TerraDrawLineStringMode()]
    });
    draw.start();

    document.querySelectorAll("[data-draw-mode]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        measuring = false;
        map.getCanvas().style.cursor = "";
        var measureBtn = document.getElementById("measureBtn");
        if (measureBtn) measureBtn.classList.remove("active");
        draw.setMode(btn.dataset.drawMode);
        document.querySelectorAll("[data-draw-mode]").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
      });
    });

    var clearBtn = document.getElementById("clearDrawBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        draw.clear();
        document.querySelectorAll("[data-draw-mode]").forEach(function (b) { b.classList.remove("active"); });
      });
    }
  }

  // ── Measure ──────────────────────────────────────────────────────────────────

  function initMeasure() {
    map.addSource("measure-pts",  { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addSource("measure-line", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

    map.addLayer({ id: "measure-line-layer", type: "line", source: "measure-line",
      paint: { "line-color": "#e63946", "line-width": 2, "line-dasharray": [3, 2] } });
    map.addLayer({ id: "measure-pts-layer", type: "circle", source: "measure-pts",
      paint: { "circle-radius": 5, "circle-color": "#e63946", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
    map.addLayer({ id: "measure-labels-layer", type: "symbol", source: "measure-pts",
      layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, -1.2], "text-anchor": "bottom" },
      paint: { "text-color": "#222", "text-halo-color": "#fff", "text-halo-width": 2 } });

    function haversine(a, b) {
      var R = 3958.8, toRad = function (x) { return x * Math.PI / 180; };
      var dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
      var x = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng/2) * Math.sin(dLng/2);
      return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    }

    function redraw() {
      var total = 0;
      map.getSource("measure-pts").setData({ type: "FeatureCollection", features: measurePts.map(function (pt, i) {
        if (i > 0) total += haversine(measurePts[i - 1], pt);
        return { type: "Feature", geometry: { type: "Point", coordinates: pt },
          properties: { label: i === 0 ? "Start" : (total.toFixed(2) + " mi") } };
      })});
      map.getSource("measure-line").setData({ type: "FeatureCollection",
        features: measurePts.length > 1 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: measurePts } }] : [] });
    }

    function clearMeasure() { measurePts = []; redraw(); }

    map.on("click", function (e) {
      if (!measuring) return;
      measurePts.push([e.lngLat.lng, e.lngLat.lat]);
      redraw();
    });

    var measureBtn = document.getElementById("measureBtn");
    if (measureBtn) {
      measureBtn.addEventListener("click", function () {
        measuring = !measuring;
        measureBtn.classList.toggle("active", measuring);
        map.getCanvas().style.cursor = measuring ? "crosshair" : "";
        if (measuring && draw) {
          draw.setMode("static");
          document.querySelectorAll("[data-draw-mode]").forEach(function (b) { b.classList.remove("active"); });
        }
      });
    }

    var clearBtn = document.getElementById("clearDrawBtn");
    if (clearBtn) clearBtn.addEventListener("click", clearMeasure);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────

  map.on("load", function () {
    initSatellite();
    initDefaultTerrain();
    initTopoOverlay();
    initBuildingsLayers();
    initMapPanel();
    initDraw();
    initMeasure();
  });
})();
