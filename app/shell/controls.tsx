/**
 * The shell's controls, shared by the wide (sidebar) and narrow (tab bar) layouts: the site
 * switcher, the range picker, the compare toggle, the filter chips and the account menu.
 */
import { appInfo, openUrl, Scroll, signal, untracked, View } from "nsh";
import { ApiError, type Dim, RANGES, type RangeId } from "../api";
import { formatCount } from "../format";
import { isAppSite } from "./nav";
import {
  addFilter,
  addSite,
  api,
  clearFilters,
  comparing,
  currentAppearance,
  currentFilters,
  currentRange,
  currentSite,
  currentSiteId,
  currentUser,
  dimLabels,
  filterFor,
  filtersAllowed,
  go,
  isOwner,
  rangeLabels,
  removeFilter,
  scope,
  selectSite,
  setAppearance,
  setRange,
  signOut,
  siteList,
  toggleCompare,
} from "../store";
import {
  ActionMenu,
  AddFilterChip,
  AvatarButton,
  Button,
  Field,
  FilterChip,
  IconButton,
  MenuLabel,
  MenuRow,
  MenuSep,
  Modal,
  NavButton,
  type PickOption,
  Segmented,
  space,
  TextInput,
  toast,
  touch,
  Txt,
} from "../ui";

/**
 * Which site the screens show; the owner can add one from the same menu. `block` is the sidebar's
 * form: a full-width nav-row trigger, left-aligned with the brand and the sections.
 */
/** Whether the "Add a site" dialog is open; the switcher owns it, the empty state opens it too. */
const adding = signal(false);
export const openAddSite = () => adding.set(true);

export function SiteSwitcher(props: { block?: boolean }) {
  const domain = signal("");
  const error = signal<string | null>(null);
  const busy = signal(false);
  const current = () => siteList().find((s) => s.id === currentSiteId())?.domain ?? "No site";
  const opened = signal(0);

  const submit = async () => {
    if (!domain().trim()) return error.set("Enter a domain or a name.");
    busy.set(true);
    error.set(null);
    try {
      const site = await addSite(domain());
      adding.set(false);
      domain.set("");
      // The next step is installing tracking on it: open Settings, where the install prompts are.
      go("settings");
      toast(`Added ${site.domain}`, { tone: "ok", body: "Next: install tracking. Copy a prompt below for your coding agent." });
    } catch (e) {
      error.set(e instanceof ApiError ? e.message : String(e));
    } finally {
      busy.set(false);
    }
  };

  return (
    <>
      <ActionMenu
        align="start"
        onOpenChange={(open) => { if (open) opened.set(opened() + 1); }}
        trigger={
          props.block ? (
            <NavButton testID="site-switcher" label={current()} icon="geography" trailing="chevronDown" accessibilityLabel={`Site: ${current()}`} />
          ) : (
            <Button testID="site-switcher" label={current()} icon="geography" trailing="chevronDown" variant="ghost" accessibilityLabel={`Site: ${current()}`} />
          )
        }
      >
        <MenuLabel>Sites</MenuLabel>
        {/* Built afresh each time the menu opens: on the web a closed menu's rows missed a change made
            while it was hidden (adding a site from the dialog left the old site checked). */}
        {() => {
          opened();
          return untracked(() => (
            <Each of={siteList()} key={(s) => s.id}>
              {(s) => <MenuRow testID={`site-row-${s().id}`} label={s().domain} checked={s().id === currentSiteId()} onSelect={() => selectSite(s().id)} />}
            </Each>
          ));
        }}
        <If when={isOwner()}>
          <MenuSep />
          <MenuRow testID="add-site" label="Add site…" icon="plus" onSelect={() => adding.set(true)} />
        </If>
      </ActionMenu>
      <Modal
        open={adding()}
        onClose={() => adding.set(false)}
        title="Add a site"
        description="A domain (example.com) or, for an app, a bare name (my-app)."
        actions={
          <>
            <Button label="Cancel" variant="ghost" block={touch} onPress={() => adding.set(false)} />
            <Button label="Add site" variant="primary" block={touch} busy={busy()} onPress={() => void submit()} testID="add-site-submit" />
          </>
        }
      >
        <Field label="Domain or name" error={error()}>
          <TextInput value={domain()} onChange={(v) => domain.set(v)} onSubmit={() => void submit()} placeholder="example.com" keyboard="url" plain autoFocus />
        </Field>
      </Modal>
    </>
  );
}

const rangeOptions = RANGES.map((r) => ({ value: r, label: rangeLabels[r].short, description: rangeLabels[r].long }));

/** today / 7d / 30d / 90d / 12mo, as a segmented control; `stretch` spans the row (phones). */
export function RangePicker(props: { stretch?: boolean }) {
  return (
    <Segmented<RangeId>
      testID="range"
      accessibilityLabel="Date range"
      options={rangeOptions}
      value={currentRange()}
      onChange={setRange}
      layout={props.stretch ? "stretch" : "fit"}
    />
  );
}

/** Overlay the previous period on every chart and show deltas. `icon`: the glyph alone (phones). */
export function CompareToggle(props: { icon?: boolean }) {
  const label = () => (comparing() ? "Comparing with the previous period" : "Compare with the previous period");
  if (props.icon) {
    return <IconButton testID="compare" icon="compare" label={label()} tone={comparing() ? "default" : "muted"} selected={comparing()} tooltip={false} onPress={toggleCompare} />;
  }
  return (
    <Button
      testID="compare"
      label="Compare"
      icon="compare"
      variant="ghost"
      selected={comparing()}
      accessibilityLabel={label()}
      onPress={toggleCompare}
    />
  );
}

/**
 * The dimensions offered as "+ X" chips in the filter bar, in this order. Only real filter dimensions:
 * the server narrows page/screen views by their columns, so `event`, `entry` and `exit` (which rank,
 * but are not columns) would be accepted and silently ignored (docs/api.md, src/dimensions.ts).
 */
export const quickFilterDims: readonly Dim[] = ["path", "referrer", "country", "device", "app_version"];

/** An app's chips: no referrer (an app has none), its OS instead. */
export const appQuickFilterDims: readonly Dim[] = ["path", "os", "device", "app_version", "country"];

/**
 * One "+ Country" chip: opening it loads that dimension's top values for the current scope (one
 * `/api/breakdown` call), and picking one adds the filter every screen then follows.
 */
export function AddFilter(props: { dim: Dim }) {
  const values = signal<PickOption[] | undefined>(undefined);
  const error = signal<string | null>(null);
  const load = async () => {
    const s = scope();
    if (!s) return;
    values.set(undefined);
    error.set(null);
    try {
      const res = await api.breakdown(s, [props.dim], 50);
      values.set((res.breakdowns[props.dim] ?? []).map((r) => ({ value: r.name, label: r.name || "(none)", hint: formatCount(r.value) })));
    } catch (e) {
      error.set(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <AddFilterChip
      testID={`add-filter-${props.dim}`}
      label={dimLabels[props.dim]}
      options={values()}
      error={error()}
      onOpen={() => void load()}
      onPick={(v) => addFilter(props.dim, v)}
    />
  );
}

/**
 * The shared filters: the applied ones as removable chips (`id:filters`, absent without filters),
 * then a "+ X" chip for each quick dimension not filtered yet. "Clear" removes them all. `scroll`:
 * one sideways-scrolling row (phones) instead of wrapping.
 */
export function FilterBar(props: { scroll?: boolean }) {
  // Phones: one row that scrolls sideways (bleeding to the screen edges), not three rows of chips
  // pushing the numbers down.
  if (props.scroll) {
    return (
      <Scroll horizontal scrollbar={false} testID="filter-scroll" style={{ marginHorizontal: -space[4] }} contentStyle={{ paddingHorizontal: space[4] }}>
        <FilterChips wrap={false} />
      </Scroll>
    );
  }
  return <FilterChips wrap />;
}

function FilterChips(props: { wrap: boolean }) {
  const row = () => `flex-row items-center gap-1.5 ${props.wrap ? "flex-wrap" : ""}`;
  return (
    <View class={row()}>
      <If when={currentFilters().length > 0}>
        <View class={row()} testID="filters">
          <Each of={currentFilters()} key={(f) => `${f.dim}:${f.value}`}>
            {(f) => (
              <FilterChip
                testID={`remove-filter-${f().dim}`}
                label={dimLabels[f().dim]}
                value={f().value}
                onRemove={() => removeFilter(f().dim)}
              />
            )}
          </Each>
        </View>
      </If>
      <Each of={filtersAllowed() ? (isAppSite(currentSite()?.domain) ? appQuickFilterDims : quickFilterDims).filter((d) => filterFor(d) === null) : []}>
        {(d) => <AddFilter dim={d()} />}
      </Each>
      <If when={currentFilters().length > 1}>
        <Button size="sm" variant="ghost" label="Clear" onPress={clearFilters} testID="clear-filters" />
      </If>
    </View>
  );
}

/** NsMetry's own pages: the website (the repository's homepage, the live demo) and the source. */
export const projectLinks = [
  { id: "website", label: "Website", icon: "website", url: "https://huacnlee.github.io/nsmetry/" },
  { id: "github", label: "GitHub", icon: "source", url: "https://github.com/huacnlee/nsmetry" },
] as const;

export const openProjectLink = (url: string) => void openUrl(url).catch(() => undefined);

/** Who is signed in, their role, the appearance, NsMetry's website and GitHub, and sign out. */
export function AccountMenu() {
  const user = () => currentUser();
  const initial = () => (user()?.email[0] ?? "?").toUpperCase();
  return (
    <ActionMenu
      align="end"
      trigger={<AvatarButton testID="account" initial={initial()} accessibilityLabel={`Account: ${user()?.email ?? ""}`} />}
    >
      <View class="px-2 pt-1.5 pb-1 gap-0.5">
        <Txt weight="medium" truncate>{user()?.email ?? ""}</Txt>
        <Txt size="caption" tone="muted">{user()?.role === "owner" ? "Owner" : "Viewer"}</Txt>
      </View>
      <MenuSep />
      <MenuLabel>Appearance</MenuLabel>
      <MenuRow label="System" icon="system" checked={currentAppearance() === "system"} onSelect={() => setAppearance("system")} />
      <MenuRow label="Light" icon="sun" checked={currentAppearance() === "light"} onSelect={() => setAppearance("light")} />
      <MenuRow label="Dark" icon="moon" checked={currentAppearance() === "dark"} onSelect={() => setAppearance("dark")} />
      <MenuSep />
      <Each of={projectLinks}>
        {(l) => <MenuRow testID={`open-${l().id}`} label={l().label} icon={l().icon} onSelect={() => openProjectLink(l().url)} />}
      </Each>
      <MenuSep />
      <If when={appInfo().development}>
        <MenuRow label="UI gallery" icon="overview" onSelect={() => go("gallery")} />
      </If>
      <MenuRow testID="sign-out" label="Sign out" icon="signOut" onSelect={() => void signOut()} />
    </ActionMenu>
  );
}

