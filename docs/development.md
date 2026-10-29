# Development

Run commands from the checkout root. Compose mounts that checkout into the application.
`--project-directory .` keeps mounts and `.dev-auth/certs` relative to the root.

## Local Docker

```bash
docker compose --project-directory . -f docker/compose.dev.yml up --wait
# Open http://localhost:3100
docker compose --project-directory . -f docker/compose.dev.yml down
```

The stack starts the application and PostgreSQL without login or a worker.
`down` keeps database and dependency volumes. `down --volumes` deletes them.

New development users are viewers. To make the local development identity an administrator, open the application once so the user is stored, then run:

```bash
docker compose --project-directory . -f docker/compose.dev.yml run --rm migrate \
  pnpm admin:bootstrap -- 'dev:developer@localhost'
```

Use the exact stored `external_subject` if `DEV_USER_SUBJECT` is configured. The normal bootstrap is one-time; use the documented break-glass path only to recover from an administrator lockout.

## Demo data

With Docker and Compose 2.20+ installed, run from the checkout root:

```bash
docker compose --project-directory . -f docker/compose.dev.yml --profile demo up --wait
# Open http://localhost:3100
```

The opt-in `demo-seed` service runs once after dependencies and migrations;
the app waits for it when the profile is enabled. Without the profile, startup
still runs without a seed or worker. Compose's [optional dependency](https://docs.docker.com/reference/compose-file/services/#depends_on)
keeps that ordering local to the development stack. Production Compose is unchanged.

The seed creates six fictional engineers with Manchester-area bases, 18 booked
visits per weekday plus today (even on a weekend), and eight unassigned demand
items, including three ready-to-book markers. Schedule snapshots cover seven
days either side of today. Dates use the London calendar; booked times use
London local time, including daylight saving. Deliberate problems repeat on
each populated day: a 30-minute overlap, five minutes between Salford and
Stockport, and a Lerwick outlier beyond the 700 km routing limit.

No Autotask or Entra credentials are needed. The seed makes no provider calls;
fixed coordinates avoid geocoding. The browser still needs internet for map
assets, and the app calls the development public OSRM service for road legs.
Travel-time issues depend on that service; overlaps and out-of-range warnings
do not. This public OSRM setting is for development only.

Today's schedule and demand become stale after five minutes and unusable after
30 minutes. There is no demo refresh loop. Refresh the timestamps and relative
dates with:

```bash
docker compose --project-directory . -f docker/compose.dev.yml run --rm demo-seed
```

The same entry point is `pnpm demo:seed` inside a configured development process.
It requires explicit `DEMO_SEED=1`, `DATABASE_URL` and all eight non-secret ID settings listed below;
Compose supplies the same placeholders to the seed and worker. It refuses
`NODE_ENV=production` and non-development authentication. Reruns replace
snapshots and update the six roster rows using stable fictional IDs. Roster
attribution uses the normal local development viewer. The seed grants that
viewer only `dispatch_review` through the existing audited permission helper,
so a clean database passes normal API authorization. No role is promoted and
engineer management is not granted. Seed roster writes deliberately bypass
engineer event auditing: they are synthetic setup, not roster management
actions. The permission grant remains audited. The demo uses the local
development identity only; signing in through the Entra overlay returns 403
without a separate permission grant to that Entra identity.

Use a disposable demo database with no worker running. The seed replaces the
schedule/demand keys in its date window; do not run it against a real-data
development database. It requests only those keys, claims and writes through
the existing fenced writer, and releases unrelated claims without refreshing
them. A lost lease, superseded refresh, or unavailable key fails the command.
There are no new migrations. To undo the seed, remove the disposable volumes:

```bash
docker compose --project-directory . -f docker/compose.dev.yml --profile demo down --volumes
```

## Environment files

| Template | Destination |
| --- | --- |
| [Local](../docker/.env.dev.example), HOST WEB section only | `.env.local` for host Next.js |
| [Local](../docker/.env.dev.example), full file with ENTRA values | `.env.dev-auth` for Docker with Entra |
| [Production](../docker/.env.prod.example) | `.env.prod`; see [operations](deployment.md) |

Default Docker development needs no env file.
Keep populated files outside Git and images. Keep real Entra secrets out of `.env.local`.
Supply Autotask credentials only to the worker.

Autotask queue and status IDs are non-secret tenant configuration. Replace the
example IDs before reading real tenant data. Set these comma-separated positive
integer lists for the worker: `AUTOTASK_SUPPORT_QUEUE_IDS`,
`AUTOTASK_INSTALL_QUEUE_IDS`, `AUTOTASK_SURVEY_QUEUE_IDS`,
`AUTOTASK_REQUESTED_STATUS_IDS`, `AUTOTASK_ACCESS_STATUS_IDS`, and
`AUTOTASK_THIRD_PARTY_REQUEST_STATUS_IDS`. Set `AUTOTASK_READY_TO_BOOK_QUEUE_ID`
and `AUTOTASK_READY_TO_BOOK_STATUS_ID` as single positive integers for both app
and worker. Each ID must be at most `Number.MAX_SAFE_INTEGER`.

The worker validates all eight settings at startup, before any Autotask call,
and checks configured IDs against live ticket metadata when loading data.
For operational IDs, the web process reads only the two ready-to-book settings; missing or invalid
values return an audited 500 response on the first ready-to-book API request,
even when the cache is empty. Code has no default IDs. Development Compose
supplies overridable placeholders, so its default stack needs no env file;
production Compose requires all eight settings. After changing IDs, restart app
and worker and let the worker replace cached snapshots before relying on them.

Optional worker-only `AUTOTASK_THIRD_PARTY_COMPANY_FIELD` names the exact supplier
custom field; without it, third-party routes group by status. App-only
`AUTOTASK_WEB_URL` accepts an HTTPS origin without credentials, path, query
or fragment. Empty disables ticket links; demo snapshots also suppress them
explicitly. Restart the affected process after changing either setting.

Third-party visit statuses start unselected. The worker imports the status
catalog, then an administrator selects the applicable statuses in Engineer
Management. Migration 011 creates only the table and index.

## Worker

Supply `AUTOTASK_API_CODE`, `AUTOTASK_USERNAME`, and `AUTOTASK_SECRET` through an approved local secret launcher.
Local launchers are environment-specific and are not part of the repository.
With these variables in the worker command environment, run:

```bash
docker compose --project-directory . -f docker/compose.dev.yml \
  --profile worker up -d --wait cache-worker
```

Local batches run serially. Keep credentials out of Next.js env files.
Set `GEOCODER_USER_AGENT_CONTACT` to your contact URL when using real providers;
production requires it. See [geocoder configuration](geocoding-runbook.md#configuration).

To stop the worker:

```bash
docker compose --project-directory . -f docker/compose.dev.yml stop cache-worker
```

## Optional Entra login

1. Create a separate development Entra Web registration.
   The callback is `https://localhost:3443/oauth2/callback`.
2. Copy `docker/.env.dev.example` to `.env.dev-auth`.
3. Fill the ENTRA section with development values.
4. Generate the separate cookie secret as specified in the template.
5. Supply trusted `.dev-auth/certs/localhost.pem` and `localhost-key.pem`.
   `scripts/create-dev-auth-certificate.sh` creates a 30-day self-signed test certificate.
   Trust it only in a development browser.
6. Start the protected stack:

   ```bash
   docker compose --project-directory . --env-file .env.dev-auth \
     -f docker/compose.dev.yml -f docker/compose.dev-auth.yml \
     up --wait app oauth2-proxy socket-proxy traefik
   ```

7. Open `https://localhost:3443` and sign in once. The Entra user is stored as a viewer.
8. Query `app_users` for the exact stable Entra `external_subject`, then run the bootstrap command against that subject if administrator access is required.

Never reuse production secrets. The overlay removes port 3100 and requires ForwardAuth through loopback Traefik.
This setup does not test production certificate issuance.

To return to local development without login:

```bash
docker compose --project-directory . --env-file .env.dev-auth \
  -f docker/compose.dev.yml -f docker/compose.dev-auth.yml down
docker compose --project-directory . -f docker/compose.dev.yml up --wait app
```

## Optional host processes

Requirements: Node.js 24.19+, pnpm 11, PostgreSQL 16+.

1. Copy the template's HOST WEB section to `.env.local`.
2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Apply migrations:

   ```bash
   DATABASE_URL=postgresql://dispatch_route_review:dispatch_route_review@localhost:5432/dispatch_route_review pnpm db:migrate
   ```

4. Start Next.js:

   ```bash
   pnpm dev
   ```

The migration command requires an exported database URL. It does not read Next.js env files.
The administrator provisioning command has the same database requirement; see [production operations](deployment.md#administrator-provisioning) for bootstrap and break-glass semantics.

A separate host worker uses `pnpm cache:worker` with `CACHE_WORKER=1`, database settings, and worker credentials in its environment.
Public routing and geocoder defaults are for local development only.
See [tests](testing-strategy.md) for validation.
