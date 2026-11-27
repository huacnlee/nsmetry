/**
 * Modal surfaces and toasts.
 *  - `Modal`: a centered dialog on desktop and web, the platform's sheet presentation on phones
 *    (`nsh/base` Dialog). Title, body, actions at the end; Escape and the backdrop close it.
 *  - `BottomSheet`: a panel from the bottom edge (phones' navigation, filters).
 *  (A record's details are not an overlay: they are a page pushed on the content area's stack,
 *  `./stack.tsx`.)
 *  - `ConfirmDialog`: a question before something that cannot be undone, the action named.
 *  - Toasts: `toast(...)` from anywhere, `<ToastHost />` once at the root. They come in from below
 *    over `fast` on the soft curve, leave over `instant`, swipe away, and go by themselves after 4s.
 */
import type { JSX } from "nsh";
import { Overlay, safeAreaInsets, signal, View } from "nsh";
import { Dialog, Sheet, Toast, ToastStack } from "nsh/base";
import { Button, ButtonRow } from "./button";
import { Glyph } from "./icons";
import { Heading, Txt } from "./text";
import { elevation, motion, settleTiming, size, touch, width } from "./tokens";

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** "alertdialog" for a confirmation of something destructive. */
  role?: "dialog" | "alertdialog";
  children?: JSX.Element;
  actions?: JSX.Element;
  testID?: string;
}) {
  // Phones: a form (anything but a confirmation) comes up from the bottom edge, in thumb reach; the
  // sheet rides on the software keyboard, so a field and its actions stay above it.
  if (touch && props.role !== "alertdialog") {
    return (
      <Sheet
        open={props.open}
        side="bottom"
        closeOnSwipe
        grabber
        grabberClass="self-center my-2 h-1 w-9 rounded-(--radius-pill) bg-border-strong"
        accessibilityLabel={props.title}
        onOpenChange={(e) => !e.open && props.onClose()}
        backdropClass="bg-scrim"
        popupClass="rounded-t-(--radius-panel) bg-popover px-5 pb-[calc(env(safe-area-inset-bottom)+16px)]"
      >
        <View class="gap-4" testID={props.testID}>
          <View class="gap-1">
            <Heading size="title">{props.title}</Heading>
            <If when={props.description}><Txt tone="muted">{props.description}</Txt></If>
          </View>
          {props.children}
          <If when={props.actions}><View class="flex-col-reverse gap-2">{props.actions}</View></If>
        </View>
      </Sheet>
    );
  }
  return (
    <Dialog
      testID={props.testID}
      open={props.open}
      animation="fade"
      role={props.role ?? "dialog"}
      accessibilityLabel={props.title}
      accessibilityDescription={props.description}
      closeOnEscape
      closeOnBackdropPress
      onOpenChange={(e) => !e.open && props.onClose()}
      backdropClass="bg-scrim"
      class="self-center rounded-(--radius-panel) border border-border bg-popover p-5 gap-4"
      style={[{ width: touch ? "92%" : width.dialog, maxWidth: width.dialog + 100, marginTop: "18%" }, elevation.float()]}
    >
      <View class="gap-1">
        <Heading size="title">{props.title}</Heading>
        <If when={props.description}><Txt tone="muted">{props.description}</Txt></If>
      </View>
      {props.children}
      <If when={props.actions}><ButtonRow align="end">{props.actions}</ButtonRow></If>
    </Dialog>
  );
}

export function BottomSheet(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: JSX.Element;
  testID?: string;
}) {
  return (
    <Sheet
      open={props.open}
      side="bottom"
      closeOnSwipe
      grabber
      grabberClass="self-center my-2 h-1 w-9 rounded-(--radius-pill) bg-border-strong"
      accessibilityLabel={props.title}
      onOpenChange={(e) => !e.open && props.onClose()}
      backdropClass="bg-scrim"
      popupClass="rounded-t-(--radius-panel) bg-popover px-2 pb-[calc(env(safe-area-inset-bottom)+8px)]"
    >
      <View class="px-3 pb-2" testID={props.testID}>
        <Heading size="title">{props.title}</Heading>
      </View>
      {props.children}
    </Sheet>
  );
}

/**
 * Ask before something that cannot be undone. The confirm button names the action ("Remove
 * person"), never "OK"; `danger` colors it. Cancel is the default focus.
 */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
}) {
  return (
    <Modal
      testID={props.testID}
      open={props.open}
      onClose={props.onCancel}
      role="alertdialog"
      title={props.title}
      description={props.body}
      actions={
        <>
          <Button label="Cancel" variant="ghost" onPress={props.onCancel} />
          <Button
            label={props.confirmLabel}
            variant={props.danger ? "danger" : "primary"}
            busy={props.busy}
            onPress={props.onConfirm}
            testID={props.testID ? `${props.testID}-confirm` : undefined}
          />
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------------------- toasts

export type ToastTone = "info" | "ok" | "error";
interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
  status: "starting" | "present" | "ending";
}

const toasts = signal<ToastItem[]>([]);
let nextId = 1;

function dismiss(id: number) {
  toasts.set(toasts().map((t) => (t.id === id ? { ...t, status: "ending" } : t)));
  // Keep it mounted for its exit transition, then drop it.
  setTimeout(() => toasts.set(toasts().filter((t) => t.id !== id)), motion.duration.fast);
}

/** Show a short notice. Errors stay twice as long: they are the ones people need to read. */
export function toast(title: string, options: { body?: string; tone?: ToastTone } = {}) {
  const id = nextId++;
  const tone = options.tone ?? "info";
  toasts.set([...toasts().slice(-2), { id, title, body: options.body, tone, status: "present" }]);
  setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4000);
}

/** The current toasts, for tests and the gallery. */
export const currentToasts = () => toasts();

export function ToastHost() {
  // On a phone toasts sit above the tab bar and the home indicator, not over them.
  const insets = safeAreaInsets();
  return (
    <Overlay style={{ position: "absolute", left: 0, right: 0, bottom: touch ? size.tabBar + insets().bottom + 12 : 20, alignItems: "center" }}>
      <ToastStack placement="bottomCenter" onCancel={() => { const last = toasts().at(-1); if (last) dismiss(last.id); }} style={{ width: touch ? "92%" : 360, maxWidth: 420 }}>
        <Each of={toasts()} key={(t) => t.id}>
          {(t) => (
            <Toast
              transitionStatus={t().status}
              accessibilityLabel={t().body ? `${t().title}. ${t().body}` : t().title}
              swipeDirection="down"
              onDismissRequest={() => dismiss(t().id)}
              class="flex-row items-start gap-2 rounded-(--radius-card) border border-border bg-popover px-3 py-2.5 motion-reduce:transition-none"
              startingClass="opacity-0 translate-y-2"
              endingClass="opacity-0 scale-95"
              // Enters over `fast` on the settle curve, leaves over `instant` (the motion tokens).
              style={[elevation.float(), { transitionProperty: "opacity, transform", transitionDuration: t().status === "ending" ? motion.duration.instant : motion.duration.fast, transitionTimingFunction: settleTiming }]}
            >
              <Glyph name={t().tone === "error" ? "error" : t().tone === "ok" ? "ok" : "info"} size={size.icon} tone={t().tone === "error" ? "bad" : t().tone === "ok" ? "ok" : "muted"} />
              <View class="min-w-0 flex-1 gap-0.5">
                <Txt weight="medium">{t().title}</Txt>
                <If when={t().body}><Txt size="caption" tone="muted">{t().body}</Txt></If>
              </View>
            </Toast>
          )}
        </Each>
      </ToastStack>
    </Overlay>
  );
}
