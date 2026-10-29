# Road routing limits

`POST /api/route-geometry` is an authenticated, read-only OSRM proxy.
Production requires an approved private HTTPS `OSRM_BASE_URL`.
The public `router.project-osrm.org` fallback is for local development only.

| Control | Limit |
| --- | --- |
| Physical OSRM calls per API request | 48, shared by all routes |
| Complete request deadline | 20 seconds |
| One OSRM fetch timeout | 15 seconds |
| Concurrent OSRM calls | 4 per Node.js process |
| Fallback after full-route `NoRoute` | 8 legs per route |
| API requests per user | 30 per 60 seconds per process |
| Circuit breaker | 30 seconds after 5 consecutive infrastructure failures |

The API returns a limit error for legs or routes beyond the call budget.
Earlier routes can use the remaining budget. The browser sends at most four routes per request.
A rate-limit response is HTTP `429` with `Retry-After`.

Network errors, unreadable responses, HTTP `429`, and HTTP `5xx` count as infrastructure failures.
A healthy response, including `NoRoute`, resets the failure count.
An open circuit rejects new provider work immediately.

## Cache and capacity

The server does not cache budget, deadline, or open-circuit failures.
It caches ordinary partial-route failures only for the short error lifetime.
The browser caches only complete routes without errors. A later load retries partial or limited results.

The provider must support four concurrent calls and respond within the complete request deadline.
Before adding web instances, provide a shared rate limit. Account for total OSRM concurrency.
These limits apply per process, not across the deployment.
