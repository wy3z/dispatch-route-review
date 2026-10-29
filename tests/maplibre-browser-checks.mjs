import assert from "node:assert/strict";
import { checkDialogFocus } from "./ui-cleanup-browser-checks.mjs";

async function checkAttributionTray({ client, read, delay, clickElement }) {
  await read("void (window.__attributionPreviousFocus = document.activeElement)");
  const viewport = await read("({width: innerWidth, height: innerHeight})");
  for (const width of [viewport.width, 1000, 600]) {
    await client.command("Emulation.setDeviceMetricsOverride", { width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    for (const open of [false, true]) {
      await read(`document.querySelector('.review-map-legend-tray').open = ${open}`);
      await delay(100);
      const bounds = await read(`(() => {
        const tray = document.querySelector('.review-map-legend-tray').getBoundingClientRect();
        const icon = document.querySelector('.review-map-info').getBoundingClientRect();
        const zoom = document.querySelector('.review-map-navigation').getBoundingClientRect();
        const header = document.querySelector('.dispatch-review-header-actions').getBoundingClientRect();
        const credits = document.querySelector('.review-map-attribution-content .maplibregl-ctrl-attrib');
        return { headerContained: header.left >= 0 && header.right <= innerWidth, contained: icon.left >= tray.left && icon.right <= tray.right,
          separated: zoom.bottom < tray.top, onScreen: tray.left >= 0 && tray.right <= innerWidth,
          credits: credits.textContent, fontSize: parseFloat(getComputedStyle(credits).fontSize) };
      })()`);
      assert.ok(bounds.headerContained, `header controls remain on screen at ${width}px`);
      assert.ok(bounds.contained && bounds.separated && bounds.onScreen, `legend/zoom layout at ${width}px, expanded=${open}`);
      assert.ok(bounds.credits.includes("MapLibre"), "native attribution remains in the tray");
      assert.ok(bounds.fontSize >= 12, "credits remain readable");
    }
  }
  await client.command("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
  const selection = await read("document.querySelector('.route-rail-route[aria-current=true]')?.textContent");
  await read("document.querySelector('.review-map-legend-tray').open = false; document.querySelector('.review-map-attribution-toggle').focus()");
  for (const [key, code, keyCode, expected] of [["Enter", "Enter", 13, true], [" ", "Space", 32, false], ["Enter", "Enter", 13, true], ["Escape", "Escape", 27, false]]) {
    for (const type of ["keyDown", "keyUp"]) await client.command("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: keyCode,
      ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}),
    });
    assert.equal(await read("document.querySelector('.review-map-legend-tray').open"), expected, `${code} operates attribution`);
  }
  assert.equal(await read("document.querySelector('.route-rail-route[aria-current=true]')?.textContent"), selection, "attribution keyboard controls preserve route selection");
  await clickElement(client, ".review-map-info", "expand map credits");
  assert.equal(await read("document.querySelector('.review-map-legend-tray').open"), true);
  await client.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await client.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert.equal(await read("document.activeElement.matches('.review-map-attribution-content a')"), true, "Tab reaches native credit links");
  await clickElement(client, ".review-map-info", "collapse map credits");
  assert.equal(await read("document.querySelector('.review-map-legend-tray').open"), false);
  await read("window.__attributionPreviousFocus.focus(); delete window.__attributionPreviousFocus");
}

/** Exercise the same accessible product actions against both engines, plus candidate publication bounds. */
export async function checkExtendedMap({ client, evaluate, clickElement, pressKey, waitFor, delay, date, capture }) {
  const read = (expression) => evaluate(client, expression, "checking extended map parity");
  const metrics = () => read("JSON.parse(document.querySelector('.audit-map').dataset.mapMetrics || 'null')");
  const popupSelector = ".review-libre-popup";
  const popupText = () => read(`document.querySelector('${popupSelector}')?.textContent ?? ''`);
  const waitPopup = (text) => waitFor(async () => (await popupText()).includes(text), `popup containing ${text}`);
  const pointId = `fixture-${date}-north-1`;
  // Timeline -> fullscreen -> routes. Pane changes never replay consumed camera intent.
  const paneTypography = () => read(`(() => {
    const pane = document.querySelector('.dispatch-map-route-rail');
    return [pane, ...pane.querySelectorAll('.route-rail-stats dd')].map(element => getComputedStyle(element).fontSize);
  })()`);
  const originalTypography = await paneTypography();
  const beforePane = await metrics();
  await pressKey(client, "t", "KeyT"); await delay(250);
  assert.deepEqual(await paneTypography(), originalTypography, "pane mode preserves inherited typography");
  await pressKey(client, "t", "KeyT"); await delay(250);
  assert.deepEqual(await paneTypography(), originalTypography, "pane mode preserves inherited typography");
  assert.equal(await read("document.querySelector('main').dataset.routePaneMode"), "routes");
  if (beforePane) assert.equal((await metrics()).cameraIntents, beforePane.cameraIntents);
  await pressKey(client, "m", "KeyM"); await delay(550);
  await pressKey(client, "e", "KeyE"); await delay(250);
  await capture("overview-light");
  await checkAttributionTray({ client, read, delay, clickElement });
  const stable = await metrics();
  await read("[...document.querySelectorAll('button.route-rail-route')].find(b => b.textContent.includes('Fixture North Engineer'))?.click()");
  await waitFor(() => read(`Boolean(document.querySelector('[data-detail-visit-id="${pointId}"]'))`), "expanded booked visit");
  await clickElement(client, `[data-detail-visit-id="${pointId}"]`, "focus booked visit");
  await waitPopup("T1001"); await delay(550);
  const booked = await popupText();
  for (const text of ["Fixture Company", "Fixture North Engineer", "Work duration", "Road estimate", "Scheduled"]) assert.ok(booked.includes(text), `booked popup includes ${text}`);
  const link = await read(`(() => { const a = document.querySelector('${popupSelector} a[target="_blank"]'); return a ? {href:a.href,target:a.target,rel:a.rel} : null; })()`);
  assert.equal(link?.href, "https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=1001");
  assert.equal(link?.target, "_blank"); assert.ok(link?.rel.includes("noreferrer"));
  assert.equal(await read("getComputedStyle(document.querySelector('.route-rail-route[aria-current=true]')).backgroundColor"),
    "rgba(0, 0, 0, 0)", "selection colours the route container, not a nested control card");
  await capture("booked-popup-light");
  if (stable) {
    const selected = await metrics();
    for (const source of ["review-roads", "review-booked", "review-demand", "review-issues", "review-advisory", "review-homes"]) {
      assert.equal(selected.publications[source], stable.publications[source], `route/visit selection leaves ${source} stable`);
    }
    assert.ok(selected.publications["review-focus"] > stable.publications["review-focus"]);
    assert.ok(selected.layerUpdates - stable.layerUpdates <= 32, "selection updates a bounded number of layers");
    assert.equal(await read("document.querySelectorAll('.leaflet-container, svg .audit-route-line').length"), 0);
    const cameraBefore = selected.cameraIntents;
    await clickElement(client, `[data-detail-visit-id="${pointId}"]`, "repeat explicit visit focus"); await delay(550);
    assert.equal((await metrics()).cameraIntents, cameraBefore + 1);
    await read("document.querySelector('.review-libre-details').focus(); window.__detailOverflow = document.body.style.overflow");
    await clickElement(client, ".review-libre-details", "open booked details");
    await waitFor(() => read("Boolean(document.querySelector('[role=dialog][aria-modal=true]'))"), "booked detail dialog");
    await checkDialogFocus({ client, read, waitFor, initialFocus: '[role=dialog] button[aria-label*=Close]' });
    const actionVisible = await read(`(() => {
      const dialog = document.querySelector('[role=dialog][aria-modal=true]').getBoundingClientRect();
      const link = document.querySelector('[role=dialog] footer a[target="_blank"]').getBoundingClientRect();
      return link.height >= 32 && link.left >= dialog.left && link.right <= dialog.right && link.bottom <= dialog.bottom;
    })()`);
    assert.ok(actionVisible, "the detail action retains its button geometry within the dialog");
    const beforeModalKey = (await metrics()).keyboardCommands;
    await pressKey(client, "ArrowRight", "ArrowRight");
    assert.equal((await metrics()).keyboardCommands, beforeModalKey, "modal owns camera keyboard input");
    await pressKey(client, "Escape", "Escape");
    await waitFor(() => read("!document.querySelector('[role=dialog][aria-modal=true]')"), "closed detail dialog");
    assert.equal(await read("document.activeElement === document.querySelector('.review-libre-details')"), true, "booked details restore popup focus");
    assert.equal(await read("document.body.style.overflow === window.__detailOverflow"), true);
  }
  {
    await read("(() => { const b = document.querySelector('.review-libre-popup .maplibregl-popup-close-button'); b.focus(); b.click(); })()");
    await waitFor(async () => !(await popupText()), "close button clears popup");
    assert.equal(await read("document.activeElement === document.querySelector('.audit-map')"), true, "popup close restores its previous map focus");
  }
  await read("[...document.querySelectorAll('button.route-rail-route')].find(b => b.textContent.includes('Fixture Home Engineer'))?.click()");
  await delay(550);
  assert.equal(await read("[...document.querySelectorAll('button.route-rail-route')].find(b => b.textContent.includes('Fixture Home Engineer'))?.getAttribute('aria-current')"), "true", "unbooked engineer with a base is selectable");
  if (stable) {
    assert.equal((await metrics()).features["review-roads"], 6, "selecting an empty engineer creates no booked legs");
    for (const source of ["review-roads", "review-booked"]) assert.equal((await metrics()).publications[source], stable.publications[source], `home selection leaves ${source} stable`);
  }
  await read(`(() => {
    const trigger = [...document.querySelectorAll('[data-rail-category-trigger]')].find(b => b.textContent.includes('Unassigned'));
    if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click();
  })()`);
  await waitFor(() => read("Boolean(document.querySelector('[data-detail-demand-id=d2]'))"), "home suggested demand in rail");
  const beforeDemand = await metrics();
  await clickElement(client, "[data-detail-demand-id=d2]", "focus home-based suggestion");
  await waitPopup("Fixture Demand d2"); await delay(550);
  const demand = await popupText();
  for (const text of ["Unassigned", "No schedule", "No ETA", "assumed", "Straight-line proximity", "Fixture Home Engineer"]) assert.ok(demand.includes(text), `demand popup includes ${text}`);
  await capture("home-suggestion-light");
  await read("document.querySelector('.review-libre-details').focus()");
  await clickElement(client, ".review-libre-details", "open demand details");
  await checkDialogFocus({ client, read, waitFor, initialFocus: '[role=dialog] button[aria-label*=Close]' });
  await pressKey(client, "Escape", "Escape");
  await waitFor(() => read("!document.querySelector('[role=dialog][aria-modal=true]')"), "closed demand details");
  assert.equal(await read("document.activeElement === document.querySelector('.review-libre-details')"), true, "demand details restore popup focus");
  if (beforeDemand) {
    const current = await metrics();
    for (const source of ["review-roads", "review-booked", "review-demand", "review-advisory", "review-homes"]) assert.equal(current.publications[source], beforeDemand.publications[source], `demand selection leaves ${source} stable`);
    assert.ok(current.features["review-advisory"] >= 2, "visit and home advisory connectors exist");
    assert.equal(current.features["review-roads"], 6, "empty engineer never creates a booked road leg");
  }
  await clickElement(client, "[data-detail-demand-id=d4]", "focus excluded demand");
  await waitPopup("Outside engineer coverage");
  assert.ok((await popupText()).includes("Waiting over 24 hours"));
  await capture("excluded-demand-light");
  const beforeTheme = await metrics();
  await clickElement(client, ".theme-toggle", "dark theme");
  await waitFor(() => read("document.documentElement.dataset.theme === 'dark' && document.querySelector('.audit-map').dataset.mapStyleReady === 'true'"), "restored dark style");
  await waitPopup("Fixture Demand d4"); await capture("excluded-demand-dark");
  await checkAttributionTray({ client, read, delay, clickElement });
  if (beforeTheme) {
    const restored = await metrics();
    assert.equal(restored.styleRestores, beforeTheme.styleRestores + 1);
    assert.equal(restored.cameraIntents, beforeTheme.cameraIntents, "theme replacement does not replay camera intent");
    assert.equal(await read("document.querySelectorAll('.review-libre-popup').length"), 1);
    assert.equal(await read("document.querySelectorAll('.maplibregl-canvas').length"), 1);
  }
  await clickElement(client, ".theme-toggle", "light theme");
  await waitFor(() => read("document.documentElement.dataset.theme === 'light' && document.querySelector('.audit-map').dataset.mapStyleReady === 'true'"), "restored light style");
  await pressKey(client, "Escape", "Escape");
  await pressKey(client, "m", "KeyM"); await delay(550);
  await capture("overview-restored");
  {
    // Exercise native world and zoom limits through the same controller keyboard path.
    await client.command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await read(`(() => {
      const element = document.querySelector('.audit-map'); element.focus();
      for (const [key, count] of [['-', 50], ['ArrowLeft', 300], ['ArrowUp', 300]]) {
        for (let i = 0; i < count; i++) for (const type of ['keydown', 'keyup']) element.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
      }
    })()`);
    let camera = await read("document.querySelector('.audit-map').reviewMapDiagnostics().camera");
    assert.equal(camera.zoom, 3, "native minimum zoom clamps repeated input");
    assert.ok(Number.isFinite(camera.center.lng) && Math.abs(camera.center.lng) < 180);
    assert.ok(Number.isFinite(camera.center.lat) && Math.abs(camera.center.lat) < 85.052, "native world pan remains inside Mercator bounds");
    await read(`(() => { const element = document.querySelector('.audit-map'); for (let i = 0; i < 50; i++) for (const type of ['keydown', 'keyup']) element.dispatchEvent(new KeyboardEvent(type, { key: '=', bubbles: true, cancelable: true })); })()`);
    camera = await read("document.querySelector('.audit-map').reviewMapDiagnostics().camera");
    assert.equal(camera.zoom, 19, "native maximum zoom clamps repeated input");
    await pressKey(client, "m", "KeyM");
    camera = await read("document.querySelector('.audit-map').reviewMapDiagnostics().camera");
    assert.ok(camera.zoom >= 3 && camera.zoom <= 13, "visible fit recovers after constrained pan and zoom");
    await client.command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  }
  return { sourceBounds: Boolean(stable), themeRestoration: true, homeSuggestion: true, safeLinks: true, completePopups: true, finalMetrics: await metrics() };
}

export async function checkMapContextLoss({ client, evaluate, clickElement, pressKey, waitFor, date }) {
  await evaluate(client, `(() => {
    const canvas = document.querySelector('.maplibregl-canvas');
    canvas.focus();
    const gl = canvas.getContext('webgl2');
    gl.getExtension('WEBGL_lose_context').loseContext();
  })()`, "losing the WebGL context");
  await waitFor(() => evaluate(client, "document.querySelector('.audit-map').dataset.basemap === 'unavailable'", "checking map degradation"), "degraded map");
  assert.equal(await evaluate(client, "document.activeElement === document.querySelector('.audit-map')", "checking degraded focus"), true, "context loss returns canvas focus to the map region");
  await evaluate(client, "[...document.querySelectorAll('button.route-rail-route')].find(b => b.textContent.includes('Fixture North Engineer'))?.click()", "route in degraded mode");
  await clickElement(client, `[data-detail-visit-id="fixture-${date}-north-1"]`, "visit in degraded mode");
  await pressKey(client, "Enter", "Enter");
  await waitFor(() => evaluate(client, "Boolean(document.querySelector('[role=dialog][aria-modal=true]'))", "checking degraded details"), "details without a map");
  assert.equal(await evaluate(client, "document.querySelectorAll('.maplibregl-canvas').length", "checking failed map cleanup"), 0);
  assert.equal(await evaluate(client, "document.querySelectorAll('.review-map-controls .maplibregl-ctrl').length", "checking native control cleanup"), 0);
  assert.equal(await evaluate(client, "JSON.parse(document.querySelector('.audit-map').dataset.mapMetrics).mapsRemoved", "checking single teardown"), 1);
}
