import { chunks } from "../../../shared/collections";
import { outboundRequestSignal } from "./request-lifecycle";
import { numberValue } from "./autotask-records";
import type { AutotaskRecord } from "./autotask-records";
import { assertCacheWorker, trackedAutotaskFetch } from "./api-activity";
import { WorkerCache } from "./memory-cache";

export { assertCacheWorker };

const MAX_BATCH = 180;
const LOOKUP_CACHE_MS = 60 * 60 * 1000;
const METADATA_CACHE_MS = 60 * 60 * 1000;
const MEBIBYTE = 1024 * 1024;

/** Worker-owned Autotask records reused across schedule and demand refreshes. */
const lookupCache = new WorkerCache<string, AutotaskRecord>({
  name: "autotask_lookup",
  ttlMs: LOOKUP_CACHE_MS,
  maxEntries: 8_192,
  maxEstimatedBytes: 40 * MEBIBYTE,
});
/** Worker-owned entity field/picklist metadata shared by live loaders. */
const metadataCache = new WorkerCache<
  string,
  AutotaskFieldInformation[]
>({
  name: "autotask_metadata",
  ttlMs: METADATA_CACHE_MS,
  maxEntries: 32,
  maxEstimatedBytes: 4 * MEBIBYTE,
});

export type AutotaskPicklistValue = {
  value?: string | number;
  label?: string;
  isActive?: boolean;
};

export type AutotaskFieldInformation = {
  name?: string;
  dataType?: string;
  isQueryable?: boolean;
  picklistValues?: AutotaskPicklistValue[];
};

function stringBinding(name: string) {
  const value = process.env[name];
  return typeof value === "string" ? value : "";
}

export function autotaskCredentials() {
  const values = {
    ApiIntegrationCode: stringBinding("AUTOTASK_API_CODE"),
    UserName: stringBinding("AUTOTASK_USERNAME"),
    Secret: stringBinding("AUTOTASK_SECRET"),
  };
  return Object.values(values).every(Boolean) ? values : null;
}

function autotaskBaseUrl() {
  assertCacheWorker();
  const baseUrl = stringBinding("AUTOTASK_BASE_URL");
  // Each tenant lives in its own REST zone, so no default is correct for everyone.
  if (!baseUrl) throw new Error("AUTOTASK_BASE_URL must be set to the tenant's REST API endpoint.");
  return baseUrl;
}

export function safeAutotaskPaginationUrl(nextPageUrl: string, baseUrl: string) {
  const base = new URL(baseUrl);
  const next = new URL(nextPageUrl, base);
  const basePath = base.pathname.replace(/\/+$/, "");
  if (
    base.protocol !== "https:" ||
    next.protocol !== "https:" ||
    next.origin !== base.origin ||
    (next.pathname !== basePath && !next.pathname.startsWith(`${basePath}/`))
  ) {
    throw new Error("Autotask returned an unsafe pagination URL.");
  }
  return next.toString();
}

function headers() {
  assertCacheWorker();
  const auth = autotaskCredentials();
  if (!auth) throw new Error("Autotask credentials are not configured locally.");
  return {
    ...auth,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function responseRecords(payload: unknown, collection: "items" | "fields") {
  const records =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as AutotaskRecord)[collection]
      : undefined;
  if (
    !Array.isArray(records) ||
    records.some(
      (record) =>
        record === null || typeof record !== "object" || Array.isArray(record),
    )
  ) {
    throw new Error(`Autotask returned an invalid ${collection} collection.`);
  }
  return records as AutotaskRecord[];
}

async function entityInformation(
  entity: string,
  resource: "fields" | "userDefinedFields",
  signal?: AbortSignal,
) {
  const key = `${entity}:${resource}`;
  const cached = metadataCache.get(key);
  if (cached) return cached;

  const baseUrl = autotaskBaseUrl();
  const requestHeaders = headers();
  const response = await trackedAutotaskFetch(
    `${baseUrl}/${entity}/entityInformation/${resource}`,
    {
      headers: requestHeaders,
      cache: "no-store",
      signal: outboundRequestSignal(signal),
    },
    { entity, operation: "entity_information" },
  );
  const payload = (await response.json()) as {
    fields?: AutotaskFieldInformation[];
    errors?: string[];
  };
  if (!response.ok) {
    throw new Error(
      `${entity} ${resource} metadata: ${
        payload.errors?.join("; ") ||
        `Autotask returned ${response.status}.`
      }`,
    );
  }
  const records = responseRecords(payload, "fields") as AutotaskFieldInformation[];
  metadataCache.set(key, records);
  return records;
}

export function autotaskEntityFields(entity: string, signal?: AbortSignal) {
  return entityInformation(entity, "fields", signal);
}

/** Read-only Autotask query. This app never PATCH/PUT/DELETE Autotask entities. */
export async function autotaskQuery(
  entity: string,
  filter: AutotaskRecord[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const items: AutotaskRecord[] = [];
  const baseUrl = autotaskBaseUrl();
  const requestHeaders = headers();
  let pageNumber = 1;
  let response = await trackedAutotaskFetch(
    `${baseUrl}/${entity}/query`,
    {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ MaxRecords: 500, filter }),
      cache: "no-store",
      signal: outboundRequestSignal(signal),
    },
    { entity, operation: "query", pageNumber },
  );

  while (true) {
    signal?.throwIfAborted();
    const payload = (await response.json()) as {
      items?: AutotaskRecord[];
      pageDetails?: { nextPageUrl?: string | null };
      errors?: string[];
    };
    if (!response.ok) {
      throw new Error(
        `${entity}: ${
          payload.errors?.join("; ") ||
          `Autotask returned ${response.status}.`
        }`,
      );
    }
    items.push(...responseRecords(payload, "items"));
    const nextPageUrl = payload.pageDetails?.nextPageUrl;
    if (!nextPageUrl) break;
    pageNumber += 1;
    response = await trackedAutotaskFetch(
      safeAutotaskPaginationUrl(nextPageUrl, baseUrl),
      {
        headers: requestHeaders,
        cache: "no-store",
        signal: outboundRequestSignal(signal),
      },
      { entity, operation: "query", pageNumber },
    );
  }
  return items;
}

export async function autotaskQueryByIds(
  entity: string,
  field: string,
  values: Array<number | string>,
  signal?: AbortSignal,
) {
  const unique = [...new Set(values)].filter(Boolean);
  const results: AutotaskRecord[] = [];
  for (const batch of chunks(unique, MAX_BATCH)) {
    signal?.throwIfAborted();
    results.push(
      ...(await autotaskQuery(
        entity,
        [{ field, op: "in", value: batch }],
        signal,
      )),
    );
  }
  return results;
}

export async function autotaskQueryLookupByIds(
  entity: "Companies" | "CompanyLocations" | "Countries" | "Resources",
  values: Array<number | string>,
  signal?: AbortSignal,
) {
  const unique = [...new Set(values.map(numberValue).filter(Boolean))];
  const records: AutotaskRecord[] = [];
  const missing: number[] = [];
  unique.forEach((id) => {
    const key = `${entity}:${id}`;
    const cached = lookupCache.get(key);
    if (cached) records.push(cached);
    else missing.push(id);
  });
  const fetched = await autotaskQueryByIds(entity, "id", missing, signal);
  fetched.forEach((record) => {
    lookupCache.set(`${entity}:${numberValue(record.id)}`, record);
  });
  return [...records, ...fetched];
}
