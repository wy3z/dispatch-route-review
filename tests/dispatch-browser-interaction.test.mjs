import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { checkStressMap } from "./maplibre-stress-checks.mjs";
import { checkExtendedMap, checkMapContextLoss } from "./maplibre-browser-checks.mjs";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectoryName = ".next-test";
const distDirectory = resolve(projectDirectory, distDirectoryName);
const standaloneDirectory = resolve(distDirectory, "standalone");
const standaloneServerPath = resolve(standaloneDirectory, "server.js");
const nextBinary = resolve(projectDirectory, "node_modules/next/dist/bin/next");
const appPort = 34_000 + (process.pid % 1_000);
const debugPort = 35_000 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${appPort}`;

const engineOverride = process.env.MAP_TEST_ENGINE ?? "";
assert.ok(["", "maplibre"].includes(engineOverride), "Only the MapLibre renderer is available");
const requestedEngine = "maplibre";
const diagnosticOutput = process.env.MAP_TEST_DIAGNOSTIC_OUTPUT;
const profileStartup = process.env.MAP_TEST_PROFILE_STARTUP === "1";
const slowStartupControl = process.env.MAP_TEST_SLOW_STARTUP === "1";
const diagnosticCommands = [];
const comparisonOutput = process.env.MAP_COMPARISON_OUTPUT;
const basemapManifestPath = process.env.MAP_TEST_BASEMAP_MANIFEST;
const basemapManifest = basemapManifestPath ? JSON.parse(readFileSync(basemapManifestPath,"utf8")) : null;
const localBasemapAsset = (url) => {
  const entry = basemapManifest?.responses?.[url];
  if(!entry) return null;
  const root = dirname(resolve(basemapManifestPath));
  const path = resolve(root,entry.path);
  assert.ok(path.startsWith(`${root}/`),"basemap asset must remain inside the manifest directory");
  return {body:readFileSync(path).toString("base64"),mime:entry.mime};
};
const extendedMapFixture = process.env.MAP_TEST_EXTENDED === "1";
const partialMapFixture = process.env.MAP_TEST_PARTIAL === "1";
const extraMapFixture = process.env.MAP_TEST_EXTRA === "1";
const asyncMap = process.env.MAP_TEST_ASYNC === "1";
const startupOnly = process.env.MAP_TEST_STARTUP === "1";
const stressMap = process.env.MAP_TEST_STRESS === "1";
const comparisonMotion = process.env.MAP_TEST_MOTION === "reduce" ? "reduce" : "no-preference";
const hardwareGpu = process.env.MAP_TEST_GPU === "hardware";
const webglInitFailure = process.env.MAP_TEST_WEBGL_FAILURE === "init";
// Default review dates remain historical; extended fixtures also exercise demand.
const fixtureReferenceTime = extendedMapFixture
  ? "2026-08-19T08:00:00.000Z"
  : "2026-09-04T08:00:00.000Z";

const initialDate = "2026-08-19";
const changedDate = "2026-08-20";
const selectedDates = [initialDate, changedDate];
const cachePollIntervalMs = 30_000;
const prePollInteractionWindowMs = 12_000;
const strictCdpTimeoutMs = 1_500;
const coldStartupTimeoutMs = 15_000;
const maxGeometryPosts = selectedDates.length;
const maxScheduleGetsPerSelectedDate = 1;
const maxAlternatingRunBeforeFailure = 5;
const maxStableNodeWrites = 8;
const maxTotalApiRequests = extendedMapFixture ? 7 : 6;
const permittedExternalStyleUrls = new Set([
  "https://tiles.openfreemap.org/styles/bright",
  "https://tiles.openfreemap.org/styles/fiord",
]);
const expectedExternalFixtureRequests = [
  "GET https://tiles.openfreemap.org/styles/bright",
];

function executableFromCommand(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  const candidate = result.stdout.trim();
  return candidate && existsSync(candidate) ? candidate : null;
}

function findChrome() {
  const configured = process.env.CHROME_PATH?.trim();
  if (configured && existsSync(configured)) return configured;

  // Keep this order aligned with the production regression runner contract.
  const candidates = [
    executableFromCommand("helium"),
    "/opt/helium-browser-bin/helium",
    executableFromCommand("google-chrome-stable"),
    executableFromCommand("google-chrome"),
    executableFromCommand("chromium"),
    executableFromCommand("chromium-browser"),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

const chromePath = findChrome();
const browserRequired =
  process.env.CI === "true" || process.env.REQUIRE_BROWSER_INTERACTION === "1";

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(predicate, label, timeoutMs = 8_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message ?? lastError}` : ""}`,
  );
}

function withTimeout(promise, label, timeoutMs = strictCdpTimeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Browser became unresponsive while ${label}.`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.opened = new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener(
        "error",
        () => rejectOpen(new Error("Chrome DevTools WebSocket could not connect.")),
        { once: true },
      );
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    });
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("Chrome DevTools connection closed."));
      }
      this.pending.clear();
    });
  }

  async command(method, params = {}, label = method, timeoutMs = strictCdpTimeoutMs) {
    await withTimeout(this.opened, `connecting DevTools for ${label}`, timeoutMs);
    const id = this.nextId++;
    const result = new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    const startedAt = performance.now();
    try {
      return await withTimeout(result, label, timeoutMs);
    } finally {
      if (diagnosticOutput) {
        diagnosticCommands.push({ method, label, startedAt, durationMs: performance.now() - startedAt, timeoutMs });
        if (diagnosticCommands.length > 100) diagnosticCommands.shift();
      }
      this.pending.delete(id);
    }
  }

  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  close() {
    this.socket.close();
  }
}

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function freshness(kind, date) {
  const refreshedAt = fixtureReferenceTime;
  return {
    kind,
    scopeDate: date,
    dateClass: "historical",
    status: "fresh",
    stale: false,
    usable: true,
    degraded: false,
    sourceRefreshedAt: refreshedAt,
    refreshedAt,
    expiresAt: "2099-01-01T00:00:00.000Z",
    sourceAgeSeconds: 0,
    ageSeconds: 0,
    maxAgeSeconds: 604800,
    consecutiveFailures: 0,
    lastError: null,
    refresh: {
      state: "idle",
      requestedAt: null,
      availableAt: null,
      leasedAt: null,
      attempts: 0,
      leaseExpired: false,
      lastError: null,
    },
  };
}

function fixtureVisit({
  date,
  id,
  serviceCallId,
  ticketId,
  ticketNumber,
  resourceId,
  resourceName,
  start,
  end,
  latitude,
  longitude,
  city,
}) {
  return {
    id,
    serviceCallId,
    ticketId,
    ticketNumber,
    title: "Standalone regression fixture",
    autotaskUrl: extendedMapFixture ? `https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=${ticketId}` : null,
    companyName: `Fixture Company ${ticketNumber}`,
    locationName: `Fixture Site ${ticketNumber}`,
    address: "1 Test Street",
    city,
    postcode: "M1 1AA",
    resourceId,
    resourceName,
    routeOwnerKey: String(resourceId),
    ownerType: "internal",
    ticketStatusId: 1,
    ticketStatusLabel: "Scheduled",
    queueId: 10,
    queueLabel: "Support",
    jobType: "support",
    ignoredResourceCount: 0,
    startDateTime: `${date}T${start}:00.000Z`,
    endDateTime: `${date}T${end}:00.000Z`,
    durationMinutes: 30,
    status: 1,
    isComplete: extendedMapFixture && ticketId === 2001,
    latitude,
    longitude,
    additionalTicketCount: 0,
  };
}

function schedule(date) {
  // Both dates have two routable routes, but their coordinate fingerprints differ.
  // loadRoadRoutes batches up to four routes, so one geometry POST per selected date
  // is the exact fixture budget.
  const dateOffset = date === changedDate ? 0.018 : 0;
  const result = {
    source: "autotask",
    date,
    generatedAt: fixtureReferenceTime,
    warnings: [],
    visits: [
      fixtureVisit({
        date,
        id: `fixture-${date}-north-1`,
        serviceCallId: 101,
        ticketId: 1001,
        ticketNumber: "T1001",
        resourceId: 77,
        resourceName: "Fixture North Engineer",
        start: "09:00",
        end: "09:30",
        latitude: 53.601 + dateOffset,
        longitude: -2.03,
        city: "Manchester",
      }),
      fixtureVisit({
        date,
        id: `fixture-${date}-north-2`,
        serviceCallId: 102,
        ticketId: 1002,
        ticketNumber: "T1002",
        resourceId: 77,
        resourceName: "Fixture North Engineer",
        start: "09:35",
        end: "10:05",
        latitude: 53.621 + dateOffset,
        longitude: -2.01,
        city: "Manchester",
      }),
      fixtureVisit({
        date,
        id: `fixture-${date}-midlands-1`,
        serviceCallId: 201,
        ticketId: 2001,
        ticketNumber: "T2001",
        resourceId: 78,
        resourceName: "Fixture Midlands Engineer",
        start: "09:00",
        end: "09:30",
        latitude: 52.506 + dateOffset,
        longitude: -1.91,
        city: "Birmingham",
      }),
      fixtureVisit({
        date,
        id: `fixture-${date}-midlands-2`,
        serviceCallId: 202,
        ticketId: 2002,
        ticketNumber: "T2002",
        resourceId: 78,
        resourceName: "Fixture Midlands Engineer",
        start: "09:35",
        end: "10:05",
        latitude: 52.526 + dateOffset,
        longitude: -1.89,
        city: "Birmingham",
      }),
      ...(extendedMapFixture ? [{ ...fixtureVisit({ date, id: `fixture-${date}-third-party`, serviceCallId: 301, ticketId: 3001,
        ticketNumber: "T3001", resourceId: null, resourceName: "Fixture Third Party", start: "12:00", end: "12:30",
        latitude: 53.58, longitude: -2.12, city: "Manchester" }), ownerType: "third-party", routeOwnerKey: "third-party-fixture" }] : []),
    ],
    cache: freshness("schedule", date),
  };
  if (partialMapFixture) result.visits.push(fixtureVisit({date, id:`fixture-${date}-missing`, serviceCallId:103, ticketId:1003,
    ticketNumber:"T1003", resourceId:77, resourceName:"Fixture North Engineer", start:"09:31", end:"09:34", latitude:null,longitude:null,city:"Unknown"}));
  return result;
}

function fixtureDemand() {
  const make = (id, latitude, longitude, overrides = {}) => ({
    id, autotaskUrl: `https://tickets.example.test/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=${9000 + Number(id.slice(1))}`, ticketId: 9000 + Number(id.slice(1)), ticketNumber: `D${id}`, title: "Fixture unassigned work",
    companyLabel: `Fixture Demand ${id}`, siteLabel: "Fixture Site", city: "Fixture City", postcode: "", latitude, longitude,
    durationMinutes: 60, durationSource: "assumed", routeRegion: "North", logisticsTerritory: "North", countryCode: "GB",
    territoryGroup: "North", queueId: 10, queueLabel: "Support", statusId: 1, statusLabel: "Unassigned request",
    workstream: "support", requestType: "requested", statusChangedAt: "2026-08-18T12:00:00Z", ageBand: "fresh",
    dueDate: null, dueBucket: "none", overdue: false, readiness: "eligible", exclusionReason: null, exclusionDetail: null,
    ...overrides,
  });
  return { source: "postgres-planning-demand-cache", generatedAt: fixtureReferenceTime, scopeDate: initialDate, warnings: [],
    counts: { total: 5, mapped: 4, unmapped: 1, eligible: 4, blocked: 1, aged: 2, overdue: extraMapFixture ? 2 : 1 },
    items: [make("d1", 53.609, -2.029), make("d2", 54.601, -1.201, { workstream: "install" }),
      make("d3", 53.64, -2.08, { workstream: "other", ageBand: "aged", overdue: true }),
      make("d4", 60, 10, { ...(extraMapFixture ? {overdue:true,workstream:"other",queueId:501,queueLabel:"Fixture Maintenance"} : {}), readiness: "blocked", exclusionReason: "no_covered_base", exclusionDetail: "Outside engineer coverage", ageBand: "aged" }),
      make("d5", null, null, {ticketId:null,ticketNumber:null})], cache: freshness("planning-demand", initialDate) };
}

const engineers = {
  engineers: [
    {
      id: "fixture-north-engineer",
      resourceId: 77,
      name: "Fixture North Engineer",
      base: "Manchester",
      region: "North",
      latitude: 53.4808,
      longitude: -2.2426,
      aliases: [],
      colourIndex: 0,
      active: true,
      workingDays: [1, 2, 3, 4, 5],
      workdayStart: "08:00",
      workdayEnd: "17:00",
    },
    {
      id: "fixture-midlands-engineer",
      resourceId: 78,
      name: "Fixture Midlands Engineer",
      base: "Birmingham",
      region: "Midlands",
      latitude: 52.4862,
      longitude: -1.8904,
      aliases: [],
      colourIndex: 1,
      active: true,
      workingDays: [1, 2, 3, 4, 5],
      workdayStart: "08:00",
      workdayEnd: "17:00",
    },
  ],
};

if (extendedMapFixture) engineers.engineers.push({ ...engineers.engineers[0], id: "fixture-home-engineer", resourceId: 79,
  name: "Fixture Home Engineer", base: "Home Fixture", latitude: 54.6, longitude: -1.2, colourIndex: 2 });

function routeGeometryFixture(request) {
  return {
    routes: (request.routes ?? []).map((route) => {
      const coordinates = route.coordinates ?? [];
      const legGeometries = coordinates
        .slice(1)
        .map((destination, index) => [coordinates[index], destination]);
      const missingLeg = partialMapFixture && route.id === "78" ? 1 : -1;
      if(missingLeg>=0) legGeometries[missingLeg]=[];
      const legDurationsMinutes = legGeometries.map((_,i) => i===missingLeg ? null : 12);
      const legDistancesKm = legGeometries.map((_,i) => i===missingLeg ? null : 4);
      return {
        id: route.id,
        legGeometries,
        legDurationsMinutes,
        legDistancesKm,
        legErrors: legGeometries.map((_,i) => i===missingLeg ? "Fixture unavailable road leg" : null),
        totalDurationMinutes: legDurationsMinutes.reduce(
          (total, value) => total + (value ?? 0),
          0,
        ),
        totalDistanceKm: legDistancesKm.reduce(
          (total, value) => total + (value ?? 0),
          0,
        ),
      };
    }),
  };
}

function fixtureCalendar(month) {
  return {
    source: "postgres-cache",
    month,
    generatedAt: fixtureReferenceTime,
    omittedOverAgeDays: 0,
    days: selectedDates.map((date) => ({
      date,
      calls: 4,
      complete: 0,
      scheduled: 4,
    })),
  };
}

function browserTestEnvironment(extra = {}) {
  // Do not inherit host application credentials, OAuth settings or DATABASE_URL.
  // The browser fixture intercepts every application API request before it can
  // reach the standalone server's route handlers.
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    NEXT_TELEMETRY_DISABLED: "1",
    ...extra,
  };
}

function tail(value, maximumLength = 6_000) {
  return value.length > maximumLength ? value.slice(-maximumLength) : value;
}

function buildStandaloneRuntime() {
  rmSync(distDirectory, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [nextBinary, "build"], {
    cwd: projectDirectory,
    env: browserTestEnvironment({
      NODE_ENV: "production",
      NEXT_DIST_DIR: distDirectoryName,
    }),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      [
        "next build for the standalone Dispatch Review regression failed.",
        result.error?.message,
        result.signal ? `signal: ${result.signal}` : null,
        result.stdout ? tail(result.stdout) : null,
        result.stderr ? tail(result.stderr) : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  assert.equal(
    existsSync(standaloneServerPath),
    true,
    `next build must emit ${standaloneServerPath}`,
  );
}

function prepareStandaloneAssets() {
  const publicSource = resolve(projectDirectory, "public");
  const staticSource = resolve(distDirectory, "static");
  const publicDestination = resolve(standaloneDirectory, "public");
  // NEXT_DIST_DIR is serialized into server.js, so this is the custom-distDir
  // equivalent of Docker's .next/static -> standalone/.next/static copy.
  const staticDestination = resolve(
    standaloneDirectory,
    distDirectoryName,
    "static",
  );

  assert.equal(existsSync(publicSource), true, "the production public directory must exist");
  assert.equal(existsSync(staticSource), true, "next build must emit static assets");
  mkdirSync(resolve(standaloneDirectory, distDirectoryName), { recursive: true });
  cpSync(publicSource, publicDestination, { recursive: true, force: true });
  cpSync(staticSource, staticDestination, { recursive: true, force: true });
  assert.equal(existsSync(publicDestination), true, "standalone public assets must be copied");
  assert.equal(existsSync(staticDestination), true, "standalone static assets must be copied");

  return { publicDestination, staticDestination };
}

function attachProcessOutput(child) {
  let output = "";
  const append = (chunk) => {
    output = tail(`${output}${chunk}`);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output;
}

function processIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code !== "ESRCH";
  }
}

function processGroupMembers(processGroupId) {
  const result = spawnSync("ps", ["-eo", "pid=,pgid="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => Number.isInteger(pid) && pgid === processGroupId)
    .map(([pid]) => pid);
}

function processesContaining(fragment) {
  const result = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(fragment))
    .map((line) => Number(line.split(/\s+/, 1)[0]))
    .filter(Number.isInteger);
}

async function stopProcessTree(child, label) {
  const pid = child?.pid;
  if (!pid) {
    return { label, pid: null, stopped: true, remainingGroupMembers: [] };
  }

  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      child.kill(signal);
    }
  };

  signalGroup("SIGTERM");
  try {
    await waitFor(
      () => !processIsAlive(pid) && processGroupMembers(pid).length === 0,
      `${label} process group cleanup`,
      1_500,
      40,
    );
  } catch {
    signalGroup("SIGKILL");
    await waitFor(
      () => !processIsAlive(pid) && processGroupMembers(pid).length === 0,
      `${label} forced process group cleanup`,
      1_500,
      40,
    ).catch(() => undefined);
  }

  const remainingGroupMembers = processGroupMembers(pid);
  return {
    label,
    pid,
    stopped: !processIsAlive(pid) && remainingGroupMembers.length === 0,
    remainingGroupMembers,
  };
}

const coldMapReadyExpression = `new Promise(resolve => {
  let readyFrames = 0;
  function check() {
    const host = document.querySelector('.audit-map');
    const diagnostics = host?.reviewMapDiagnostics?.();
    const ready = document.querySelector('#map-tool-date') &&
      host?.dataset.mapStyleReady === 'true' &&
      diagnostics?.ready &&
      diagnostics.renderedPointIds?.some(id => id.startsWith('visit:'));
    readyFrames = ready ? readyFrames + 1 : 0;
    if (readyFrames >= 2) resolve(true);
    else setTimeout(check, 100);
  }
  setTimeout(check, 100);
})`;

function waitForColdMapStartup(client) {
  return evaluate(client, coldMapReadyExpression, "waiting for cold map readiness", coldStartupTimeoutMs);
}

async function evaluate(client, expression, label = "evaluating the page", timeoutMs = strictCdpTimeoutMs) {
  const response = await client.command(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    label,
    timeoutMs,
  );
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        `Evaluation failed while ${label}.`,
    );
  }
  return response.result?.value;
}

async function clickElement(client, selector, label) {
  const clicked = await evaluate(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
    `clicking ${label}`,
  );
  assert.equal(clicked, true, `${label} should exist`);
}

async function selectElementValue(client, selector, value, label) {
  const selected = await evaluate(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLSelectElement)) return null;
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return element.value;
    })()`,
    `changing ${label}`,
  );
  assert.equal(selected, value, `${label} should accept ${value}`);
}

async function pressKey(client, key, code = key) {
  const dispatched = await evaluate(
    client,
    `(() => {
      const element = document.querySelector(".audit-map");
      if (!(element instanceof HTMLElement)) return false;
      element.focus();
      for (const type of ["keydown", "keyup"]) {
        element.dispatchEvent(new KeyboardEvent(type, {
          key: ${JSON.stringify(key)},
          code: ${JSON.stringify(code)},
          bubbles: true,
          cancelable: true,
        }));
      }
      return true;
    })()`,
    `pressing ${key}`,
  );
  assert.equal(dispatched, true, "the map keyboard target should exist");
}

async function markerPosition(client) {
  return evaluate(
    client,
    `(() => {
      const map = document.querySelector('.audit-map');
      // Read only this fixture point's projection. The full diagnostic also
      // queries every rendered hit layer, which is unrelated to camera movement.
      return map?.reviewMapDiagnostics?.(${JSON.stringify(`visit:fixture-${initialDate}-north-1`)}).firstVisit ?? null;
    })()`,
    "reading the booked marker position",
  );
}

async function installStableNodeMonitor(client) {
  return evaluate(
    client,
    `(() => {
      const input = document.querySelector('input[aria-label="Engineer route"]');
      if (!(input instanceof HTMLInputElement)) return null;
      const originalOwnDescriptor = Object.getOwnPropertyDescriptor(input, "value");
      const prototypeDescriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      );
      const descriptor = originalOwnDescriptor ?? prototypeDescriptor;
      if (!descriptor?.get || !descriptor?.set) return null;
      const monitor = {
        input,
        originalOwnDescriptor,
        getter: descriptor.get,
        setter: descriptor.set,
        writeCount: 0,
        replacementCount: 0,
        observer: null,
      };
      monitor.observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const removed of record.removedNodes) {
            if (
              removed === input ||
              (removed instanceof Element && removed.contains(input))
            ) {
              monitor.replacementCount += 1;
            }
          }
        }
      });
      // Count only removal/replacement of the stable node, not unrelated React
      // aria/class attribute updates in its surrounding layout.
      monitor.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      Object.defineProperty(input, "value", {
        configurable: true,
        enumerable: descriptor.enumerable ?? true,
        get() {
          return monitor.getter.call(this);
        },
        set(value) {
          monitor.writeCount += 1;
          return monitor.setter.call(this, value);
        },
      });
      window.__dispatchStableNodeMonitor = monitor;
      return { connected: input.isConnected, initialValue: input.value };
    })()`,
    "installing the stable engineer-search monitor",
  );
}

async function readStableNodeMonitor(client) {
  return evaluate(
    client,
    `(() => {
      const monitor = window.__dispatchStableNodeMonitor;
      if (!monitor) return null;
      return {
        writes: monitor.writeCount,
        replacements: monitor.replacementCount,
        connected: monitor.input.isConnected,
        sameNode: document.querySelector('input[aria-label="Engineer route"]') === monitor.input,
      };
    })()`,
    "reading the stable engineer-search monitor",
  );
}

async function clearPageInstrumentation(client) {
  if (!client) return;
  await evaluate(
    client,
    `(() => {
      clearInterval(window.__dispatchHeartbeatTimer);
      const monitor = window.__dispatchStableNodeMonitor;
      if (monitor) {
        monitor.observer?.disconnect();
        if (monitor.originalOwnDescriptor) {
          Object.defineProperty(monitor.input, "value", monitor.originalOwnDescriptor);
        } else {
          delete monitor.input.value;
        }
        delete window.__dispatchStableNodeMonitor;
      }
      return true;
    })()`,
    "removing browser regression instrumentation",
  ).catch(() => undefined);
}

/**
 * A two-date happy path naturally has S,G,S,G (four relevant events). A storm
 * needs at least three near-equal alternating schedule/geometry cycles before
 * it is classified as the original render-effect feedback pattern.
 */
function sustainedScheduleGeometryAlternation(events) {
  const relevant = events.filter(
    (event) => event.kind === "schedule" || event.kind === "geometry",
  );
  let longestRun = [];
  let currentRun = [];

  for (const event of relevant) {
    const previous = currentRun.at(-1);
    if (!previous || previous.kind !== event.kind) {
      currentRun.push(event);
    } else {
      currentRun = [event];
    }
    if (currentRun.length > longestRun.length) longestRun = [...currentRun];
  }

  const scheduleCount = longestRun.filter((event) => event.kind === "schedule").length;
  const geometryCount = longestRun.filter((event) => event.kind === "geometry").length;
  return {
    detected:
      longestRun.length > maxAlternatingRunBeforeFailure &&
      Math.abs(scheduleCount - geometryCount) <= 1,
    relevantEventCount: relevant.length,
    longestRunLength: longestRun.length,
    scheduleCount,
    geometryCount,
    threshold: maxAlternatingRunBeforeFailure + 1,
  };
}

test("the alternating request detector rejects an original-bug-shaped storm", () => {
  const originalBugShapedEvents = Array.from({ length: 12 }, (_, index) => ({
    kind: index % 2 === 0 ? "schedule" : "geometry",
    at: index * 20,
  }));
  const normalTwoDateEvents = [
    { kind: "schedule", at: 0 },
    { kind: "geometry", at: 20 },
    { kind: "schedule", at: 300 },
    { kind: "geometry", at: 320 },
  ];

  const storm = sustainedScheduleGeometryAlternation(originalBugShapedEvents);
  assert.equal(storm.detected, true);
  assert.equal(storm.longestRunLength, 12);
  assert.deepEqual(
    [storm.scheduleCount, storm.geometryCount],
    [6, 6],
    "the detector must reject sustained near-1:1 schedule/geometry alternation",
  );
  assert.equal(
    sustainedScheduleGeometryAlternation(normalTwoDateEvents).detected,
    false,
    "the permitted two-date fixture sequence must not be mistaken for a storm",
  );
});

test("camera probes request one fixture projection without full rendered-feature diagnostics", async () => {
  const ids = [];
  const position = { left: 12, top: 34, transform: "12,34,5" };
  const client = { command: async (_method, { expression }, _label, timeout) => {
    assert.equal(timeout, 1_500);
    const document = { querySelector: () => ({ reviewMapDiagnostics: id => {
      assert.equal(id, `visit:fixture-${initialDate}-north-1`);
      ids.push(id);
      return { firstVisit: position };
    } }) };
    return { result: { value: new Function("document", `return ${expression}`)(document) } };
  } };
  assert.deepEqual(await markerPosition(client), position);
  assert.equal(ids.length, 1);
});

test("cold startup gets a bounded budget without changing interaction deadlines", async () => {
  const calls = [];
  const client = { command: async (...args) => {
    calls.push(args);
    return { result: { value: true } };
  } };
  await waitForColdMapStartup(client);
  await evaluate(client, "true", "post-readiness interaction");
  assert.equal(calls[0][3], 15_000);
  assert.equal(calls[1][3], 1_500);
  assert.equal(calls[0][1].awaitPromise, true);
});

test("cold readiness requires rendered visits and two ready samples, not projected coordinates", async () => {
  const frames = [];
  let ready = false;
  let renderedPointIds = [];
  const host = { dataset: { mapStyleReady: 'true' }, reviewMapDiagnostics: () => ({
    firstVisit: { left: 1, top: 1 }, ready, renderedPointIds,
  }) };
  const document = { querySelector: selector => selector === '.audit-map' ? host : {} };
  const pending = new Function('document', 'setTimeout', `return ${coldMapReadyExpression}`)(document, callback => frames.push(callback));
  let settled = false;
  pending.then(() => { settled = true; });
  frames.shift()(); await Promise.resolve();
  assert.equal(settled, false, 'projected coordinates alone cannot admit interactions');
  ready = true;
  frames.shift()(); await Promise.resolve();
  assert.equal(settled, false, 'style readiness alone cannot admit interactions');
  renderedPointIds = ['visit:fixture'];
  frames.shift()(); await Promise.resolve();
  assert.equal(settled, false, 'wait for a second rendered sample');
  frames.shift()(); await pending;
  assert.equal(settled, true);
});

test("a post-readiness CDP stall is still rejected at 1500ms", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = withTimeout(new Promise(() => {}), 'post-readiness interaction');
  const rejected = assert.rejects(result, /Browser became unresponsive while post-readiness interaction/);
  t.mock.timers.tick(1500);
  await rejected;
});

test(
  "Dispatch Review standalone production runtime bounds schedule/geometry work and stays responsive",
  { skip: !chromePath && !browserRequired, timeout: stressMap ? 240_000 : 150_000 },
  async () => {
    assert.ok(
      chromePath,
      "Chrome/Chromium is required for the standalone Dispatch Review browser regression.",
    );
    assert.equal(
      typeof WebSocket,
      "function",
      "Node must provide the WebSocket client used by CDP.",
    );

    let server;
    let chrome;
    let client;
    let getServerOutput = () => "";
    let getChromeOutput = () => "";
    let firstScheduleRequestAt = null;
    let interceptionError;
    let evidence;
    let phase = "pre-build";
    let heartbeatBeforeInteractions = null;
    let heartbeatAfterInteractions = null;
    let finalCdpDurationMs = null;
    let finalDom = null;
    let stableNode = null;
    const profileDirectory = mkdtempSync(resolve(tmpdir(), "dispatch-browser-"));
    const scheduleRequestsByDate = new Map(selectedDates.map((date) => [date, 0]));
    const apiRequestEvents = [];
    const unexpectedApiRequests = [];
    const browserErrors = [];
    const externalFixtureRequests = [];
    const apiNetworkUrls = new Map();
    let calendarRequests = 0;
    let engineerRequests = 0;
    let geometryPosts = 0;
    let totalApiRequests = 0;
    let response429Count = 0;
    let failedApiRequestCount = 0;
    let cleanup;
    let extendedEvidence;
    let stressEvidence;
    let refreshMode = "initial";
    let demandRevision = 0;
    let overlapDemand = false;
    let scheduleRevision = 0;
    const refreshEvents = [];
    const cacheReadEvents = [];
    let automaticPollCount = 0;
    let automaticPollMaximum = 0;
    let failStyles = false;
    const heldRoads=[],heldSchedules=[];
    let delayRoads=asyncMap,delaySchedule=asyncMap;

    try {
      phase = "building standalone runtime";
      buildStandaloneRuntime();
      const standaloneAssets = prepareStandaloneAssets();

      server = spawn(process.execPath, ["server.js"], {
        cwd: standaloneDirectory,
        env: browserTestEnvironment({
          NODE_ENV: "production",
          PORT: String(appPort),
          HOSTNAME: "127.0.0.1",
          AUTH_MODE: "development",
          DEV_PAGE_PERMISSIONS: "dispatch_review,engineer_management",
          NEXT_DIST_DIR: distDirectoryName,
        }),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      getServerOutput = attachProcessOutput(server);

      await waitFor(async () => {
        if (server.exitCode !== null) {
          throw new Error(
            `standalone server exited before readiness (${server.exitCode}): ${getServerOutput()}`,
          );
        }
        try {
          return (await fetch(`${origin}/`, { signal: AbortSignal.timeout(1_000) })).ok;
        } catch {
          return false;
        }
      }, "the generated standalone server.js", 12_000);

      chrome = spawn(
        chromePath,
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--window-size=1440,1000",
          "--enable-webgl",
          "--ignore-gpu-blocklist",
          ...(hardwareGpu ? [] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
          "--remote-debugging-address=127.0.0.1",
          `--remote-debugging-port=${debugPort}`,
          `--user-data-dir=${profileDirectory}`,
          "about:blank",
        ],
        { stdio: diagnosticOutput ? ["ignore", "pipe", "pipe"] : "ignore", detached: true },
      );
      if (diagnosticOutput) getChromeOutput = attachProcessOutput(chrome);

      const target = await waitFor(async () => {
        if (chrome.exitCode !== null || chrome.signalCode !== null) {
          throw new Error(`Chrome exited before DevTools was ready (${chrome.exitCode ?? chrome.signalCode})`);
        }
        try {
          const response = await fetch(
            `http://127.0.0.1:${debugPort}/json/list`,
            { signal: AbortSignal.timeout(500) },
          );
          const targets = await response.json();
          return (
            targets.find(
              (candidate) =>
                candidate.type === "page" && candidate.webSocketDebuggerUrl,
            ) ?? false
          );
        } catch {
          return false;
        }
      }, "the Chrome DevTools endpoint", 8_000).catch((error) => {
        // Chrome's own output is the only evidence of why it never listened.
        throw new Error(`${error.message}\nChrome output:\n${getChromeOutput().slice(-4_000) || "(none captured)"}`);
      });

      client = new CdpClient(target.webSocketDebuggerUrl);
      await client.command("Page.enable");
      await client.command("Runtime.enable");
      client.on("Runtime.exceptionThrown", (event) => browserErrors.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text));
      await client.command("Network.enable");
      if (diagnosticOutput) {
        console.log("[dispatch-startup-diagnostics] browser:", await client.command("Browser.getVersion"));
        if (profileStartup) {
        await client.command("Profiler.enable");
        await client.command("Profiler.setSamplingInterval", { interval: 1000 });
        await client.command("Profiler.start");
        await client.command("Tracing.start", {
          categories: "devtools.timeline,v8,blink,cc,gpu,disabled-by-default-devtools.timeline",
          transferMode: "ReturnAsStream",
        });
        }
        await client.command("Page.addScriptToEvaluateOnNewDocument", { source: `
          window.__dispatchStartupDiagnostics = { events: [], longTasks: [] };
          window.addEventListener('review-map-comparison', event => {
            const data = window.__dispatchStartupDiagnostics.events;
            if (data.length < 100) data.push(event.detail);
          });
          new PerformanceObserver(list => {
            const data = window.__dispatchStartupDiagnostics.longTasks;
            for (const entry of list.getEntries()) {
              if (data.length < 100) data.push({start: entry.startTime, duration: entry.duration});
            }
          }).observe({type: 'longtask', buffered: true});
        ` });
      }
      // The request-budget fixture starts with a settled roster. A schedule
      // arriving first legitimately changes routing inputs when bases arrive.
      await client.command("Page.addScriptToEvaluateOnNewDocument", { source: `
        window.__fixtureRosterReady = new Promise(resolve => {
          const originalFetch = window.fetch;
          window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            if (new URL(String(args[0]), location.href).pathname === '/api/engineers') {
              const originalJson = response.json.bind(response);
              response.json = async () => {
                const body = await originalJson();
                requestAnimationFrame(() => requestAnimationFrame(resolve));
                return body;
              };
            }
            return response;
          };
        });
      ` });
      if (slowStartupControl) {
        await client.command("Page.addScriptToEvaluateOnNewDocument", { source: `
          window.addEventListener('review-map-comparison', function slowStartup(event) {
            if (event.detail.name !== 'style-loaded') return;
            window.removeEventListener('review-map-comparison', slowStartup);
            const deadline = performance.now() + 2000;
            while (performance.now() < deadline) { /* bounded cold-start regression control */ }
          });
        ` });
      }
      if (comparisonOutput) {
        await client.command("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: comparisonMotion }],
        });
        await client.command("Page.addScriptToEvaluateOnNewDocument", { source: `
          window.__mapComparison = { frames: [], frameTimes: [], longTasks: [], nativeEvents: [], apiResponses: [], cache304Probes: [] };
          window.addEventListener('review-map-comparison',event=>{
            window.__mapComparison.nativeEvents.push(event.detail);
            if(event.detail.name==='camera-end') requestAnimationFrame(()=>window.__mapComparison.nativeEvents.push({engine:event.detail.engine,name:'camera-end-next-frame',at:performance.now()}));
          });
          const comparisonFetch = window.fetch;
          window.fetch = async (...args) => {
            const startedAt=performance.now(),host=document.querySelector('.audit-map'),control=window.__cacheRefreshControl || 'automatic';
            const response = await comparisonFetch(...args);
            const path = new URL(args[0] instanceof Request ? args[0].url : String(args[0]),location.href).pathname;
            if(path.startsWith('/api/')) window.__mapComparison.apiResponses.push({path,status:response.status,at:performance.now(),startedAt,control});
            if(response.status===304) requestAnimationFrame(()=>requestAnimationFrame(()=>{
              const endedAt=performance.now();
              window.__mapComparison.cache304Probes.push({path,startedAt,endedAt,control,sameHost:host===document.querySelector('.audit-map'),
                publications:window.__mapComparison.nativeEvents.filter(e=>e.at>=startedAt&&e.at<=endedAt&&e.name.startsWith('publication:')&&!e.name.endsWith('review-focus'))});
            }));
            return response;
          };
          function observeVisibleBookedPoint() {
            const host=document.querySelector('.audit-map');
            let visible=false;
            visible=host?.reviewMapDiagnostics?.().renderedPointIds?.some(id=>id.startsWith('visit:'));
            if(visible) {window.__mapComparison.firstVisibleBookedPointMs=performance.now();return;}
            if(performance.now()<15000) requestAnimationFrame(observeVisibleBookedPoint);
          }
          if (!${startupOnly}) requestAnimationFrame(observeVisibleBookedPoint);
          let previous;
          function frame(now) {
            if (previous !== undefined) { window.__mapComparison.frames.push(now - previous); window.__mapComparison.frameTimes.push({start:previous, duration:now-previous}); }
            previous = now;
            requestAnimationFrame(frame);
          }
          if (${process.env.MAP_TEST_SAMPLE !== "0"}) requestAnimationFrame(frame);
          if (${process.env.MAP_TEST_SAMPLE !== "0"}) new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
              window.__mapComparison.longTasks.push({ start: entry.startTime, duration: entry.duration });
            }
          }).observe({ type: 'longtask', buffered: true });
        ` });
      }
      // Cache hard expiry is recomputed in the browser. Keep its advancing clock
      // aligned with fixture freshness instead of letting the fixture age out.
      await client.command("Page.addScriptToEvaluateOnNewDocument", { source: `
          const RealDate = Date;
          const fixtureEpoch = new RealDate(${JSON.stringify(fixtureReferenceTime)}).getTime();
          const fixtureClockStart = performance.now();
          window.__cacheClockOffset = 0;
          const fixtureNow = () => Math.floor(fixtureEpoch + performance.now() - fixtureClockStart + window.__cacheClockOffset);
          window.Date = class extends RealDate {
            constructor(...args) { super(...(args.length ? args : [fixtureNow()])); }
            static now() { return fixtureNow(); }
          };
      ` });
      if (webglInitFailure) {
        assert.equal(requestedEngine, "maplibre");
        await client.command("Page.addScriptToEvaluateOnNewDocument", { source: `
          const getContext = HTMLCanvasElement.prototype.getContext;
          window.__webglAttempts = 0;
          HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
            if (kind === 'webgl2' || kind === 'webgl') { window.__webglAttempts++; return null; }
            return getContext.call(this, kind, ...args);
          };
        ` });
      }
      await client.command("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });

      client.on("Network.requestWillBeSent", (event) => {
        if (event.request?.url?.startsWith(`${origin}/api/`)) {
          apiNetworkUrls.set(event.requestId, event.request.url);
        }
      });
      client.on("Network.responseReceived", (event) => {
        if (
          apiNetworkUrls.has(event.requestId) &&
          event.response?.status === 429
        ) {
          response429Count += 1;
        }
      });
      client.on("Network.loadingFailed", (event) => {
        if (apiNetworkUrls.has(event.requestId)) failedApiRequestCount += 1;
      });

      let uiCleanup = false;
      let heldEditorSave;
      const uiRequests = [];
      const fulfill = async (event, responseCode, body, headers = []) => {
        await client.command(
          "Fetch.fulfillRequest",
          {
            requestId: event.requestId,
            responseCode,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              ...headers,
            ],
            ...(body === undefined ? {} : {body: jsonBody(body)}),
          },
          `fulfilling ${event.request.url}`,
          3_000,
        );
      };

      const markUnexpectedApiRequest = async (event, url, reason) => {
        const message = `${event.request.method} ${url.pathname}${url.search}: ${reason}`;
        unexpectedApiRequests.push(message);
        if (!interceptionError) {
          interceptionError = new Error(`Unexpected fixture API request: ${message}`);
        }
        await fulfill(
          event,
          599,
          { message: "Browser regression fixture rejected this API request." },
        );
      };

      const markUnexpectedExternalRequest = async (event, url, reason) => {
        const message = `${event.request.method} ${url.toString()}: ${reason}`;
        externalFixtureRequests.push(`REJECTED ${message}`);
        if (!interceptionError) {
          interceptionError = new Error(`Unexpected fixture external request: ${message}`);
        }
        await fulfill(
          event,
          599,
          { message: "Browser regression fixture rejected this external request." },
        );
      };

      client.on("Fetch.requestPaused", (event) => {
        void (async () => {
          const url = new URL(event.request.url);
          if (url.origin !== origin) {
            const request = `${event.request.method} ${url.toString()}`;
            // No external provider is contacted. Only the two literal styles used
            // by route-map-basemap.ts may be requested, and each gets an in-memory
            // fixture response before the browser can reach the network.
            const localAsset=event.request.method === "GET" && localBasemapAsset(url.toString());
            if(localAsset && !failStyles) {
              externalFixtureRequests.push(request);
              await client.command("Fetch.fulfillRequest",{requestId:event.requestId,responseCode:200,
                responseHeaders:[{name:"Content-Type",value:localAsset.mime},{name:"Access-Control-Allow-Origin",value:"*"}],body:localAsset.body});
              return;
            }
            if (basemapManifest && !failStyles) {
              await markUnexpectedExternalRequest(event,url,"asset missing from the local basemap manifest");
              return;
            }
            if (
              event.request.method !== "GET" ||
              !permittedExternalStyleUrls.has(url.toString())
            ) {
              await markUnexpectedExternalRequest(
                event,
                url,
                "origin, method or path is outside the OpenFreeMap style allow-list",
              );
              return;
            }
            externalFixtureRequests.push(request);
            if (failStyles) { await fulfill(event, 503, {message:"Deterministic style failure"}, [{name:"Access-Control-Allow-Origin", value:"*"}]); return; }
            const mapStyle = {
              version: 8,
              sources: {},
              layers: [
                {
                  id: "dispatch-browser-fixture-background",
                  type: "background",
                  paint: { "background-color": url.pathname.endsWith("/fiord") ? "#1a2530" : "#dfe8ed" },
                },
              ],
            };
            await fulfill(event, 200, mapStyle, [{ name: "Access-Control-Allow-Origin", value: "*" }]);
            return;
          }

          if (uiCleanup && url.pathname === "/logout") {
            await client.command("Fetch.fulfillRequest", {
              requestId: event.requestId, responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: "text/html" }],
              body: Buffer.from("<!doctype html><h1>Logout fixture</h1>").toString("base64"),
            });
            return;
          }
          if (!url.pathname.startsWith("/api/")) {
            await client.command(
              "Fetch.continueRequest",
              { requestId: event.requestId },
              `continuing ${url.pathname}`,
              3_000,
            );
            return;
          }

          if (uiCleanup) {
            const key = `${event.request.method} ${url.pathname}${url.search}`;
            uiRequests.push(key);
            if (key === "GET /api/engineers") await fulfill(event, 200, engineers);
            else if (key === "GET /api/engineers/third-party-statuses") await fulfill(event, 200, { statuses: [] });
            else if (key === "POST /api/engineers") heldEditorSave = () => fulfill(event, 400, { message: "Fixture save rejected" });
            else await markUnexpectedApiRequest(event, url, "endpoint is outside the editor fixture");
            return;
          }
          totalApiRequests += 1;
          if (extendedMapFixture && url.pathname === "/api/planning-demand" && event.request.method === "GET") {
            const body = fixtureDemand();
            body.generatedAt = new Date(Date.parse(fixtureReferenceTime) + demandRevision * 60_000).toISOString();
            if (demandRevision) body.items[0].companyLabel = "Fixture Demand refreshed";
            if (overlapDemand) {const visit=schedule(changedDate).visits[0]; body.items[0].latitude = visit.latitude + (scheduleRevision ? .002 : 0); body.items[0].longitude = visit.longitude;}
            const etag = `"fixture-demand-${demandRevision}"`;
            const conditional = Object.entries(event.request.headers).find(([key]) => key.toLowerCase() === "if-none-match")?.[1];
            const code = stressMap && conditional === etag ? 304 : 200;
            cacheReadEvents.push({kind:"demand",conditional,code,control:refreshMode,at:performance.now()});
            if (refreshMode !== "initial") refreshEvents.push({kind:"demand", conditional, code, revision:demandRevision});
            await fulfill(event, code, code === 304 ? undefined : body, [{name:"ETag", value:etag}]);
            return;
          }
          if (
            url.pathname === "/api/autotask-schedule" &&
            event.request.method === "GET" &&
            url.searchParams.has("month") &&
            !url.searchParams.has("date")
          ) {
            calendarRequests += 1;
            await fulfill(event, 200, fixtureCalendar(url.searchParams.get("month")));
            return;
          }

          if (
            url.pathname === "/api/autotask-schedule" &&
            event.request.method === "GET" &&
            url.searchParams.has("date") &&
            !url.searchParams.has("month")
          ) {
            const date = url.searchParams.get("date");
            if (!scheduleRequestsByDate.has(date)) {
              await markUnexpectedApiRequest(event, url, "date is outside the cache fixture");
              return;
            }
            if (firstScheduleRequestAt === null) firstScheduleRequestAt = Date.now();
            scheduleRequestsByDate.set(date, scheduleRequestsByDate.get(date) + 1);
            apiRequestEvents.push({ kind: "schedule", date, at: Date.now() });
            const body = schedule(date);
            body.generatedAt = new Date(Date.parse(fixtureReferenceTime) + scheduleRevision * 60_000).toISOString();
            if (scheduleRevision) body.visits[0].latitude += .002;
            const etag = `"fixture-${date}-${scheduleRevision}"`;
            const conditional = Object.entries(event.request.headers).find(([key]) => key.toLowerCase() === "if-none-match")?.[1];
            const code = stressMap && conditional === etag ? 304 : 200;
            cacheReadEvents.push({kind:"schedule",date,conditional,code,control:refreshMode,at:performance.now()});
            if (refreshMode !== "initial") refreshEvents.push({kind:"schedule", conditional, code, revision:scheduleRevision});
            if (date === initialDate && scheduleRequestsByDate.get(date) === 1) {
              await evaluate(client, "window.__fixtureRosterReady", "settling fixture roster before initial schedule", coldStartupTimeoutMs);
            }
            const send=()=>fulfill(event, code, code === 304 ? undefined : body, [{name:"ETag", value:etag}]);
            if(delaySchedule && date===changedDate) heldSchedules.push(send); else await send();
            return;
          }

          if (
            url.pathname === "/api/engineers" &&
            event.request.method === "GET" &&
            !url.search
          ) {
            engineerRequests += 1;
            await fulfill(event, 200, engineers);
            return;
          }

          if (
            url.pathname === "/api/route-geometry" &&
            event.request.method === "POST"
          ) {
            let request;
            try {
              request = JSON.parse(event.request.postData || "{}");
            } catch {
              await markUnexpectedApiRequest(event, url, "geometry body was not JSON");
              return;
            }
            geometryPosts += 1;
            apiRequestEvents.push({ kind: "geometry", at: Date.now() });
            const send=()=>fulfill(event, 200, routeGeometryFixture(request));
            if(delayRoads)heldRoads.push(send);else await send();
            return;
          }

          await markUnexpectedApiRequest(event, url, "endpoint or method is not fixture-approved");
        })().catch((error) => {
          if (!interceptionError) interceptionError = error;
        });
      });

      let finishStartup;
      if(startupOnly) {
        const {startStartupTrace}=await import("./map-startup-trace.mjs");
        finishStartup=await startStartupTrace({client,evaluate,delay,waitFor,output:comparisonOutput});
      }
      phase = "hydrating initial selected date";
      await client.command(
        "Page.navigate",
        { url: `${origin}/?date=${initialDate}&mapDiagnostics=1${engineOverride ? `&mapEngine=${engineOverride}` : ""}` },
        "navigating to standalone Dispatch Review",
        3_000,
      );

      if(startupOnly) {
        const pixels=await finishStartup();
        const metrics=await evaluate(client,'window.__mapComparison','startup lifecycle trace');
        const environment=await evaluate(client,`(()=>{const host=document.querySelector('.audit-map'),canvas=document.querySelector('.maplibregl-canvas');const gl=canvas?.getContext('webgl2')??canvas?.getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return {engine:host.dataset.mapEngine,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],devicePixelRatio,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};})()`,'startup environment');
        assert.equal(environment.engine,requestedEngine); assert.equal(environment.reducedMotion,comparisonMotion==='reduce');
        assert.equal(geometryPosts,1,'startup uses one canonical geometry batch');
        assert.equal(interceptionError,undefined); assert.deepEqual(unexpectedApiRequests,[]); assert.deepEqual(browserErrors,[]);
        writeFileSync(resolve(comparisonOutput,'startup-trace.json'),JSON.stringify({engine:requestedEngine,motion:comparisonMotion,sampling:process.env.MAP_TEST_SAMPLE!=='0',pixels,metrics,environment,geometryPosts,totalApiRequests},null,2));
        phase='passed assertions'; return;
      }

      if (webglInitFailure) {
        phase = "WebGL initialization degradation";
        await waitFor(() => evaluate(client, "document.querySelector('.audit-map')?.dataset.basemap === 'unavailable'", "checking initial graphics failure"), "initial WebGL degraded state");
        await evaluate(client, "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Start reviewing')?.click()", "dismissing onboarding");
        await pressKey(client, "t", "KeyT");
        await waitFor(() => evaluate(client, `Boolean(document.querySelector('[data-detail-visit-id="fixture-${initialDate}-north-1"]'))`, "checking degraded Timeline"), "Timeline without WebGL");
        await clickElement(client, `[data-detail-visit-id="fixture-${initialDate}-north-1"]`, "select visit without WebGL");
        await pressKey(client, "Enter", "Enter");
        await waitFor(() => evaluate(client, "Boolean(document.querySelector('[role=dialog][aria-modal=true]'))", "checking degraded detail"), "details without WebGL");
        await delay(300);
        assert.equal(await evaluate(client, "document.querySelectorAll('.maplibregl-canvas').length", "checking failed-canvas cleanup"), 0);
        assert.ok(await evaluate(client, "window.__webglAttempts <= 2", "checking no graphics retry loop"));
        assert.equal(scheduleRequestsByDate.get(initialDate), 1);
        assert.equal(geometryPosts, 1);
        assert.equal(totalApiRequests, extendedMapFixture ? 4 : 3);
        assert.deepEqual(unexpectedApiRequests, []);
        assert.deepEqual(externalFixtureRequests, []);
        assert.deepEqual(browserErrors, [], "initialization failure remains contained without unexpected browser exceptions");
        if(comparisonOutput) {
          mkdirSync(comparisonOutput,{recursive:true});
          writeFileSync(resolve(comparisonOutput,"initialization-failure.json"),JSON.stringify({engine:requestedEngine,totalApiRequests,geometryPosts,browserErrors,
            state:await evaluate(client,"({attempts:window.__webglAttempts,canvases:document.querySelectorAll('.maplibregl-canvas').length,status:document.querySelector('.audit-map').dataset.basemap,details:document.querySelector('[role=dialog][aria-modal=true]')?.textContent.includes('T1001')})","recording contained initialization failure")},null,2));
        }
        phase = "passed assertions";
        return;
      }

      // Projectable scene coordinates are not rendered readiness. Chrome's cold
      // SwiftShader compositor can block for several seconds before style load.
      // One finite request budget covers this phase; all later CDP reads remain strict.
      await waitForColdMapStartup(client);
      assert.equal(interceptionError, undefined);
      assert.equal(scheduleRequestsByDate.get(initialDate), 1);

      assert.equal(await evaluate(client,
        "document.querySelector('.audit-map')?.dataset.mapEngine",
        "checking the requested renderer"), requestedEngine,
        "the default workspace must use MapLibre");
      await waitFor(
        async () =>
          (await evaluate(
            client,
            "document.querySelector('.audit-map')?.dataset.mapStyleReady === 'true' ? document.querySelector('.audit-map')?.dataset.basemap : null",
            "checking the MapLibre basemap",
          )) === "maplibre",
        "the MapLibre basemap",
      );
      await waitFor(
        () => geometryPosts === 1,
        "the initial bounded geometry POST",
      );
      // Every fixture starts with a fresh profile. Dismiss the real onboarding
      // dialog before operating the map, whether or not evidence capture is enabled.
      const startReviewing = '[role="dialog"][aria-labelledby="help-overlay-title"] .help-overlay-done';
      await waitFor(() => evaluate(client, `Boolean(document.querySelector(${JSON.stringify(startReviewing)}))`), "initial quick guide");
      await clickElement(client, startReviewing, "Start reviewing");
      await waitFor(() => evaluate(client, "!document.querySelector('[role=dialog][aria-labelledby=help-overlay-title]')"), "dismissed quick guide");
      await evaluate(client, "void (window.__existingMap = document.querySelector('.audit-map'))", "remembering default renderer");
      for (const value of ["legacy", "maplibre", "unknown", engineOverride || null]) {
        await evaluate(client, `(()=>{const url=new URL(location.href);${value === null ? "url.searchParams.delete('mapEngine')" : `url.searchParams.set('mapEngine',${JSON.stringify(value)})`};history.replaceState(null,'',url);})()`, "checking retired engine URL compatibility");
        await delay(60);
        assert.equal(await evaluate(client, "window.__existingMap === document.querySelector('.audit-map')", "checking stable renderer"), true, "old engine parameters cannot remount the map");
      }
      await evaluate(client, "delete window.__existingMap", "ending engine compatibility check");
      if (comparisonOutput) {
        await evaluate(client, `(() => {
          window.__mapComparison.initialUsableMs = performance.now();
          const canvas = document.querySelector('.maplibregl-canvas');
          const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
          const ext = gl?.getExtension('WEBGL_debug_renderer_info');
          window.__mapComparison.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
        })()`, "recording first observed usable map after onboarding");
      }
      if(process.env.MAP_TEST_NATIVE_RELEASE === "1") {
        assert.ok(requestedEngine === "maplibre" && extendedMapFixture && comparisonOutput, "native release requires candidate extended fixtures and an output directory");
        const {checkNativeRelease}=await import("./maplibre-native-release-checks.mjs");
        await checkNativeRelease({client,evaluate,waitFor,delay,output:comparisonOutput});
        assert.equal(interceptionError,undefined); assert.deepEqual(unexpectedApiRequests,[]); assert.deepEqual(browserErrors,[]);
        assert.equal(geometryPosts,1); assert.equal(scheduleRequestsByDate.get(initialDate),1);
        phase='passed assertions'; return;
      }
      if(asyncMap) {
        const {checkAsyncMap}=await import("./maplibre-async-checks.mjs");
        const result=await checkAsyncMap({client,evaluate,waitFor,delay,engine:requestedEngine,initialDate,changedDate,
          held:()=>({roads:heldRoads.length,schedule:heldSchedules.length}),
          releaseRoads:async()=>{delayRoads=false;for(const send of heldRoads.splice(0))await send();},
          releaseSchedule:async()=>{delaySchedule=false;for(const send of heldSchedules.splice(0))await send();}});
        assert.equal(interceptionError,undefined); assert.deepEqual(unexpectedApiRequests,[]); assert.deepEqual(browserErrors,[]);
        mkdirSync(comparisonOutput,{recursive:true});
        writeFileSync(resolve(comparisonOutput,'async-evidence.json'),JSON.stringify({engine:requestedEngine,result,geometryPosts,totalApiRequests},null,2));
        phase='passed assertions'; return;
      }
      await delay(300);
      assert.equal(interceptionError, undefined);
      assert.equal(
        scheduleRequestsByDate.get(initialDate),
        maxScheduleGetsPerSelectedDate,
        "the initial selected date must have exactly one schedule GET before polling",
      );
      assert.equal(
        scheduleRequestsByDate.get(changedDate),
        0,
        "the second date must not be loaded before the date control selects it",
      );

      await evaluate(
        client,
        "window.__dispatchHeartbeat = 0; window.__dispatchHeartbeatTimer = setInterval(() => { window.__dispatchHeartbeat += 1; }, 25); true",
        "installing the responsiveness heartbeat",
      );
      const stableMonitor = await installStableNodeMonitor(client);
      assert.deepEqual(stableMonitor, { connected: true, initialValue: "" });
      await delay(125);
      heartbeatBeforeInteractions = await evaluate(
        client,
        "window.__dispatchHeartbeat",
        "reading the initial heartbeat",
      );

      phase = "exercising ordinary interactions";
      const interactionsStartedAt = Date.now();
      // Filters force unrelated UI and map rerenders without selecting another date.
      await clickElement(client, "#map-tool-filters", "map filters");
      await waitFor(
        async () =>
          await evaluate(
            client,
            "Boolean(document.querySelector('[data-map-tool-content=\"filters\"]'))",
            "checking the filters popover",
          ),
        "the filters popover",
      );
      // Change the ordinary region filter while the Map Filters control is open.
      // This is a genuine projection/map rerender but cannot legitimately reload
      // the selected-date cache snapshot.
      await selectElementValue(
        client,
        'select[aria-label="Engineer region"]',
        "North",
        "the engineer region filter",
      );
      await waitFor(
        async () =>
          (await evaluate(
            client,
            "document.querySelector('select[aria-label=\"Engineer region\"]')?.value",
            "checking the narrowed engineer region",
          )) === "North",
        "the North region filter",
      );
      await selectElementValue(
        client,
        'select[aria-label="Engineer region"]',
        "all",
        "the engineer region filter reset",
      );
      await waitFor(
        async () =>
          (await evaluate(
            client,
            "document.querySelector('select[aria-label=\"Engineer region\"]')?.value",
            "checking the reset engineer region",
          )) === "all",
        "the all-regions filter reset",
      );

      // The fixture deliberately has short inter-visit gaps, so Issues has a real item.
      await clickElement(client, "#map-tool-notifications", "route issues");
      await waitFor(
        async () =>
          await evaluate(
            client,
            "Boolean(document.querySelector('[data-map-tool-content=\"notifications\"] [data-notification-item]'))",
            "checking the issues panel",
          ),
        "an actionable route issue",
      );
      await clickElement(
        client,
        "[data-map-tool-content=\"notifications\"] [data-notification-item]",
        "an issue focus action",
      );

      // A real route selection sends the route-focus camera intent through RouteMap.
      await clickElement(
        client,
        "button.route-summary-route-focus",
        "a route summary selection",
      );
      await waitFor(
        async () =>
          await evaluate(
            client,
            "Boolean(document.querySelector('button.route-summary-route-focus[aria-pressed=\"true\"]'))",
            "checking route selection",
          ),
        "the selected route",
      );

      // Wait for rendered camera/rail settling, including slow software-GPU frames.
      // A fixed sleep can sample an unfinished route fit and cancel the measured pan.
      let settledPosition = null;
      let stableFrames = 0;
      await waitFor(async () => {
        const position = await markerPosition(client);
        stableFrames = position && settledPosition &&
          Math.abs(position.left - settledPosition.left) < .5 &&
          Math.abs(position.top - settledPosition.top) < .5 ? stableFrames + 1 : 0;
        settledPosition = position;
        return stableFrames >= 4;
      }, "the route-focus camera to settle", 8_000, 100);
      const beforePan = await markerPosition(client);
      assert.ok(beforePan, "a booked marker should exist before panning");
      await pressKey(client, "ArrowRight", "ArrowRight");
      let afterPan;
      await waitFor(async () => {
        afterPan = await markerPosition(client);
        return afterPan && Math.abs(afterPan.left - beforePan.left) >= 8;
      }, "ArrowRight to move a rendered map marker", 3_000);
      assert.ok(afterPan, "a booked marker should exist after panning");
      assert.ok(
        Math.abs(afterPan.left - beforePan.left) >= 8,
        `ArrowRight should move a rendered map marker (${beforePan.left} -> ${afterPan.left}).`,
      );

      const beforeZoom = afterPan;
      await pressKey(client, "=", "Equal");
      await delay(125);
      const afterZoom = await markerPosition(client);
      assert.ok(afterZoom, "a booked marker should exist after zooming");
      assert.notEqual(
        afterZoom.transform,
        beforeZoom.transform,
        "the zoom shortcut should update the rendered marker transform",
      );

      // m clears selection and increments visibleMarkerFitToken: exercise the real refit path.
      await pressKey(client, "m", "KeyM");
      await delay(125);
      const afterRefit = await markerPosition(client);
      assert.ok(afterRefit, "a booked marker should exist after refitting");
      assert.ok(
        Math.abs(afterRefit.left - afterPan.left) >= 8 ||
          Math.abs(afterRefit.top - afterPan.top) >= 8,
        "the fit-to-visible shortcut should reverse the keyboard pan",
      );

      await pressKey(client, "t", "KeyT");
      await waitFor(
        async () =>
          (await evaluate(
            client,
            "document.querySelector('main.dispatch-review-page')?.dataset.routePaneMode",
            "checking the timeline shortcut",
          )) === "timeline",
        "the route pane to enter timeline mode",
      );

      assert.equal(
        scheduleRequestsByDate.get(initialDate),
        maxScheduleGetsPerSelectedDate,
        "filters, issues, route selection, timeline, pan, zoom and refit must not GET the current schedule again",
      );
      assert.equal(
        scheduleRequestsByDate.get(changedDate),
        0,
        "ordinary interactions must not preload another selected-date schedule",
      );

      phase = "opening date control and changing selected date";
      // Opening the calendar may GET its month summary, but must not GET another schedule.
      await clickElement(client, "#map-tool-date", "date control");
      await waitFor(
        async () =>
          await evaluate(
            client,
            "Boolean(document.querySelector('[data-map-tool-content=\"date\"]'))",
            "checking the date popover",
          ),
        "the date popover",
      );
      await waitFor(
        () => calendarRequests === 1,
        "the fixture calendar month request",
      );
      assert.equal(
        scheduleRequestsByDate.get(initialDate),
        maxScheduleGetsPerSelectedDate,
        "opening the date control must not refetch the current selected-date schedule",
      );
      assert.equal(scheduleRequestsByDate.get(changedDate), 0);

      await clickElement(
        client,
        `button[data-date="${changedDate}"]`,
        "the new calendar day",
      );
      await waitFor(
        async () =>
          (await evaluate(
            client,
            "document.querySelector('#map-tool-date')?.getAttribute('aria-label')",
            "checking the changed selected date",
          )) === `Date, ${changedDate}`,
        "the selected date to update",
      );
      await waitFor(
        () => scheduleRequestsByDate.get(changedDate) === 1,
        "one schedule GET for the newly selected date",
      );
      await waitFor(
        () => geometryPosts === maxGeometryPosts,
        "one geometry POST for each distinct selected-date route batch",
      );
      await delay(350);

      assert.equal(interceptionError, undefined);
      assert.equal(
        scheduleRequestsByDate.get(initialDate),
        maxScheduleGetsPerSelectedDate,
        "the original selected date must remain at one schedule GET",
      );
      assert.equal(
        scheduleRequestsByDate.get(changedDate),
        maxScheduleGetsPerSelectedDate,
        "the changed selected date must receive exactly one initial schedule GET",
      );
      assert.ok(
        geometryPosts <= maxGeometryPosts,
        `geometry POSTs must stay within the two-date fixture ceiling (${geometryPosts}/${maxGeometryPosts})`,
      );
      assert.equal(
        geometryPosts,
        maxGeometryPosts,
        "the fixture must exercise the bounded geometry request for each selected date",
      );

      assert.equal(await evaluate(client,
        "new URLSearchParams(location.search).get('mapEngine') ?? ''",
        "checking the engine override survives date navigation"), engineOverride);
      const alternatingPattern = sustainedScheduleGeometryAlternation(apiRequestEvents);
      assert.equal(
        alternatingPattern.detected,
        false,
        `schedule/geometry requests formed a sustained alternating storm: ${JSON.stringify(alternatingPattern)}`,
      );
      assert.ok(
        totalApiRequests <= maxTotalApiRequests,
        `intercepted API requests exceeded the fixture ceiling (${totalApiRequests}/${maxTotalApiRequests})`,
      );
      assert.equal(
        totalApiRequests,
        maxTotalApiRequests,
        "the exact cache-only fixture request budget must be consumed with no hidden endpoint calls",
      );
      assert.equal(calendarRequests, 1, "the date control should request one cached month summary");
      assert.equal(engineerRequests, 1, "the roster should load once");
      assert.deepEqual(
        unexpectedApiRequests,
        [],
        "every unexpected application API endpoint must fail the fixture",
      );
      assert.equal(response429Count, 0, "the fixture must not receive HTTP 429 responses");
      assert.equal(failedApiRequestCount, 0, "the fixture must not have failed API requests");
      assert.deepEqual(
        basemapManifest ? externalFixtureRequests.filter(r=>permittedExternalStyleUrls.has(r.slice(4))) : externalFixtureRequests,
        expectedExternalFixtureRequests,
        "only the exact current-theme OpenFreeMap style request may be intercepted",
      );

      const elapsedSinceFirstSchedule = Date.now() - firstScheduleRequestAt;
      const interactionDurationMs = Date.now() - interactionsStartedAt;
      assert.ok(
        interactionDurationMs < prePollInteractionWindowMs,
        `post-readiness interactions must finish within ${prePollInteractionWindowMs}ms (${interactionDurationMs}ms)`,
      );
      assert.ok(
        elapsedSinceFirstSchedule < cachePollIntervalMs,
        `startup and interactions must finish before the first ${cachePollIntervalMs / 1_000}s production poll (${elapsedSinceFirstSchedule}ms)`,
      );

      phase = "checking renderer responsiveness and churn";
      await delay(150);
      heartbeatAfterInteractions = await evaluate(
        client,
        "window.__dispatchHeartbeat",
        "checking final browser responsiveness",
      );
      assert.ok(
        heartbeatAfterInteractions > heartbeatBeforeInteractions,
        `the in-page heartbeat should advance (${heartbeatBeforeInteractions} -> ${heartbeatAfterInteractions})`,
      );

      const finalCdpStartedAt = performance.now();
      finalDom = await evaluate(
        client,
        `({
          page: document.querySelector('main.dispatch-review-page') instanceof HTMLElement,
          date: document.querySelector('#map-tool-date')?.getAttribute('aria-label') ?? null,
          map: document.querySelector('.audit-map') instanceof HTMLElement,
        })`,
        "running the strict final external CDP/DOM command",
        strictCdpTimeoutMs,
      );
      finalCdpDurationMs = Math.round(performance.now() - finalCdpStartedAt);
      assert.deepEqual(finalDom, {
        page: true,
        date: `Date, ${changedDate}`,
        map: true,
      });
      assert.ok(
        finalCdpDurationMs <= strictCdpTimeoutMs,
        `the final CDP command exceeded its strict ${strictCdpTimeoutMs}ms timeout (${finalCdpDurationMs}ms)`,
      );

      stableNode = await readStableNodeMonitor(client);
      assert.ok(stableNode?.connected, "the monitored engineer-search node must remain connected");
      assert.ok(stableNode?.sameNode, "the monitored engineer-search node must not be replaced");
      const stableNodeWriteTotal = stableNode.writes + stableNode.replacements;
      assert.ok(
        stableNodeWriteTotal <= maxStableNodeWrites,
        `the stable engineer-search node was rewritten too often (${stableNodeWriteTotal}/${maxStableNodeWrites})`,
      );

      if (extendedMapFixture && !stressMap) {
        phase = "extended visual and semantic parity";
        const capture = async (name) => {
          if (!comparisonOutput) return;
          mkdirSync(comparisonOutput, { recursive: true });
          const screenshot = await client.command("Page.captureScreenshot", { format: "png" });
          writeFileSync(resolve(comparisonOutput, `${name}.png`), Buffer.from(screenshot.data, "base64"));
        };
        const check = extraMapFixture ? (await import("./maplibre-extra-checks.mjs")).checkExtraMap : checkExtendedMap;
        extendedEvidence = await check({ client, evaluate, clickElement, pressKey, waitFor, delay,
          engine: requestedEngine, date: changedDate, capture });
        assert.equal(totalApiRequests, maxTotalApiRequests + Number(extraMapFixture), "exact extended budget plus one explicit C calendar-tool read in extra coverage");
        assert.equal(calendarRequests, extraMapFixture ? 2 : 1, "calendar reads correspond to explicit date-tool openings");
        assert.equal(geometryPosts, 2, "home suggestion focus does not create road requests");
        assert.deepEqual(basemapManifest ? externalFixtureRequests.filter(r=>permittedExternalStyleUrls.has(r.slice(4))) : externalFixtureRequests, [...expectedExternalFixtureRequests,
          "GET https://tiles.openfreemap.org/styles/fiord", "GET https://tiles.openfreemap.org/styles/bright"]);
        assert.deepEqual(browserErrors, [], "the candidate must not throw browser exceptions");
      }

      if (stressMap) {
        phase = "paired pointer, refresh and lifecycle stress";
        assert.ok(extendedMapFixture && comparisonOutput, "stress requires extended fixtures and an output directory");
        stressEvidence = await checkStressMap({ client, evaluate, clickElement, pressKey, waitFor, delay,
          engine: requestedEngine, date: changedDate, output: comparisonOutput, partial:partialMapFixture,
          refresh: async (mode) => {
            refreshMode = mode;
            if (mode === "demand" || mode === "overlap") demandRevision++;
            if (mode === "overlap") overlapDemand = true;
            if (mode === "schedule") scheduleRevision++;
            const start = refreshEvents.length;
            await evaluate(client, `window.__cacheRefreshControl=${JSON.stringify(mode)}; window.__cacheClockOffset += 31000; window.dispatchEvent(new Event('focus'))`, "advancing deterministic cache poll clock");
            await waitFor(() => refreshEvents.length >= start + 2, "both conditional cache reads");
            await delay(400);
            refreshMode = "initial";
            await evaluate(client,"window.__cacheRefreshControl='automatic'","ending controlled refresh phase");
            return refreshEvents.slice(start);
          },
          requestCounts: () => ({totalApiRequests, geometryPosts}),
          failStyle: () => { failStyles = true; },
        });
        // End the visible workload before validating a final immutable request set.
        // A poll already in flight still must resolve and pass the normal 304 probes.
        await evaluate(client, "Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))", "backgrounding the completed fixture workload");
        await waitFor(async()=>await evaluate(client,"window.__mapComparison.apiResponses.length","draining final fixture reads")===totalApiRequests,"all in-flight app fetches complete at measurement boundary");
        await evaluate(client,"new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))","finishing final 304 publication probes");
        assert.deepEqual(unexpectedApiRequests, []);
        assert.equal(interceptionError, undefined);
        assert.deepEqual(browserErrors, []);
        assert.equal(scheduleRequestsByDate.get(initialDate),1);
        const automaticPolls = cacheReadEvents.filter(e=>e.control==="initial" && e.conditional);
        automaticPollCount=automaticPolls.length;
        automaticPollMaximum=2*Math.floor((performance.now()-cacheReadEvents[0].at)/29000);
        assert.ok(automaticPollCount<=automaticPollMaximum,"automatic polls have a duration-derived maximum for two resources at >=29-second cadence");
        const automaticProbes=await evaluate(client,"window.__mapComparison.cache304Probes.filter(p=>p.control==='automatic')","observing automatic 304 publication isolation");
        assert.equal(automaticProbes.length,automaticPollCount,"every automatic 304 has a post-response rendered-frame probe");
        for(const probe of automaticProbes) {
          assert.equal(probe.sameHost,true,"automatic refresh publication probe has one continuous renderer");
          assert.deepEqual(probe.publications,[],"automatic 304 cannot rebuild canonical map data");
        }
        for(const poll of automaticPolls) {
          assert.equal(poll.code,304,"scheduled background polls must retain the current ETag");
          const previous=cacheReadEvents.slice(0,cacheReadEvents.indexOf(poll)).findLast(e=>e.kind===poll.kind);
          assert.ok(previous && poll.at-previous.at>=29000,"automatic poll respects the 30-second cadence, never a remount/retry loop");
        }
        assert.equal(scheduleRequestsByDate.get(changedDate),5+automaticPolls.filter(e=>e.kind==="schedule").length,"initial date read, four controlled polls and individually cadence-verified 304 polls");
        assert.equal(geometryPosts,3,"only a changed coordinate causes one additional geometry request");
        assert.equal(totalApiRequests,maxTotalApiRequests+9+automaticPollCount,"exact controlled request budget plus verified scheduled 304s; no unexplained requests");
      }

      if (comparisonOutput) {
        mkdirSync(comparisonOutput, { recursive: true });
        const screenshot = await client.command("Page.captureScreenshot", { format: "png" });
        writeFileSync(resolve(comparisonOutput, "workspace.png"), Buffer.from(screenshot.data, "base64"));
        const metrics = await evaluate(client, `(() => {
          const canvas = document.querySelector('.maplibregl-canvas');
          const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
          const extension = gl?.getExtension('WEBGL_debug_renderer_info');
          return {
            ...window.__mapComparison,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            viewport: [innerWidth, innerHeight], devicePixelRatio,
            renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : window.__mapComparison.renderer,
            userAgent: navigator.userAgent,
            initialUsableMs: window.__mapComparison.initialUsableMs,
          };
        })()`, "recording comparison metrics");
        assert.equal(metrics.apiResponses.length,totalApiRequests,"every intercepted application read resolves through fetch");
        assert.ok(metrics.apiResponses.every(response=>[200,304].includes(response.status)),"all application responses remain successful or conditional unchanged");
        assert.equal(metrics.reducedMotion, comparisonMotion === "reduce", "requested motion must be measured");
        if (hardwareGpu) assert.ok(metrics.renderer && !/SwiftShader|llvmpipe|Software/i.test(metrics.renderer), "hardware comparison requires a verified hardware renderer");
        writeFileSync(resolve(comparisonOutput, "measurement.json"), JSON.stringify({
          engine: requestedEngine, fixtureReferenceTime, extendedEvidence, stressEvidence, refreshEvents, cacheReadEvents, automaticPollCount, automaticPollMaximum,
          selectedDates, partialMapFixture, extraMapFixture, applicationClock: `${fixtureReferenceTime} + elapsed monotonic time + controlled poll offsets`,
          fixture: extendedMapFixture ? { routes: 3, legs: partialMapFixture ? 3 : 6, canonicalLegs: partialMapFixture ? 4 : 6, roadCoordinates: partialMapFixture ? 6 : 12, bookedVisits: partialMapFixture ? 6 : 5, missingBookedLocations: partialMapFixture ? 1 : 0, bookedPoints: 5, homePoints: 3, demandItems: 5, mappedDemandPoints: 4, visibleDemandPoints: 3 }
            : { routes: 2, legs: 6, roadCoordinates: 12, bookedPoints: 4, homePoints: 2, demandPoints: 0 },
          conditions: {validationBoundary:stressMap ? "visible through phases; backgrounded afterward to drain pending reads before final validation" : "visible",profile:"fresh browser profile", build:"production", gpu:hardwareGpu ? "hardware requested and verified" : "SwiftShader", basemap:basemapManifest ? "local manifest assets" : "plain intercepted style", basemapManifest:basemapManifest ? {name:basemapManifest.name, assetCount:Object.keys(basemapManifest.responses).length} : null, instrumentation:process.env.MAP_TEST_SAMPLE === "0" ? "frame probe disabled; runtime counters retained" : "frame probe and runtime counters", run:process.env.MAP_COMPARISON_RUN ?? null, order:process.env.MAP_COMPARISON_ORDER ?? null},
          metrics, scheduleRequestsByDate: Object.fromEntries(scheduleRequestsByDate), geometryPosts, totalApiRequests,
        }, null, 2) + "\n");
      }
      evidence = {
        browser: chromePath,
        runtime: {
          build: `NEXT_DIST_DIR=${distDirectoryName} next build`,
          launch: `node ${standaloneServerPath}`,
          publicDestination: standaloneAssets.publicDestination,
          staticDestination: standaloneAssets.staticDestination,
        },
        scheduleRequestsByDate: Object.fromEntries(scheduleRequestsByDate),
        geometryPosts,
        totalApiRequests,
        calendarRequests,
        engineerRequests,
        heartbeatBeforeInteractions,
        heartbeatAfterInteractions,
        finalCdpDurationMs,
        finalDom,
        stableNode: {
          ...stableNode,
          total: stableNodeWriteTotal,
          ceiling: maxStableNodeWrites,
        },
        response429Count,
        failedApiRequestCount,
        alternatingPattern,
        ceilings: {
          scheduleGetsPerSelectedDate: maxScheduleGetsPerSelectedDate,
          geometryPosts: stressMap ? 3 : maxGeometryPosts,
          controlledPolls: stressMap ? 4 : 0,
          automaticPollMaximum,
          alternatingRun: maxAlternatingRunBeforeFailure,
          totalApiRequests: stressMap ? maxTotalApiRequests+9+automaticPollCount : maxTotalApiRequests + Number(extraMapFixture),
        },
        externalFixtureRequests,
        elapsedSinceFirstSchedule,
      };
      if (extendedMapFixture && !stressMap && requestedEngine === "maplibre") {
        phase = "WebGL context loss";
        await checkMapContextLoss({ client, evaluate, clickElement, pressKey, waitFor, date: changedDate });
        assert.equal(totalApiRequests, maxTotalApiRequests + Number(extraMapFixture));
      }
      if (process.env.MAP_TEST_ARTWORK === "1") {
        phase = "sprite byte equivalence outside comparison phases";
        const { checkMapArtwork } = await import("./maplibre-artwork-check.mjs");
        await checkMapArtwork({ client, evaluate, output: comparisonOutput });
        assert.deepEqual(browserErrors, [], "artwork verification must not hide browser errors");
      }
      if (extendedMapFixture && !stressMap && !extraMapFixture) {
        phase = "editor and logout behaviour";
        uiCleanup = true;
        const { checkEngineerEditor, checkLogoutNavigation } = await import("./ui-cleanup-browser-checks.mjs");
        await checkEngineerEditor({ client, evaluate, waitFor, clickElement, pressKey, origin,
          savePending: () => Boolean(heldEditorSave), releaseSave: () => heldEditorSave() });
        assert.deepEqual(uiRequests.sort(), ["GET /api/engineers", "GET /api/engineers/third-party-statuses", "POST /api/engineers"]);
        await checkLogoutNavigation({ client, evaluate, waitFor, delay, clickElement });
        assert.equal(interceptionError, undefined);
        assert.deepEqual(browserErrors, []);
      }
      phase = "passed assertions";
    } finally {
      if (diagnosticOutput && client) {
        // Diagnostic read gets its own recovery budget AFTER the original verdict.
        // It cannot extend or suppress any startup/interaction assertion deadline.
        const result = await client.command("Runtime.evaluate", {
          expression: `JSON.stringify({
            ...window.__dispatchStartupDiagnostics,
            now: performance.now(),
            ready: document.querySelector('.audit-map')?.reviewMapDiagnostics?.().ready,
            status: document.querySelector('.review-libre-status')?.textContent,
            cacheError: document.querySelector('.error-banner')?.textContent,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          })`, returnByValue: true,
        }, "recovering startup diagnostics after verdict", 15_000).catch(error => ({ error: String(error) }));
        const diagnostics = { phase, result, commands: diagnosticCommands, chromeOutput: getChromeOutput() };
        mkdirSync(diagnosticOutput, { recursive: true });
        if (profileStartup) {
        const profile = await client.command("Profiler.stop", {}, "collecting startup CPU profile after verdict", 15_000).catch(error => ({ error: String(error) }));
        writeFileSync(resolve(diagnosticOutput, "startup.cpuprofile"), JSON.stringify(profile));
        try {
          const complete = new Promise(resolveComplete => client.on("Tracing.tracingComplete", resolveComplete));
          await client.command("Tracing.end", {}, "ending startup trace after verdict", 15_000);
          const { stream } = await withTimeout(complete, "collecting startup trace", 15_000);
          const chunks = [];
          let total = 0;
          let eof = false;
          while (!eof && total < 50_000_000) {
            const part = await client.command("IO.read", { handle: stream, size: 1_000_000 }, "reading startup trace", 15_000);
            const chunk = Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8");
            chunks.push(chunk);
            total += chunk.length;
            eof = part.eof;
          }
          await client.command("IO.close", { handle: stream });
          if (eof) writeFileSync(resolve(diagnosticOutput, "startup-trace.json.gz"), gzipSync(Buffer.concat(chunks)));
          else console.log("[dispatch-startup-diagnostics] trace exceeded 50MB bound");
        } catch (error) {
          console.log("[dispatch-startup-diagnostics] trace collection failed:", String(error));
        }
        }
        writeFileSync(resolve(diagnosticOutput, "startup.json"), JSON.stringify(diagnostics, null, 2));
        console.log("[dispatch-startup-diagnostics]", JSON.stringify(diagnostics));
      }
      if (phase !== "passed assertions" && client) {
        if(comparisonOutput) {
          mkdirSync(comparisonOutput,{recursive:true});
          const metrics=await evaluate(client,"window.__mapComparison||null","preserving failed-run metrics").catch(()=>null);
          writeFileSync(resolve(comparisonOutput,"failed-final-evidence.json"),JSON.stringify({phase,metrics,totalApiRequests,geometryPosts,cacheReadEvents,browserErrors},null,2));
        }
        console.log("[dispatch-browser-regression] map failure:", await evaluate(client, `({
          dataset: {...document.querySelector('.audit-map')?.dataset},
          status: document.querySelector('.review-libre-status')?.textContent,
          diagnostics: Boolean(document.querySelector('.audit-map')?.reviewMapDiagnostics),
        })`, "reading map failure diagnostics").catch(() => null));
        console.log("[dispatch-browser-regression] browser errors:", browserErrors);
      }
      await clearPageInstrumentation(client);
      client?.close();
      const chromeCleanup = await stopProcessTree(chrome, "Chromium");
      const serverCleanup = await stopProcessTree(server, "standalone server");
      rmSync(profileDirectory, { recursive: true, force: true });
      rmSync(distDirectory, { recursive: true, force: true });
      cleanup = {
        chrome: chromeCleanup,
        server: serverCleanup,
        profileRemoved: !existsSync(profileDirectory),
        distDirectoryRemoved: !existsSync(distDirectory),
        remainingChromeProfileProcesses: processesContaining(profileDirectory),
        remainingStandaloneServerProcesses: processesContaining(standaloneServerPath),
      };
      assert.ok(cleanup.chrome.stopped && cleanup.server.stopped && cleanup.profileRemoved && cleanup.distDirectoryRemoved, "fixture processes and temporary files must be cleaned");
      console.log("[dispatch-browser-regression] partial evidence:", {
        phase,
        scheduleRequestsByDate: Object.fromEntries(scheduleRequestsByDate),
        geometryPosts,
        totalApiRequests,
        calendarRequests,
        engineerRequests,
        heartbeatBeforeInteractions,
        heartbeatAfterInteractions,
        finalCdpDurationMs,
        finalDom,
        stableNode,
        response429Count,
        failedApiRequestCount,
        unexpectedApiRequests,
        externalFixtureRequests,
        interceptionError: interceptionError?.message ?? null,
        cleanup,
      });
    }

    assert.ok(cleanup.chrome.stopped, `Chromium cleanup failed: ${JSON.stringify(cleanup.chrome)}`);
    assert.ok(cleanup.server.stopped, `standalone server cleanup failed: ${JSON.stringify(cleanup.server)}`);
    assert.equal(cleanup.profileRemoved, true, "the temporary Chromium profile must be removed");
    assert.equal(cleanup.distDirectoryRemoved, true, "the ignored standalone build output must be removed");
    assert.deepEqual(cleanup.remainingChromeProfileProcesses, [], "no Chromium fixture process may remain");
    assert.deepEqual(cleanup.remainingStandaloneServerProcesses, [], "no standalone server process may remain");

    console.log("[dispatch-browser-regression] standalone runtime:", evidence.runtime);
    console.log("[dispatch-browser-regression] browser:", evidence.browser);
    console.log("[dispatch-browser-regression] schedule GETs by selected date:", evidence.scheduleRequestsByDate);
    console.log("[dispatch-browser-regression] geometry POSTs / total API requests:", {
      geometryPosts: evidence.geometryPosts,
      totalApiRequests: evidence.totalApiRequests,
      calendarRequests: evidence.calendarRequests,
      engineerRequests: evidence.engineerRequests,
    });
    console.log("[dispatch-browser-regression] ceilings:", evidence.ceilings);
    console.log("[dispatch-browser-regression] responsiveness:", {
      heartbeatBeforeInteractions: evidence.heartbeatBeforeInteractions,
      heartbeatAfterInteractions: evidence.heartbeatAfterInteractions,
      finalCdpDurationMs: evidence.finalCdpDurationMs,
      finalDom: evidence.finalDom,
    });
    console.log("[dispatch-browser-regression] stable-node churn:", evidence.stableNode);
    console.log("[dispatch-browser-regression] request health:", {
      response429Count: evidence.response429Count,
      failedApiRequestCount: evidence.failedApiRequestCount,
      alternatingPattern: evidence.alternatingPattern,
      externalFixtureRequests: evidence.externalFixtureRequests,
      elapsedSinceFirstSchedule: evidence.elapsedSinceFirstSchedule,
    });
    console.log("[dispatch-browser-regression] cleanup:", cleanup);
  },
);
