/**
 * Text fields (allsum §3: 28pt, 6pt radius, a 1px input border that takes the ring color on focus).
 * `Field` wraps one with its label above and a hint or error below, which screen readers read with it.
 */
import type { InputStyle } from "nsh";
import { View } from "nsh";
import { Input } from "nsh/base";
import { Txt } from "./text";
import { focusRing, interactiveTransition, pad, size, type } from "./tokens";

export type KeyboardKind = "default" | "email-address" | "url" | "number-pad";

export function TextInput(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  keyboard?: KeyboardKind;
  /** One-time codes and emails: no autocapitalize or autocorrect. */
  plain?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  autoComplete?: "email" | "one-time-code" | "url" | "off";
}) {
  return (
    <Input
      testID={props.testID}
      value={props.value}
      placeholder={props.placeholder}
      accessibilityLabel={props.accessibilityLabel ?? props.placeholder}
      keyboardType={props.keyboard ?? "default"}
      autoCapitalize={props.plain ? "none" : undefined}
      autoCorrect={props.plain ? false : undefined}
      autoFocus={props.autoFocus}
      autoComplete={props.autoComplete}
      readonly={props.disabled}
      returnKeyType={props.onSubmit ? "go" : undefined}
      onChange={(e) => props.onChange(e.value)}
      onSubmit={() => props.onSubmit?.()}
      class={`rounded-(--radius) border bg-background text-foreground placeholder:text-faint focus:border-ring motion-reduce:transition-none ${props.invalid ? "border-bad" : "border-input"} ${props.disabled ? "bg-hover text-muted-foreground" : ""}`}
      focusStyle={focusRing()}
      style={[interactiveTransition as InputStyle, type.ui, { height: size.control, paddingHorizontal: pad.field }]}
    />
  );
}

/** A labelled field: label, control, then a hint or (in its place) the error. */
export function Field(props: {
  label: string;
  hint?: string;
  error?: string | null;
  children?: import("nsh").JSX.Element;
}) {
  return (
    <View class="gap-1.5">
      <Txt size="caption" weight="medium" tone="soft">{props.label}</Txt>
      {props.children}
      <If when={props.error}>
        {(e) => <Txt size="caption" tone="bad" role="alert">{e()}</Txt>}
      </If>
      <If when={!props.error && props.hint}>
        <Txt size="caption" tone="muted">{props.hint}</Txt>
      </If>
    </View>
  );
}

/**
 * A multi-line field (an invite note, a description): the text input's look, `rows` lines tall, Return
 * inserting a line break. It grows no further: longer text scrolls inside it.
 */
export function Textarea(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  invalid?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const lines = () => props.rows ?? 3;
  return (
    <Input
      testID={props.testID}
      multiline
      submitBehavior="newline"
      value={props.value}
      placeholder={props.placeholder}
      accessibilityLabel={props.accessibilityLabel ?? props.placeholder}
      readonly={props.disabled}
      onChange={(e) => props.onChange(e.value)}
      class={`rounded-(--radius) border bg-background text-foreground placeholder:text-faint focus:border-ring motion-reduce:transition-none ${props.invalid ? "border-bad" : "border-input"} ${props.disabled ? "bg-hover text-muted-foreground" : ""}`}
      focusStyle={focusRing()}
      style={[
        interactiveTransition as InputStyle,
        type.ui,
        { height: lines() * type.ui.lineHeight + 2 * pad.compact + 2, paddingHorizontal: pad.field, paddingVertical: pad.compact },
      ]}
    />
  );
}
