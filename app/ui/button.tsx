/**
 * Buttons (allsum-io DESIGN.md §3.1). One component, four variants:
 *  - `primary`: a text-colored fill with the background color on it (allsum's "ink" button), 90% on
 *    hover. One per decision area: the action Return commits.
 *  - `outline`: a 1px strong border on the page color; the ordinary secondary action.
 *  - `ghost`: no chrome until hovered; toolbars and inline actions.
 *  - `danger`: an outline whose label and edge take the theme's `bad` role.
 * `IconButton` is the 28pt (44pt touch) square ghost with a 16pt glyph.
 *
 * Built on `nsh/base`'s Button, which owns presses, disabled / busy state and the button role; the
 * look is all token classes. Every state transitions over the `instant` motion token and presses
 * scale to 0.97 (0.95 for icon buttons); `motion-reduce:` drops the scale.
 */
import type { JSX } from "nsh";
import { View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Glyph, type GlyphName } from "./icons";
import { Txt } from "./text";
import { Spinner, Tooltip } from "./feedback";
import { focusRing, interactiveTransition, motion, pad, pressStyle, size } from "./tokens";

export type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

const look: Record<ButtonVariant, string> = {
  primary: "bg-primary border border-primary hover:opacity-90 active:opacity-80",
  outline: "bg-background border border-border-strong hover:bg-hover active:bg-pressed",
  ghost: "border border-transparent hover:bg-hover active:bg-pressed",
  danger: "bg-background border border-bad/40 hover:bg-bad/10 active:bg-bad/15",
};
const labelTone = { primary: "on-primary", outline: "default", ghost: "soft", danger: "bad" } as const;
const glyphTone = { primary: "on-primary", outline: "muted", ghost: "muted", danger: "bad" } as const;

export function Button(props: {
  label: string;
  variant?: ButtonVariant;
  /** `sm` is allsum's compact 24pt control (toolbars, chips). */
  size?: "sm" | "md";
  icon?: GlyphName;
  /** A trailing glyph: a menu trigger's chevron. */
  trailing?: GlyphName;
  /** Its action is running: a busy state for screen readers, and no further presses. */
  busy?: boolean;
  disabled?: boolean;
  /** Stretch to the row's width (a phone form's main action). */
  block?: boolean;
  selected?: boolean;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const v = () => props.variant ?? "outline";
  const sm = () => props.size === "sm";
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled || props.busy}
      busy={props.busy}
      selected={props.selected}
      onPress={() => props.onPress?.()}
      class={`flex-row items-center justify-center gap-1.5 rounded-(--radius) motion-reduce:transition-none ${look[v()]} disabled:opacity-50 selected:bg-pressed`}
      activeStyle={pressStyle(motion.press.control)}
      focusVisibleStyle={focusRing()}
      style={[
        interactiveTransition,
        {
          height: sm() ? size.compact : size.control,
          paddingHorizontal: sm() ? pad.compact : pad.control,
          alignSelf: props.block ? "stretch" : "flex-start",
        },
      ]}
    >
      {/* Busy swaps the leading glyph for a spinner, so the label (and the width) stays put. */}
      <If when={props.busy} else={<If when={props.icon}>{(name) => <Glyph name={name()} size={sm() ? size.iconSm : size.icon} tone={glyphTone[v()]} />}</If>}>
        <Spinner size={sm() ? size.iconSm : size.icon} tone={glyphTone[v()]} />
      </If>
      <Txt size={sm() ? "caption" : "ui"} weight="medium" tone={labelTone[v()]} truncate>
        {props.busy ? `${props.label}…` : props.label}
      </Txt>
      <If when={props.trailing}>{(name) => <Glyph name={name()} size={size.iconSm} tone={glyphTone[v()]} />}</If>
    </BaseButton>
  );
}

/** A square ghost button around one glyph. Always has a label: it is what screen readers say. */
export function IconButton(props: {
  icon: GlyphName;
  label: string;
  size?: "sm" | "md";
  selected?: boolean;
  disabled?: boolean;
  tone?: "muted" | "default" | "ok" | "bad";
  /** The hint shown on hover and keyboard focus: the label by default, `false` for none. */
  tooltip?: string | false;
  onPress?: () => void;
  testID?: string;
}) {
  const side = () => (props.size === "sm" ? size.compact : size.control);
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      selected={props.selected}
      onPress={() => props.onPress?.()}
      hitSlop={4}
      // A glyph alone says little to a sighted pointer user: its name shows on hover and on focus.
      tooltip={props.tooltip === false ? undefined : <Tooltip text={props.tooltip ?? props.label} />}
      class="items-center justify-center rounded-(--radius) hover:bg-hover active:bg-pressed selected:bg-pressed disabled:opacity-40 motion-reduce:transition-none"
      activeStyle={pressStyle(motion.press.icon)}
      focusVisibleStyle={focusRing()}
      style={[interactiveTransition, { width: side(), height: side() }]}
    >
      <Glyph name={props.icon} size={props.size === "sm" ? size.iconSm : size.icon} tone={props.tone ?? "muted"} />
    </BaseButton>
  );
}

/** The account button: a round initial on the pressed wash (a menu trigger). */
export function AvatarButton(props: { initial: string; accessibilityLabel: string; onPress?: () => void; testID?: string }) {
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      onPress={() => props.onPress?.()}
      hitSlop={8}
      class="items-center justify-center rounded-(--radius-pill) bg-pressed hover:bg-border-strong motion-reduce:transition-none"
      activeStyle={pressStyle(motion.press.icon)}
      focusVisibleStyle={focusRing()}
      style={[interactiveTransition, { width: size.avatar, height: size.avatar }]}
    >
      <Txt size="caption" weight="semibold" tone="soft">{props.initial}</Txt>
    </BaseButton>
  );
}

/** A row of buttons with allsum's 8pt gap, ends aligned. */
export function ButtonRow(props: { children?: JSX.Element; align?: "start" | "end" | "between" }) {
  const j = () => (props.align === "end" ? "justify-end" : props.align === "between" ? "justify-between" : "justify-start");
  return <View class={`flex-row flex-wrap items-center gap-2 ${j()}`}>{props.children}</View>;
}
