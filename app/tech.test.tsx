/** Tech: five lists from one request, apps labelled "App", app versions, a row adding a filter, its detail page. */
import { describe, expect, open, test } from "nsh/test";
import { calls, desktop, hasText, server, signedIn } from "./fixtures/insights-server";

describe("tech screen", () => {
  test("browsers (with App), systems, devices, screens and app versions in one request", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.press("id:nav-tech");
    await app.waitFor("text:1.2.0");
    for (const t of ["Chrome", "App", "macOS", "desktop", "1280+"]) expect(hasText(app.texts(), t)).toBe(true);
    const b = calls(app, "/api/breakdown").filter((r) => r.url.includes("app_version"));
    expect(b.length).toBe(1);
    await app.press("role:button[1.2.0, 250]");
    await app.waitFor("id:remove-filter-app_version");
    expect(app.shows("id:tech-details")).toBe(true);
    await app.press("id:tech-details");
    await app.waitFor("id:tech-page-props");
    await app.waitUntil(() => calls(app, "/api/breakdown").some((r) => r.url.includes("dim=os%2Cdevice%2Ccountry") && r.url.includes("f=app_version:1.2.0")));
    app.dispose();
  });
});
