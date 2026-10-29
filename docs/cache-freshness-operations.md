# Cache operations

The worker updates PostgreSQL snapshots. Browser and API reads never start or queue a refresh.
The worker keeps 30 past days, today, and 30 future days ready for review.

## Data age

| Cache | Refresh interval | Maximum age |
| --- | ---: | ---: |
| Today | 5 minutes | 30 minutes |
| Planning demand | 5 minutes | 30 minutes |
| Future schedule | 1 hour | 6 hours |
| Past schedule | 24 hours | 7 days |

`fresh` data is within the refresh interval. `stale` data remains usable, with a warning.
At the maximum age, the API returns `503` with age information but no snapshot.

The browser checks every 30 seconds while visible. Retry delays apply when the page becomes visible again.
A `304` response keeps the existing data references. Reads continue after missing or expired data to permit recovery.
Maximum age clears displayed data, even when demand controls are hidden.

Schedule data in session storage lasts at most two minutes, subject to the same maximum age.
There is no persistent browser storage.

## Queue limits

Roster and status changes can queue worker refreshes. Cache reads cannot.

Old review-date jobs outside the warm window enter `cache_refresh_dead_letters` after six failed attempts.
The worker keeps these records for at most seven days and logs `cache_refresh_dead_lettered`.
These jobs do not block the ready queue. Dates inside the warm window use normal worker maintenance.
System refreshes and invalidations keep the normal lease and retry controls.

## Health

`/api/health/ready` checks PostgreSQL, today's schedule, planning demand, queue progress, leases, and failures.

| Response | Meaning |
| --- | --- |
| `200 ready` | Both operational caches are fresh; the worker makes progress |
| `200 warming` | A recent queued, retry-wait, or leased refresh is creating missing data |
| `200 degraded` | Data is stale but usable, or the worker has a problem below the maximum-age limit |
| `503 not_ready` | Data exceeds maximum age, or data is missing without recent refresh activity |

The worker health check uses the same policy. It fails for `not_ready` or a stalled worker.
The web container and Traefik use `/api/health/live`. Cache failure must not make the application unreachable.
The readiness response contains status and counts only. Authenticated cache APIs also return the last refresh error.

| Worker fault | Limit |
| --- | ---: |
| No successful operational refresh | 15 minutes |
| Oldest ready queue item | 15 minutes |
| Consecutive operational refresh failures | 3 |
| Expired lease | Any |

## Alert conditions

- Two failed worker probes, 30 seconds apart.
- Readiness `not_ready` or HTTP `503`.
- `worker.status=stalled` for more than five minutes.
- Queue age of 900 seconds, any expired lease, or three consecutive operational failures.
- Repeated dead-letter events or a persistent increase in their count.

A degraded cache needs investigation before the 30-minute operational maximum age.
Configure alert owners and destinations as part of [deployment](deployment.md#backups-and-rollback).

## Recovery

1. Check the worker logs and container state:

   ```bash
   docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod logs --since=30m cache-worker
   docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod ps
   ```

2. Check readiness for the affected cache, queue age, failures, and expired leases.
3. For past or future review failures, check `cache_refresh_dead_letters` before a forced retry.
4. Check container access to PostgreSQL and Autotask.
5. Check credentials through the approved worker-only secret source.
6. If the worker has stopped or cannot progress, restart it:

   ```bash
   docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod restart cache-worker
   ```

7. Check that both operational caches are fresh, the worker is healthy, and queue age and failures decrease.

Do not delete queue records, snapshots, dead letters, or leases as an initial repair.
Deletion can remove pending work or failure evidence. Do not restart the web application to hide stale data.
If the fault continues, keep the logs and escalate the source fault.

## Request records

Administration shows counts for one hour, 24 hours, and seven London calendar days.
Each physical request creates `autotask_api_request_completed` and a PostgreSQL record.
Records contain only entity, operation, method, page, outcome/status, and duration.
They exclude URLs, filters, headers, payloads, and returned records.
Once per London day, the worker removes records older than eight days.
