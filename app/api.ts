/**
 * A typed client for the NsMetry HTTP API (docs/api.md, the one contract for every client).
 *
 * Design:
 *  - Every endpoint in the contract is one method on `Api`, typed with the contract's own types.
 *  - Requests go through a `Transport`: `fetchTransport` (the network) by default. A later demo
 *    mode plugs in an on-device transport with `createApi({ transport })` and nothing else changes.
 *  - Errors are thrown as `ApiError` with the status and the server's `{ error }` message, so screens
 *    can show what went wrong. A 401 additionally calls `onUnauthorized`, which the store uses to
 *    move the app to signed-out: a token that expired anywhere signs out everywhere.
 *  - The client holds no state of its own beyond its config: the base URL and token are read through
 *    getters on every request, so the store owns them (and persists them per server).
 */

// ------------------------------------------------------------------------------------- contract types

export type Role = "owner" | "viewer";
export interface PublicUser {
  id: number;
  email: string;
  role: Role;
  created_at: number;
  siteIds: number[];
}
export interface Site {
  id: number;
  /** A domain (`example.com`) or a bare name (`my-app`). */
  domain: string;
  created_at: number;
}
export type RangeId = "today" | "7d" | "30d" | "90d" | "12mo";
export const RANGES: readonly RangeId[] = ["today", "7d", "30d", "90d", "12mo"];
export type Metric = "visitors" | "views" | "vpv" | "bounce" | "time";
export const METRICS: readonly Metric[] = ["visitors", "views", "vpv", "bounce", "time"];
export type Dim =
  | "path" | "entry" | "exit" | "referrer" | "country" | "browser" | "os" | "device" | "screen"
  | "app_version" | "utm_source" | "utm_medium" | "utm_campaign" | "event";
export const DIMS: readonly Dim[] = [
  "path", "entry", "exit", "referrer", "country", "browser", "os", "device", "screen",
  "app_version", "utm_source", "utm_medium", "utm_campaign", "event",
];
export interface Row {
  name: string;
  value: number;
}
/** One `dim:value` filter. */
export interface Filter {
  dim: Dim;
  value: string;
}
export type Granularity = "hour" | "day" | "week" | "month";

export interface StartResponse {
  ok: true;
  /** How the code was delivered: `"log"` means no mail is configured and the code is in the Worker logs (`message` says where). */
  delivery: "smtp" | "email" | "log";
  message?: string;
}
export interface VerifyResponse {
  token: string;
  user: PublicUser;
}
export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  behind: boolean;
}
export interface MeResponse {
  user: PublicUser;
  trackerUrl: string;
  version: string;
  update: UpdateInfo | null;
}
export interface SummaryRange {
  id: RangeId;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  granularity: Granularity;
  prevLabel: string;
}
export interface Summary {
  site: Site;
  range: SummaryRange;
  filters: Filter[];
  totals: Record<Metric, number>;
  previous: Record<Metric, number> | null;
  series: {
    labels: string[];
    cur: Record<Metric, number[]>;
    prev: Record<Metric, number[]> | null;
  };
}
export interface Breakdowns {
  breakdowns: Partial<Record<Dim, Row[]>>;
}
export interface TimeseriesResponse {
  granularity: Granularity;
  points: { label: string; cur: number; prev: number | null }[];
}
export interface Realtime {
  online: number;
  /** The web window behind `online`, in seconds (an app counts as online for 600 s after its last screen). */
  online_window_s: number;
  /** Views per minute by event time; with `since`, only the views that arrived after it. */
  minutes: { label: string; cur: number }[];
  /** Epoch seconds of minutes[0]; minute i starts at first_minute + 60·i. */
  first_minute: number;
  recent: { ts: number; path: string; country: string }[];
  /** Pass back as `since` on the next poll. */
  cursor: string;
  /** The whole 30-minute window (no `since`, or one too old): replace what is held, do not merge. */
  full: boolean;
}
export interface WorldMap {
  width: number;
  height: number;
  /** ISO 3166-1 alpha-2 → SVG path. */
  countries: Record<string, string>;
}
export interface ActiveUsers {
  tracked: boolean;
  labels: string[];
  dau: number[];
  new: number[];
  totals: { active: number; new: number };
  wau: number;
  mau: number;
}
export interface Retention {
  tracked: boolean;
  cohorts: { label: string; size: number; retained: number[] }[];
}
export interface EventRow {
  name: string;
  count: number;
  users: number;
}
/** One event over the range, per bucket of the range's granularity (`/api/event-series`). */
export interface EventSeries {
  labels: string[];
  count: number[];
  users: number[];
}
export interface Grant {
  id: number | string;
  client_name: string;
  created_at: number;
  last_used_at: number | null;
}

/** What every analytics request is scoped by. */
export interface Scope {
  site: number;
  range: RangeId;
  filters?: readonly Filter[];
  /** Ask for the previous period too (`cmp=1`). */
  compare?: boolean;
}

// ------------------------------------------------------------------------------------- transport

export interface TransportRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The full URL, query string included. */
  url: string;
  headers: Record<string, string>;
  /** JSON text, when the request has a body. */
  body?: string;
}
export interface TransportResponse {
  status: number;
  /** The parsed JSON body, or null when there was none / it was not JSON. */
  json: unknown;
}
/** Carries one request. Reject only when no response came (offline, DNS, reset). */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** The network, through the runtime's `fetch`. */
export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
};

// ------------------------------------------------------------------------------------- errors

/** A request that did not succeed: `status` 0 when no response came at all. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
  get unauthorized() {
    return this.status === 401;
  }
  get offline() {
    return this.status === 0;
  }
}

// ------------------------------------------------------------------------------------- helpers

/** Filters as the contract carries them: `dim:value,dim:value`, each value URI-encoded. */
export function encodeFilters(filters: readonly Filter[]): string {
  return filters.map((f) => `${f.dim}:${encodeURIComponent(f.value)}`).join(",");
}

/** A server URL as the user typed it, normalized: a scheme, no trailing slash. */
export function normalizeServer(input: string): string {
  let s = input.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

type Query = Record<string, string | number | boolean | undefined | null>;
function queryString(q: Query): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === false || v === "") continue;
    // `f` is already encoded value by value (encodeFilters); encoding it again would double-encode.
    parts.push(`${k}=${k === "f" ? String(v) : encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
function scopeQuery(s: Scope): Query {
  return { site: s.site, range: s.range, f: s.filters?.length ? encodeFilters(s.filters) : undefined, cmp: s.compare ? 1 : undefined };
}

// ------------------------------------------------------------------------------------- client

export interface ApiConfig {
  /** The instance's origin (`https://stats.example.com`); read on every request. */
  baseUrl: () => string;
  /** The bearer token, or null when signed out; read on every request. */
  token: () => string | null;
  transport?: Transport;
  /** Called after any 401 from an authenticated request. */
  onUnauthorized?: () => void;
}

export type Api = ReturnType<typeof createApi>;

export function createApi(config: ApiConfig) {
  const transport = () => config.transport ?? fetchTransport;

  async function request<T>(method: TransportRequest["method"], path: string, options: { query?: Query; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const base = config.baseUrl();
    const headers: Record<string, string> = { accept: "application/json" };
    const auth = options.auth ?? true;
    const token = config.token();
    if (auth && token) headers.authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let res: TransportResponse;
    try {
      res = await transport()({ method, url: `${base}${path}${queryString(options.query ?? {})}`, headers, body });
    } catch {
      throw new ApiError(0, `Could not reach ${base || "the server"}. Check the address and your connection.`);
    }
    if (res.status >= 200 && res.status < 300) return res.json as T;
    const message =
      res.json && typeof res.json === "object" && typeof (res.json as { error?: unknown }).error === "string"
        ? (res.json as { error: string }).error
        : `Request failed (${res.status})`;
    if (res.status === 401 && auth) config.onUnauthorized?.();
    throw new ApiError(res.status, message);
  }

  const get = <T>(path: string, query?: Query) => request<T>("GET", path, { query });

  return {
    // --- authentication
    startSignIn: (email: string) => request<StartResponse>("POST", "/api/auth/start", { body: { email }, auth: false }),
    verifySignIn: (email: string, code: string) => request<VerifyResponse>("POST", "/api/auth/verify", { body: { email, code }, auth: false }),
    logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),

    // --- account and instance
    me: () => get<MeResponse>("/api/me"),
    setTrackerUrl: (url: string) => request<{ trackerUrl: string }>("PUT", "/api/settings/tracker-url", { body: { url } }),

    // --- sites
    sites: () => get<{ sites: Site[] }>("/api/sites"),
    addSite: (domain: string) => request<{ site: Site }>("POST", "/api/sites", { body: { domain } }),
    deleteSite: (id: number) => request<{ ok: true }>("DELETE", `/api/sites/${id}`),

    // --- people (owner)
    users: () => get<{ users: PublicUser[] }>("/api/users"),
    inviteUser: (email: string, siteIds: number[]) => request<{ user: PublicUser }>("POST", "/api/users", { body: { email, siteIds } }),
    updateUser: (id: number, siteIds: number[]) => request<{ user: PublicUser }>("PATCH", `/api/users/${id}`, { body: { siteIds } }),
    deleteUser: (id: number) => request<{ ok: true }>("DELETE", `/api/users/${id}`),

    // --- analytics
    summary: (s: Scope) => get<Summary>("/api/summary", scopeQuery(s)),
    breakdown: (s: Scope, dims: readonly Dim[], limit?: number) =>
      get<Breakdowns>("/api/breakdown", { ...scopeQuery(s), dim: dims.join(","), limit }),
    timeseries: (s: Scope, metric: Metric) => get<TimeseriesResponse>("/api/timeseries", { ...scopeQuery(s), metric }),
    realtime: (site: number, since?: string) => get<Realtime>("/api/realtime", { site, since }),
    world: () => request<WorldMap>("GET", "/api/world.json", { auth: false }),

    // --- app analytics
    activeUsers: (s: Scope) => get<ActiveUsers>("/api/active-users", scopeQuery(s)),
    retention: (site: number, cohort: "day" | "week" = "week", periods = 8) => get<Retention>("/api/retention", { site, cohort, periods }),
    events: (s: Scope) => get<{ events: EventRow[] }>("/api/events", scopeQuery(s)),
    eventKeys: (s: Scope, event: string) => get<{ keys: { key: string; count: number }[] }>("/api/event-properties", { ...scopeQuery(s), event }),
    eventValues: (s: Scope, event: string, key: string, limit?: number) =>
      get<{ values: Row[] }>("/api/event-properties", { ...scopeQuery(s), event, key, limit }),
    eventSeries: (s: Scope, event: string) => get<EventSeries>("/api/event-series", { ...scopeQuery(s), event }),

    // --- connected agents
    grants: () => get<{ grants: Grant[] }>("/api/oauth/grants"),
    revokeGrant: (id: number | string) => request<{ ok: true }>("DELETE", `/api/oauth/grants/${encodeURIComponent(String(id))}`),
  };
}
