/**
 * The real app with a BreakdownList as the Overview screen: the tests use it to add and remove
 * filters through the UI, and to see that a range change reloads the shared scope.
 */
import { mount } from "nsh";
import { BreakdownList } from "../components/breakdown-list";
import { Root } from "../shell/root";

function PagesBreakdown() {
  return <BreakdownList testID="breakdown" title="Pages" dims={["path", "entry"]} />;
}

mount(Root, { screens: { overview: PagesBreakdown } });
