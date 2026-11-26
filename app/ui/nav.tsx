/**
 * Navigation controls of the shell, as `ui` variants so the shell composes nothing from `nsh/base`:
 *  - `NavList` / `NavItem`: the sidebar's sections (allsum §4: 13pt items 30pt tall, the current one
 *    weight 500 on the sidebar accent wash). The wash is the Tabs indicator: it springs between items.
 *  - `NavButton`: a sidebar-row-shaped button (the site switcher): same height, inset and glyph column
 *    as a `NavItem`, content left-aligned, a trailing glyph at the end.
 *  - `TabBarList` / `TabBarItem` / `TabBarButton`: the phone tab bar. Items are 44pt (48dp) targets,
 *    the selected one brand-toned on a brand-soft wash that springs between tabs (the Tabs
 *    indicator). `TabBarButton` is the same look for an item that is an action, not a tab ("More"
 *    opens a sheet): it sits next to the list, so arrow keys never open it.
 *  - `SheetNavRow`: a section row inside a bottom sheet.
 *
 * Motion: indicators spring natively (at once under reduced motion); hover / press washes over
 * `instant`; a press scales a row to 0.99 and a tab bar item to 0.97.
 */
import type { JSX } from "nsh";
import { View } from "nsh";
import { Button as BaseButton, Tab, Tabs } from "nsh/base";
import { Glyph, type GlyphName } from "./icons";
import { Txt } from "./text";
import { focusRing, interactiveTransition, motion, pad, pressStyle, size } from "./tokens";

/** A vertical list of sections; children are `NavItem`s. */
export function NavList(props: { accessibilityLabel: string; children?: JSX.Element }) {
  return (
    <Tabs
      orientation="vertical"
      accessibilityLabel={props.accessibilityLabel}
      class="gap-px"
      indicatorClass="inset-x-0 rounded-(--radius) bg-sidebar-accent"
    >
      {props.children}
    </Tabs>
  );
}

export function NavItem(props: { label: string; icon: GlyphName; selected: boolean; onPress: () => void; testID?: string }) {
  return (
    <Tab
      testID={props.testID}
      selected={props.selected}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      focusVisibleStyle={focusRing()}
      class="flex-row items-center gap-2 rounded-(--radius) hover:bg-hover motion-reduce:transition-none"
      activeStyle={pressStyle(motion.press.row)}
      style={[interactiveTransition, { height: size.row, paddingHorizontal: pad.compact }]}
    >
      <Glyph name={props.icon} size={size.icon} tone={props.selected ? "default" : "muted"} />
      <Txt weight={props.selected ? "medium" : "regular"} tone={props.selected ? "default" : "soft"} truncate>
        {props.label}
      </Txt>
    </Tab>
  );
}

/** A button shaped like a `NavItem` (a menu trigger in the sidebar): left-aligned, full width. */
export function NavButton(props: {
  label: string;
  icon: GlyphName;
  trailing?: GlyphName;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onPress={() => props.onPress?.()}
      focusVisibleStyle={focusRing()}
      class="flex-row items-center justify-start gap-2 self-stretch rounded-(--radius) hover:bg-hover active:bg-pressed motion-reduce:transition-none"
      activeStyle={pressStyle(motion.press.row)}
      style={[interactiveTransition, { height: size.row, paddingHorizontal: pad.compact }]}
    >
      <Glyph name={props.icon} size={size.icon} tone="muted" />
      <View class="min-w-0 flex-1">
        <Txt weight="medium" truncate>{props.label}</Txt>
      </View>
      <If when={props.trailing}>{(n) => <Glyph name={n()} size={size.iconSm} tone="muted" />}</If>
    </BaseButton>
  );
}

/** The tab bar's tab list; children are `TabBarItem`s. It takes the room its siblings leave. */
export function TabBarList(props: { accessibilityLabel: string; children?: JSX.Element }) {
  return (
    <Tabs
      orientation="horizontal"
      accessibilityLabel={props.accessibilityLabel}
      class="flex-row"
      style={{ flex: 4 }}
      indicatorClass="inset-y-1 mx-1 rounded-(--radius-card) bg-brand-soft"
    >
      {props.children}
    </Tabs>
  );
}

function TabBarContent(props: { label: string; icon: GlyphName; selected: boolean }) {
  return (
    <>
      <Glyph name={props.icon} size={size.iconLg} tone={props.selected ? "brand" : "muted"} />
      <Txt size="micro" weight="medium" tone={props.selected ? "brand" : "muted"} truncate>{props.label}</Txt>
    </>
  );
}

const tabBarItemClass = "flex-1 items-center justify-center gap-0.5 rounded-(--radius-card) motion-reduce:transition-none";

export function TabBarItem(props: { label: string; icon: GlyphName; selected: boolean; onPress: () => void; testID?: string }) {
  return (
    <Tab
      testID={props.testID}
      selected={props.selected}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      focusVisibleStyle={focusRing()}
      class={tabBarItemClass}
      activeStyle={pressStyle(motion.press.control)}
      style={[interactiveTransition, { minHeight: size.row }]}
    >
      <TabBarContent label={props.label} icon={props.icon} selected={props.selected} />
    </Tab>
  );
}

/**
 * An item of the tab bar that is an action (opens a sheet): one tab's width, outside the tab list.
 * `selected` (the current section lives behind it) draws the same brand-soft wash, in place.
 */
export function TabBarButton(props: {
  label: string;
  icon: GlyphName;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <View class="py-1 px-1" style={{ flex: 1 }}>
      <BaseButton
        testID={props.testID}
        accessibilityLabel={props.accessibilityLabel ?? props.label}
        selected={props.selected}
        onPress={props.onPress}
        focusVisibleStyle={focusRing()}
        class={`${tabBarItemClass} selected:bg-brand-soft`}
        activeStyle={pressStyle(motion.press.control)}
        style={interactiveTransition}
      >
        <TabBarContent label={props.label} icon={props.icon} selected={!!props.selected} />
      </BaseButton>
    </View>
  );
}

/** A section row in a bottom sheet (the tab bar's "More"). */
export function SheetNavRow(props: { label: string; icon: GlyphName; selected: boolean; onPress: () => void; testID?: string }) {
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.label}
      selected={props.selected}
      onPress={props.onPress}
      focusVisibleStyle={focusRing()}
      class="flex-row items-center gap-3 rounded-(--radius-card) hover:bg-hover active:bg-pressed selected:bg-hover motion-reduce:transition-none"
      activeStyle={pressStyle(motion.press.row)}
      style={[interactiveTransition, { minHeight: size.row, paddingHorizontal: pad.control }]}
    >
      <Glyph name={props.icon} size={size.iconLg} tone={props.selected ? "brand" : "muted"} />
      <Txt size="lead" weight={props.selected ? "medium" : "regular"}>{props.label}</Txt>
    </BaseButton>
  );
}
