/**
 * The app's shared state, one owner for each piece: the session (server, token, user), the site,
 * the range, the comparison toggle, the filters, the current section, the page stack of the content
 * area (a section's list and the details pushed over it) and the appearance.
 *
 * Signals are private; screens read them through the exported accessors and change them through the
 * exported actions, so every change goes through one place (and is persisted from one place).
 *
 * Persistence (NSH `Storage`, async, on the device):
 *   "server"              the last server URL used (not on the web, where it is the page's origin)
 *   "session:<server>"    `{ token, user }` for that server: a token is per server
 *   "prefs:<server>"      `{ site, range, compare }` for that server
 *   "appearance"          "system" | "light" | "dark"
 */
import type { JSX } from "nsh";
import { batch, computed, platform, setColorScheme, signal, Storage, untracked } from "nsh";
import { createNavStack } from "nsh/base";
import {
  type Api,
  ApiError,
  createApi,
  type Dim,
  fetchTransport as defaultTransport,
  type Filter,
  type MeResponse,
  normalizeServer,
  type PublicUser,
  type RangeId,
  RANGES,
  type Scope,
  type Site,
  type Transport,
} from "./api";
import { track } from "./telemetry";
import { createDemoServer, DEMO_CODE, DEMO_EMAIL, DEMO_SERVER, isDemoServer } from "./demo";

// ------------------------------------------------------------------------------------- session

export type Phase = "loading" | "signedOut" | "signedIn";

const phase = signal<Phase>("loading");
const server = signal("");
const token = signal<string | null>(null);
const user = signal<PublicUser | null>(null);
const me = signal<MeResponse | null>(null);
let transport: Transport | undefined;
/** The on-device demo instance, made the first time the demo is entered (it holds that run's edits). */
let demo: Transport | undefined;
/** The server the demo was entered from, to return to when it is left. */
let serverBeforeDemo = "";

/**
 * The page's origin on the web build, where the app is served by the instance it talks to; null on
 * native platforms and in headless tests (no page).
 */
export function pageOrigin(): string | null {
  if (platform.os !== "web") return null;
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return typeof loc?.origin === "string" && /^https?:/.test(loc.origin) ? loc.origin : null;
}

/** On the web build the server is the page's origin, so the sign-in form hides the server field. */
export const serverIsFixed = () => pageOrigin() !== null;

/** The one API client. Its base URL and token are the store's, read per request. */
export const api: Api = createApi({
  baseUrl: () => server(),
  token: () => token(),
  // The demo server is answered on the device: its address never reaches the network.
  transport: (req) => (transport ?? (isDemoServer(server()) ? (demo ??= createDemoServer()) : defaultTransport))(req),
  onUnauthorized: () => {
    // A 401 anywhere means the token is gone: forget it and show sign-in, keeping the server.
    if (phase() === "signedIn") void endSession("Your session expired. Sign in again.");
  },
});

/**
 * Replace how requests travel (an on-device demo transport, a test double). Pass undefined to go
 * back to the network.
 */
export function setTransport(t: Transport | undefined) {
  transport = t;
}

export const sessionPhase = () => phase();
export const currentServer = () => server();
export const currentUser = () => user();
export const instance = () => me();
export const isOwner = () => user()?.role === "owner";
export const inDemo = () => isDemoServer(server());
/** Why the app last went to signed-out (an expired session), shown once on the sign-in screen. */
const signedOutReason = signal<string | null>(null);
export const signOutReason = () => signedOutReason();

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await Storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
async function writeJson(key: string, value: unknown) {
  try {
    await Storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or refused: the session still works for this run.
  }
}

/** Start the app: pick the server, restore its session, and load the account. */
export async function boot(): Promise<void> {
  const appearanceSaved = (await Storage.getItem("appearance").catch(() => null)) as Appearance | null;
  if (appearanceSaved === "light" || appearanceSaved === "dark" || appearanceSaved === "system") setAppearance(appearanceSaved, false);

  // `?demo` on the web build (the public GitHub Pages demo links there) opens straight into it.
  if (pageOrigin() && /[?&]demo(=|&|$)/.test((globalThis as { location?: { search?: string } }).location?.search ?? "")) {
    await enterDemo();
    return;
  }

  const origin = pageOrigin();
  const saved = origin ?? (await Storage.getItem("server").catch(() => null)) ?? "";
  server.set(normalizeServer(saved));
  const session = server() ? await readJson<{ token: string; user: PublicUser }>(`session:${server()}`) : null;
  if (!session?.token) {
    phase.set("signedOut");
    return;
  }
  batch(() => {
    token.set(session.token);
    user.set(session.user);
  });
  await restorePrefs();
  phase.set("signedIn");
  await refreshAccount();
}

/** Point the app at another server (native only). Signing in there starts its own session. */
export function setServer(input: string) {
  server.set(normalizeServer(input));
}

/**
 * Sign in to the on-device demo (app/demo.ts): the same sign-in, against an instance that answers on
 * the device, so the whole app can be tried without deploying anything.
 */
export async function enterDemo(): Promise<void> {
  if (!inDemo()) serverBeforeDemo = server();
  server.set(DEMO_SERVER);
  await verifyCode(DEMO_EMAIL, DEMO_CODE);
}

/** Step 1 of sign-in: ask the server to send a code. Throws `ApiError`. */
export async function requestCode(email: string) {
  if (!server()) throw new ApiError(0, "Enter your NsMetry server's address.");
  return api.startSignIn(email.trim());
}

/** Step 2: trade the code for a token, persist it for this server, and enter the app. */
export async function verifyCode(email: string, code: string): Promise<void> {
  track("sign_in");
  const res = await api.verifySignIn(email.trim(), code.trim());
  batch(() => {
    token.set(res.token);
    user.set(res.user);
    signedOutReason.set(null);
  });
  if (!pageOrigin()) await Storage.setItem("server", server()).catch(() => undefined);
  await writeJson(`session:${server()}`, { token: res.token, user: res.user });
  await restorePrefs();
  phase.set("signedIn");
  await refreshAccount();
}

/** Sign out: revoke the token on the server (best effort) and forget it here. */
export async function signOut(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // Already invalid or offline: forgetting it locally is what matters.
  }
  await endSession(null);
}

async function endSession(reason: string | null) {
  const key = `session:${server()}`;
  batch(() => {
    token.set(null);
    user.set(null);
    me.set(null);
    sites.set([]);
    siteId.set(null);
    filters.set([]);
    signedOutReason.set(reason);
    phase.set("signedOut");
    resetPages();
  });
  await Storage.removeItem(key).catch(() => undefined);
  // Leaving the demo goes back to the server it was entered from (the page's own origin on the web).
  if (inDemo()) {
    server.set(pageOrigin() ?? serverBeforeDemo);
    if (!pageOrigin()) await Storage.setItem("server", server()).catch(() => undefined);
  }
}

/** Reload the account and the site list (after sign-in, and when the shell asks). */
export async function refreshAccount(): Promise<void> {
  try {
    const [m, s] = await Promise.all([api.me(), api.sites()]);
    batch(() => {
      me.set(m);
      user.set(m.user);
      sites.set(s.sites);
      if (siteId() === null || !s.sites.some((x) => x.id === siteId())) siteId.set(s.sites[0]?.id ?? null);
    });
    await writeJson(`session:${server()}`, { token: token(), user: m.user });
  } catch (error) {
    // A 401 already signed out (onUnauthorized); anything else leaves the cached session usable.
    if (!(error instanceof ApiError)) throw error;
  }
}

// ------------------------------------------------------------------------------------- sites

const sites = signal<Site[]>([]);
const siteId = signal<number | null>(null);

export const siteList = () => sites();
export const currentSiteId = () => siteId();
export const currentSite = computed(() => sites().find((s) => s.id === siteId()) ?? null);

export function selectSite(id: number) {
  if (id === siteId()) return;
  batch(() => {
    siteId.set(id);
    // Filters name values of one site; they mean nothing on another. Neither does an open detail.
    filters.set([]);
    resetPages();
  });
  void savePrefs();
}

/** Owner only: register a site and switch to it. Throws `ApiError`. */
export async function addSite(domain: string): Promise<Site> {
  track("add_site", { kind: domain.includes(".") ? "domain" : "app" });
  const { site } = await api.addSite(domain.trim());
  batch(() => {
    sites.set([...sites(), site]);
    siteId.set(site.id);
    filters.set([]);
    resetPages();
  });
  void savePrefs();
  return site;
}

// ------------------------------------------------------------------------------------- range, compare, filters

const range = signal<RangeId>("7d");
const compare = signal(false);
const filters = signal<Filter[]>([]);

export const currentRange = () => range();
export const comparing = () => compare();
export const currentFilters = () => filters();

/**
 * Whether filters apply to this range. The server answers 400 for a filtered window over 31 days
 * (docs/api.md: a filtered year reads more rows than the free plan's daily budget), so the longer
 * ranges are unfiltered: picking one drops the filters, and the filter bar offers none.
 */
export const filtersAllowed = (r: RangeId = range()) => r !== "90d" && r !== "12mo";

export function setRange(r: RangeId) {
  track("range", { range: r });
  if (r === range()) return;
  if (!filtersAllowed(r)) filters.set([]);
  range.set(r);
  void savePrefs();
}
export function setCompare(on: boolean) {
  compare.set(on);
  void savePrefs();
}
export function toggleCompare() {
  track("compare");
  setCompare(!compare());
}

/**
 * Add a `dim:value` filter, shared by every screen. One value per dimension: picking another value of
 * a filtered dimension replaces it (narrowing to two paths at once is not something the UI offers).
 */
export function addFilter(dim: Dim, value: string) {
  track("filter", { dim });
  if (!canFilter(dim) || !filtersAllowed()) return;
  const rest = filters().filter((f) => f.dim !== dim);
  filters.set([...rest, { dim, value }]);
}
export function removeFilter(dim: Dim) {
  filters.set(filters().filter((f) => f.dim !== dim));
}
export function clearFilters() {
  filters.set([]);
}
/**
 * Whether the server narrows by this dimension. `event`, `entry` and `exit` can be ranked but are not
 * columns of a page/screen view, so a filter on them would be accepted and silently ignored; their
 * rows are shown without a "filter by" action instead (docs/api.md, "Analytics").
 */
export const canFilter = (dim: Dim) => dim !== "event" && dim !== "entry" && dim !== "exit" && filtersAllowed();
export const filterFor = (dim: Dim) => filters().find((f) => f.dim === dim)?.value ?? null;

/**
 * What every analytics request is scoped by, or null before a site is chosen. Screens pass it as a
 * `resource` source, so a change of site, range, comparison or filters reloads them.
 */
export const scope = computed<Scope | null>(() => {
  const site = siteId();
  if (site === null) return null;
  return { site, range: range(), filters: filters(), compare: compare() };
});

async function savePrefs() {
  if (!server()) return;
  await writeJson(`prefs:${server()}`, { site: siteId(), range: range(), compare: compare() });
}
async function restorePrefs() {
  const p = await readJson<{ site?: number | null; range?: RangeId; compare?: boolean }>(`prefs:${server()}`);
  batch(() => {
    if (p?.range && RANGES.includes(p.range)) range.set(p.range);
    if (typeof p?.compare === "boolean") compare.set(p.compare);
    if (typeof p?.site === "number") siteId.set(p.site);
  });
}

// ------------------------------------------------------------------------------------- navigation

export type Section =
  | "overview" | "users" | "events" | "pages" | "sources" | "geography" | "tech" | "settings" | "team" | "agents"
  /** The ui layer's gallery: development builds only, from the account menu. */
  | "gallery";
const section = signal<Section>("overview");
export const currentSection = () => section();
/**
 * Show a section. The page stack goes back to its root (the section's list): a detail belongs to the
 * section it was opened from, and going to the section already shown pops to its list.
 */
export function go(s: Section) {
  if (s === "team" && !isOwner()) return;
  batch(() => {
    resetPages();
    section.set(s);
  });
}

/**
 * A data detail pushed over the current section's list (docs: app/DESIGN.md, "Navigation model").
 * The screen that opens it builds it, so its content reads that screen's live loads; the list stays
 * mounted beneath it. `title` and `meta` are read where they are shown, so they may change.
 */
export interface DetailPage {
  /** The record's name: the page's title (the system header on iOS and Android, a heading elsewhere). */
  title: () => string;
  /** Above the title, muted monospace ("example.com · Page"). */
  meta?: () => string | undefined;
  /** Icon buttons at the end of the page header (open in the browser). */
  actions?: () => JSX.Element;
  /** The detail itself, built once when the page is pushed. */
  content: () => JSX.Element;
  /** Finds the page in tests. */
  testID: string;
}

/** A route of the content area's stack: the current section's list, or a detail over it. */
export type PageRoute = "section" | DetailPage;

/** The content area's page stack. Its root route is the same value always, so a reset keeps the list's page. */
export const pageStack = createNavStack<PageRoute>(["section"]);

/** Push a detail over the current list. */
export function openDetail(page: DetailPage) {
  pageStack.push(page);
}
/** Leave the detail on top (its back button does the same). */
export function closeDetail() {
  if (untracked(() => pageStack.routes().length) > 1) pageStack.pop();
}
/** How many details are open over the list. */
export const detailDepth = () => pageStack.routes().length - 1;

function resetPages() {
  if (untracked(() => pageStack.routes().length) > 1) pageStack.setRoutes(["section"]);
}

// ------------------------------------------------------------------------------------- appearance

export type Appearance = "system" | "light" | "dark";
const appearance = signal<Appearance>("system");
export const currentAppearance = () => appearance();
export function setAppearance(a: Appearance, persist = true) {
  appearance.set(a);
  setColorScheme(a);
  if (persist) void Storage.setItem("appearance", a).catch(() => undefined);
}

// ------------------------------------------------------------------------------------- labels

export const rangeLabels: Record<RangeId, { short: string; long: string }> = {
  today: { short: "Today", long: "Today" },
  "7d": { short: "7d", long: "Last 7 days" },
  "30d": { short: "30d", long: "Last 30 days" },
  "90d": { short: "90d", long: "Last 90 days" },
  "12mo": { short: "12mo", long: "Last 12 months" },
};

export const dimLabels: Record<Dim, string> = {
  path: "Page",
  entry: "Entry page",
  exit: "Exit page",
  referrer: "Referrer",
  country: "Country",
  browser: "Browser",
  os: "OS",
  device: "Device",
  screen: "Screen size",
  app_version: "App version",
  utm_source: "UTM source",
  utm_medium: "UTM medium",
  utm_campaign: "UTM campaign",
  event: "Event",
};
