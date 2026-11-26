/**
 * Sources: where visits come from. Referrers (an empty one is a direct visit or an app launch) and
 * the UTM tags of campaign links, each a tab of one dimension. A row adds a filter; with a referrer
 * or UTM filter on, "<Dimension> details" pushes its detail page (landing pages, countries, ...).
 */
import type { Dim } from "../api";
import { dimLabels, filterFor, openDetail } from "../store";
import { Button } from "../ui";
import { ScreenFrame } from "./frame";
import { breakdownResource, summaryResource } from "./insights/data";
import { DimensionView } from "./insights/dimension";
import { displayName } from "./insights/names";
import { valueDetail } from "./insights/value-detail";

const SOURCE_DIMS: readonly Dim[] = ["referrer", "utm_source", "utm_medium", "utm_campaign"];

export function SourcesScreen() {
  const load = breakdownResource(SOURCE_DIMS, 50);
  const summary = summaryResource();
  // The filtered source the details are about: the first of the source dimensions that is filtered.
  const focus = (): Dim | null => SOURCE_DIMS.find((d) => filterFor(d) !== null) ?? null;
  return (
    <ScreenFrame
      testID="screen-sources"
      title="Sources"
      description="Referrers and campaign tags of the visits in this range."
      actions={
        <If when={focus()}>
          {(d) => <Button variant="outline" size="sm" icon="info" label={`${dimLabels[d()]} details`} onPress={() => openDetail(valueDetail(d(), filterFor(d())!, "source-page"))} testID="source-details" />}
        </If>
      }
    >
      <DimensionView
        testID="sources"
        accessibilityLabel="Sources by"
        load={load}
        sections={[
          { dim: "referrer", label: "Referrers", icon: "link", column: "Referrer" },
          { dim: "utm_source", label: "Source", icon: "sources", column: "UTM source" },
          { dim: "utm_medium", label: "Medium", icon: "medium", column: "UTM medium" },
          { dim: "utm_campaign", label: "Campaign", icon: "campaign", column: "UTM campaign" },
        ]}
        formatName={displayName}
        total={() => summary()?.totals.visitors}
      />
    </ScreenFrame>
  );
}
