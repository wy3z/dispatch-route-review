# Worker memory

The worker caches source lookups in process memory. It removes least-recently-used entries when a limit is reached.
It also removes expired entries every five minutes.

| Cache | Lifetime | Maximum entries | Estimated payload limit |
| --- | --- | ---: | ---: |
| `autotask_lookup` | 1 hour | 8,192 | 40 MiB |
| `autotask_metadata` | 1 hour | 32 | 4 MiB |
| `ticket_field_labels` | 1 hour | 1 | 4 MiB |
| `active_resources` | 1 hour | 1 | 8 MiB |

The total limit is 8,226 entries and 56 MiB of serialized keys and values.
This estimate excludes JavaScript object overhead. Use process RSS and heap values to assess actual memory use.
Geocode results use [PostgreSQL storage](geocoding-runbook.md#stored-data), not this memory budget.

During batches, the worker logs `worker_cache_metrics` at most once per minute.
The event contains process RSS, heap, external memory, and each cache's size, bytes, hits, misses, removals, and expirations.

```bash
docker compose --env-file .env.prod logs cache-worker \
  | grep '"event":"worker_cache_metrics"'
```

More removals with a stable cache size indicate a capacity limit.
If process memory increases while cache estimates stay stable, investigate other memory use.
