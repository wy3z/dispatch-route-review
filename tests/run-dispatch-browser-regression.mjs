import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const browserTestPath = fileURLToPath(
  new URL("./dispatch-browser-interaction.test.mjs", import.meta.url),
);
const maximumAttempts = process.env.CI === "true" ? 2 : 1;
const retryableBootstrapFailures = [
  "Timed out waiting for the Chrome DevTools endpoint",
  "Chrome DevTools WebSocket could not connect",
];

function tail(value, maximumLength = 64_000) {
  return value.length > maximumLength ? value.slice(-maximumLength) : value;
}

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
  return [
    executableFromCommand("google-chrome-stable"),
    executableFromCommand("google-chrome"),
    executableFromCommand("chromium"),
    executableFromCommand("chromium-browser"),
  ].find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function browserEnvironment() {
  if (process.env.CI !== "true") {
    return { env: process.env, cleanup: () => undefined };
  }

  const chromePath = findChrome();
  if (!chromePath) {
    return { env: process.env, cleanup: () => undefined };
  }

  const directory = mkdtempSync(join(tmpdir(), "dispatch-ci-chrome-"));
  const launcher = join(directory, "chrome");
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      // Camera assertions exercise control wiring and final state, not animation timing.
      `exec ${shellQuote(chromePath)} --force-prefers-reduced-motion "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
  return {
    env: { ...process.env, CHROME_PATH: launcher },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const configuredBrowser = browserEnvironment();

function runBrowserRegression() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", browserTestPath], {
      cwd: process.cwd(),
      env: configuredBrowser.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const forward = (destination) => (chunk) => {
      const text = String(chunk);
      output = tail(`${output}${text}`);
      destination.write(text);
    };

    child.stdout?.on("data", forward(process.stdout));
    child.stderr?.on("data", forward(process.stderr));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code: code ?? 1, signal, output });
    });
  });
}

let result = { code: 1, signal: null, output: "" };
try {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    result = await runBrowserRegression();
    if (result.code === 0) break;

    const retryable = retryableBootstrapFailures.some((message) =>
      result.output.includes(message),
    );
    if (!retryable || attempt === maximumAttempts) break;

    process.stderr.write(
      `\n[dispatch-browser-regression] Chromium DevTools bootstrap failed on attempt ${attempt}; retrying once with a fresh browser process, profile and debugging port.\n\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
} finally {
  configuredBrowser.cleanup();
}

if (result.code !== 0) {
  if (result.signal) {
    process.stderr.write(
      `\n[dispatch-browser-regression] final attempt ended from signal ${result.signal}.\n`,
    );
  }
  process.exitCode = result.code;
}
