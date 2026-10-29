/** Shared marker key; renderer chrome owns its placement and attribution. */
export function MapLegend({ showDemand, hasExcludedDemand }: { showDemand: boolean; hasExcludedDemand: boolean }) {
  return (
    <span className="map-legend" aria-label="Map legend">
      <span><i className="legend-marker legend-suggestion" /> Suggestion</span>
      <span><i className="legend-marker legend-demand queue-support"><b>S</b></i> Support</span>
      <span><i className="legend-marker legend-demand queue-other"><b>M</b></i> Maintenance</span>
      <span><i className="legend-marker legend-demand queue-install"><b>I</b></i> Install</span>
      <span><i className="legend-marker legend-open">1</i> Open visit</span>
      <span><i className="legend-marker legend-done">✓</i> Complete</span>
      <span><i className="legend-marker legend-issue">!</i> Issue modifier</span>
      <span><i className="legend-marker legend-third-party"><b>1</b></i> Third party modifier</span>
      <span>
        <i className="legend-marker legend-home" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M3.5 10.7 12 3.6l8.5 7.1v9.7H14v-5.9h-4v5.9H3.5Z" /></svg>
        </i>
        Home
      </span>
      <span><i className="legend-relationship"><b /></i> Straight-line proximity</span>
      <span><i className="legend-line open" /> Open road</span>
      <span><i className="legend-line complete" /> Completed road</span>
      <span><i className="legend-line return" /> Return home</span>
      {showDemand && (
        <>
          <span>
            <i className="legend-marker legend-attention">!</i>
            <b className="legend-attention-warning">Waiting over 24 hours</b>
          </span>
          <span>
            <i className="legend-marker legend-attention critical">!</i>
            <b className="legend-attention-critical">Blocked or overdue</b>
          </span>
          {hasExcludedDemand && (
            <span>
              <i className="legend-marker legend-excluded"><b>I</b></i>
              Unassigned · no covered base
            </span>
          )}
        </>
      )}
    </span>
  );
}
