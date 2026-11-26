/**
 * Settings for the current site: whether it is receiving events, how to install it (website, HTTP
 * API, NSH app, JavaScript, an AI agent prompt), this instance's address and version, and removing
 * the site (admin). Account-wide things live elsewhere: people under Team, agents under Agents.
 *
 * The page is per site, so its title is the site key itself, with a soft status pill beside it
 * (Linear's project header): "Live" when the site sent a page view or an event in the last seven
 * days. That check is one small breakdown request (limit 1), not a summary: it is all this needs.
 */
import { computed, openUrl, resource, signal, untracked, View } from "nsh";
import { ApiError } from "../api";
import {
  api, currentServer, currentSite, currentUser, instance, isOwner, refreshAccount,
} from "../store";
import {
  Button, ConfirmDialog, EmptyState, Panel, PropertyList, StatusPill, Tag, toast, Txt,
} from "../ui";
import { firstInstallTab, InstallTabs } from "./install";
import { ScreenFrame } from "./frame";
import { defaultTrackerSrc, type InstallTarget } from "./settings/snippets";

/** "Live" or "No events in 7 days", from the last week's top page and top event. */
function SiteStatus(props: { siteId: number }) {
  const recent = resource(
    () => props.siteId,
    (site) => api.breakdown({ site, range: "7d" }, ["path", "event"], 1),
  );
  const live = () => {
    const b = recent()?.breakdowns;
    return !!b && ((b.path?.length ?? 0) > 0 || (b.event?.length ?? 0) > 0);
  };
  return (
    <If when={recent()} else={<If when={!recent.error()}><StatusPill label="Checking" testID="site-status" /></If>}>
      <If when={live()} else={<StatusPill label="No events in 7 days" tone="neutral" testID="site-status" />}>
        <StatusPill label="Live" tone="ok" pulse testID="site-status" />
      </If>
    </If>
  );
}

/** The instance: where it is, which version, who is signed in, and whether an update is out. */
function InstancePanel() {
  const update = () => instance()?.update ?? null;
  return (
    <Panel title="This instance" testID="instance-panel">
      <PropertyList
        items={[
          { label: "Server", value: currentServer() || "–", mono: true },
          { label: "Version", value: instance()?.version ?? "–", mono: true },
          {
            label: "Signed in as",
            value: (
              <View class="min-w-0 flex-row items-center gap-2">
                <View class="min-w-0 shrink"><Txt truncate>{currentUser()?.email ?? "–"}</Txt></View>
                <Tag label={isOwner() ? "Admin" : "Viewer"} tone={isOwner() ? "brand" : "neutral"} />
              </View>
            ),
          },
          {
            label: "Updates",
            value: (
              <If when={update()} else={<Txt tone="muted">Not checked</Txt>}>
                {(u) => (
                  <View class="flex-row flex-wrap items-center gap-2">
                    <If when={u().behind} else={<StatusPill label="Up to date" tone="ok" />}>
                      <StatusPill label={`${u().latest} is out`} tone="warn" testID="update-available" />
                      <Button size="sm" variant="ghost" label="Release notes" trailing="external" onPress={() => void openUrl(u().url).catch(() => undefined)} />
                    </If>
                  </View>
                )}
              </If>
            ),
          },
        ]}
      />
    </Panel>
  );
}

/** Admin: stop tracking this site. The dialog names the site; collected numbers are kept. */
function RemoveSite(props: { id: number; domain: string }) {
  const open = signal(false);
  const busy = signal(false);
  const remove = async () => {
    busy.set(true);
    try {
      await api.deleteSite(props.id);
      open.set(false);
      toast(`Removed ${props.domain}`, { tone: "ok" });
      // The store re-reads the site list and moves to the next site (or none).
      await refreshAccount();
    } catch (e) {
      toast("Couldn't remove the site", { body: e instanceof ApiError ? e.message : undefined, tone: "error" });
    } finally {
      busy.set(false);
    }
  };
  return (
    <Panel
      title="Remove site"
      note="Stops accepting events for it and drops it from the switcher. Numbers already collected are kept."
      actions={<Button label="Remove site…" variant="danger" icon="trash" onPress={() => open.set(true)} testID="remove-site" />}
      testID="remove-site-panel"
    >
      <ConfirmDialog
        testID="remove-site-dialog"
        open={open()}
        title={`Remove ${props.domain}?`}
        body="Events sent to it are refused from now on, and viewers lose access to it."
        confirmLabel="Remove site"
        danger
        busy={busy()}
        onConfirm={() => void remove()}
        onCancel={() => open.set(false)}
      />
    </Panel>
  );
}

export function SettingsScreen() {
  const siteId = computed(() => currentSite()?.id ?? null);
  const target = (): InstallTarget | null => {
    const site = currentSite();
    if (!site) return null;
    const server = currentServer();
    return { server, site: site.domain, trackerSrc: instance()?.trackerUrl || defaultTrackerSrc(server) };
  };
  return (
    <If
      when={currentSite()}
      else={
        <ScreenFrame testID="screen-settings" title="Settings">
          <EmptyState
            icon="settings"
            title="No site yet"
            body={isOwner() ? "Add a site from the site switcher: a domain or an app's name." : "The administrator has not given you a site yet."}
          />
          <InstancePanel />
        </ScreenFrame>
      }
    >
      {(site) => (
        <ScreenFrame
          testID="screen-settings"
          title={site().domain}
          description="Install, this instance, and the site itself."
          actions={<SiteStatus siteId={site().id} />}
        >
          <Panel title="Install" note="Send page views and events from a website, an app or any HTTP client." testID="install-panel">
            {/* Rebuilt per site, so the first tab follows the new site's kind (domain or app name). */}
            {(() => {
              // Only the site's id is tracked: a refreshed account (a saved script URL) keeps the tab.
              siteId();
              return untracked(() => <InstallTabs initial={firstInstallTab(site().domain)} target={target()!} />);
            })()}
          </Panel>
          <InstancePanel />
          <If when={isOwner()}>
            <RemoveSite id={site().id} domain={site().domain} />
          </If>
        </ScreenFrame>
      )}
    </If>
  );
}
