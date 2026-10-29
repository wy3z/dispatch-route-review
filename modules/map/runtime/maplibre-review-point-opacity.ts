import type { FeatureCollection } from "geojson";

type PointOpacity = { routeId: string; overview: number };
type SourceIndex = {
  points: Map<string, PointOpacity>;
  routes: Map<string, string[]>;
  applied: Map<string, number>;
  dirty: boolean;
};
type WriteOpacity = (source: string, id: string, opacity: number | null) => void;

/** Index canonical route points on publication and reconcile only changed opacity state. */
export class ReviewPointOpacity {
  private sources = new Map<string, SourceIndex>();
  private emphasis = new Set<string>();

  stage(source: string, data: FeatureCollection) {
    const points = new Map<string, PointOpacity>();
    const routes = new Map<string, string[]>();
    for (const feature of data.features) {
      const id = String(feature.id);
      const routeId = String(feature.properties!.routeId);
      points.set(id, { routeId, overview: feature.properties!.complete ? .64 : 1 });
      const ids = routes.get(routeId) ?? [];
      ids.push(id);
      routes.set(routeId, ids);
    }
    this.sources.set(source, { points, routes, applied: this.sources.get(source)?.applied ?? new Map(), dirty: true });
  }

  /** Only a proven full style replacement loses native state; C3 retention skips this. */
  reset() {
    for (const index of this.sources.values()) {
      index.applied.clear();
      index.dirty = true;
    }
  }

  reconcile(routeIds: readonly string[], write: WriteOpacity) {
    const next = new Set(routeIds);
    const modeChanged = Boolean(next.size) !== Boolean(this.emphasis.size);
    const changedRoutes = [...new Set([...next, ...this.emphasis])]
      .filter(id => next.has(id) !== this.emphasis.has(id));
    for (const [source, index] of this.sources) {
      if (index.dirty) {
        // Remove only our key: date/source changes must not retain old feature IDs
        // or erase state owned by another interaction.
        for (const id of index.applied.keys()) {
          if (!index.points.has(id)) { write(source, id, null); index.applied.delete(id); }
        }
      }
      const ids = index.dirty || modeChanged ? index.points.keys()
        : changedRoutes.flatMap(routeId => index.routes.get(routeId) ?? []);
      for (const id of ids) {
        const point = index.points.get(id)!;
        const opacity = next.size ? next.has(point.routeId) ? 1 : .38 : point.overview;
        if (index.applied.get(id) === opacity) continue;
        write(source, id, opacity);
        index.applied.set(id, opacity);
      }
      index.dirty = false;
    }
    this.emphasis = next;
  }
}
