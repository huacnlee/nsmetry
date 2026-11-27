/**
 * The narrow layout's navigation: a bottom tab bar of the four main sections, and "More", a button
 * beside the tab list (it opens a sheet; it is not a tab, so the list's arrow keys never open it)
 * with the rest in a bottom sheet. Items are 44pt (48dp) targets; the selected one is brand-toned on
 * a brand-soft wash that springs between tabs (the Tabs indicator). While the current section is one
 * of "More"'s, no tab is selected and "More" carries the wash and the section's name.
 */
import { safeAreaInsets, signal, View } from "nsh";
import { currentSection, currentSite, go, isOwner, type Section } from "../store";
import { BottomSheet, SheetNavRow, size, TabBarButton, TabBarItem, TabBarList } from "../ui";
import { isAppSite, labelOf, navItems, tabBarItemsFor, visibleNav } from "./nav";

export function TabBar() {
  const more = signal(false);
  const insets = safeAreaInsets();
  const app = () => isAppSite(currentSite()?.domain);
  const tabBarItems = () => tabBarItemsFor(app());
  const inMore = () => !tabBarItems().includes(currentSection());
  const rest = () => visibleNav(app(), isOwner()).filter((n) => !tabBarItems().includes(n.id));
  const icon = (id: Section) => navItems.find((n) => n.id === id)?.icon ?? "overview";
  return (
    <View class="border-t border-border bg-background" style={{ paddingBottom: insets().bottom }}>
      <View class="flex-row" style={{ height: size.tabBar }}>
        <TabBarList accessibilityLabel="Sections">
          <Each of={tabBarItems()}>
            {(id) => (
              <TabBarItem
                testID={`tab-${id()}`}
                label={labelOf(id())}
                icon={icon(id())}
                selected={currentSection() === id()}
                onPress={() => go(id())}
              />
            )}
          </Each>
        </TabBarList>
        <TabBarButton
          testID="tab-more"
          label={inMore() ? labelOf(currentSection()) : "More"}
          accessibilityLabel={inMore() ? `More sections, showing ${labelOf(currentSection())}` : "More sections"}
          icon="menu"
          selected={inMore()}
          onPress={() => more.set(true)}
        />
      </View>
      <BottomSheet open={more()} onClose={() => more.set(false)} title="More">
        <Each of={rest()}>
          {(n) => (
            <SheetNavRow
              testID={`more-${n().id}`}
              label={n().label}
              icon={n().icon}
              selected={currentSection() === n().id}
              onPress={() => {
                go(n().id);
                more.set(false);
              }}
            />
          )}
        </Each>
      </BottomSheet>
    </View>
  );
}
