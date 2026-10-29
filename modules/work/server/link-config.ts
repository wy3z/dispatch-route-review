type AutotaskWebEnvironment = { AUTOTASK_WEB_URL?: string };

/** App-only configuration; ticket links never require worker credentials. */
export function autotaskWebUrl(environment: AutotaskWebEnvironment = process.env as AutotaskWebEnvironment): string | null {
  const configured = environment.AUTOTASK_WEB_URL?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch { // Reject malformed configuration before it reaches browser links.
    throw new Error("AUTOTASK_WEB_URL must be a valid absolute URL.");
  }
  if (url.protocol !== "https:") throw new Error("AUTOTASK_WEB_URL must use HTTPS.");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("AUTOTASK_WEB_URL must be an origin without credentials, a path, query string or fragment.");
  }
  return url.origin;
}
