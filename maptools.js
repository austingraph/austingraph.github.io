(function () {
  var map = window.AG.map;
  var draw;
  var measuring = false;
  var measurePts = [];
  var contourDemSource;

  // Contour source must be set up before map load
  if (window.mlcontour) {
    contourDemSource = new mlcontour.DemSource({
      url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
      encoding: "terrarium",
      maxzoom: 14,
    });
    contourDemSource.setupMapLibre(maplibregl);
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

    map.addControl({
      onAdd: function () {
        this._container = document.createElement("div");
        this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
        this._btn = document.createElement("button");
        this._btn.className = "satellite-btn";
        this._btn.textContent = "Satellite";
        var self = this;
        this._btn.onclick = function () {
          var on = map.getLayoutProperty("satellite-layer", "visibility") === "visible";
          map.setLayoutProperty("satellite-layer", "visibility", on ? "none" : "visible");
          self._btn.classList.toggle("active", !on);
        };
        this._container.appendChild(this._btn);
        return this._container;
      },
      onRemove: function () { this._container.parentNode.removeChild(this._container); }
    }, "top-left");
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

  // ── Topo overlay (contour lines) ─────────────────────────────────────────────

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

    map.addControl({
      onAdd: function () {
        this._container = document.createElement("div");
        this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
        var lbl = document.createElement("label");
        lbl.className = "overlay-ctrl-label";
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.addEventListener("change", function () {
          var vis = this.checked ? "visible" : "none";
          if (map.getLayer("contour-lines")) map.setLayoutProperty("contour-lines", "visibility", vis);
          if (map.getLayer("contour-labels")) map.setLayoutProperty("contour-labels", "visibility", vis);
          map.setTerrain({ source: "terrain-dem", exaggeration: this.checked ? 2 : 1 });
        });
        var span = document.createElement("span");
        span.textContent = "Topo";
        lbl.appendChild(checkbox);
        lbl.appendChild(span);
        this._container.appendChild(lbl);
        return this._container;
      },
      onRemove: function () { this._container.parentNode.removeChild(this._container); }
    }, "bottom-left");
  }

  // ── Buildings toggle ──────────────────────────────────────────────────────────

  function initBuildingsToggle() {
    var buildingLayers = map.getStyle().layers
      .filter(function (l) { return l.id.includes("building"); })
      .map(function (l) { return l.id; });
    if (map.getLayer("3d-buildings")) buildingLayers.push("3d-buildings");

    map.addControl({
      onAdd: function () {
        this._container = document.createElement("div");
        this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
        var lbl = document.createElement("label");
        lbl.className = "overlay-ctrl-label";
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = true;
        checkbox.addEventListener("change", function () {
          var vis = this.checked ? "visible" : "none";
          buildingLayers.forEach(function (id) {
            if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
          });
        });
        var span = document.createElement("span");
        span.textContent = "Buildings";
        lbl.appendChild(checkbox);
        lbl.appendChild(span);
        this._container.appendChild(lbl);
        return this._container;
      },
      onRemove: function () { this._container.parentNode.removeChild(this._container); }
    }, "bottom-left");
  }

  // ── Layers panel (flyout) ────────────────────────────────────────────────────

  function initLayersPanel() {
    var layersPanelEl;
    map.addControl({
      onAdd: function () {
        this._container = document.createElement("div");
        this._container.className = "maplibregl-ctrl maplibregl-ctrl-group layers-ctrl";

        var btn = document.createElement("button");
        btn.className = "satellite-btn layers-btn";
        btn.textContent = "Layers";
        btn.setAttribute("aria-label", "Toggle overlay layers");

        layersPanelEl = document.createElement("div");
        layersPanelEl.className = "layers-panel";

        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          layersPanelEl.classList.toggle("open");
        });

        this._container.appendChild(btn);
        this._container.appendChild(layersPanelEl);
        return this._container;
      },
      onRemove: function () { this._container.parentNode.removeChild(this._container); }
    }, "top-left");

    document.addEventListener("click", function (e) {
      if (layersPanelEl && !e.target.closest(".layers-ctrl")) {
        layersPanelEl.classList.remove("open");
      }
    });
  }

  // ── Overlay layers (lazy-loaded) ─────────────────────────────────────────────

  function addOverlayControl(geojsonPath, sourceId, label, colorProperty) {
    var panel = document.querySelector(".layers-panel");
    if (!panel) return;

    var lbl = document.createElement("label");
    lbl.className = "overlay-ctrl-label";
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    var span = document.createElement("span");
    span.textContent = label;
    lbl.appendChild(checkbox);
    lbl.appendChild(span);
    panel.appendChild(lbl);

    var loaded = false;
    checkbox.addEventListener("change", async function () {
      if (!loaded) {
        checkbox.disabled = true;
        span.textContent = label + " (loading…)";
        try {
          var res = await fetch(geojsonPath);
          var data = await res.json();

          var palette = ["#4285f4","#ea4335","#fbbc04","#34a853","#ff6d00","#46bdc6","#7b1fa2","#f06292"];
          var colorExpr = "#4285f4";

          if (colorProperty) {
            var uniqueVals = [...new Set(data.features.map(function (f) { return f.properties[colorProperty]; }))];
            var matchExpr = ["match", ["get", colorProperty]];
            uniqueVals.forEach(function (val, i) { matchExpr.push(val, palette[i % palette.length]); });
            matchExpr.push("#888");
            colorExpr = matchExpr;
          }

          var firstLabelLayer = map.getStyle().layers.find(function (l) {
            return l.type === "symbol" && l.layout && l.layout["text-field"];
          });
          var beforeLayer = firstLabelLayer ? firstLabelLayer.id : undefined;

          map.addSource(sourceId, { type: "geojson", data: data });
          map.addLayer({ id: sourceId + "-fill", type: "fill", source: sourceId,
            layout: { visibility: "none" },
            paint: { "fill-color": colorExpr, "fill-opacity": 0.2 }
          }, beforeLayer);
          map.addLayer({ id: sourceId + "-line", type: "line", source: sourceId,
            layout: { visibility: "none" },
            paint: { "line-color": colorExpr, "line-width": 1.5 }
          }, beforeLayer);
          if (colorProperty) {
            map.addLayer({ id: sourceId + "-labels", type: "symbol", source: sourceId,
              layout: {
                visibility: "none",
                "text-field": ["get", colorProperty],
                "text-size": 11,
                "text-font": ["Open Sans Semibold", "Arial Unicode MS Regular"],
                "text-max-width": 8
              },
              paint: { "text-color": "#222", "text-halo-color": "#fff", "text-halo-width": 1.5 }
            }, beforeLayer);
          }

          loaded = true;
        } catch (e) {
          console.error("Overlay load error:", sourceId, e);
          span.textContent = label + " (error)";
          checkbox.disabled = false;
          return;
        }
        span.textContent = label;
        checkbox.disabled = false;
      }

      var vis = this.checked ? "visible" : "none";
      map.setLayoutProperty(sourceId + "-fill", "visibility", vis);
      map.setLayoutProperty(sourceId + "-line", "visibility", vis);
      if (colorProperty && map.getLayer(sourceId + "-labels")) {
        map.setLayoutProperty(sourceId + "-labels", "visibility", vis);
      }
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
    initBuildingsToggle();
    initLayersPanel();
    OVERLAYS.forEach(function (ov, i) {
      addOverlayControl(ov.file, "overlay" + i, ov.label, ov.colorProperty);
    });
    initDraw();
    initMeasure();
  });
})();
