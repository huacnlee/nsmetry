/**
 * Geography: visitors by country, as a world map (a choropleth drawn on Canvas from the Worker's
 * `/api/world.json`) beside the list of countries. Pressing a country on the map or in the list adds
 * it as a filter; with a country filter on, "Country details" pushes its detail page.
 *
 * The map's shapes are public and immutable, so they are loaded once per run of the app and kept at
 * module level: switching screens back and forth does not ask again.
 */
import { resource, View } from "nsh";
import type { WorldMap as WorldShapes } from "../api";
import { formatCount } from "../format";
import { addFilter, api, filterFor, openDetail } from "../store";
import { Button, Card, EmptyState, Skeleton, WorldMap } from "../ui";
import { ScreenFrame } from "./frame";
import { countryName } from "./insights/countries";
import { breakdownResource, errorText, summaryResource } from "./insights/data";
import { DimensionPanel } from "./insights/dimension";
import { Cell, Grid } from "./insights/grid";
import { displayName, leadingFor } from "./insights/names";
import { valueDetail } from "./insights/value-detail";
import { touch } from "../ui";

let worldCache: Promise<WorldShapes> | null = null;
/** The world's shapes, asked for once per run (a failed load may be retried). */
function loadWorld(): Promise<WorldShapes> {
  worldCache ??= api.world().catch((e: unknown) => {
    worldCache = null;
    throw e;
  });
  return worldCache;
}

export function GeographyScreen() {
  const load = breakdownResource(["country"], 50);
  const summary = summaryResource();
  const world = resource(() => loadWorld());
  const values = () => {
    const out: Record<string, number> = {};
    for (const r of load()?.breakdowns.country ?? []) if (r.name) out[r.name.toUpperCase()] = r.value;
    return out;
  };
  const top = () => (load()?.breakdowns.country ?? []).slice(0, 3).map((r) => `${countryName(r.name)} ${formatCount(r.value)}`).join(", ");
  return (
    <ScreenFrame
      testID="screen-geography"
      title="Geography"
      description="Visitors by country."
      actions={
        <If when={filterFor("country")}>
          {(code) => <Button variant="outline" size="sm" icon="info" label="Country details" onPress={() => openDetail(valueDetail("country", code(), "country-page"))} testID="country-details" />}
        </If>
      }
    >
      <Grid min={420}>
        <Cell>
          <Card testID="world">
            <If when={world.error()}>
              <EmptyState icon="error" title="Could not load the map" body={errorText(world.error())} action={{ label: "Try again", onPress: () => void world.refetch() }} />
            </If>
            <If when={!world.error() && !world()}>
              <View class="gap-2">
                <Skeleton height={220} />
                <Skeleton width={160} height={12} />
              </View>
            </If>
            <If when={world()}>
              {(shapes) => (
                <WorldMap
                  testID="world-map"
                  map={shapes()}
                  values={values()}
                  selected={filterFor("country")}
                  onSelect={(code) => addFilter("country", code)}
                  name={countryName}
                  format={(v) => `${formatCount(v)} visitors`}
                  hint={touch ? "Tap a country to filter by it" : "Press a country to filter by it"}
                  accessibilityLabel={top() ? `World map of visitors. Most visitors: ${top()}` : "World map of visitors"}
                />
              )}
            </If>
          </Card>
        </Cell>
        <Cell>
          <DimensionPanel
            testID="countries"
            title="Countries"
            column="Country"
            dim="country"
            load={load}
            formatName={displayName}
            leading={leadingFor}
            total={() => summary()?.totals.visitors}
            placeholderRows={8}
          />
        </Cell>
      </Grid>
    </ScreenFrame>
  );
}
