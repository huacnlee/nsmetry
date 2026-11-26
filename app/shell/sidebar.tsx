/**
 * The wide layout's sidebar (allsum §4: 13pt items 30pt tall, the current one weight 500 on the
 * active wash, on the warm sidebar color). The brand sits top-left; on a desktop window with a hidden
 * title bar it clears the system's window controls. The current item's wash is the Tabs indicator,
 * so it slides between items natively (at once under reduced motion). The items are `ui` NavItems.
 */
import { View } from "nsh";
import { isAvailable as hasWindow, titleBar } from "nsh/desktop";
import { currentSection, go, isOwner } from "../store";
import { Glyph, NavItem, NavList, size, Txt } from "../ui";
import { type NavItem as NavEntry, navItems } from "./nav";

export function Brand() {
  return (
    <View class="flex-row items-center gap-2">
      <View class="items-center justify-center rounded-(--radius) bg-primary" style={{ width: size.brandMark, height: size.brandMark }}>
        <Glyph name="activity" size={size.iconSm} tone="on-primary" />
      </View>
      <Txt size="lead" weight="semibold">NsMetry</Txt>
    </View>
  );
}

function NavGroup(props: { items: readonly NavEntry[]; label: string }) {
  return (
    <NavList accessibilityLabel={props.label}>
      <Each of={props.items}>
        {(item) => (
          <NavItem
            testID={`nav-${item().id}`}
            label={item().label}
            icon={item().icon}
            selected={currentSection() === item().id}
            onPress={() => go(item().id)}
          />
        )}
      </Each>
    </NavList>
  );
}

/**
 * Brand and nav items share one left edge: the sidebar's 8pt padding plus each
 * row's own 8pt inset, so their glyphs sit in one column.
 */
export function Sidebar() {
  const visible = () => navItems.filter((n) => !n.ownerOnly || isOwner());
  const top = () => (hasWindow ? titleBar().height : 0);
  return (
    <View class="border-r border-sidebar-border bg-sidebar px-2 pb-3" style={{ width: size.sidebar }}>
      <View class="justify-end px-2" style={{ height: size.topBar + top(), paddingTop: top() }}>
        <Brand />
      </View>
      <View class="pb-2" />
      <NavGroup label="Analytics" items={visible().filter((n) => n.group === "analytics")} />
      <View class="px-2 pt-5 pb-1">
        <Txt size="caption" tone="faint">Instance</Txt>
      </View>
      <NavGroup label="Instance" items={visible().filter((n) => n.group === "instance")} />
    </View>
  );
}
