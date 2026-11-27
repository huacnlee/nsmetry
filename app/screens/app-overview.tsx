/**
 * Overview of an app (a site named without a dot, see isAppSite): how many people use it, then
 * what they open and do, and on which platform and version.
 *
 *  - Users first: active and new users over the range, daily, weekly and monthly, and the daily
 *    chart (the same loads and tiles as the Users screen, ./users.tsx).
 *  - The live panel, then screens, events, platforms (OS and device class), app versions and
 *    countries. Every row adds a filter that the whole app follows.
 *
 * What only a website has is left out: referrers and UTM tags, entry and exit pages, browsers,
 * bounce rate and visit duration. A desktop or phone app has no landing page and no referrer, and
 * a "bounce" there is just a short session. The Pages and Tech screens still show everything.
 *
 * Requests per load: one active-users, one breakdown carrying every list, one realtime every 30 s
 * while visible.
 */
import { View, windowSize } from "nsh";
import type { Dim } from "../api";
import { BreakdownList } from "../components/breakdown-list";
import { currentFilters, currentRange, currentSite, go, rangeLabels } from "../store";
import { Button, Card, EmptyState, Txt } from "../ui";
import { WIDE } from "../ui/tokens";
import { ScreenFrame } from "./frame";
import { breakdownResource } from "./insights/data";
import { Cell, Grid } from "./insights/grid";
import { displayName, leadingFor } from "./insights/names";
import { createLivePoll, LivePanel, LiveStatus } from "./realtime";
import { activeUsersResource, DailyUsersPanel, UsersSkeleton, UserTiles } from "./users";

const APP_DIMS: readonly Dim[] = ["path", "event", "os", "device", "app_version", "country"];

export function AppOverview() {
  const users = activeUsersResource();
  const lists = breakdownResource(APP_DIMS, 8);
  const live = createLivePoll();
  const tracked = () => users.active()?.tracked;

  return (
    <ScreenFrame
      testID="screen-overview"
      title={currentSite()?.domain ?? "Overview"}
      description={`Active users, screens and events · ${rangeLabels[currentRange()].long}`}
      actions={
        <View class="flex-row items-center gap-2">
          <LiveStatus live={live} testID="overview-status" />
          <If when={windowSize().width >= WIDE}>
            <Button label="Install tracking" icon="code" variant="outline" size="sm" onPress={() => go("settings")} testID="overview-install" />
          </If>
        </View>
      }
    >
      <If when={users.active.error()}>
        <Card>
          <EmptyState icon="error" title="Could not load users" body={String((users.active.error() as Error)?.message ?? "")} action={{ label: "Try again", onPress: () => users.active.refetch() }} />
        </Card>
      </If>
      <If when={!users.active.error() && users.active() === undefined}>
        <UsersSkeleton />
      </If>
      {/* No user id yet: active users need one, and the Users screen shows the lines that send it. */}
      <If when={tracked() === false}>
        <Card testID="overview-no-users">
          <EmptyState
            icon="users"
            title={`No app users for ${currentSite()?.domain ?? "this app"} yet`}
            body="Users are counted from the random install id the SDK sends. Settings has a prompt to paste into your coding agent."
            action={{ label: "Install tracking", onPress: () => go("settings") }}
          />
        </Card>
      </If>
      <If when={tracked() === true}>
        <If when={currentFilters().length > 0}>
          <Txt size="caption" tone="muted" testID="overview-users-filter-note">Filters do not apply to users: these count every install of the app.</Txt>
        </If>
        <UserTiles load={users} testID="overview-users" />
        <DailyUsersPanel load={users} testID="overview-users-chart" />
      </If>
      <Grid min={380} testID="overview-grid">
        <Cell>
          <LivePanel live={live} testID="live" />
        </Cell>
        <Cell>
          <BreakdownList testID="overview-pages" title="Screens" dims={["path"]} labels={{ path: "Screen" }} source={lists} formatName={displayName} />
        </Cell>
        <Cell>
          <BreakdownList testID="overview-events" title="Events" dims={["event"]} source={lists} formatName={displayName} />
        </Cell>
        <Cell>
          <BreakdownList
            testID="overview-platforms"
            title="Platforms"
            dims={["os", "device"]}
            labels={{ os: "OS", device: "Device" }}
            source={lists}
            formatName={displayName}
          />
        </Cell>
        <Cell>
          <BreakdownList testID="overview-versions" title="App versions" dims={["app_version"]} source={lists} formatName={displayName} />
        </Cell>
        <Cell>
          <BreakdownList testID="overview-countries" title="Countries" dims={["country"]} source={lists} formatName={displayName} leading={leadingFor} />
        </Cell>
      </Grid>
    </ScreenFrame>
  );
}
