/** The app's sections, in sidebar order, with the glyph and label each shows. */
import type { Section } from "../store";
import type { GlyphName } from "../ui";

export interface NavItem {
  id: Section;
  label: string;
  icon: GlyphName;
  /** Only the instance's owner sees it. */
  ownerOnly?: boolean;
  /** The group it is listed under in the sidebar. */
  group: "analytics" | "instance";
  /** Only for websites: an app (a site named without a dot) has no referrers or UTM tags. */
  webOnly?: boolean;
}

export const navItems: readonly NavItem[] = [
  { id: "overview", label: "Overview", icon: "overview", group: "analytics" },
  { id: "users", label: "Users", icon: "users", group: "analytics" },
  { id: "events", label: "Events", icon: "events", group: "analytics" },
  { id: "pages", label: "Pages", icon: "pages", group: "analytics" },
  { id: "sources", label: "Sources", icon: "sources", group: "analytics", webOnly: true },
  { id: "geography", label: "Geography", icon: "geography", group: "analytics" },
  { id: "tech", label: "Tech", icon: "tech", group: "analytics" },
  { id: "settings", label: "Settings", icon: "settings", group: "instance" },
  { id: "team", label: "Team", icon: "team", ownerOnly: true, group: "instance" },
  { id: "agents", label: "Agents", icon: "agents", group: "instance" },
];

/**
 * An app rather than a website: the site is a bare name (`noop`), not a domain (`example.com`).
 * Apps are counted by their users, screens, events and platforms, not by referrers or bounce rate.
 */
export const isAppSite = (domain: string | null | undefined) => !!domain && !domain.includes(".");

/** The sections a viewer sees for this kind of site. */
export const visibleNav = (app: boolean, owner: boolean) => navItems.filter((n) => (!n.ownerOnly || owner) && !(app && n.webOnly));

/** The phone tab bar's four direct tabs; the rest are under "More". */
export const tabBarItemsFor = (app: boolean): readonly Section[] =>
  app ? ["overview", "users", "events", "pages"] : ["overview", "users", "pages", "sources"];

export const labelOf = (id: Section) => navItems.find((n) => n.id === id)?.label ?? (id === "gallery" ? "UI gallery" : id);
