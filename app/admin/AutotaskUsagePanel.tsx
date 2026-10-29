import type { AutotaskUsagePayload } from "../../modules/work/contracts";

type Props = {
  usage: AutotaskUsagePayload | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
};

export function AutotaskUsagePanel({ usage, loading, error, onRefresh }: Props) {
  return (
    <section className="panel admin-panel">
      <div className="admin-audit-heading">
        <div>
          <h2>Autotask API activity</h2>
        </div>
        <button
          type="button"
          className="admin-action"
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? "Refreshing…" : "Refresh counts"}
        </button>
      </div>
      {error ? (
        <p className="admin-status admin-status-error" role="alert">
          API activity is unavailable. {error}
        </p>
      ) : usage ? (
        <div className="admin-usage-content">
          <div className="admin-usage-summary" aria-label="Autotask API totals for the last 24 hours">
            <article><strong>{usage.summary.lastHourRequestCount}</strong><span>Requests · last hour</span></article>
            <article><strong>{usage.summary.averageRequestsPerHour}</strong><span>Average requests/hour · 24h</span></article>
            <article><strong>{usage.summary.requestCount}</strong><span>Requests · 24h</span></article>
            <article><strong>{usage.summary.successCount}</strong><span>Successful</span></article>
            <article><strong>{usage.summary.failureCount}</strong><span>Failed</span></article>
          </div>
          <details className="admin-usage-details">
            <summary>
              <span>View detailed activity</span>
              <small>Entities and seven-day trend</small>
            </summary>
            <div className="admin-usage-tables">
              <div className="admin-table-wrap">
              <h3>Last 24 hours by entity</h3>
              <table className="admin-table">
                <thead><tr><th>Entity</th><th>Operation</th><th>Requests</th><th>Failed</th><th>Average</th></tr></thead>
                <tbody>
                  {usage.breakdown.length ? usage.breakdown.map((row) => (
                    <tr key={`${row.entity}:${row.operation}`}>
                      <td><strong>{row.entity}</strong></td>
                      <td>{row.operation === "entity_information" ? "Metadata" : "Query"}</td>
                      <td>{row.requestCount}</td>
                      <td>{row.failureCount}</td>
                      <td>{row.averageDurationMs} ms</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={5}><small>No outbound requests recorded.</small></td></tr>
                  )}
                </tbody>
              </table>
              </div>
              <div className="admin-table-wrap">
              <h3>Seven-day trend</h3>
              <table className="admin-table">
                <thead><tr><th>Date</th><th>Requests</th><th>Successful</th><th>Failed</th></tr></thead>
                <tbody>
                  {usage.daily.length ? usage.daily.map((row) => (
                    <tr key={row.day}>
                      <td>{new Date(`${row.day}T12:00:00`).toLocaleDateString("en-GB")}</td>
                      <td>{row.requestCount}</td>
                      <td>{row.successCount}</td>
                      <td>{row.failureCount}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={4}><small>No outbound requests recorded.</small></td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>
          </details>
        </div>
      ) : (
        <p className="admin-panel-description">
          {loading ? "Loading API activity…" : "No API activity is available."}
        </p>
      )}
    </section>
  );
}
