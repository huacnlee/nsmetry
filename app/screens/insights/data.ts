/**
 * The loads behind the insights screens, keyed so that a request goes out only when its answer can
 * change. The free plan's binding limit is Worker requests, so this matters more than it looks:
 *
 *  - Each resource's source is a string key built in a `computed`. A computed notifies only when its
 *    value changes, and equal strings are equal, so a change that does not touch the key (the
 *    compare toggle for a breakdown, which has no previous period) starts no request.
 *  - The Overview's summary always asks for the previous period (`cmp=1`): it is the same one
 *    request either way, it gives every metric tile its delta, and the compare toggle then only
 *    shows or hides the dashed series instead of loading the screen again.
 *  - One breakdown request carries every dimension a screen shows (`dim=a,b,c`): tabs switch over
 *    rows already in hand.
 */
import { computed, resource } from "nsh";
import type { Breakdowns, Dim, Filter, RangeId, Scope, Summary } from "../../api";
import { api, scope } from "../../store";

interface Key {
  site: number;
  range: RangeId;
  filters: Filter[];
}

/**
 * The shared scope without the compare flag. With `extra`, one filter is forced on (a detail page's
 * value), and while `extra` gives none the key is null: no request.
 */
function scopeKey(extra?: () => Filter | null): () => Key | null {
  return () => {
    const s = scope();
    if (!s) return null;
    let filters = [...(s.filters ?? [])];
    if (extra) {
      // A load for one value (a detail page) asks nothing until there is a value.
      const add = extra();
      if (!add) return null;
      filters = [...filters.filter((f) => f.dim !== add.dim), add];
    }
    return { site: s.site, range: s.range, filters };
  };
}

const toScope = (k: Key, compare: boolean): Scope => ({ site: k.site, range: k.range, filters: k.filters, compare });

/** `/api/summary` for the shared scope, always with the previous period. */
export function summaryResource(extra?: () => Filter | null) {
  const key = computed(() => {
    const k = scopeKey(extra)();
    return k ? JSON.stringify(k) : null;
  });
  return resource(key, (k) => api.summary(toScope(JSON.parse(k) as Key, true)));
}

/** `/api/breakdown` of `dims` (one request) for the shared scope. */
export function breakdownResource(dims: readonly Dim[], limit: number, extra?: () => Filter | null) {
  const key = computed(() => {
    const k = scopeKey(extra)();
    return k ? JSON.stringify({ ...k, dims, limit }) : null;
  });
  return resource(key, (k) => {
    const q = JSON.parse(k) as Key & { dims: Dim[]; limit: number };
    return api.breakdown(toScope(q, false), q.dims, q.limit);
  });
}

/** What a list needs from a load: its value, its error, and a way to try again. */
export interface Loaded<T> {
  (): T | undefined;
  error: () => unknown;
  refetch: () => unknown;
}
export type BreakdownLoad = Loaded<Breakdowns>;
export type SummaryLoad = Loaded<Summary>;

/** An error's text for an EmptyState body. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}
