import type { CacheKind } from "./snapshots";
import { cacheFreshnessValidator } from "../freshness";
import type { CacheFreshness } from "../freshness";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export function cacheSnapshotEtag(
  kind: CacheKind,
  scopeDate: string,
  sourceRefreshedAt: string,
  freshnessVersion?: string,
) {
  const suffix = freshnessVersion ? `:${freshnessVersion}` : "";
  return `"${kind}:${scopeDate}:${sourceRefreshedAt}${suffix}"`;
}

export function cacheSnapshotNotModified(request: Request, etag: string) {
  const value = request.headers.get("If-None-Match");
  if (!value) return false;
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag);
}

function cacheSnapshotHeaders(
  freshness: CacheFreshness,
  etag: string,
) {
  return {
    ...PRIVATE_HEADERS,
    ETag: etag,
    "X-Dispatch-Cache": freshness.status === "fresh"
      ? "hit"
      : freshness.status.replace("_", "-"),
    "X-Dispatch-Cache-Status": freshness.status,
    "X-Dispatch-Refresh-State": freshness.refresh.state,
    ...(freshness.sourceRefreshedAt
      ? { "X-Dispatch-Source-Refreshed-At": freshness.sourceRefreshedAt }
      : {}),
    ...(freshness.lastError
      ? { "X-Dispatch-Refresh-Error": "previous-refresh-failed" }
      : {}),
    ...(freshness.status === "stale"
      ? { Warning: '110 - "Response is stale"' }
      : {}),
  };
}

function refreshDetail(freshness: CacheFreshness, missing: boolean) {
  if (freshness.refresh.state === "idle") {
    return missing
      ? "No background refresh is currently queued."
      : `The last successful snapshot exceeded the ${Math.floor(
          freshness.maxAgeSeconds / 60,
        )}-minute maximum age. No background refresh is currently queued.`;
  }
  return missing
    ? "A background refresh has been queued. Please retry shortly."
    : `The last successful snapshot exceeded the ${Math.floor(
        freshness.maxAgeSeconds / 60,
      )}-minute maximum age. A background refresh has been queued.`;
}

export function cacheSnapshotResponse<T extends object>(args: {
  request: Request;
  freshness: CacheFreshness;
  payload: T | null;
  label: string;
  validatorVariant?: string;
}) {
  const freshnessVersion = [
    cacheFreshnessValidator(args.freshness),
    args.validatorVariant ? encodeURIComponent(args.validatorVariant) : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(":");
  const etag = cacheSnapshotEtag(
    args.freshness.kind,
    args.freshness.scopeDate,
    args.freshness.sourceRefreshedAt ?? "missing",
    freshnessVersion,
  );
  const headers = cacheSnapshotHeaders(args.freshness, etag);

  if (
    args.payload &&
    args.freshness.usable &&
    cacheSnapshotNotModified(args.request, etag)
  ) {
    return new Response(null, { status: 304, headers });
  }

  if (!args.payload || !args.freshness.usable) {
    const missing = args.freshness.status === "missing" || !args.payload;
    return Response.json(
      {
        message: missing
          ? `The ${args.label} cache is warming.`
          : `The ${args.label} cache is too old to use.`,
        detail: refreshDetail(args.freshness, missing),
        cache: args.freshness,
      },
      {
        status: 503,
        headers: { ...headers, "Retry-After": "5" },
      },
    );
  }

  return Response.json(
    { ...args.payload, cache: args.freshness },
    { headers },
  );
}
