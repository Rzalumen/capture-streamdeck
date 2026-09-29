import { decodeName, type MatchMode, type MenuTarget } from "./applescript.js";

export interface MenuNode {
  name: string;
  enabled: boolean;
  children: MenuNode[];
}

/** Top-level menu bar items that macOS/the app add and that are never offered. */
const EXCLUDED_TOP = new Set(["apple", "capture"]);
/** Items macOS injects into app menus (matched ignoring a trailing "…"), with their whole submenus. */
const EXCLUDED_ITEMS = new Set(["writing tools", "autofill", "start dictation", "emoji & symbols", "open recent"]);

const norm = (s: string): string => s.replace(/(…|\.\.\.)\s*$/, "").trim().toLowerCase();

export function isSeparatorName(name: string): boolean {
  return name.trim() === "" || /^\d+$/.test(name.trim());
}

/** Parse the output of `buildMenuDump` (records separated by TAB/CR/LF) into a filtered tree. */
export function parseMenuDump(raw: string): MenuNode[] {
  type Rec = { depth: number; enabled: boolean; name: string };
  const recs: Rec[] = [];
  for (const line of raw.split(/[\t\r\n]+/)) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 3) continue;
    const depth = parseInt(parts[0], 10);
    if (!Number.isFinite(depth)) continue;
    recs.push({ depth, enabled: parts[1] === "1", name: decodeName(parts[2]) });
  }

  const roots: MenuNode[] = [];
  const stack: { depth: number; node: MenuNode | null }[] = []; // node null = excluded subtree
  for (const r of recs) {
    while (stack.length && stack[stack.length - 1].depth >= r.depth) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : undefined;
    let node: MenuNode | null = null;
    const excluded =
      isSeparatorName(r.name) ||
      (r.depth === 0 ? EXCLUDED_TOP.has(norm(r.name)) : EXCLUDED_ITEMS.has(norm(r.name))) ||
      (parent !== undefined && parent.node === null);
    if (!excluded) {
      node = { name: r.name, enabled: r.enabled, children: [] };
      if (parent?.node) parent.node.children.push(node);
      else if (r.depth === 0) roots.push(node);
    }
    stack.push({ depth: r.depth, node });
  }
  return roots;
}

export interface FlatCommand {
  path: string[];
  match: MatchMode;
  /** "View › Camera › Swing to Top" */
  label: string;
  enabled: boolean;
}

const UNDO_REDO = /^(Undo|Redo)\b/;
const FULLSCREEN = /^(Enter|Exit) Full Screen$/;

/**
 * Normalise a live item name into the stored form: "Undo Live" / plain "Undo" → prefix "Undo" (titles are dynamic);
 * "Enter Full Screen" / "Exit Full Screen" → alternates "Enter Full Screen|Exit Full Screen".
 */
export function suggestTarget(path: string[]): MenuTarget {
  const last = path[path.length - 1];
  const head = path.slice(0, -1);
  const m = UNDO_REDO.exec(last);
  if (m) return { path: [...head, m[1]], match: "prefix" };
  if (FULLSCREEN.test(last)) return { path: [...head, "Enter Full Screen|Exit Full Screen"], match: "alternates" };
  return { path, match: "exact" };
}

/** All leaf commands (items without submenu), for the Property Inspector dropdown. */
export function flattenMenu(tree: MenuNode[]): FlatCommand[] {
  const out: FlatCommand[] = [];
  const walk = (n: MenuNode, path: string[]): void => {
    const p = [...path, n.name];
    if (n.children.length === 0) {
      if (p.length >= 2) {
        const t = suggestTarget(p);
        out.push({
          path: t.path,
          match: t.match,
          label: p.join(" › "),
          enabled: n.enabled,
        });
      }
    } else n.children.forEach((c) => walk(c, p));
  };
  tree.forEach((t) => t.children.forEach((c) => walk(c, [t.name])));
  return out;
}

/** Human title for a target: last path element (first alternate, or the prefix). */
export function targetTitle(t: MenuTarget): string {
  const last = t.path[t.path.length - 1] ?? "";
  return t.match === "alternates" ? (last.split("|")[0] ?? last).trim() : last;
}

/** Parse the comma list from buildEnabledBatch. */
export function parseEnabledBatch(out: string, n: number): (boolean | null)[] {
  const parts = out.trim().split(",");
  return Array.from({ length: n }, (_, i) => (parts[i] === "1" ? true : parts[i] === "0" ? false : null));
}
