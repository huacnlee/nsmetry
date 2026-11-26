/**
 * Cohort retention: installs grouped by the day or week they were first seen, and how many of each
 * group came back 1…7 periods later, as a heatmap (`Heatmap`, `nsh/base/plot` `Cell`). The first
 * column is the cohort's size on the neutral wash; the others are shares of it on the brand ramp,
 * whose dark end is the best share in the grid so a typical 5–40% retention still reads.
 *
 * `/api/retention` takes neither the range nor the filters: cohorts are always the latest eight.
 */
import { computed, resource, signal, View } from "nsh";
import type { Retention } from "../../api";
import { formatCount, formatPercent } from "../../format";
import { api, currentSiteId } from "../../store";
import { EmptyState, type HeatCell, Heatmap, Panel, Segmented, Skeleton, Txt } from "../../ui";
import { bucketLabel } from "./labels";

type Cohort = "day" | "week";
const PERIODS = 8;

/** The grid of one retention answer: rows, columns and cells. Exported for tests of the arithmetic. */
export function retentionGrid(data: Retention, cohort: Cohort) {
  const unit = cohort === "day" ? "day" : "week";
  const columns = Array.from({ length: PERIODS }, (_, i) => String(i));
  const rows: string[] = [];
  const cells: HeatCell[] = [];
  let best = 0;
  let backSum = 0;
  let backBase = 0;
  for (const c of data.cohorts) {
    const row = bucketLabel(c.label);
    rows.push(row);
    cells.push({ x: "0", y: row, label: formatCount(c.size), description: `${row}: ${formatCount(c.size)} new users` });
    for (let i = 1; i < Math.min(PERIODS, c.retained.length); i++) {
      const n = c.retained[i] ?? 0;
      const share = c.size > 0 ? n / c.size : 0;
      best = Math.max(best, share);
      cells.push({
        x: String(i),
        y: row,
        value: share,
        label: formatPercent(share),
        description: `${row}, ${unit} ${i}: ${formatCount(n)} of ${formatCount(c.size)} (${formatPercent(share)})`,
      });
    }
    // Period 1 is the headline ("came back the next day / week"), weighted by cohort size.
    if (c.retained.length > 1 && c.size > 0) {
      backSum += c.retained[1] ?? 0;
      backBase += c.size;
    }
  }
  return { columns, rows, cells, best, periodOne: backBase > 0 ? backSum / backBase : null };
}

export function RetentionPanel() {
  const cohort = signal<Cohort>("week");
  // Keyed on site and cohort only, so a range or filter change does not reload what they do not change.
  const source = computed(() => {
    const site = currentSiteId();
    return site == null ? null : `${site}|${cohort()}`;
  });
  const data = resource(source, (key) => {
    const [site, c] = key.split("|");
    return api.retention(Number(site), c as Cohort, PERIODS);
  });
  const grid = computed(() => {
    const d = data();
    return d ? retentionGrid(d, cohort()) : null;
  });
  const unit = () => (cohort() === "day" ? "day" : "week");

  return (
    <Panel
      testID="retention"
      title="Retention"
      note={`Share of each ${unit()}'s new users active again N ${unit()}s later`}
      actions={
        <Segmented
          testID="retention-cohort"
          accessibilityLabel="Cohorts by"
          options={[
            { value: "day", label: "Daily", description: "Daily cohorts" },
            { value: "week", label: "Weekly", description: "Weekly cohorts" },
          ]}
          value={cohort()}
          onChange={(c) => cohort.set(c)}
        />
      }
    >
      <If when={data.error()}>
        <EmptyState icon="error" title="Could not load retention" body={String((data.error() as Error)?.message ?? "")} action={{ label: "Try again", onPress: () => data.refetch() }} />
      </If>
      <If when={!data.error() && grid() === null}>
        <View class="gap-2 py-1">
          <Each of={[0, 1, 2, 3, 4]}>{() => <Skeleton height={22} />}</Each>
        </View>
      </If>
      <If when={!data.error() && grid() !== null && grid()!.rows.length === 0}>
        <EmptyState title="No cohorts yet" body={`Cohorts appear once a ${unit()} has new users.`} />
      </If>
      <If when={!data.error() && (grid()?.rows.length ?? 0) > 0}>
        <View class="gap-3">
          <If when={grid()!.periodOne != null}>
            <Txt tone="muted" testID="retention-period-one">
              {`${formatPercent(grid()!.periodOne ?? 0)} of new users came back the next ${unit()}`}
            </Txt>
          </If>
          <Heatmap
            testID="retention-grid"
            accessibilityLabel={`Retention of the last ${grid()!.rows.length} ${cohort() === "day" ? "daily" : "weekly"} cohorts`}
            cells={grid()!.cells}
            columns={grid()!.columns}
            rows={grid()!.rows}
            columnLabel={(c) => (c === "0" ? "New" : `${cohort() === "day" ? "D" : "W"}${c}`)}
            max={grid()!.best || 1}
            generation={source() ?? 0}
            labelWidth={56}
          />
        </View>
      </If>
    </Panel>
  );
}
