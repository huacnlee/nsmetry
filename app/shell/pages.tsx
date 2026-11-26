/**
 * The content area: one page stack under the top bar, in both layouts (app/DESIGN.md, "Navigation
 * model"). Its root page is the current section's screen; a screen pushes a record's detail over it
 * with `openDetail`. Every page scrolls on its own, led by the filter bar, in the content column.
 *
 * One instance whatever the width (the shell swaps only its chrome at the breakpoint), so a detail
 * stays open when the window crosses 900pt. The store resets the stack on a section or site change.
 */
import type { Component, JSX } from "nsh";
import { computed, Scroll, View } from "nsh";
import { closeDetail, currentSection, currentSiteId, type DetailPage, isOwner, pageStack, type Section } from "../store";
import { EmptyState, Heading, PageHeader, pageInset, PageStack, space, StackPage, systemHeader, Txt, width } from "../ui";
import { FilterBar, openAddSite } from "./controls";
import { labelOf } from "./nav";

/** A page's scroll: the filter bar, then the page, in the content column of the layout. */
function PageScroll(props: { wide: boolean; children?: JSX.Element }) {
  return (
    <Scroll class="flex-1" contentClass="items-center">
      <View
        class="w-full gap-4"
        style={{
          maxWidth: width.content,
          paddingHorizontal: pageInset(props.wide),
          paddingTop: props.wide ? space[5] : space[2],
          paddingBottom: props.wide ? space[5] : space[6],
        }}
      >
        <FilterBar />
        {props.children}
      </View>
    </Scroll>
  );
}

/** The sections that read a site's numbers, and so have nothing to show before one is chosen. */
const SITE_SECTIONS: readonly Section[] = ["overview", "users", "events", "pages", "sources", "geography", "tech"];

/** What an analytics section shows on an instance with no site yet, instead of loading forever. */
function NoSite() {
  return (
    <EmptyState
      testID="no-site"
      icon="geography"
      title="No site yet"
      body={isOwner()
        ? "Add a website (example.com) or an app (a bare name such as my-app), then install the tracker from Settings."
        : "The administrator has not shared a site with you yet."}
      action={isOwner() ? { label: "Add site", onPress: openAddSite } : undefined}
    />
  );
}

/** The current section's screen; only a section change (or a first site) makes a new one. */
function CurrentScreen(props: { screens: Record<Section, Component> }) {
  // A boolean, so switching between two sites does not rebuild the screen (its resources reload).
  const hasSite = computed(() => currentSiteId() !== null);
  return () => {
    const s = currentSection();
    if (SITE_SECTIONS.includes(s) && !hasSite()) return <NoSite />;
    const Screen = props.screens[s];
    return <Screen />;
  };
}

/** A pushed detail: the header with the way back, the record's name, then the screen's content. */
function DetailView(props: { page: DetailPage; wide: boolean }) {
  // Built once, when the page is pushed: the content is the screen's own component.
  const page = props.page;
  const content = page.content();
  const actions = page.actions?.();
  // The section it was opened from (a section change resets the stack, so it is this one).
  const from = labelOf(currentSection());
  return (
    <StackPage
      testID={page.testID}
      title={page.title()}
      header={<PageHeader testID={`${page.testID}-header`} backLabel={from} onBack={closeDetail} meta={page.meta?.()} actions={actions} wide={props.wide} />}
    >
      <PageScroll wide={props.wide}>
        <View class="gap-5">
          <If when={!systemHeader || page.meta?.()}>
            <View class="gap-0.5">
              <If when={systemHeader && page.meta?.()}>
                <Txt size="caption" tone="muted" class="font-mono" truncate>{page.meta?.()}</Txt>
              </If>
              <If when={!systemHeader}>
                <Heading size="heading" testID={`${page.testID}-title`}>{page.title()}</Heading>
              </If>
            </View>
          </If>
          {content}
        </View>
      </PageScroll>
    </StackPage>
  );
}

export function Pages(props: { screens: Record<Section, Component>; wide: boolean }) {
  return (
    <PageStack state={pageStack} testID="pages">
      {(route) =>
        route === "section" ? (
          <StackPage root title={labelOf(currentSection())} testID="page-section">
            <PageScroll wide={props.wide}>
              <CurrentScreen screens={props.screens} />
            </PageScroll>
          </StackPage>
        ) : (
          <DetailView page={route} wide={props.wide} />
        )
      }
    </PageStack>
  );
}
