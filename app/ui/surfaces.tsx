/**
 * Surfaces and small parts: Card / Panel, Badge, PillTabs, EmptyState, Skeleton.
 * allsum keeps surfaces flat: a 1px border and the page color, no shadow (shadows are for floating
 * things). Cards are 8pt corners, large panels 10pt.
 */
import type { JSX } from "nsh";
import { createMotion, View } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { Button } from "./button";
import { Glyph, type GlyphName } from "./icons";
import { Heading, Txt } from "./text";
import { focusRing, interactiveTransition, motion, pressStyle, size } from "./tokens";

/** A bordered surface. `inset` drops the padding (a list that runs edge to edge). */
export function Card(props: { children?: JSX.Element; inset?: boolean; class?: string; testID?: string }) {
  return (
    <View testID={props.testID} class={`rounded-(--radius-card) border border-border bg-card ${props.inset ? "" : "p-4"} ${props.class ?? ""}`}>
      {props.children}
    </View>
  );
}

/** A card with a header row: a title, an optional note, and actions at the end. */
export function Panel(props: {
  title: string;
  note?: string;
  actions?: JSX.Element;
  children?: JSX.Element;
  testID?: string;
  class?: string;
}) {
  return (
    <View testID={props.testID} class={`rounded-(--radius-panel) border border-border bg-card ${props.class ?? ""}`}>
      <View class="flex-row items-center gap-2 px-4 pt-3 pb-2">
        <View class="flex-1 gap-0.5">
          <Heading size="lead">{props.title}</Heading>
          <If when={props.note}><Txt size="caption" tone="muted">{props.note}</Txt></If>
        </View>
        {props.actions}
      </View>
      <View class="px-4 pb-4">{props.children}</View>
    </View>
  );
}

/** allsum's 18pt pill badge: 11pt medium on the active wash. `tone` only for status that matters. */
export function Badge(props: { label: string; tone?: "neutral" | "brand" | "ok" | "bad"; testID?: string }) {
  const bg = { neutral: "bg-pressed", brand: "bg-brand-soft", ok: "bg-ok/15", bad: "bg-bad/15" }[props.tone ?? "neutral"];
  const fg = { neutral: "soft", brand: "brand", ok: "ok", bad: "bad" } as const;
  return (
    <View testID={props.testID} class={`items-center justify-center rounded-(--radius-pill) px-1.5 self-start ${bg}`} style={{ height: size.badge }}>
      <Txt size="micro" weight="medium" tone={fg[props.tone ?? "neutral"]}>{props.label}</Txt>
    </View>
  );
}

/**
 * Pill tabs (allsum §3: 26pt pills, the selected one on the active wash). The wash is the Tabs
 * indicator, so it slides between tabs natively. Used inside panels ("Pages · Entry · Exit").
 */
export function PillTabs<T extends string>(props: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  return (
    <Tabs
      orientation="horizontal"
      accessibilityLabel={props.accessibilityLabel}
      class="flex-row gap-0.5"
      indicatorClass="inset-y-0 rounded-(--radius-pill) bg-pressed"
      testID={props.testID}
    >
      <Each of={props.options}>
        {(o) => (
          <Tab
            selected={o().value === props.value}
            onPress={() => o().value !== props.value && props.onChange(o().value)}
            focusVisibleStyle={focusRing()}
            testID={props.testID ? `${props.testID}-${o().value}` : undefined}
            accessibilityLabel={o().label}
            // The pill (indicator) springs between tabs natively; hover washes, a press scales a touch.
            class={`items-center justify-center rounded-(--radius-pill) px-2.5 motion-reduce:transition-none ${o().value === props.value ? "" : "hover:bg-hover"}`}
            activeStyle={pressStyle(motion.press.control)}
            style={[interactiveTransition, { height: size.chip + 2 }]}
          >
            <Txt size="caption" weight="medium" tone={o().value === props.value ? "default" : "muted"}>{o().label}</Txt>
          </Tab>
        )}
      </Each>
    </Tabs>
  );
}

/** Nothing to show: what is missing, why, and the one thing to do about it. */
export function EmptyState(props: {
  title: string;
  body?: string;
  icon?: GlyphName;
  action?: { label: string; onPress: () => void };
  testID?: string;
}) {
  // It fades up into place once, so an empty result reads as an answer rather than a blank.
  const m = createMotion({ enter: { duration: motion.duration.base, easing: motion.settle, keyframes: { opacity: [0, 1], translateY: [6, 0] } } });
  return (
    <View testID={props.testID} class="items-center justify-center gap-2 px-6 py-10" style={m.style}>
      <Glyph name={props.icon ?? "empty"} size={20} tone="faint" />
      <Txt weight="medium" align="center">{props.title}</Txt>
      <If when={props.body}><Txt size="caption" tone="muted" align="center">{props.body}</Txt></If>
      <If when={props.action}>
        {(a) => <View class="pt-2"><Button label={a().label} onPress={a().onPress} /></View>}
      </If>
    </View>
  );
}

/** A loading placeholder in the shape of what is coming. It breathes, except under reduced motion. */
export function Skeleton(props: { width?: number | `${number}%`; height?: number; round?: boolean }) {
  return (
    <View
      accessibilityLabel="Loading"
      class={`bg-hover animate-pulse motion-reduce:animate-none ${props.round ? "rounded-(--radius-pill)" : "rounded-(--radius-sm)"}`}
      style={{ width: props.width ?? "100%", height: props.height ?? 12 }}
    />
  );
}

/** A hairline between groups. */
export function Divider() {
  return <View class="h-px bg-border self-stretch" />;
}
