"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppHeader } from "../../shared/ui/AppHeader";
import { compareRouteRegions } from "@/modules/dispatch/domain";
import type { EngineerRosterEntry } from "@/modules/engineers/contracts";
import { EngineerEditor } from "./EngineerEditor";
import { blankDraft, draftForEngineer, requestBody, workingDaysLabel } from "./engineer-draft";
import type { EngineerDraft } from "./engineer-draft";
import type { ThirdPartyVisitStatus } from "@/modules/work/contracts";

export default function EngineerManagementClient({
  canAccessDispatch,
  canAccessAdmin,
}: {
  canAccessDispatch: boolean;
  canAccessAdmin: boolean;
}) {
  const [engineers, setEngineers] = useState<EngineerRosterEntry[]>([]);
  const [thirdPartyStatuses, setThirdPartyStatuses] = useState<ThirdPartyVisitStatus[]>([]);
  const [savedThirdPartyStatusIds, setSavedThirdPartyStatusIds] = useState<number[]>([]);
  const [unselectedStatusIds, setUnselectedStatusIds] = useState<number[]>([]);
  const [selectedStatusIds, setSelectedStatusIds] = useState<number[]>([]);
  const [draft, setDraft] = useState<EngineerDraft | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [rosterResponse, statusesResponse] = await Promise.all([
        fetch("/api/engineers", { cache: "no-store" }),
        fetch("/api/engineers/third-party-statuses", { cache: "no-store" }),
      ]);
      const rosterPayload = (await rosterResponse.json().catch(() => null)) as
        | { engineers?: EngineerRosterEntry[]; message?: string }
        | null;
      const statusesPayload = (await statusesResponse.json().catch(() => null)) as
        | { statuses?: ThirdPartyVisitStatus[]; message?: string }
        | null;
      if (!rosterResponse.ok || !rosterPayload?.engineers) {
        throw new Error(rosterPayload?.message ?? `Roster request failed (${rosterResponse.status}).`);
      }
      if (!statusesResponse.ok || !statusesPayload?.statuses) {
        throw new Error(statusesPayload?.message ?? `Status request failed (${statusesResponse.status}).`);
      }
      setEngineers(rosterPayload.engineers);
      setThirdPartyStatuses(statusesPayload.statuses);
      setSavedThirdPartyStatusIds(
        statusesPayload.statuses.filter((item) => item.selected).map((item) => item.id),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const visibleEngineers = useMemo(
    () => engineers.filter((engineer) => showInactive || engineer.active),
    [engineers, showInactive],
  );

  function updateDraft(patch: Partial<EngineerDraft>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
  }

  async function saveThirdPartyStatuses() {
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const selectedIds = thirdPartyStatuses
        .filter((item) => item.selected)
        .map((item) => item.id);
      const response = await fetch("/api/engineers/third-party-statuses", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ selectedIds }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { statuses?: ThirdPartyVisitStatus[]; message?: string }
        | null;
      if (!response.ok || !payload?.statuses) {
        throw new Error(payload?.message ?? `Status save failed (${response.status}).`);
      }
      setThirdPartyStatuses(payload.statuses);
      setSavedThirdPartyStatusIds(selectedIds);
      setStatus("Third-party visit statuses were saved. Schedule refreshes have been queued.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function saveEngineer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/engineers", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(requestBody(draft)),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            engineer?: EngineerRosterEntry;
            message?: string;
            errors?: Record<string, string>;
          }
        | null;
      if (!response.ok || !payload?.engineer) {
        const details = Object.values(payload?.errors ?? {}).join(" ");
        throw new Error(
          details || payload?.message || `Save failed (${response.status}).`,
        );
      }
      const savedEngineer = payload.engineer;
      setEngineers((current) => {
        const found = current.some((engineer) => engineer.id === savedEngineer.id);
        const next = found
          ? current.map((engineer) => engineer.id === savedEngineer.id ? savedEngineer : engineer)
          : [...current, savedEngineer];
        return next.sort(
          (first, second) =>
            compareRouteRegions(first.region, second.region) ||
            first.name.localeCompare(second.name, "en-GB"),
        );
      });
      setStatus(`${payload.engineer.name} was saved.`);
      setDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function deactivateEngineer(engineer: EngineerRosterEntry) {
    if (!window.confirm(`Remove ${engineer.name} from the active engineer roster?`)) {
      return;
    }
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/engineers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ id: engineer.id }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { engineer?: EngineerRosterEntry; message?: string }
        | null;
      if (!response.ok || !payload?.engineer) {
        throw new Error(payload?.message ?? `Removal failed (${response.status}).`);
      }
      const savedEngineer = payload.engineer;
      setEngineers((current) => current.map((candidate) =>
        candidate.id === savedEngineer.id ? savedEngineer : candidate
      ));
      setStatus(`${engineer.name} was removed from the active roster.`);
      if (draft?.id === engineer.id) setDraft(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setSaving(false);
    }
  }

  function restoreEngineer(engineer: EngineerRosterEntry) {
    setDraft({ ...draftForEngineer(engineer), active: true });
    setStatus("Review the engineer details, then save to restore them.");
    setError("");
  }

  return (
    <main className="admin-page engineers-page">
      <AppHeader
        active="engineers"
        canAccessDispatch={canAccessDispatch}
        canAccessAdmin={canAccessAdmin}
        canManageEngineers
      />
      <header className="admin-heading engineers-heading">
        <h1>Engineer Controls</h1>
      </header>

      {error ? <p className="admin-status admin-status-error" role="alert">{error}</p> : null}
      {status ? <p className="admin-status" role="status">{status}</p> : null}

      {draft ? (
        <EngineerEditor
          draft={draft}
          saving={saving}
          updateDraft={updateDraft}
          onSave={saveEngineer}
          onClose={() => setDraft(null)}
        />
      ) : null}

      <section className="panel admin-panel engineers-third-party-panel">
        <div className="admin-audit-heading">
          <div>
            <h2>Third Party Attending Statuses</h2>
          </div>
          <button
            type="button"
            className="admin-action engineers-primary"
            disabled={saving || JSON.stringify(thirdPartyStatuses.filter((item) => item.selected).map((item) => item.id).sort((a, b) => a - b)) === JSON.stringify([...savedThirdPartyStatusIds].sort((a, b) => a - b))}
            onClick={() => void saveThirdPartyStatuses()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        <div className="engineers-status-transfer">
          <label>
            <span>Unselected</span>
            <select
              multiple
              aria-label="Unselected Autotask statuses"
              value={unselectedStatusIds.map(String)}
              onChange={(event) => setUnselectedStatusIds(
                [...event.currentTarget.selectedOptions].map((option) => Number(option.value)),
              )}
            >
              {thirdPartyStatuses.filter((item) => !item.selected).map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
                  {item.label} — ID {item.id}{item.available ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
          </label>
          <div className="engineers-status-transfer-actions">
            <button
              type="button"
              className="admin-action"
              aria-label="Mark selected statuses as third party"
              disabled={saving || unselectedStatusIds.length === 0}
              onClick={() => {
                const ids = new Set(unselectedStatusIds);
                setThirdPartyStatuses((current) => current.map((item) =>
                  ids.has(item.id) ? { ...item, selected: true } : item
                ));
                setUnselectedStatusIds([]);
              }}
            >
              <span aria-hidden="true">→</span>
            </button>
            <button
              type="button"
              className="admin-action"
              aria-label="Remove selected statuses from third party"
              disabled={saving || selectedStatusIds.length === 0}
              onClick={() => {
                const ids = new Set(selectedStatusIds);
                setThirdPartyStatuses((current) => current.map((item) =>
                  ids.has(item.id) ? { ...item, selected: false } : item
                ));
                setSelectedStatusIds([]);
              }}
            >
              <span aria-hidden="true">←</span>
            </button>
          </div>
          <label>
            <span>Third-party statuses</span>
            <select
              multiple
              aria-label="Selected third-party Autotask statuses"
              value={selectedStatusIds.map(String)}
              onChange={(event) => setSelectedStatusIds(
                [...event.currentTarget.selectedOptions].map((option) => Number(option.value)),
              )}
            >
              {thirdPartyStatuses.filter((item) => item.selected).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} — ID {item.id}{item.available ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!loading && !thirdPartyStatuses.length ? (
          <p className="admin-panel-description">No ticket statuses are available yet. Run the cache worker to sync Autotask metadata.</p>
        ) : null}
      </section>

      <section className="panel admin-panel engineers-roster-panel">
        <div className="admin-audit-heading">
          <div>
            <h2>Roster</h2>
            <p className="admin-panel-description">
              {engineers.filter((engineer) => engineer.active).length} active engineer{engineers.filter((engineer) => engineer.active).length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="engineers-roster-actions">
            <label className="engineers-show-inactive">
              <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.currentTarget.checked)} />
              <span>Show inactive</span>
            </label>
            <button
              type="button"
              className="admin-action engineers-add"
              onClick={() => {
                setDraft(blankDraft());
                setError("");
                setStatus("");
              }}
            >
              Add engineer
            </button>
          </div>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table engineers-table">
            <thead>
              <tr><th>Engineer</th><th>Autotask ID</th><th>Home base</th><th>Normal hours</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {visibleEngineers.map((engineer) => (
                <tr key={engineer.id}>
                  <td><strong>{engineer.name}</strong><small className={engineer.active ? "engineer-status-active" : "engineer-status-inactive"}>{engineer.active ? "Active" : "Inactive"}</small>{engineer.aliases?.length ? <small title="Names matched when a visit has no resource ID">Also: {engineer.aliases.join(", ")}</small> : null}</td>
                  <td><code>{engineer.resourceId}</code></td>
                  <td><strong>{engineer.base}</strong><small>{engineer.region}</small></td>
                  <td><strong>{engineer.workdayStart}–{engineer.workdayEnd}</strong><small>{workingDaysLabel(engineer.workingDays)}</small></td>
                  <td>
                    <div className="engineers-row-actions">
                      <button type="button" className="admin-action" disabled={saving} onClick={() => { setDraft(draftForEngineer(engineer)); setError(""); setStatus(""); }}>Edit</button>
                      {engineer.active ? (
                        <button type="button" className="admin-action engineers-remove" disabled={saving} onClick={() => void deactivateEngineer(engineer)}>Remove</button>
                      ) : (
                        <button type="button" className="admin-action" disabled={saving} onClick={() => restoreEngineer(engineer)}>Restore</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && !visibleEngineers.length ? <tr><td colSpan={5}><small>No engineers match this view.</small></td></tr> : null}
              {loading ? <tr><td colSpan={5}><small>Loading engineer roster…</small></td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
