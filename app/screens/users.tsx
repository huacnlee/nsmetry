/**
 * Users: how many installs used the app over the range (daily active, new, weekly, monthly), how
 * sticky it is (average DAU / MAU), and how many come back (retention cohorts). It needs the site to
 * send a `user_id`; until it does (`tracked: false`) the screen explains how, with a snippet.
 *
 * `/api/active-users` takes the site and the range only: filters do not narrow it (the per-day
 * user lists and sketches it reads have no dimensions), so a filter does not reload it, and a note
 * says so while filters are on.
 */
import { computed, resource, View } from "nsh";
import type { RangeId } from "../api";
import { formatCount, formatPercent } from "../format";
import { api, currentFilters, currentRange, currentSiteId, rangeLabels } from "../store";
import { ChartLegend, EmptyState, MetricTile, Panel, Skeleton, Sparkline, StatusPill, TimeSeries, Txt } from "../ui";
import { ScreenFrame } from "./frame";
import { bucketLabel, mean } from "./users/labels";
import { RetentionPanel } from "./users/retention";
import { UserIdSetup } from "./users/setup";

export function UsersScreen() {
  // Site and range only (see above), as one string so an unrelated scope change is not a new source.
  const source = computed(() => {
    const site = currentSiteId();
    return site == null ? null : `${site}|${currentRange()}`;
  });
  const active = resource(source, (key) => {
    const [site, range] = key.split("|");
    return api.activeUsers({ site: Number(site), range: range as RangeId });
  });

  const tracked = () => active()?.tracked;
  const avgDau = () => mean(active()?.dau ?? []);
  const stickiness = () => {
    const mau = active()?.mau ?? 0;
    return mau > 0 ? Math.min(1, avgDau() / mau) : null;
  };
  const points = () => {
    const a = active();
    return a ? a.labels.map((label, i) => ({ label: bucketLabel(label), cur: a.dau[i] ?? 0, prev: a.new[i] ?? 0 })) : [];
  };

  return (
    <ScreenFrame
      testID="screen-users"
      title="Users"
      description="Active installs and how many come back."
      actions={
        <If when={active() !== undefined}>
          <StatusPill
            testID="users-status"
            tone={tracked() ? "ok" : "neutral"}
            label={tracked() ? "Counting user ids" : "No user ids yet"}
          />
        </If>
      }
    >
      <If when={active.error()}>
        <EmptyState icon="error" title="Could not load users" body={String((active.error() as Error)?.message ?? "")} action={{ label: "Try again", onPress: () => active.refetch() }} />
      </If>

      <If when={!active.error() && active() === undefined}>
        <View class="flex-row flex-wrap gap-2">
          <Each of={[0, 1, 2, 3]}>{() => <View class="gap-2 p-3" style={{ flexGrow: 1, flexBasis: 150 }}><Skeleton width="50%" /><Skeleton width="70%" height={24} /></View>}</Each>
        </View>
        <Skeleton height={220} />
      </If>

      <If when={!active.error() && tracked() === false}>
        <UserIdSetup testID="users-setup" />
      </If>

      <If when={!active.error() && tracked() === true}>
        <If when={currentFilters().length > 0}>
          <Txt size="caption" tone="muted" testID="users-filter-note">Filters do not apply to users: these count every install of the site.</Txt>
        </If>

        <View class="flex-row flex-wrap gap-2" testID="users-tiles">
          <View style={{ flexGrow: 1, flexBasis: 150 }}>
            <MetricTile testID="users-active" label={`Active users · ${rangeLabels[currentRange()].long}`} value={formatCount(active()?.totals.active ?? 0)} chart={<Sparkline values={active()?.dau ?? []} generation={source() ?? 0} />} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: 150 }}>
            <MetricTile testID="users-new" label="New users" value={formatCount(active()?.totals.new ?? 0)} chart={<Sparkline values={active()?.new ?? []} tone="muted" generation={source() ?? 0} />} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: 120 }}>
            <MetricTile testID="users-dau" label="Avg. daily" value={formatCount(Math.round(avgDau()))} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: 120 }}>
            <MetricTile testID="users-wau" label="Weekly" value={formatCount(active()?.wau ?? 0)} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: 120 }}>
            <MetricTile testID="users-mau" label="Monthly" value={formatCount(active()?.mau ?? 0)} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: 120 }}>
            <MetricTile testID="users-stickiness" label="Stickiness" value={stickiness() == null ? "–" : formatPercent(stickiness()!)} />
          </View>
        </View>

        <Panel
          testID="users-chart"
          title="Daily active users"
          note="Weekly and monthly counts are estimates (±2%); daily and new are exact."
          actions={<ChartLegend items={[{ label: "Active", tone: "brand" }, { label: "New", tone: "second" }]} />}
        >
          <TimeSeries
            accessibilityLabel={`Daily active users, ${rangeLabels[currentRange()].long}: about ${formatCount(Math.round(avgDau()))} a day, ${formatCount(active()?.totals.new ?? 0)} new`}
            points={points()}
            format={formatCount}
            label="Active"
            compareLabel="New"
            secondary="series"
            generation={source() ?? 0}
          />
        </Panel>

        <RetentionPanel />
      </If>
    </ScreenFrame>
  );
}
