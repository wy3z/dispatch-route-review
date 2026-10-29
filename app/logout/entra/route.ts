import { resolveAuthMode, resolveEntraTenantId } from "@/modules/access/domain";

/** Resolve the only external destination permitted after proxy sign-out. */
export function entraLogoutLocation(
  environment: Record<string, string | undefined> = process.env,
) {
  if (resolveAuthMode(environment) !== "forward-auth") return null;
  const tenantId = resolveEntraTenantId(environment);
  return tenantId
    ? `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`
    : null;
}

/** Ignore request input and redirect only to the configured tenant. */
export function GET() {
  const location = entraLogoutLocation();
  if (!location) {
    return new Response("Logout is temporarily unavailable.", {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "private, no-store",
    },
  });
}
