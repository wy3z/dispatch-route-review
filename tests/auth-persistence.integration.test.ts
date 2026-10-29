import assert from "node:assert/strict";
import test from "node:test";
import { isolatedDatabase } from "./support/database";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const authMigrations = ["001_initial_schema.sql", "019_auth_identities.sql"];

type UserSnapshot = {
  email: string;
  display_name: string;
  updated_at: Date;
  last_seen_at: Date;
  xmin: string;
  ctid: string;
};

function authenticatedRequest(subject: string, email: string, displayName: string) {
  return new Request("https://planner.example.test/api/me", {
    headers: {
      "x-auth-request-user": subject,
      "x-auth-request-email": email,
      "x-auth-request-preferred-username": displayName,
    },
  });
}

test(
  "authenticated polling writes only for first login, expired presence, or profile changes",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    const client = await isolatedDatabase(t, {
      migrations: authMigrations,
      environment: { AUTH_MODE: "forward-auth", BOOTSTRAP_ADMIN_EMAILS: "" },
    });
    const subject = "entra:auth-persistence";

    const snapshot = async () => {
      const result = await client.query<UserSnapshot>(
        `SELECT email, display_name, updated_at, last_seen_at,
                xmin::text AS xmin, ctid::text AS ctid
           FROM app_users
          WHERE external_subject = $1`,
        [subject],
      );
      assert.equal(result.rowCount, 1);
      return result.rows[0];
    };

    const { authenticateRequest } = await import("../modules/access/server/auth");

    const firstLogin = await authenticateRequest(
      authenticatedRequest(subject, "user@example.test", "First User"),
    );
    assert.equal(firstLogin.role, "viewer");
    const firstSnapshot = await snapshot();

    await authenticateRequest(
      authenticatedRequest(subject, "user@example.test", "First User"),
    );
    await authenticateRequest(
      authenticatedRequest(subject, "user@example.test", "First User"),
    );
    const repeatedPollSnapshot = await snapshot();
    assert.equal(
      repeatedPollSnapshot.updated_at.getTime(),
      firstSnapshot.updated_at.getTime(),
    );
    assert.equal(
      repeatedPollSnapshot.last_seen_at.getTime(),
      firstSnapshot.last_seen_at.getTime(),
    );
    assert.equal(repeatedPollSnapshot.xmin, firstSnapshot.xmin);
    assert.equal(repeatedPollSnapshot.ctid, firstSnapshot.ctid);

    await client.query(
      `UPDATE app_users
          SET last_seen_at = clock_timestamp() - interval '16 minutes'
        WHERE external_subject = $1`,
      [subject],
    );
    const expiredPresenceSnapshot = await snapshot();
    await authenticateRequest(
      authenticatedRequest(subject, "user@example.test", "First User"),
    );
    const refreshedPresenceSnapshot = await snapshot();
    assert.ok(
      refreshedPresenceSnapshot.last_seen_at.getTime() >
        expiredPresenceSnapshot.last_seen_at.getTime(),
    );
    assert.equal(
      refreshedPresenceSnapshot.updated_at.getTime(),
      expiredPresenceSnapshot.updated_at.getTime(),
    );
    assert.notEqual(
      refreshedPresenceSnapshot.xmin,
      expiredPresenceSnapshot.xmin,
    );
    assert.notEqual(
      refreshedPresenceSnapshot.ctid,
      expiredPresenceSnapshot.ctid,
    );

    await client.query(
      `UPDATE app_users
          SET updated_at = clock_timestamp() - interval '1 hour',
              last_seen_at = clock_timestamp()
        WHERE external_subject = $1`,
      [subject],
    );
    const originalProfileSnapshot = await snapshot();
    const changedProfile = await authenticateRequest(
      authenticatedRequest(subject, "renamed@example.test", "Renamed User"),
    );
    assert.equal(changedProfile.email, "renamed@example.test");
    assert.equal(changedProfile.displayName, "Renamed User");
    const changedProfileSnapshot = await snapshot();
    assert.equal(changedProfileSnapshot.email, "renamed@example.test");
    assert.equal(changedProfileSnapshot.display_name, "Renamed User");
    assert.ok(
      changedProfileSnapshot.updated_at.getTime() >
        originalProfileSnapshot.updated_at.getTime(),
    );
    assert.equal(
      changedProfileSnapshot.last_seen_at.getTime(),
      originalProfileSnapshot.last_seen_at.getTime(),
    );
  },
);

test(
  "concurrent first sign-ins converge and one request authenticates once",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async (t) => {
    await isolatedDatabase(t, {
      migrations: authMigrations,
      environment: { AUTH_MODE: "forward-auth", BOOTSTRAP_ADMIN_EMAILS: "" },
    });

    const { authenticateRequest } = await import("../modules/access/server/auth");

    const raceSubject = "entra:auth-race";
    const [raceFirst, raceSecond] = await Promise.all([
      authenticateRequest(
        authenticatedRequest(raceSubject, "race@example.test", "Race User"),
      ),
      authenticateRequest(
        authenticatedRequest(raceSubject, "race@example.test", "Race User"),
      ),
    ]);
    assert.equal(raceFirst.id, raceSecond.id);
    assert.equal(raceFirst.email, "race@example.test");

    const memoRequest = authenticatedRequest(
      raceSubject,
      "race@example.test",
      "Race User",
    );
    const first = await authenticateRequest(memoRequest);
    const second = await authenticateRequest(memoRequest);
    assert.equal(second, first);
  },
);
