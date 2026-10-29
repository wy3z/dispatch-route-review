import { pageUser } from "../navigation-access";
import { forbidden, unstable_rethrow } from "next/navigation";
import EngineerManagementClient from "./EngineerManagementClient";
import { AppHeader } from "../../shared/ui/AppHeader";
import {
  AuthenticationError,
  hasPagePermission,
  requirePagePermission,
} from "@/modules/access/server";

async function resolveEngineerAccess() {
  try {
    const user = await pageUser("/engineers");
    await requirePagePermission(user, "engineer_management");
    return {
      ok: true as const,
      canAccessDispatch: await hasPagePermission(user.id, "dispatch_review"),
      canAccessAdmin: user.role === "admin",
    };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false as const, error };
  }
}

export default async function EngineerManagementPage() {
  const access = await resolveEngineerAccess();
  if (access.ok) {
    return (
      <EngineerManagementClient
        canAccessDispatch={access.canAccessDispatch}
        canAccessAdmin={access.canAccessAdmin}
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
    <main className="admin-page engineers-page">
      <AppHeader
        active="engineers"
        canAccessDispatch={false}
        canAccessAdmin={false}
        canManageEngineers={false}
      />
      <section className="panel page-hidden" role="alert">
        <p className="eyebrow">Access unavailable</p>
        <h1>Engineer management could not be opened</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}
