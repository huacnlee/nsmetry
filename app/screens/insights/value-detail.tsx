/**
 * The detail page of one value of a dimension: a page or screen, a referrer or campaign tag, a
 * country, a browser or app version. Pushed over the list: the site and dimension in the mono meta
 * line, the value as the title, its headline numbers as a property list, its trend, and the
 * questions one asks about it next (where its visitors came from, what they used).
 *
 * It loads with that value forced into the filters, so it is right whether or not the value is the
 * current filter. Two requests (summary + one breakdown of the related dimensions), made only while
 * the page is in the stack: it is built when pushed and its loads go when it pops.
 */
import { openUrl, View } from "nsh";
import type { Dim, Filter } from "../../api";
import { formatCount } from "../../format";
import { closeDetail, comparing, currentRange, currentSite, type DetailPage, dimLabels, filterFor, rangeLabels, removeFilter } from "../../store";
import {
  BarRow, Button, EmptyState, Heading, IconButton, PropertyList, Skeleton, Tag, TimeSeries, Txt,
} from "../../ui";
import { breakdownResource, errorText, summaryResource } from "./data";
import { bucketLabel, metricMeta } from "./metrics";
import { displayName } from "./names";

/** What else to break a value down by, per dimension: the questions one asks about it next. */
const related: Partial<Record<Dim, Dim[]>> = {
  path: ["referrer", "country", "device"],
  entry: ["referrer", "country", "device"],
  exit: ["referrer", "country", "device"],
  referrer: ["entry", "country", "device"],
  utm_source: ["entry", "utm_campaign", "country"],
  utm_medium: ["entry", "utm_source", "country"],
  utm_campaign: ["entry", "utm_source", "country"],
  country: ["path", "referrer", "browser"],
  browser: ["os", "device", "country"],
  os: ["browser", "device", "country"],
  device: ["browser", "os", "country"],
  screen: ["device", "browser", "os"],
  app_version: ["os", "device", "country"],
};
const sectionTitle: Partial<Record<Dim, string>> = {
  referrer: "Where visitors came from",
  country: "Countries",
  device: "Devices",
  entry: "Landing pages",
  path: "Pages",
  browser: "Browsers",
  os: "Operating systems",
  screen: "Screen sizes",
  utm_campaign: "Campaigns",
  utm_source: "Sources",
};

/** A link outside the app for a value, when it names a place on the web. */
function externalUrl(dim: Dim, value: string, siteName: string | undefined): string | null {
  if ((dim === "path" || dim === "entry" || dim === "exit") && siteName?.includes(".") && value.startsWith("/")) {
    return `https://${siteName}${value}`;
  }
  if (dim === "referrer" && /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(value)) return `https://${value.replace(/^https?:\/\//, "")}`;
  return null;
}

/** The page of `value` of `dim`, for `openDetail`. */
export function valueDetail(dim: Dim, value: string, testID: string): DetailPage {
  return {
    testID,
    title: () => displayName(dim, value),
    meta: () => `${currentSite()?.domain ?? ""} · ${dimLabels[dim]}${dim === "country" ? ` · ${value}` : ""}`,
    actions: () => (
      <If when={externalUrl(dim, value, currentSite()?.domain)}>
        {(url) => <IconButton icon="external" label="Open in the browser" onPress={() => void openUrl(url()).catch(() => undefined)} />}
      </If>
    ),
    content: () => <ValueDetail dim={dim} value={value} testID={testID} />,
  };
}

/** The page's content: numbers, trend, related breakdowns, and the way to drop its filter. */
export function ValueDetail(props: { dim: Dim; value: string; testID: string }) {
  // Read once: a page is about one value.
  const dim = props.dim;
  const value = props.value;
  const testID = props.testID;
  const forced: Filter = { dim, value };
  const summary = summaryResource(() => forced);
  const dims = related[dim] ?? ["referrer", "country", "device"];
  const parts = breakdownResource(dims, 5, () => forced);
  const title = displayName(dim, value);

  const properties = () => {
    const s = summary();
    if (!s) return [];
    const row = (m: "visitors" | "views" | "vpv" | "bounce" | "time") => ({ label: metricMeta[m].label, value: metricMeta[m].format(s.totals[m]) });
    return [
      row("visitors"),
      row("views"),
      row("vpv"),
      row("bounce"),
      row("time"),
      { label: "Range", value: <Tag label={rangeLabels[currentRange()].long} /> },
    ];
  };
  const points = () => {
    const s = summary();
    if (!s) return [];
    return s.series.labels.map((l, i) => ({
      label: bucketLabel(l, s.range.granularity),
      cur: s.series.cur.visitors[i] ?? 0,
      prev: comparing() ? (s.series.prev?.visitors[i] ?? null) : null,
    }));
  };

  return (
    <View class="gap-5" testID={testID ? `${testID}-body` : undefined}>
      <If when={summary.error()}>
        <EmptyState icon="error" title="Could not load the details" body={errorText(summary.error())} action={{ label: "Try again", onPress: () => void summary.refetch() }} />
      </If>
      <If when={!summary.error() && !summary()}>
        <View class="gap-2">
          <Each of={[0, 1, 2, 3, 4]}>{() => <Skeleton height={20} />}</Each>
        </View>
      </If>
      <If when={summary()}>
        <PropertyList items={properties()} testID={`${testID}-props`} />
        <View class="gap-2">
          <Heading size="lead">Visitors over time</Heading>
          <TimeSeries
            points={points()}
            format={formatCount}
            height={160}
            generation={`${value}:${currentRange()}:${comparing()}`}
            compareLabel={summary()?.range.prevLabel}
            accessibilityLabel={`Visitors over time for ${title}`}
          />
        </View>
      </If>
      <Each of={dims}>
        {(d) => (
          <View class="gap-1">
            <Heading size="lead">{sectionTitle[d()] ?? dimLabels[d()]}</Heading>
            <If when={parts.error()} else={
              <If when={parts()} else={<Skeleton height={60} />}>
                <If when={(parts()?.breakdowns[d()] ?? []).length > 0} else={<Txt tone="faint">Nothing recorded.</Txt>}>
                  <Each of={parts()?.breakdowns[d()] ?? []} key={(r) => r.name}>
                    {(r) => (
                      <BarRow
                        label={displayName(d(), r().name)}
                        value={formatCount(r().value)}
                        share={r().value / Math.max(1, ...(parts()?.breakdowns[d()] ?? []).map((x) => x.value))}
                      />
                    )}
                  </Each>
                </If>
              </If>
            }>
              <Txt tone="bad">{errorText(parts.error())}</Txt>
            </If>
          </View>
        )}
      </Each>
      {/* Only while this value is the filter: then dropping it is the page's way out. */}
      <If when={filterFor(dim) === value}>
        <View class="flex-row">
          <Button
            variant="outline"
            icon="close"
            label={`Remove the ${dimLabels[dim].toLowerCase()} filter`}
            onPress={() => {
              removeFilter(dim);
              closeDetail();
            }}
            testID={`${testID}-clear`}
          />
        </View>
      </If>
    </View>
  );
}
