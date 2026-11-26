/**
 * Text in the app's type scale. Screens never set a font size: they pick a step (`size`) and a tone,
 * and this maps them to allsum's scale (tokens.ts) and the theme's text roles.
 */
import type { JSX, TextStyle } from "nsh";
import { Text } from "nsh";
import { type, type TypeStep } from "./tokens";

/** The text roles of the theme: allsum's text / text-soft / text-muted / text-faint, plus states. */
export type Tone = "default" | "soft" | "muted" | "faint" | "brand" | "link" | "ok" | "warn" | "bad" | "on-primary";

const toneClass: Record<Tone, string> = {
  default: "text-foreground",
  soft: "text-soft",
  muted: "text-muted-foreground",
  faint: "text-faint",
  brand: "text-brand",
  link: "text-link",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  "on-primary": "text-primary-foreground",
};

const weightClass = { regular: "font-normal", medium: "font-medium", semibold: "font-semibold" } as const;

export function Txt(props: {
  size?: TypeStep;
  tone?: Tone;
  weight?: keyof typeof weightClass;
  /** Numbers in a column line up (counts, percentages, times). */
  numeric?: boolean;
  /** One line, truncated with an ellipsis. */
  truncate?: boolean;
  align?: "left" | "center" | "right";
  class?: string;
  style?: TextStyle;
  testID?: string;
  accessibilityLabel?: string;
  role?: "header" | "text" | "alert";
  children?: JSX.Element;
}) {
  return (
    <Text
      testID={props.testID}
      role={props.role}
      accessibilityLabel={props.accessibilityLabel}
      class={`${toneClass[props.tone ?? "default"]} ${weightClass[props.weight ?? "regular"]} ${props.class ?? ""}`}
      style={[
        type[props.size ?? "ui"],
        props.numeric ? { fontVariant: ["tabular-nums"] } : null,
        props.truncate ? { numberOfLines: 1 } : null,
        props.align ? { textAlign: props.align } : null,
        props.style ?? null,
      ]}
    >
      {props.children}
    </Text>
  );
}

/** A heading: weight 600, as allsum sets every heading. */
export function Heading(props: { size?: "title" | "heading" | "display" | "lead"; children?: JSX.Element; testID?: string }) {
  return (
    <Txt size={props.size ?? "heading"} weight="semibold" role="header" testID={props.testID}>
      {props.children}
    </Txt>
  );
}
