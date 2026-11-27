/**
 * Underline tabs (Linear's view tabs: a glyph and a label, a 2pt underline under the current one)
 * and grouped collapsible sections (a tinted rounded header with a chevron, a glyph, the name and a
 * muted count).
 *
 * Motion: the underline is the Tabs indicator, sprung natively to the next tab (at once under
 * reduced motion); labels change tone over `instant`. A group's chevron turns 90° over `fast` and its
 * content reveals with a clipped, critically damped height spring (NSH `Collapsible` `reveal`).
 */
import type { JSX } from "nsh";
import { Scroll, View } from "nsh";
import { Collapsible, Tab, Tabs } from "nsh/base";
import { Glyph, type GlyphName } from "./icons";
import { Txt } from "./text";
import { focusRing, interactiveTransition, motion, size } from "./tokens";

export interface TabOption<T extends string> {
  value: T;
  label: string;
  icon?: GlyphName;
  /** A muted count after the label. */
  count?: number;
}

export function UnderlineTabs<T extends string>(props: {
  options: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  // More tabs than a phone's width scroll sideways under one border instead of running off the edge.
  return (
    <View class="border-b border-border">
      <Scroll horizontal scrollbar={false}>
        <Tabs
          testID={props.testID}
          orientation="horizontal"
          accessibilityLabel={props.accessibilityLabel}
          class="flex-row gap-1"
          indicatorClass="bottom-0 mx-2 rounded-(--radius-pill) bg-foreground"
          indicatorStyle={{ height: size.indicator }}
        >
          <Each of={props.options}>
            {(o) => (
              <Tab
                testID={props.testID ? `${props.testID}-${o().value}` : undefined}
                selected={o().value === props.value}
                accessibilityLabel={o().label}
                onPress={() => o().value !== props.value && props.onChange(o().value)}
                focusVisibleStyle={focusRing()}
                class="flex-row items-center gap-1.5 rounded-(--radius) px-2 hover:bg-hover motion-reduce:transition-none"
                style={[interactiveTransition, { height: size.tabStrip }]}
              >
                <If when={o().icon}>{(n) => <Glyph name={n()} size={size.iconSm} tone={o().value === props.value ? "default" : "muted"} />}</If>
                <Txt weight="medium" tone={o().value === props.value ? "default" : "muted"}>{o().label}</Txt>
                <If when={o().count != null}><Txt size="caption" tone="faint" numeric>{String(o().count)}</Txt></If>
              </Tab>
            )}
          </Each>
        </Tabs>
      </Scroll>
    </View>
  );
}

/** A collapsible group: the header is the trigger, the children are revealed under it. */
export function GroupSection(props: {
  title: string;
  icon?: GlyphName;
  count?: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** At the end of the header (an add button). */
  actions?: JSX.Element;
  children?: JSX.Element;
  testID?: string;
}) {
  return (
    <Collapsible
      open={props.open}
      reveal
      class="gap-1"
      content={<View class="pt-0.5">{props.children}</View>}
    >
      <View class="flex-row items-center rounded-(--radius) bg-hover pr-1">
        {/* A focusable role="button" view, as Collapsible prescribes: base Button cannot say `expanded`. */}
        <View
          testID={props.testID}
          role="button"
          focusable
          accessibilityLabel={props.count == null ? props.title : `${props.title}, ${props.count}`}
          accessibilityState={{ expanded: props.open }}
          onPress={() => props.onToggle(!props.open)}
          focusVisibleStyle={focusRing()}
          class="min-w-0 flex-1 flex-row items-center gap-2 rounded-(--radius) px-2 hover:bg-hover active:bg-pressed motion-reduce:transition-none"
          style={[interactiveTransition, { minHeight: size.listRow }]}
        >
          <View
            class="motion-reduce:transition-none"
            style={{
              transform: [{ rotate: props.open ? "90deg" : "0deg" }],
              transitionProperty: "transform",
              transitionDuration: motion.duration.fast,
              transitionTimingFunction: `cubic-bezier(${motion.settleCurve.join(",")})`,
            }}
          >
            <Glyph name="chevronRight" size={size.iconSm} tone="muted" />
          </View>
          <If when={props.icon}>{(n) => <Glyph name={n()} size={size.iconSm} tone="soft" />}</If>
          <Txt weight="semibold">{props.title}</Txt>
          <If when={props.count != null}><Txt tone="faint" numeric>{String(props.count)}</Txt></If>
        </View>
        {props.actions}
      </View>
    </Collapsible>
  );
}
