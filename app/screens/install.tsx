/**
 * How to measure the current site: a prompt for a coding agent (Claude Code, Codex, Cursor) to paste
 * in the project, one tab per kind of project plus "Not sure", which lets the agent pick. Each prompt
 * carries this instance's address, the site key, the few rules that matter, a docs link and how to verify.
 * Nobody pastes code by hand any more; the agent does the instrumenting.
 *
 * The first tab shown follows the site key: a domain (`example.com`) opens on Website, a bare name
 * (an app) on "Not sure", which covers NSH, JavaScript and every other language.
 */
import type { JSX } from "nsh";
import { Clipboard, createMotion, Scroll, signal, View } from "nsh";
import { instance, isOwner, refreshAccount, api } from "../store";
import { ApiError } from "../api";
import { Button, ButtonRow, CodeBlock, Field, motion, TextInput, toast, Txt, UnderlineTabs } from "../ui";
import { agentPrompt, defaultTrackerSrc, type InstallTarget, looksLikeDomain, type PromptKind } from "./settings/snippets";

export type InstallTab = PromptKind;

const tabs = [
  { value: "any", label: "Not sure", icon: "sparkles" },
  { value: "website", label: "Website", icon: "geography" },
  { value: "nsh", label: "NSH app", icon: "phone" },
  { value: "js", label: "JavaScript", icon: "code" },
  { value: "http", label: "Other (HTTP)", icon: "terminal" },
] as const;

/** The tab a site opens on: see the file comment. */
export const firstInstallTab = (site: string): InstallTab => (looksLikeDomain(site) ? "website" : "any");

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

// ------------------------------------------------------------------------------------- the prompt

const intro: Record<InstallTab, string> = {
  any: "Not sure what the project is? This prompt lets the agent look and pick: an NSH app, JavaScript, a website, or anything else over HTTP.",
  website: "For a website: the agent adds the tracker script to every page. It counts page views by itself, with no cookies.",
  js: "For a JavaScript or TypeScript app (browser, Node, Electron, React Native, Workers): the agent installs the nsmetry package and tracks screens and events.",
  nsh: "For an NSH app: the agent adds the nsmetry nshm, wires it in the root component and tracks screens and events.",
  http: "For anything else (Swift, Kotlin, Go, Python, Rust…): the agent writes a small queue that sends batches to the HTTP API.",
};

/**
 * A tab's body: what the prompt is for, Copy, then the prompt itself. Paste it into Claude Code,
 * Codex or Cursor in the project to measure: it carries this instance, the site key and the rules.
 */
function PromptTab(props: { kind: InstallTab; target: InstallTarget }) {
  const prompt = () => agentPrompt(props.target, props.kind);
  const copy = async () => {
    const r = await Clipboard.writeText(prompt()).catch(() => "failed" as const);
    if (r === "failed") toast("Couldn't copy the prompt", { tone: "error" });
    else toast("Prompt copied", { body: "Paste it into Claude Code, Codex or Cursor in the project to measure.", tone: "ok" });
  };
  return (
    <TabBody testID={`install-${props.kind}`}>
      <View class="gap-3">
        <Txt tone="muted">{intro[props.kind]}</Txt>
        <ButtonRow>
          <Button label="Copy prompt" icon="copy" variant="primary" onPress={() => void copy()} testID={`copy-prompt-${props.kind}`} />
        </ButtonRow>
      </View>
      <CodeBlock code={prompt()} label="prompt" testID={`prompt-${props.kind}`} />
      <If when={props.kind === "website" && isOwner()}>
        <ScriptUrl server={props.target.server} />
      </If>
    </TabBody>
  );
}

// ------------------------------------------------------------------------------------- panel

/** The tabs and the current tab's body. `target` is read where used, so a site switch updates every block. */
export function InstallTabs(props: { target: InstallTarget; initial: InstallTab }) {
  const tab = signal<InstallTab>(props.initial);
  const body = (t: InstallTab) => <PromptTab kind={t} target={props.target} />;
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
