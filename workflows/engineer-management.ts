import type { AppUser, AuditContext } from "@/modules/access/contracts";
import { deactivateEngineer, updateEngineer, insertEngineer } from "@/modules/engineers/server";
import type { PoolClient } from "pg";
import { appendAuditEvent } from "@/modules/access/server";
import { invalidateCacheSnapshots, updateThirdPartyVisitStatuses } from "@/modules/work/server";
import { withTransaction } from "../platform/database";
import type { EngineerRosterPayload } from "@/modules/engineers/contracts";

export async function refreshEngineerDependentSnapshots(
  client: PoolClient,
  requestedBy: string,
) {
  await invalidateCacheSnapshots(
    client,
    ["schedule", "planning_demand"],
    requestedBy,
  );
}
export async function createManagedEngineer(
  engineer: EngineerRosterPayload,
  actor: AppUser,
  context: AuditContext,
) {
  return await withTransaction(async (client) => {
    const created = await insertEngineer(client, engineer, actor.id);
    await appendAuditEvent(client, actor, context, {
      action: "engineer.created",
      entityType: "engineer_roster",
      entityId: created.id,
      afterState: created,
      metadata: { autotaskResourceId: created.resourceId },
    });
    await refreshEngineerDependentSnapshots(client, actor.id);
    return created;
  });
}
export async function updateManagedEngineer(
  id: string,
  engineer: EngineerRosterPayload,
  actor: AppUser,
  context: AuditContext,
) {
  return await withTransaction(async (client) => {
    const changed = await updateEngineer(client, id, engineer, actor.id);
    if (!changed) return null;
    const { before, after } = changed;
    await appendAuditEvent(client, actor, context, {
      action: "engineer.updated",
      entityType: "engineer_roster",
      entityId: id,
      beforeState: before,
      afterState: after,
      metadata: { autotaskResourceId: after.resourceId },
    });
    await refreshEngineerDependentSnapshots(client, actor.id);
    return after;
  });
}
export async function deactivateManagedEngineer(id: string, actor: AppUser, context: AuditContext) {
  return await withTransaction(async (client) => {
    const changed = await deactivateEngineer(client, id, actor.id);
    if (!changed) return null;
    const { before, after } = changed;
    if (before.active) {
      await appendAuditEvent(client, actor, context, {
        action: "engineer.deactivated",
        entityType: "engineer_roster",
        entityId: id,
        beforeState: before,
        afterState: after,
        metadata: { autotaskResourceId: after.resourceId },
      });
      await refreshEngineerDependentSnapshots(client, actor.id);
    }
    return after;
  });
}
export async function updateManagedThirdPartyStatuses(
  selectedIds: number[],
  actor: AppUser,
  context: AuditContext,
) {
  return await withTransaction(async (client) => {
    const changed = await updateThirdPartyVisitStatuses(client, selectedIds);
    if (!changed) return null;
    const { beforeSelectedIds, statuses: after } = changed;
    await appendAuditEvent(client, actor, context, {
      action: "third_party_visit_statuses.updated",
      entityType: "planner_settings",
      entityId: "third-party-visit-statuses",
      beforeState: {
        selectedIds: beforeSelectedIds,
      },
      afterState: { selectedIds },
    });
    await invalidateCacheSnapshots(client, ["schedule"], actor.id);
    return after;
  });
}
