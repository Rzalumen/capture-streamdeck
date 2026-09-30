/**
 * The default Stream Deck+ layout as a pure data structure: HOME → category folders → command keys, plus dials.
 * No file or image handling here (see build.ts); this is what the layout tests read.
 *
 * Rules (Handoff 09 §3):
 *  - HOME: row 0 = View · Camera · Select · Edit, row 1 = Patch & Focus · Windows · File · Look (all folders).
 *  - Every child page: Back at "0,0"; commands fill "1,0" → "3,0" → "0,1" → "3,1" (7 slots) in catalog order.
 *  - More than 7 commands: the 7th slot ("3,1") becomes a "More ▸" folder to the next page (which has its own Back).
 *  - Dials: every page has its own four. Standard set everywhere; View pages get the View set; the Look folder the Flare set.
 */
import { CATEGORIES, ENTRIES, actionName, type CatalogEntry } from "../catalog/index.js";
import { CONNECTION_UUID, CONNECTION_NAME, SHOW_POSITION_COUNT, STORE_MODIFIER_NAME, STORE_MODIFIER_UUID, showPositionName, showPositionUuid, toggleActionName } from "../catalog/extras.js";
import { uuidOf } from "../catalog/index.js";
import { BOOL_PROPERTIES, NUMBER_PROPERTIES } from "../lib/properties.js";
import { dialUuid, PROPERTY_ICON, toggleUuid } from "../lib/named.js";
import { createHash } from "node:crypto";

export const OPEN_CHILD_UUID = "com.elgato.streamdeck.profile.openchild";
export const BACK_UUID = "com.elgato.streamdeck.profile.backtoparent";

/** Stream Deck+: 4 × 2 keys, 4 dials. */
export const KEY_POSITIONS_ALL = ["0,0", "1,0", "2,0", "3,0", "0,1", "1,1", "2,1", "3,1"] as const;
export const DIAL_POSITIONS = ["0,0", "1,0", "2,0", "3,0"] as const;
/** Command slots on a child page, in fill order ("0,0" is Back). */
export const COMMAND_SLOTS = ["1,0", "2,0", "3,0", "0,1", "1,1", "2,1", "3,1"] as const;
export const MORE_SLOT = COMMAND_SLOTS[COMMAND_SLOTS.length - 1];

export const DIAL_SETS = {
  standard: ["exposureAdjustment", "ambientLighting", "bloom", "whiteBalance"],
  view: ["contrast", "saturation", "fillLighting", "hueClamp"],
  look: ["flare", "flareStreaks", "flareAngle", "flareSize"],
} as const;
export type DialSet = keyof typeof DIAL_SETS;

/** A key as the layout describes it. `icon` is an icon name from src/lib/icons.ts. */
export type Key =
  | { type: "action"; uuid: string; name: string; title: string; icon: string }
  | { type: "folder"; title: string; icon: string; child: Page }
  | { type: "back"; title: string; icon: string };
export interface Dial {
  uuid: string;
  name: string;
  title: string;
  icon: string;
  property: string;
}
export interface Page {
  /** Lower-case UUID (the form used in references). The folder in the zip is this, upper-cased. */
  id: string;
  /** Readable path, e.g. "camera/positions/2" (tests and logs only). */
  path: string;
  parent?: Page;
  /** position "x,y" → key */
  keys: Map<string, Key>;
  dials: Map<string, Dial>;
}
export interface Layout {
  home: Page;
  /** Home first, then every page in creation order. */
  pages: Page[];
}

// ---- deterministic UUIDs
export function uuidFrom(seed: string): string {
  const h = createHash("sha1").update(`capture-streamdeck-profile:${seed}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40; // version 4 layout
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// ---- content
type Item = { kind: "action"; key: Extract<Key, { type: "action" }> } | { kind: "folder"; title: string; icon: string; items: Item[]; dials: DialSet };

const cmd = (e: CatalogEntry): Item => ({ kind: "action", key: { type: "action", uuid: uuidOf(e), name: actionName(e), title: e.title, icon: e.icon } });
const inCat = (slug: string): CatalogEntry[] => ENTRIES.filter((e) => e.category === slug);
const byId = (slug: string, id: string): CatalogEntry => {
  const e = ENTRIES.find((x) => x.category === slug && x.id === id);
  if (!e) throw new Error(`catalog has no ${slug}/${id}`);
  return e;
};

interface FolderDef {
  slug: string;
  title: string;
  /** Icon name of the folder key (the category icon). */
  icon: string;
  dials: DialSet;
  items: () => Item[];
}

const catIcon = (slug: string): string => CATEGORIES.find((c) => c.slug === slug)?.icon ?? "folder-view";

/** HOME order: row 0, then row 1. */
export const FOLDERS: FolderDef[] = [
  { slug: "view", title: "View", icon: catIcon("view"), dials: "view", items: () => inCat("view").map(cmd) },
  {
    slug: "camera",
    title: "Camera",
    icon: catIcon("camera"),
    dials: "standard",
    items: () => {
      const cam = inCat("camera");
      const swing = cam.filter((e) => !/^(position|store)-\d$/.test(e.id));
      const positions = cam.filter((e) => /^position-\d$/.test(e.id));
      const stores = cam.filter((e) => /^store-\d$/.test(e.id));
      const store: Item = { kind: "action", key: { type: "action", uuid: STORE_MODIFIER_UUID, name: STORE_MODIFIER_NAME, title: "Store Modifier", icon: "store" } };
      const show: Item[] = Array.from({ length: SHOW_POSITION_COUNT }, (_, i) => ({
        kind: "action",
        key: { type: "action", uuid: showPositionUuid(i + 1), name: showPositionName(i + 1), title: `Show Position ${i + 1}`, icon: "position" },
      }));
      return [...swing.map(cmd), ...positions.map(cmd), store, { kind: "folder", title: "Positions ▸", icon: "positions", dials: "standard", items: [...show, ...stores.map(cmd)] }];
    },
  },
  { slug: "select", title: "Select", icon: catIcon("select"), dials: "standard", items: () => inCat("select").map(cmd) },
  { slug: "edit", title: "Edit", icon: catIcon("edit"), dials: "standard", items: () => inCat("edit").map(cmd) },
  { slug: "patch", title: "Patch & Focus", icon: catIcon("patch"), dials: "standard", items: () => inCat("patch").map(cmd) },
  { slug: "windows", title: "Windows", icon: catIcon("window"), dials: "standard", items: () => [...inCat("tabs"), ...inCat("navigate"), ...inCat("window")].map(cmd) },
  { slug: "file", title: "File", icon: catIcon("file"), dials: "standard", items: () => inCat("file").map(cmd) },
  {
    slug: "look",
    title: "Look",
    icon: "cat-look",
    dials: "look",
    items: () => [
      ...BOOL_PROPERTIES.map<Item>((p) => ({ kind: "action", key: { type: "action", uuid: toggleUuid(p), name: toggleActionName(p.label), title: p.label, icon: PROPERTY_ICON[p.id] } })),
      { kind: "action", key: { type: "action", uuid: CONNECTION_UUID, name: CONNECTION_NAME, title: "Connection", icon: "connection" } },
    ],
  },
];

function dialsFor(set: DialSet, pageId: string): Map<string, Dial> {
  const m = new Map<string, Dial>();
  DIAL_SETS[set].forEach((id, i) => {
    const p = NUMBER_PROPERTIES.find((x) => x.id === id);
    if (!p) throw new Error(`unknown dial property ${id}`);
    m.set(DIAL_POSITIONS[i], { uuid: dialUuid(p), name: `Dial: ${p.label}`, title: p.label, icon: PROPERTY_ICON[p.id], property: p.id });
  });
  void pageId;
  return m;
}

export const MORE_TITLE = "More ▸";

/** One folder (possibly several chained pages) → its first page. */
function buildChain(path: string, items: Item[], dials: DialSet, parent: Page, pages: Page[]): Page {
  const page: Page = { id: uuidFrom(path), path, parent, keys: new Map(), dials: dialsFor(dials, path) };
  pages.push(page);
  page.keys.set("0,0", { type: "back", title: "Back", icon: "back" });
  const overflow = items.length > COMMAND_SLOTS.length;
  const here = overflow ? items.slice(0, COMMAND_SLOTS.length - 1) : items;
  here.forEach((it, i) => {
    const pos = COMMAND_SLOTS[i];
    if (it.kind === "action") page.keys.set(pos, it.key);
    else page.keys.set(pos, { type: "folder", title: it.title, icon: it.icon, child: buildChain(`${path}/${it.title.replace(/\s*▸$/, "").toLowerCase()}`, it.items, it.dials, page, pages) });
  });
  if (overflow) {
    const n = Number(/\/(\d+)$/.exec(path)?.[1] ?? 1) + 1;
    const base = path.replace(/\/\d+$/, "");
    page.keys.set(MORE_SLOT, { type: "folder", title: MORE_TITLE, icon: "more", child: buildChain(`${base}/${n}`, items.slice(COMMAND_SLOTS.length - 1), dials, page, pages) });
  }
  return page;
}

export function buildLayout(): Layout {
  const home: Page = { id: uuidFrom("home"), path: "home", keys: new Map(), dials: dialsFor("standard", "home") };
  const pages: Page[] = [home];
  FOLDERS.forEach((f, i) => {
    home.keys.set(KEY_POSITIONS_ALL[i], { type: "folder", title: f.title, icon: f.icon, child: buildChain(f.slug, f.items(), f.dials, home, pages) });
  });
  return { home, pages };
}

/** Icon names the profile images are needed for: [key-style icons, folder-style icons]. */
export function iconsUsed(layout: Layout): { keys: Set<string>; folders: Set<string> } {
  const keys = new Set<string>();
  const folders = new Set<string>();
  for (const p of layout.pages) {
    for (const k of p.keys.values()) (k.type === "action" ? keys : folders).add(k.icon);
    for (const d of p.dials.values()) keys.add(d.icon);
  }
  return { keys, folders };
}
