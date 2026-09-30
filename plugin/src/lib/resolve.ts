/**
 * THE menu title resolver (v0.3.1).
 *
 * Capture's live menu titles are the truth (for example "Patch..." with three ASCII periods), the catalog may spell a
 * title differently ("Patch…"). Every place that needs a menu path goes through `resolveTarget` / `resolveEntry`:
 *   - a key press (what is sent to the worker),
 *   - the enabled-state polling (what is asked of the worker),
 *   - the startup comparison of the catalog with Capture's menus (what is reported as found / missing).
 * Because they all call the same function on the same cached live tree, "found" in the startup log means "clickable".
 *
 * Matching of one path segment: "…" ≡ "...", runs of whitespace collapse, trim, case-insensitive. The segment that is
 * SENT is always the exact live title (so the worker's exact comparison cannot miss). Dynamic titles keep their mode:
 *   - "prefix" (Undo, Redo): the candidate stays a prefix, only the parents are replaced by live titles;
 *   - "alternates" (Enter|Exit Full Screen): each candidate is replaced by its live title when one exists, else kept.
 */
import type { MatchMode, MenuTarget } from "./applescript.js";
import type { MenuNode } from "./menu.js";

/** Canonical form for comparing titles. */
export const canon = (s: string): string => s.replace(/…/g, "...").replace(/\s+/g, " ").trim().toLowerCase();
/** Even more lenient (ignores a trailing ellipsis altogether): only used to find a moved/renamed command by name. */
const loose = (s: string): string => canon(s).replace(/\.\.\.$/, "").trim();

const plainEllipsis = (s: string): string => s.replace(/…/g, "...");

export interface EntryLike {
  menuPath: string[];
  match: MatchMode;
  fallbackPaths?: string[][];
  kind?: string;
}

export type Resolution =
  | {
      ok: true;
      /** What to send to the worker: exact live titles for every parent and (in exact mode) the command. */
      target: MenuTarget;
      /** path: the entry's own path matched; fallback: one of its fallbackPaths; name: a unique same-named command in the same menu. */
      via: "path" | "fallback" | "name";
      /** The live command(s) this resolved to (full live paths). */
      live: string[][];
    }
  | {
      ok: false;
      /** The catalog path with "…" written as "..." (what would have been sent). */
      target: MenuTarget;
      /** Closest live titles, as full paths, best first (at most 3). */
      suggestions: string[];
    };

const childOf = (nodes: MenuNode[], title: string): MenuNode | undefined => {
  const exact = nodes.find((n) => n.name === title);
  if (exact) return exact;
  const c = canon(title);
  return nodes.find((n) => canon(n.name) === c);
};

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[n];
}

/** The closest titles among `nodes` to `wanted`, as full paths below `base`. */
function closest(nodes: MenuNode[], base: string[], wanted: string): string[] {
  const w = loose(wanted);
  return nodes
    .map((n) => {
      const l = loose(n.name);
      const d = levenshtein(w, l) - (l.includes(w) || w.includes(l) ? 3 : 0);
      return { path: [...base, n.name].join(" > "), d };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.path);
}

type Walk = { ok: true; parents: string[]; parentNode: MenuNode[] } | { ok: false; at: number; siblings: MenuNode[]; base: string[] };

/** Descend through the parent segments (all but the last). `nodes` = the top-level menu bar items. */
function walkParents(tree: MenuNode[], path: string[]): Walk {
  let level = tree;
  const parents: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const n = childOf(level, path[i]);
    if (!n) return { ok: false, at: i, siblings: level, base: parents };
    parents.push(n.name);
    level = n.children;
  }
  return { ok: true, parents, parentNode: level };
}

/** Resolve one target (path + mode) against the live tree. */
export function resolveTarget(tree: MenuNode[], t: MenuTarget): Resolution {
  const literal: MenuTarget = { path: t.path.map(plainEllipsis), match: t.match };
  const w = walkParents(tree, t.path);
  if (!w.ok) return { ok: false, target: literal, suggestions: closest(w.siblings, w.base, t.path[w.at]) };
  const last = t.path[t.path.length - 1];

  if (t.match === "exact") {
    const n = childOf(w.parentNode, last);
    if (!n) return { ok: false, target: literal, suggestions: closest(w.parentNode, w.parents, last) };
    const live = [...w.parents, n.name];
    return { ok: true, target: { path: live, match: "exact" }, via: "path", live: [live] };
  }

  if (t.match === "prefix") {
    const cand = plainEllipsis(last);
    const c = canon(cand);
    const n = w.parentNode.find((x) => canon(x.name).startsWith(c));
    if (!n) return { ok: false, target: literal, suggestions: closest(w.parentNode, w.parents, last) };
    // The worker compares prefixes exactly: use the live spelling of the prefix (same length after "…" → "...").
    const sent = n.name.startsWith(cand) ? cand : n.name.slice(0, cand.length).toLowerCase() === cand.toLowerCase() ? n.name.slice(0, cand.length) : cand;
    return { ok: true, target: { path: [...w.parents, sent], match: "prefix" }, via: "path", live: [[...w.parents, n.name]] };
  }

  // alternates "A|B": every candidate that exists live is replaced by its live title; the others are kept (only one
  // of Enter/Exit Full Screen exists at a time).
  const cands = last.split("|").map((s) => s.trim()).filter(Boolean);
  const sent: string[] = [];
  const live: string[][] = [];
  for (const cand of cands) {
    const n = childOf(w.parentNode, cand);
    if (n) {
      sent.push(n.name);
      live.push([...w.parents, n.name]);
    } else sent.push(plainEllipsis(cand));
  }
  if (live.length === 0) return { ok: false, target: literal, suggestions: closest(w.parentNode, w.parents, cands[0] ?? last) };
  return { ok: true, target: { path: [...w.parents, sent.join("|")], match: "alternates" }, via: "path", live };
}

/** Leaf commands (no submenu) of the live tree with their full live paths. */
export function liveLeaves(tree: MenuNode[]): string[][] {
  const out: string[][] = [];
  const walk = (n: MenuNode, path: string[]): void => {
    const p = [...path, n.name];
    if (n.children.length === 0) {
      if (p.length >= 2) out.push(p);
    } else n.children.forEach((c) => walk(c, p));
  };
  tree.forEach((t) => t.children.forEach((c) => walk(c, [t.name])));
  return out;
}

/**
 * Resolve a catalog entry (or a key's own path): its path, then its fallback paths, then the one live command in the same
 * top-level menu with the same name (ignoring case and a trailing ellipsis) when the entry is an exact-title command.
 * Never guesses between two candidates.
 */
export function resolveEntry(tree: MenuNode[], e: EntryLike): Resolution {
  const primary = resolveTarget(tree, { path: e.menuPath, match: e.match });
  if (primary.ok) return primary;
  for (const p of e.fallbackPaths ?? []) {
    const r = resolveTarget(tree, { path: p, match: "exact" });
    if (r.ok) return { ...r, via: "fallback" };
  }
  if (e.match === "exact") {
    const last = loose(e.menuPath[e.menuPath.length - 1] ?? "");
    const top = canon(e.menuPath[0] ?? "");
    const same = liveLeaves(tree).filter((p) => canon(p[0]) === top && loose(p[p.length - 1]) === last);
    if (same.length === 1) return { ok: true, target: { path: same[0], match: "exact" }, via: "name", live: [same[0]] };
  }
  return primary;
}

/** Commands in the live tree that the catalog deliberately doesn't cover. */
const NOT_CATALOGUED = new Set(["file > new", "file > open"]);
const CATALOGUED_MENUS = new Set(["file", "edit", "view", "navigate", "window"]);

export interface CatalogDiff<E extends EntryLike> {
  /** Entries with no live command. */
  missing: { entry: E; suggestions: string[] }[];
  /** Entries that resolved, but not at their own path. */
  moved: { entry: E; to: string[]; via: "fallback" | "name" }[];
  /** Live commands in File/Edit/View/Navigate/Window that no entry resolves to (New and Open… excluded). */
  extra: string[][];
}

/** The startup comparison: catalog vs live tree, using exactly the resolver that clicks use. */
export function diffCatalog<E extends EntryLike>(tree: MenuNode[], entries: E[]): CatalogDiff<E> {
  const covered = new Set<string>();
  const missing: CatalogDiff<E>["missing"] = [];
  const moved: CatalogDiff<E>["moved"] = [];
  for (const e of entries) {
    if (e.kind === "tab") continue;
    const r = resolveEntry(tree, e);
    if (!r.ok) {
      missing.push({ entry: e, suggestions: r.suggestions });
      continue;
    }
    for (const l of r.live) covered.add(JSON.stringify(l.map(canon)));
    if (r.via !== "path") moved.push({ entry: e, to: r.live[0], via: r.via });
  }
  const extra = liveLeaves(tree).filter((p) => {
    if (!CATALOGUED_MENUS.has(canon(p[0]))) return false;
    if (NOT_CATALOGUED.has(p.map(loose).join(" > "))) return false;
    return !covered.has(JSON.stringify(p.map(canon)));
  });
  return { missing, moved, extra };
}
