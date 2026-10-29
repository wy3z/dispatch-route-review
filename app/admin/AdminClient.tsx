"use client";

import { AutotaskUsagePanel } from "./AutotaskUsagePanel";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "../../shared/ui/AppHeader";
import type { PagePermission, UserRole as Role, ManagedUser, AuditLogEvent as AuditEvent } from "@/modules/access/contracts";
import type { AutotaskUsagePayload } from "@/modules/work/contracts";
import { jsonObject } from "../../shared/http";
import { londonCalendarDate } from "../../shared/calendar";

type AuditFilters = {
  resource: string;
  dateFrom: string;
  dateTo: string;
  action: string;
};
type AuditPayload = {
  events: AuditEvent[];
  filterOptions: { resources: string[]; actions: string[] };
};
function defaultAuditFilters(): AuditFilters {
  const today = londonCalendarDate();
  return { resource: "", dateFrom: today, dateTo: today, action: "" };
}

function auditUrl(filters: AuditFilters, format?: "csv") {
  const params = new URLSearchParams({ limit: "100" });
  if (filters.resource) params.set("resource", filters.resource);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  if (filters.action) params.set("action", filters.action);
  if (format) params.set("format", format);
  return `/api/audit?${params}`;
}

function auditEntityLabel(event: AuditEvent, users: ManagedUser[]) {
  if (event.entityType === "app_user" && event.entityId) {
    const user = users.find((candidate) => candidate.id === event.entityId);
    if (user) return user.displayName;
    const targetEmail = jsonObject(event.metadata)?.targetEmail;
    if (typeof targetEmail === "string" && targetEmail) return targetEmail;
  }
  if (
    event.entityType === "app_user_page" ||
    event.entityType === "app_user_page_permission"
  ) {
    const targetEmail = jsonObject(event.metadata)?.targetEmail;
    if (typeof targetEmail === "string" && targetEmail) return targetEmail;
  }
  return event.entityId || event.entityType.replaceAll("_", " ");
}

function auditEntityKind(entityType: string) {
  return entityType.replaceAll("_", " ");
}

export default function AdminClient({
  canAccessDispatch,
  canManageEngineers,
}: {
  canAccessDispatch: boolean;
  canManageEngineers: boolean;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [savedUsers, setSavedUsers] = useState<ManagedUser[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [permissions, setPermissions] = useState<PagePermission[]>([]);
  const [permissionUserId, setPermissionUserId] = useState("");
  const [autotaskUsage, setAutotaskUsage] = useState<AutotaskUsagePayload | null>(null);
  const [autotaskUsageError, setAutotaskUsageError] = useState("");
  const [autotaskUsageLoading, setAutotaskUsageLoading] = useState(false);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>(defaultAuditFilters);
  const [auditOptions, setAuditOptions] = useState<AuditPayload["filterOptions"]>({
    resources: [],
    actions: [],
  });
  const [auditLoading, setAuditLoading] = useState(false);
  const [status, setStatus] = useState("Loading access controls…");
  const [savingUser, setSavingUser] = useState<string | null>(null);
  const [savingPermission, setSavingPermission] = useState<string | null>(null);
  const auditRequestId = useRef(0);
  const permissionRequestId = useRef(0);

  const loadAutotaskUsage = useCallback(async () => {
    setAutotaskUsageLoading(true);
    setAutotaskUsageError("");
    try {
      const response = await fetch("/api/admin/autotask-usage", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | (Partial<AutotaskUsagePayload> & { message?: string })
        | null;
      if (!response.ok || !payload?.summary || !payload.breakdown || !payload.daily) {
        throw new Error(payload?.message ?? `API activity request failed (${response.status}).`);
      }
      setAutotaskUsage(payload as AutotaskUsagePayload);
    } catch (error) {
      setAutotaskUsage(null);
      setAutotaskUsageError(error instanceof Error ? error.message : String(error));
    } finally {
      setAutotaskUsageLoading(false);
    }
  }, []);

  const loadPagePermissions = useCallback(async (userId: string) => {
    const requestId = permissionRequestId.current + 1;
    permissionRequestId.current = requestId;
    const response = await fetch(
      `/api/admin/page-permissions?${new URLSearchParams({ userId })}`,
      { cache: "no-store" },
    );
    const payload = (await response.json().catch(() => null)) as
      | { message?: string; permissions?: PagePermission[] }
      | null;
    if (!response.ok || !payload?.permissions) {
      throw new Error(payload?.message ?? `Permission request failed (${response.status}).`);
    }
    if (permissionRequestId.current === requestId) {
      setPermissions(payload.permissions);
    }
  }, []);

  const load = useCallback(async () => {
    const usageRequest = loadAutotaskUsage();
    const [usersResponse, auditResponse] = await Promise.all([
      fetch("/api/admin/users", { cache: "no-store" }),
      fetch(auditUrl(defaultAuditFilters()), { cache: "no-store" }),
    ]);
    const failedResponse = [usersResponse, auditResponse].find(
      (response) => !response.ok,
    );
    if (failedResponse) {
      const payload = (await failedResponse.json().catch(() => null)) as
        | { message?: string }
        | null;
      throw new Error(payload?.message ?? "Administrator access is required.");
    }
    const usersPayload = (await usersResponse.json()) as { users: ManagedUser[] };
    const auditPayload = (await auditResponse.json()) as AuditPayload;
    setUsers(usersPayload.users);
    setSavedUsers(usersPayload.users);
    setEvents(auditPayload.events);
    setAuditOptions(auditPayload.filterOptions);
    setPermissionUserId("");
    setPermissions([]);
    setStatus("");
    await usageRequest;
  }, [loadAutotaskUsage]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void load().catch((error: unknown) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  function updateLocalUser(id: string, patch: Partial<ManagedUser>) {
    setUsers((current) =>
      current.map((user) => (user.id === id ? { ...user, ...patch } : user)),
    );
  }

  function selectPermissionUser(userId: string) {
    setPermissionUserId(userId);
    setPermissions([]);
    setStatus("");
    void loadPagePermissions(userId).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  }

  async function loadAuditEvents(filters: AuditFilters) {
    const requestId = auditRequestId.current + 1;
    auditRequestId.current = requestId;
    setAuditLoading(true);
    try {
      const response = await fetch(auditUrl(filters), { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | (Partial<AuditPayload> & { message?: string })
        | null;
      if (!response.ok || !payload?.events || !payload.filterOptions) {
        throw new Error(payload?.message ?? `Audit log request failed (${response.status}).`);
      }
      if (auditRequestId.current === requestId) {
        setEvents(payload.events);
        setAuditOptions(payload.filterOptions);
      }
    } catch (error) {
      if (auditRequestId.current === requestId) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (auditRequestId.current === requestId) setAuditLoading(false);
    }
  }

  function updateAuditFilters(patch: Partial<AuditFilters>) {
    const next = { ...auditFilters, ...patch };
    setStatus("");
    setAuditFilters(next);
    void loadAuditEvents(next);
  }

  function clearAuditFilters() {
    const defaults = defaultAuditFilters();
    setStatus("");
    setAuditFilters(defaults);
    void loadAuditEvents(defaults);
  }

  async function saveUser(user: ManagedUser) {
    setSavingUser(user.id);
    setStatus("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ userId: user.id, role: user.role, active: user.active }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { message?: string; user?: ManagedUser }
        | null;
      if (!response.ok || !payload?.user) {
        throw new Error(payload?.message ?? `Update failed (${response.status}).`);
      }
      updateLocalUser(user.id, payload.user);
      setSavedUsers((current) =>
        current.map((candidate) =>
          candidate.id === payload.user?.id ? payload.user : candidate,
        ),
      );
      setStatus(`Saved access for ${payload.user.email}.`);
      await loadAuditEvents(auditFilters);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingUser(null);
    }
  }

  async function savePermission(permission: PagePermission, granted: boolean) {
    setSavingPermission(permission.key);
    setStatus("");
    try {
      const response = await fetch("/api/admin/page-permissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          userId: permissionUserId,
          permissionKey: permission.key,
          granted,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { message?: string; permissions?: PagePermission[] }
        | null;
      if (!response.ok || !payload?.permissions) {
        throw new Error(payload?.message ?? `Update failed (${response.status}).`);
      }
      setPermissions(payload.permissions);
      const user = users.find((candidate) => candidate.id === permissionUserId);
      setStatus(`${permission.label} is now ${granted ? "granted" : "denied"} for ${user?.email ?? "this user"}.`);
      await loadAuditEvents(auditFilters);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingPermission(null);
    }
  }

  return (
    <main className="admin-page">
      <AppHeader
        active="admin"
        canAccessDispatch={canAccessDispatch}
        canAccessAdmin
        canManageEngineers={canManageEngineers}
      />
      <header className="admin-heading">
        <h1>Administration</h1>
      </header>

      {status ? <p className="admin-status" role="status">{status}</p> : null}

      <AutotaskUsagePanel
        usage={autotaskUsage}
        loading={autotaskUsageLoading}
        error={autotaskUsageError}
        onRefresh={() => void loadAutotaskUsage()}
      />

      <section className="panel admin-panel admin-users-panel">
        <div className="admin-audit-heading">
          <div>
            <h2>People and access</h2>
          </div>
          <span className="admin-user-count">{users.length} user{users.length === 1 ? "" : "s"}</span>
        </div>
        <div className="admin-user-list">
          {users.map((user) => {
            const expanded = permissionUserId === user.id;
            const savedUser = savedUsers.find((candidate) => candidate.id === user.id);
            const dirty = Boolean(
              savedUser &&
              (savedUser.role !== user.role || savedUser.active !== user.active),
            );
            return (
              <article className={`admin-user-card${expanded ? " expanded" : ""}`} key={user.id}>
                <div className="admin-user-main">
                  <div
                    className="admin-user-identity"
                  >
                    <i aria-hidden="true">{user.displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</i>
                    <span><strong>{user.displayName}</strong><small>{user.email}</small></span>
                  </div>
                  <button
                    type="button"
                    className="admin-action admin-access-toggle"
                    aria-expanded={expanded}
                    aria-controls={`admin-user-permissions-${user.id}`}
                    aria-label={`${expanded ? "Hide" : "Manage"} permissions for ${user.email}`}
                    onClick={() => {
                      if (expanded) {
                        setPermissionUserId("");
                        setPermissions([]);
                      } else {
                        selectPermissionUser(user.id);
                      }
                    }}
                  >
                    {expanded ? "Hide permissions" : "Permissions"}
                  </button>
                  <label className="admin-user-field">
                    <span>Role</span>
                    <select value={user.role} onChange={(event) => updateLocalUser(user.id, { role: event.currentTarget.value as Role })} aria-label={`Role for ${user.email}`}>
                      <option value="viewer">Viewer</option>
                      <option value="scheduler">Scheduler</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </label>
                  <label className="admin-user-enabled">
                    <input type="checkbox" checked={user.active} onChange={(event) => updateLocalUser(user.id, { active: event.currentTarget.checked })} aria-label={`Enabled for ${user.email}`} />
                    <span>{user.active ? "Enabled" : "Disabled"}</span>
                  </label>
                  <span className="admin-user-seen"><small>Last seen</small>{new Date(user.lastSeenAt).toLocaleString("en-GB")}</span>
                  {dirty || savingUser === user.id ? (
                    <button type="button" className="admin-action admin-user-save" disabled={savingUser === user.id} onClick={() => void saveUser(user)}>
                      {savingUser === user.id ? "Saving…" : "Save changes"}
                    </button>
                  ) : null}
                </div>
                {expanded ? (
                  <div
                    className="admin-user-pages"
                    id={`admin-user-permissions-${user.id}`}
                    aria-label={`Page permissions for ${user.displayName}`}
                  >
                    <header><strong>Page permissions</strong></header>
                    <div>
                      {permissions.map((permission) => (
                        <label className="admin-page-control" key={permission.key}>
                          <span><strong>{permission.label}</strong><small>{permission.path}</small></span>
                          <input type="checkbox" checked={permission.granted} disabled={savingPermission === permission.key} onChange={(event) => void savePermission(permission, event.currentTarget.checked)} aria-label={`Grant ${permission.label} to ${user.email}`} />
                          <b>{savingPermission === permission.key ? "Saving…" : permission.granted ? "Granted" : "Denied"}</b>
                        </label>
                      ))}
                      {!permissions.length ? <p className="admin-panel-description">Loading permissions…</p> : null}
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel admin-panel">
        <div className="admin-audit-heading">
          <div>
            <h2>Audit events</h2>
            <p className="admin-panel-description">
              {auditLoading ? "Loading…" : `${events.length} most recent matching event${events.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <a
            className="admin-action admin-download"
            href={auditUrl(auditFilters, "csv")}
            download
          >
            Download CSV
          </a>
        </div>
        <div className="admin-audit-filters" aria-label="Audit log filters">
          <label>
            <span>Resource</span>
            <select
              value={auditFilters.resource}
              onChange={(event) => updateAuditFilters({ resource: event.currentTarget.value })}
            >
              <option value="">All resources</option>
              {auditOptions.resources.map((resource) => (
                <option key={resource} value={resource}>{resource}</option>
              ))}
            </select>
          </label>
          <label>
            <span>From</span>
            <input
              type="date"
              value={auditFilters.dateFrom}
              max={auditFilters.dateTo || undefined}
              onChange={(event) => updateAuditFilters({ dateFrom: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="date"
              value={auditFilters.dateTo}
              min={auditFilters.dateFrom || undefined}
              onChange={(event) => updateAuditFilters({ dateTo: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>Action</span>
            <select
              value={auditFilters.action}
              onChange={(event) => updateAuditFilters({ action: event.currentTarget.value })}
            >
              <option value="">All actions</option>
              {auditOptions.actions.map((action) => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="admin-action"
            onClick={clearAuditFilters}
          >
            Reset to today
          </button>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Time</th><th>Resource</th><th>Action</th><th>Entity</th><th>Context</th></tr></thead>
            <tbody>
              {events.length ? events.map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.occurredAt).toLocaleString("en-GB")}</td>
                  <td>{event.actorEmail}</td>
                  <td><code>{event.action}</code></td>
                  <td className="admin-audit-entity">
                    <strong>{auditEntityLabel(event, users)}</strong>
                    <small>{auditEntityKind(event.entityType)}</small>
                  </td>
                  <td><small>{JSON.stringify(event.metadata)}</small></td>
                </tr>
              )) : (
                <tr><td colSpan={5}><small>No audit events match these filters.</small></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
