import assert from "node:assert/strict";

const dialogSelector = '[role="dialog"][aria-modal="true"]';

async function tab(client, backwards = false) {
  for (const type of ["keyDown", "keyUp"]) {
    await client.command("Input.dispatchKeyEvent", {
      type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9,
      modifiers: backwards ? 8 : 0,
    });
  }
}

async function escape(client) {
  for (const type of ["keyDown", "keyUp"]) {
    await client.command("Input.dispatchKeyEvent", {
      type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
    });
  }
}

export async function checkDialogFocus({ client, read, waitFor, initialFocus }) {
  await waitFor(() => read(`document.activeElement === document.querySelector(${JSON.stringify(initialFocus)})`), "initial dialog focus");
  assert.equal(await read("document.body.style.overflow"), "hidden", "dialog locks body scroll");
  await read(`void (window.__focusTargets = [...document.querySelector(${JSON.stringify(dialogSelector)}).querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'))`);
  await read("window.__focusTargets.at(-1).focus()");
  await tab(client);
  assert.equal(await read("document.activeElement === window.__focusTargets[0]"), true, "Tab wraps forwards");
  await tab(client, true);
  assert.equal(await read("document.activeElement === window.__focusTargets.at(-1)"), true, "Shift+Tab wraps backwards");
  await read("document.querySelector('.app-menu-trigger').focus()");
  await tab(client);
  assert.equal(await read("document.activeElement === window.__focusTargets[0]"), true, "escaped focus returns to the dialog");
  await read("delete window.__focusTargets");
}

/** A separate, explicitly counted fixture phase after all map performance assertions. */
export async function checkEngineerEditor({ client, evaluate, waitFor, clickElement, origin, releaseSave, savePending }) {
  const read = expression => evaluate(client, expression, "checking engineer editor");
  await client.command("Page.navigate", { url: `${origin}/engineers` });
  // A server-rendered button exists before React can handle its click.
  await waitFor(() => read("Boolean(document.querySelector('.engineers-table .engineers-row-actions button'))"), "hydrated engineer roster");
  await read("document.querySelector('.engineers-add').focus(); window.__editorOverflow = document.body.style.overflow");
  await clickElement(client, ".engineers-add", "add engineer");
  await checkDialogFocus({ client, read, waitFor, initialFocus: ".engineers-editor input" });
  const fill = async (index, value) => {
    await read(`(() => {
      const input = document.querySelectorAll('.engineers-form-grid input')[${index}];
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await read("new Promise(resolve => requestAnimationFrame(resolve))");
    assert.equal(await read(`document.activeElement === document.querySelectorAll('.engineers-form-grid input')[${index}]`), true, "editing does not restart initial focus");
  };
  for (const [index, value] of [[0, "Fixture Editor"], [1, "888"], [2, "Fixture Base"], [3, "53.4"], [4, "-2.2"]]) await fill(index, value);
  await read("document.querySelector('.engineers-editor form').requestSubmit()");
  await waitFor(savePending, "held engineer save");
  await waitFor(() => read("document.querySelector('.engineers-form-actions button[type=submit]')?.disabled"), "saving guard");
  await escape(client);
  assert.equal(await read(`Boolean(document.querySelector('${dialogSelector}'))`), true, "Escape cannot close a saving editor");
  await releaseSave();
  await waitFor(() => read("document.querySelector('.engineers-form-actions button[type=submit]')?.disabled === false"), "save error settles");
  await escape(client);
  await waitFor(() => read(`!document.querySelector('${dialogSelector}')`), "editor closes after save settles");
  assert.equal(await read("document.activeElement === document.querySelector('.engineers-add')"), true, "editor restores its trigger");
  assert.equal(await read("document.body.style.overflow === window.__editorOverflow"), true, "editor restores body scrolling");
}

export async function checkLogoutNavigation({ client, evaluate, waitFor, delay, clickElement }) {
  const read = expression => evaluate(client, expression, "checking logout navigation");
  const requests = [];
  client.on("Network.requestWillBeSent", event => {
    if (new URL(event.request.url).pathname === "/logout") requests.push(event.type);
  });
  await clickElement(client, ".app-menu-trigger", "application menu");
  await waitFor(() => read("Boolean(document.querySelector('.app-menu-logout'))"), "logout link");
  const rect = await read("(() => { const r = document.querySelector('.app-menu-logout').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()");
  await client.command("Input.dispatchMouseEvent", { type: "mouseMoved", ...rect });
  await delay(250);
  assert.deepEqual(requests, [], "displaying and hovering logout never prefetches it");
  await read("window.__logoutDocument = true");
  await clickElement(client, ".app-menu-logout", "logout");
  await waitFor(() => read("document.querySelector('h1')?.textContent === 'Logout fixture'"), "logout document navigation");
  assert.deepEqual(requests, ["Document"], "logout is exactly one full document request");
  assert.equal(await read("window.__logoutDocument === undefined"), true, "logout replaces the document");
}
