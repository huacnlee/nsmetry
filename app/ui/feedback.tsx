/**
 * Small controls and feedback: Checkbox, Switch, Spinner, Tooltip and Separator. Each wraps its
 * `nsh/base` counterpart (keyboard, roles and states come from there) and draws its parts in tokens.
 *
 * Motion: a checkbox's mark fades and scales in over `instant`; a switch's thumb slides and its
 * track tints over `fast` on the soft curve; a spinner turns (`animate-spin`) and stands still under
 * reduced motion; a tooltip fades and rises 4pt over `fast`, leaves over `instant`.
 */
import type { JSX, ViewStyle } from "nsh";
import { View } from "nsh";
import { Checkbox as BaseCheckbox, Switch as BaseSwitch, Tooltip as BaseTooltip } from "nsh/base";
import { Glyph } from "./icons";
import { Txt, type Tone } from "./text";
import { elevation, focusRing, interactiveTransition, motion, settleTiming, size, touch, width } from "./tokens";

const settle = settleTiming;
// The control is small; on a touch screen the press area reaches a full target around it.
const slop = touch ? Math.max(0, (44 - size.checkbox) / 2) : 4;

/** A checkbox with its label to the right; the label is part of the press target. */
export function Checkbox(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Some but not all of what it stands for (a "select all"). */
  indeterminate?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  testID?: string;
}) {
  const on = () => props.checked || !!props.indeterminate;
  return (
    <BaseCheckbox
      testID={props.testID}
      checked={props.checked}
      indeterminate={props.indeterminate}
      disabled={props.disabled}
      invalid={props.invalid}
      accessibilityLabel={props.label}
      onChange={(e) => props.onChange(e.checked)}
      hitSlop={slop}
      class="group flex-row items-center gap-2 self-start rounded-(--radius-sm) disabled:opacity-50"
      focusVisibleStyle={focusRing()}
      style={{ minHeight: size.compact }}
      indicatorClass={`items-center justify-center rounded-(--radius-sm) border motion-reduce:transition-none ${on() ? "border-primary bg-primary" : props.invalid ? "border-bad bg-background group-hover:bg-hover" : "border-border-strong bg-background group-hover:bg-hover"}`}
      indicatorStyle={[interactiveTransition, { width: size.checkbox, height: size.checkbox }]}
      indicator={
        <View
          class="motion-reduce:transition-none"
          style={{
            opacity: on() ? 1 : 0,
            transform: [{ scale: on() ? 1 : 0.6 }],
            transitionProperty: "opacity, transform",
            transitionDuration: motion.duration.instant,
            transitionTimingFunction: settle,
          }}
        >
          <Glyph name={props.indeterminate ? "minus" : "check"} size={size.checkbox - 4} tone="on-primary" />
        </View>
      }
    >
      <Txt tone={props.disabled ? "muted" : "default"}>{props.label}</Txt>
    </BaseCheckbox>
  );
}

/** An on / off setting that applies at once (allsum's toggle): a pill track, a round thumb. */
export function Switch(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Show the label (default): a settings row hides it when the row already says it. */
  showLabel?: boolean;
  testID?: string;
}) {
  const inset = 2;
  const thumb = () => size.switchH - inset * 2;
  const travel = () => size.switchW - thumb() - inset * 2;
  return (
    <BaseSwitch
      testID={props.testID}
      checked={props.checked}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      onChange={(e) => props.onChange(e.checked)}
      hitSlop={touch ? Math.max(0, (44 - size.switchH) / 2) : 4}
      class="flex-row items-center gap-2 self-start rounded-(--radius-pill) disabled:opacity-50"
      focusVisibleStyle={focusRing()}
      trackClass={`rounded-(--radius-pill) motion-reduce:transition-none ${props.checked ? "bg-brand" : "border border-border-strong bg-hover hover:bg-pressed"}`}
      trackStyle={[interactiveTransition, { width: size.switchW, height: size.switchH, padding: inset, transitionDuration: motion.duration.fast }]}
      thumbClass="rounded-(--radius-pill) bg-elevated motion-reduce:transition-none"
      thumbStyle={[
        elevation.raised(),
        {
          width: thumb(),
          height: thumb(),
          transform: [{ translateX: props.checked ? travel() : 0 }],
          transitionProperty: "transform",
          transitionDuration: motion.duration.fast,
          transitionTimingFunction: settle,
        },
      ]}
    >
      <If when={props.showLabel ?? true}>
        <Txt tone={props.disabled ? "muted" : "default"}>{props.label}</Txt>
      </If>
    </BaseSwitch>
  );
}

/** A turning ring for work in progress. Decorative unless `label` says what is loading. */
export function Spinner(props: { size?: number; tone?: Tone; label?: string }) {
  return (
    <View
      role={props.label ? "progressbar" : undefined}
      accessibilityLabel={props.label}
      class="animate-spin motion-reduce:animate-none"
    >
      <Glyph name="loader" size={props.size ?? size.icon} tone={props.tone ?? "muted"} />
    </View>
  );
}

const tipStart: ViewStyle = { opacity: 0, transform: [{ translateY: motion.popDistance }] };
const tipEnd: ViewStyle = { opacity: 0, transitionDuration: motion.duration.instant };

/**
 * The bubble for a view's `tooltip` prop: `<IconButton … />` takes it as `tooltip={<Tooltip text="Copy" />}`.
 * Shown on hover after a short delay and at once on keyboard focus (NSH's rules); a hint only, never
 * the only way to learn what a control does: the control keeps its own accessibility label.
 */
export function Tooltip(props: { text: string; placement?: "top" | "bottom" | "left" | "right" }) {
  return (
    <BaseTooltip
      placement={props.placement ?? "top"}
      offset={6}
      class="rounded-(--radius) bg-foreground px-2 py-1 motion-reduce:transition-none"
      style={{
        maxWidth: width.tooltipMax,
        transitionProperty: "opacity, transform",
        transitionDuration: motion.duration.fast,
        transitionTimingFunction: settle,
      }}
      startingStyle={tipStart}
      endingStyle={tipEnd}
    >
      <Txt size="caption" weight="medium" class="text-background">{props.text}</Txt>
    </BaseTooltip>
  );
}

/** A hairline between groups: horizontal by default, vertical in a toolbar row. */
export function Separator(props: { vertical?: boolean; inset?: number }) {
  return (
    <View
      // Decorative: the groups it parts are what screen readers hear.
      class={`bg-border ${props.vertical ? "w-px self-stretch" : "h-px self-stretch"}`}
      style={props.vertical ? { marginVertical: props.inset ?? 0 } : { marginHorizontal: props.inset ?? 0 }}
    />
  );
}

export type { JSX };
