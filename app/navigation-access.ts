import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import {
  authenticateRequest,
  developmentPageUser,
  hasPagePermission,
} from "@/modules/access/server";

export async function pageUser(path: string) {
  const requestHeaders = await headers();
  return developmentPageUser() ?? authenticateRequest(
    new Request(`http://dispatch-review.internal${path}`, { headers: requestHeaders }),
  );
}

/** Navigation is fail-closed; the page still enforces its own access requirement. */
export async function navigationAccess(path: string) {
  try {
    const user = await pageUser(path);
    return {
      canAccessDispatch: await hasPagePermission(user.id, "dispatch_review"),
      canAccessAdmin: user.role === "admin",
      canManageEngineers: await hasPagePermission(user.id, "engineer_management"),
    };
  } catch (error) {
    unstable_rethrow(error);
    return { canAccessDispatch: false, canAccessAdmin: false, canManageEngineers: false };
  }
}
