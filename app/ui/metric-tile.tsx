/**
 * A headline metric: label, value, the change against the previous period, and a slot for a
 * sparkline. Pressable tiles are the Overview's metric switcher (the selected one gets the active
 * wash and a brand underline that fades in).
 *
 * The delta's color says good or bad, not up or down: a falling bounce rate is good, so the caller
 * says which way is better (`better`).
 */
import type { JSX } from "nsh";
import { View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Glyph } from "./icons";
import { Txt } from "./text";
import { focusRing, interactiveTransition, motion, pressStyle, size } from "./tokens";

export function formatDelta(delta: number): string {
  const pct = Math.abs(delta * 100);
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

export function MetricTile(props: {
  label: string;
  value: string;
  /** Change as a fraction of the previous value (0.12 = +12%); null when there is nothing to compare. */
  delta?: number | null;
  better?: "up" | "down";
  selected?: boolean;
  onPress?: () => void;
  /** A `Sparkline`, or anything small under the value. */
  chart?: JSX.Element;
  testID?: string;
}) {
  const good = () => {
    const d = props.delta ?? 0;
    return (props.better ?? "up") === "up" ? d >= 0 : d <= 0;
  };
  const deltaText = () => (props.delta == null ? "" : formatDelta(props.delta));
  const content = (
    <View class="gap-1">
      <Txt size="caption" tone="muted" truncate>{props.label}</Txt>
      <View class="flex-row items-baseline gap-2">
        <Txt size="heading" weight="semibold" numeric testID={props.testID ? `${props.testID}-value` : undefined}>{props.value}</Txt>
        <If when={props.delta != null && Number.isFinite(props.delta)}>
          <View class="flex-row items-center gap-0.5">
            <Glyph name={(props.delta ?? 0) >= 0 ? "up" : "down"} size={12} tone={good() ? "ok" : "bad"} />
            <Txt size="caption" weight="medium" tone={good() ? "ok" : "bad"} numeric>{deltaText()}</Txt>
          </View>
        </If>
      </View>
      <If when={props.chart}><View style={{ height: size.spark }}>{props.chart}</View></If>
    </View>
  );
  return (
    <If when={props.onPress} else={<View testID={props.testID} class="p-3">{content}</View>}>
      <BaseButton
        testID={props.testID}
        selected={props.selected}
        accessibilityLabel={`${props.label} ${props.value}${props.delta == null ? "" : `, ${(props.delta ?? 0) >= 0 ? "up" : "down"} ${deltaText()}`}`}
        onPress={() => props.onPress?.()}
        class="rounded-(--radius-card) p-3 hover:bg-hover selected:bg-pressed motion-reduce:transition-none"
        activeStyle={pressStyle(motion.press.control)}
        focusVisibleStyle={focusRing()}
        style={interactiveTransition}
      >
        {content}
        <View
          class="absolute bottom-0 left-3 right-3 h-0.5 rounded-(--radius-pill) bg-brand transition-opacity motion-reduce:transition-none"
          style={{ opacity: props.selected ? 1 : 0, transitionDuration: motion.duration.fast }}
        />
      </BaseButton>
    </If>
  );
}
