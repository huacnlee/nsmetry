/**
 * Every screen's frame: its title (a header for screen readers), a one-line description, optional
 * actions at the end, then its content in a column with allsum's 16pt rhythm. The content fades up
 * 6pt over `base` when the screen is shown, so switching sections reads as a change of place.
 */
import type { JSX } from "nsh";
import { createMotion, View } from "nsh";
import { Heading, motion, Txt } from "../ui";

export function ScreenFrame(props: {
  title: string;
  description?: string;
  actions?: JSX.Element;
  children?: JSX.Element;
  testID?: string;
}) {
  const m = createMotion({ enter: { duration: motion.duration.base, easing: motion.settle, keyframes: { opacity: [0, 1], translateY: [6, 0] } } });
  return (
    <View testID={props.testID} class="gap-4" style={m.style}>
      <View class="flex-row items-end gap-3">
        <View class="flex-1 gap-0.5">
          <Heading size="heading">{props.title}</Heading>
          <If when={props.description}><Txt tone="muted">{props.description}</Txt></If>
        </View>
        {props.actions}
      </View>
      {props.children}
    </View>
  );
}

/** What a screen shows until its agent fills it in. */
export function Placeholder(props: { what: string }) {
  return (
    <View class="rounded-(--radius-card) border border-dashed border-border-strong px-4 py-10 items-center">
      <Txt tone="faint" align="center">{props.what}</Txt>
    </View>
  );
}
