/**
 * Data display: the quiet parts of a detail view and a dense list (Linear's issue view, allsum's
 * tables). StatusPill, ShareBar, PropertyList, Timeline, DataTable, Avatar, CodeBlock, Tag.
 *
 * Motion: ShareBar's fill grows by `scaleX` over `base` on the soft curve when its value changes;
 * CodeBlock's copy glyph swaps to a check for 1.5s (fade over `fast`); a status pill's live dot
 * breathes (`animate-pulse`); everything else is static. All of it is still under reduced motion.
 */
import type { JSX } from "nsh";
import { Clipboard, signal, View } from "nsh";
import { Avatar as BaseAvatar, Button as BaseButton } from "nsh/base";
import { IconButton } from "./button";
import { Txt } from "./text";
import { focusRing, interactiveTransition, motion, size, width } from "./tokens";

// ------------------------------------------------------------------------------------- status pill

export type StatusTone = "ok" | "warn" | "bad" | "neutral" | "brand";
const dotClass: Record<StatusTone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", neutral: "bg-faint", brand: "bg-brand" };
const washClass: Record<StatusTone, string> = { ok: "bg-ok/12", warn: "bg-warn/12", bad: "bg-bad/12", neutral: "bg-hover", brand: "bg-brand-soft" };

/** A soft pill with a dot and a short state ("Live", "No events in 7 days"). `pulse` breathes the dot. */
export function StatusPill(props: { label: string; tone?: StatusTone; pulse?: boolean; testID?: string }) {
  const tone = () => props.tone ?? "neutral";
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.label}
      class={`flex-row items-center gap-1.5 self-start rounded-(--radius-pill) px-2 ${washClass[tone()]}`}
      style={{ height: size.pill }}
    >
      <View class={`h-1.5 w-1.5 rounded-full ${dotClass[tone()]} ${props.pulse ? "animate-pulse motion-reduce:animate-none" : ""}`} />
      <Txt size="caption" weight="medium" tone="soft">{props.label}</Txt>
    </View>
  );
}

/** A soft tinted label pill (Linear's labels): a tag on a record, not a state. */
export function Tag(props: { label: string; tone?: StatusTone }) {
  return (
    <View class={`items-center justify-center self-start rounded-(--radius-pill) px-2 ${washClass[props.tone ?? "neutral"]}`} style={{ height: size.tag }}>
      <Txt size="micro" weight="medium" tone="soft">{props.label}</Txt>
    </View>
  );
}

// ------------------------------------------------------------------------------------- share bar

/**
 * A thin two-tone bar: the share in the brand color on the hover wash ("62% of visitors"). It is a
 * `progressbar` for screen readers with its value.
 */
export function ShareBar(props: { value: number; tone?: "brand" | "ok" | "warn" | "bad"; height?: number; accessibilityLabel?: string }) {
  const v = () => Math.max(0, Math.min(1, Number.isFinite(props.value) ? props.value : 0));
  const fill = () => ({ brand: "bg-brand", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" })[props.tone ?? "brand"];
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v() * 100) }}
      class="self-stretch overflow-hidden rounded-(--radius-pill) bg-hover"
      style={{ height: props.height ?? 4 }}
    >
      <View
        class={`absolute inset-0 rounded-(--radius-pill) ${fill()} motion-reduce:transition-none`}
        style={{
          transform: [{ scaleX: v() }],
          transformOrigin: "left",
          transitionProperty: "transform",
          transitionDuration: motion.duration.base,
          transitionTimingFunction: `cubic-bezier(${motion.settleCurve.join(",")})`,
        }}
      />
    </View>
  );
}

// ------------------------------------------------------------------------------------- property list

export interface Property {
  label: string;
  /** Text, or an element (a Tag, a StatusPill, an avatar and a name). */
  value: string | JSX.Element;
  /** Show a text value in the monospace face (ids, versions, hashes). */
  mono?: boolean;
}

/** Two columns: muted labels, values (Linear's issue properties). */
export function PropertyList(props: { items: readonly Property[]; labelWidth?: number; testID?: string }) {
  return (
    <View testID={props.testID} class="gap-0.5">
      <Each of={props.items}>
        {(p) => (
          <View class="flex-row items-center gap-3" style={{ minHeight: size.row }}>
            <View style={{ width: props.labelWidth ?? width.propertyLabel }}>
              <Txt tone="muted" truncate>{p().label}</Txt>
            </View>
            {/* min-w-0 lets a long value (a URL) truncate inside the card instead of pushing past it. */}
            <View class="min-w-0 flex-1 flex-row items-center overflow-hidden">
              {typeof p().value === "string"
                ? <View selectable class="min-w-0 shrink"><Txt truncate class={p().mono ? "font-mono" : undefined}>{p().value as string}</Txt></View>
                : (p().value as JSX.Element)}
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

// ------------------------------------------------------------------------------------- timeline

export interface TimelineItem {
  id: string | number;
  /** What happened ("Added example.com"). */
  title: string;
  /** Who, or a short detail, after the title in muted text. */
  detail?: string;
  /** Right-aligned, muted ("2h ago"). */
  time?: string;
  tone?: StatusTone;
  /** An avatar in place of the dot. */
  avatar?: string;
}

/** An activity feed: a dot per entry joined by a hairline, the time at the end of each row. */
export function Timeline(props: { items: readonly TimelineItem[]; testID?: string }) {
  return (
    <View testID={props.testID}>
      <Each of={props.items} key={(i) => i.id}>
        {(item, index) => (
          <View class="flex-row gap-3">
            <View class="items-center" style={{ width: size.timelineGutter }}>
              <View class={`w-px flex-1 ${index() === 0 ? "bg-transparent" : "bg-border"}`} style={{ minHeight: 6 }} />
              <If when={item().avatar} else={<View class={`h-2 w-2 rounded-full ${dotClass[item().tone ?? "neutral"]}`} />}>
                {(name) => <Avatar name={name()} size={20} />}
              </If>
              <View class={`w-px flex-1 ${index() === props.items.length - 1 ? "bg-transparent" : "bg-border"}`} style={{ minHeight: 6 }} />
            </View>
            <View class="flex-1 flex-row items-center gap-2 py-1.5">
              <View class="flex-1 flex-row flex-wrap gap-1">
                <Txt weight="medium">{item().title}</Txt>
                <If when={item().detail}><Txt tone="muted">{item().detail}</Txt></If>
              </View>
              <If when={item().time}><Txt size="caption" tone="faint" numeric>{item().time}</Txt></If>
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

// ------------------------------------------------------------------------------------- avatar

/** A person's initials on the active wash (accounts have no pictures). */
export function Avatar(props: { name: string; size?: number; accessibilityLabel?: string }) {
  const s = () => props.size ?? 24;
  return (
    <BaseAvatar
      name={props.name}
      accessibilityLabel={props.accessibilityLabel ?? props.name}
      class="overflow-hidden rounded-full"
      style={{ width: s(), height: s() }}
      fallbackClass="items-center justify-center bg-pressed"
      fallback={<Txt size={s() >= 28 ? "caption" : "micro"} weight="semibold" tone="soft">{(props.name.trim()[0] ?? "?").toUpperCase()}</Txt>}
    />
  );
}

// ------------------------------------------------------------------------------------- data table

export interface Column<T> {
  key: string;
  title: string;
  /** Text of a cell, or an element. */
  cell: (row: T) => string | JSX.Element;
  /** A fixed width; without one the column shares the rest. */
  width?: number;
  align?: "start" | "end";
  /** Muted monospace (ids, versions, times): Linear's secondary columns. */
  mono?: boolean;
  /**
   * Leave the column out while the table is narrower than this (points): on a phone a table keeps
   * its first column and the ones that still fit, never squeezing every column to nothing.
   */
  hideBelow?: number;
}

/**
 * A small table of bounded rows (people, sites, grants): muted 13pt headers, 14pt rows on hairlines.
 * Rows press when `onRowPress` is given: each is then a button, in the Tab order with the focus
 * ring, Return or Space pressing it. For lists that can grow without bound use `List`.
 */
export function DataTable<T>(props: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  onRowPress?: (row: T) => void;
  /** What screen readers say a pressable row does, from the row ("Open ada@example.com"). */
  rowLabel?: (row: T) => string;
  empty?: JSX.Element;
  testID?: string;
}) {
  // Measured, so `hideBelow` follows the space the table has, not the window.
  const tableWidth = signal(Number.POSITIVE_INFINITY);
  const shown = () => props.columns.filter((c) => !c.hideBelow || tableWidth() >= c.hideBelow);
  // min-w-0 + overflow-hidden: a flexible cell may shrink below its content and clip it, so cells
  // never draw over each other on a narrow screen.
  const cellStyle = (c: Column<T>) => (c.width ? { width: c.width } : { flex: 1, minWidth: 0 });
  const cellClass = (c: Column<T>) => `overflow-hidden ${c.align === "end" ? "items-end" : ""}`;
  const cells = (row: T) => (
    <Each of={shown()}>
      {(c) => (
        <View style={cellStyle(c())} class={cellClass(c())}>
          {(() => {
            const v = c().cell(row);
            return typeof v === "string"
              ? <Txt size={c().mono ? "ui" : "table"} tone={c().mono ? "muted" : "default"} class={c().mono ? "font-mono" : undefined} numeric={c().align === "end"} truncate>{v}</Txt>
              : v;
          })()}
        </View>
      )}
    </Each>
  );
  const rowClass = "flex-row items-center gap-3 border-b border-border px-3";
  return (
    <View testID={props.testID} role="table" onLayout={(e) => tableWidth.set(e.bounds.size.width)}>
      <View class={rowClass} style={{ height: size.tableHead }}>
        <Each of={shown()}>
          {(c) => (
            <View style={cellStyle(c())} class={cellClass(c())}>
              <Txt tone="muted" truncate>{c().title}</Txt>
            </View>
          )}
        </Each>
      </View>
      <If when={props.rows.length > 0} else={props.empty}>
        <Each of={props.rows} key={props.rowKey}>
          {(row) => (
            <If
              when={props.onRowPress}
              else={<View role="row" class={rowClass} style={{ minHeight: size.listRow + 4 }}>{cells(row())}</View>}
            >
              <BaseButton
                onPress={() => props.onRowPress?.(row())}
                accessibilityLabel={props.rowLabel?.(row())}
                class={`${rowClass} hover:bg-hover active:bg-pressed motion-reduce:transition-none`}
                style={{ minHeight: size.listRow + 4, ...interactiveTransition }}
                focusVisibleStyle={focusRing()}
              >
                {cells(row())}
              </BaseButton>
            </If>
          )}
        </Each>
      </If>
    </View>
  );
}

// ------------------------------------------------------------------------------------- code block

/** Monospace text on the sidebar tint with a copy button (a tracker snippet, a command). */
export function CodeBlock(props: { code: string; label?: string; testID?: string }) {
  const copied = signal(false);
  const copy = async () => {
    await Clipboard.writeText(props.code).catch(() => undefined);
    copied.set(true);
    setTimeout(() => copied.set(false), 1500);
  };
  return (
    <View testID={props.testID} class="flex-row items-start gap-2 rounded-(--radius-card) border border-border bg-sidebar py-2 pl-3 pr-1.5">
      <View class="flex-1 py-1" selectable>
        <Txt class="font-mono" tone="soft">{props.code}</Txt>
      </View>
      <IconButton
        icon={copied() ? "check" : "copy"}
        label={copied() ? "Copied" : `Copy ${props.label ?? "code"}`}
        size="sm"
        tone={copied() ? "ok" : undefined}
        onPress={() => void copy()}
        testID={props.testID ? `${props.testID}-copy` : undefined}
      />
    </View>
  );
}

/** Inline code inside muted body text. */
export function InlineCode(props: { children: string }) {
  return <Txt size="caption" class="font-mono rounded-(--radius-sm) bg-hover px-1">{props.children}</Txt>;
}
