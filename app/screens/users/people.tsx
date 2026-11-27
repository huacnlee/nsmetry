/**
 * People: who uses the app, by the user id it sends (an email, an account id), with when each was
 * first and last seen. Only sites whose administrator turned on "Keep user ids" in Settings have
 * this; every other site keeps only a pseudonym, and the panel says how to turn it on.
 *
 * The window follows the screen's range (today = 1 day … 12 months = 365 days). Filters do not
 * narrow it, like the rest of the screen.
 */
import { computed, resource, View } from "nsh";
import type { Person, RangeId } from "../../api";
import { formatCount } from "../../format";
import { api, currentRange, currentSiteId, go, isOwner, rangeLabels } from "../../store";
import { DataTable, EmptyState, Panel, Skeleton, Txt, type Column } from "../../ui";
import { ago, day } from "../settings/time";

const DAYS: Record<RangeId, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90, "12mo": 365 };

const columns: readonly Column<Person>[] = [
  {
    key: "user",
    title: "User ID",
    cell: (p) => <View class="min-w-0 shrink"><Txt size="table" truncate>{p.user_id}</Txt></View>,
  },
  { key: "first", title: "First seen", width: 120, mono: true, hideBelow: 520, cell: (p) => day(p.first_seen) },
  { key: "last", title: "Last seen", width: 110, align: "end", mono: true, cell: (p) => ago(p.last_seen) },
];

export function PeoplePanel() {
  const source = computed(() => {
    const site = currentSiteId();
    return site == null ? null : `${site}|${DAYS[currentRange()]}`;
  });
  const data = resource(source, (key) => {
    const [site, days] = key.split("|");
    return api.people(Number(site), Number(days));
  });
  const note = () => {
    const d = data();
    if (!d?.enabled) return "Who uses the app, by the user id it sends";
    const n = `${formatCount(d.total)} ${d.total === 1 ? "person" : "people"}`;
    return d.people.length < d.total
      ? `${n} active · ${rangeLabels[currentRange()].long} · newest ${formatCount(d.people.length)} shown`
      : `${n} active · ${rangeLabels[currentRange()].long}`;
  };

  return (
    <Panel testID="people" title="People" note={note()}>
      <If when={data.error()}>
        <EmptyState icon="error" title="Could not load people" body={String((data.error() as Error)?.message ?? "")} action={{ label: "Try again", onPress: () => data.refetch() }} />
      </If>
      <If when={!data.error() && data() === undefined}>
        <View class="gap-2 py-1">
          <Each of={[0, 1, 2]}>{() => <Skeleton height={20} />}</Each>
        </View>
      </If>
      <If when={!data.error() && data()?.enabled === false}>
        <EmptyState
          testID="people-off"
          icon="team"
          title="User ids are not kept"
          body={
            isOwner()
              ? "Turn on Keep user ids in this site's Settings to list the people who use it here."
              : "The administrator can turn on Keep user ids in this site's Settings to list the people who use it."
          }
          action={isOwner() ? { label: "Open Settings", onPress: () => go("settings") } : undefined}
        />
      </If>
      <If when={!data.error() && data()?.enabled === true && data()!.people.length === 0}>
        <EmptyState testID="people-empty" title="No one yet" body="No user id has arrived in this range since keeping them was turned on." />
      </If>
      <If when={!data.error() && (data()?.people.length ?? 0) > 0}>
        <DataTable testID="people-table" columns={columns} rows={data()!.people} rowKey={(p) => p.user_id} />
      </If>
    </Panel>
  );
}
