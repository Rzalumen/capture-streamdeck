/**
 * The named actions that are not menu commands from the catalog: the eight "Camera: Show Position k" keys (OSC recall),
 * the named toggles ("Look: …"), and the UUIDs of the generic actions that stay registered but hidden.
 */
import { BASE_UUID } from "../lib/named.js";

/** Show Position keys: OSC "auto" mode on catalog 1, the k-th position of whatever show is open. */
export const SHOW_POSITION_COUNT = 8;
export const SHOW_POSITION_CATALOG = 1;
export const showPositionUuid = (k: number): string => `${BASE_UUID}.showpos.${k}`;
export const showPositionName = (k: number): string => `Camera: Show Position ${k}`;
export const showPositionSettings = (k: number): { mode: "auto"; catalog: number; index: number } => ({ mode: "auto", catalog: SHOW_POSITION_CATALOG, index: k });
/** Inverse of showPositionUuid (undefined for any other UUID). */
export function showPositionIndex(uuid: string): number | undefined {
  const m = new RegExp(`^${BASE_UUID.replace(/\./g, "\\.")}\\.showpos\\.([1-9]\\d*)$`).exec(uuid);
  return m ? Number(m[1]) : undefined;
}

/** Kept visible in the action list, renamed into their folder's group. UUIDs are unchanged from v0.2. */
export const STORE_MODIFIER_UUID = `${BASE_UUID}.store`;
export const CONNECTION_UUID = `${BASE_UUID}.connection`;
export const STORE_MODIFIER_NAME = "Camera: Store Modifier";
export const CONNECTION_NAME = "Status: Connection";

/** Named toggles are listed as "Look: <label>" (UUIDs unchanged: toggle.automatic-exposure, toggle.laser-flicker-effect). */
export const toggleActionName = (label: string): string => `Look: ${label}`;

/**
 * Generic, configurable actions. They stay registered (keys already placed from v0.1/v0.2 keep working) but are hidden
 * from the Stream Deck action list with `VisibleInActionsList: false`: every key a user can drag is a straight command.
 */
export const HIDDEN_GENERIC_UUIDS = [
  `${BASE_UUID}.command`,
  `${BASE_UUID}.tab`,
  `${BASE_UUID}.slot`,
  `${BASE_UUID}.position`,
  `${BASE_UUID}.dial`,
  `${BASE_UUID}.toggle`,
] as const;
