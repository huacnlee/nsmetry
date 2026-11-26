/**
 * Events: the custom events (everything but page and screen views) over the shared scope — how
 * often each fired, by how many users, and in what share of visits — and, for the one pressed, a
 * detail page (pushed over the table) with its trend and its properties.
 *
 * "Users" is what `/api/events` reports: visitors per day summed over the range, the same unit as
 * the summary's visitors, so users / visitors is the share of visits that fired the event.
 * The filters narrow both, so the share stays a share of the same visits.
 */
import { computed, resource } from "nsh";
import type { EventRow } from "../api";
import { formatCount } from "../format";
import { api, currentFilters, currentRange, currentSite, openDetail, rangeLabels, scope } from "../store";
import { Badge, Card, CodeBlock, DataTable, EmptyState, Panel, Skeleton, type Column } from "../ui";
import { EventDetail, VisitShare } from "./events/event-detail";
import { ScreenFrame } from "./frame";

export function EventsScreen() {
  const events = resource(() => scope(), (s) => api.events(s));
  // Only the visitors total is needed; the summary is the one endpoint that has it.
  const summary = resource(() => scope(), (s) => api.summary(s));
  const visitors = () => summary()?.totals.visitors ?? null;
  const rows = computed(() => [...(events()?.events ?? [])].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)));

  // The event's page reads the table's live row, so its counts follow a range or filter change; the
  // row pressed stands in if the event drops out of the new scope.
  const select = (row: EventRow) => {
    const name = row.name;
    const live = () => rows().find((r) => r.name === name) ?? row;
    openDetail({
      testID: "event-page",
      title: () => name,
      meta: () => `${currentSite()?.domain ?? ""} · event · ${rangeLabels[currentRange()].long}`,
      content: () => <EventDetail event={live()} visitors={visitors()} />,
    });
  };

  const columns: Column<EventRow>[] = [
    { key: "name", title: "Event", cell: (r) => r.name },
    { key: "count", title: "Count", cell: (r) => formatCount(r.count), width: 72, align: "end" },
    { key: "users", title: "Users", cell: (r) => formatCount(r.users), width: 72, align: "end", hideBelow: 360 },
    { key: "share", title: "Share of visits", cell: (r) => <VisitShare users={r.users} visitors={visitors()} />, width: 200, hideBelow: 520 },
  ];

  return (
    <ScreenFrame
      testID="screen-events"
      title="Events"
      description="Custom events and their properties."
      actions={<If when={rows().length > 0}><Badge testID="events-count" label={`${rows().length} ${rows().length === 1 ? "event" : "events"}`} /></If>}
    >
      <If when={events.error()}>
        <EmptyState icon="error" title="Could not load events" body={String((events.error() as Error)?.message ?? "")} action={{ label: "Try again", onPress: () => events.refetch() }} />
      </If>

      <If when={!events.error() && events() === undefined}>
        <Card class="gap-3">
          <Each of={[0.8, 0.6, 0.45, 0.3]}>{(w) => <Skeleton width={`${Math.round(w() * 100)}%` as `${number}%`} height={20} />}</Each>
        </Card>
      </If>

      <If when={!events.error() && events() !== undefined && rows().length === 0}>
        <Card class="gap-3" testID="events-empty">
          <EmptyState
            title={currentFilters().length > 0 ? "No custom events match these filters" : "No custom events in this period"}
            body="Page and screen views are counted on their own screens. Anything else an app or page sends is an event:"
          />
          <CodeBlock label="snippet" code={`nsmetry.track("export", { format: "csv" });\n\n// or over HTTP:\n// POST /api/event {"site":"${currentSite()?.domain ?? "my-app"}","name":"export","props":{"format":"csv"}}`} />
        </Card>
      </If>

      <If when={rows().length > 0}>
        <Panel title="Custom events" note="Press an event for its trend and properties.">
          <DataTable
            testID="events-table"
            columns={columns}
            rows={rows()}
            rowKey={(r) => r.name}
            onRowPress={select}
            rowLabel={(r) => `${r.name}, ${formatCount(r.count)} times by ${formatCount(r.users)} users. Open details`}
          />
        </Panel>
      </If>

    </ScreenFrame>
  );
}

