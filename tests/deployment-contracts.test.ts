import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const identityHeaders = [
  "X-Auth-Request-User",
  "X-Auth-Request-Email",
  "X-Auth-Request-Preferred-Username",
  "X-Forwarded-User",
  "X-Forwarded-Email",
  "X-Forwarded-Preferred-Username",
];

function assertIdentitySanitizer(source: string, middleware: string) {
  for (const header of identityHeaders) {
    assert.ok(
      source.includes(
        `traefik.http.middlewares.${middleware}-identity-sanitize.headers.customrequestheaders.${header}: ""`,
      ),
      header,
    );
  }
  assert.ok(
    source.includes(
      `traefik.http.middlewares.${middleware}-auth.forwardauth.authResponseHeaders: X-Auth-Request-User,X-Auth-Request-Email,X-Auth-Request-Preferred-Username`,
    ),
  );
}

test("development accepts only the documented loopback browser origin", () => {
  const nextConfig = readFileSync(join(root, "next.config.ts"), "utf8");
  assert.match(nextConfig, /allowedDevOrigins:\s*\["127\.0\.0\.1"\]/);
});

test("example Compose keeps the web application reachable while operational data warms", () => {
  const composeSource = readFileSync(join(root, "docker/compose.example.yml"), "utf8");
  const appService = composeSource.slice(
    composeSource.indexOf("  app:"),
    composeSource.indexOf("  cache-worker:"),
  );

  assert.match(
    appService,
    /fetch\('http:\/\/127\.0\.0\.1:3000\/api\/health\/live'\)/,
  );
  assert.match(
    appService,
    /loadbalancer\.healthcheck\.path: \/api\/health\/live/,
  );
  assert.doesNotMatch(appService, /\/api\/health\/ready/);
  assert.match(
    appService,
    /middlewares: dispatch-route-review-identity-sanitize@docker,dispatch-route-review-auth@docker,dispatch-route-review-security@docker/,
  );
  assertIdentitySanitizer(appService, "dispatch-route-review");
});

test("authenticated development mirrors the production ForwardAuth boundary", () => {
  const composeSource = readFileSync(
    join(root, "docker/compose.dev-auth.yml"),
    "utf8",
  );

  assert.match(composeSource, /image: traefik:3\.7/);
  assert.match(
    composeSource,
    /image: quay\.io\/oauth2-proxy\/oauth2-proxy:v7\.15\.3/,
  );
  assert.match(composeSource, /AUTH_MODE: forward-auth/);
  assert.match(composeSource, /ports: !reset \[\]/);
  assert.match(composeSource, /networks:\n      - default\n      - auth-edge/);
  assert.match(
    composeSource,
    /--redirect-url=https:\/\/localhost:3443\/oauth2\/callback/,
  );
  assert.match(
    composeSource,
    /middlewares: dispatch-route-review-dev-identity-sanitize@docker,dispatch-route-review-dev-auth@docker,dispatch-route-review-dev-security@docker/,
  );
  assertIdentitySanitizer(composeSource, "dispatch-route-review-dev");
  assert.match(
    composeSource,
    /forwardauth\.maxResponseBodySize: "65536"/,
  );
  assert.match(
    composeSource,
    /entrypoints\.websecure\.http\.aliasheadersstrategy=delete/,
  );
  assert.match(composeSource, /"127\.0\.0\.1:3443:443"/);
  assert.doesNotMatch(
    composeSource,
    /AUTOTASK_(API_CODE|USERNAME|SECRET)/,
  );
});

test("local authentication credentials and certificates stay outside Docker builds", () => {
  const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(dockerignore, /^\.dev-auth$/m);
});

test("development Compose keeps Autotask credentials in the worker", () => {
  const composeSource = readFileSync(join(root, "docker/compose.dev.yml"), "utf8");
  const appService = composeSource.slice(
    composeSource.indexOf("  app:"),
    composeSource.indexOf("  cache-worker:"),
  );
  const workerServiceStart = composeSource.indexOf("  cache-worker:");
  const workerService = composeSource.slice(
    workerServiceStart,
    composeSource.indexOf("\nvolumes:\n", workerServiceStart),
  );

  assert.doesNotMatch(appService, /AUTOTASK_(API_CODE|USERNAME|SECRET)/);
  assert.doesNotMatch(appService, /GEOCODER_USER_AGENT_CONTACT/);
  assert.ok(workerService.includes("GEOCODER_USER_AGENT_CONTACT: " + "${"));
  for (const variable of [
    "AUTOTASK_API_CODE",
    "AUTOTASK_USERNAME",
    "AUTOTASK_SECRET",
  ]) {
    assert.ok(workerService.includes(`${variable}: ` + "${"));
  }

});

test("production requires geocoder contact only in the worker", () => {
  const composeSource = readFileSync(join(root, "docker/compose.example.yml"), "utf8");
  const workerStart = composeSource.indexOf("  cache-worker:");
  const workerEnd = composeSource.indexOf("  oauth2-proxy:", workerStart);
  const workerService = composeSource.slice(workerStart, workerEnd);
  assert.match(workerService, /GEOCODER_USER_AGENT_CONTACT: \$\{GEOCODER_USER_AGENT_CONTACT:\?/);
  assert.doesNotMatch(composeSource.slice(0, workerStart), /GEOCODER_USER_AGENT_CONTACT/);
  assert.doesNotMatch(composeSource.slice(workerEnd), /GEOCODER_USER_AGENT_CONTACT/);
});

// Compose owns environment injection; an application API cannot prove its absence.
test("example Compose gives Autotask secrets only to the worker and keeps optional config process-scoped", () => {
  const source = readFileSync(join(root, "docker/compose.example.yml"), "utf8");
  const appStart = source.indexOf("\n  app:");
  const workerStart = source.indexOf("\n  cache-worker:");
  const app = source.slice(appStart, workerStart);
  const worker = source.slice(workerStart, source.indexOf("\n  oauth2-proxy:", workerStart));
  assert.ok(appStart >= 0 && workerStart > appStart);
  assert.doesNotMatch(app, /AUTOTASK_(API_CODE|USERNAME|SECRET|THIRD_PARTY_COMPANY_FIELD)/);
  assert.match(app, /AUTOTASK_WEB_URL:/);
  assert.match(worker, /AUTOTASK_THIRD_PARTY_COMPANY_FIELD:/);
  assert.doesNotMatch(worker, /AUTOTASK_WEB_URL/);
  for (const name of ["AUTOTASK_API_CODE", "AUTOTASK_USERNAME", "AUTOTASK_SECRET"]) assert.ok(worker.includes(`${name}:`));
});
