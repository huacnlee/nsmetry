/**
 * The content area's page stack, as `ui` variants so the shell composes nothing from `nsh/base`:
 *  - `PageStack`: a `NavStack` filling its column on the page color. Pages stay mounted while they
 *    are in the stack, so the list under a detail keeps its scroll position, tab and loads.
 *  - `StackPage`: one page. A `root` page has no header anywhere (the shell's top bar is above it);
 *    a pushed page gets the system header on iOS and Android (title, back button, edge swipe) and
 *    `header` on the desktops and the web.
 *  - `PageHeader`: that desktop / web header: a 46pt bar on a hairline, a ghost "‹ Section" back
 *    button, the record's mono muted meta line, and its actions at the end, all aligned to the
 *    content column (24pt inset and 1200pt wide in the wide layout, 16pt on a narrow one).
 *
 * Motion: push and pop are the stack's native transition (forward on push, backward on pop; at once
 * under reduced motion); the back button washes over `instant` and presses to 0.97.
 */
import type { JSX } from "nsh";
import { platform, View } from "nsh";
import { NavPage, NavStack, type NavStackState } from "nsh/base";
import { Button } from "./button";
import { Txt } from "./text";
import { size, space, width } from "./tokens";

/** iOS and Android head a pushed page with their system header (title, back button, swipe). */
export const systemHeader = platform.os === "ios" || platform.os === "android";

export function PageStack<R>(props: { state: NavStackState<R>; children: (route: R) => JSX.Element; testID?: string }) {
  const render = props.children;
  return (
    <NavStack state={props.state} testID={props.testID} class="flex-1 bg-background">
      {(route) => render(route)}
    </NavStack>
  );
}

export function StackPage(props: {
  /** The system header's title (iOS, Android). */
  title: string;
  /** The stack's first page: no header on any platform. */
  root?: boolean;
  /** The desktop / web header (a `PageHeader`). */
  header?: JSX.Element;
  children?: JSX.Element;
  testID?: string;
}) {
  return (
    <NavPage
      testID={props.testID}
      title={props.title}
      headerVisible={!props.root}
      headerShadowVisible={false}
      header={props.root || systemHeader ? undefined : props.header}
    >
      <View class="flex-1 bg-background">{props.children}</View>
    </NavPage>
  );
}

/** The horizontal inset of the content column, by layout. */
export const pageInset = (wide: boolean) => (wide ? space[6] : space[4]);

export function PageHeader(props: {
  /** Where back goes: the section's name ("Events"). */
  backLabel: string;
  onBack: () => void;
  /** Muted monospace after the back button ("example.com · event · Last 7 days"). */
  meta?: string;
  /** Icon buttons at the end. */
  actions?: JSX.Element;
  /** The wide layout's column (24pt inset) or the narrow one's (16pt). */
  wide: boolean;
  testID?: string;
}) {
  return (
    <View
      testID={props.testID}
      class="items-center border-b border-border bg-background"
      style={{ height: size.topBar, paddingHorizontal: pageInset(props.wide) }}
    >
      <View class="h-full w-full flex-row items-center gap-3" style={{ maxWidth: width.content }}>
        {/* The chevron sits on the content column's edge, not the button's padding. */}
        <View class="justify-center" style={{ marginLeft: -space[2] }}>
          <Button
            variant="ghost"
            size="sm"
            icon="chevronLeft"
            label={props.backLabel}
            accessibilityLabel={`Back to ${props.backLabel}`}
            onPress={props.onBack}
            testID={props.testID ? `${props.testID}-back` : undefined}
          />
        </View>
        <View class="min-w-0 flex-1 justify-center">
          <If when={props.meta}>
            <Txt size="caption" tone="muted" class="font-mono" truncate>{props.meta}</Txt>
          </If>
        </View>
        <If when={props.actions}>
          <View class="flex-row items-center gap-1">{props.actions}</View>
        </If>
      </View>
    </View>
  );
}
