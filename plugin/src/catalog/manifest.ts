/**
 * Builds manifest.json: one action per catalog entry, the eight "Camera: Show Position k" keys, one per view dial and
 * one per view toggle ("Look: …"), plus Store Modifier / Connection and the six generic (configurable) actions from
 * manifest.base.json, which are hidden from the action list (VisibleInActionsList: false). Used by scripts/gen-manifest.mjs (writes the file) and by the tests (compare with it).
 *
 * Grouping: the Stream Deck manifest has NO per-action group/category field (only the plugin-level "Category"),
 * so actions are grouped by manifest order (category order) AND by the "<Category>: " name prefix.
 */
import { NUMBER_PROPERTIES, BOOL_PROPERTIES } from "../lib/properties.js";
import { dialUuid, PROPERTY_ICON, toggleUuid } from "../lib/named.js";
import { CATEGORIES, actionName, isTab, orderedEntries, uuidOf, type CatalogEntry } from "./index.js";
import { FIXTURE_DIALS, FIXTURE_KEYS, FIXTURE_SELECT, FIXTURES_PI } from "./fixtures.js";
import { CONNECTION_UUID, HIDDEN_GENERIC_UUIDS, SHOW_POSITION_COUNT, STORE_MODIFIER_UUID, showPositionName, showPositionUuid, toggleActionName } from "./extras.js";

export interface ManifestAction {
  Name: string;
  UUID: string;
  Icon: string;
  Tooltip: string;
  PropertyInspectorPath?: string;
  /** false: registered but not offered in the Stream Deck action list (only usable from a profile or keys placed earlier). */
  VisibleInActionsList?: boolean;
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

function showPositionAction(k: number): ManifestAction {
  return {
    Name: showPositionName(k),
    UUID: showPositionUuid(k),
    Icon: iconPath("position"),
    Tooltip: `Recalls camera position ${k} of catalog 1 in the open show over OSC. The key is titled with its name in Capture.`,
    Controllers: ["Keypad"],
    States: [{ Image: keyPath("position"), ShowTitle: false }],
  };
}

export function buildManifest(base: Manifest, packageVersion: string): Manifest {
  const [maj, min, pat] = packageVersion.split(".");
  const baseByUuid = new Map(base.Actions.map((a) => [a.UUID, a]));
  const pick = (uuid: string): ManifestAction => {
    const a = baseByUuid.get(uuid);
    if (!a) throw new Error(`manifest.base.json has no action ${uuid}`);
    return a;
  };
  // Action-list order: the catalog's categories; the Camera group also holds the Show Position keys and the Store Modifier.
  const entries = orderedEntries();
  const commands: ManifestAction[] = CATEGORIES.flatMap((c) => {
    const own = entries.filter((e) => e.category === c.slug).map(commandAction);
    if (c.slug !== "camera") return own;
    const shows = Array.from({ length: SHOW_POSITION_COUNT }, (_, i) => showPositionAction(i + 1));
    return [...own, ...shows, pick(STORE_MODIFIER_UUID)];
  });

  const dials: ManifestAction[] = NUMBER_PROPERTIES.map((p) => ({
    Name: `Dial: ${p.label}`,
    UUID: dialUuid(p),
    Icon: iconPath(PROPERTY_ICON[p.id]),
    Tooltip: `Turn to adjust ${p.label} over OSC (${p.min} … ${p.max}). Push or touch: fine mode. Long touch: reset.`,
    PropertyInspectorPath: PI, // named dials: Step and Reset value only (no view / property pickers)
    Controllers: ["Encoder"],
    States: [{ Image: keyPath(PROPERTY_ICON[p.id]), ShowTitle: false }],
    Encoder: {
      layout: "layouts/dial.json",
      TriggerDescription: { Rotate: "Adjust", Push: "Fine mode", Touch: "Fine mode", LongTouch: "Reset" },
      background: "imgs/actions/dial/strip-background",
    },
  }));

  const toggles: ManifestAction[] = BOOL_PROPERTIES.map((p) => ({
    Name: toggleActionName(p.label),
    UUID: toggleUuid(p),
    Icon: iconPath(PROPERTY_ICON[p.id]),
    Tooltip: `Toggles ${p.label} in Capture's live view over OSC.`,
    Controllers: ["Keypad"],
    States: [
      { Image: keyPath(PROPERTY_ICON[p.id]), ShowTitle: false },
      { Image: keyPath(PROPERTY_ICON[p.id]), ShowTitle: false },
    ],
  }));

  // v0.4: fixture keys and dials (Fixtures: Setup / Release / Home Selected / Status, Fixture: Select / Pan / Tilt ...).
  const fixtureKeys: ManifestAction[] = FIXTURE_KEYS.map((k) => ({
    Name: k.name,
    UUID: k.uuid,
    Icon: iconPath(k.icon),
    Tooltip: k.tooltip,
    ...(k.pi ? { PropertyInspectorPath: FIXTURES_PI } : {}),
    Controllers: ["Keypad"],
    States: [{ Image: keyPath(k.icon), ShowTitle: false }],
  }));
  const fixtureSelect: ManifestAction = {
    Name: FIXTURE_SELECT.name,
    UUID: FIXTURE_SELECT.uuid,
    Icon: iconPath(FIXTURE_SELECT.icon),
    Tooltip: FIXTURE_SELECT.tooltip,
    Controllers: ["Encoder"],
    States: [{ Image: keyPath(FIXTURE_SELECT.icon), ShowTitle: false }],
    Encoder: {
      layout: "layouts/select.json",
      TriggerDescription: { Rotate: "Select fixture", Push: "Single / all of type", Touch: "Single / all of type" },
      background: "imgs/actions/dial/strip-background",
    },
  };
  const fixtureDials: ManifestAction[] = FIXTURE_DIALS.map((d) => ({
    Name: d.name,
    UUID: d.uuid,
    Icon: iconPath(d.icon),
    Tooltip: d.tooltip,
    Controllers: ["Encoder"],
    States: [{ Image: keyPath(d.icon), ShowTitle: false }],
    Encoder: {
      layout: "layouts/dial.json",
      TriggerDescription: { Rotate: "Adjust", Push: "Fine mode", Touch: "Fine mode", LongTouch: "Home" },
      background: "imgs/actions/dial/strip-background",
    },
  }));

  // Named actions first (commands, Look toggles, fixtures, Status, dials), then the hidden generic ones (VisibleInActionsList: false).
  const hidden = HIDDEN_GENERIC_UUIDS.map(pick);
  for (const h of hidden) if (h.VisibleInActionsList !== false) throw new Error(`${h.UUID} must be hidden (VisibleInActionsList: false)`);
  return { ...base, Version: `${maj}.${min}.${pat}.0`, Actions: [...commands, ...toggles, ...fixtureKeys, fixtureSelect, ...fixtureDials, pick(CONNECTION_UUID), ...dials, ...hidden] };
}
