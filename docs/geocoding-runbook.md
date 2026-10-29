# Geocoding

The worker converts customer locations to coordinates.
An allowed hostname is not approval to send customer locations to a provider.
Before deployment, approve both processing paths for your data and jurisdiction.

## Provider approval

Keep the approval in the controlled deployment record, or link an immutable approval ticket from that record.
For each UK and continental Europe endpoint, record:

- Provider, service, exact URL, and allowed `host[:port]`.
- Service owner, legal/data-protection approver, and security review reference.
- Processing regions, subprocessors, cross-border transfers, and the exact fields sent.
- Request-log and backup retention, deletion, access-request, and incident terms.
- DPA/SCC, contract, or internal-processing basis.
- Approval date, review/expiry date, change ticket, and operational/incident contacts.

## Configuration

Set these values in protected `.env.prod` after approval:

```dotenv
UK_GEOCODER_URL=https://approved-geocoder.example/postcodes
EU_GEOCODER_URL=https://approved-geocoder.example/search
GEOCODER_ALLOWED_HOSTS=approved-geocoder.example
GEOCODER_USER_AGENT_CONTACT=https://example.com/contact
```

URLs must use absolute HTTPS addresses without credentials, queries, or fragments.
The comma-separated allowlist must contain each exact `host[:port]`. Redirects are rejected.
The UK endpoint must support the Postcodes.io bulk response format.
The EU endpoint must support the worker's Nominatim search response format.

`NODE_ENV=production` disables public defaults and rejects missing or invalid settings.
Public Postcodes.io and Nominatim defaults are for local development only.
`GEOCODER_USER_AGENT_CONTACT` identifies the deployment in the geocoder User-Agent. It is worker-only and required in production; replace the placeholder with a real contact URL. The [public Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/) requires an identifying Referer or User-Agent; this application also requires a deployment contact in production. Public use is limited to one request per second, with single-threaded cached bulk work on one machine; recurring or day-long scripts are restricted to four requests per minute. Do not send confidential or personal data to the public service. Use an approved private provider for production.

## Fields sent

| Endpoint | Input | Request |
| --- | --- | --- |
| UK | Normalized postcode only | HTTPS POST; JSON `postcodes` array; maximum 100 per batch |
| Continental Europe | `address1`, postal code, city, country display name, ISO country code | HTTPS query: `q`, `countrycodes`, `format=jsonv2`, `limit=1` |

EU retries use less-specific input. They can remove a motorway prefix or text before the first comma.
The worker does not send `address2`, state, company names, ticket descriptions, contacts, emails, engineers, or Autotask credentials.

## Stored data

PostgreSQL `geocode_cache` persists across worker restarts. Each record contains:

- SHA-256 key from provider type, endpoint, and normalized input.
- Provider type and approved host.
- `resolved` or `not_found` result.
- Coordinates for resolved results only.
- Refresh and expiry times.

The cache contains no raw address input, request URLs, or provider responses.
Resolved coordinates last 30 days. Valid misses last one hour.
An EU miss requires valid empty results for every query variant.
Network errors, redirects, failed HTTP responses, partial UK results, and invalid coordinates/responses are not stored as misses.

Worker startup logs only approved provider hosts.
Do not log queries, postcode bodies, addresses, responses, or cache-key input, including in error messages.
Treat raw location queries in logs as a possible data incident.

## Deployment checks

1. Complete the approval record.
2. Configure the approved endpoints.
3. Where supported, restrict worker network access to Autotask and approved geocoders.
4. Run `docker compose --project-directory . -f docker/compose.example.yml --env-file .env.prod config --quiet`.
5. Check that only the worker receives the four geocoder variables.
6. Start the worker.
7. Check that `geocoder_configuration_validated` contains only approved hosts.
8. Run a controlled refresh.
9. Check for 64-character hexadecimal cache keys and no raw address columns.
10. Check that logs contain no postcode bodies or EU query values.

## Incidents and changes

For suspected disclosure or an unapproved endpoint:

1. Stop `cache-worker`.
2. Block its geocoder network access.
3. Keep deployment and worker logs as evidence.
4. Notify the recorded operations and data-protection contacts.
5. Follow the incident procedure for provider logs.

Provider, host, path, region, retention, or contract changes require new approval.
Update the approval record and allowlist together. Check the startup event after deployment.
An endpoint change creates different cache keys and requires fresh lookups.
