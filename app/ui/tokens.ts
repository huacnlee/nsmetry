/**
 * NsMetry's non-color design tokens: sizes, type scale, spacing, radii and motion.
 *
 * Colors are NOT here: they live in `../theme.json` (allsum-io's palette, light and dark) and are read
 * through token classes (`bg-elevated`, `text-soft`) or `token("…")`. Everything in this file is
 * geometry or timing, which the theme file has no good home for, and which the `ui/` controls read so
 * that screens never pick a size of their own.
 *
 * Values follow allsum-io's DESIGN.md (13px UI base, 28px controls, 4px grid, 6/8/10 radii), with two
 * deliberate departures the NSH Design Guides require: a visible keyboard focus ring, and 44pt (iOS) /
 * 48dp (Android) touch targets on phones and tablets, where allsum would have used 36/40.
 */
import type { ViewStyle } from "nsh";
import { Easing, platform, token } from "nsh";

/**
 * A pointer device (desktop or a desktop-idiom browser) gets allsum's compact density; anything driven
 * by a finger gets the platform's minimum targets. Read once: the idiom does not change while running.
 */
export const touch = !platform.desktop;
const target = platform.os === "android" ? 48 : 44;

/** Control heights. `control` is a button / input / segmented track; `compact` a small chip; `row` a menu or list row. */
export const size = {
  control: touch ? target : 28,
  compact: touch ? 36 : 24,
  row: touch ? target : 30,
  listRow: touch ? target : 32,
  icon: 16,
  iconSm: 14,
  /** A tab bar glyph and the brand mark's square. */
  iconLg: 20,
  brandMark: 20,
  /** The narrowest a segment of a segmented control gets ("7d" stays a comfortable target). */
  segmentMin: touch ? 40 : 32,
  /** The account button's initial dot. */
  avatar: 28,
  topBar: 46,
  sidebar: 248,
  badge: 18,
  /** A status pill and a label tag: a touch taller than a badge, they carry a dot or a word. */
  pill: 22,
  tag: 20,
  /** A filter chip: the compact height, taller on touch so it stays an easy target. */
  chip: touch ? 32 : 24,
  /** The underline tab strip and its 2pt indicator. */
  tabStrip: touch ? target : 34,
  indicator: 2,
  /** A table's header row. */
  tableHead: 30,
  /** The gutter of an activity timeline: a dot or a 20pt avatar. */
  timelineGutter: 20,
  /** A switch track and the box of a checkbox. */
  switchW: touch ? 44 : 32,
  switchH: touch ? 26 : 18,
  checkbox: touch ? 20 : 16,
  /** A metric tile's sparkline. */
  spark: 28,
  tabBar: touch ? 56 : 46,
} as const;

/** Widths of the app's fixed surfaces. */
export const width = {
  /** A dialog's panel. */
  dialog: 420,
  /** A popover list (the add-filter picker), and its tallest before it scrolls. */
  picker: 240,
  pickerMaxHeight: 360,
  /** A property list's label column, narrower on a phone. */
  propertyLabel: touch ? 96 : 112,
  /** A filter chip's text before it truncates. */
  chipMax: 220,
  /** A breakdown row's value column, so counts line up down the list. */
  valueColumn: 56,
  /** A tooltip's text before it wraps. */
  tooltipMax: 260,
  /** The content column of the wide layout. */
  content: 1200,
} as const;

/** Inner padding of controls, by height class (allsum: 12 on a 28 button, 8 on a 24 one, 10 in a field). */
export const pad = { control: 12, compact: 8, field: 10 } as const;

/**
 * The type scale, in points, with the line height each step always uses (allsum: 11 / 12 / 13 base /
 * 14 tables / 15 / 17 / 20 / 27; UI line-height 1.45). Phones bump the UI steps by 2 so body text is
 * not smaller than the platform's own controls.
 */
const bump = touch ? 2 : 0;
export const type = {
  micro: { fontSize: 11, lineHeight: 15 },
  caption: { fontSize: 12 + (touch ? 1 : 0), lineHeight: 17 + (touch ? 1 : 0) },
  ui: { fontSize: 13 + bump, lineHeight: 19 + bump },
  table: { fontSize: 14 + bump, lineHeight: 20 + bump },
  lead: { fontSize: 15 + bump, lineHeight: 22 + bump },
  title: { fontSize: 17, lineHeight: 24 },
  heading: { fontSize: 20, lineHeight: 26 },
  display: { fontSize: 27, lineHeight: 32 },
} as const;
export type TypeStep = keyof typeof type;

/** Spacing on a 4pt grid. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const;

/** The radius ladder (also the theme's `radius*` tokens, for `rounded-(--radius)` classes). */
export const radius = { sm: 4, control: 6, card: 8, panel: 10, pill: 999 } as const;

/**
 * Motion tokens (NSH Design Guides, "Motion"): one vocabulary for every transition in the app.
 * allsum asks for 120–300ms ease-out with at most one gentle overshoot; the soft settle curve is
 * `cubic-bezier(0.22, 1, 0.36, 1)`. Reduced motion is honored by the `motion-reduce:` classes on each
 * control and by NSH itself for springs, popups, plots and `createMotion`.
 */
export const motion = {
  duration: { instant: 120, fast: 180, base: 240, slow: 360, slower: 500 },
  /** As a `[x1, y1, x2, y2]` for `transitionTimingFunction` styles and plot motion. */
  settleCurve: [0.22, 1, 0.36, 1] as [number, number, number, number],
  settle: Easing.bezier(0.22, 1, 0.36, 1),
  /** What a pressed control scales to. Icon buttons give a little more: they are small. */
  press: { control: 0.97, icon: 0.95, row: 0.99 },
  /** How far a popup slides out of its trigger as it appears. */
  popDistance: 4,
} as const;

/** The settle curve as a style's timing function. */
export const settleTiming = `cubic-bezier(${motion.settleCurve.join(",")})` as `cubic-bezier(${string})`;

/** The press feedback every button shares: a quick scale down that settles back. */
export const pressStyle = (scale: number = motion.press.control): ViewStyle => ({ transform: [{ scale }] });

/** The transition every interactive surface shares: background, border and transform over `fast`. */
export const interactiveTransition: ViewStyle = {
  transitionProperty: "background-color, border-color, opacity, transform",
  transitionDuration: motion.duration.instant,
  transitionTimingFunction: "ease-out",
};

/**
 * allsum's elevation, built from the theme's shadow tokens so dark mode gets its deeper shadow. These
 * are functions: `token()` is reactive, so a style binding that calls them follows the appearance.
 */
export const elevation = {
  /** Menus, popovers, dialogs: `0 6px 20px` plus a near shadow. */
  float: (): ViewStyle => ({ boxShadow: `0 6px 20px ${token("shadow")}, 0 1px 3px ${token("shadow-near")}` }),
  /** The selected segment of a segmented control. */
  raised: (): ViewStyle => ({ boxShadow: `0 1px 2px ${token("shadow-near")}` }),
};

/** The keyboard focus ring (NSH requires a visible one; allsum has none): 2pt of the theme's ring. */
export const focusRing = (): ViewStyle => ({ outlineWidth: 2, outlineColor: token("ring"), outlineOffset: 1 });

/** The window width from which the shell shows the sidebar layout; narrower is the phone layout. */
export const WIDE = 900;
