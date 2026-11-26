/**
 * Lists of one dimension's top values, built from the ui layer only:
 *
 *  - `DimensionRows`: the rows themselves (BarRow: a proportional bar, the value, its share of the
 *    total when one is known), with the loading, empty and error states. Pressing a row adds its
 *    value as a filter, which every screen then follows; the row of a value that is already the
 *    filter is static (pressing it would change nothing).
 *  - `DimensionView`: a whole section of a screen: underline tabs with icons and counts over a card
 *    of rows (Pages · Entry · Exit, Referrers · UTM ...), Linear's section view.
 *  - `DimensionPanel`: a titled panel of one dimension (the Tech grid).
 *
 * The data comes from the caller (one breakdown request per screen, see ./data.ts), so tabs and
 * panels never load on their own.
 */
import type { JSX } from "nsh";
import { signal, View } from "nsh";
import type { Dim, Row } from "../../api";
import { formatCount, formatPercent } from "../../format";
import { addFilter, canFilter, filterFor } from "../../store";
import { BarRow, Card, EmptyState, type GlyphName, Panel, Skeleton, Txt, UnderlineTabs } from "../../ui";
import { type BreakdownLoad, errorText } from "./data";

export interface DimensionSection {
  dim: Dim;
  label: string;
  icon?: GlyphName;
  /** The column's name over the rows ("Page", "Referrer"). */
  column?: string;
}

export interface DimensionRowsProps {
  dim: Dim;
  load: BreakdownLoad;
  /** The column's name over the rows. */
  column: string;
  /** A row's display name ("" → "Direct", "DE" → "Germany"). */
  formatName?: (dim: Dim, name: string) => string;
  /** Before a row's name (a country code in mono). */
  leading?: (dim: Dim, name: string) => JSX.Element;
  /** The whole the shares are of (the range's visitors); without it rows show no share. */
  total?: () => number | undefined;
  /** How many skeleton rows to hold the place while loading. */
  placeholderRows?: number;
  /** What a row's press does besides adding its filter (Pages also opens the route's page). */
  onFiltered?: (dim: Dim, name: string) => void;
  testID?: string;
}

export function DimensionRows(props: DimensionRowsProps) {
  const rows = (): Row[] => props.load()?.breakdowns[props.dim] ?? [];
  const max = () => Math.max(1, ...rows().map((r) => r.value));
  const name = (r: Row) => props.formatName?.(props.dim, r.name) ?? (r.name || "(none)");
  const share = (v: number) => {
    const t = props.total?.();
    return t && t > 0 ? formatPercent(Math.min(1, v / t)) : undefined;
  };
  const loading = () => !props.load.error() && props.load() === undefined;
  return (
    <View testID={props.testID}>
      <If when={props.load.error()}>
        <EmptyState
          icon="error"
          title="Could not load this list"
          body={errorText(props.load.error())}
          action={{ label: "Try again", onPress: () => void props.load.refetch() }}
        />
      </If>
      <If when={loading()}>
        <View class="gap-2 py-1">
          <Each of={[0.9, 0.72, 0.6, 0.48, 0.4, 0.3, 0.25, 0.2].slice(0, props.placeholderRows ?? 5)}>
            {(w) => <Skeleton width={`${Math.round(w() * 100)}%` as `${number}%`} height={20} />}
          </Each>
        </View>
      </If>
      <If when={!props.load.error() && props.load() !== undefined && rows().length === 0}>
        <EmptyState title="No data for this period" body="Try a longer range or remove a filter." />
      </If>
      <If when={rows().length > 0}>
        <View class="flex-row justify-between px-2 pb-1">
          <Txt size="caption" tone="muted">{props.column}</Txt>
          <Txt size="caption" tone="muted">Visitors</Txt>
        </View>
        <Each of={rows()} key={(r) => r.name}>
          {(r) => (
            <BarRow
              label={name(r())}
              value={formatCount(r().value)}
              secondary={share(r().value)}
              share={r().value / max()}
              leading={props.leading?.(props.dim, r().name)}
              onPress={!canFilter(props.dim) || filterFor(props.dim) === r().name ? undefined : () => {
                const name = r().name;
                addFilter(props.dim, name);
                props.onFiltered?.(props.dim, name);
              }}
              accessibilityHint="Filters every view by this value"
            />
          )}
        </Each>
      </If>
    </View>
  );
}

/** A section of a screen: underline tabs over a card of one dimension's rows. */
export function DimensionView(props: {
  sections: readonly DimensionSection[];
  load: BreakdownLoad;
  accessibilityLabel: string;
  formatName?: (dim: Dim, name: string) => string;
  leading?: (dim: Dim, name: string) => JSX.Element;
  total?: () => number | undefined;
  onFiltered?: (dim: Dim, name: string) => void;
  testID?: string;
}) {
  const active = signal<Dim>(props.sections[0]!.dim);
  const section = () => props.sections.find((s) => s.dim === active()) ?? props.sections[0]!;
  const count = (d: Dim) => props.load()?.breakdowns[d]?.length;
  return (
    <View class="gap-3" testID={props.testID}>
      <UnderlineTabs
        testID={props.testID ? `${props.testID}-tabs` : undefined}
        accessibilityLabel={props.accessibilityLabel}
        options={props.sections.map((s) => ({ value: s.dim, label: s.label, icon: s.icon, count: count(s.dim) }))}
        value={active()}
        onChange={(d) => active.set(d)}
      />
      <Card>
        {/* Rebuilt per tab (a ternary, not If) so the bars of the new dimension start from their own lengths. */}
        {(() => {
          const s = section();
          return (
            <DimensionRows
              dim={s.dim}
              load={props.load}
              column={s.column ?? s.label}
              formatName={props.formatName}
              leading={props.leading}
              total={props.total}
              placeholderRows={8}
              onFiltered={props.onFiltered}
            />
          );
        })()}
      </Card>
    </View>
  );
}

/** A titled panel of one dimension (the Tech grid, Overview's single lists). */
export function DimensionPanel(props: Omit<DimensionRowsProps, "column"> & { title: string; column?: string; note?: string }) {
  return (
    <Panel title={props.title} note={props.note} testID={props.testID}>
      <DimensionRows
        dim={props.dim}
        load={props.load}
        column={props.column ?? props.title}
        formatName={props.formatName}
        leading={props.leading}
        total={props.total}
        placeholderRows={props.placeholderRows}
      />
    </Panel>
  );
}
