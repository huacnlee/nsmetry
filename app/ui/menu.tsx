/**
 * Menus, popovers and selects (allsum §3: an elevated surface with a light popup shadow, 4pt padding,
 * 8pt corners; rows at least 30pt, 13pt text, 6pt corners; a separator inset 8pt).
 *
 * `nsh/base` Menu brings the behavior (keyboard, typeahead, dismissal, a bottom sheet on phones);
 * this file is its one look. Popups grow out of their trigger: their first frame is 96% scale, 4pt
 * toward the trigger and transparent, and they settle over `fast` (180ms) on the soft curve; they
 * leave over `instant` (120ms). NSH runs both at once under reduced motion.
 */
import type { JSX, ViewStyle } from "nsh";
import { View } from "nsh";
import { Menu, MenuItem, MenuSeparator, Popover, Select as BaseSelect } from "nsh/base";
import { Button } from "./button";
import { Glyph, type GlyphName } from "./icons";
import { Txt } from "./text";
import { elevation, motion, size, touch, type, width } from "./tokens";

const popupClass = "rounded-(--radius-card) border border-border bg-popover p-1";
const popupMotion: ViewStyle = {
  transitionProperty: "opacity, transform",
  transitionDuration: motion.duration.fast,
  transitionTimingFunction: `cubic-bezier(${motion.settleCurve.join(",")})`,
  transformOrigin: "top",
};
const popupStart: ViewStyle = {
  opacity: 0,
  transform: [{ translateY: -motion.popDistance }, { scale: 0.96 }],
};
const popupEnd: ViewStyle = { opacity: 0, transform: [{ scale: 0.98 }], transitionDuration: motion.duration.instant };

/** The props every `Menu` / `Popover` in the app takes, spread onto it. */
export const popupProps = () => ({
  popupClass,
  popupStyle: [{ minWidth: 200 }, elevation.popup(), popupMotion] as ViewStyle[],
  popupStartingStyle: popupStart,
  popupEndingStyle: popupEnd,
  offset: 4,
});

/** `popupProps` plus the backdrop a menu shows as a bottom sheet on phones. */
export const menuProps = () => ({ ...popupProps(), backdropClass: "bg-scrim" });

/** A menu row: optional glyph, a label, an optional trailing hint; `checked` shows a check. */
export function MenuRow(props: {
  label: string;
  icon?: GlyphName;
  hint?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  testID?: string;
}) {
  return (
    <MenuItem
      testID={props.testID}
      disabled={props.disabled}
      checked={props.checked === undefined ? undefined : props.checked}
      role={props.checked === undefined ? undefined : "menuitemradio"}
      onSelect={props.onSelect}
      accessibilityLabel={props.label}
      class="flex-row items-center gap-2 rounded-(--radius) px-2 hover:bg-hover focus:bg-hover active:bg-pressed disabled:opacity-40"
      style={{ minHeight: size.row }}
    >
      <If when={props.icon}>{(n) => <Glyph name={n()} size={size.iconSm} tone={props.danger ? "bad" : "muted"} />}</If>
      <View class="min-w-0 flex-1">
        <Txt tone={props.danger ? "bad" : "default"} truncate>{props.label}</Txt>
      </View>
      <If when={props.hint}><Txt size="caption" tone="faint">{props.hint}</Txt></If>
      <If when={props.checked !== undefined}>
        <View
          style={{ width: size.icon, opacity: props.checked ? 1 : 0, transitionProperty: "opacity", transitionDuration: motion.duration.instant }}
          class="motion-reduce:transition-none"
        >
          <Glyph name="check" size={size.iconSm} tone="brand" />
        </View>
      </If>
    </MenuItem>
  );
}

/**
 * An action menu: `nsh/base` Menu with the app's popup look (grows from its trigger; a sheet on
 * phones). `trigger` is a `Button`, `NavButton` or `AvatarButton`; children are `MenuRow`s.
 */
export function ActionMenu(props: {
  trigger: JSX.Element;
  align?: "start" | "end";
  /** Hears the menu open and close (its open state stays its own). */
  onOpenChange?: (open: boolean) => void;
  children?: JSX.Element;
}) {
  return (
    <Menu {...menuProps()} align={props.align ?? "start"} trigger={props.trigger} onOpenChange={(e) => props.onOpenChange?.(e.open)}>
      {props.children}
    </Menu>
  );
}

/** The line between groups, inset 8pt as allsum's. */
export function MenuSep() {
  return <MenuSeparator class="my-1 h-px bg-border" style={{ marginHorizontal: 8 }} />;
}

/** A quiet section label inside a menu (the account menu's email). */
export function MenuLabel(props: { children?: JSX.Element }) {
  return (
    <View class="px-2 py-1.5">
      <Txt size="caption" tone="muted" truncate>{props.children}</Txt>
    </View>
  );
}

/**
 * A single choice from a list (allsum's "select / popover menu"): a button with a chevron that opens
 * the list on `nsh/base` Select, a popup at the trigger on desktops and a bottom sheet on phones, with
 * arrows, typeahead, Return and Escape. Controlled: the app owns `value`. An action list (rows that
 * do something rather than set a value) is a `Menu` of `MenuRow`s instead.
 */
export function Select<T extends string>(props: {
  value: T | null;
  options: readonly { value: T; label: string; disabled?: boolean; group?: string }[];
  onChange: (value: T) => void;
  accessibilityLabel: string;
  /** What the trigger says while nothing is chosen. */
  placeholder?: string;
  icon?: GlyphName;
  /** `ghost` in toolbars and headers; `outline` in forms. */
  variant?: "ghost" | "outline";
  size?: "sm" | "md";
  /** A search field above a long list. */
  searchable?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const current = () => props.options.find((o) => o.value === props.value)?.label ?? props.placeholder ?? "";
  return (
    <BaseSelect
      {...popupProps()}
      backdropClass="bg-scrim"
      align="start"
      value={props.value}
      items={props.options.map((o) => ({ value: o.value, title: o.label, disabled: o.disabled, group: o.group }))}
      onChange={(e) => {
        if (e.value != null && e.value !== props.value) props.onChange(e.value as T);
      }}
      disabled={props.disabled}
      searchable={props.searchable}
      searchPlaceholder="Search"
      searchAccessibilityLabel={`Search ${props.accessibilityLabel.toLowerCase()}`}
      searchClass="mb-1 rounded-(--radius) border border-input bg-background px-2 text-foreground placeholder:text-faint"
      searchStyle={[type.ui, { height: size.control }]}
      accessibilityLabel={props.accessibilityLabel}
      itemClass="group flex-row items-center gap-2 rounded-(--radius) px-2 text-foreground focus:bg-hover active:bg-pressed disabled:opacity-40"
      itemStyle={[type.ui, { minHeight: size.row }]}
      groupClass="px-2 pt-2 pb-1"
      renderGroup={(g) => <Txt size="caption" tone="muted">{g.title}</Txt>}
      renderItem={(item) => (
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <View class="min-w-0 flex-1"><Txt truncate>{item.title}</Txt></View>
          {/* The check follows the row's selected state (group-selected:), not a value read here. */}
          <View class="opacity-0 group-selected:opacity-100" style={{ width: size.icon }}>
            <Glyph name="check" size={size.iconSm} tone="brand" />
          </View>
        </View>
      )}
      empty={<View class="px-2 py-2"><Txt tone="muted">No matches</Txt></View>}
      trigger={
        <Button
          label={current()}
          icon={props.icon}
          trailing="chevronDown"
          variant={props.variant ?? "ghost"}
          size={props.size}
          disabled={props.disabled}
          accessibilityLabel={`${props.accessibilityLabel}: ${current()}`}
          testID={props.testID}
        />
      }
    />
  );
}

/** A popover with the menu surface: free content anchored to a trigger. */
export function PopoverPanel(props: {
  trigger: JSX.Element;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: JSX.Element;
}) {
  return (
    <Popover
      {...popupProps()}
      align="start"
      open={props.open}
      onOpenChange={(e) => props.onOpenChange?.(e.open)}
      trigger={props.trigger}
      popupStyle={[{ minWidth: width.picker, padding: 12 }, elevation.popup(), popupMotion]}
    >
      {props.children}
    </Popover>
  );
}

export { touch };
