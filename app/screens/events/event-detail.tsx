/**
 * One custom event's detail page (pushed over the events table): its totals, its trend over the
 * range, and its properties — each key a collapsible group whose values load when it opens (one
 * request per key actually looked at, not per key the event has).
 *
 * Property values are counts, not filters (docs/api.md: `f=` takes only the dimensions), so their
 * rows do not press; the page says so once under the list rather than leaving a dead tap.
 */
import { computed, resource, signal, View } from "nsh";
import type { EventRow, Scope } from "../../api";
import { ApiError } from "../../api";
import { formatCount, formatPercent } from "../../format";
import { api, currentRange, rangeLabels, scope } from "../../store";
import {
  BarRow, ChartLegend, EmptyState, GroupSection, Heading, InlineCode, PropertyList, ShareBar, Skeleton, TimeSeries, Txt,
  width,
} from "../../ui";
import { bucketLabel } from "../users/labels";

/** The share of visits as a bar and a number, used in the table and on the event's page. */
export function VisitShare(props: { users: number; visitors: number | null }) {
  const share = () => (props.visitors && props.visitors > 0 ? Math.min(1, props.users / props.visitors) : null);
  return (
    <View class="min-w-0 flex-1 flex-row items-center gap-2">
      <View class="min-w-0 flex-1">
        <ShareBar value={share() ?? 0} accessibilityLabel="Share of visits" />
      </View>
      <View class="items-end" style={{ width: width.valueColumn }}>
        <Txt size="ui" tone="muted" numeric>{share() == null ? "–" : formatPercent(share()!)}</Txt>
      </View>
    </View>
  );
}

/**
 * The event's page content. `event` is the table's live row (its counts follow the range); its name
 * is read once, since a page is about one event.
 */
export function EventDetail(props: { event: EventRow; visitors: number | null }) {
  // Read once: a page shows one event.
  const name = props.event.name;
  const series = resource(
    () => scope(),
    async (s: Scope) => {
      try {
        const d = await api.eventSeries(s, name);
        // A Worker without the endpoint answers 404, or the web build's page for unknown paths.
        return d && Array.isArray(d.labels) && Array.isArray(d.count) ? d : null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  );
  const keys = resource(() => scope(), (s: Scope) => api.eventKeys(s, name));
  const opened = signal<Record<string, boolean>>({});
  // The first key starts open, once the keys arrive.
  const isOpen = (key: string) => opened()[key] ?? keys()?.keys[0]?.key === key;
  const points = computed(() => {
    const d = series();
    return d ? d.labels.map((label, i) => ({ label: bucketLabel(label), cur: d.count[i] ?? 0, prev: d.users?.[i] ?? 0 })) : [];
  });

  return (
    <View class="gap-6" testID="event-detail">
      <PropertyList
        testID="event-properties-summary"
        items={[
          { label: "Count", value: formatCount(props.event.count) },
          { label: "Users", value: formatCount(props.event.users) },
          { label: "Share of visits", value: <VisitShare users={props.event.users} visitors={props.visitors} /> },
          { label: "Per user", value: props.event.users > 0 ? (props.event.count / props.event.users).toFixed(1) : "–", mono: true },
        ]}
      />

      <View class="gap-3">
        <View class="flex-row items-center gap-2">
          <View class="flex-1"><Heading size="lead">Trend</Heading></View>
          <If when={points().length > 0}>
            <ChartLegend items={[{ label: "Count", tone: "brand" }, { label: "Users", tone: "second" }]} />
          </If>
        </View>
        <If when={series.error()}>
          <EmptyState icon="error" title="Could not load the trend" body={String((series.error() as Error)?.message ?? "")} action={{ label: "Try again", onPress: () => series.refetch() }} />
        </If>
        <If when={!series.error() && series.state() === "pending" && series() === undefined}>
          <Skeleton height={180} />
        </If>
        <If when={!series.error() && series.state() === "ready" && series() === null}>
          <Txt tone="muted" testID="event-trend-unavailable">This server does not report an event's trend yet. Updating the Worker adds it.</Txt>
        </If>
        <If when={points().length > 0}>
          <TimeSeries
            testID="event-trend"
            accessibilityLabel={`${name} over ${rangeLabels[currentRange()].long}: ${formatCount(props.event.count)} times by ${formatCount(props.event.users)} users`}
            points={points()}
            format={formatCount}
            label="Count"
            compareLabel="Users"
            secondary="series"
            height={180}
            generation={name}
          />
        </If>
      </View>

      <View class="gap-3">
        <Heading size="lead">Properties</Heading>
        <If when={keys.error()}>
          <EmptyState icon="error" title="Could not load properties" body={String((keys.error() as Error)?.message ?? "")} action={{ label: "Try again", onPress: () => keys.refetch() }} />
        </If>
        <If when={!keys.error() && keys() === undefined}>
          <View class="gap-2"><Skeleton height={28} /><Skeleton height={28} /></View>
        </If>
        <If when={!keys.error() && keys()?.keys.length === 0}>
          <Txt tone="muted" testID="event-no-properties">
            No properties on this event. Send up to 10 with it as <InlineCode>props</InlineCode>, e.g. <InlineCode>{`track("${name}", { plan: "pro" })`}</InlineCode>.
          </Txt>
        </If>
        <If when={(keys()?.keys.length ?? 0) > 0}>
          <View class="gap-2" testID="event-keys">
            <Each of={keys()?.keys ?? []} key={(k) => k.key}>
              {(k) => (
                <GroupSection
                  testID={`event-key-${k().key}`}
                  title={k().key}
                  icon="code"
                  count={k().count}
                  open={isOpen(k().key)}
                  onToggle={(o) => opened.update((m) => ({ ...m, [k().key]: o }))}
                >
                  <If when={isOpen(k().key)}>
                    <PropertyValues event={name} propKey={k().key} total={k().count} />
                  </If>
                </GroupSection>
              )}
            </Each>
            <Txt size="caption" tone="faint">Values are counted per event; they are not filters.</Txt>
          </View>
        </If>
      </View>
    </View>
  );
}

/** One key's values (top 10) as proportional rows, with each value's share of the events that carried the key. */
function PropertyValues(props: { event: string; propKey: string; total: number }) {
  const event = props.event;
  const key = props.propKey;
  const values = resource(() => scope(), (s: Scope) => api.eventValues(s, event, key, 10));
  const max = () => Math.max(1, ...(values()?.values ?? []).map((v) => v.value));
  return (
    <View class="pl-2" testID={`event-values-${key}`}>
      <If when={values.error()}>
        <EmptyState icon="error" title="Could not load values" action={{ label: "Try again", onPress: () => values.refetch() }} />
      </If>
      <If when={!values.error() && values() === undefined}>
        <View class="gap-1.5 py-1"><Skeleton width="80%" height={20} /><Skeleton width="50%" height={20} /></View>
      </If>
      <If when={!values.error() && values()?.values.length === 0}>
        <Txt tone="muted">No values in this period.</Txt>
      </If>
      <Each of={values()?.values ?? []} key={(v) => v.name}>
        {(v) => (
          <BarRow
            label={v().name === "" ? "(empty)" : v().name}
            value={formatCount(v().value)}
            share={v().value / max()}
            secondary={props.total > 0 ? formatPercent(v().value / props.total) : undefined}
          />
        )}
      </Each>
    </View>
  );
}
