/**
 * Segmented control (allsum §3: a 28pt track of the hover wash with 2pt of padding; the selected
 * segment is an elevated pill with a small shadow, and a 1px border in dark mode where a shadow does
 * not read). Built on `nsh/base` Tabs, so arrows / Home / End move between segments and screen readers
 * hear a tab list. The pill is the Tabs' indicator: the core springs it to the next segment natively
 * (and moves it at once under reduced motion), so the slide costs no JS.
 */
import { platform, View } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { Txt } from "./text";
import { elevation, focusRing, interactiveTransition, pad, size } from "./tokens";

/** The track's padding around the segments (allsum: 2pt). */
const segmentInset = 2;

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** What screen readers say when the label is an abbreviation ("7d" → "Last 7 days"). */
  description?: string;
}

export function Segmented<T extends string>(props: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
  /**
   * `fit` (the default): each segment is as wide as its label, so a label never truncates.
   * `stretch`: the track spans its row and the segments share the extra room (never less than
   * their labels: a row too narrow for them is the layout's problem, not a reason to cut "Today").
   */
  layout?: "fit" | "stretch";
  testID?: string;
}) {
  const stretch = () => props.layout === "stretch";
  return (
    <View class={`rounded-(--radius) bg-hover ${stretch() ? "self-stretch" : "self-start"}`} style={{ height: size.control, padding: segmentInset }}>
      <Tabs
        testID={props.testID}
        orientation="horizontal"
        accessibilityLabel={props.accessibilityLabel}
        class="flex-1 flex-row"
        indicatorClass="inset-y-0 rounded-(--radius-sm) bg-elevated dark:border dark:border-border-strong"
        indicatorStyle={elevation.raised()}
      >
        <Each of={props.options}>
          {(o) => (
            <Tab
              testID={props.testID ? `${props.testID}-${o().value}` : undefined}
              selected={props.value === o().value}
              accessibilityLabel={o().description ?? o().label}
              onPress={() => {
                if (o().value !== props.value) props.onChange(o().value);
              }}
              focusVisibleStyle={focusRing()}
              // An unselected segment washes on hover, as allsum's segments do; the pill slides over it.
              // Segments never shrink below their label; `stretch` lets them grow from it.
              class={`shrink-0 items-center justify-center rounded-(--radius-sm) motion-reduce:transition-none ${props.value === o().value ? "" : "hover:bg-hover"} ${stretch() ? "grow" : ""}`}
              style={[interactiveTransition, { paddingHorizontal: pad.compact, minWidth: size.segmentMin }]}
            >
              <Txt size="caption" weight="medium" tone={props.value === o().value ? "default" : "muted"}>
                {o().label}
              </Txt>
            </Tab>
          )}
        </Each>
      </Tabs>
    </View>
  );
}

/** Desktop and web read the short labels with a pointer; nothing platform-specific beyond `touch`. */
export const compactLabels = platform.desktop;
