/**
 * The live panel: who is here now, views per minute over the last half hour, and the latest views
 * as an activity feed. One poller feeds the panel and the Overview's status pill.
 *
 * Budget: on the free plan the Worker's request count is the limit that binds, and a dashboard
 * left open is the one client that would spend it for nothing. So the poll
 *  - runs every 30 s, and only while the app is visible (`lifecycle()` is not "background": a
 *    minimized window, a hidden tab, a phone app in the background asks nothing);
 *  - asks once at once when the app comes back after a pause of 30 s or more, so the count on
 *    screen is never older than one interval;
 *  - stops with the screen that owns it (the effect's cleanup clears the timer);
 *  - after its first answer, passes that answer's `cursor` as `since`, so the server reads only
 *    what arrived in between; the panel keeps its own 30-minute window and adds each answer to it,
 *    and starts over on a site change or when the server says the cursor was too old (`full`).
 */
import { cleanup, computed, effect, lifecycle, resource, signal, untracked, View } from "nsh";
import type { Realtime } from "../api";
import { formatCount } from "../format";
import { api, currentSiteId } from "../store";
import { Bars, EmptyState, Panel, Skeleton, StatusPill, Timeline, type TimelineItem, Txt } from "../ui";
import { countryName } from "./insights/countries";
import { errorText } from "./insights/data";
import { relativeTime } from "./insights/metrics";

/** How often the live panel asks, in milliseconds. */
export const LIVE_POLL_MS = 30_000;

export interface LiveData extends Realtime {
  /** When this answer arrived (ms), so "2m ago" is measured against the answer, not a stale clock. */
  at: number;
}

export interface LivePoll {
  (): LiveData | undefined;
  error: () => unknown;
  refetch: () => unknown;
}

/** Start polling `/api/realtime` for the current site; stops when the calling component goes. */
export function createLivePoll(): LivePoll {
  const tick = signal(0);
  let last = 0;
  effect(() => {
    if (lifecycle() === "background") return;
    if (currentSiteId() === null) return;
    // Back in front after a pause: ask now rather than show a count up to 30 s old.
    if (last > 0 && Date.now() - last >= LIVE_POLL_MS) untracked(() => tick.update((n) => n + 1));
    const id = setInterval(() => tick.update((n) => n + 1), LIVE_POLL_MS);
    cleanup(() => clearInterval(id));
  });
  // A string key: the same site and tick never ask twice.
  const key = computed(() => {
    const site = currentSiteId();
    return site === null ? null : `${site}:${tick()}`;
  });
  let held: { site: number; data: LiveData } | null = null;
  return resource(key, async (k): Promise<LiveData> => {
    last = Date.now();
    const site = Number(k.split(":")[0]);
    const prior = held && held.site === site ? held.data : null;
    const r = await api.realtime(site, prior?.cursor);
    const data = prior && r.full === false ? mergeLive(prior, r) : r;
    held = { site, data: { ...data, at: Date.now() } };
    return held.data;
  });
}

const WINDOW_MINUTES = 30;

/** Adds an incremental answer to the window held: counts by minute, the newest views, the server's online count. */
export function mergeLive(prior: Realtime, next: Realtime): Realtime {
  const counts = new Map<number, number>();
  prior.minutes.forEach((m, i) => counts.set(prior.first_minute + 60 * i, m.cur));
  next.minutes.forEach((m, i) => {
    const at = next.first_minute + 60 * i;
    counts.set(at, (counts.get(at) ?? 0) + m.cur);
  });
  const minutes = Array.from({ length: WINDOW_MINUTES }, (_, i) => ({
    label: `${WINDOW_MINUTES - i}m`,
    cur: counts.get(next.first_minute + 60 * i) ?? 0,
  }));
  const horizon = next.first_minute;
  const recent = [...next.recent, ...prior.recent].filter((r) => r.ts >= horizon).sort((a, b) => b.ts - a.ts).slice(0, 8);
  return { ...next, minutes, recent, full: false };
}

/** The site's state as a soft pill: "Live · 3 online", or quiet. */
export function LiveStatus(props: { live: LivePoll; testID?: string }) {
  const online = () => props.live()?.online ?? 0;
  const label = () => {
    const d = props.live();
    if (!d) return "Checking…";
    if (d.online > 0) return `Live · ${formatCount(d.online)} online`;
    return d.minutes.some((m) => m.cur > 0) ? "Active in the last 30 min" : "No visits in 30 min";
  };
  const tone = () => (online() > 0 ? "ok" : props.live()?.minutes.some((m) => m.cur > 0) ? "brand" : "neutral");
  return <StatusPill testID={props.testID} label={label()} tone={tone()} pulse={online() > 0} />;
}

/** The live panel itself. */
export function LivePanel(props: { live: LivePoll; testID?: string }) {
  const data = () => props.live();
  const minutes = () => (data()?.minutes ?? []).map((m) => ({ label: m.label, value: m.cur }));
  const views = () => minutes().reduce((n, m) => n + m.value, 0);
  const feed = (): TimelineItem[] => {
    const d = data();
    if (!d) return [];
    return d.recent.map((r, i) => ({
      id: `${r.ts}:${r.path}:${i}`,
      title: r.path || "/",
      detail: r.country ? countryName(r.country) : undefined,
      time: relativeTime(r.ts, d.at),
      tone: i === 0 ? "brand" : "neutral",
    }));
  };
  return (
    <Panel
      testID={props.testID}
      title="Live"
      note="Refreshes every 30 seconds while NsMetry is open"
      actions={<LiveStatus live={props.live} testID={props.testID ? `${props.testID}-status` : undefined} />}
    >
      <If when={props.live.error() && !data()}>
        <EmptyState icon="error" title="Could not load live data" body={errorText(props.live.error())} action={{ label: "Try again", onPress: () => void props.live.refetch() }} />
      </If>
      <If when={!props.live.error() && !data()}>
        <View class="gap-3 py-1">
          <Skeleton width={96} height={28} />
          <Skeleton height={96} />
        </View>
      </If>
      <If when={data()}>
        <View class="gap-4">
          <View class="flex-row items-end gap-6">
            <View class="gap-0.5">
              <Txt size="caption" tone="muted">Online now</Txt>
              <Txt size="display" weight="semibold" numeric testID={props.testID ? `${props.testID}-online` : undefined}>{formatCount(data()?.online ?? 0)}</Txt>
            </View>
            <View class="gap-0.5">
              <Txt size="caption" tone="muted">Views, last 30 min</Txt>
              <Txt size="title" weight="semibold" numeric>{formatCount(views())}</Txt>
            </View>
          </View>
          <Bars rows={minutes()} format={formatCount} height={96} generation={currentSiteId() ?? 0} accessibilityLabel={`Views per minute over the last 30 minutes, ${formatCount(views())} in all`} />
          <View class="gap-1">
            <Txt size="caption" tone="muted">Latest views</Txt>
            <If when={feed().length > 0} else={<Txt tone="faint">Nothing in the last 30 minutes.</Txt>}>
              <Timeline items={feed()} testID={props.testID ? `${props.testID}-feed` : undefined} />
            </If>
          </View>
        </View>
      </If>
    </Panel>
  );
}
