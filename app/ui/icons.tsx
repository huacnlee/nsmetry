/**
 * The app's icon set: Lucide, through `nsh-icon`. One place names every glyph the app uses, so a
 * screen asks for `"sources"`, not a Lucide constant, and a later swap of a glyph touches one line.
 * Icons draw in the inherited text color; `Glyph` takes the same tones as `Txt`.
 */
import { Icon } from "nsh-icon";
import * as L from "nsh-icon-lucide";
import type { Tone } from "./text";

export const glyphs = {
  search: L.Search,
  chevronDown: L.ChevronDown,
  chevronLeft: L.ChevronLeft,
  chevronRight: L.ChevronRight,
  plus: L.Plus,
  close: L.X,
  sun: L.Sun,
  moon: L.Moon,
  system: L.Monitor,
  settings: L.Settings,
  menu: L.Menu,
  check: L.Check,
  overview: L.LayoutDashboard,
  users: L.Users,
  events: L.Zap,
  pages: L.FileText,
  sources: L.Share2,
  geography: L.Globe,
  tech: L.Cpu,
  team: L.UsersRound,
  agents: L.Bot,
  signOut: L.LogOut,
  copy: L.Copy,
  calendar: L.Calendar,
  up: L.ArrowUpRight,
  down: L.ArrowDownRight,
  compare: L.GitCompare,
  filter: L.Filter,
  empty: L.Inbox,
  error: L.AlertCircle,
  info: L.Info,
  ok: L.CircleCheck,
  link: L.Link,
  trash: L.Trash2,
  mail: L.Mail,
  key: L.KeyRound,
  server: L.Server,
  activity: L.Activity,
  // A detail page's header (open elsewhere, more) and pagers.
  expand: L.Maximize2,
  external: L.ExternalLink,
  website: L.Globe,
  source: L.FolderGit2,
  more: L.Ellipsis,
  back: L.ArrowLeft,
  forward: L.ArrowRight,
  minus: L.Minus,
  refresh: L.RefreshCw,
  loader: L.LoaderCircle,
  // Install tabs, people and agents (Settings, Team, Agents screens).
  code: L.Code,
  terminal: L.SquareTerminal,
  phone: L.Smartphone,
  package: L.Package,
  sparkles: L.Sparkles,
  plug: L.Plug,
  unplug: L.Unplug,
  userPlus: L.UserPlus,
  clock: L.Clock,
  // Insights screens (Overview, Pages, Sources, Geography, Tech): section tabs and the live panel.
  entry: L.LogIn,
  exit: L.LogOut,
  route: L.Route,
  campaign: L.Megaphone,
  medium: L.Signpost,
  tag: L.Tag,
  browser: L.AppWindow,
  screenSize: L.Ruler,
  map: L.Map,
  live: L.Radio,
} as const;
export type GlyphName = keyof typeof glyphs;

const toneClass: Record<Tone, string> = {
  default: "text-foreground",
  soft: "text-soft",
  muted: "text-muted-foreground",
  faint: "text-faint",
  brand: "text-brand",
  link: "text-link",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  "on-primary": "text-primary-foreground",
};

/** A glyph. Decorative unless it gets a `label` (an icon that stands alone and means something). */
export function Glyph(props: { name: GlyphName; size?: number; tone?: Tone; label?: string; class?: string }) {
  return (
    <Icon
      icon={glyphs[props.name]}
      size={props.size ?? 16}
      strokeWidth={1.75}
      label={props.label}
      class={`${toneClass[props.tone ?? "default"]} ${props.class ?? ""}`}
    />
  );
}
