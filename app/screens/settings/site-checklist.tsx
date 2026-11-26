/**
 * Which sites a viewer may read: a checkbox per site under an "All sites" box that shows a partial
 * choice as indeterminate. Used by the invite dialog and the person page (Team).
 *
 * An instance can hold ~100 sites, so past a handful a filter field appears above the list and the
 * list scrolls inside its own bounded box instead of growing the dialog off the screen. "All sites"
 * acts on what the filter shows, which is what a person filtering for "omasend" expects.
 */
import { Scroll, signal, View } from "nsh";
import type { Site } from "../../api";
import { Checkbox, Separator, TextInput, Txt } from "../../ui";

/** More sites than this and the filter shows. */
const FILTER_FROM = 8;
/** The list's tallest before it scrolls, in points: about eight rows. */
const LIST_MAX_HEIGHT = 260;

export function SiteChecklist(props: {
  sites: readonly Site[];
  selected: readonly number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const query = signal("");
  const shown = () => {
    const q = query().trim().toLowerCase();
    return q ? props.sites.filter((s) => s.domain.toLowerCase().includes(q)) : props.sites;
  };
  const isOn = (id: number) => props.selected.includes(id);
  const onCount = () => shown().filter((s) => isOn(s.id)).length;
  const toggle = (id: number, on: boolean) =>
    props.onChange(on ? [...props.selected.filter((x) => x !== id), id] : props.selected.filter((x) => x !== id));
  const toggleAll = (on: boolean) => {
    const ids = new Set(shown().map((s) => s.id));
    const rest = props.selected.filter((x) => !ids.has(x));
    props.onChange(on ? [...rest, ...ids] : rest);
  };

  return (
    <View class="gap-2" testID={props.testID}>
      <If when={props.sites.length > FILTER_FROM}>
        <TextInput value={query()} onChange={(v) => query.set(v)} placeholder="Filter sites" plain accessibilityLabel="Filter sites" />
      </If>
      <If when={props.sites.length > 0} else={<Txt tone="muted">No sites yet. Add one from the site switcher first.</Txt>}>
        <View class="flex-row items-center gap-2">
          <View class="flex-1">
            <Checkbox
              label={query().trim() ? "All shown" : "All sites"}
              checked={shown().length > 0 && onCount() === shown().length}
              indeterminate={onCount() > 0 && onCount() < shown().length}
              disabled={props.disabled || shown().length === 0}
              onChange={toggleAll}
              testID={props.testID ? `${props.testID}-all` : undefined}
            />
          </View>
          <Txt size="caption" tone="faint" numeric>{`${props.selected.length} of ${props.sites.length}`}</Txt>
        </View>
        <Separator />
        <Scroll style={{ maxHeight: LIST_MAX_HEIGHT }}>
          <View class="gap-1 pl-1">
            <Each of={shown()} key={(s) => s.id}>
              {(s) => (
                <Checkbox
                  label={s().domain}
                  checked={isOn(s().id)}
                  disabled={props.disabled}
                  onChange={(on) => toggle(s().id, on)}
                  testID={props.testID ? `${props.testID}-${s().id}` : undefined}
                />
              )}
            </Each>
            <If when={shown().length === 0}>
              <Txt tone="muted">No site matches.</Txt>
            </If>
          </View>
        </Scroll>
      </If>
    </View>
  );
}
