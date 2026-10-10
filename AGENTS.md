# Randoshopper – working notes

Chrome MV3 extensions that overlay shops/food/water/etc. along a route on a route-planner map.
Not a git repo. Two sibling extensions: `rwgps-extension\` (Ride with GPS) and `komoot-extension\` (Komoot).
Test data: `test-data\` (`payload-to-server.json` = request shape, `response-from-server.json` = GeoJSON reply, sample `.gpx`).

## Architecture (same in both extensions)
- `page.js` – runs in the page's MAIN world (`run_at: document_start`). Does everything: finds the map object, reads the route, builds the payload, draws markers/popups and the side panel. No extension APIs available here.
- `relay.js` – isolated-world bridge. Forwards `window.postMessage` `randoshopper-request` -> `chrome.runtime.sendMessage` and replies with `randoshopper-response`. Also exposes the logo URL to `page.js` via `document.documentElement.dataset.randoshopperLogo` (`logo.svg` is a web_accessible_resource; master copy in `icons\logo.svg`, copied into both extension folders).
- `background.js` – service worker. POSTs the payload to `https://randoshopper.sloth.fi/api/route` (host permission in `manifest.json`) and returns the JSON.
- Backend gets the simplified route; replies GeoJSON; `toItems()` in `page.js` filters features into categories.

## rwgps-extension\page.js layout (search the `// ----------` section comments)
- Top: `CATEGORIES` list (id, label, icon, color, `test(tags)`), the way to add/remove item types. Shelter exclusions in `SHELTER_EXCLUDED_TYPES`.
- geometry helpers: `simplify`, `dedupe`, `signature`.
- finding the map: RWGPS uses a Mapbox/MapLibre GL map. Captured by an `Object.prototype._listeners` setter hook and a `Function.prototype.bind` hook, with `scanForMap` as fallback.
- reading the route: `routeFromMap(map)` reads only `geojson` sources (route is a UUID-named GeoJSON source; layers `<uuid>_1_target/_casing/_paved/_unpaved/_unknown`). Basemap is vector (`rwgps:vector`) and must be ignored (an earlier bug picked `path_track_access_no_outer`). Falls back to `querySourceFeatures`, then to `networkRoute` sniffed from fetch/XHR JSON (`hookNetwork`).
- panel: injected into the right sidebar (`[class*="_PlannerSidebar_"]`, class names are hashed so match on the prefix; sample HTML in `test-data\rwgps-menu.html`) just before the `[class*="_aboveClearAll_"]` hr, i.e. above "Delete All" (falls back to appending at the end of the sidebar). `mountPanel()` in `tick()` re-attaches it after React re-renders and removes it outside the planner. Open by default.
- backend, markers, main loop `tick()` every 1500 ms.
- Planner URLs matched by `/routes/(new|<id>/edit)`.

- Komoot panel: same idea, mounted by `mountPanel()` into `#side-panel` (stable id; css-* classes are hashed), inside `side-panel > scroll container > wrapper` after the last section; sample HTML in `test-data\komoot-menu.html`. Only on `/plan`. Open by default.

## Workflow when changing something
1. Read the relevant section of `page.js` (use grep for the section comment, then view a range).
2. Edit with the edit tool (no PowerShell file writes).
3. Validate syntax: `node --check <ext>\page.js` (and relay/background if touched). It is browser-only code, so no unit tests.
4. Tell the user to reload the extension at `chrome://extensions` and reload the page; the user tests in the browser and reports back.
5. Keep the two extensions' behavior in sync when a change applies to both (popup close button, panel minimized, etc.).

## Debugging
Debug logging was removed. If route detection breaks again, temporarily add a `console.log` dump of `map.getStyle().layers` filtered to non-vector/raster sources (look for GeoJSON sources with line layers and check coordinate counts), then remove it after. Ignore console noise from the sites (Permissions-Policy warnings, Amplitude/Engagement `ERR_BLOCKED_BY_CLIENT`).

## User preferences
- Replies short (under ~100 words).
- Popups have an x button and close on map click.
- Panel minimized by default.
