/** The SDK on its own, headless: the user-agent words, defaults from the app, the wire format. */
import { describe, expect, test } from "nsh/test";
import { createNsMetry, describePlatform, type NsMetry } from "nsmetry";

interface Batch {
  site: string;
  events: Array<Record<string, unknown>>;
}

/** A client whose requests land in `bodies` instead of the network. */
function capture(options: { persistUserId?: boolean; status?: number } = {}): { client: NsMetry; bodies: Batch[]; urls: string[] } {
  const bodies: Batch[] = [];
  const urls: string[] = [];
  const client = createNsMetry({
    endpoint: "https://stats.example.com",
    site: "sdk-test",
    persistUserId: options.persistUserId,
    fetch: async (url, init) => {
      urls.push(url);
      bodies.push(JSON.parse(String(init.body)) as Batch);
      return new Response(null, { status: options.status ?? 204 });
    },
  });
  return { client, bodies, urls };
}

describe("describePlatform", () => {
  test("names the OS and device class the server's parser looks for", () => {
    expect(describePlatform({ os: "ios", version: "17.5", idiom: "phone" })).toBe("NsMetry-NSH/0.1.0 (iPhone; iOS 17.5; Mobile)");
    expect(describePlatform({ os: "ios", version: "17.5", idiom: "pad" })).toBe("NsMetry-NSH/0.1.0 (iPad; iOS 17.5; Tablet)");
    expect(describePlatform({ os: "android", version: "35", idiom: "phone" })).toBe("NsMetry-NSH/0.1.0 (Android 35; Mobile)");
    expect(describePlatform({ os: "android", version: "35", idiom: "pad" })).toBe("NsMetry-NSH/0.1.0 (Android 35; Tablet)");
    expect(describePlatform({ os: "macos", version: "15.1", idiom: "desktop" })).toBe("NsMetry-NSH/0.1.0 (macOS 15.1)");
    expect(describePlatform({ os: "windows", version: "10.0.26100", idiom: "desktop" })).toBe("NsMetry-NSH/0.1.0 (Windows NT 10.0.26100)");
    expect(describePlatform({ os: "linux", version: "6.8", idiom: "desktop" })).toBe("NsMetry-NSH/0.1.0 (Linux)");
  });

  test("leaves the web to the browser's own User-Agent", () => {
    expect(describePlatform({ os: "web", version: "0.0", idiom: "desktop" })).toBeUndefined();
  });
});

describe("createNsMetry", () => {
  test("batches events into one request with the app's version", async () => {
    const { client, bodies, urls } = capture();
    client.screen("/home");
    client.track("export", { format: "csv", rows: 3, bad: null });
    expect(bodies).toHaveLength(0);
    await client.flush();
    expect(urls).toEqual(["https://stats.example.com/api/events/batch"]);
    expect(bodies).toHaveLength(1);
    const [view, custom] = bodies[0]!.events;
    expect(bodies[0]!.site).toBe("sdk-test");
    expect(view!.name).toBe("screen_view");
    expect(view!.url).toBe("/home");
    expect(view!.app_version).toBe("1.4.0");
    expect(custom!.name).toBe("export");
    expect(custom!.url).toBe("/home");
    expect(custom!.props).toEqual({ format: "csv", rows: 3 });
    await client.shutdown();
  });

  test("persists an anonymous id in NSH Storage", async () => {
    const first = capture({ persistUserId: true });
    first.client.track("a");
    await first.client.flush();
    const id = first.bodies[0]!.events[0]!.user_id;
    expect(typeof id).toBe("string");

    // A second client, as after a relaunch, reads the same id back.
    const second = capture({ persistUserId: true });
    second.client.track("b");
    await second.client.flush();
    expect(second.bodies[0]!.events[0]!.user_id).toBe(id);
    await first.client.shutdown();
    await second.client.shutdown();
  });

  test("keeps events when the server is down", async () => {
    const { client, bodies } = capture({ status: 503 });
    client.track("a");
    await client.flush();
    expect(bodies).toHaveLength(1);
    expect(client.queued).toBe(1);
    client.setEnabled(false);
    expect(client.queued).toBe(0);
  });
});
