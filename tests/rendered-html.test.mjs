import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 32_000 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
let server;

before(async () => {
  server = spawn(
    process.execPath,
    [resolve(projectDirectory, "node_modules/next/dist/bin/next"), "start", "-p", String(port)],
    {
      cwd: projectDirectory,
      env: {
        ...process.env,
        AUTH_MODE: "development",
        DEV_PAGE_PERMISSIONS: "dispatch_review,engineer_management",
      },
      stdio: "ignore",
    },
  );

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${origin}/`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Next.js test server did not become ready.");
});

after(() => {
  server?.kill();
});

async function render(pathname = "/") {
  return fetch(`${origin}${pathname}`, { headers: { accept: "text/html" } });
}

test("server renders Dispatch Review and preserves the legacy dispatch URL", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Dispatch Route Review<\/title>/i);
  assert.match(html, /<strong>Dispatch Route Review<\/strong>/i);
  assert.match(html, /<link[^>]+rel="icon"[^>]+href="\/icon\.svg(?:\?[^"<>]*)?"/i);
  assert.match(html, /Road map of scheduled engineer visits/i);
  assert.doesNotMatch(html, /LOCAL · READ ONLY/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);

  const legacyDispatch = await render("/dispatch?date=2026-08-10");
  assert.equal(legacyDispatch.status, 200);
  assert.match(legacyDispatch.url, /\?view=timeline&date=2026-08-10$/);
});

test("server renders the permission-gated engineer roster editor", async () => {
  const response = await render("/engineers");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Engineer Controls/i);
  assert.match(html, /Third Party Attending Statuses/i);
  assert.match(html, /Add engineer/i);
});

test("Help remains an application overlay rather than a standalone route", async () => {
  const response = await render("/help");
  assert.equal(response.status, 404);
});

test("removed Draft and scheduler runtime surfaces return 404 over HTTP", async () => {
  for (const [pathname, method] of [
    ["/draft", "GET"],
    ["/api/draft-queue", "GET"],
    ["/api/travel-matrix", "POST"],
    ["/api/timefold-export", "GET"],
    ["/api/scheduler/plans", "GET"],
    ["/api/scheduler/plans", "POST"],
    ["/api/scheduler/plans/removed-plan", "PATCH"],
  ]) {
    const response = await fetch(`${origin}${pathname}`, { method });
    assert.equal(response.status, 404, `${method} ${pathname}`);
  }
});

test("read-only schedule API rejects mutation methods", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${origin}/api/autotask-schedule`, { method });
    assert.equal(response.status, 405, method);
  }
});
