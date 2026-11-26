/**
 * Agents: the AI agents connected to this account over MCP (OAuth grants), and how to connect one.
 *
 * Each person sees and disconnects only their own agents (docs/api.md, "Connected agents"). A grant
 * row pushes the agent's page with its activity; "Disconnect…" asks in a dialog over it, and the page
 * pops once the agent is gone. The connect panel gives the MCP URL and a ready snippet per client; the agent
 * does the rest (dynamic registration, a browser sign-in with an email code, the approval page).
 */
import { createMotion, resource, signal, View } from "nsh";
import { ApiError, type Grant } from "../api";
import { api, closeDetail, currentServer, openDetail } from "../store";
import {
  Button, Card, CodeBlock, ConfirmDialog, DataTable, EmptyState, Glyph, Heading, InlineCode, Panel, PillTabs, PropertyList,
  Skeleton, Tag, Timeline, toast, Txt, motion, size,
} from "../ui";
import { ScreenFrame } from "./frame";
import { serverOr } from "./settings/snippets";
import { ago, day } from "./settings/time";

type Client = "claude-code" | "claude-desktop" | "cursor" | "other";

/** The MCP endpoint of an instance. */
export const mcpUrl = (server: string) => `${serverOr(server)}/mcp`;

/** The snippet and its one-line explanation, per client. */
export function connectSnippet(client: Client, url: string): { body: string; code: string; label: string } {
  switch (client) {
    case "claude-code":
      return {
        body: "Run it in a terminal, then /mcp in Claude Code to sign in.",
        code: `claude mcp add --transport http nsmetry ${url}`,
        label: "command",
      };
    case "claude-desktop":
      return {
        body: "In Settings, Connectors, add a custom connector with the URL above. Or add this to claude_desktop_config.json:",
        code: JSON.stringify({ mcpServers: { nsmetry: { command: "npx", args: ["-y", "mcp-remote", url] } } }, null, 2),
        label: "config",
      };
    case "cursor":
      return {
        body: "Add it to ~/.cursor/mcp.json (or .cursor/mcp.json in a project):",
        code: JSON.stringify({ mcpServers: { nsmetry: { url } } }, null, 2),
        label: "config",
      };
    case "other":
      return {
        body: "Any MCP client that speaks Streamable HTTP with OAuth: give it the URL. It registers itself and opens a browser to sign in.",
        code: JSON.stringify({ mcpServers: { nsmetry: { type: "http", url } } }, null, 2),
        label: "config",
      };
  }
}

const clients = [
  { value: "claude-code", label: "Claude Code" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "cursor", label: "Cursor" },
  { value: "other", label: "Other" },
] as const;

/** The chosen client's snippet; it fades up 4pt over `fast` as the client changes. */
function ClientBody(props: { client: Client; url: string }) {
  const m = createMotion({ enter: { duration: motion.duration.fast, easing: motion.settle, keyframes: { opacity: [0, 1], translateY: [motion.popDistance, 0] } } });
  const s = () => connectSnippet(props.client, props.url);
  return (
    <View class="gap-2" style={m.style} testID={`connect-${props.client}`}>
      <Txt tone="muted">{s().body}</Txt>
      <CodeBlock code={s().code} label={s().label} testID="connect-snippet" />
    </View>
  );
}

function ConnectPanel() {
  const client = signal<Client>("claude-code");
  const url = () => mcpUrl(currentServer());
  return (
    <Panel title="Connect an agent" note="Agents read through MCP, signed in as you." testID="connect-panel">
      <View class="gap-5">
        <View class="gap-2">
          <Txt weight="semibold">MCP URL</Txt>
          <CodeBlock code={url()} label="MCP URL" testID="mcp-url" />
        </View>
        <View class="gap-3">
          <PillTabs testID="connect-client" accessibilityLabel="Client" options={clients} value={client()} onChange={(v) => client.set(v)} />
          {/* Rebuilt per client (a call in JSX re-runs when `client` changes), so it enters with its motion. */}
          {((c: Client) => <ClientBody client={c} url={url()} />)(client())}
        </View>
        <View class="gap-1.5">
          <Txt weight="semibold">What happens</Txt>
          <Txt tone="muted">
            The first time, the agent opens a browser: sign in with an email code and approve it. It can read, never change, the
            sites you can see; access renews itself hourly until you disconnect it here.
          </Txt>
          <View class="flex-row flex-wrap items-center gap-1">
            <Txt tone="muted">Tools:</Txt>
            <InlineCode>list_sites</InlineCode>
            <InlineCode>get_summary</InlineCode>
            <InlineCode>get_breakdown</InlineCode>
            <InlineCode>get_timeseries</InlineCode>
            <InlineCode>get_realtime</InlineCode>
          </View>
        </View>
      </View>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------- grant page

/** One agent's page: its access, when it connected and last read, and the way to disconnect it. */
function GrantDetail(props: { grant: Grant; onDisconnect: (g: Grant) => Promise<boolean> }) {
  const asking = signal(false);
  const busy = signal(false);
  const g = () => props.grant;
  const disconnect = async () => {
    busy.set(true);
    const gone = await props.onDisconnect(g());
    busy.set(false);
    if (gone) {
      asking.set(false);
      closeDetail();
    }
  };
  return (
    <View class="gap-5" testID="grant-detail">
      <PropertyList
        items={[
          { label: "Access", value: <Tag label="Read only" tone="brand" /> },
          { label: "Connected", value: day(g().created_at), mono: true },
          { label: "Last used", value: g().last_used_at ? ago(g().last_used_at) : "Never", mono: true },
        ]}
      />
      <View class="gap-2">
        <Heading size="lead">Activity</Heading>
        <Timeline
          items={[
            ...(g().last_used_at ? [{ id: "used", title: "Read data", detail: "over MCP", time: ago(g().last_used_at), tone: "ok" as const }] : []),
            { id: "connected", title: "Connected", detail: "approved by you", time: ago(g().created_at), tone: "brand" as const },
          ]}
        />
        <Txt size="caption" tone="faint">Last use is recorded at most every few minutes.</Txt>
      </View>
      <View class="flex-row">
        <Button label="Disconnect…" variant="danger" icon="unplug" onPress={() => asking.set(true)} testID="grant-disconnect" />
      </View>
      <ConfirmDialog
        testID="disconnect-dialog"
        open={asking()}
        title={`Disconnect ${g().client_name || "this agent"}?`}
        body="It loses access at once. Connecting it again needs a new sign-in."
        confirmLabel="Disconnect"
        danger
        busy={busy()}
        onConfirm={() => void disconnect()}
        onCancel={() => asking.set(false)}
      />
    </View>
  );
}

// ------------------------------------------------------------------------------------- screen

export function AgentsScreen() {
  const grants = resource(() => api.grants());
  const list = () => grants()?.grants ?? [];

  /** Revoke a grant; true once it is gone. */
  const disconnect = async (g: Grant): Promise<boolean> => {
    try {
      await api.revokeGrant(g.id);
      grants.mutate({ grants: list().filter((x) => x.id !== g.id) });
      toast(`Disconnected ${g.client_name || "the agent"}`, { tone: "ok" });
      return true;
    } catch (e) {
      toast("Couldn't disconnect it", { body: e instanceof ApiError ? e.message : undefined, tone: "error" });
      return false;
    }
  };

  // The page reads the grant from the list (its last use follows a reload); the row pressed stands in
  // once it has left the list.
  const openGrant = (row: Grant) => {
    const id = row.id;
    const live = () => list().find((x) => x.id === id) ?? row;
    openDetail({
      testID: "grant-page",
      title: () => live().client_name || "Unnamed agent",
      meta: () => `agent · ${String(id)}`,
      content: () => <GrantDetail grant={live()} onDisconnect={disconnect} />,
    });
  };

  return (
    <ScreenFrame testID="screen-agents" title="Agents" description="AI agents that read your analytics over MCP.">
      <Panel title="Connected" note={grants() ? `${list().length} ${list().length === 1 ? "agent" : "agents"}` : undefined} testID="grants-panel">
        <If
          when={!grants.error()}
          else={
            <EmptyState
              icon="error"
              title="Couldn't load connected agents"
              body={grants.error() instanceof ApiError ? (grants.error() as ApiError).message : undefined}
              action={{ label: "Try again", onPress: () => void grants.refetch() }}
            />
          }
        >
          <If when={grants()} else={<View class="gap-3 py-2"><Skeleton width="55%" /><Skeleton width="40%" /></View>}>
            <If
              when={list().length > 0}
              else={<EmptyState icon="agents" title="No agents connected" body="Connect one below. It signs in as you and reads only your sites." testID="grants-empty" />}
            >
              <Card inset testID="grants-table">
                <DataTable
                  columns={[
                    {
                      key: "client",
                      title: "Client",
                      cell: (g: Grant) => (
                        <View class="min-w-0 flex-row items-center gap-2">
                          <Glyph name="agents" size={size.iconSm} tone="muted" />
                          <View class="min-w-0 shrink"><Txt size="table" truncate>{g.client_name || "Unnamed agent"}</Txt></View>
                        </View>
                      ),
                    },
                    { key: "connected", title: "Connected", width: 110, mono: true, hideBelow: 480, cell: (g: Grant) => ago(g.created_at) },
                    { key: "used", title: "Last used", width: 100, align: "end", mono: true, cell: (g: Grant) => (g.last_used_at ? ago(g.last_used_at) : "Never") },
                  ]}
                  rows={list()}
                  rowKey={(g) => g.id}
                  rowLabel={(g) => `Open ${g.client_name || "agent"}`}
                  onRowPress={openGrant}
                />
              </Card>
            </If>
          </If>
        </If>
      </Panel>

      <ConnectPanel />

    </ScreenFrame>
  );
}
