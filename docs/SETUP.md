# Setup

How to run the demo, connect real Autotask data and run the checks.
For architecture see the [code map](CODEBASE.md). For production, see
[deployment](deployment.md) and [cache operations](cache-freshness-operations.md).

## Try the demo

You need Git, Docker and Docker Compose 2.20 or later. No Autotask account,
Entra registration, env file or host Node installation is needed. From a
checkout of this repository:

```bash
docker compose --project-directory . -f docker/compose.dev.yml --profile demo up --wait
```

Open **http://localhost:3100**. The first run downloads dependencies, starts
PostgreSQL, applies migrations and seeds fictional data before starting the app.
It runs locally without login. The seed grants the local development viewer
Dispatch Review access; it grants no administrator role or engineer management
access. Ports 3100 and 5432 must be free.

The map has six engineers with Manchester-area bases and 18 booked visits on
each populated day. There are eight unassigned demand items, including three
ready-to-book markers. An overlap, an impossible travel gap and a deliberately
far-off booking give Route Issues something to show. Ready-to-book demand is
an optional marker layer, never a booked route or a dispatch instruction.

Dates are relative to today in London. The seed fills today and weekdays in
the seven days before and after it; other weekend snapshots are empty. Names,
companies, sites, ticket numbers and record IDs are synthetic. Every site has
fixed coordinates, so seeding needs no geocoder. Map assets and server-side
road routing need internet access. Development uses the public OSRM demo;
road-provider failures appear as unavailable routing data.

There is no worker or automatic refresh in this demo. Today's data becomes
stale after five minutes and disappears at the normal 30-minute hard expiry.
To refresh it, including its relative dates:

```bash
docker compose --project-directory . -f docker/compose.dev.yml run --rm demo-seed
```

Rerunning updates the same roster rows and replaces snapshots without adding
duplicate visits or demand. Use a disposable database and keep the worker
stopped: the seed replaces snapshot keys in its date window. It refuses to
run without explicit `DEMO_SEED=1` (supplied by the profile), or with
`NODE_ENV=production` or non-development authentication.

Stop the stack, keeping its data:

```bash
docker compose --project-directory . -f docker/compose.dev.yml --profile demo down
```

Add `--volumes` to delete the demo database and dependency volumes. Without
`--profile demo`, no seed or worker starts; a clean database has no snapshots. More options,
including development Entra login, are in [development](development.md).

## Connect real Autotask data

Use a separate database from the demo. Create a dedicated API-only user with a
custom security level limited to the read access this integration needs.
Review the permissions explicitly: Autotask's default API-only security level
has broad access. See [Autotask API security](https://webservices.autotask.net/help/developerhelp/Content/APIs/REST/General_Topics/REST_Security_Auth.htm).

Supply `AUTOTASK_API_CODE`, `AUTOTASK_USERNAME` and `AUTOTASK_SECRET` only to the
cache worker through your approved secret source. Do not put them in Next.js
env files. Set worker-only `AUTOTASK_BASE_URL` to your tenant's REST API endpoint.
Optionally set worker-only `AUTOTASK_THIRD_PARTY_COMPANY_FIELD` to the exact
custom field name containing supplier text. When unset, third-party routes
group by the selected status instead. No approval custom fields are required.

Set app-only `AUTOTASK_WEB_URL` to your Autotask web UI HTTPS origin if you
want ticket links. It must have no path, credentials, query or fragment.
When unset, all ticket links are disabled. Explicit snapshot nulls remain
disabled even with configuration; the demo leaves this setting empty.

Replace the placeholder tenant IDs:

| Setting | Value |
| --- | --- |
| `AUTOTASK_SUPPORT_QUEUE_IDS` | Support queues, comma-separated IDs |
| `AUTOTASK_INSTALL_QUEUE_IDS` | Installation queues, comma-separated IDs |
| `AUTOTASK_SURVEY_QUEUE_IDS` | Survey queues, comma-separated IDs |
| `AUTOTASK_REQUESTED_STATUS_IDS` | Requested-work statuses, comma-separated IDs |
| `AUTOTASK_ACCESS_STATUS_IDS` | Access-request statuses, comma-separated IDs |
| `AUTOTASK_THIRD_PARTY_REQUEST_STATUS_IDS` | Third-party request statuses, comma-separated IDs |
| `AUTOTASK_READY_TO_BOOK_QUEUE_ID` | One ready-to-book queue ID, app and worker |
| `AUTOTASK_READY_TO_BOOK_STATUS_ID` | One ready-to-book status ID, app and worker |

Use the tenant's `GET /Tickets/entityInformation/fields` response: find
`queueID` and `status`, then match each intended picklist label to its numeric
`value`. Use those values, not labels or guessed IDs. Autotask documents the
metadata endpoint under [Tickets](https://webservices.autotask.net/help/developerhelp/Content/APIs/REST/Entities/TicketsEntity.htm).
The worker validates configuration and checks IDs against live metadata.

Populate the engineer roster through Engineer Management and select applicable
third-party visit statuses. Configure approved routing/geocoding providers,
then follow [deployment](deployment.md) for Entra, worker startup and
runtime checks. The [development guide](development.md#worker) covers a
local worker. The demo profile is only for synthetic local data.

## Tests

Run the full local check tier in containers:

```bash
scripts/verify.sh
```

It runs `pnpm lint`, `pnpm typecheck`, `pnpm test` and a whitespace check,
using a disposable PostgreSQL test database. Nothing is installed on the host.
For a second checkout, set a unique `COMPOSE_PROJECT_NAME` first.

Tests cover pure domain behavior, built-application HTTP responses, PostgreSQL
persistence and migrations, mocked-provider behavior, and browser interactions.
PostgreSQL suites skip without `TEST_DATABASE_URL`. Browser checks skip locally
without Chrome/Chromium and fail in CI if the browser is missing. Container
checks alone do not prove the real Entra callback or deployment connectivity.
See the [test strategy](testing-strategy.md) for commands and test boundaries.
