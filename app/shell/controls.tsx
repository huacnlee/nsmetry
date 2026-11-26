/**
 * The shell's controls, shared by the wide (sidebar) and narrow (tab bar) layouts: the site
 * switcher, the range picker, the compare toggle, the filter chips and the account menu.
 */
import { appInfo, signal, View } from "nsh";
import { ApiError, type Dim, RANGES, type RangeId } from "../api";
import { formatCount } from "../format";
import {
  addFilter,
  addSite,
  api,
  clearFilters,
  comparing,
  currentAppearance,
  currentFilters,
  currentRange,
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
  MenuLabel,
  MenuRow,
  MenuSep,
  Modal,
  NavButton,
  type PickOption,
  Segmented,
  TextInput,
  toast,
  Txt,
} from "../ui";

/**
 * Which site the screens show; the owner can add one from the same menu. `block` is the sidebar's
 * form: a full-width nav-row trigger, left-aligned with the brand and the sections.
 */
export function SiteSwitcher(props: { block?: boolean }) {
  const adding = signal(false);
  const domain = signal("");
  const error = signal<string | null>(null);
  const busy = signal(false);
  const current = () => siteList().find((s) => s.id === currentSiteId())?.domain ?? "No site";

  const submit = async () => {
    if (!domain().trim()) return error.set("Enter a domain or a name.");
    busy.set(true);
    error.set(null);
    try {
      const site = await addSite(domain());
      adding.set(false);
      domain.set("");
      toast(`Added ${site.domain}`, { tone: "ok", body: "Install the tracker on it from Settings." });
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
        trigger={
          props.block ? (
            <NavButton testID="site-switcher" label={current()} icon="geography" trailing="chevronDown" accessibilityLabel={`Site: ${current()}`} />
          ) : (
            <Button testID="site-switcher" label={current()} icon="geography" trailing="chevronDown" variant="ghost" accessibilityLabel={`Site: ${current()}`} />
          )
        }
      >
        <MenuLabel>Sites</MenuLabel>
        <Each of={siteList()} key={(s) => s.id}>
          {(s) => <MenuRow label={s().domain} checked={s().id === currentSiteId()} onSelect={() => selectSite(s().id)} />}
        </Each>
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
            <Button label="Cancel" variant="ghost" onPress={() => adding.set(false)} />
            <Button label="Add site" variant="primary" busy={busy()} onPress={() => void submit()} testID="add-site-submit" />
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

/** Overlay the previous period on every chart and show deltas. */
export function CompareToggle() {
  return (
    <Button
      testID="compare"
      label="Compare"
      icon="compare"
      variant="ghost"
      selected={comparing()}
      accessibilityLabel={comparing() ? "Comparing with the previous period" : "Compare with the previous period"}
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
 * then a "+ X" chip for each quick dimension not filtered yet. "Clear" removes them all.
 */
export function FilterBar() {
  return (
    <View class="flex-row flex-wrap items-center gap-1.5">
      <If when={currentFilters().length > 0}>
        <View class="flex-row flex-wrap items-center gap-1.5" testID="filters">
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
      <Each of={filtersAllowed() ? quickFilterDims.filter((d) => filterFor(d) === null) : []}>
        {(d) => <AddFilter dim={d()} />}
      </Each>
      <If when={currentFilters().length > 1}>
        <Button size="sm" variant="ghost" label="Clear" onPress={clearFilters} testID="clear-filters" />
      </If>
    </View>
  );
}

/** Who is signed in, their role, the appearance, and sign out. */
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
      <If when={appInfo().development}>
        <MenuRow label="UI gallery" icon="overview" onSelect={() => go("gallery")} />
      </If>
      <MenuRow testID="sign-out" label="Sign out" icon="signOut" onSelect={() => void signOut()} />
    </ActionMenu>
  );
}

