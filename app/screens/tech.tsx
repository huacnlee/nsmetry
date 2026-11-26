/**
 * Tech: what visitors use. Browsers (native apps report "App"), operating systems, device classes,
 * screen-size buckets and, for apps, the app version that sent the events. One request carries all
 * five lists; a row adds a filter, and with one of them filtered "<Dimension> details" pushes that
 * value's detail page.
 */
import type { Dim } from "../api";
import { dimLabels, filterFor, openDetail } from "../store";
import { Button } from "../ui";
import { ScreenFrame } from "./frame";
import { breakdownResource, summaryResource } from "./insights/data";
import { DimensionPanel } from "./insights/dimension";
import { Cell, Grid } from "./insights/grid";
import { displayName } from "./insights/names";
import { valueDetail } from "./insights/value-detail";

const TECH_DIMS: readonly Dim[] = ["browser", "os", "device", "screen", "app_version"];

export function TechScreen() {
  const load = breakdownResource(TECH_DIMS, 20);
  const summary = summaryResource();
  const total = () => summary()?.totals.visitors;
  // The filtered value the details are about: the first of the tech dimensions that is filtered.
  const focus = (): Dim | null => TECH_DIMS.find((d) => filterFor(d) !== null) ?? null;
  return (
    <ScreenFrame
      testID="screen-tech"
      title="Tech"
      description="Browsers and apps, systems, devices, screen sizes and app versions."
      actions={
        <If when={focus()}>
          {(d) => <Button variant="outline" size="sm" icon="info" label={`${dimLabels[d()]} details`} onPress={() => openDetail(valueDetail(d(), filterFor(d())!, "tech-page"))} testID="tech-details" />}
        </If>
      }
    >
      <Grid min={360} testID="tech-grid">
        <Cell>
          <DimensionPanel testID="tech-browser" title="Browsers" column="Browser or app" note="Native apps show as “App”" dim="browser" load={load} formatName={displayName} total={total} />
        </Cell>
        <Cell>
          <DimensionPanel testID="tech-os" title="Operating systems" column="OS" dim="os" load={load} formatName={displayName} total={total} />
        </Cell>
        <Cell>
          <DimensionPanel testID="tech-device" title="Devices" column="Device" dim="device" load={load} formatName={displayName} total={total} />
        </Cell>
        <Cell>
          <DimensionPanel testID="tech-screen" title="Screen sizes" column="Screen" dim="screen" load={load} formatName={displayName} total={total} />
        </Cell>
        <Cell span>
          <DimensionPanel testID="tech-version" title="App versions" column="Version" note="Sent by apps with their events" dim="app_version" load={load} formatName={displayName} total={total} />
        </Cell>
      </Grid>
    </ScreenFrame>
  );
}
