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

  function findMap() {
    const el = document.querySelector(".maplibregl-map, .mapboxgl-map, .maplibregl-canvas, .mapboxgl-canvas");
    if (!el) return null;
    let node = el;
    while (node && node !== document.documentElement) {
      const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$"));
      if (key) {
        let fiber = node[key];
        while (fiber.return) fiber = fiber.return;
        const m = findMapInFiberTree(fiber);
        if (m) return m;
        break;
      }
      node = node.parentElement;
    }
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
    const re = /tourline|route|plan/i;
    const reSkip = /record|completed|highlight|hover|poi|label|arrow|cap|casing|outline|halo/i;
    let best = null;
    for (const layer of style.layers || []) {
      if (layer.type !== "line" || !layer.source) continue;
      if (!(re.test(layer.id) || re.test(layer.source))) continue;
      if (reSkip.test(layer.id)) continue;
      const src = map.getSource(layer.source);
      if (!src) continue;
      let data = src._data;
      if (!data && typeof src.serialize === "function") data = src.serialize().data;
      let coords = typeof data === "object" ? geojsonLine(data) : [];
      if (!coords.length) {
        try {
          const feats = map.queryRenderedFeatures({ layers: [layer.id] });
          if (feats.length === 1) coords = geojsonLine(feats[0]);
        } catch (_) { /* ignore */ }
      }
      if (coords.length > 1 && (!best || coords.length > best.coords.length)) {
        best = { coords, layer: layer.id };
      }
    }
    return best;
  }

  // Fallback: capture route geometry from Komoot's own API responses.
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
      if (!/komoot/.test(url) || !/rout|tour|plan/i.test(url)) return;
      if (!text || text[0] !== "{" && text[0] !== "[") return;
      try {
        const pts = extractFromJson(JSON.parse(text));
        if (pts.length > 10) state.networkRoute = pts;
      } catch (_) { /* ignore */ }
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
    const sig = signature(route);
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
    overlay.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:5;";
    container.appendChild(overlay);
    state.map.on("move", positionMarkers);
    state.map.on("resize", positionMarkers);
    state.map.on("click", closePopup);
    return true;
  }

  function showPopup(item, el) {
    closePopup();
    const t = item.tags;
    popup = document.createElement("div");
    popup.style.cssText = "position:absolute;transform:translate(-50%,-130%);background:#fff;color:#222;padding:8px 10px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.35);font:13px/1.35 sans-serif;width:max-content;min-width:200px;max-width:340px;pointer-events:auto;z-index:10;";
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    let html = `<b>${esc(t.name || item.cat.label)}</b><span data-close style="position:absolute;top:2px;right:6px;cursor:pointer;font-size:16px;line-height:1;color:#666;">×</span>`;
    if (t.name) html += `<div style="color:#666;margin-bottom:8px">${esc(item.cat.label)}</div>`;
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
    popup.style.paddingRight = "22px";
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
    panel.style.cssText = "box-sizing:border-box;width:100%;padding:12px 0;color:inherit;font-family:inherit;font-size:14px;line-height:1.4;";
    const header = document.createElement("div");
    header.style.cssText = "padding:4px 0;font-weight:500;font-size:16px;cursor:pointer;display:flex;justify-content:space-between;user-select:none;";
    const arrow = document.createElement("span");
    arrow.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" style="display:block;transition:transform .2s;transform:rotate(180deg)"><path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z"></path></svg>';
    const title = document.createElement("span");
    title.style.cssText = "display:flex;align-items:center;gap:6px;";
    const logoUrl = document.documentElement.dataset.randoshopperLogo;
    if (logoUrl) {
      const img = document.createElement("img");
      logoEl = img; img.src = logoUrl; img.alt = ""; img.width = 22; img.height = 22;
      title.append(img);
    }
    title.append("Komootshopper");
    header.appendChild(title);
    header.appendChild(arrow);
    const body = document.createElement("div");
    body.style.cssText = "padding-top:6px;";
    header.addEventListener("click", () => {
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      arrow.firstElementChild.style.transform = hidden ? "rotate(180deg)" : "";
    });

    statusEl = document.createElement("div");
    statusEl.style.cssText = "color:#7a6c5d;margin-bottom:6px;font-size:13px;";
    statusEl.textContent = "0 places found";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;";
    const btn = document.createElement("button");
    btn.textContent = "Search route";
    btn.style.cssText = "box-sizing:border-box;height:40px;font:inherit;padding:0 16px;line-height:1;color:#6b5d4d;background:#fff;cursor:pointer;border:1px solid #d6d1c4;border-radius:999px;";
    btn.addEventListener("click", () => { search(); });
    const pad = document.createElement("input");
    pad.type = "number"; pad.min = 100; pad.max = 10000; pad.step = 100; pad.value = state.padding;
    pad.title = "Search distance from route (m)";
    pad.style.cssText = "box-sizing:border-box;height:40px;font:inherit;width:96px;padding:0 16px;line-height:1;color:#6b5d4d;background:#fff;border:1px solid #d6d1c4;border-radius:999px;";
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
    hideBtn.style.cssText = "box-sizing:border-box;height:40px;font:inherit;padding:0 16px;line-height:1;color:#6b5d4d;background:#fff;cursor:pointer;border:1px solid #d6d1c4;border-radius:999px;";
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
    filtersTitle.style.cssText = "font-weight:500;font-size:16px;margin:8px 0 4px;";
    const list = document.createElement("div");
    CATEGORIES.forEach((c) => {
      const lab = document.createElement("label");
      lab.style.cssText = "display:flex;align-items:center;gap:4px;padding:1px 0;cursor:pointer;";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = false;
      cb.addEventListener("change", () => {
        cb.checked ? state.enabled.add(c.id) : state.enabled.delete(c.id);
        renderMarkers();
      });
      const ic = document.createElement("span");
      ic.textContent = c.icon; ic.style.cssText = "width:20px;text-align:center;";
      const nm = document.createElement("span"); nm.textContent = c.label; nm.style.flex = "1";
      const n = document.createElement("span"); n.textContent = "0"; n.style.color = "#888";
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
    const searchIcon = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236b5d4d' stroke-width='1.8' stroke-linecap='round'><circle cx='11' cy='11' r='7'/><path d='M20 20l-4-4'/></svg>\")";
    nameBox.style.cssText += `;height:40px;border-radius:999px;border:1px solid #d6d1c4;padding:0 16px 0 42px;color:#6b5d4d;background:${searchIcon} no-repeat 14px center / 20px;`;
    let nameTimer;
    nameBox.addEventListener("input", () => {
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => { state.nameQuery = nameBox.value.trim().toLowerCase(); renderMarkers(); }, 250);
    });
    body.append(statusEl, row, row2, filtersTitle, nameBox, open24, list);

    panel.append(header, body);
  }

  // Komoot's css-* class names are hashed, so anchor on #side-panel and use its structure:
  // side-panel > scroll container > wrapper > sections. Falls back to #side-panel itself.
  function mountPanel(onPlan) {
    let sp = onPlan ? document.querySelector("#side-panel") : null;
    // The route editor controls are missing while a POI/highlight is open in the side panel.
    if (sp && !sp.querySelector('[data-test-id="activity-dropdown"]')) sp = null;
    if (!sp) {
      if (panel && panel.isConnected) panel.remove();
      return;
    }
    buildPanel();
    const host = sp.children[1]?.firstElementChild?.firstElementChild || sp;
    if (panel.parentNode !== host || host.lastElementChild !== panel) host.appendChild(panel);
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

  function tick() {
    const onPlan = /\/(plan|tour)(\/|$)/.test(location.pathname);
    mountPanel(onPlan);
    if (!onPlan) {
      if (state.items.length) clearResults();
      return;
    }
    if (!state.map || !state.map.getStyle) {
      state.map = findMap();
      if (state.map) {  ensureOverlay(); renderMarkers(); }
    } else if (overlay && !overlay.isConnected) {
      overlay = null;
      ensureOverlay();
      renderMarkers();
    }
    const r = currentRoute();
    if (!r || dedupe(r.coords).length < 2) {
      if (state.items.length || state.routeSig) clearResults();
      return;
    }
    const sig = signature(dedupe(r.coords));
    if (sig !== state.routeSig) {
      state.routeSig = sig;
      state.route = r.coords;
      if (state.auto) {
        clearTimeout(state.debounce);
        state.debounce = setTimeout(() => { if (state.routeSig !== state.lastSearchedSig) search(); }, 1500);
      } else {
      }
    }
  }
  setInterval(tick, 1500);
})();
