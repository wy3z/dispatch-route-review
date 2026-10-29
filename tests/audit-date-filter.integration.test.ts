import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { GET } from "../app/api/audit/route";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const migrationsDirectory = join(process.cwd(), "db/migrations");

const windows = [
  {
    name: "winter",
    from: "2026-01-15", to: "2026-01-15",
    start: "2026-01-15T00:00:00.000Z", end: "2026-01-16T00:00:00.000Z",
  },
  {
    name: "summer",
    from: "2026-07-01", to: "2026-07-01",
    start: "2026-06-30T23:00:00.000Z", end: "2026-07-01T23:00:00.000Z",
  },
  {
    name: "spring DST day (23 hours)",
    from: "2026-03-29", to: "2026-03-29",
    start: "2026-03-29T00:00:00.000Z", end: "2026-03-29T23:00:00.000Z",
  },
  {
    name: "autumn DST day (25 hours)",
    from: "2026-10-25", to: "2026-10-25",
    start: "2026-10-24T23:00:00.000Z", end: "2026-10-26T00:00:00.000Z",
  },
  {
    name: "multiday spring DST range",
    from: "2026-03-28", to: "2026-03-30",
    start: "2026-03-28T00:00:00.000Z", end: "2026-03-30T23:00:00.000Z",
  },
  {
    name: "multiday autumn DST range",
    from: "2026-10-24", to: "2026-10-26",
    start: "2026-10-23T23:00:00.000Z", end: "2026-10-27T00:00:00.000Z",
  },
];

for (const zone of ["UTC", "Europe/London"]) {
  test(
    `audit date filters use London calendar bounds in a ${zone} session`,
    { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
    async (t) => {
      assert.ok(databaseUrl);
      const client = new Client({ connectionString: databaseUrl });
      const schema = `audit_dates_${process.pid}_${Date.now()}`;
      const previousPool = globalThis.__dispatchDatabasePool;
      const environment = {
        AUTH_MODE: "forward-auth",
        BOOTSTRAP_ADMIN_EMAILS: "",
        AUTH_SUBJECT_HEADER: "x-auth-request-user",
        AUTH_EMAIL_HEADER: "x-auth-request-email",
        AUTH_DISPLAY_NAME_HEADER: "x-auth-request-preferred-username",
      };
      const previousEnvironment = Object.fromEntries(
        Object.keys(environment).map((name) => [name, process.env[name]]),
      );
      const scopedDatabaseUrl = new URL(databaseUrl);
      scopedDatabaseUrl.searchParams.set(
        "options", `-c search_path=${schema},public -c TimeZone=${zone}`,
      );
      const pool = new Pool({ connectionString: scopedDatabaseUrl.toString() });

      await client.connect();
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        const migrationNames = (await readdir(migrationsDirectory))
          .filter((name) => /^\d{3}_.*\.sql$/.test(name))
          .sort();
        for (const name of migrationNames) {
          await client.query(await readFile(join(migrationsDirectory, name), "utf8"));
        }
        await client.query(
          `INSERT INTO app_users (external_subject, email, display_name, role)
           VALUES ('entra:audit-dates', 'audit@example.test', 'Audit Test', 'admin')`,
        );
        Object.assign(process.env, environment);
        globalThis.__dispatchDatabasePool = pool;
        const session = await pool.query("SHOW TimeZone");
        assert.equal(session.rows[0].TimeZone, zone);

        for (const window of windows) {
          const start = Date.parse(window.start);
          const end = Date.parse(window.end);
          const inside = [start, start + 30 * 60_000, (start + end) / 2, end - 1];
          const timestamps = [start - 1, ...inside, end, end + 30 * 60_000];
          const inserted = await client.query<{ id: string; occurred_at: Date }>(
            `INSERT INTO audit_events
               (occurred_at, actor_subject, actor_email, action, entity_type, request_id)
             SELECT instant, 'entra:audit-dates', 'audit@example.test', $2,
                    'audit_date_fixture', 'audit-date-test'
               FROM unnest($1::timestamptz[]) AS instant
             RETURNING id::text, occurred_at`,
            [timestamps.map((instant) => new Date(instant).toISOString()), window.name],
          );
          const expectedIds = inserted.rows
            .filter((row) => inside.includes(row.occurred_at.getTime()))
            .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime())
            .map((row) => row.id);
          assert.equal(expectedIds.length, 4);
          const styles = window.from === window.to ? ["range", "legacy"] : ["range"];
          for (const style of styles) {
            for (const format of ["json", "csv"]) {
              await t.test(`${window.name}, ${style}, ${format}`, async () => {
                const url = new URL("https://planner.example.test/api/audit");
                url.searchParams.set("action", window.name);
                if (style === "legacy") {
                  url.searchParams.set("date", window.from);
                } else {
                  url.searchParams.set("dateFrom", window.from);
                  url.searchParams.set("dateTo", window.to);
                }
                if (format === "csv") url.searchParams.set("format", "csv");
                const response = await GET(new Request(url, {
                  headers: {
                    "x-auth-request-user": "entra:audit-dates",
                    "x-auth-request-email": "audit@example.test",
                    "x-auth-request-preferred-username": "Audit Test",
                  },
                }));
                assert.equal(response.status, 200);
                assert.equal(response.headers.get("cache-control"), "private, no-store");
                let actualIds: string[];
                if (format === "csv") {
                  assert.match(response.headers.get("content-type") ?? "", /^text\/csv/);
                  const csv = await response.text();
                  const lines = csv.trim().split("\r\n");
                  assert.match(lines.shift() ?? "", /^"Time","Event ID",/);
                  actualIds = lines.map((line) => {
                    const match = /^"[^"]+","(\d+)",/.exec(line);
                    assert.ok(match, "CSV row must contain an event ID");
                    return match[1];
                  });
                } else {
                  const body = await response.json();
                  actualIds = body.events.map((event: { id: string }) => event.id);
                }
                assert.deepEqual(
                  actualIds,
                  expectedIds,
                  `Expected [${window.start}, ${window.end}) in ${zone}`,
                );
              });
            }
          }
        }
      } finally {
        await pool.end();
        globalThis.__dispatchDatabasePool = previousPool;
        for (const [name, value] of Object.entries(previousEnvironment)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await client.end();
      }
    },
  );
}
