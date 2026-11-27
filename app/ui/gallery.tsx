/**
 * The ui layer's gallery: every control in each variant and state, with fixed demo data, so the look
 * can be reviewed in light and dark without a server. Reached from the account menu in development
 * builds; `App.gallery.test.tsx` screenshots it.
 */
import { colorScheme, Scroll, signal, View } from "nsh";
import { createNavStack } from "nsh/base";
import {
  ActionMenu, AddFilterChip, Avatar, AvatarButton, Badge, BarRow, Bars, Button, ButtonRow, Card, Checkbox, CodeBlock, ConfirmDialog, DataTable, EmptyState,
  Field, FilterChip, GroupSection, Heading, IconButton, InlineCode, MenuRow, MetricTile, Modal, NavButton, NavItem, NavList, Panel, PillTabs,
  PageHeader, PageStack, PropertyList, Segmented, Select, Separator, ShareBar, Skeleton, StackPage, SheetNavRow, Sparkline, Spinner, StatusPill, Switch, TabBarButton, TabBarItem, TabBarList, Tag, Textarea,
  CodeInput, TextInput, TimeSeries, Timeline, toast, Txt, UnderlineTabs, ChartLegend, Heatmap, WorldMap, size, width,
} from "./index";

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const cur = [120, 132, 101, 154, 190, 230, 210, 180, 199, 240, 260, 230, 280, 300];
const prev = [100, 110, 98, 120, 150, 170, 160, 150, 170, 180, 200, 190, 210, 220];

const people = [
  { id: 1, email: "ada@example.com", role: "Owner", sites: "All", seen: "2m ago" },
  { id: 2, email: "grace@example.com", role: "Viewer", sites: "example.com", seen: "3d ago" },
  { id: 3, email: "linus@example.com", role: "Viewer", sites: "my-app", seen: "Never" },
];

/**
 * Every ui control in its variants and states. `appearance` switches the theme in place, so the
 * same page is reviewed (and screenshotted) in light and dark.
 */
export function Gallery(props: { onAppearance?: (a: "light" | "dark") => void }) {
  const seg = signal<"a" | "b" | "c">("a");
  const pill = signal<"pages" | "entry" | "exit">("pages");
  const nav = signal("overview");
  const tab = signal<"all" | "web" | "app">("all");
  const choice = signal<"visitors" | "views">("visitors");
  const text = signal("");
  const otp = signal("AB12");
  const group = signal(true);
  const confirm = signal(false);
  const modal = signal(false);
  const picked = signal<string[]>(["Germany"]);
  const country = signal<string | null>(null);
  const note = signal("");
  const agree = signal(true);
  const digest = signal(false);
  const live = signal(true);
  return (
    <View class="gap-6" testID="gallery">
      <View class="flex-row items-center gap-3">
        <View class="flex-1"><Heading size="heading">UI gallery</Heading></View>
        <If when={props.onAppearance}>
          <Segmented
            testID="gallery-theme"
            accessibilityLabel="Appearance"
            options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
            value={colorScheme()}
            onChange={(v) => props.onAppearance?.(v)}
          />
        </If>
      </View>

      <Section title="Title with a status">
        <View class="flex-row flex-wrap items-center gap-3">
          <Txt size="display" weight="semibold">example.com</Txt>
          <StatusPill label="Live" tone="ok" pulse />
          <StatusPill label="No events in 7 days" tone="warn" />
          <StatusPill label="Not installed" />
        </View>
      </Section>

      <Section title="Underline tabs">
        <UnderlineTabs
          testID="gallery-tabs"
          accessibilityLabel="Traffic"
          options={[{ value: "all", label: "All", icon: "overview", count: 3 }, { value: "web", label: "Web", icon: "pages" }, { value: "app", label: "App", icon: "events" }]}
          value={tab()}
          onChange={(v) => tab.set(v)}
        />
      </Section>

      <Section title="Buttons">
        <ButtonRow>
          <Button label="Primary" variant="primary" />
          <Button label="Outline" />
          <Button label="Ghost" variant="ghost" />
          <Button label="Delete" variant="danger" icon="trash" />
          <Button label="Busy" variant="primary" busy />
          <Button label="Disabled" disabled />
          <Button label="Small" size="sm" icon="plus" />
          <IconButton icon="settings" label="Settings" />
          <IconButton icon="close" label="Close" size="sm" />
          <IconButton icon="filter" label="Filter (selected)" selected />
          <IconButton icon="trash" label="Disabled" disabled />
          <Button label="Selected" variant="ghost" icon="compare" selected />
          <Button label="Small primary" variant="primary" size="sm" />
          <Button label="Small busy" size="sm" busy />
        </ButtonRow>
      </Section>

      <Section title="Inputs">
        <View class="gap-3" style={{ maxWidth: 360 }}>
          <Field label="Email" hint="The address you were invited with.">
            <TextInput value={text()} onChange={(v) => text.set(v)} placeholder="you@example.com" keyboard="email-address" plain />
          </Field>
          <Field label="Code">
            <CodeInput length={8} value={otp()} onChange={(v) => otp.set(v)} />
          </Field>
          <Field label="Code" error="That code is not right.">
            <CodeInput length={8} value="AB12CD34" onChange={() => {}} invalid />
          </Field>
          <Field label="Disabled">
            <TextInput value="stats.example.com" onChange={() => {}} disabled />
          </Field>
          <Field label="Note" hint="Shown in the invitation email.">
            <Textarea value={note()} onChange={(v) => note.set(v)} placeholder="A line for the person you invite" rows={3} />
          </Field>
        </View>
      </Section>

      <Section title="Checkbox, switch">
        <View class="gap-2">
          <Checkbox testID="gallery-check" label="Count bots as visitors" checked={agree()} onChange={(v) => agree.set(v)} />
          <Checkbox label="Some sites" checked={false} indeterminate onChange={() => {}} />
          <Checkbox label="Must accept" checked={false} invalid onChange={() => {}} />
          <Checkbox label="Disabled" checked disabled onChange={() => {}} />
        </View>
        <Separator />
        <View class="gap-2">
          <Switch testID="gallery-switch" label="Weekly digest" checked={digest()} onChange={(v) => digest.set(v)} />
          <Switch label="Live updates" checked={live()} onChange={(v) => live.set(v)} />
          <Switch label="Disabled" checked={false} disabled onChange={() => {}} />
        </View>
      </Section>

      <Section title="Segmented, pill tabs, select">
        <Segmented accessibilityLabel="Demo" options={[{ value: "a", label: "Today" }, { value: "b", label: "7d" }, { value: "c", label: "30d" }]} value={seg()} onChange={(v) => seg.set(v)} />
        <PillTabs accessibilityLabel="Demo tabs" options={[{ value: "pages", label: "Pages" }, { value: "entry", label: "Entry" }, { value: "exit", label: "Exit" }]} value={pill()} onChange={(v) => pill.set(v)} />
        <Segmented accessibilityLabel="Demo stretched" layout="stretch" options={[{ value: "a", label: "Today" }, { value: "b", label: "7d" }, { value: "c", label: "30d" }]} value={seg()} onChange={(v) => seg.set(v)} />
        <ActionMenu trigger={<Button label="Open menu" trailing="chevronDown" />}>
          <MenuRow label="Checked" checked onSelect={() => {}} />
          <MenuRow label="Unchecked" checked={false} onSelect={() => {}} />
          <MenuRow label="With icon" icon="settings" hint="⌘," onSelect={() => {}} />
          <MenuRow label="Delete" icon="trash" danger onSelect={() => {}} />
          <MenuRow label="Disabled" disabled onSelect={() => {}} />
        </ActionMenu>
        <ButtonRow>
          <Select testID="gallery-select" accessibilityLabel="Metric" value={choice()} onChange={(v) => choice.set(v)} options={[{ value: "visitors", label: "Visitors" }, { value: "views", label: "Views" }]} />
          <Select
            accessibilityLabel="Country"
            variant="outline"
            placeholder="Choose a country"
            searchable
            value={country()}
            onChange={(v) => country.set(v)}
            options={[
              { value: "de", label: "Germany", group: "Europe" },
              { value: "fr", label: "France", group: "Europe" },
              { value: "jp", label: "Japan", group: "Asia" },
              { value: "kp", label: "Unavailable", group: "Asia", disabled: true },
            ]}
          />
          <Select accessibilityLabel="Disabled" variant="outline" value="visitors" disabled onChange={() => {}} options={[{ value: "visitors", label: "Disabled" }]} />
        </ButtonRow>
      </Section>

      <Section title="Navigation: sidebar, tab bar, sheet rows">
        <View class="flex-row flex-wrap gap-6">
          <View class="gap-2 rounded-(--radius-card) bg-sidebar p-2" style={{ width: width.picker }}>
            <NavButton label="example.com" icon="geography" trailing="chevronDown" />
            <NavList accessibilityLabel="Demo sections">
              <NavItem label="Overview" icon="overview" selected={nav() === "overview"} onPress={() => nav.set("overview")} />
              <NavItem label="Users" icon="users" selected={nav() === "users"} onPress={() => nav.set("users")} />
              <NavItem label="Pages" icon="pages" selected={nav() === "pages"} onPress={() => nav.set("pages")} />
            </NavList>
          </View>
          <View class="w-full gap-2" style={{ maxWidth: width.dialog }}>
            <View class="flex-row rounded-(--radius-card) border border-border" style={{ height: size.tabBar }}>
              <TabBarList accessibilityLabel="Demo tab bar">
                <TabBarItem label="Overview" icon="overview" selected={nav() === "overview"} onPress={() => nav.set("overview")} />
                <TabBarItem label="Users" icon="users" selected={nav() === "users"} onPress={() => nav.set("users")} />
                <TabBarItem label="Pages" icon="pages" selected={nav() === "pages"} onPress={() => nav.set("pages")} />
                <TabBarItem label="Sources" icon="sources" selected={nav() === "sources"} onPress={() => nav.set("sources")} />
              </TabBarList>
              <TabBarButton label="More" icon="menu" onPress={() => nav.set("settings")} selected={nav() === "settings"} />
            </View>
            <SheetNavRow label="Settings" icon="settings" selected={nav() === "settings"} onPress={() => nav.set("settings")} />
            <View class="flex-row items-center gap-2">
              <ActionMenu align="start" trigger={<AvatarButton initial="A" accessibilityLabel="Account" />}>
                <MenuRow label="Sign out" icon="signOut" onSelect={() => {}} />
              </ActionMenu>
              <Txt tone="muted">Account button</Txt>
            </View>
          </View>
        </View>
      </Section>

      <Section title="Filter chips">
        <View class="flex-row flex-wrap items-center gap-1.5">
          <Each of={picked()}>{(v) => <FilterChip label="Country" value={v()} onRemove={() => picked.set(picked().filter((x) => x !== v()))} />}</Each>
          <AddFilterChip label="Country" options={[{ value: "France", label: "France", hint: "320" }, { value: "Japan", label: "Japan", hint: "180" }]} onPick={(v) => picked.set([...picked().filter((x) => x !== v), v])} />
          <AddFilterChip label="Device" options={undefined} onPick={() => {}} />
        </View>
      </Section>

      <Section title="Detail page (pushed on the page stack)">
        <DetailDemo />
      </Section>

      <Section title="Overlays">
        <ButtonRow>
          <Button label="Open dialog" onPress={() => modal.set(true)} />
          <Button label="Remove person" variant="danger" onPress={() => confirm.set(true)} />
        </ButtonRow>
        <Modal open={modal()} onClose={() => modal.set(false)} title="Add a site" description="A domain or a bare name." actions={<><Button label="Cancel" variant="ghost" onPress={() => modal.set(false)} /><Button label="Add site" variant="primary" onPress={() => modal.set(false)} /></>}>
          <TextInput value="" onChange={() => {}} placeholder="example.com" />
        </Modal>
        <ConfirmDialog open={confirm()} title="Remove grace@example.com?" body="They lose access to every site at once, and their agents are disconnected." confirmLabel="Remove person" danger onConfirm={() => confirm.set(false)} onCancel={() => confirm.set(false)} />
      </Section>

      <Section title="Grouped section, table, property list">
        <GroupSection title="People" icon="team" count={people.length} open={group()} onToggle={(o) => group.set(o)} actions={<IconButton icon="plus" label="Invite" size="sm" />}>
          <DataTable
            rows={people}
            rowKey={(p) => p.id}
            onRowPress={() => {}}
            rowLabel={(p) => `Open ${p.email}`}
            columns={[
              { key: "who", title: "Person", cell: (p) => <View class="flex-row items-center gap-2"><Avatar name={p.email} /><Txt size="table" truncate>{p.email}</Txt></View> },
              { key: "role", title: "Role", width: 80, hideBelow: 360, cell: (p) => <Tag label={p.role} tone={p.role === "Owner" ? "brand" : "neutral"} /> },
              { key: "sites", title: "Sites", width: 110, hideBelow: 520, cell: (p) => p.sites, mono: true },
              { key: "seen", title: "Last seen", width: 80, align: "end", cell: (p) => p.seen, mono: true },
            ]}
          />
        </GroupSection>
        <Card><PropertyList items={[{ label: "Tracker", value: "https://stats.example.com/t.js", mono: true }, { label: "Version", value: "0.3.0", mono: true }, { label: "Role", value: <Tag label="Owner" tone="brand" /> }]} /></Card>
      </Section>

      <Section title="Share bars, code">
        <View class="gap-2" style={{ maxWidth: 360 }}>
          <View class="flex-row justify-between"><Txt tone="muted">Returning visitors</Txt><Txt numeric>62%</Txt></View>
          <ShareBar value={0.62} accessibilityLabel="Returning visitors" />
          <ShareBar value={0.18} tone="warn" />
          <ShareBar value={0.05} tone="bad" />
        </View>
        <CodeBlock label="tracker snippet" code={'<script defer src="https://stats.example.com/t.js" data-site="example.com"></script>'} />
        <Txt tone="muted">Send events with <InlineCode>nsmetry.track("signup")</InlineCode> from the page.</Txt>
      </Section>

      <Section title="Badges and toasts">
        <ButtonRow>
          <Badge label="Owner" />
          <Badge label="Live" tone="ok" />
          <Badge label="New" tone="brand" />
          <Badge label="Failed" tone="bad" />
          <Button label="Show a toast" size="sm" onPress={() => toast("Site added", { tone: "ok", body: "Install the tracker from Settings." })} />
        </ButtonRow>
      </Section>

      <Section title="Metric tiles">
        <View class="flex-row flex-wrap gap-2">
          <MetricTile label="Visitors" value="2,480" delta={0.124} selected onPress={() => {}} chart={<Sparkline values={cur} />} />
          <MetricTile label="Bounce rate" value="41%" delta={0.05} better="down" onPress={() => {}} chart={<Sparkline values={prev} tone="muted" />} />
          <MetricTile label="Visit duration" value="1m 20s" delta={null} />
        </View>
      </Section>

      <Panel title="Time series" note="Dashed: previous period">
        <TimeSeries accessibilityLabel="Visitors per day" points={days.map((label, i) => ({ label, cur: cur[i]!, prev: prev[i]! }))} format={(v) => String(Math.round(v))} compareLabel="Previous 14 days" />
      </Panel>

      <Panel title="Two series" note="Solid chart-2: a second series of the same period" actions={<ChartLegend items={[{ label: "Active", tone: "brand" }, { label: "New", tone: "second" }]} />}>
        <TimeSeries accessibilityLabel="Active and new users per day" points={days.map((label, i) => ({ label, cur: cur[i]!, prev: Math.round(prev[i]! / 4) }))} format={(v) => String(Math.round(v))} label="Active" compareLabel="New" secondary="series" />
      </Panel>

      <Panel title="World map" note="Choropleth on Canvas: brand ramp by value, hover outline, press to select">
        <WorldMap
          testID="gallery-world"
          map={{ width: 200, height: 100, countries: { DE: "M10 10 L60 10 L60 60 L10 60 Z", JP: "M80 10 L130 10 L130 60 L80 60 Z", US: "M140 10 L190 10 L190 90 L140 90 Z" } }}
          values={{ DE: 500, JP: 120 }}
          selected="DE"
          name={(c) => c}
          format={(v) => `${v} visitors`}
          hint="Press a country to filter by it"
          accessibilityLabel="World map sample"
        />
      </Panel>

      <Panel title="Heatmap" note="Retention cohorts: size on the neutral wash, shares on the brand ramp">
        <Heatmap
          accessibilityLabel="Weekly retention"
          columns={["0", "1", "2", "3"]}
          rows={["Nov 2", "Nov 9", "Nov 16"]}
          columnLabel={(c) => (c === "0" ? "New" : `W${c}`)}
          cells={[
            { x: "0", y: "Nov 2", label: "300", description: "Nov 2: 300 new users" },
            { x: "1", y: "Nov 2", value: 0.42, label: "42%", description: "Nov 2, week 1: 42%" },
            { x: "2", y: "Nov 2", value: 0.3, label: "30%", description: "Nov 2, week 2: 30%" },
            { x: "3", y: "Nov 2", value: 0.21, label: "21%", description: "Nov 2, week 3: 21%" },
            { x: "0", y: "Nov 9", label: "280", description: "Nov 9: 280 new users" },
            { x: "1", y: "Nov 9", value: 0.38, label: "38%", description: "Nov 9, week 1: 38%" },
            { x: "2", y: "Nov 9", value: 0.25, label: "25%", description: "Nov 9, week 2: 25%" },
            { x: "0", y: "Nov 16", label: "310", description: "Nov 16: 310 new users" },
            { x: "1", y: "Nov 16", value: 0.4, label: "40%", description: "Nov 16, week 1: 40%" },
          ]}
        />
      </Panel>

      <Panel title="Bars">
        <Bars accessibilityLabel="Visitors per weekday" rows={days.slice(0, 7).map((label, i) => ({ label, value: cur[i]! }))} format={(v) => String(Math.round(v))} />
      </Panel>

      <Panel title="Breakdown rows">
        <BarRow label="/" value="1,204" share={1} onPress={() => {}} />
        <BarRow label="/pricing" value="602" share={0.5} onPress={() => {}} />
        <BarRow label="/docs/getting-started" value="180" share={0.15} secondary="7%" />
      </Panel>

      <Section title="Loading, empty, error">
        <View class="flex-row items-center gap-2"><Spinner label="Loading visitors" /><Txt tone="muted">Loading visitors…</Txt></View>
        <Card class="gap-2">
          <Skeleton width="60%" height={14} />
          <Skeleton width="90%" />
          <Skeleton width="40%" />
        </Card>
        <Card inset><EmptyState title="No data for this period" body="Try a longer range or remove a filter." action={{ label: "Clear filters", onPress: () => {} }} /></Card>
        <Card inset><EmptyState icon="error" title="Could not load visitors" body="The server did not answer. Check your connection." action={{ label: "Try again", onPress: () => {} }} /></Card>
      </Section>
    </View>
  );
}

/**
 * A small live page stack: a list whose row pushes a record's page, with the desktop / web header
 * (`PageHeader`) and its back button. The shell's content area is the same, full size.
 */
function DetailDemo() {
  const stack = createNavStack<"list" | "detail">(["list"]);
  return (
    <View class="overflow-hidden rounded-(--radius-card) border border-border" style={{ height: 380 }} testID="gallery-stack">
      <PageStack state={stack}>
        {(route) =>
          route === "list" ? (
            <StackPage root title="Events">
              <View class="gap-2 p-4">
                <Txt tone="muted">The list. A row pushes its page.</Txt>
                <BarRow label="checkout_completed" value="1,204" share={0.8} onPress={() => stack.push("detail")} />
                <BarRow label="signup" value="320" share={0.25} />
              </View>
            </StackPage>
          ) : (
            <StackPage
              title="checkout_completed"
              testID="gallery-detail"
              header={<PageHeader testID="gallery-detail-header" backLabel="Events" onBack={() => stack.pop()} meta="my-app · event · Last 7 days" actions={<IconButton icon="link" label="Copy link" />} wide={false} />}
            >
              <Scroll class="flex-1">
                <View class="gap-5 p-4">
                  <Heading size="heading">checkout_completed</Heading>
                  <PropertyList items={[{ label: "Status", value: <StatusPill label="Live" tone="ok" /> }, { label: "Count", value: "1,204" }, { label: "Version", value: "2.3.1", mono: true }, { label: "Labels", value: <View class="flex-row gap-1"><Tag label="checkout" tone="brand" /><Tag label="ios" /></View> }]} />
                  <Txt weight="semibold">Activity</Txt>
                  <Timeline items={[{ id: 1, title: "First seen", detail: "on iOS", time: "3d ago", tone: "brand" }, { id: 2, title: "Ada", detail: "added a goal", time: "2h ago", avatar: "Ada" }, { id: 3, title: "Spike", detail: "+240% vs yesterday", time: "12m ago", tone: "warn" }]} />
                </View>
              </Scroll>
            </StackPage>
          )
        }
      </PageStack>
    </View>
  );
}

function Section(props: { title: string; children?: import("nsh").JSX.Element }) {
  return (
    <View class="gap-3">
      <Txt size="caption" tone="muted" weight="medium">{props.title}</Txt>
      {props.children}
    </View>
  );
}
