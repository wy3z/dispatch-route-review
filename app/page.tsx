import { pageUser } from "./navigation-access";
import { forbidden, unstable_rethrow } from "next/navigation";
import DispatchReviewClient from "@/modules/dispatch/client";
import { AccessError } from "./dispatch-access-error";
import {
  AuthenticationError,
  hasPagePermission,
  requirePagePermission,
} from "@/modules/access/server";

async function resolveDispatchAccess() {
  try {
    const user = await pageUser("/");
    await requirePagePermission(user, "dispatch_review");
    return {
      ok: true as const,
      canAccessAdmin: user.role === "admin",
      canManageEngineers: await hasPagePermission(
        user.id,
        "engineer_management",
      ),
    };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false as const, error };
  }
}

export default async function DispatchReviewPage() {
  const access = await resolveDispatchAccess();
  if (access.ok) {
    return (
      <DispatchReviewClient
        canAccessAdmin={access.canAccessAdmin}
        canManageEngineers={access.canManageEngineers}
      />
    );
  }
  if (access.error instanceof AuthenticationError && access.error.status === 403) {
    forbidden();
  }
  if (access.error instanceof AuthenticationError) {
    return (
      <AccessError status={access.error.status} message={access.error.message} />
    );
  }
  return (
    <AccessError
      status={503}
      message="Authorization is temporarily unavailable."
    />
  );
}
