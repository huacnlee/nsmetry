/**
 * Chart wrappers on `nsh/base/plot` (no chart package): every screen draws its series through these,
 * so the look (one brand line on a soft area, a dashed faint comparison, hairline grid, muted 11pt
 * axis labels) and the motion stay one system.
 *
 * Motion: the series draws in from the leading edge over `slow` (360ms) on the soft curve when the
 * data's identity changes (`generation`: a new range, metric or filter); a domain change glides over
 * `base`; the hover fades over `instant`. NSH runs all of it at once under reduced motion.
 * Heatmap cells grow from their middles one after another over `slow` (stagger 0.4) on a new
 * generation, glide to a new color over `base`, and the others fade to 55% while one is hovered.
 */
import type { JSX } from "nsh";
import { signal, token, View } from "nsh";
import { Area, Bar, Cell, Grid, Line, Plot, PlotAxis } from "nsh/base/plot";
import { Txt } from "./text";
import { motion, type } from "./tokens";

export interface SeriesPoint {
  label: string;
  cur: number;
  /** The comparison period's value at the same offset; null/undefined when not comparing. */
  prev?: number | null;
}

const plotMotion = {
  appear: { duration: motion.duration.slow, easing: motion.settle },
  update: { duration: motion.duration.base, easing: motion.settle },
  enter: { duration: motion.duration.instant },
  exit: { duration: motion.duration.instant },
};

/** About `count` evenly spaced row indices, always including the first and last. */
export function tickIndices(length: number, count: number): number[] {
  if (length <= 0) return [];
  if (length <= count) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(i * step));
}

/**
 * A line + soft area time series with an optional dashed comparison line, an x axis of the labels
 * and a y axis of `format`ted values. The tooltip shows the row under the pointer.
 */
export function TimeSeries(props: {
  points: SeriesPoint[];
  /** Turns a value into text for the axis and tooltip ("1.2k", "34%", "1m 20s"). */
  format: (value: number) => string;
  /** Change it to redraw the series in (a new metric, range or filter). */
  generation?: string | number;
  height?: number;
  accessibilityLabel: string;
  /** Label of the comparison series in the tooltip ("Previous 7 days"). */
  compareLabel?: string;
  /** Name of the main series in the tooltip ("Active users"); without one the tooltip shows the value alone. */
  label?: string;
  /**
   * What `prev` is: the previous period (`"compare"`, the default: dashed and faint) or a second
   * series of the same period (`"series"`: solid, in `chart-2`, e.g. new users beside active ones).
   */
  secondary?: "compare" | "series";
  testID?: string;
}) {
  const hasPrev = () => props.points.some((p) => p.prev != null);
  const second = () => props.secondary === "series";
  // The row under the pointer, for the tooltip: a signal, so the tooltip's bindings follow it.
  const hovered = signal<number | null>(null);
  return (
    <View testID={props.testID} style={{ height: props.height ?? 220 }} class="pl-1">
      <Plot
        data={props.points}
        y="cur"
        xScale={{ type: "point" }}
        yScale={{ type: "linear" }}
        motion={plotMotion}
        appearGeneration={props.generation ?? 0}
        accessibilityLabel={props.accessibilityLabel}
        crossLineClass="w-px bg-border-strong"
        dotClass="h-2 w-2 rounded-full bg-brand border-2 border-background"
        class="flex-1 text-brand stroke-border"
        style={{ marginLeft: 36, marginBottom: 20 }}
        onHoverChange={(e) => hovered.set(e.index)}
        tooltipContent={<ChartTooltip points={props.points} index={hovered} format={props.format} compareLabel={props.compareLabel} label={props.label} />}
      >
        <Grid ticks={4} class="stroke-border" />
        <Area y1="cur" curve="linear" class="fill-brand-soft" />
        <If when={hasPrev() && !second()}>
          <Line y={(d: SeriesPoint) => d.prev ?? Number.NaN} curve="linear" class="stroke-compare" style={{ strokeWidth: 1.5, strokeDasharray: "4 4" }} hoverDotClass="h-1.5 w-1.5 rounded-full bg-compare" />
        </If>
        <If when={hasPrev() && second()}>
          <Line y={(d: SeriesPoint) => d.prev ?? Number.NaN} curve="linear" class="stroke-chart-2" style={{ strokeWidth: 2 }} hoverDotClass="h-2 w-2 rounded-full bg-chart-2 border-2 border-background" />
        </If>
        <Line y="cur" curve="linear" class="stroke-brand" style={{ strokeWidth: 2 }} />
        <PlotAxis placement="left" ticks={4} format={(v) => props.format(v)} labelClass="pr-2 text-faint" labelStyle={type.micro} />
        <PlotAxis
          placement="bottom"
          tickValues={tickIndices(props.points.length, 6)}
          format={(v) => props.points[v]?.label ?? ""}
          labelClass="pt-1.5 text-faint" labelStyle={type.micro}
        />
      </Plot>
    </View>
  );
}

function ChartTooltip(props: { points: SeriesPoint[]; index: () => number | null; format: (v: number) => string; compareLabel?: string; label?: string }) {
  const p = () => {
    const i = props.index();
    return i == null ? undefined : props.points[i];
  };
  return (
    <View class="rounded-(--radius) border border-border bg-popover px-2 py-1.5 gap-0.5">
      <Txt size="caption" tone="muted">{p()?.label ?? ""}</Txt>
      <Txt size="ui" weight="medium" numeric>{p() ? (props.label ? `${props.label}: ${props.format(p()!.cur)}` : props.format(p()!.cur)) : ""}</Txt>
      <If when={p()?.prev != null}>
        <Txt size="caption" tone="muted" numeric>{`${props.compareLabel ?? "Previous"}: ${props.format(p()?.prev ?? 0)}`}</Txt>
      </If>
    </View>
  );
}

/** Vertical bars of one series (hours of day, retention), the hovered one standing out. */
export function Bars(props: {
  rows: { label: string; value: number }[];
  format: (value: number) => string;
  generation?: string | number;
  height?: number;
  accessibilityLabel: string;
}) {
  return (
    <View style={{ height: props.height ?? 180 }}>
      <Plot
        data={props.rows}
        y="value"
        xScale={{ type: "band", paddingInner: 0.25 }}
        motion={plotMotion}
        appearGeneration={props.generation ?? 0}
        accessibilityLabel={props.accessibilityLabel}
        crossLineClass="w-full bg-hover"
        class="flex-1 text-brand"
        style={{ marginLeft: 36, marginBottom: 20 }}
      >
        <Grid ticks={4} class="stroke-border" />
        <Bar value="value" cornerRadii={{ topLeft: 3, topRight: 3 }} stagger={0.3} inactiveOpacity={0.55} class="fill-brand" />
        <PlotAxis placement="left" ticks={4} format={(v) => props.format(v)} labelClass="pr-2 text-faint" labelStyle={type.micro} />
        <PlotAxis placement="bottom" tickValues={tickIndices(props.rows.length, 8)} format={(v) => props.rows[v]?.label ?? ""} labelClass="pt-1.5 text-faint" labelStyle={type.micro} />
      </Plot>
    </View>
  );
}

/** A tiny trend line for a metric tile: no axes, no focus, no hover. */
export function Sparkline(props: { values: number[]; tone?: "brand" | "muted"; generation?: string | number }): JSX.Element {
  const rows = () => props.values.map((v) => ({ v }));
  return (
    <Plot
      data={rows()}
      y="v"
      interactive={false}
      motion={plotMotion}
      appearGeneration={props.generation ?? 0}
      class={`flex-1 ${props.tone === "muted" ? "text-faint" : "text-brand"}`}
    >
      <Area y1="v" curve="linear" class={props.tone === "muted" ? "fill-hover" : "fill-brand-soft"} />
      <Line y="v" curve="linear" style={{ strokeWidth: 1.5 }} class={props.tone === "muted" ? "stroke-faint" : "stroke-brand"} />
    </Plot>
  );
}

// ------------------------------------------------------------------------------------- legend

export type LegendTone = "brand" | "second" | "compare";
const legendMark: Record<LegendTone, string> = { brand: "bg-brand", second: "bg-chart-2", compare: "bg-compare" };

/** The series of a chart, named: a short bar in each series' color, then its label. */
export function ChartLegend(props: { items: readonly { label: string; tone: LegendTone }[]; testID?: string }) {
  return (
    <View testID={props.testID} class="flex-row flex-wrap items-center gap-3">
      <Each of={props.items}>
        {(item) => (
          <View class="flex-row items-center gap-1.5">
            <View class={`h-0.5 w-3 rounded-(--radius-pill) ${legendMark[item().tone]}`} />
            <Txt size="caption" tone="muted">{item().label}</Txt>
          </View>
        )}
      </Each>
    </View>
  );
}

// ------------------------------------------------------------------------------------- heatmap

export interface HeatCell {
  /** Its column (a category of `columns`). */
  x: string;
  /** Its row (a category of `rows`). */
  y: string;
  /** Its intensity along the ramp; undefined draws the neutral wash (a row's size column). */
  value?: number;
  /** The text in the cell ("42%", "1.2k"). */
  label: string;
  /** What the tooltip and screen readers say of it ("Nov 16 · week 2: 42 of 120"). */
  description: string;
}

/**
 * A grid of cells colored along one ramp, from the `muted` surface to the brand blue (`nsh/base/plot`
 * `Cell` on two band scales): retention cohorts, hour-of-week activity. Column labels on top, row
 * labels at the left, each cell's label inside it (light on the dark end). Pointer and arrow keys move
 * a hover ring and a tooltip across the cells.
 */
export function Heatmap(props: {
  cells: HeatCell[];
  columns: string[];
  rows: string[];
  /** A column's heading ("Week 2"); the category itself without one. */
  columnLabel?: (column: string) => string;
  /** The value at the dark end of the ramp; the largest value without one. */
  max?: number;
  generation?: string | number;
  accessibilityLabel: string;
  /** Room for the row labels at the left. */
  labelWidth?: number;
  testID?: string;
}) {
  const hovered = signal<number | null>(null);
  const top = () => (props.max ?? Math.max(0, ...props.cells.map((c) => c.value ?? 0))) || 1;
  // A row is a 28pt band of cells; the top axis takes 20pt.
  const height = () => props.rows.length * 28 + 20;
  return (
    <View testID={props.testID} style={{ height: height() }}>
      <Plot
        data={props.cells}
        xScale={{ type: "band", domain: props.columns, paddingInner: 0.08 }}
        yScale={{ type: "band", domain: props.rows, paddingInner: 0.1 }}
        // Theme tokens, read in a binding so the ramp follows light and dark.
        colorScale={{ type: "sequential", domain: [0, top()], range: [token("muted"), token("brand")], unknown: token("muted") }}
        motion={plotMotion}
        appearGeneration={props.generation ?? 0}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityValue={{ text: hovered() == null ? null : props.cells[hovered()!]?.description ?? null }}
        onHoverChange={(e) => hovered.set(e.index)}
        tooltipPlacement="pointer"
        tooltipOffset={8}
        tooltipContent={
          <View class="rounded-(--radius) border border-border bg-popover px-2 py-1.5">
            <Txt size="caption" numeric>{hovered() == null ? "" : props.cells[hovered()!]?.description ?? ""}</Txt>
          </View>
        }
        class="flex-1"
        style={{ marginLeft: props.labelWidth ?? 64, marginTop: 20 }}
      >
        <Cell
          x="x"
          y="y"
          value="value"
          label="label"
          cornerRadii={4}
          stagger={0.4}
          inactiveOpacity={0.55}
          // Dark text on a light cell and light text on a dark one, in either theme: the ramp runs
          // light→dark in light mode and dark→light in dark mode, so the text tokens swap with it.
          labelClass="text-foreground data-dark:text-background dark:text-background dark:data-dark:text-foreground"
          labelStyle={type.micro}
          hoverCellClass="rounded-(--radius-sm) outline-2 outline-foreground"
        />
        <PlotAxis placement="top" format={(v) => { const c = props.columns[v] ?? ""; return props.columnLabel ? props.columnLabel(c) : c; }} labelClass="pb-1.5 text-faint" labelStyle={type.micro} />
        <PlotAxis placement="left" format={(v) => props.rows[v] ?? ""} labelClass="pr-2 text-muted-foreground" labelStyle={type.micro} />
      </Plot>
    </View>
  );
}
