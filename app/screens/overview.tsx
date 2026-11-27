/**
 * Overview: the site at a glance.
 *
 *  - A card of five metric tiles (visitors, views, views per visit, bounce rate, visit duration),
 *    each with its value, its change against the previous period and a sparkline. The selected tile
 *    drives the hero chart under it; with compare on, the previous period runs beside it as a
 *    dashed line.
 *  - The live panel (online now, the last 30 minutes, the latest views), polled only while the app
 *    is visible (./realtime.tsx).
 *  - Top lists: pages (top / entry / exit), sources (referrer / UTM), events, countries, tech. Every
 *    row adds a filter that the whole app follows.
 *
 * Requests per load: one summary (always with the previous period, see insights/data.ts), one
 * breakdown carrying every list, one realtime every 30 s while visible. A change of compare loads
 * nothing: it only shows or hides the dashed series.
 */
import { signal, View, windowSize } from "nsh";
import type { Dim, Metric } from "../api";
import { METRICS } from "../api";
import { BreakdownList } from "../components/breakdown-list";
import { change } from "../format";
import { comparing, currentFilters, currentRange, currentSite, go, rangeLabels } from "../store";
import { Button, Card, ChartLegend, Divider, EmptyState, Heading, MetricTile, Skeleton, Sparkline, TimeSeries } from "../ui";
import { WIDE } from "../ui/tokens";
import { ScreenFrame } from "./frame";
import { breakdownResource, errorText, summaryResource } from "./insights/data";
import { Cell, Grid } from "./insights/grid";
import { bucketLabel, metricMeta } from "./insights/metrics";
import { displayName, leadingFor } from "./insights/names";
import { createLivePoll, LivePanel, LiveStatus } from "./realtime";

/** Every dimension the Overview's lists show, in one request. */
const OVERVIEW_DIMS: readonly Dim[] = [
  "path", "entry", "exit", "referrer", "utm_source", "utm_medium", "utm_campaign", "event", "country", "browser", "os", "device",
];

export function OverviewScreen() {
  const metric = signal<Metric>("visitors");
  const summary = summaryResource();
  const lists = breakdownResource(OVERVIEW_DIMS, 8);
  const live = createLivePoll();
  const noData = () => {
    const t = summary()?.totals;
    return !!t && t.visitors === 0 && t.views === 0 && currentFilters().length === 0;
  };

  return (
    <ScreenFrame
      testID="screen-overview"
      title={currentSite()?.domain ?? "Overview"}
      description={`Visitors, views and engagement · ${rangeLabels[currentRange()].long}`}
      actions={
        <View class="flex-row items-center gap-2">
          <LiveStatus live={live} testID="overview-status" />
          {/* On phones the header has no room for it; the no-data card and Settings carry the install there. */}
          <If when={windowSize().width >= WIDE}>
            <Button label="Install tracking" icon="code" variant="outline" size="sm" onPress={() => go("settings")} testID="overview-install" />
          </If>
        </View>
      }
    >
      {/* Nothing recorded and no filter narrowing it: most likely tracking is not installed yet. */}
      <If when={noData()}>
        <Card testID="overview-no-data">
          <EmptyState
            icon="code"
            title={`No data for ${currentSite()?.domain ?? "this site"} ${rangeLabels[currentRange()].long.toLowerCase()}`}
            body="Install tracking on your website or app: Settings has a prompt to paste into your coding agent."
            action={{ label: "Install tracking", onPress: () => go("settings") }}
          />
        </Card>
      </If>
      <MetricsCard metric={metric()} onMetric={(m) => metric.set(m)} summary={summary} />
      <Grid min={380} testID="overview-grid">
        <Cell>
          <LivePanel live={live} testID="live" />
        </Cell>
        <Cell>
          <BreakdownList
            testID="overview-pages"
            title="Pages and screens"
            dims={["path", "entry", "exit"]}
            labels={{ path: "Top", entry: "Entry", exit: "Exit" }}
            source={lists}
            formatName={displayName}
          />
        </Cell>
        <Cell>
          <BreakdownList
            testID="overview-sources"
            title="Sources"
            dims={["referrer", "utm_source", "utm_medium", "utm_campaign"]}
            labels={{ referrer: "Referrers", utm_source: "Source", utm_medium: "Medium", utm_campaign: "Campaign" }}
            source={lists}
            formatName={displayName}
          />
        </Cell>
        <Cell>
          <BreakdownList testID="overview-events" title="Events" dims={["event"]} source={lists} formatName={displayName} />
        </Cell>
        <Cell>
          <BreakdownList testID="overview-countries" title="Countries" dims={["country"]} source={lists} formatName={displayName} leading={leadingFor} />
        </Cell>
        <Cell>
          <BreakdownList
            testID="overview-tech"
            title="Tech"
            dims={["browser", "os", "device"]}
            labels={{ browser: "Browser", os: "OS", device: "Device" }}
            source={lists}
            formatName={displayName}
          />
        </Cell>
      </Grid>
    </ScreenFrame>
  );
}

/** The five tiles and the hero chart of the selected one. */
function MetricsCard(props: { metric: Metric; onMetric: (m: Metric) => void; summary: ReturnType<typeof summaryResource> }) {
  const width = signal(0);
  // Five across when they fit (about 140pt each), otherwise two by two with the last one wide.
  const tileWidth = (i: number) => {
    const w = width();
    if (w <= 0) return "100%" as const;
    if (w >= 700) return w / 5;
    return i === METRICS.length - 1 ? w : w / 2;
  };
  const s = () => props.summary();
  const meta = () => metricMeta[props.metric];
  const points = () => {
    const d = s();
    if (!d) return [];
    return d.series.labels.map((l, i) => ({
      label: bucketLabel(l, d.range.granularity),
      cur: d.series.cur[props.metric][i] ?? 0,
      prev: comparing() ? (d.series.prev?.[props.metric][i] ?? null) : null,
    }));
  };
  // The chart draws in again when what it shows changes, not on every poll or tick.
  const generation = () => `${props.metric}:${currentRange()}:${comparing()}:${JSON.stringify(currentFilters())}:${currentSite()?.id ?? ""}`;

  return (
    <Card inset testID="overview-metrics">
      <If when={props.summary.error()}>
        <View class="p-4">
          <EmptyState icon="error" title="Could not load the summary" body={errorText(props.summary.error())} action={{ label: "Try again", onPress: () => void props.summary.refetch() }} />
        </View>
      </If>
      <If when={!props.summary.error()}>
        <View class="flex-row flex-wrap p-1" onLayout={(e) => width.set(Math.floor(e.bounds.size.width) - 8)} accessibilityLabel="Metrics">
          <Each of={METRICS}>
            {(m, i) => (
              <View style={{ width: tileWidth(i()) }}>
                <If when={s()} else={<View class="gap-2 p-3"><Skeleton width={64} height={12} /><Skeleton width={88} height={24} /><Skeleton height={28} /></View>}>
                  <MetricTile
                    testID={`metric-${m()}`}
                    label={metricMeta[m()].label}
                    value={metricMeta[m()].format(s()?.totals[m()] ?? 0)}
                    delta={change(s()?.totals[m()] ?? 0, s()?.previous?.[m()])}
                    better={metricMeta[m()].better}
                    selected={props.metric === m()}
                    onPress={() => props.onMetric(m())}
                    chart={<Sparkline values={s()?.series.cur[m()] ?? []} tone={props.metric === m() ? "brand" : "muted"} generation={generation()} />}
                  />
                </If>
              </View>
            )}
          </Each>
        </View>
        <Divider />
        <View class="gap-2 px-4 pt-3 pb-3">
          <View class="flex-row items-center gap-3">
            <View class="min-w-0 flex-1">
              <Heading size="lead">{meta().label}</Heading>
            </View>
            <If when={comparing() && s()}>
              <ChartLegend
                items={[
                  { label: rangeLabels[currentRange()].long, tone: "brand" },
                  { label: capitalize(s()?.range.prevLabel ?? "Previous period"), tone: "compare" },
                ]}
              />
            </If>
          </View>
          <If when={s()} else={<Skeleton height={220} />}>
            <TimeSeries
              testID="overview-chart"
              points={points()}
              format={meta().format}
              generation={generation()}
              compareLabel={capitalize(s()?.range.prevLabel ?? "Previous")}
              accessibilityLabel={`${meta().label}, ${rangeLabels[currentRange()].long}: ${meta().format(s()?.totals[props.metric] ?? 0)}`}
            />
          </If>
        </View>
      </If>
    </Card>
  );
}

const capitalize = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);
