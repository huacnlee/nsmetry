/**
 * Sign in with an emailed code (docs/api.md, "Authentication"): server (native only) → email →
 * "Send code" → code → signed in. Every refusal the contract names gets its own plain message:
 *   403  the email was not invited             → ask the owner for an invite
 *   429  rate-limited                          → the server's own wording (it says how long)
 *   delivery "log"                             → no mail is configured: the code is in the Worker logs
 *   status 0                                   → the server could not be reached
 *
 * The code goes into one cell per digit (`CodeInput`, NSH's `OtpInput`) and is sent as soon as the
 * last cell fills. A server older than 0.1.2 sends letters too and says nothing about `codeDigits`, so
 * its code goes into a plain text field.
 *
 * Motion: the code step slides in from the right and fades (base, soft settle) as the email step
 * leaves; errors fade in; under reduced motion both swap at once.
 */
import { createMotion, signal, View } from "nsh";
import { ApiError } from "./api";
import { openProjectLink, projectLinks } from "./shell/controls";
import { Brand } from "./shell/sidebar";
import { currentServer, enterDemo, requestCode, serverIsFixed, setServer, signOutReason, verifyCode } from "./store";
import { Button, Card, CodeInput, Field, Heading, motion, TextInput, Txt } from "./ui";

export function explainStartError(e: unknown): string {
  if (!(e instanceof ApiError)) return String(e);
  if (e.status === 403) return "This email has not been invited to this NsMetry. Ask its owner to invite you from Team.";
  if (e.status === 429) return e.message;
  if (e.status === 502) return "The server could not send the email. Try again, or ask the owner to check the mail settings.";
  if (e.status === 503) return "This server is not set up yet: its owner has to set ADMIN_EMAIL.";
  if (e.status === 0) return e.message;
  return e.message;
}

export function SignIn() {
  const step = signal<"email" | "code">("email");
  const serverText = signal(currentServer());
  const email = signal("");
  const code = signal("");
  /** The code's length when it is digits only (the server says so); `null` for an older server's code. */
  const digits = signal<number | null>(null);
  const error = signal<string | null>(null);
  const notice = signal<string | null>(null);
  const busy = signal(false);

  const send = async () => {
    if (!serverIsFixed()) setServer(serverText());
    if (!email().includes("@")) return error.set("Enter the email address you were invited with.");
    busy.set(true);
    error.set(null);
    notice.set(null);
    try {
      const res = await requestCode(email());
      digits.set(res.codeDigits ?? null);
      code.set("");
      notice.set(
        res.delivery === "log"
          ? `No mail is configured on this server: the code is in your Worker logs. ${res.message ?? "Read it with `wrangler tail`."}`
          : `We sent a sign-in code to ${email().trim()}. It is valid for 10 minutes.`,
      );
      step.set("code");
    } catch (e) {
      error.set(explainStartError(e));
    } finally {
      busy.set(false);
    }
  };

  const verify = async () => {
    if (busy()) return;
    const n = digits();
    if (!code().trim() || (n !== null && code().length < n)) return error.set("Enter the code from the email.");
    busy.set(true);
    error.set(null);
    try {
      await verifyCode(email(), code());
    } catch (e) {
      error.set(e instanceof ApiError ? e.message : String(e));
      // Full cells would take eight Backspaces before a retry: start the code over instead.
      if (digits() !== null) code.set("");
      busy.set(false);
    }
  };

  // The demo runs on this device with made-up data (app/demo.ts); typing "demo" as the server does the same.
  const demo = async () => {
    busy.set(true);
    error.set(null);
    try {
      await enterDemo();
    } catch (e) {
      error.set(e instanceof ApiError ? e.message : String(e));
      busy.set(false);
    }
  };

  return (
    <View class="flex-1 items-center justify-center bg-sidebar px-4">
      <View class="w-full gap-5" style={{ maxWidth: 380 }}>
        <View class="items-center"><Brand /></View>
        <Card class="gap-4 p-6 bg-background">
          <View class="gap-1">
            <Heading size="title">Sign in</Heading>
            <Txt tone="muted">No passwords: we email you a one-time code.</Txt>
          </View>
          <If when={signOutReason() && step() === "email"}>
            <Txt size="caption" tone="warn" role="alert">{signOutReason()}</Txt>
          </If>
          <If when={step() === "email"}>
            <View class="gap-4">
              <If when={!serverIsFixed()}>
                <Field label="Server" hint="The address of your NsMetry instance.">
                  <TextInput testID="server" value={serverText()} onChange={(v) => serverText.set(v)} placeholder="stats.example.com" keyboard="url" plain autoComplete="url" />
                </Field>
              </If>
              <Field label="Email" error={error()}>
                <TextInput testID="email" value={email()} onChange={(v) => email.set(v)} onSubmit={() => void send()} placeholder="you@example.com" keyboard="email-address" plain autoComplete="email" invalid={!!error()} />
              </Field>
              <Button testID="send-code" label="Send code" variant="primary" block busy={busy()} onPress={() => void send()} />
              <Button testID="try-demo" label="Try the demo" variant="ghost" block disabled={busy()} onPress={() => void demo()} />
            </View>
          </If>
          <If when={step() === "code"}>
            <CodeStep
              notice={notice()}
              digits={digits()}
              code={code()}
              onCode={(v) => code.set(v)}
              error={error()}
              busy={busy()}
              onVerify={() => void verify()}
              onBack={() => {
                step.set("email");
                code.set("");
                error.set(null);
              }}
              onResend={() => void send()}
            />
          </If>
        </Card>
        <View class="flex-row justify-center gap-1">
          <Each of={projectLinks}>
            {(l) => <Button testID={`signin-${l().id}`} label={l().label} icon={l().icon} variant="ghost" size="sm" onPress={() => openProjectLink(l().url)} />}
          </Each>
        </View>
      </View>
    </View>
  );
}

function CodeStep(props: {
  notice: string | null;
  digits: number | null;
  code: string;
  onCode: (v: string) => void;
  error: string | null;
  busy: boolean;
  onVerify: () => void;
  onBack: () => void;
  onResend: () => void;
}) {
  const m = createMotion({ enter: { duration: motion.duration.base, easing: motion.settle, keyframes: { opacity: [0, 1], translateX: [16, 0] } } });
  return (
    <View class="gap-4" style={m.style}>
      <If when={props.notice}>
        {/* Selectable: when the code went to the logs, people copy the command from here. */}
        <View class="rounded-(--radius) bg-brand-soft px-3 py-2" selectable>
          <Txt size="caption" tone="soft" testID="code-notice">{props.notice}</Txt>
        </View>
      </If>
      <Field label="Code" error={props.error}>
        <If
          when={props.digits}
          fallback={<TextInput testID="code" value={props.code} onChange={props.onCode} onSubmit={props.onVerify} placeholder="ABCD-EFGH" keyboard="default" plain autoComplete="one-time-code" autoFocus invalid={!!props.error} />}
        >
          {(n) => <CodeInput testID="code" length={n()} value={props.code} onChange={props.onCode} onComplete={props.onVerify} invalid={!!props.error} autoFocus />}
        </If>
      </Field>
      <Button testID="verify" label="Sign in" variant="primary" block busy={props.busy} onPress={props.onVerify} />
      <View class="flex-row justify-between">
        <Button label="Use another email" variant="ghost" size="sm" onPress={props.onBack} />
        <Button label="Send a new code" variant="ghost" size="sm" onPress={props.onResend} />
      </View>
    </View>
  );
}
