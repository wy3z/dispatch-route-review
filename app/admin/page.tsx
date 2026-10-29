import { pageUser } from "../navigation-access";
import { forbidden, unstable_rethrow } from "next/navigation";
import AdminClient from "./AdminClient";
import { AppHeader } from "../../shared/ui/AppHeader";
import {
  AuthenticationError,
  requireRole,
  hasPagePermission,
} from "@/modules/access/server";

async function resolveAdminAccess() {
  try {
    const user = await pageUser("/admin");
    requireRole(user, ["admin"]);
    const canAccessDispatch = await hasPagePermission(
      user.id,
      "dispatch_review",
    );
    const canManageEngineers = await hasPagePermission(
      user.id,
      "engineer_management",
    );
    return { ok: true as const, canAccessDispatch, canManageEngineers };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false as const, error };
  }
}

export default async function AdminPage() {
  const access = await resolveAdminAccess();
  if (access.ok) {
    return (
      <AdminClient
        canAccessDispatch={access.canAccessDispatch}
        canManageEngineers={access.canManageEngineers}
      />
    );
  }
  if (access.error instanceof AuthenticationError && access.error.status === 403) {
    forbidden();
  }
  const message =
    access.error instanceof AuthenticationError
      ? access.error.message
      : "Authorization is temporarily unavailable.";
  return (
    <main className="admin-page">
      <AppHeader
        active="admin"
        canAccessDispatch={false}
        canAccessAdmin={false}
        canManageEngineers={false}
      />
      <section className="panel page-hidden" role="alert">
        <p className="eyebrow">Access unavailable</p>
        <h1>Administration could not be opened</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}
