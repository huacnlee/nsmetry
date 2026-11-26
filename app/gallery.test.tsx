/**
 * The ui gallery renders every control, in light and dark. Headless it checks structure and the
 * stateful demos; on a real target (`nsh test app/gallery.test.tsx --target macos`) its screenshots
 * of both themes land in app/shots/ (a headless run draws nothing).
 */
import { expect, open, test } from "nsh/test";

/** A screenshot on a real target; headless runs draw nothing, so there it is skipped. */
const shot = (app: { screenshot(path?: string | null): Promise<Uint8Array> }, path: string) => app.screenshot(path).catch(() => undefined);


test("every section is there, in light and in dark", async () => {
  const app = await open("./gallery.tsx", { width: 1280, height: 4200, platform: "macos" });
  await app.waitFor("id:gallery");
  for (const t of ["Buttons", "Underline tabs", "Filter chips", "Overlays", "Metric tiles", "Time series"]) {
    expect(app.shows(`text:${t}`)).toBe(true);
  }
  await shot(app, "app/shots/gallery-light.png");
  await app.press("id:gallery-theme-dark");
  await app.wait(400);
  await shot(app, "app/shots/gallery-dark.png");
  app.dispose();
});

test("the detail page pushes and its header goes back; underline tabs select", async () => {
  const app = await open("./gallery.tsx", { width: 1280, height: 900, platform: "macos" });
  await app.waitFor("id:gallery");
  await app.press("id:gallery-tabs-web");
  expect(app.accessibility("id:gallery-tabs-web")?.selected).toBe(true);
  await app.press("role:button[checkout_completed, 1,204]");
  await app.waitFor("id:gallery-detail-header");
  expect(app.shows("text:my-app · event · Last 7 days")).toBe(true);
  await app.wait(400);
  await shot(app, "app/shots/gallery-detail-light.png");
  await app.press("id:gallery-detail-header-back");
  await app.waitFor("id:gallery-detail", { state: "gone" });
  expect(app.shows("text:The list. A row pushes its page.")).toBe(true);
  app.dispose();
});

test("checkbox, switch and select change their values, and say so to screen readers", async () => {
  const app = await open("./gallery.tsx", { width: 1280, height: 900, platform: "macos" });
  await app.waitFor("id:gallery");
  expect(app.accessibility("id:gallery-check")?.checked).toBe("true");
  await app.press("id:gallery-check");
  expect(app.accessibility("id:gallery-check")?.checked).toBe("false");
  expect(app.accessibility("id:gallery-switch")?.checked).toBe("false");
  await app.press("id:gallery-switch");
  expect(app.accessibility("id:gallery-switch")?.checked).toBe("true");
  await app.press("id:gallery-select");
  await app.press("text:Views");
  await app.waitFor("text:Views");
  expect(app.shows("text:Views")).toBe(true);
  app.dispose();
});

test("a phone-width table keeps its first column and drops the ones that do not fit", async () => {
  // A phone idiom runs headless (or on --target ios); a desktop target cannot pretend to be one.
  const app = await open("./gallery.tsx", { width: 390, height: 844, platform: "ios" }).catch((e: { code?: string }) => {
    if (e.code === "ERR_NSH_TEST_UNSUPPORTED") return null;
    throw e;
  });
  if (!app) return;
  await app.waitFor("id:gallery");
  expect(app.shows("text:ada@example.com")).toBe(true);
  // "Sites" hides under 520pt; "Last seen" (no hideBelow) stays.
  expect(app.shows("text:Sites")).toBe(false);
  expect(app.shows("text:Last seen")).toBe(true);
  app.dispose();
});
