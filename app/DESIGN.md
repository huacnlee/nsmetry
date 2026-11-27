# NsMetry app: design system

The NSH app (web, desktop, mobile) of NsMetry. The visual language comes from allsum-io
(warm neutral greys, one blue accent, 13pt UI on a 4pt grid, headings by weight) and Linear's
issue views (soft status pills, underline tabs, "+ X" filter chips, grouped sections, a record's
detail on a page of its own pushed over the list). Where allsum and the NSH Design Guides disagree, the Guides win: every
control keeps a visible focus ring, and touch screens get 44pt (iOS) / 48dp (Android) targets.

Screens never pick a color, size, radius or duration of their own: they compose `app/ui`.

## Tokens

### Color (`app/theme.json`, read as classes `bg-elevated`, `text-soft` or `token("…")`)

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | `#ffffff` | `#131312` | Page |
| `sidebar` | `#f7f6f3` | `#191918` | Sidebar, code blocks, sign-in backdrop |
| `elevated` / `popover` | `#ffffff` | `#2a2a28` | Menus, popovers, dialogs, the selected segment |
| `hover` | black 4.5% | white 6% | Hover wash, segmented track, skeletons, group headers |
| `pressed` | black 7.5% | white 10% | Pressed / selected wash, pill tab selection |
| `border` / `border-strong` | black 8% / 15% | white 9% / 16% | Hairlines / dashed chips, emphasis |
| `foreground` / `soft` / `muted-foreground` / `faint` | `#1f1e1c` / `#3d3b37` / `#6f6c65` / `#a19e97` | `#e8e6e1` / `#c3c0b9` / `#8e8b84` / `#65625c` | Text levels |
| `brand` / `brand-strong` / `on-brand` | `#2563eb` / `#1d4ed8` / white | `#60a5fa` / `#3b82f6` / `#0b1324` | Accent, first chart series, links |
| `brand-soft`, `bar` | brand tints | brand tints | Filter chips, chart area, breakdown fill bars |
| `primary` | `#1f1e1c` | `#e8e6e1` | The primary button: text color as fill |
| `ok` / `warn` / `bad` | green / amber / red | lighter in dark | Status only (deltas, pills, errors) |
| `compare` | faint | faint | The dashed comparison series |
| `ring` | brand | brand | Keyboard focus ring |
| `scrim`, `shadow`, `shadow-near` | | | Backdrops and the float/popup shadows |

### Geometry (`app/ui/tokens.ts`)

- Type scale (pt): micro 11, caption 12, ui 13, table 14, lead 15, title 17, heading 20, display 27;
  UI steps +2 on touch screens. Headings are weight 600 (`Heading`), not larger sizes alone.
- Spacing on the 4pt grid. Radii: 4 (`--radius-sm`), 6 (`--radius`, controls), 8 (`--radius-card`,
  menus, cards), 10 (`--radius-panel`), pill.
- Sizes: control 28 (touch 44/48), compact 24 (touch 36), menu / list row 30 / 32 (touch 44/48),
  top bar 46, sidebar 248, badge 18, status pill 22, tag 20, filter chip 24 (touch 32), tab strip
  34 (touch 44/48) with a 2pt indicator, table header 30, checkbox 16 (touch 20), switch 32×18
  (touch 44×26), sparkline 28, tab bar 56 on touch. Widths (`width`): dialog 420, picker 240 × 360, property label 112 (touch 96), tooltip 260. Paddings
  (`pad`): control 12, compact 8, field 10. Every control reads these; no literal sizes in `app/ui`.
- Touch targets: anything pressable is at least 44pt (iOS) / 48dp (Android) tall on touch screens,
  or reaches it with `hitSlop` (icon buttons, chips, checkbox, switch).
- Elevation: flat surfaces with a 1px border; only floating things get a shadow: dialogs and toasts
  `elevation.float()`, menus, selects and popovers the lighter `elevation.popup()` (their border
  already sets them apart); the selected segment gets `elevation.raised()`.
- System fonts only; monospace (`font-mono`) for ids, versions, code and secondary table columns.

### Motion (`motion` in `app/ui/tokens.ts`)

| Token | Value | Used for |
| --- | --- | --- |
| `instant` | 120ms | Hover / press washes, popup exit, toast exit, chart hover |
| `fast` | 180ms | Popup entrance, chevron turn, chip entrance, metric tile underline |
| `base` | 240ms | Screen and step entrances, share and fill bars, chart domain changes |
| `slow` | 360ms | Chart draw-in on a new range / metric / filter |
| `slower` | 500ms | Reserved (large layout moves) |
| `settle` | `cubic-bezier(0.22, 1, 0.36, 1)` | Every entrance and value change |
| `press` | control 0.97, icon 0.95, row 0.99 | Press scale |
| `popDistance` | 4pt | Popups slide out of their trigger |

Reduced motion: every transition carries `motion-reduce:transition-none` or
`motion-reduce:animate-none`; NSH itself runs `createMotion`, springs (Tabs indicators,
Collapsible reveal, Sheet) and plots at once under reduced motion.

## Components (`app/ui`)

| Component | File | Variants and states |
| --- | --- | --- |
| `Button` | button.tsx | primary (ink fill, hover 90%), outline, ghost, danger; sm / md; icon, trailing; hover, pressed (scale), focus ring, disabled, selected, busy (spinner in place of the icon) |
| `IconButton` | button.tsx | sm / md; tone muted / default / ok / bad; selected, disabled; tooltip (its label) |
| `TextInput`, `Textarea`, `Field` | input.tsx | invalid, disabled, focus (ring border + outline); label, hint, error |
| `Checkbox` | feedback.tsx | checked, indeterminate, invalid, disabled; hover, focus ring; label in the target |
| `Switch` | feedback.tsx | on / off, disabled; hover track, focus ring; thumb slides over `fast` |
| `Spinner` | feedback.tsx | Turning loader; busy buttons use it; still under reduced motion |
| `Tooltip` | feedback.tsx | The bubble of a view's `tooltip` (ink on page color); `IconButton` shows its label by default |
| `Separator` | feedback.tsx | Hairline, horizontal or vertical, optional inset |
| `Segmented` | segmented.tsx | Range picker: hover track, raised selected segment that springs between options; `layout` fit (segments as wide as their labels, never truncated; default) or stretch (spans the row, segments grow from their labels) |
| `NavList`, `NavItem`, `NavButton` | nav.tsx | Sidebar sections on a springing accent wash (hover wash, press 0.99, focus ring); `NavButton` is a left-aligned nav-row trigger (the site switcher) |
| `TabBarList`, `TabBarItem`, `TabBarButton`, `SheetNavRow` | nav.tsx | Phone tab bar: brand-toned selected item on a brand-soft wash that springs between tabs; `TabBarButton` is the same look for an action ("More"), selected wash in place; sheet rows |
| `ActionMenu` | menu.tsx | `Menu` with the app's popup look; trigger a `Button`, `NavButton` or `AvatarButton` |
| `AvatarButton` | button.tsx | Round initial on the pressed wash, hover, press 0.95, focus ring (the account menu) |
| `Select` | menu.tsx | On `nsh/base` Select: ghost / outline trigger, sm / md, placeholder, searchable, groups, disabled items, disabled; a sheet on phones |
| `MenuRow`, `MenuSep`, `MenuLabel`, `PopoverPanel` | menu.tsx | Action menus on `Menu`: checked, icon, hint, danger, disabled rows; 4pt padding, 8pt radius, popup shadow |
| `Card`, `Panel`, `Divider` | surfaces.tsx | Inset |
| `Badge` | surfaces.tsx | 18pt; neutral, brand, ok, bad |
| `PillTabs` | surfaces.tsx | Selected on the pressed wash (sliding indicator); hover wash, press scale |
| `UnderlineTabs` | tabs.tsx | Leading icons, counts; 2pt underline springs between tabs |
| `GroupSection` | tabs.tsx | Tinted rounded header, chevron, icon, name, muted count, actions; reveal |
| `EmptyState`, `Skeleton` | surfaces.tsx | Icon, body, action (empty and error states); pulsing skeleton |
| `Modal`, `BottomSheet`, `ConfirmDialog` | overlays.tsx | Dialogs fade with their backdrop; on phones a form `Modal` is a bottom sheet that rides on the keyboard, its actions full width (primary on top), and a confirmation stays a centered dialog; the bottom sheet (phones' "More") slides up, swipe closes; both clear the home indicator |
| `PageStack`, `StackPage`, `PageHeader` | stack.tsx | On `nsh/base` NavStack / NavPage: the content area's page stack. `PageHeader` is the desktop / web header of a pushed page (a 46pt bar on a hairline: ghost "‹ Section" back button, mono muted meta line, trailing actions, aligned to the content column); iOS and Android show their system header with its back button and swipe instead |
| `toast`, `ToastHost` | overlays.tsx | info, ok, error; swipe away |
| `BarRow` | list-row.tsx | Proportional fill bar; pressable (adds a filter) or static |
| `MetricTile` | metric-tile.tsx | Delta colored by `better`; sparkline slot; selectable |
| `StatusPill`, `Tag` | data.tsx | ok / warn / bad / neutral / brand; pulsing dot |
| `ShareBar` | data.tsx | Thin two-tone bar; brand / ok / warn / bad |
| `PropertyList` | data.tsx | Muted labels, text (mono) or element values |
| `Timeline` | data.tsx | Dot connectors, avatars, right-aligned times |
| `DataTable` | data.tsx | 14pt rows, muted 13pt headers, mono muted columns, pressable rows (buttons with a focus ring), `hideBelow` columns on narrow widths, empty slot |
| `Avatar` | data.tsx | Initial dot |
| `CodeBlock`, `InlineCode` | data.tsx | Copy button swapping to a check |
| `FilterChip`, `AddFilterChip` | filter-chip.tsx | Removable chip; dashed "+ X" chip opening a searchable picker (loading, error, nothing matches) |
| `TimeSeries`, `Bars`, `Sparkline` | charts.tsx | On `nsh/base/plot` only: brand first series on a soft area, dashed `compare` series, hairline grid, 11pt faint axes |
| `Txt`, `Heading`, `Glyph` | text.tsx, icons.tsx | Lucide glyphs through `Glyph` only (no text characters as icons) |

Every control is in the gallery: `nsh run app/gallery.tsx`, or the account menu's "UI gallery" in
development builds. `app/gallery.test.tsx` checks it and, on a real target
(`nsh test app/gallery.test.tsx --target macos`), saves screenshots to `app/shots/`.

## Layout

- 900pt and wider: sidebar (248pt, brand "NsMetry" top-left, Analytics and Instance groups) and a
  46pt top bar that is the title bar's own row (site switcher leading, then range, compare,
  account, all on one vertical center). Content max 1200pt, 24pt side padding.
- Narrower: compact top bar (site, account; the brand only in a desktop window), below the status
  bar and clear of the notch on phones, the range across the width (`Segmented` `layout="stretch"`)
  with Compare as an icon beside it, the filter chips in one row that scrolls sideways, pull to
  refresh on touch screens, and a bottom tab bar (Overview, Users, Pages, Sources as tabs; for an
  app, Overview, Users, Events, Pages; "More" a button beside the tab list, so arrow keys never open
  its sheet) with the rest in a bottom sheet.
- An app (a site named without a dot, `isAppSite`) is read by its users: its Overview leads with
  active and new users and the daily chart, then screens, events, platforms, app versions and
  countries. Referrers, UTM tags, entry and exit pages, browsers, bounce rate and visit duration are
  left out, and Sources is not in the navigation.
- The sidebar's brand and sections (`NavItem`) share one left edge.
- Data details open as pages on a NavStack (`openDetail`), never in a sheet.
- Desktop windows hide the system title bar; the shell keeps clear of the window controls.
- The filter bar sits above every screen: applied chips, then "+ Page / Referrer / Country /
  Device / App version" (only real filter dimensions: events, entry and exit pages rank but do not
  filter, docs/api.md). It leads every page's scroll, detail pages included (their data is scoped
  by the same filters).

## Navigation model

Data detail is never a sheet: it is a page pushed on a `NavStack`.

- The content area under the top bar (both layouts) is one `NavStack` (`shell/pages.tsx`, state
  `pageStack` in `store.ts`), a single instance whatever the width, so crossing the 900pt breakpoint
  keeps the open detail. Its root page is the current section's screen (filter bar, then the screen,
  in its own scroll). A screen pushes a detail with `openDetail({ title, meta, actions, content,
  testID })`; the content is the screen's own component, so it reads the screen's live loads.
- What pushes: an event row (Events), a person (Team), an agent (Agents), and the "<Dimension>
  details" button of a filtered value (Pages "Route details", Sources, Geography "Country details",
  Tech). A breakdown row still adds a filter (the row's own job); on Pages a page row also pushes
  that route (filtering by one page is a question about it). Values inside a detail page do not push further.
- Back: the page header's "‹ Section" button, Escape, the mouse's back button and the browser's back
  on desktops and the web; the system back button and the edge swipe on iOS, back and predictive
  back on Android. The list under it stays mounted, so its scroll position, tab and loads are as
  they were.
- Section change (sidebar, tab bar, "More"): the stack resets to the root and the new screen fades
  up (sibling sections cross-fade, they do not slide). Pressing the current section again pops to
  its list.
- Site change and sign-out: reset (a detail names a value of one site). Range, compare and filters:
  the stack is kept and the open detail reloads for the new scope (its own value stays forced).
- Destructive actions inside a detail ("Remove access…", "Disconnect…") still ask in a
  `ConfirmDialog` over the page; on success the page pops.
- The phone "More" sheet is navigation, not data detail: it stays a `BottomSheet`.

## Motion inventory

### Shell
- Section change: the new screen fades up 6pt over `base` (createMotion in `ScreenFrame`).
- Sidebar selection: the accent wash springs to the new item (Tabs indicator); items wash on hover
  over `instant` and press to 0.99.
- Tab bar selection (phones): the brand-soft wash springs to the new tab (Tabs indicator) as glyph
  and label turn brand over `instant`; tabs press to 0.97. Going to a section under "More" hides the
  tab wash and "More" takes the same wash in place (it is a button, not a tab).
- Range picker: the raised segment springs to the new range (Tabs indicator).
- Compare toggle: wash over `instant`; charts redraw (see charts).
- Filter added: its chip fades and scales in from 0.96 over `fast`; the "+ X" chip of that
  dimension leaves at once. Filter removed: chip leaves at once, the "+ X" chip returns.
- Site switcher / account / "+ X" pickers: popups grow from their trigger (96%, 4pt, `fast`),
  leave over `instant`; on phones menus are sheets that slide up.
- Add site dialog: backdrop and dialog fade (`Dialog animation="fade"`).
- More sheet (phones): slides up with its backdrop; swipe down closes.
- Detail pushed / popped: `NavStack`'s native transition, forward on push and backward on pop
  (iOS UINavigationController slide with the edge swipe following the finger, Android's predictive
  back, the desktop / web stack's own push); the list beneath keeps its place. A section change
  resets the stack and cross-fades by the new screen's fade-up instead of sliding. Reduced motion:
  pages appear and leave at once (NSH runs the stack transition at once).
- Page header back button: ghost wash on hover over `instant`, press 0.97, focus ring.
- Toasts: in from below over `fast`, out over `instant`, swipe away.
- Boot: a breathing skeleton under the brand.

### Sign-in
- Email step to code step: the code step slides in 16pt from the right and fades over `base`.
- Errors and notices appear in place (no motion), announced as alerts.
- Busy buttons show "…" and stay their size.

### Gallery (and every screen that uses the components)
- Buttons: hover wash `instant`, press scale 0.97 / icons 0.95.
- Underline tabs, pill tabs, segmented: indicator springs natively.
- Group section: chevron turns 90° over `fast`; content reveals with a height spring.
- Page header: the back button washes on hover over `instant` and presses to 0.97; the page itself
  moves with the stack's push / pop.
- Share bar / breakdown fill bars: `scaleX` over `base` on a value change.
- Charts: draw in over `slow` when the data's identity changes; domain glides over `base`.
- Metric tile: selected underline fades over `fast`.
- Code block: copy glyph swaps to a check for 1.5s.
- Status pill "Live": the dot breathes.
- Segmented and pill tabs: unselected segments wash on hover over `instant`; pill tabs press to 0.97.
- Checkbox: the mark fades and scales from 0.6 over `instant` on the settle curve.
- Switch: the thumb slides and the track tints over `fast` on the settle curve.
- Select: the list grows out of its trigger like every popup (`fast` in, `instant` out); a sheet on phones.
- Tooltip: fades and rises 4pt over `fast`, leaves over `instant`.
- Toast: enters over `fast` from 8pt below, leaves over `instant` shrinking to 95%.
- Spinner: turns continuously; stands still under reduced motion.
- Menu row check: fades over `instant`.

### Screens (filled by the next agents)
Each screen's owner adds its inventory here before writing it: Overview, Users, Events,
Pages / Screens, Sources, Geography, Tech, Settings, Team, Agents.

### Settings (per-site install)
- Screen: fades up 6pt over `base` (ScreenFrame). Reduced motion: appears at once.
- Status pill ("Live" / "No events in 7 days"): appears in place when the check returns; the Live dot
  breathes (`animate-pulse`), still under reduced motion. While checking, a "Checking" neutral pill (no motion).
- Install tabs (Website · HTTP API · NSH app · JavaScript · AI agent): the underline springs to the
  chosen tab (Tabs indicator); the tab's body is rebuilt and fades up 4pt over `fast` on the settle
  curve (createMotion), so the swap reads as one place changing. Reduced motion: underline and body at once.
- Copy buttons (every snippet): copy glyph swaps to a check for 1.5s (CodeBlock); press scale 0.95.
- Script URL (admin): Save shows the busy spinner in place of its glyph, width kept; the error appears
  under the field as an alert (no motion: it must be read, not watched); success is a toast (`fast` in).
- Remove site (admin): confirm dialog fades with its backdrop (`Dialog animation="fade"`); the confirm
  button goes busy; on success the site leaves the switcher and the screen re-renders for the next site
  (the ScreenFrame fade-up), with a toast.
- Loading: none beyond the pill; everything else is already known (account, server, site).
- Drag / live: none.

### Team (admin only)
- Rows: hover wash `instant`, pressed wash `pressed` (rows deepen, never scale), focus ring.
- Invite…: dialog fades in with its backdrop; email field focused; Invite goes busy; a refusal (409 /
  400) appears under the field as an alert; success closes the dialog (fade) and the new person's row
  arrives in the table (the list reloads in place) with a toast.
- Person page: pushed over the list (stack transition, see Shell); back pops it with the list where
  it was. Site checkboxes: mark fades and scales from 0.6 over `instant`. Save enables when the
  selection differs, goes busy while saving, toast on success.
- Remove access…: the confirm dialog fades in over the person page; on success the page pops and the
  row is gone from the list beneath. Reduced motion: every surface opens and closes at once.
- Loading: three breathing skeleton rows; error: EmptyState fade-up with "Try again".

### Agents
- Connected list rows: hover / pressed washes as tables; a row pushes the agent's page (stack
  transition); its activity timeline is static.
- Disconnect…: confirm dialog fades in over the page, confirm goes busy, on success the page pops and
  the row has left the list, toast. Empty list: EmptyState fades up 6pt over `base`.
- Connect an agent: client pill tabs (Claude Code · Claude Desktop · Cursor · Other); the pill wash
  springs (Tabs indicator) and the body fades up 4pt over `fast`. Copy glyph swaps to a check for 1.5s.
- Loading: skeleton rows (breathing); reduced motion stills them.

### Overview, Pages, Sources, Geography, Tech, realtime (insights screens)
Shared by these screens: every line below runs at once under reduced motion (the ui controls carry
`motion-reduce:` classes; NSH runs plots, `createMotion`, springs and the page stack at once).

| Change | Motion |
| --- | --- |
| Screen shown | `ScreenFrame` fade-up 6pt over `base` (shell). |
| Metric tile hover / press | Hover wash `instant`, press 0.97 (MetricTile). |
| Metric selected | Selected tile's brand underline fades over `fast`; the hero chart redraws in over `slow` (`generation` = metric + range + filters + compare). |
| Compare toggled | Hero chart: dashed `compare` series draws in with the redraw (`slow`); tile deltas appear in place (text, no motion: values, not places). |
| Range / filter / site changes | Hero chart and sparklines redraw over `slow`; breakdown fill bars glide by `scaleX` over `base`; values swap in place. |
| Loading | Skeleton rows / tiles breathe, then the content takes their place (no pop: same height). |
| Section tabs (underline, pill) | The indicator springs to the new tab (ui); rows of the new dimension glide their bars over `base`. |
| Row hover / press | BarRow wash `instant`, press 0.99; pressing adds a filter, whose chip scales in over `fast` (shell). |
| Route / source / country / tech value detail opens | The value's page is pushed (stack transition, see Shell); back pops it to the list as it was. "Remove the … filter" on the page removes the chip (it leaves at once) and pops. |
| Live: online count changes | The "Live" status pill's dot breathes while anyone is online; the number swaps in place (it updates every 30 s, a place that does not move). |
| Live: per-minute bars | Bars grow on first draw (`slow`, 0.3 stagger), later polls glide the domain over `base` (no redraw: same `generation`). |
| Live: recent feed | New entries take their slot at the top; the feed is a bounded list of 8, so no wave (a tick plays nothing, per the guides). |
| World map | Draws at once on load (a static picture); the hovered country's outline swaps at once (pointer-follow, no lag); the hover caption swaps in place. |
| Errors / empty | `EmptyState` in place, no motion; "Try again" presses like every button. |

### Users (app analytics)

| Change | Motion |
| --- | --- |
| Screen enters / range changes | Tiles' sparklines draw in over `slow`; the DAU + new chart redraws (new `generation`), both lines drawing in together; numbers swap in place. |
| Chart hover | Crosshair and hover dots follow the pointer at once; the tooltip (Active / New) swaps in place. |
| Retention cohort (Daily / Weekly) | `Segmented` indicator springs to the pressed option; the heatmap cells grow in staggered (`slow`, 0.4 stagger) as the new grid loads. |
| Heatmap hover | Hovered cell keeps full color, the others fade to 55% over `fast`; the tooltip (cohort, period, share) follows the pointer. |
| Filter added | Nothing reloads (users ignore filters); the "filters do not apply" note fades up in place. |
| No user ids (setup) | `PillTabs` indicator slides between NSH app / JavaScript / HTTP; the snippet swaps in place; the code block's copy glyph swaps to a check and back. |
| Loading / errors | Skeletons pulse; `EmptyState` fades up with "Try again". |

### Events

| Change | Motion |
| --- | --- |
| Table loads / scope changes | Rows appear in place; share bars grow from the left over `base` (`scaleX`). |
| Row hover / press | Row wash over `fast`; press pushes the event's page. |
| Event page | Pushed with the stack's transition; back (header button, Esc, swipe) pops it to the table, scroll kept. Counts follow the table's live row, so a range change updates them in place. |
| Event trend | Count and users lines draw in (`generation` = event name, so another event redraws, a refetch glides). |
| Property group toggle | Chevron rotates over `fast`; the values reveal with a height spring and load only then (skeleton rows pulse meanwhile); value bars grow over `base`. |
| No trend endpoint / errors / empty | Muted note or `EmptyState` in place, no motion. |
| Reduced motion | Everything above is instant: no draw-in, stagger, slide or spring. |
