(() => {
  if (window.__randoshopperLoaded) return;
  window.__randoshopperLoaded = true;

  const DEFAULT_PADDING = 1500;
  const SIMPLIFY_TOLERANCE_M = 25;
  const MAX_POINTS = 150;
  // The backend example payload lists coordinates as [lat, lon].
  const PAYLOAD_LAT_FIRST = true;

  const SHELTER_EXCLUDED_TYPES = new Set(["public_transport", "bus_stop", "lean_to_bus"]);
  const CATEGORIES = [
    { id: "beach", label: "Beaches", icon: "🏖️", color: "#f2c94c", test: (t) => t.natural === "beach" || t.leisure === "beach_resort" || t.leisure === "swimming_area" },
    { id: "bike", label: "Bike shops", icon: "🚲", color: "#2d9cdb", test: (t) => t.shop === "bicycle" },
    { id: "camp", label: "Camp sites", icon: "⛺", color: "#27ae60", test: (t) => t.tourism === "camp_site" },
    { id: "convenience", label: "Convenience stores", icon: "🏪", color: "#9b51e0", test: (t) => t.shop === "convenience" },
    { id: "water", label: "Drinking water", icon: "🚰", color: "#56ccf2", test: (t) => t.amenity === "drinking_water" || t.man_made === "water_tap" },
    { id: "fastfood", label: "Fast food", icon: "🍔", color: "#eb5757", test: (t) => t.amenity === "fast_food" },
    { id: "foodcourt", label: "Food courts", icon: "🍱", color: "#f2994a", test: (t) => t.amenity === "food_court" },
    { id: "fuel", label: "Fuel stations", icon: "⛽", color: "#4f4f4f", test: (t) => t.amenity === "fuel" },
    { id: "grave", label: "Grave yards", icon: "🪦", color: "#828282", test: (t) => t.amenity === "grave_yard" || t.landuse === "cemetery" },
    { id: "hotel", label: "Hotels", icon: "🏨", color: "#bb6bd9", test: (t) => t.tourism === "hotel" },
    { id: "icecream", label: "Ice cream", icon: "🍦", color: "#ff80ab", test: (t) => t.amenity === "ice_cream" || t.shop === "ice_cream" },
    { id: "kiosk", label: "Kiosks", icon: "🛒", color: "#e67e22", test: (t) => t.shop === "kiosk" },
    { id: "cafe", label: "Coffee shops", icon: "☕", color: "#8d6e63", test: (t) => t.amenity === "cafe" },
    { id: "pharmacy", label: "Pharmacies", icon: "💊", color: "#e74c3c", test: (t) => t.amenity === "pharmacy" },
    { id: "pub", label: "Pubs", icon: "🍺", color: "#d4a017", test: (t) => t.amenity === "pub" },
    { id: "restaurant", label: "Restaurants", icon: "🍽️", color: "#c0392b", test: (t) => t.amenity === "restaurant" },
    { id: "shelter", label: "Shelters", icon: "🛖", color: "#6d4c41", test: (t) => (t.amenity === "shelter" && !SHELTER_EXCLUDED_TYPES.has(t.shelter_type)) || t.tourism === "wilderness_hut" || t.tourism === "alpine_hut" },
    { id: "supermarket", label: "Supermarkets", icon: "🛍️", color: "#16a085", test: (t) => t.shop === "supermarket" },
    { id: "vending", label: "Vending machines", icon: "🥤", color: "#7f8c8d", test: (t) => t.amenity === "vending_machine" },
  ];

  const state = {
    map: null,
    route: null,
    routeSig: null,
    routeSource: null,
    networkRoute: null,
    items: [],
    hidden: false,
    enabled: new Set(), // empty = no filtering
    padding: DEFAULT_PADDING,
    busy: false,
    auto: false,
    only24h: false,
    nameQuery: "",
    lastSearchedSig: null,
    debounce: null,
  };
  window.randoshopper = state;

  // ---------- geometry helpers ----------
  function simplify(route) {
    const lat0 = route[0][1] * (Math.PI / 180);
    const kx = 111320 * Math.cos(lat0);
    const ky = 110540;
    const pts = route.map(([lon, lat]) => [lon * kx, lat * ky]);
    const dp = (tol) => {
      const keep = new Uint8Array(pts.length);
      keep[0] = keep[pts.length - 1] = 1;
      const stack = [[0, pts.length - 1]];
      while (stack.length) {
        const [a, b] = stack.pop();
        let maxD = 0, idx = -1;
        const [ax, ay] = pts[a], [bx, by] = pts[b];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        for (let i = a + 1; i < b; i++) {
          let t = len2 ? ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy));
          if (d > maxD) { maxD = d; idx = i; }
        }
        if (maxD > tol && idx > 0) {
          keep[idx] = 1;
          stack.push([a, idx], [idx, b]);
        }
      }
      return route.filter((_, i) => keep[i]);
    };
    let tol = SIMPLIFY_TOLERANCE_M;
    let out = dp(tol);
    while (out.length > MAX_POINTS) { tol *= 1.5; out = dp(tol); }
    return out;
  }

  function dedupe(route) {
    const out = [];
    for (const p of route) {
      const q = out[out.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
    }
    return out;
  }

  function signature(route) {
    const m = route[Math.floor(route.length / 2)];
    return [route.length, route[0], m, route[route.length - 1]].join("|");
  }

  // ---------- finding the map ----------
  const isMap = (o) =>
    o && typeof o === "object" && typeof o.project === "function" && typeof o.unproject === "function" &&
    typeof o.getStyle === "function" && typeof o.on === "function";

  function asMap(o) {
    if (!o || typeof o !== "object") return null;
    if (isMap(o)) return o;
    try {
      if (typeof o.getMap === "function") { const m = o.getMap(); if (isMap(m)) return m; }
      if (isMap(o.current)) return o.current;
      if (o.current && typeof o.current.getMap === "function") { const m = o.current.getMap(); if (isMap(m)) return m; }
      if (isMap(o._map)) return o._map;
      if (isMap(o.map)) return o.map;
    } catch (_) { /* ignore */ }
    return null;
  }

  function findMapInFiberTree(rootFiber) {
    const stack = [rootFiber];
    let visited = 0;
    while (stack.length && visited++ < 200000) {
      const f = stack.pop();
      if (!f) continue;
      const candidates = [f.stateNode, f.ref, f.memoizedProps && Object.values(f.memoizedProps)];
      const flat = [];
      for (const c of candidates) Array.isArray(c) ? flat.push(...c) : flat.push(c);
      let h = f.memoizedState;
      let guard = 0;
      while (h && typeof h === "object" && guard++ < 50) {
        flat.push(h.memoizedState);
        if (h.queue) flat.push(h.queue.lastRenderedState);
        h = h.next;
      }
      for (const c of flat) {
        const m = asMap(c);
        if (m) return m;
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  }

  function isRealMap(m) {
    try {
      return isMap(m) && typeof m.getSource === "function" && typeof m.getCanvas === "function" &&
        typeof m.getContainer === "function" && m.getContainer() instanceof Element;
    } catch (_) { return false; }
  }

  // Mapbox's Evented does `this._listeners = this._listeners || {}` in on(), so an
  // inherited setter sees every evented object, including the map itself.
  (function hookEventedCapture() {
    Object.defineProperty(Object.prototype, "_listeners", {
      configurable: true,
      get() { return undefined; },
      set(v) {
        Object.defineProperty(this, "_listeners", { value: v, writable: true, configurable: true, enumerable: true });
        try {
          if (!state.capturedMap && isRealMap(this)) {
            state.capturedMap = this;
            delete Object.prototype._listeners;
          }
        } catch (_) { /* ignore */ }
      },
    });
  })();

  // Mapbox GL binds its event handlers to the map instance in the constructor.
  (function hookMapCapture() {
    const origBind = Function.prototype.bind;
    Function.prototype.bind = function (thisArg, ...rest) {
      try {
        if (!state.capturedMap && thisArg && typeof thisArg === "object" && isRealMap(thisArg)) {
          state.capturedMap = thisArg;
        }
      } catch (_) { /* ignore */ }
      return origBind.call(this, thisArg, ...rest);
    };
  })();

  // Last resort: look for a map object on window, on the map DOM elements and one level below.
  function scanForMap() {
    const seenObjs = new Set();
    const check = (o) => {
      if (!o || (typeof o !== "object" && typeof o !== "function") || seenObjs.has(o)) return null;
      seenObjs.add(o);
      const m = asMap(o);
      return isRealMap(m) ? m : null;
    };
    const roots = [window, ...document.querySelectorAll(".mapboxgl-map, .maplibregl-map, canvas")];
    for (const root of roots) {
      let keys = [];
      try { keys = Object.getOwnPropertyNames(root); } catch (_) { /* ignore */ }
      for (const k of keys) {
        let v;
        try { v = root[k]; } catch (_) { continue; }
        let m = check(v);
        if (m) return m;
        if (v && typeof v === "object" && !(v instanceof Node)) {
          let sub = [];
          try { sub = Object.getOwnPropertyNames(v).slice(0, 80); } catch (_) { /* ignore */ }
          for (const s of sub) {
            try { m = check(v[s]); } catch (_) { continue; }
            if (m) return m;
          }
        }
      }
    }
    return null;
  }

  function findMap() {
    if (state.capturedMap) return state.capturedMap;
    if (document.querySelector(".mapboxgl-map, .maplibregl-map")) return scanForMap();
    return null;
  }


  // ---------- reading the route ----------
  function lineCoords(geom, out) {
    if (!geom) return;
    if (geom.type === "LineString") out.push(...geom.coordinates);
    else if (geom.type === "MultiLineString") geom.coordinates.forEach((l) => out.push(...l));
    else if (geom.type === "GeometryCollection") geom.geometries.forEach((g) => lineCoords(g, out));
  }

  function geojsonLine(data) {
    const out = [];
    if (!data || typeof data !== "object") return out;
    if (data.type === "FeatureCollection") data.features.forEach((f) => lineCoords(f.geometry, out));
    else if (data.type === "Feature") lineCoords(data.geometry, out);
    else lineCoords(data, out);
    return out.map((c) => [c[0], c[1]]);
  }

  function routeFromMap(map) {
    let style;
    try { style = map.getStyle(); } catch (_) { return null; }
    if (!style) return null;
    const re = /route|track|plan|line/i;
    const reSkip = /record|completed|highlight|hover|poi|label|arrow|cap|casing|outline|halo|heatmap|segment|waypoint|cue/i;
    let best = null;
    for (const layer of style.layers || []) {
      if (layer.type !== "line" || !layer.source) continue;
      if (reSkip.test(layer.id)) continue;
      const nameMatch = re.test(layer.id) || re.test(layer.source);
      const src = map.getSource(layer.source);
      if (!src || src.type !== "geojson") continue; // basemap vector layers are never the route
      let data = src._data;
      if (!data && typeof src.serialize === "function") data = src.serialize().data;
      let coords = data && typeof data === "object" ? geojsonLine(data) : [];
      if (!coords.length) {
        try {
          const feats = map.querySourceFeatures(layer.source);
          const out = [];
          feats.forEach((f) => lineCoords(f.geometry, out));
          coords = out.map((c) => [c[0], c[1]]);
        } catch (_) { /* ignore */ }
      }
      if (coords.length > 1 && (!best || coords.length > best.coords.length)) {
        best = { coords, layer: layer.id };
      }
    }
    return best;
  }

  // Fallback: capture route geometry from the site's own API responses.
  function extractFromJson(root) {
    let best = [];
    const seen = new Set();
    const num = (v) => typeof v === "number" && isFinite(v);
    const visit = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 12 || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) {
        if (o.length > best.length && o.length > 1) {
          const f = o[0];
          let pts = null;
          if (f && num(f.lat) && (num(f.lng) || num(f.lon))) pts = o.map((p) => [p.lng ?? p.lon, p.lat]);
          else if (f && num(f.x) && num(f.y)) pts = o.map((p) => [p.x, p.y]);
          else if (f && f.location && num(f.location.lat) && num(f.location.lng)) pts = o.map((p) => [p.location.lng, p.location.lat]);
          else if (Array.isArray(f) && f.length >= 2 && num(f[0]) && num(f[1]) && o.every((p) => Array.isArray(p) && num(p[0]) && num(p[1]))) pts = o.map((p) => [p[0], p[1]]);
          if (pts && pts.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90)) best = pts;
        }
        o.forEach((v) => visit(v, depth + 1));
      } else {
        if (o.type && (o.coordinates || o.features || o.geometry)) {
          const g = geojsonLine(o);
          if (g.length > best.length) best = g;
        }
        Object.values(o).forEach((v) => visit(v, depth + 1));
      }
    };
    visit(root, 0);
    return best;
  }

  function hookNetwork() {
    const handle = (url, text) => {
      const looksJson = !!text && (text[0] === "{" || text[0] === "[");
      const relevant = (/trailmap/.test(url) || url.startsWith("/")) && /rout|track|plan|direction|path/i.test(url);
      if (relevant && looksJson) {
        try {
          const pts = extractFromJson(JSON.parse(text));
          if (pts.length > 10) state.networkRoute = pts;
        } catch (_) { /* ignore */ }
      }
    };
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const url = String(args[0]?.url || args[0]);
        p.then((r) => r.clone().text().then((t) => handle(url, t)).catch(() => {})).catch(() => {});
      } catch (_) { /* ignore */ }
      return p;
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.addEventListener("load", () => {
        try { if (this.responseType === "" || this.responseType === "text") handle(String(url), this.responseText); } catch (_) { /* ignore */ }
      });
      return origOpen.call(this, method, url, ...rest);
    };
  }
  hookNetwork();

  function currentRoute() {
    if (state.map) {
      const r = routeFromMap(state.map);
      if (r) return r;
      return null;
    }
    if (state.networkRoute) return { coords: state.networkRoute, layer: "network" };
    return null;
  }

  // ---------- backend ----------
  let reqId = 0;
  function callBackend(payload) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      const timer = setTimeout(() => { window.removeEventListener("message", onMsg); reject(new Error("Timed out")); }, 60000);
      function onMsg(ev) {
        if (ev.source !== window || ev.data?.type !== "randoshopper-response" || ev.data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        ev.data.ok ? resolve(ev.data.data) : reject(new Error(ev.data.error));
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ type: "randoshopper-request", id, payload }, "*");
    });
  }

  function centroid(geom) {
    if (geom.type === "Point") return geom.coordinates;
    let ring;
    if (geom.type === "MultiPolygon") ring = geom.coordinates[0][0];
    else if (geom.type === "Polygon") ring = geom.coordinates[0];
    else if (geom.type === "LineString") ring = geom.coordinates;
    else if (geom.type === "MultiPoint") ring = geom.coordinates;
    if (!ring || !ring.length) return null;
    let x = 0, y = 0;
    ring.forEach((c) => { x += c[0]; y += c[1]; });
    return [x / ring.length, y / ring.length];
  }

  function toItems(geojson) {
    const items = [];
    const seen = new Set();
    for (const f of geojson.features || []) {
      const tags = f.properties?.tags || {};
      const cat = CATEGORIES.find((c) => c.test(tags));
      if (!cat || !f.geometry) continue;
      const pos = centroid(f.geometry);
      if (!pos) continue;
      const key = `${f.properties?.osm_id}|${cat.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ cat, pos, tags });
    }
    return items;
  }

  async function search() {
    if (state.busy) { state.rerun = true; return; }
    const r = currentRoute();
    if (!r) { return; }
    const route = dedupe(r.coords);
    if (route.length < 2) { return; }
    state.busy = true; setSpin(true);
    const sig = signature(route) + "|" + routeLength();
    try {
      const simplified = simplify(route).map(([lon, lat]) => [+(PAYLOAD_LAT_FIRST ? lat : lon).toFixed(6), +(PAYLOAD_LAT_FIRST ? lon : lat).toFixed(6)]);
      const payload = {
        route: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: simplified } },
        searchAreaPadding: state.padding,
      };
      const data = await callBackend(payload);
      state.items = toItems(data);
      state.lastSearchedSig = sig;
      setStatus();
      renderMarkers();
      renderPanelCounts();
    } catch (_) { /* leave previous results */ } finally {
      state.busy = false; setSpin(false);
      if (state.rerun) { state.rerun = false; search(); }
    }
  }

  // ---------- markers ----------
  let overlay = null;
  let popup = null;
  let markerEls = [];

  function ensureOverlay() {
    if (!state.map) return false;
    const container = state.map.getCanvasContainer ? state.map.getCanvasContainer() : state.map.getContainer();
    if (overlay && overlay.parentNode === container) return true;
    overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:1000;";
    // Keep the map (route hover/drag handling) from seeing events meant for our markers and popups.
    ["mousemove", "mouseover", "mouseout", "mouseup", "pointerdown", "pointermove", "pointerup", "touchstart", "touchmove", "dblclick", "contextmenu"].forEach((n) => overlay.addEventListener(n, (e) => e.stopPropagation()));
    container.appendChild(overlay);
    state.map.on("move", positionMarkers);
    state.map.on("resize", positionMarkers);
    state.map.on("click", closePopup);
    return true;
  }

  function injectStyles() {
    if (document.getElementById("rs-styles")) return;
    const st = document.createElement("style");
    st.id = "rs-styles";
    st.textContent = `
      .rs-panel, .rs-popup { font-family: Roboto, Helvetica, Arial, sans-serif; color: rgba(0,0,0,.87); }
      .rs-panel { font-size: 1rem; line-height: 1.5; }
      .rs-header { box-sizing: border-box; min-height: 48px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; font-size: 1rem; }
      .rs-header:hover { background: rgba(0,0,0,.04); }
      .rs-arrow { color: rgba(0,0,0,.54); }
      .rs-body { padding: 0 16px 16px; }
      .rs-status { font-size: .875rem; line-height: 1.43; color: rgba(0,0,0,.6); margin-bottom: 8px; }
      .rs-section { font-size: .875rem; font-weight: 500; line-height: 1.57; margin: 12px 0 4px; }
      .rs-btn { font: 500 .8125rem/1.75 Roboto, Helvetica, Arial, sans-serif; letter-spacing: .02857em; text-transform: uppercase; padding: 3px 9px; min-width: 64px; color: #2e7d32; background: transparent; border: 1px solid rgba(46,125,50,.5); border-radius: 4px; cursor: pointer; transition: background-color .25s, border-color .25s; }
      .rs-btn:hover { background: rgba(46,125,50,.04); border-color: #2e7d32; }
      .rs-input { box-sizing: border-box; width: 72px; height: 32px; padding: 0 8px; font: 400 .875rem Roboto, Helvetica, Arial, sans-serif; color: rgba(0,0,0,.87); background: transparent; border: 1px solid rgba(0,0,0,.23); border-radius: 4px; }
      .rs-input:hover { border-color: rgba(0,0,0,.87); }
      .rs-input:focus { outline: none; border-color: #2e7d32; box-shadow: 0 0 0 1px #2e7d32; }
      .rs-check { display: flex; align-items: center; gap: 8px; padding: 2px 0; cursor: pointer; font-size: .875rem; line-height: 1.43; }
      .rs-check input, .rs-body input[type=checkbox] { accent-color: #2e7d32; width: 16px; height: 16px; margin: 0; }
      .rs-count { color: rgba(0,0,0,.6); }
      .rs-popup { box-sizing: border-box; background: #fff; border-radius: 4px; padding: 12px 36px 12px 16px; font-size: .875rem; line-height: 1.43; box-shadow: 0 5px 5px -3px rgba(0,0,0,.2), 0 8px 10px 1px rgba(0,0,0,.14), 0 3px 14px 2px rgba(0,0,0,.12); }
      .rs-title { font-size: 1rem; font-weight: 500; line-height: 1.5; }
      .rs-sub { color: rgba(0,0,0,.6); margin-bottom: 8px; }
      .rs-close { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; line-height: 24px; text-align: center; border-radius: 50%; font-size: 14px; color: rgba(0,0,0,.54); cursor: pointer; }
      .rs-close:hover { background: rgba(0,0,0,.04); }
      .rs-links { margin-top: 8px; display: flex; gap: 16px; flex-wrap: wrap; }
      .rs-links a { color: #2e7d32; text-decoration: none; font-weight: 500; }
      .rs-links a:hover { text-decoration: underline; }
    `;
    document.head.appendChild(st);
  }
  function showPopup(item, el) {
    closePopup();
    const t = item.tags;
    popup = document.createElement("div");
    injectStyles();
    popup.className = "rs-popup";
    popup.style.cssText = "position:absolute;transform:translate(-50%,-130%);width:max-content;min-width:200px;max-width:340px;pointer-events:auto;z-index:10;";
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    let html = `<div class="rs-title">${esc(t.name || item.cat.label)}</div><span data-close class="rs-close">✕</span>`;
    if (t.name) html += `<div class="rs-sub">${esc(item.cat.label)}</div>`;
    if (t.opening_hours) html += `<div><b>Opening hours:</b> ${esc(t.opening_hours)}</div>`;
    if (t["opening_hours:drive_through"]) html += `<div><b>Drive-through:</b> ${esc(t["opening_hours:drive_through"])}</div>`;
    if (t.phone) html += `<div><b>Phone:</b> ${esc(t.phone)}</div>`;
    let site = t.website || t["contact:website"] || t.url;
    if (site && !/^https?:\/\//i.test(site)) site = /^[\w-]+(\.[\w-]+)+/.test(site) ? "https://" + site : null;
    const links = [];
    if (site) links.push(`<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">Website</a>`);
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${item.pos[1]},${item.pos[0]}`;
    links.push(`<a href="${gmaps}" target="_blank" rel="noopener noreferrer">Google Maps</a>`);
    html += `<div style="margin-top:8px"><b>More information</b></div><div class="rs-links" style="display:flex;flex-direction:column;gap:2px;">${links.join("")}</div>`;
    popup.innerHTML = html;
    popup.querySelector("[data-close]").addEventListener("click", (e) => { e.stopPropagation(); closePopup(); });
    popup.addEventListener("click", (e) => e.stopPropagation());
    popup.addEventListener("mousedown", (e) => e.stopPropagation());
    popup.dataset.lon = item.pos[0];
    popup.dataset.lat = item.pos[1];
    overlay.appendChild(popup);
    positionMarkers();
  }

  function closePopup() {
    if (popup) { popup.remove(); popup = null; }
  }

  function renderMarkers() {
    if (!ensureOverlay()) return;
    closePopup();
    markerEls.forEach((m) => m.el.remove());
    markerEls = [];
    const frag = document.createDocumentFragment();
    for (const item of state.hidden ? [] : state.items) {
      if (state.enabled.size && !state.enabled.has(item.cat.id)) continue;
      if (state.nameQuery && !String(item.tags.name || "").toLowerCase().includes(state.nameQuery)) continue;
      if (state.only24h && !["opening_hours", "opening_hours:drive_through"].some((k) => String(item.tags[k] || "").trim() === "24/7")) continue;
      const el = document.createElement("div");
      el.textContent = item.cat.icon;
      el.title = item.tags.name ? `${item.tags.name} (${item.cat.label})` : item.cat.label;
      el.style.cssText = `position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:${item.cat.color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;cursor:pointer;pointer-events:auto;user-select:none;`;
      el.addEventListener("click", (e) => { e.stopPropagation(); showPopup(item, el); });
      el.addEventListener("mousedown", (e) => e.stopPropagation());
      frag.appendChild(el);
      markerEls.push({ el, item });
    }
    overlay.appendChild(frag);
    positionMarkers();
  }

  function positionMarkers() {
    if (!state.map || !overlay) return;
    for (const { el, item } of markerEls) {
      const p = state.map.project(item.pos);
      el.style.transform = `translate(${p.x}px,${p.y}px)`;
    }
    if (popup) {
      const p = state.map.project([+popup.dataset.lon, +popup.dataset.lat]);
      popup.style.left = "0";
      popup.style.top = "0";
      popup.style.transform = `translate(${p.x}px,${p.y}px) translate(-50%,-130%)`;
    }
  }

  // ---------- panel ----------
  let panel, statusEl, countsEls = {};
  let logoEl = null;
  function setSpin(on) {
    if (!document.getElementById("rs-spin-style")) {
      const st = document.createElement("style");
      st.id = "rs-spin-style";
      st.textContent = "@keyframes rs-spin{to{transform:rotate(360deg)}}";
      (document.head || document.documentElement).appendChild(st);
    }
    if (logoEl) logoEl.style.animation = on ? "rs-spin 1s linear infinite" : "";
  }

  function setStatus() { if (statusEl) statusEl.textContent = `${state.items.length} places found`; }

  function renderPanelCounts() {
    const counts = {};
    state.items.forEach((i) => { counts[i.cat.id] = (counts[i.cat.id] || 0) + 1; });
    CATEGORIES.forEach((c) => { if (countsEls[c.id]) countsEls[c.id].textContent = counts[c.id] || 0; });
  }

  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement("div");
    const siteAcc = document.querySelector(".MuiDrawer-paper .MuiAccordion-root");
    if (siteAcc) panel.className = siteAcc.className;
    injectStyles();
    panel.classList.add("rs-panel");
    panel.style.cssText = "box-sizing:border-box;width:100%;";
    const header = document.createElement("div");
    header.className = "rs-header";
    const arrow = document.createElement("span");
    arrow.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" style="display:block;transition:transform .2s;transform:rotate(180deg)"><path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z"></path></svg>';
    arrow.className = "rs-arrow";
    const title = document.createElement("span");
    title.style.cssText = "display:flex;align-items:center;gap:6px;";
    const logoUrl = document.documentElement.dataset.randoshopperLogo;
    if (logoUrl) {
      const img = document.createElement("img");
      logoEl = img; img.src = logoUrl; img.alt = ""; img.width = 22; img.height = 22;
      title.append(img);
    }
    title.append("Trailshopper");
    header.appendChild(title);
    header.appendChild(arrow);
    const body = document.createElement("div");
    body.className = "rs-body";
    header.addEventListener("click", () => {
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      arrow.firstElementChild.style.transform = hidden ? "rotate(180deg)" : "";
    });

    statusEl = document.createElement("div");
    statusEl.className = "rs-status";
    statusEl.textContent = "0 places found";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;";
    const btn = document.createElement("button");
    btn.textContent = "Search route";
    btn.className = "rs-btn";
    btn.addEventListener("click", () => { search(); });
    const pad = document.createElement("input");
    pad.type = "number"; pad.min = 100; pad.max = 10000; pad.step = 100; pad.value = state.padding;
    pad.title = "Search distance from route (m)";
    pad.className = "rs-input";
    let padTimer;
    pad.addEventListener("input", () => {
      clearTimeout(padTimer);
      padTimer = setTimeout(() => {
        const v = Math.min(10000, Math.max(100, +pad.value || DEFAULT_PADDING));
        pad.value = v;
        if (v === state.padding) return;
        state.padding = v;
        state.items = [];
        renderMarkers();
        renderPanelCounts();
        setStatus();
        search();
      }, 1000);
    });
    const m = document.createElement("span"); m.textContent = "m";
    const hideBtn = document.createElement("button");
    hideBtn.textContent = "Hide all";
    hideBtn.className = "rs-btn";
    hideBtn.addEventListener("click", () => {
      state.hidden = !state.hidden;
      hideBtn.textContent = state.hidden ? "Show all" : "Hide all";
      renderMarkers();
    });
    row.append(btn, hideBtn, pad, m);

    const row2 = document.createElement("div");
    row2.style.cssText = "margin-bottom:6px;";
    const auto = document.createElement("label");
    const autoCb = document.createElement("input");
    autoCb.type = "checkbox"; autoCb.checked = state.auto;
    autoCb.addEventListener("change", () => { state.auto = autoCb.checked; });
    auto.append(autoCb, " Auto-update when route changes");
    row2.append(auto);

    const filtersTitle = document.createElement("div");
    filtersTitle.textContent = "Filters";
    filtersTitle.className = "rs-section";
    const list = document.createElement("div");
    CATEGORIES.forEach((c) => {
      const lab = document.createElement("label");
      lab.className = "rs-check";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = false;
      cb.addEventListener("change", () => {
        cb.checked ? state.enabled.add(c.id) : state.enabled.delete(c.id);
        renderMarkers();
      });
      const ic = document.createElement("span");
      ic.textContent = c.icon; ic.style.cssText = "width:20px;text-align:center;";
      const nm = document.createElement("span"); nm.textContent = c.label; nm.style.flex = "1";
      const n = document.createElement("span"); n.textContent = "0"; n.className = "rs-count";
      countsEls[c.id] = n;
      lab.append(cb, ic, nm, n);
      list.appendChild(lab);
    });

    const open24 = document.createElement("label");
    const open24Cb = document.createElement("input");
    open24Cb.type = "checkbox"; open24Cb.checked = state.only24h;
    open24Cb.addEventListener("change", () => { state.only24h = open24Cb.checked; renderMarkers(); });
    const open24Txt = document.createElement("span"); open24Txt.textContent = "Open 24/7 only";
    open24.append(open24Cb, open24Txt);
    const firstLab = list.firstElementChild;
    if (firstLab) { open24.className = firstLab.className; open24.style.cssText = firstLab.style.cssText; }
    const nameBox = document.createElement("input");
    nameBox.type = "search";
    nameBox.placeholder = "Search by name";
    nameBox.className = pad.className;
    nameBox.style.cssText = pad.style.cssText;
    nameBox.style.width = "100%";
    nameBox.style.margin = "0 0 6px";
    let nameTimer;
    nameBox.addEventListener("input", () => {
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => { state.nameQuery = nameBox.value.trim().toLowerCase(); renderMarkers(); }, 250);
    });
    body.append(statusEl, row, row2, filtersTitle, nameBox, open24, list);

    panel.append(header, body);
  }

  // Sits as an accordion right after the site's own accordions (Summary, Warnings, Route places).
  function mountPanel(inPlanner) {
    const accs = inPlanner ? [...document.querySelectorAll(".MuiDrawer-paper .MuiAccordion-root")].filter((a) => a !== panel) : [];
    if (!accs.length) {
      if (panel && panel.isConnected) panel.remove();
      return;
    }
    buildPanel();
    const last = accs[accs.length - 1];
    if (last.nextElementSibling !== panel) last.after(panel);
  }
  // ---------- main loop ----------
  function clearResults() {
    clearTimeout(state.debounce);
    state.items = [];
    state.networkRoute = null;
    state.routeSig = state.lastSearchedSig = null;
    renderMarkers();
    renderPanelCounts();
    setStatus();
  }

  function routeLength() {
    for (const p of document.querySelectorAll("p")) {
      if (/^Length\b/.test(p.textContent.trim())) return p.nextElementSibling ? p.nextElementSibling.textContent.trim() : "";
    }
    return "";
  }

  function tick() {
    const inPlanner = !!document.querySelector(".MuiDrawer-paper .MuiAccordion-root");
    mountPanel(inPlanner);
    if (!state.map || !state.map.getStyle) {
      state.map = findMap();
      if (state.map) {
        ensureOverlay();
        renderMarkers();
      }
    } else if (overlay && !overlay.isConnected) {
      overlay = null;
      ensureOverlay();
      renderMarkers();
    }
    if (!inPlanner) {
      if (state.items.length) clearResults();
      return;
    }
    const r = currentRoute();
    if (!r || dedupe(r.coords).length < 2) {
      if (state.items.length || state.routeSig) clearResults();
      return;
    }
    // The planner first draws a straight preview line; the "Length" figure changes once the real route is drawn.
    const sig = signature(dedupe(r.coords)) + "|" + routeLength();
    state.route = r.coords;
    if (sig !== state.routeSig) {
      state.routeSig = sig;
      state.route = r.coords;
      if (state.auto) {
        clearTimeout(state.debounce);
        state.debounce = setTimeout(() => {
          const cur = currentRoute();
          if (cur) state.route = cur.coords;
          if (state.routeSig !== state.lastSearchedSig) search();
        }, 2000);
      } else {
      }
    }
  }
  setInterval(tick, 1500);
})();
