import { resolveAuthMode, resolveEntraTenantId } from "@/modules/access/domain";

export const LOGOUT_HANDOFF_PATH = "/logout/entra";

/** Production clears the proxy session before the fixed Entra handoff. */
export function logoutLocation(
  environment: Record<string, string | undefined> = process.env,
) {
  const mode = resolveAuthMode(environment);
  if (mode === "development") return "/";
  if (mode !== "forward-auth" || !resolveEntraTenantId(environment)) return null;
  return `/oauth2/sign_out?rd=${encodeURIComponent(LOGOUT_HANDOFF_PATH)}`;
}

export function GET() {
  const location = logoutLocation();
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
