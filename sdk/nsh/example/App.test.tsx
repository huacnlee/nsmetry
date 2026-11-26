/** The example app headless: navigation becomes screen views, backgrounding sends them. */
import { expect, open, test } from "nsh/test";

const BATCH = "POST https://stats.example.com/api/events/batch";

interface Batch {
  site: string;
  events: Array<Record<string, unknown>>;
}

test("records screens and events, and flushes them when the app goes to the background", async () => {
  const bodies: Batch[] = [];
  const app = await open("./App.tsx", {
    platform: "android",
    network: {
      [BATCH]: (request) => {
        bodies.push(JSON.parse(request.body ?? "{}") as Batch);
        return { status: 204 };
      },
    },
  });

  await app.press("Export");
  await app.press("Open settings");
  await app.waitFor("Nothing to set.");
  // Nothing is sent while the app is in use: the 30 s interval has not passed.
  expect(bodies).toHaveLength(0);

  await app.setLifecycle("background");
  await app.waitUntil(() => bodies.length > 0);

  expect(bodies).toHaveLength(1);
  const events = bodies[0]!.events;
  expect(bodies[0]!.site).toBe("nsmetry-example");
  expect(events.map((e) => `${e.name} ${e.url}`)).toEqual(["screen_view /home", "export /home", "screen_view /settings"]);
  expect(events[0]!.app_version).toBe("1.4.0");
  expect(events[0]!.ua).toMatch(/\(Android \d+; Mobile\)$/);
  expect(typeof events[0]!.user_id).toBe("string");
  // The anonymous id is in the app's storage for the next launch.
  expect(app.storage()["nsmetry.uid"]).toBe(events[0]!.user_id as string);
  app.dispose();
});

test("going back to a page records it again", async () => {
  const bodies: Batch[] = [];
  const app = await open("./App.tsx", {
    network: { [BATCH]: (request) => (bodies.push(JSON.parse(request.body ?? "{}") as Batch), { status: 204 }) },
  });
  await app.press("Open settings");
  await app.waitFor("Nothing to set.");
  await app.press("Back");
  await app.waitFor("Export");
  await app.setLifecycle("background");
  await app.waitUntil(() => bodies.length > 0);
  expect(bodies[0]!.events.map((e) => e.url)).toEqual(["/home", "/settings", "/home"]);
  app.dispose();
});
