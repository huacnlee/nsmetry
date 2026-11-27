/**
 * NsMetry's root: the boot / sign-in / signed-in switch, and the shell around the screens.
 *
 * Layout by width, not by platform (allsum §6): at 900pt and wider a sidebar with the brand and the
 * sections, and a 46pt top bar led by the site switcher with the range, compare and account;
 * narrower, a compact top bar (below the status bar on phones), the range across the width, and a
 * bottom tab bar with "More" in a sheet. Under the top bar, in both, the content area's page stack (./pages.tsx).
 * Desktop windows hide the system title bar and the shell keeps clear of the window controls.
 */
import type { Component, JSX } from "nsh";
import { useNsMetry, useScreenTracking } from "nsmetry";
import { nsmetry, startTelemetry } from "../telemetry";
import { safeAreaInsets, View, windowSize } from "nsh";
import { currentWindow, isAvailable as hasWindow, titleBar } from "nsh/desktop";
import { Head } from "nsh/web";
import {
  AgentsScreen,
  EventsScreen,
  GeographyScreen,
  OverviewScreen,
  PagesScreen,
  SettingsScreen,
  SourcesScreen,
  TeamScreen,
  TechScreen,
  UsersScreen,
} from "../screens";
import { SignIn } from "../signin";
import { boot, currentSection, detailDepth, type Section, sessionPhase, setAppearance } from "../store";
import { size, Skeleton, space, ToastHost } from "../ui";
import { Gallery } from "../ui/gallery";
import { AccountMenu, CompareToggle, RangePicker, SiteSwitcher } from "./controls";
import { Pages } from "./pages";
import { Brand, Sidebar } from "./sidebar";
import { TabBar } from "./tab-bar";

/** The width at which the sidebar layout starts. */
export { WIDE } from "../ui/tokens";
import { WIDE } from "../ui/tokens";

export type ScreenMap = Record<Section, Component>;

const defaultScreens: ScreenMap = {
  overview: OverviewScreen,
  users: UsersScreen,
  events: EventsScreen,
  pages: PagesScreen,
  sources: SourcesScreen,
  geography: GeographyScreen,
  tech: TechScreen,
  settings: SettingsScreen,
  team: TeamScreen,
  agents: AgentsScreen,
  gallery: () => <Gallery onAppearance={(a) => setAppearance(a)} />,
};

/**
 * One control in a bar row. `ui` controls pin themselves to the start of their parent's cross axis
 * (so they never stretch in a column); this box is what the row centers, so every control in a bar
 * shares one vertical center whatever its own height.
 */
function BarItem(props: { children?: JSX.Element }) {
  return <View class="justify-center">{props.children}</View>;
}

/**
 * The wide layout's top bar: the site being viewed leads it, beside what it scopes (range, compare).
 * It is the title bar's own row (the window controls sit over the sidebar), so it is not padded below it.
 */
function WideTopBar() {
  const top = () => (hasWindow ? titleBar().height : 0);
  return (
    <View class="flex-row items-center gap-2 border-b border-border px-4" style={{ height: Math.max(size.topBar, top()), paddingRight: space[4] + (hasWindow ? titleBar().right : 0) }}>
      <BarItem><SiteSwitcher /></BarItem>
      <View class="flex-1" />
      <BarItem><RangePicker /></BarItem>
      <BarItem><CompareToggle /></BarItem>
      <View class="w-px h-5 bg-border mx-1" />
      <BarItem><AccountMenu /></BarItem>
    </View>
  );
}

/**
 * The narrow layout's top. On a phone (no window of its own) it starts below the status bar and the
 * Dynamic Island and keeps clear of the notch in landscape; the site being viewed leads it (the
 * thing people switch most), the account trails, and the app's name is left to the home screen.
 * Under it the range spans the width with Compare as an icon, so nothing wraps at 320pt.
 * A narrow desktop window keeps its brand and clears the window controls.
 */
function NarrowTopBar() {
  const insets = safeAreaInsets();
  const left = () => (hasWindow ? titleBar().left : insets().left);
  const right = () => (hasWindow ? 0 : insets().right);
  const top = () => (hasWindow ? titleBar().height : 0);
  return (
    <View style={{ paddingTop: hasWindow ? 0 : insets().top }}>
      <View class="flex-row items-center gap-2" style={{ height: Math.max(size.topBar, top()), paddingLeft: space[2] + left(), paddingRight: space[3] + right() }}>
        <If when={hasWindow}>
          <View class="pl-1"><Brand /></View>
        </If>
        <View class={`flex-1 justify-center ${hasWindow ? "items-end" : "items-start"}`}>
          <SiteSwitcher />
        </View>
        <BarItem><AccountMenu /></BarItem>
      </View>
      <View class="flex-row items-center gap-1 pb-2" style={{ paddingLeft: space[3] + left(), paddingRight: space[2] + right() }}>
        <View class="flex-1 justify-center"><RangePicker stretch /></View>
        <BarItem><CompareToggle icon /></BarItem>
      </View>
    </View>
  );
}

/**
 * The signed-in shell. Only its chrome changes at the breakpoint (sidebar and top bar, or compact
 * top bar and tab bar); the content area, one page stack, is the same instance in both, so an open
 * detail survives a resize across 900pt.
 */
function Shell(props: { screens: ScreenMap }) {
  const wide = () => windowSize().width >= WIDE;
  return (
    <View class="flex-1 flex-row">
      <If when={wide()}>
        <Sidebar />
      </If>
      <View class="flex-1">
        <If when={wide()} else={<NarrowTopBar />}>
          <WideTopBar />
        </If>
        <Pages screens={props.screens} wide={wide()} />
        <If when={!wide()}>
          <TabBar />
        </If>
      </View>
    </View>
  );
}

function Booting() {
  return (
    <View class="flex-1 items-center justify-center gap-3" accessibilityLabel="Loading">
      <Brand />
      <Skeleton width={120} height={8} round />
    </View>
  );
}

/**
 * The whole app. `screens` replaces some sections' screens: test fixtures use it to put a shared
 * component (a BreakdownList) inside the real shell, with the real store and API client.
 */
export function Root(props: { screens?: Partial<ScreenMap> }) {
  const screens: ScreenMap = { ...defaultScreens, ...(props.screens ?? {}) };
  if (hasWindow) currentWindow().set({ title: "NsMetry", titleBar: { style: "hidden", height: size.topBar } });
  void boot();
  void startTelemetry();
  useNsMetry(nsmetry); // flush on background / quit
  // A screen view per section, and per detail page opened over it.
  useScreenTracking(nsmetry, () => `/${currentSection()}${detailDepth() > 0 ? "/detail" : ""}`);
  return (
    <View class="flex-1 bg-background">
      <Head title="NsMetry" description="Privacy-first analytics." />
      <If when={sessionPhase() === "loading"}>
        <Booting />
      </If>
      <If when={sessionPhase() === "signedOut"}>
        <SignIn />
      </If>
      <If when={sessionPhase() === "signedIn"}>
        <Shell screens={screens} />
      </If>
      <ToastHost />
    </View>
  );
}
