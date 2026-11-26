/**
 * The gallery, page by page, for review: desktop width and a narrow window, light and dark. On a real
 * target (`nsh test app/gallery-shots.test.tsx --target macos`) each page lands in
 * app/shots/<width>-<scheme>-<n>.png; headless the same steps run and nothing is drawn.
 */
import { open, test } from "nsh/test";

const shot = (app: { screenshot(path?: string | null): Promise<Uint8Array> }, path: string) => app.screenshot(path).catch(() => undefined);

for (const [name, width, height] of [["desktop", 1280, 900], ["narrow", 390, 844]] as const) {
  test(`gallery pages at ${name} width, light and dark`, async () => {
    const app = await open("./gallery.tsx", { width, height, platform: "macos" });
    await app.waitFor("id:gallery");
    // A headless run draws nothing: the walk would only cost time there.
    if (!(await app.screenshot().then(() => true, () => false))) return app.dispose();
    for (const scheme of ["light", "dark"] as const) {
      await app.setColorScheme(scheme);
      await app.wait(300);
      const pages = name === "desktop" ? 9 : 20;
      for (let i = 0; i < pages; i++) {
        await shot(app, `app/shots/${name}-${scheme}-${String(i).padStart(2, "0")}.png`);
        await app.scroll("id:gallery-scroll", height - 120).catch(() => undefined);
        await app.wait(250);
      }
      await app.scroll("id:gallery-scroll", -100000).catch(() => undefined);
    }
    app.dispose();
  }, 420_000);
}
