# Deployment

Deploy Dispatch Route Review with `docker/compose.example.yml`, which includes Traefik, OAuth2 Proxy, PostgreSQL, the application, a cache worker and a migration runner. Only Traefik publishes ports. Only the worker receives Autotask credentials.

| File | Purpose |
| --- | --- |
| `docker/compose.example.yml` | Deployment reference; adapt networking to the target environment |
| `docker/.env.prod.example` | Tracked placeholders for validation |
| `.env.prod` | Protected deployment settings, excluded from Git and images |

Use the same explicit Compose file and project directory for every command. Commands below run from the checkout root. They use protected values only in the target deployment; never supply production secrets to CI.

## First deployment

1. Select and record the application revision and previous deployed images.
2. Copy the production template to `.env.prod`.
3. Set file mode `0600`.
4. Fill the applicable settings.
   Use `openssl rand -hex 32` for `POSTGRES_PASSWORD`; Compose inserts it into a database URL.
5. Register a single-tenant Entra Web application.
   Register `https://<APP_FQDN>/oauth2/callback` as the exact Web redirect URI; it must match the configured OAuth2 Proxy redirect. See [Entra redirect URIs](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).
6. Set the tenant, client-secret value, and independent cookie secret.
7. Check DNS, restricted HTTPS access, certificate renewal, network isolation and the outbound path described below.
8. Check that ForwardAuth replaces client identity headers.
9. Check that the forwarded subject is stable and tenant-scoped.
10. Configure approved private HTTPS OSRM and [approved geocoders](geocoding-runbook.md), including a real `GEOCODER_USER_AGENT_CONTACT`. Replace every example Autotask queue/status ID with the correct immutable IDs for your tenant. Supply only `AUTOTASK_API_CODE`, `AUTOTASK_USERNAME`, and `AUTOTASK_SECRET` through a worker-only secret source; the reference passes these only to `cache-worker`. Protect the populated env file or inject these variables from your secret launcher. Never put them in Next.js env files.
Optionally set worker-only `AUTOTASK_THIRD_PARTY_COMPANY_FIELD` to the exact
supplier custom field name; leaving it empty keeps status-based third-party
ownership. Set app-only `AUTOTASK_WEB_URL` to the Autotask web UI HTTPS origin
(without credentials, path, query or fragment) to enable ticket links. Empty
disables all links, and explicit snapshot nulls always remain disabled.
Restart the affected process after changing these settings; the worker must
replace snapshots after changing the company field.

11. In the target environment, run:

```bash
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod config --quiet
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod build
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod up -d
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod ps
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod logs --follow migrate cache-worker
```

12. Have the intended first administrator sign in once. The account is stored as a viewer.
13. Read that account's exact stable `external_subject` from PostgreSQL and run the one-time bootstrap command described below.
14. Check migrations, Entra login/callback, page/API protection, cache data, role permissions, and the bootstrap audit event before release.

`migrate` completes before application/worker startup. Caches can take time to fill.
Local CI does not prove deployment connectivity or Entra login.

## Administrator provisioning

Authentication never grants an application role from email or UPN. New users are stored as viewers.
The initial administrator is promoted only by exact stored `external_subject`, after that identity has authenticated once.
Migration `018_administrator_bootstrap.sql` creates the persistent one-time bootstrap latch. If an administrator already exists when the migration is applied, the latch is consumed automatically.

Identify the intended stored account before running the command:

```bash
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod exec postgres \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT id, external_subject, email, display_name, role, active FROM app_users ORDER BY created_at;"'
```

Then promote exactly that immutable subject:

```bash
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod run --rm migrate \
  pnpm admin:bootstrap -- '<external-subject>'
```

The operation locks the bootstrap state, requires no active administrator, changes the stored role transactionally, consumes the latch, and appends `user.access.bootstrap` to `audit_events`. Re-running normal bootstrap fails after consumption.

Break-glass recovery is deliberately separate and is allowed only when no active administrator remains:

```bash
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod run --rm migrate \
  pnpm admin:bootstrap -- --break-glass '<external-subject>'
```

The recovery target must already exist and be active. Break-glass does not reopen the one-time bootstrap latch and writes `user.access.break_glass` to the audit trail.

## Reference stack

**Outbound connectivity is a deployment prerequisite.**
`docker/compose.example.yml` is not a deploy-as-is network configuration: its
app and cache-worker attach only to internal networks, so external provider
calls cannot work until the deployment supplies an approved outbound path. Attach
the app to egress for the approved OSRM endpoint and the worker to egress for
Autotask and the configured UK/EU geocoders. Keep PostgreSQL isolated, restrict
outbound destinations where practical, and do not publish additional service
ports just to enable outbound requests.

Before deployment, verify DNS/TLS and provider access from the actual app/worker containers using credential-safe checks, then verify route geometry and worker refresh. Compose config/build success does not prove runtime connectivity. The example does not automatically provision egress.

The example uses Let's Encrypt HTTP-01. Certificate issuance and renewal require public TCP 80 and correct DNS; see [Traefik ACME](https://doc.traefik.io/traefik/v3.3/https/acme/#httpchallenge).
Keep HTTPS application access restricted to approved internal networks.
If HTTP-01 is unsuitable, use DNS-01. Select an `EDGE_SUBNET` without network overlap.
`ACME_EMAIL` and `EDGE_SUBNET` apply only to the example.

Run repository checks from the checkout root with placeholders only:

```bash
docker compose --project-directory . -f docker/compose.example.yml --env-file docker/.env.prod.example config --quiet
docker compose --project-directory . -f docker/compose.example.yml --env-file docker/.env.prod.example build
```

Deployment checks use protected values in the target environment, never in CI.

## ForwardAuth identity-header handoff

The application accepts exactly `X-Auth-Request-User`, `X-Auth-Request-Email`, and `X-Auth-Request-Preferred-Username`. Legacy `X-Forwarded-User`, `X-Forwarded-Email`, and `X-Forwarded-Preferred-Username` identity aliases are rejected.

The reference stack applies an identity-sanitising [Headers middleware](https://doc.traefik.io/traefik/v3.3/middlewares/http/headers/#adding-and-removing-headers) before [ForwardAuth](https://doc.traefik.io/traefik/v3.3/middlewares/http/forwardauth/). OAuth2 Proxy supplies the canonical tuple through [`--set-xauthrequest`](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/#header-options). When integrating with an existing Traefik instance, preserve this order and contract:

1. Remove caller-supplied values for all six header names above by setting each `customRequestHeaders` value to an empty string.
2. Run ForwardAuth next with `trustForwardHeader=false` and `authResponseHeaders=X-Auth-Request-User,X-Auth-Request-Email,X-Auth-Request-Preferred-Username` so only OAuth2 Proxy repopulates the trusted tuple.
3. Keep security middleware after ForwardAuth and keep the application reachable only on its private Traefik network.
4. Protect pages and `/api/*`. OAuth2 Proxy `/oauth2/` routes must bypass ForwardAuth to avoid an authentication loop. The exact `/logout/entra` path is the only application handoff exception: it redirects to the fixed tenant logout endpoint after the proxy clears its cookie. Do not broaden it to a path prefix or an external redirect allowlist.

Check that normal Entra login succeeds, missing or legacy-only identity tuples return `401`, and client-supplied canonical or legacy identity values cannot survive Traefik into the application request. Keep the application network inaccessible to untrusted sibling containers; header sanitisation is defence in depth, not a replacement for isolation.

For a change to an existing proxy contract, stage the compatible proxy configuration before the application release. Keep the sanitizer during rollback; do not leave an application depending on headers the active proxy does not provide.

## Access and health

Admins grant roles and the `dispatch_review` and `engineer_management` permissions.
New users are viewers. `scheduler` adds no capability. The last active admin cannot be disabled or demoted.
Historical scheduler data remains inactive and append-only.

OAuth cookies are HTTPS-only, HttpOnly, and host-only.
ForwardAuth protects pages and `/api/*`. Entra tenant restriction is primary; email-domain restrictions are optional.
`preferred_username` must supply a usable UPN/email. Identity must use the stable tenant subject, not email.

```bash
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod ps
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod logs --tail=100 app cache-worker
```

| Check | Purpose |
| --- | --- |
| `/api/health/live` | Application process; keeps the UI reachable during cache faults |
| `/api/health/ready` | Database, cache, and worker status |
| OAuth2 Proxy `/ready` | Authentication service |
| `scripts/cache-worker-health.ts` | Worker check; no HTTP listener |

See [cache recovery](cache-freshness-operations.md), [worker memory](worker-cache-operations.md), and [OSRM limits](osrm-provider-protections.md).

## Updating a deployment

Before an update, record the current revision and images, confirm a restorable backup, inspect new migrations and their compatibility with the previous revision, and validate the target configuration. Stop app and cache-worker before running migrations to prevent mixed-version traffic; keep PostgreSQL running. Build the selected revision, run `migrate` to completion, then start app and cache-worker, followed by the authentication services as needed. The service dependencies also gate startup on migration success.

Check migration records, Entra callback/login/logout, page and API protection, existing user roles/permissions, worker refresh, route geometry, `/api/health/live` and `/api/health/ready`. Configuration/build success alone does not prove these runtime paths. Do not release a failed or unverified migration.

## Migration faults

The runner takes a database-wide advisory lock before reading or applying migrations.
Other runners wait. Success, failure, or session closure releases the lock.

The first checksum deployment fills missing `schema_migrations` checksums from the approved checkout.
Before this deployment, check that its files match the applied migrations. Check that a database backup can be restored.
The update is transactional and rejects missing applied files.
Migration `009` has a [specific compatibility rule](engineer-roster-bootstrap.md#migration-009-compatibility).

To inspect migration records:

```bash
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod exec postgres \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name;"'
```

To find the migration lock holder and waiting sessions:

```bash
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod exec postgres \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT locks.pid, locks.granted, activity.application_name,
           activity.state, activity.query_start, activity.query
      FROM pg_locks AS locks
      LEFT JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
     WHERE locks.locktype = \$\$advisory\$\$
       AND locks.classid = 1096045121
       AND locks.objid = 1296648018
     ORDER BY locks.granted DESC, locks.pid;"'
```

For an unexpected wait:

1. Check that no deployment is active.
2. Stop an abandoned migration process normally to close its session.
3. Before terminating a database backend, check its PID belongs to the abandoned runner.
4. Before termination, check that a current backup can be restored.

For a checksum mismatch, restore the file from the exact approved revision. Then rerun migrations.
Do not change the stored checksum to bypass the check.
If the applied file is unknown, stop deployment.
Restore a matching backup/revision or obtain a separately reviewed DBA repair.

## Backups and rollback

Before each deployment, check that a backup stored outside the deployment host can be restored. At least daily backups are recommended.
Choose a backup destination, retention and restore-test schedule. Configure monitoring for worker probes, cache readiness and queue failures using [cache alert conditions](cache-freshness-operations.md#alert-conditions), with a notification destination and an escalation owner.

```bash
docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod exec -T postgres \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > dispatch-route-review-$(date +%F).dump
```

Backups include users, roles, historical plans, audits, and caches.
To test a restore, use an isolated environment:

1. Stop its application and worker.
2. Create a clean target database.
3. Restore with PostgreSQL 16 `pg_restore --clean --if-exists`.

**Do not use `docker compose down -v` in production. It deletes volumes.**

Record the source/image revision before deployment. Check migrations, login, and readiness after deployment.
Roll back code/images alone only when migrations are backward compatible.
Otherwise, restore the matching database backup and prior revision together.

Restrict populated env files and Docker access to operators.
Document and test secret rotation. Cookie-secret rotation signs users out.
A database password change must update the database role and `.env.prod` together.
