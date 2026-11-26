/**
 * Pages and screens: a web page's path and an app's screen name are the same dimension (`path`),
 * with where visits started (entry) and ended (exit).
 *
 * A row adds its value as a filter. A single page filter is a question about one route, so pressing
 * a page row also pushes the route's detail page (its numbers, its trend, where its visitors came
 * from) over the list. Going back keeps the filter (the chip above still shows it); "Route details"
 * in the header pushes it again, and "Remove the page filter" on the page drops the filter and pops.
 */
import { filterFor, openDetail } from "../store";
import { Button } from "../ui";
import { ScreenFrame } from "./frame";
import { breakdownResource, summaryResource } from "./insights/data";
import { DimensionView } from "./insights/dimension";
import { displayName } from "./insights/names";
import { valueDetail } from "./insights/value-detail";

export function PagesScreen() {
  const load = breakdownResource(["path", "entry", "exit"], 50);
  // Visitors of the whole selection, so each row can say which share of them it holds.
  const summary = summaryResource();
  const route = () => filterFor("path");
  const openRoute = (path: string) => openDetail(valueDetail("path", path, "route-page"));

  return (
    <ScreenFrame
      testID="screen-pages"
      title="Pages"
      description="Web pages and app screens, with where visits started and ended."
      actions={
        <If when={route()}>
          {(r) => <Button variant="outline" size="sm" icon="route" label="Route details" onPress={() => openRoute(r())} testID="route-details" />}
        </If>
      }
    >
      <DimensionView
        testID="pages"
        accessibilityLabel="Pages by"
        load={load}
        sections={[
          { dim: "path", label: "Pages", icon: "pages", column: "Page or screen" },
          { dim: "entry", label: "Entry", icon: "entry", column: "Entry page" },
          { dim: "exit", label: "Exit", icon: "exit", column: "Exit page" },
        ]}
        formatName={displayName}
        total={() => summary()?.totals.visitors}
        onFiltered={(dim, name) => dim === "path" && openRoute(name)}
      />
    </ScreenFrame>
  );
}
