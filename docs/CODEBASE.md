# Architecture and trust boundaries

Dispatch Route Review is a modular monolith: one Next.js application, one PostgreSQL database, plus separate cache-worker and migration processes. Autotask is read-only; local PostgreSQL writes are expected for application state, audit, cache state, authorization, and roster changes.

## Repository ownership

| Area | Owns |
| --- | --- |
| `app/` | Next.js pages, API adapters, route-level authorization, and composition |
| `modules/` | Feature/domain behavior behind explicit public entry points |
| `platform/` | Shared infrastructure; currently PostgreSQL connection and transaction helpers |
| `shared/` | Generic dependency-light helpers and reusable UI with no feature ownership |
| `docs/` | Maintainer guidance and operational runbooks; this file is the canonical architecture map |

`workflows/engineer-management.ts` coordinates roster/status changes, audit, and snapshot invalidation in one transaction. Keep cross-module orchestration there rather than moving feature ownership into `app/`.

| Module | Owns |
| --- | --- |
| `access` | Identity, users, permissions, audit |
| `engineers` | Roster, bases, aliases, working hours, colours |
| `work` | Bookings, demand, coverage, snapshots, freshness, refresh queue, Autotask ingestion |
| `routing` | Route construction, road geometry, timing, issues, suggestions |
| `map` | MapLibre scene, lifecycle, layers, camera, popups |
| `dispatch` | Review projections, interaction state, rail, timeline, workspace |

Dependencies point downward: `dispatch → map → routing → work → engineers`; `access` is independent. Import another module through its root `contracts.ts`, `domain.ts`, `presentation.ts`, `client.ts`, `server.ts`, or `worker.ts` when present. Internals are private outside that module. `pnpm lint` enforces public imports, dependency direction, cycles, and browser/server/worker separation.

## Process ownership

| Process | Responsibility |
| --- | --- |
| Next.js app | Serves pages/APIs, authenticates and authorizes requests, reads PostgreSQL snapshots/local state, and performs authorized local writes. It has no Autotask credentials and does not call Autotask. |
| Cache worker | `scripts/cache-worker.ts` → `modules/work/worker/run.ts`. The only process allowed to receive Autotask credentials or perform live Autotask reads; it refreshes PostgreSQL snapshots and worker/request state. `CACHE_WORKER=1` guards the worker boundary. |
| Migration runner | `scripts/migrate.ts` applies `db/migrations/` under a database advisory lock before application/worker startup. |
| PostgreSQL | Local system of record for users, identities, permissions, roster state, audits, cache snapshots, queue/lease state, and other application-owned data. |

API routes adapt HTTP and enforce authorization; domain behavior stays in the owning module/workflow. SQL stays with its owning module except for connection/transaction plumbing in `platform/database.ts`.

## Autotask and cache boundary

Autotask is an external read-only source. The worker may use Autotask query endpoints, but no application path may create, update, or delete Autotask records. The browser and Next.js app consume cached PostgreSQL projections instead of contacting Autotask directly.

Snapshot freshness is policy-driven: fresh data is served normally, stale-but-usable data is served with age information, and data beyond maximum age is withheld. Ordinary cache reads do not perform live refreshes. Web entry points cannot import the refresh writer; ESLint enforces that boundary. The web process can write local queue/invalidation state through dedicated authorized paths; the worker owns the actual refresh.

Refresh work is fenced in PostgreSQL. A claim carries a lease owner and `claim_generation`; `request_generation` identifies the current requested work for a cache key. The worker renews its lease while live work is running and aborts that work if renewal is rejected or expires. Completion, release, retry, and dead-letter paths verify the active claim/generation so a lost or superseded worker cannot finalize stale work.

Detailed intervals, maximum ages, queue limits, readiness semantics, and recovery steps belong in [cache operations](cache-freshness-operations.md), not here.

## Authentication and trust boundaries

Production request flow is `browser → Traefik → OAuth2 Proxy / Entra → Next.js`. Application, PostgreSQL, worker, and migration services expose no public ports. Health probes are deliberate authentication exceptions. `/logout/entra` is the only application logout handoff allowed without ForwardAuth, and only as an exact path after OAuth2 Proxy clears its session.

Traefik strips caller-supplied canonical and legacy identity headers before ForwardAuth. OAuth2 Proxy supplies the canonical `X-Auth-Request-User`, `X-Auth-Request-Email`, and `X-Auth-Request-Preferred-Username` tuple; both `proxy.ts` and application authentication reject legacy-only, mixed, partial, or conflicting tuples.

`app_users.id` is the stable authorization principal. Exact OIDC subjects are owned in `auth_identities`; retired subjects remain reserved and `app_users.external_subject` is only the compatibility mirror of the current primary identity. Identity stage/replace/retire actions are audited, and final-administrator identity recovery is a separate dry-run-first operator path.

Authentication never grants application privilege from email, UPN, or Entra groups. New users start as viewers. The initial administrator is promoted explicitly by exact stored external subject through `admin:bootstrap`; break-glass provisioning is separate and only valid when no active administrator remains. Roles and page permissions live in PostgreSQL. Mutating API paths also enforce same-origin checks.

The deployment must use one concrete non-zero Entra tenant GUID. Logout redirects only to that configured tenant-specific Entra endpoint; request input cannot choose the destination.

Autotask credentials are worker-only. Do not place them in Next.js environment files, browser data, CI, images, logs, or tracked configuration. Return only the Autotask fields needed by the UI.

Ticket links are projected by the app from optional `AUTOTASK_WEB_URL`; worker snapshots omit the URL, and explicit snapshot nulls suppress links. The worker alone reads optional `AUTOTASK_THIRD_PARTY_COMPANY_FIELD`, otherwise grouping third-party visits by status.

Server-side routing/geocoding providers remain outside the browser trust boundary: OSRM is called by server code, and geocoding is worker-owned.

## Deployment

`docker/compose.example.yml` is the deployment reference, validated with tracked placeholders in `docker/.env.prod.example`. Adapt its networking and protected settings to the target environment before deployment.

Keep populated `.env.prod` files and secrets out of Git, images, PRs, and CI. Autotask credentials are restricted to the worker. Authentication, database/migration, deployment/worker, and CI paths have reviewers declared in `.github/CODEOWNERS`.

Deployment commands, secret handling, backups, checks, and rollback belong in [deployment](deployment.md).

## Main entry points

| Area | Entry point |
| --- | --- |
| Dispatch composition | `modules/dispatch/ui/DispatchReviewClient.tsx` |
| Dispatch projections/interaction | `modules/dispatch/model/`, `modules/dispatch/state/` |
| Map seam and lifecycle | `modules/map/contracts.ts`, `modules/map/ui/ReviewMap.tsx`, `modules/map/runtime/` |
| Synthetic demo | `scripts/demo-seed.ts` uses the existing queue/lease snapshot writer and roster helpers; `scripts/demo-data.ts` contains fictional data only |
| Worker orchestration | `modules/work/worker/run.ts` |
| Autotask transport | `modules/work/worker/autotask-server.ts` |
| Cache queue/snapshots | `modules/work/server/refresh.ts`, `modules/work/server/snapshots.ts` |
| Authentication | `modules/access/identity-headers.ts`, `modules/access/server/auth.ts`, `modules/access/server/auth-identity-store.ts`, `modules/access/server/auth-identities.ts`, `proxy.ts` |
| Administrator bootstrap/recovery | `modules/access/server/admin-bootstrap.ts`, `scripts/provision-administrator.ts`, `scripts/recover-auth-identity.ts` |
| Road geometry | `modules/routing/server/geometry.ts` |
| Engineer management workflow | `workflows/engineer-management.ts` |
| Database connection | `platform/database.ts` |

[Contributing rules](../CONTRIBUTING.md) · [Documentation index](README.md) · [Tests](testing-strategy.md) · [Development](development.md)
