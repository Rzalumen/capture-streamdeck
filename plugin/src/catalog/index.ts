/**
 * The command catalog: ONE source of truth for every named Capture command.
 * `commands.json` drives (a) the generated manifest.json (one Stream Deck action per entry), (b) the named-action
 * handlers, (c) the Property Inspector's summary, (d) the tests.
 */
import raw from "./commands.json";
import type { MatchMode, MenuTarget } from "../lib/applescript.js";
import { TABS } from "../lib/applescript.js";
import { ICON_NAMES } from "../lib/icons.js";

export interface CategoryInfo {
  /** Used in UUIDs and entry.category. */
  slug: string;
  /** Shown in action names ("Camera: Swing to Front"). */
  title: string;
  /** Category icon (also the fallback for entries with no specific glyph). */
  icon: string;
}

/** Categories, in manifest / action-list order. */
export const CATEGORIES: CategoryInfo[] = [
  { slug: "view", title: "View", icon: "cat-view" },
  { slug: "camera", title: "Camera", icon: "cat-camera" },
  { slug: "select", title: "Select", icon: "cat-select" },
  { slug: "edit", title: "Edit", icon: "cat-edit" },
  { slug: "patch", title: "Patch & Focus", icon: "cat-patch" },
  { slug: "navigate", title: "Navigate", icon: "cat-navigate" },
  { slug: "window", title: "Window", icon: "cat-window" },
  { slug: "file", title: "File", icon: "cat-file" },
  { slug: "tabs", title: "Tabs", icon: "cat-tabs" },
];

export interface CatalogEntry {
  id: string;
  category: string;
  title: string;
  /** Menu bar item, submenu items…, command. Empty for tab entries. For alternates the last element is "A|B". */
  menuPath: string[];
  match: MatchMode;
  alternates?: string[];
  holdToFire: boolean;
  icon: string;
  /** "menu" (default) or "tab" (uses the tab radio button, not a menu). */
  kind?: "menu" | "tab";
  tab?: string;
  /** Other places the command might live if the primary path doesn't exist in this Capture version. */
  fallbackPaths?: string[][];
  /** Path guessed from the Handoff 07 description, never seen in a real menu dump. */
  unverified?: boolean;
}

export const TOP_MENUS = ["File", "Edit", "View", "Navigate", "Window"];

export const ENTRIES: CatalogEntry[] = raw as CatalogEntry[];

export const categoryOf = (slug: string): CategoryInfo | undefined => CATEGORIES.find((c) => c.slug === slug);

export const uuidOf = (e: Pick<CatalogEntry, "category" | "id">): string => `com.rezabehjat.capture.cmd.${e.category}.${e.id}`;

/** "Camera: Swing to Front" */
export function actionName(e: CatalogEntry): string {
  return `${categoryOf(e.category)?.title ?? e.category}: ${e.title}`;
}

export const isTab = (e: CatalogEntry): boolean => e.kind === "tab";

export function targetOf(e: CatalogEntry): MenuTarget | undefined {
  return isTab(e) ? undefined : { path: e.menuPath, match: e.match };
}

/** Entries in action-list order: category order, then catalog order within a category. */
export function orderedEntries(entries: CatalogEntry[] = ENTRIES): CatalogEntry[] {
  return CATEGORIES.flatMap((c) => entries.filter((e) => e.category === c.slug));
}

export function byUuid(uuid: string): CatalogEntry | undefined {
  return ENTRIES.find((e) => uuidOf(e) === uuid);
}

/** Problems found in a catalog (empty = valid). */
export function validateCatalog(entries: CatalogEntry[] = ENTRIES): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  const cats = new Set(CATEGORIES.map((c) => c.slug));
  const icons = new Set(ICON_NAMES);
  for (const e of entries) {
    const at = `${e.category}/${e.id}`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id ?? "")) errs.push(`${at}: bad id`);
    if (!cats.has(e.category)) errs.push(`${at}: unknown category`);
    if (!e.title?.trim()) errs.push(`${at}: empty title`);
    const u = uuidOf(e);
    if (seen.has(u)) errs.push(`${at}: duplicate UUID ${u}`);
    seen.add(u);
    if (!["exact", "prefix", "alternates"].includes(e.match)) errs.push(`${at}: bad match`);
    if (typeof e.holdToFire !== "boolean") errs.push(`${at}: holdToFire must be boolean`);
    if (!icons.has(e.icon)) errs.push(`${at}: unknown icon "${e.icon}"`);
    if (isTab(e)) {
      if (e.category !== "tabs") errs.push(`${at}: tab entry outside the Tabs category`);
      if (!(TABS as readonly string[]).includes(e.tab ?? "")) errs.push(`${at}: unknown tab`);
      continue;
    }
    if (e.category === "tabs") errs.push(`${at}: Tabs entries must have kind "tab"`);
    const p = e.menuPath;
    if (!Array.isArray(p) || p.length < 2 || p.some((x) => typeof x !== "string" || !x)) errs.push(`${at}: invalid menuPath`);
    else if (!TOP_MENUS.includes(p[0])) errs.push(`${at}: menuPath must start at a Capture menu (${TOP_MENUS.join(", ")})`);
    if (e.match === "alternates") {
      const last = p?.[p.length - 1] ?? "";
      if (!e.alternates || e.alternates.length < 2 || e.alternates.join("|") !== last) errs.push(`${at}: alternates must match the last path element "A|B"`);
    }
    for (const f of e.fallbackPaths ?? []) if (!Array.isArray(f) || f.length < 2 || !TOP_MENUS.includes(f[0])) errs.push(`${at}: invalid fallbackPath`);
  }
  return errs;
}
