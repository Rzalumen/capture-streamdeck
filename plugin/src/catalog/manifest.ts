/**
 * Builds manifest.json: the generic actions from manifest.base.json plus one action per catalog entry, one per view
 * dial and one per view toggle. Used by scripts/gen-manifest.mjs (writes the file) and by the tests (compare with it).
 *
 * Grouping: the Stream Deck manifest has NO per-action group/category field (only the plugin-level "Category"),
 * so actions are grouped by manifest order (category order) AND by the "<Category>: " name prefix.
 */
import { NUMBER_PROPERTIES, BOOL_PROPERTIES } from "../lib/properties.js";
import { dialUuid, PROPERTY_ICON, toggleUuid } from "../lib/named.js";
import { actionName, isTab, orderedEntries, uuidOf, type CatalogEntry } from "./index.js";

export interface ManifestAction {
  Name: string;
  UUID: string;
  Icon: string;
  Tooltip: string;
  PropertyInspectorPath?: string;
  Controllers: string[];
  States: { Image: string; ShowTitle: boolean }[];
  Encoder?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface Manifest {
  Version: string;
  Actions: ManifestAction[];
  [k: string]: unknown;
}

const PI = "ui/inspector.html";
export const iconPath = (name: string): string => `imgs/icons/${name}`;
export const keyPath = (name: string): string => `imgs/keys/${name}`;

function commandAction(e: CatalogEntry): ManifestAction {
  const hold = e.holdToFire ? " Hold the key for 1 s to fire." : "";
  const what = isTab(e) ? `Switches Capture to the ${e.tab} tab.` : `Fires ${e.menuPath.join(" › ").replace("|", " / ")} in Capture.`;
  return {
    Name: actionName(e),
    UUID: uuidOf(e),
    Icon: iconPath(e.icon),
    Tooltip: `${what}${hold}`,
    PropertyInspectorPath: PI,
    Controllers: ["Keypad"],
    States: [
      { Image: keyPath(e.icon), ShowTitle: false },
      { Image: keyPath(e.icon), ShowTitle: false },
    ],
  };
}

export function buildManifest(base: Manifest, packageVersion: string): Manifest {
  const [maj, min, pat] = packageVersion.split(".");
  const commands = orderedEntries().map(commandAction);

  const dials: ManifestAction[] = NUMBER_PROPERTIES.map((p) => ({
    Name: `Dial: ${p.label}`,
    UUID: dialUuid(p),
    Icon: iconPath(PROPERTY_ICON[p.id]),
    Tooltip: `Turn to adjust ${p.label} over OSC (${p.min} … ${p.max}). Push or touch: fine mode. Long touch: reset.`,
    PropertyInspectorPath: PI,
    Controllers: ["Encoder"],
    States: [{ Image: keyPath(PROPERTY_ICON[p.id]), ShowTitle: false }],
    Encoder: {
      layout: "layouts/dial.json",
      TriggerDescription: { Rotate: "Adjust", Push: "Fine mode", Touch: "Fine mode", LongTouch: "Reset" },
      background: "imgs/actions/dial/strip-background",
    },
  }));

  const toggles: ManifestAction[] = BOOL_PROPERTIES.map((p) => ({
    Name: `Toggle: ${p.label}`,
    UUID: toggleUuid(p),
    Icon: iconPath(PROPERTY_ICON[p.id]),
    Tooltip: `Toggles ${p.label} over OSC.`,
    PropertyInspectorPath: PI,
    Controllers: ["Keypad"],
    States: [
      { Image: keyPath(PROPERTY_ICON[p.id]), ShowTitle: false },
      { Image: keyPath(PROPERTY_ICON[p.id]), ShowTitle: false },
    ],
  }));

  // Generated (named) actions first, in category order; the generic actions keep their names and UUIDs, after them.
  return { ...base, Version: `${maj}.${min}.${pat}.0`, Actions: [...commands, ...dials, ...toggles, ...base.Actions] };
}
