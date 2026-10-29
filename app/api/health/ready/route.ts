import { publicCacheFreshness, readCacheSystemHealth } from "@/modules/work/server";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET() {
  try {
    const health = await readCacheSystemHealth();
    return Response.json(
      {
        status: health.status,
        ready: health.ready,
        checkedAt: new Date().toISOString(),
        worker: health.worker,
        caches: health.caches.map(publicCacheFreshness),
        queue: health.queue,
        issues: health.issues,
      },
      {
        status: health.ready ? 200 : 503,
        headers: {
          ...PRIVATE_HEADERS,
          "X-Dispatch-Worker-Status": health.worker.status,
        },
      },
    );
  } catch {
    return Response.json(
      {
        status: "not_ready",
        ready: false,
        worker: { status: "unknown", healthy: false },
        issues: [{ code: "database_unavailable", cacheKey: null }],
      },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
