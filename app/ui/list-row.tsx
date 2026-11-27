/**
 * A breakdown row (allsum's table row: 14pt text, 8×12 cells) with a proportional fill bar behind
 * the label, the way analytics tools show a share at a glance. The bar is the brand's soft tint and
 * grows from the left by `scaleX`, so a new range or filter animates it (`base` duration on the soft
 * curve) without relayout; reduced motion sets it at once.
 *
 * A row is a button when it has `onPress` (add the value as a filter), with hover and press states.
 */
import type { JSX } from "nsh";
import { View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Txt } from "./text";
import { focusRing, interactiveTransition, motion, pressStyle, size, width } from "./tokens";

export function BarRow(props: {
  label: string;
  /** Formatted value at the end ("1,204"). */
  value: string;
  /** 0..1 of the largest row: the bar's length. */
  share: number;
  /** A second, quieter figure before the value ("34%"). */
  secondary?: string;
  /** Before the label: a flag, a favicon, a glyph. */
  leading?: JSX.Element;
  onPress?: () => void;
  accessibilityHint?: string;
  testID?: string;
}) {
  const share = () => Math.max(0, Math.min(1, props.share));
  const body = (
    <>
      <View
        class="absolute inset-y-0.5 left-0 right-0 rounded-(--radius-sm) bg-bar motion-reduce:transition-none"
        style={{
          transform: [{ scaleX: share() }],
          transformOrigin: "left",
          transitionProperty: "transform",
          transitionDuration: motion.duration.base,
          transitionTimingFunction: `cubic-bezier(${motion.settleCurve.join(",")})`,
        }}
      />
      <View class="min-w-0 flex-1 flex-row items-center gap-2 px-2">
        {props.leading}
        <View class="min-w-0 flex-1">
          <Txt size="table" truncate>{props.label}</Txt>
        </View>
      </View>
      <If when={props.secondary}>
        <Txt size="caption" tone="muted" numeric>{props.secondary}</Txt>
      </If>
      <View class="items-end pl-3 pr-2" style={{ minWidth: width.valueColumn }}>
        <Txt size="table" weight="medium" numeric>{props.value}</Txt>
      </View>
    </>
  );
  return (
    <If
      when={props.onPress}
      else={
        <View testID={props.testID} class="flex-row items-center" style={{ minHeight: size.listRow }}>
          {body}
        </View>
      }
    >
      <BaseButton
        testID={props.testID}
        accessibilityLabel={`${props.label}, ${props.value}`}
        accessibilityHint={props.accessibilityHint}
        onPress={() => props.onPress?.()}
        class="flex-row items-center rounded-(--radius) hover:bg-hover active:bg-pressed motion-reduce:transition-none"
        activeStyle={pressStyle(motion.press.row)}
        focusVisibleStyle={focusRing()}
        style={[interactiveTransition, { minHeight: size.listRow }]}
      >
        {body}
      </BaseButton>
    </If>
  );
}
