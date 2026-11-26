/**
 * How to send events to this instance from the current site's code, one tab per kind of client:
 * a website's script tag, the raw HTTP API, the NSH nshm, the npm package, and a prompt for a coding
 * agent that does the instrumenting itself. Every block is prefilled with this instance's address and
 * the site key, and copies with one press.
 *
 * The first tab shown follows the site key: a domain (`example.com`) opens on Website, a bare name
 * (`disktree`) on NSH app, since that is what a bare name almost always is in this fleet.
 */
import type { JSX } from "nsh";
import { Clipboard, createMotion, Scroll, signal, View } from "nsh";
import { instance, isOwner, refreshAccount, api } from "../store";
import { ApiError } from "../api";
import { Button, ButtonRow, CodeBlock, Field, Glyph, InlineCode, motion, TextInput, toast, Txt, UnderlineTabs, size } from "../ui";
import {
  agentPrompt, curlBatch, curlEvent, defaultTrackerSrc, httpRules, ignoreSnippet, type InstallTarget, jsUsage,
  looksLikeDomain, npmInstall, nshAdd, nshUsage, websiteSnippet,
} from "./settings/snippets";

export type InstallTab = "website" | "http" | "nsh" | "js" | "agent";

const tabs = [
  { value: "website", label: "Website", icon: "geography" },
  { value: "http", label: "HTTP API", icon: "terminal" },
  { value: "nsh", label: "NSH app", icon: "phone" },
  { value: "js", label: "JavaScript", icon: "code" },
  { value: "agent", label: "AI agent", icon: "sparkles" },
] as const;

/** The tab a site opens on: see the file comment. */
export const firstInstallTab = (site: string): InstallTab => (looksLikeDomain(site) ? "website" : "nsh");

/** A titled step inside a tab: a short semibold heading, an optional muted line, then its content. */
function Step(props: { title: string; body?: string; children?: JSX.Element }) {
  return (
    <View class="gap-2">
      <View class="gap-0.5">
        <Txt weight="semibold">{props.title}</Txt>
        <If when={props.body}><Txt tone="muted">{props.body}</Txt></If>
      </View>
      {props.children}
    </View>
  );
}

/** A tab's body: it fades up 4pt over `fast` when the tab is chosen, so the swap reads as one place changing. */
function TabBody(props: { testID: string; children?: JSX.Element }) {
  const m = createMotion({ enter: { duration: motion.duration.fast, easing: motion.settle, keyframes: { opacity: [0, 1], translateY: [motion.popDistance, 0] } } });
  return <View testID={props.testID} class="gap-5 pt-4" style={m.style}>{props.children}</View>;
}

// ------------------------------------------------------------------------------------- website

/**
 * The script URL override (admin): for a renamed `em.js` or a tracker served from another hostname
 * than the app. Viewers see the snippet the admin chose and cannot change what everyone installs.
 */
function ScriptUrl(props: { server: string }) {
  const draft = signal(instance()?.trackerUrl ?? "");
  const busy = signal(false);
  const error = signal<string | null>(null);
  const save = async () => {
    if (busy()) return;
    busy.set(true);
    error.set(null);
    try {
      const { trackerUrl } = await api.setTrackerUrl(draft().trim());
      draft.set(trackerUrl);
      await refreshAccount();
      toast(trackerUrl ? "Snippet updated" : "Snippet uses this instance again");
    } catch (e) {
      error.set(e instanceof ApiError ? e.message : "Couldn't save the script URL.");
    } finally {
      busy.set(false);
    }
  };
  return (
    <Field
      label="Script URL"
      hint={`Set it if you renamed em.js or serve it from another host. Empty: ${defaultTrackerSrc(props.server)}`}
      error={error()}
    >
      <View class="flex-row items-center gap-2">
        <View class="flex-1">
          <TextInput
            testID="tracker-url"
            value={draft()}
            onChange={(v) => { draft.set(v); error.set(null); }}
            onSubmit={() => void save()}
            placeholder={defaultTrackerSrc(props.server)}
            keyboard="url"
            plain
            invalid={!!error()}
            autoComplete="url"
            accessibilityLabel="Script URL"
          />
        </View>
        <Button label="Save" busy={busy()} disabled={draft().trim() === (instance()?.trackerUrl ?? "")} onPress={() => void save()} testID="tracker-url-save" />
      </View>
    </Field>
  );
}

function WebsiteTab(props: { target: InstallTarget }) {
  return (
    <TabBody testID="install-website">
      <Step title="Add the script" body={`Paste it into the <head> of every page of ${props.target.site}. It counts page views by itself: no cookies, nothing stored about visitors.`}>
        <CodeBlock code={websiteSnippet(props.target)} label="snippet" testID="snippet-website" />
      </Step>
      <If when={isOwner()}>
        <ScriptUrl server={props.target.server} />
      </If>
      <Step title="Ignore your own visits" body={`Run it once in the browser console on ${props.target.site}: the script then skips that browser.`}>
        <CodeBlock code={ignoreSnippet} label="one-liner" testID="snippet-ignore" />
      </Step>
    </TabBody>
  );
}

// ------------------------------------------------------------------------------------- HTTP API

function HttpTab(props: { target: InstallTarget }) {
  return (
    <TabBody testID="install-http">
      <Step title="One event" body="For a script, a server or a test. Any HTTP client works; text/plain spares browsers a preflight request.">
        <CodeBlock code={curlEvent(props.target)} label="request" testID="snippet-curl-event" />
      </Step>
      <Step title="A batch" body="What an app should send: its queue, up to 50 events, in one request.">
        <CodeBlock code={curlBatch(props.target)} label="request" testID="snippet-curl-batch" />
      </Step>
      <Step title="Rules">
        <View class="gap-1.5">
          <Each of={httpRules}>
            {(rule) => (
              <View class="flex-row items-start gap-2">
                <View class="pt-0.5"><Glyph name="check" size={size.iconSm} tone="muted" /></View>
                <View class="flex-1"><Txt tone="soft">{rule()}</Txt></View>
              </View>
            )}
          </Each>
        </View>
      </Step>
    </TabBody>
  );
}

// ------------------------------------------------------------------------------------- NSH, JavaScript

function NshTab(props: { target: InstallTarget }) {
  return (
    <TabBody testID="install-nsh">
      <Step title="Add the nshm" body="From the app's folder (the one with nsh.json).">
        <CodeBlock code={nshAdd} label="command" testID="snippet-nsh-add" />
      </Step>
      <Step title="Use it" body="Create one client, wire it in the root component, and track what matters anywhere.">
        <CodeBlock code={nshUsage(props.target)} label="code" testID="snippet-nsh-usage" />
      </Step>
      <View class="flex-row flex-wrap items-center gap-1">
        <Txt tone="muted">The version comes from nsh.json and the install id lives in Storage. With a NavStack, pass</Txt>
        <InlineCode>{"navStackPath(nav, (r) => `/${r.name}`)"}</InlineCode>
        <Txt tone="muted">as the path. Keep ids out of paths: each distinct path is a row.</Txt>
      </View>
    </TabBody>
  );
}

function JsTab(props: { target: InstallTarget }) {
  return (
    <TabBody testID="install-js">
      <Step title="Install" body="Browsers, Node, Bun, Deno, Electron, React Native and Workers; no dependencies.">
        <CodeBlock code={npmInstall} label="command" testID="snippet-npm" />
      </Step>
      <Step title="Use it">
        <CodeBlock code={jsUsage(props.target)} label="code" testID="snippet-js-usage" />
      </Step>
      <Txt tone="muted">It sends up to 50 events per request every 30 s, and when the page is hidden or the process exits. On React Native, pass AsyncStorage as storage and flush when the app leaves the foreground.</Txt>
    </TabBody>
  );
}

// ------------------------------------------------------------------------------------- AI agent

function AgentTab(props: { target: InstallTarget }) {
  const copy = async () => {
    const r = await Clipboard.writeText(agentPrompt(props.target)).catch(() => "failed" as const);
    if (r === "failed") toast("Couldn't copy the prompt", { tone: "error" });
    else toast("Prompt copied", { body: "Paste it into Claude Code, Codex or Cursor in the project to measure.", tone: "ok" });
  };
  return (
    <TabBody testID="install-agent">
      <View class="gap-3">
        <Txt tone="muted">
          A prompt for a coding agent (Claude Code, Codex, Cursor) working in the project you want to measure. It carries this
          instance's address, the site key, the batching and privacy rules, and how to check the result.
        </Txt>
        <ButtonRow>
          <Button label="Copy prompt" icon="copy" variant="primary" onPress={() => void copy()} testID="copy-agent-prompt" />
        </ButtonRow>
      </View>
      <CodeBlock code={agentPrompt(props.target)} label="prompt" testID="snippet-agent" />
    </TabBody>
  );
}

// ------------------------------------------------------------------------------------- panel

/** The tabs and the current tab's body. `target` is read where used, so a site switch updates every block. */
export function InstallTabs(props: { target: InstallTarget; initial: InstallTab }) {
  const tab = signal<InstallTab>(props.initial);
  const body = (t: InstallTab) => {
    switch (t) {
      case "website": return <WebsiteTab target={props.target} />;
      case "http": return <HttpTab target={props.target} />;
      case "nsh": return <NshTab target={props.target} />;
      case "js": return <JsTab target={props.target} />;
      case "agent": return <AgentTab target={props.target} />;
    }
  };
  return (
    <View>
      {/* Five tabs overflow a phone's width: the strip scrolls sideways rather than wrapping. */}
      <Scroll horizontal scrollbar={false}>
        <UnderlineTabs testID="install-tabs" accessibilityLabel="Install with" options={tabs} value={tab()} onChange={(v) => tab.set(v)} />
      </Scroll>
      {/* Rebuilt per tab (a call in JSX re-runs when `tab` changes), so each body enters with its motion. */}
      {body(tab())}
    </View>
  );
}
