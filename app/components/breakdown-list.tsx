/**
 * A top-N list for one or more dimensions ("Pages · Entry · Exit"), the building block of the
 * Pages, Sources, Geography and Tech screens. It loads `/api/breakdown` for the shared scope (site,
 * range, filters), shows the rows as proportional bars, and pressing a row adds it as a filter, which
 * every screen then follows. A dimension that is already filtered shows its value as the only row.
 */
import type { JSX } from "nsh";
import { resource, signal, View } from "nsh";
import type { Breakdowns, Dim, Row } from "../api";
import { formatCount } from "../format";
import { addFilter, canFilter, api, dimLabels, filterFor, scope } from "../store";
import { BarRow, EmptyState, Panel, PillTabs, Skeleton, Txt } from "../ui";

export function BreakdownList(props: {
  title: string;
  /** One dimension, or several shown as pill tabs. */
  dims: readonly Dim[];
  /** Tab labels when they should differ from the dimension names. */
  labels?: Partial<Record<Dim, string>>;
  limit?: number;
  /** A row's display name (a country code to its name, "" to "(direct)"). */
  formatName?: (dim: Dim, name: string) => string;
  /** Something before a row's name (a flag). */
  leading?: (dim: Dim, name: string) => JSX.Element;
  /**
   * Rows loaded by the caller (one `/api/breakdown` request carrying every list of a screen): the
   * list then makes no request of its own. Without it the list loads its own dimensions.
   */
  source?: { (): Breakdowns | undefined; error: () => unknown; refetch: () => unknown };
  testID?: string;
}) {
  const active = signal<Dim>(props.dims[0]!);
  // One request for every tab: switching tabs then shows rows at once.
  const own = resource(
    () => {
      const s = scope();
      return s && !props.source ? { s, dims: props.dims, limit: props.limit ?? 10 } : null;
    },
    (src) => api.breakdown(src.s, src.dims, src.limit),
  );
  const data = props.source ?? own;
  const rows = (): Row[] => data()?.breakdowns[active()] ?? [];
  const max = () => Math.max(1, ...rows().map((r) => r.value));
  const name = (r: Row) => props.formatName?.(active(), r.name) ?? (r.name || "(none)");

  return (
    <Panel
      testID={props.testID}
      title={props.title}
      actions={
        <If when={props.dims.length > 1}>
          <PillTabs
            accessibilityLabel={`${props.title} by`}
            options={props.dims.map((d) => ({ value: d, label: props.labels?.[d] ?? dimLabels[d] }))}
            value={active()}
            onChange={(d) => active.set(d)}
          />
        </If>
      }
    >
      <If when={data.error()}>
        <EmptyState icon="error" title="Could not load this list" body={String((data.error() as Error)?.message ?? "")} action={{ label: "Try again", onPress: () => void data.refetch() }} />
      </If>
      <If when={!data.error() && data() === undefined}>
        <View class="gap-2 py-1">
          <Each of={[0.9, 0.7, 0.55, 0.4, 0.3]}>{(w) => <Skeleton width={`${Math.round(w() * 100)}%` as `${number}%`} height={20} />}</Each>
        </View>
      </If>
      <If when={!data.error() && data() !== undefined && rows().length === 0}>
        <EmptyState title="No data for this period" body="Try a longer range or remove a filter." />
      </If>
      <If when={rows().length > 0}>
        <View class="flex-row justify-between px-2 pb-1">
          <Txt size="caption" tone="muted">{props.labels?.[active()] ?? dimLabels[active()]}</Txt>
          <Txt size="caption" tone="muted">Visitors</Txt>
        </View>
        <Each of={rows()} key={(r) => r.name}>
          {(r) => (
            <BarRow
              label={name(r())}
              value={formatCount(r().value)}
              share={r().value / max()}
              leading={props.leading?.(active(), r().name)}
              onPress={!canFilter(active()) || filterFor(active()) === r().name ? undefined : () => addFilter(active(), r().name)}
              accessibilityHint="Filters every view by this value"
            />
          )}
        </Each>
      </If>
    </Panel>
  );
}
