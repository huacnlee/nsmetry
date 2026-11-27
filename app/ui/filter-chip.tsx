/**
 * Filter chips: an applied `dim:value` filter with its remove button, and the dashed "+ Country"
 * chip that opens a picker of values (Linear's add-filter chips).
 *
 * Motion: chips fade and scale in from 0.96 over `fast` as they are added (createMotion, soft
 * settle); the remove button scales on press (icon press); the picker grows out of its chip like
 * every popup (`popupProps`). Under reduced motion everything appears at once.
 */
import { createMotion, signal, View } from "nsh";
import { Button as BaseButton, Popover } from "nsh/base";
import { Glyph, type GlyphName } from "./icons";
import { TextInput } from "./input";
import { popupProps } from "./menu";
import { Skeleton } from "./surfaces";
import { Txt } from "./text";
import { focusRing, interactiveTransition, motion, pressStyle, size, touch, width } from "./tokens";

const chipHeight = size.chip;

/** An applied filter: "Country  Germany  ×". */
export function FilterChip(props: { label: string; value: string; onRemove: () => void; testID?: string }) {
  const m = createMotion({ enter: { duration: motion.duration.fast, easing: motion.settle, keyframes: { opacity: [0, 1], scale: [0.96, 1] } } });
  return (
    <View class="flex-row items-center gap-1 rounded-(--radius-pill) border border-border bg-brand-soft pl-2.5" style={[{ minHeight: chipHeight }, m.style]}>
      <Txt size="caption" tone="muted">{props.label}</Txt>
      <Txt size="caption" weight="medium" truncate style={{ maxWidth: width.chipMax }}>{props.value || "(none)"}</Txt>
      <BaseButton
        testID={props.testID}
        accessibilityLabel={`Remove filter ${props.label} ${props.value}`}
        onPress={props.onRemove}
        hitSlop={touch ? 8 : 4}
        class="ml-0.5 items-center justify-center rounded-(--radius-pill) hover:bg-pressed active:bg-pressed motion-reduce:transition-none"
        activeStyle={pressStyle(motion.press.icon)}
        focusVisibleStyle={focusRing()}
        style={[interactiveTransition, { width: chipHeight - 2, height: chipHeight - 2 }]}
      >
        <Glyph name="close" size={12} tone="muted" />
      </BaseButton>
    </View>
  );
}

export interface PickOption {
  value: string;
  label: string;
  /** A muted figure at the end (a count). */
  hint?: string;
}

/**
 * "+ Country": a dashed outline chip opening a searchable picker. `options` undefined means loading;
 * `onOpen` lets the caller load them only when asked.
 */
export function AddFilterChip(props: {
  label: string;
  icon?: GlyphName;
  options: readonly PickOption[] | undefined;
  onPick: (value: string) => void;
  onOpen?: () => void;
  error?: string | null;
  testID?: string;
}) {
  const open = signal(false);
  const query = signal("");
  const shown = () => {
    const q = query().trim().toLowerCase();
    const all = props.options ?? [];
    return (q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all).slice(0, 50);
  };
  return (
    <Popover
      {...popupProps()}
      align="start"
      open={open()}
      onOpenChange={(e) => {
        open.set(e.open);
        if (e.open) {
          query.set("");
          props.onOpen?.();
        }
      }}
      popupStyle={[{ minWidth: width.picker, maxHeight: width.pickerMaxHeight }, ...popupProps().popupStyle]}
      trigger={
        <BaseButton
          testID={props.testID}
          accessibilityLabel={`Add filter: ${props.label}`}
          class="flex-row items-center gap-1 rounded-(--radius-pill) border border-dashed border-border-strong px-2.5 hover:bg-hover active:bg-pressed selected:bg-pressed motion-reduce:transition-none"
          selected={open()}
          activeStyle={pressStyle(motion.press.control)}
          focusVisibleStyle={focusRing()}
          style={[interactiveTransition, { minHeight: chipHeight }]}
        >
          <Glyph name={props.icon ?? "plus"} size={12} tone="muted" />
          <Txt size="caption" weight="medium" tone="soft">{props.label}</Txt>
        </BaseButton>
      }
    >
      <View class="gap-1">
        <TextInput value={query()} onChange={(v) => query.set(v)} placeholder={`Search ${props.label.toLowerCase()}`} accessibilityLabel={`Search ${props.label}`} autoFocus />
        <If when={props.error}><Txt size="caption" tone="bad" role="alert">{props.error}</Txt></If>
        <If when={!props.error && props.options === undefined}>
          <View class="gap-1.5 p-2"><Skeleton width="80%" /><Skeleton width="60%" /><Skeleton width="70%" /></View>
        </If>
        <If when={props.options !== undefined && shown().length === 0}>
          <View class="px-2 py-3"><Txt size="caption" tone="muted">Nothing matches.</Txt></View>
        </If>
        <Each of={shown()} key={(o) => o.value}>
          {(o) => (
            <BaseButton
              accessibilityLabel={o().label}
              onPress={() => {
                props.onPick(o().value);
                open.set(false);
              }}
              focusVisibleStyle={focusRing()}
              class="flex-row items-center gap-2 rounded-(--radius) px-2 hover:bg-hover active:bg-pressed motion-reduce:transition-none"
              style={[interactiveTransition, { minHeight: size.row }]}
            >
              <View class="min-w-0 flex-1"><Txt truncate>{o().label}</Txt></View>
              <If when={o().hint}><Txt size="caption" tone="faint" numeric>{o().hint}</Txt></If>
            </BaseButton>
          )}
        </Each>
      </View>
    </Popover>
  );
}
