# Tests

Test observable behavior. A test must survive internal changes that preserve the public contract.

## Select the test boundary

| Behavior | Test |
| --- | --- |
| Dates, filters, routes, policy | Pure domain functions |
| Keyboard and accessibility | Component rendering or interaction models |
| Routes, redirects, HTTP status, server HTML | Built-application HTTP tests |
| Persistence, migrations, locks, concurrent refreshes | PostgreSQL integration tests |
| Provider limits, timeouts, retries, circuit breaker | Mocked-provider tests |

Keep integration tests grouped by production boundary.
Check CSS selectors or exact text only when they are user-facing requirements.
Do not test implementation strings in application TypeScript, JSX, or CSS.
Replace obsolete source assertions after a refactor; do not adjust their regular expressions to match the new layout.

## Running the suite

`pnpm test` builds into `.next-test`, runs built-application HTTP tests and the TypeScript suites, then runs browser interaction checks. `pnpm lint` also runs `scripts/check-boundaries.mjs` to enforce module and runtime boundaries.

PostgreSQL suites skip when `TEST_DATABASE_URL` is unset. For database coverage, export it with a URL for a disposable test database, not a development or production database. CI supplies PostgreSQL 16 and this variable. The test role must be able to create and drop schemas; migration-runner tests also exercise the migration runner separately.

`tests/support/database.ts` provides `isolatedDatabase`: one random schema per test, selected or all migrations, and a schema-scoped application connection. Teardown closes the application pool, restores environment values, and drops the schema. Callers within a file must run sequentially because they share process environment and the application pool. Use this helper for module persistence tests rather than duplicating schema/pool cleanup.

## Browser checks

The browser suite requires Chrome/Chromium; set `CHROME_PATH` if it is not on PATH. Without a browser it skips locally, but fails in CI or with `REQUIRE_BROWSER_INTERACTION=1`. Run `REQUIRE_BROWSER_INTERACTION=1 pnpm test:browser` when a skipped browser check must fail validation.

Alongside map interactions, the suite checks shared dialog focus trapping, Escape and focus restoration, the hydrated engineer editor, and logout navigation. These checks live in `tests/ui-cleanup-browser-checks.mjs` and run through the dispatch browser suite.

The standalone MapLibre test allows 15 seconds for cold startup.
Readiness requires a ready style and a rendered booked marker across two samples, 100 ms apart.
Projected coordinates alone are insufficient. Task-based sampling avoids symbol-index reads during a frame.
The fixture completes roster processing before the first schedule response to prevent an extra geometry batch.
Every browser fixture uses an advancing clock aligned with its cache timestamps,
so the host date cannot expire its schedule before any booked markers render.
Default review dates stay historical; extended fixtures keep their current-day
demand coverage. Elapsed time and controlled stress offsets still advance the
clock, preserving polling and expiry behavior.

After readiness, CDP reads have a 1.5-second deadline. Camera movement probes request one fixture point's projection, not the full rendered-feature diagnostics; cold readiness still requires rendered markers.
The 12-second interaction budget starts after readiness and setup. A separate guard requires startup and interactions together to finish before the first 30-second production poll.
Keep heartbeat, request limits, and stable map-publication checks.

| Option | Use |
| --- | --- |
| `MAP_TEST_SLOW_STARTUP=1 pnpm test:browser` | Add a two-second startup stall |
| `MAP_TEST_DIAGNOSTIC_OUTPUT=<directory>` | Write small failure records |
| `MAP_TEST_PROFILE_STARTUP=1` | Add CPU profiles and bounded native traces |

Normal CI does not use heavy profiling. Fixture tests do not prove real-tile continuity or device performance.
For renderer changes, use the [MapLibre checks](maplibre-renderer.md#upgrade-and-basemap-checks).

## Allowed file checks

File-content tests are limited to:

- Immutable SQL artifacts: schema, constraints, and absence of tenant data.
  PostgreSQL tests must still prove execution.
- Declarative deployment settings: Compose secrets and local origins.
- Security absence: retired routes and direct Autotask write methods.

Explain why each new file-content assertion cannot use an API, lint rule, HTTP test, or integration test.
The existing suites are `deployment-contracts.test.ts` and `runtime-boundaries.test.ts` under `tests/`.
Required commands are in [CONTRIBUTING.md](../CONTRIBUTING.md#changes-and-validation).
