/**
 * How a dimension's raw values read in a list: an empty referrer is a direct visit, a country code
 * is its name (the code stays beside it in mono, Linear's secondary column), an empty browser is
 * one the Worker could not label. One function for every screen, so a value reads the same in a
 * list, a chip's picker and a detail page.
 */
import { View } from "nsh";
import type { Dim } from "../../api";
import { Txt } from "../../ui";
import { countryName } from "./countries";

export function displayName(dim: Dim, name: string): string {
  switch (dim) {
    case "referrer":
      return name || "Direct / none";
    case "country":
      return countryName(name);
    case "path":
    case "entry":
    case "exit":
      return name || "/";
    case "utm_source":
    case "utm_medium":
    case "utm_campaign":
      return name || "(none)";
    case "app_version":
      return name || "(not set)";
    case "browser":
    case "os":
    case "device":
    case "screen":
      return name || "Unknown";
    default:
      return name || "(none)";
  }
}

/** The country code before its name, muted mono: names alone hide which code a filter will use. */
export function leadingFor(dim: Dim, name: string) {
  if (dim !== "country") return undefined;
  return (
    <View class="items-start" style={{ width: 22 }}>
      <Txt size="caption" tone="faint" class="font-mono">{name || "—"}</Txt>
    </View>
  );
}

