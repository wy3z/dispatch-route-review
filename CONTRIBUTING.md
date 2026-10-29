# Contributing rules

These rules apply to the entire repository.
Dispatch Route Review is a read-only Autotask dispatch review demo.
Data path: Next.js standalone → PostgreSQL ← cache worker → Autotask.
Deployments use Traefik, OAuth2 Proxy, and Entra.
Cloudflare Worker/Vite deployment is retired.

## Task guides

Read the applicable guide before changes:

| Task | Guide |
| --- | --- |
| Find code | [Code map](docs/CODEBASE.md) |
| Local setup, Docker, development Entra | [Development](docs/development.md) |
| Renderer | [MapLibre](docs/maplibre-renderer.md) |
| Deployment, authentication, providers, backups, alerts | [Deployment](docs/deployment.md) and its linked runbooks |
| Cache policy and request records | [Cache operations](docs/cache-freshness-operations.md) |
| Tests | [Test strategy](docs/testing-strategy.md) |

Use official vendor documents for current configuration.
MapLibre is the only renderer. Engine and navigation experiments remain retired.

## Data and security

- Never write Autotask records.
  Only `cache-worker`, guarded by `CACHE_WORKER=1`, can call Autotask or receive its credentials.
  Web reads use PostgreSQL snapshots and never start or queue refreshes.
  Existing privileged roster/status mutations retain transactional snapshot invalidation.
- Return only necessary Autotask fields to the browser.
  Exclude ticket descriptions, contacts, emails, credentials, and environment values.
- Match Autotask records and picklists by immutable numeric ID.
  Keep IDs through snapshots and projections. Use labels only for display,
  except territory grouping: UK territories and country-name fallbacks use labels;
  a non-GB ISO country code takes precedence.
  Show a warning when scope filtering fails. Distinguish failure from a valid empty result.
- Require Entra for production pages and `/api/*`, except health probes.
  Trust identity headers only on the private Traefik network.
  ForwardAuth must replace client headers. Check for a stable tenant-scoped subject before adding users.
- Store roles in PostgreSQL. Do not map roles from Entra groups.
  Preserve `viewer`, `scheduler`, and `admin`. The `scheduler` role adds no capability.
  Only admins manage users, permissions, and audit access.
  Keep the protection against disabling or demoting the last active admin.
- Keep page permissions `dispatch_review` and `engineer_management`.
  The latter grants only engineer roster management. Require the admin role for administration, not an `admin` page permission.
  Deactivate roster records instead of deleting them.
- Supply only the three Autotask credentials through an approved worker-only secret source.
  Keep populated env files out of Git, images, CI, and PRs.
  Keep Autotask credentials out of Next.js env files. Use separate development Entra credentials.

## Behavior and scope

- Poll only while the page is visible.
  Use an effect-local request window to suppress immediate remount retries.
  Do not rebuild routes or geometry for unchanged ETags.
  Clear data at hard expiry, but permit recovery reads.
  Paused demand keeps its usable snapshot and expiry deadline.
- Keep optional ready-to-book unassigned demand as cached markers only.
  Never use it as booked routes, road legs, Route Issues, dispatch items, or optimizer input.
- Keep historical scheduler plans, revisions, and audits inactive and append-only.
  Deletion or reactivation requires a separate product and migration review.
- Require an approved private HTTPS `OSRM_BASE_URL` in production.
  Use the public demo only for development, never as a browser dependency.
  Keep server-side geometry until a replacement is proven.

## Changes and validation

- Keep deployment examples in `docker/compose.example.yml`.
  Document services, settings, startup order, migrations, checks, and rollback requirements.
- Use pnpm. Do not create `package-lock.json`.
  Add SQL files in `db/migrations/` with increasing migration numbers.
  Never rewrite deployed migrations.
- Keep derived facts in the owning module; JSX displays them. Use public module entry points.
  Reuse `modules/work/presentation.ts`, including `jobTypeLabel`.
  Keep dispatch projections, interaction state, and map lifecycle separate.
  Preserve source/attendance identity and explicit suggestion context; do not scaffold future planning.
- Add folders, context providers, or a global store only when moving existing functions cannot solve the change.
  Give each new file one responsibility that can be described in one sentence.
  Keep architecture documentation in `docs/CODEBASE.md`; do not add duplicate module READMEs.
- Update affected README files, runbooks, examples, and these rules when behavior, operations, architecture, security, or required checks change.
- Before code handoff, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `git diff --check`.
  Add proportionate integration tests for PostgreSQL, Entra, OAuth2 Proxy, Traefik, or Autotask changes.
- For deployment changes, run both example checks with tracked placeholders:

  ```bash
  docker compose --project-directory . -f docker/compose.example.yml --env-file docker/.env.prod.example config --quiet
  docker compose --project-directory . -f docker/compose.example.yml --env-file docker/.env.prod.example build
  ```

  These checks are PR merge gates.
  Check real settings, Compose, migrations, provider connectivity, and the Entra callback in the target environment before deployment.
  Runtime deployment checks are separate from PR merge gates.
  Never supply production secrets to CI.

## Typography

Use design-system tokens at 100% zoom. Apply these sizes to tooltips and map overlays too:

| Text | Size |
| --- | --- |
| Primary text and values | 13–14px |
| Controls and critical warnings | At least 13px |
| Secondary text | 12–13px |
| Metadata | 12px |
| Badges and eyebrows | 11–12px |
| Titles | 15–18px |

Never use less than 11px. Reserve 11px for tertiary information.
Use less content, tighter spacing, grouping, wrapping, or more width to reduce clutter.
Do not reduce text size. Show hierarchy through weight, color, and spacing.
