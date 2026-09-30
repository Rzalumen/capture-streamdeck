/** Names, UUIDs and icons of the generated dial / toggle actions ("Dial: Bloom", "Toggle: Auto Exposure"). */
import { BOOL_PROPERTIES, NUMBER_PROPERTIES, type BoolProperty, type NumberProperty } from "./properties.js";

/** camelCase → kebab-case (Stream Deck UUIDs may only contain a-z, 0-9, "-" and "."). */
export const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

export const BASE_UUID = "com.rezabehjat.capture";
export const dialUuid = (p: Pick<NumberProperty, "id">): string => `${BASE_UUID}.dial.${kebab(p.id)}`;
export const toggleUuid = (p: Pick<BoolProperty, "id">): string => `${BASE_UUID}.toggle.${kebab(p.id)}`;

export const PROPERTY_ICON: Record<string, string> = {
  exposureAdjustment: "exposure",
  ambientLighting: "ambient",
  bloom: "bloom",
  whiteBalance: "whitebalance",
  fillLighting: "fill",
  hueClamp: "hueclamp",
  contrast: "contrast",
  saturation: "saturation",
  flare: "flare",
  flareSize: "flaresize",
  flareAngle: "flareangle",
  flareStreaks: "streaks",
  automaticExposure: "autoexposure",
  laserFlickerEffect: "laser",
};

export type NamedKind = { kind: "cmd"; category: string; id: string } | { kind: "dial"; property: string } | { kind: "toggle"; property: string };

/** Which generated action does this UUID belong to? (undefined for the generic actions) */
export function parseNamedUuid(uuid: string): NamedKind | undefined {
  const cmd = /^com\.rezabehjat\.capture\.cmd\.([a-z0-9-]+)\.([a-z0-9-]+)$/.exec(uuid);
  if (cmd) return { kind: "cmd", category: cmd[1], id: cmd[2] };
  const dial = NUMBER_PROPERTIES.find((p) => dialUuid(p) === uuid);
  if (dial) return { kind: "dial", property: dial.id };
  const tog = BOOL_PROPERTIES.find((p) => toggleUuid(p) === uuid);
  if (tog) return { kind: "toggle", property: tog.id };
  return undefined;
}
