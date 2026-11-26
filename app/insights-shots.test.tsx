/**
 * The insights screens for review, light and dark at desktop and phone width. On a real target
 * (`nsh test app/insights-shots.test.tsx --target macos`) each lands in app/shots/insights-*.png;
 * headless the steps run and nothing is drawn.
 */
import { open, test } from "nsh/test";
import { server, signedIn } from "./fixtures/insights-server";

for (const [name, width, height] of [["desktop", 1280, 900], ["narrow", 390, 844]] as const) {
  test(`insights screens at ${name} width, light and dark`, async () => {
    const app = await open("./App.tsx", { width, height, platform: "macos", storage: signedIn(), network: server() });
    await app.waitFor("id:screen-overview");
    if (!(await app.screenshot().then(() => true, () => false))) return app.dispose();
    for (const scheme of ["light", "dark"] as const) {
      await app.setColorScheme(scheme);
      for (const s of ["overview", "pages", "sources", "geography", "tech"]) {
        if (name === "desktop") await app.press(`id:nav-${s}`).catch(() => undefined);
        else if (s !== "overview") break;
        await app.wait(900);
        await app.screenshot(`app/shots/insights-${name}-${scheme}-${s}.png`).catch(() => undefined);
      }
      await app.press("id:nav-overview").catch(() => undefined);
    }
    app.dispose();
  }, 300_000);
}
