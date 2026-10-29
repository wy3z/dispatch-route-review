#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isIP } from "node:net";

const EXPECTED_IMAGE = "quay.io/oauth2-proxy/oauth2-proxy:v7.15.3";
const TENANT_GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_GUID = "00000000-0000-0000-0000-000000000000";
const LOGOUT_HANDOFF_PATH = "/logout/entra";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = { files: [], envFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--file" && argument !== "--env-file") {
      fail(`Unknown argument: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value.`);
    if (argument === "--file") options.files.push(value);
    else options.envFile = value;
  }
  if (!options.files.length || !options.envFile) {
    fail("Usage: check-oauth2-proxy-config --env-file PATH --file PATH [--file PATH]");
  }
  return options;
}

function optionValues(command, name) {
  const option = `--${name}`;
  const prefix = `${option}=`;
  const values = [];
  for (let index = 0; index < command.length; index += 1) {
    const argument = command[index];
    if (argument === option) {
      const value = command[++index];
      if (typeof value !== "string" || !value || value.startsWith("--")) {
        fail(`${option} requires a value.`);
      }
      values.push(value);
    } else if (typeof argument === "string" && argument.startsWith(prefix)) {
      values.push(argument.slice(prefix.length));
    }
  }
  return values;
}

function exactOption(command, name) {
  const values = optionValues(command, name);
  if (values.length !== 1 || !values[0]) {
    fail(`OAuth2 Proxy must set --${name} exactly once.`);
  }
  return values[0];
}

function validateTrustedProxy(value) {
  const separator = value.lastIndexOf("/");
  const address = separator > 0 ? value.slice(0, separator) : "";
  const prefix = separator > 0 ? value.slice(separator + 1) : "";
  const family = isIP(address);
  const maximum = family === 4 ? 32 : family === 6 ? 128 : -1;
  if (!/^\d+$/.test(prefix) || maximum < 0) fail(`${value} must be a CIDR.`);
  const bits = Number(prefix);
  if (bits < 1 || bits > maximum) {
    fail("OAuth2 Proxy trusted proxies must not include a catch-all CIDR.");
  }
}

function validateLogoutHandoff(app) {
  const labels = app.labels ?? {};
  const forwardAuth = Object.keys(labels)
    .filter((name) => name.endsWith(".forwardauth.address"))
    .map((name) =>
      name.slice(
        "traefik.http.middlewares.".length,
        -".forwardauth.address".length,
      ),
    );
  if (!forwardAuth.length) fail("Application ForwardAuth middleware is missing.");

  const routers = Object.entries(labels)
    .filter(([name]) => name.startsWith("traefik.http.routers.") && name.endsWith(".rule"))
    .map(([ruleKey, rule]) => {
      const prefix = ruleKey.slice(0, -".rule".length);
      const middlewares = String(labels[`${prefix}.middlewares`] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      return { rule: String(rule), middlewares };
    });
  const bypass = routers.filter(
    (router) =>
      !router.middlewares.some((middleware) =>
        forwardAuth.some(
          (name) => middleware === name || middleware === `${name}@docker`,
        ),
      ),
  );
  if (
    bypass.length !== 1 ||
    !bypass[0].rule.includes(`Path(\`${LOGOUT_HANDOFF_PATH}\`)`) ||
    bypass[0].rule.includes("PathPrefix(")
  ) {
    fail(`Only exact ${LOGOUT_HANDOFF_PATH} may bypass application ForwardAuth.`);
  }
}

function validateRenderedConfig(rendered) {
  const proxy = rendered?.services?.["oauth2-proxy"];
  const app = rendered?.services?.app;
  if (!proxy || !app) fail("Compose must define app and oauth2-proxy services.");
  if (proxy.image !== EXPECTED_IMAGE) fail(`OAuth2 Proxy must use ${EXPECTED_IMAGE}.`);
  if (!Array.isArray(proxy.command)) fail("OAuth2 Proxy command must be an argument array.");
  if (proxy.environment && Object.keys(proxy.environment).some((key) => key.startsWith("OAUTH2_PROXY_"))) {
    fail("OAuth2 Proxy OAUTH2_PROXY_* environment overrides are not permitted.");
  }

  const command = proxy.command;
  if (exactOption(command, "provider") !== "oidc") fail("OAuth2 Proxy must use OIDC.");
  if (exactOption(command, "insecure-oidc-skip-nonce") !== "false") {
    fail("OAuth2 Proxy must explicitly validate OIDC nonces.");
  }
  if (exactOption(command, "reverse-proxy") !== "true") {
    fail("OAuth2 Proxy must enable reverse proxy mode.");
  }
  const trustedProxies = optionValues(command, "trusted-proxy-ip")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (!trustedProxies.length) fail("OAuth2 Proxy trusted proxy CIDR is missing.");
  trustedProxies.forEach(validateTrustedProxy);
  if (optionValues(command, "whitelist-domain").length) {
    fail("OAuth2 Proxy redirect whitelisting is not permitted for logout.");
  }

  const issuer = exactOption(command, "oidc-issuer-url");
  const tenantId = issuer.match(
    /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0$/i,
  )?.[1] ?? "";
  if (!TENANT_GUID.test(tenantId) || tenantId.toLowerCase() === NIL_GUID) {
    fail("OAuth2 Proxy must use a concrete non-zero Entra tenant GUID.");
  }
  if (app.environment?.ENTRA_TENANT_ID !== tenantId) {
    fail("Application and OAuth2 Proxy must use the same Entra tenant GUID.");
  }
  validateLogoutHandoff(app);

  const proxyRules = Object.entries(proxy.labels ?? {})
    .filter(([name]) => name.endsWith(".rule"))
    .map(([, rule]) => String(rule));
  if (!proxyRules.some((rule) => rule.includes("PathPrefix(`/oauth2/`)"))) {
    fail("OAuth2 Proxy public routing must include /oauth2/sign_out.");
  }
  return { image: proxy.image, command };
}

function renderCompose(options) {
  const args = ["compose", "--project-directory", ".", "--env-file", options.envFile];
  for (const file of options.files) args.push("--file", file);
  args.push("config", "--format", "json");
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) fail(`Docker Compose render failed:\n${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("Docker Compose returned invalid JSON.");
  }
}

function parserOnlyCommand(command) {
  const replacements = new Map([
    ["client-secret", "oauth2-proxy-config-check-secret"],
    ["cookie-secret", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ]);
  return command.map((argument) => {
    for (const [name, value] of replacements) {
      if (argument.startsWith(`--${name}=`)) return `--${name}=${value}`;
    }
    return argument;
  });
}

function validateWithPinnedBinary(image, command) {
  const result = spawnSync(
    "docker",
    ["run", "--rm", image, ...parserOnlyCommand(command), "--config-test"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(`OAuth2 Proxy rejected the rendered flag set:\n${result.stderr}`);
  }
}

try {
  const validated = validateRenderedConfig(renderCompose(parseArguments(process.argv.slice(2))));
  validateWithPinnedBinary(validated.image, validated.command);
  process.stdout.write("OAuth2 Proxy configuration contract passed.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "OAuth2 Proxy validation failed."}\n`);
  process.exitCode = 1;
}
