# MapLibre renderer

MapLibre is the only renderer. `ReviewMap.tsx` uses the stock runtime through `modules/map/contracts.ts`.
Old `mapEngine` and `mapNavigation` parameters have no effect. Leaflet and custom navigation experiments are retired.
See the [code map](CODEBASE.md#main-entry-points) for file owners.

## Data and runtime

The interface carries an indexed scene, selection, temporary route preview, navigation requests, and one action sink.
Domain code derives routes and issues. The controller owns date, filters, and selection.
Unbooked homes use a separate lookup/source and never enter booked geometry.
Unassigned demand uses rounded pin markers with tapered tips; booked visits remain circles and engineer bases retain home markers. Demand labels, suggestion highlights, and attention badges remain unchanged.

The runtime owns the map, source updates, camera, popups/tooltips, and cleanup.
React owns the legend/attribution tray and native control outlets.
MapLibre owns attribution updates and `IControl` cleanup.

## Style changes

Cache only the two raw basemap definitions from full loads with confirmed identity.
Do not add review layers to these cached definitions.
A known opposite-theme diff can retain the live review suffix after public identity, order, and dependency checks.
Keep publication and state records only when native retention is proven.
For unknown or interrupted loads, replace the style URL. Then reinstall current data.

## Tile continuity

`retainCachedBasemapParents` repairs a MapLibre 5.24 parent lookup gap.
Native lookup can miss decoded cached parents while children load. The basemap can then disappear during movement.

The repair applies once per manager to `openmaptiles` during style restoration.
It uses `_addTile` only for cached tiles with `hasData()`, preserving native initialization, expiry, and removal.
It neither preloads tiles nor creates another cache.

`maxTileCacheZoomLevels: 8` and `maxTileCacheSize: 256` retain overview tiles during long flights.
They increase memory retention. No startup speed improvement is proven.

## Upgrade and basemap checks

1. Check `style.tileManagers`, `getTile`, `_outOfViewCache.get`, `hasData()`, and `_addTile` against the proposed MapLibre version.
2. Run the browser checks in [testing](testing-strategy.md).
3. Test both themes with real tiles on a representative device.
4. Test normal and reduced motion.
5. Test first visits, repeated A→B→A rail focus, wheel zoom, long flights, and return to overview.
6. Check coverage throughout movement with compositor captures and render-time samples.
7. Record viewport, GPU, visibility, cache conditions, and measurement overhead.

Style readiness, `idle`, empty-style tests, and move-end screenshots cannot prove continuity.
Keep customer screenshots and traces private and outside Git.
Old benchmark records do not prove current acceptance.
