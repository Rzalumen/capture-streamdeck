/**
 * Layout → `.streamDeckProfile` (a zip), following the structure of a real Stream Deck 7.6 export (Handoff 09 §2):
 *
 *   package.json
 *   Profiles/<ROOT>.sdProfile/manifest.json, Images/
 *   Profiles/<ROOT>.sdProfile/Profiles/<PAGE>/manifest.json, Images/<ID>.png     (one folder per page AND per folder level)
 *
 * Page folders are named with the page UUID in upper case; every reference to them (Pages, Default, ProfileUUID) is the same UUID in lower case.
 */
import { createHash } from "node:crypto";
import { BACK_UUID, KEY_POSITIONS_ALL, OPEN_CHILD_UUID, uuidFrom, type Dial, type Key, type Layout, type Page } from "./layout.js";
import { writeZip, type ZipEntry } from "./zip.js";
import type { Manifest } from "../catalog/manifest.js";

export const DEFAULT_CAPTURE_APP = "/Applications/Capture 2026.app";
export const PLUGIN_UUID = "com.rezabehjat.capture";
export const PROFILE_NAME = "Capture";
/** Stream Deck+ (manifest "Profiles" DeviceType 7; profile DeviceModel). */
export const DEVICE_MODEL = "20GBD9901";
const DEVICE_UUID = "@(1)[4057/132/CAPTURE-DEFAULT]"; // 4057 = Elgato vendor id, 132 = Stream Deck+; the app substitutes the connected device

export type ImageSource = (style: "key" | "folder", icon: string) => Buffer;

export interface BuildOptions {
  manifest: Manifest;
  image: ImageSource;
  /** Capture's .app path: makes Stream Deck switch to this profile when Capture is the active app. */
  appPath?: string;
}

const b32 = (buf: Buffer): string => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let v = 0;
  let out = "";
  for (const byte of buf) {
    v = (v << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += A[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(v << (5 - bits)) & 31];
  return out;
};
/** Image file id: 26 upper-case characters derived from the PNG bytes (identical images share a file). */
export const imageId = (png: Buffer): string => b32(createHash("sha1").update(png).digest()).slice(0, 26);

const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v), "utf8");

interface Built {
  /** Page manifest + the images it references. */
  manifest: unknown;
  images: Map<string, Buffer>;
}

function state(image: string, title: string, showTitle: boolean): Record<string, unknown> {
  return { Image: image, Title: title, ShowTitle: showTitle, TitleAlignment: "bottom", TitleColor: "#E8E8E8", FontSize: 12, FontFamily: "", FontStyle: "", FontUnderline: false, OutlineThickness: 2 };
}

function buildPage(page: Page, o: BuildOptions, plugin: { Name: string; UUID: string; Version: string }): Built {
  const images = new Map<string, Buffer>();
  const put = (style: "key" | "folder", icon: string): string => {
    const png = o.image(style, icon);
    const id = imageId(png);
    images.set(`${id}.png`, png);
    return `Images/${id}.png`;
  };
  const actionOf = (uuid: string) => {
    const a = o.manifest.Actions.find((x) => x.UUID === uuid);
    if (!a) throw new Error(`profile uses ${uuid}, which is not in the plugin manifest`);
    return a;
  };
  const seed = (pos: string, what: string): string => uuidFrom(`${page.path}|${what}|${pos}`);

  const keyAction = (pos: string, k: Key): Record<string, unknown> => {
    if (k.type === "folder") {
      return {
        ActionID: seed(pos, "folder"),
        LinkedTitle: true,
        Name: "Create Folder",
        Resources: null,
        Settings: { ProfileUUID: k.child.id },
        State: 0,
        States: [state(put("folder", k.icon), k.title, true)],
        UUID: OPEN_CHILD_UUID,
      };
    }
    if (k.type === "back") {
      return {
        ActionID: seed(pos, "back"),
        LinkedTitle: true,
        Name: "Parent Folder",
        Resources: null,
        Settings: {},
        State: 0,
        States: [state(put("folder", k.icon), k.title, true)],
        UUID: BACK_UUID,
      };
    }
    const m = actionOf(k.uuid);
    const image = put("key", k.icon);
    // v0.5: the key shows its name as Stream Deck title text; the plugin no longer draws labels into the key images.
    const states = m.States.map(() => state(image, k.title, true));
    return { ActionID: seed(pos, k.uuid), LinkedTitle: true, Name: m.Name, Plugin: plugin, Resources: null, Settings: {}, State: 0, States: states, UUID: k.uuid };
  };

  const dialAction = (pos: string, d: Dial): Record<string, unknown> => {
    const m = actionOf(d.uuid);
    const image = put("key", d.icon);
    return { ActionID: seed(pos, d.uuid), LinkedTitle: true, Name: m.Name, Plugin: plugin, Resources: null, Settings: {}, State: 0, States: m.States.map(() => state(image, d.title, false)), UUID: d.uuid };
  };

  const enc: Record<string, unknown> = {};
  for (const [pos, d] of [...page.dials.entries()].sort(posOrder)) enc[pos] = dialAction(pos, d);
  const pad: Record<string, unknown> = {};
  for (const [pos, k] of [...page.keys.entries()].sort(posOrder)) pad[pos] = keyAction(pos, k);

  return {
    manifest: { Controllers: [{ Type: "Encoder", Actions: enc }, { Type: "Keypad", Actions: pad }], Icon: "", Name: "" },
    images,
  };
}

/** "x,y" sorted by row then column (the order Stream Deck itself lists them). */
const posOrder = (a: [string, unknown], b: [string, unknown]): number => {
  const [ax, ay] = a[0].split(",").map(Number);
  const [bx, by] = b[0].split(",").map(Number);
  return ay - by || ax - bx;
};

export function buildProfileFiles(layout: Layout, o: BuildOptions): ZipEntry[] {
  const pluginManifest = o.manifest;
  const plugin = { Name: String(pluginManifest.Name), UUID: PLUGIN_UUID, Version: String(pluginManifest.Version) };
  const root = uuidFrom("root").toUpperCase();
  const rootDir = `Profiles/${root}.sdProfile`;
  const home = layout.home.id;

  const files: ZipEntry[] = [];
  files.push({ name: "package.json", data: json({ AppVersion: "7.6.0.23012", DeviceModel: DEVICE_MODEL, DeviceSettings: null, FormatVersion: 1, OSType: "macOS", OSVersion: "26.6.2", RequiredPlugins: [PLUGIN_UUID, OPEN_CHILD_UUID, BACK_UUID] }) });
  files.push({ name: "Profiles/" });
  files.push({ name: `${rootDir}/` });
  files.push({
    name: `${rootDir}/manifest.json`,
    data: json({
      AppIdentifier: o.appPath ?? DEFAULT_CAPTURE_APP,
      Device: { Model: DEVICE_MODEL, UUID: DEVICE_UUID },
      Name: PROFILE_NAME,
      Pages: { Current: "00000000-0000-0000-0000-000000000000", Default: home, Pages: [home] },
      Version: "3.0",
    }),
  });
  files.push({ name: `${rootDir}/Images/` });
  files.push({ name: `${rootDir}/Profiles/` });
  for (const page of layout.pages) {
    const dir = `${rootDir}/Profiles/${page.id.toUpperCase()}`;
    const b = buildPage(page, o, plugin);
    files.push({ name: `${dir}/` });
    files.push({ name: `${dir}/manifest.json`, data: json(b.manifest) });
    files.push({ name: `${dir}/Images/` });
    for (const [name, png] of [...b.images.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) files.push({ name: `${dir}/Images/${name}`, data: png });
  }
  return files;
}

export function buildProfileZip(layout: Layout, o: BuildOptions): Buffer {
  return writeZip(buildProfileFiles(layout, o));
}

export { KEY_POSITIONS_ALL };
