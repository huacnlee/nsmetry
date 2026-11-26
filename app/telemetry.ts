/**
 * NsMetry's own usage numbers, sent with its own SDK (sdk/nsh) to the project's instance as the site
 * `nsmetry`: which screens are used, on which platform and version, and a few actions. Never the
 * numbers an instance holds, its address, or who is signed in; the user id is an anonymous install id.
 *
 * On by default and off from Settings › This instance ("Share anonymous usage data"); the choice is kept on the
 * device. Only release builds send (`nsh package`, the web build): `nsh run` and `nsh test` never do.
 */
import { appInfo, signal, Storage } from "nsh";
import { createNsMetry, type Props } from "nsmetry";

const ENDPOINT = "https://nsmetry.huacnlee-account.workers.dev";
const PREF_KEY = "telemetry";

/** Development builds (`nsh run`, `nsh test`, `nsh build` without `--release`) never send. */
const devBuild = appInfo().development;

export const nsmetry = createNsMetry({
  endpoint: ENDPOINT,
  site: "nsmetry",
  persistUserId: true,
  appVersion: appInfo().version ?? undefined,
  disabled: true,
});

const enabled = signal(false);
/** Whether usage data is being shared (Settings shows it as a switch). */
export const sharingUsage = () => enabled();

/** Turns sharing on or off and remembers it on this device. */
export function setSharingUsage(on: boolean) {
  enabled.set(on);
  nsmetry.setEnabled(on && !devBuild);
  void Storage.setItem(PREF_KEY, on ? "on" : "off").catch(() => undefined);
}

/** Reads the saved choice (default on). Called once at start. */
export async function startTelemetry() {
  let saved: string | null = null;
  try {
    saved = await Storage.getItem(PREF_KEY);
  } catch {
    // No storage: keep the default.
  }
  const on = saved !== "off";
  enabled.set(on);
  nsmetry.setEnabled(on && !devBuild);
}

/** A custom event; a no-op while sharing is off. */
export function track(name: string, props?: Props) {
  nsmetry.track(name, props);
}
