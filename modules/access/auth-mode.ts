export type AuthMode = "development" | "forward-auth" | "invalid";

const ENTRA_TENANT_GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_GUID = "00000000-0000-0000-0000-000000000000";

/** Dev may omit AUTH_MODE. Production must set it; anything else fails closed. */
export function resolveAuthMode(
  environment: Record<string, string | undefined> = process.env,
): AuthMode {
  const configured = environment.AUTH_MODE?.trim();
  if (configured === "development" || configured === "forward-auth") {
    return configured;
  }
  if (!configured && environment.NODE_ENV !== "production") {
    return "development";
  }
  return "invalid";
}

/** Production logout must target one concrete Entra tenant, never an alias. */
export function resolveEntraTenantId(
  environment: Record<string, string | undefined> = process.env,
) {
  const tenantId = environment.ENTRA_TENANT_ID?.trim();
  if (
    !tenantId ||
    !ENTRA_TENANT_GUID.test(tenantId) ||
    tenantId.toLowerCase() === NIL_GUID
  ) {
    return null;
  }
  return tenantId;
}
