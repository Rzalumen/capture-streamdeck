import type { AxBridge } from "./axBridge.js";
import { nullLogger, type Logger } from "./log.js";
import type { MenuTarget } from "./applescript.js";
import { flattenMenu, type FlatCommand, type MenuNode } from "./menu.js";
import { diffCatalog, resolveEntry, type EntryLike } from "./resolve.js";

const TTL_WITHOUT_PID_MS = 10 * 60_000;

const join = (xs: string[], max = 700): string => {
  const s = xs.join("; ");
  return s.length > max ? `${s.slice(0, max)}… (+${xs.length} total)` : s;
};

export interface MenuCacheOptions {
  logger?: Logger;
  entries?: EntryLike[];
  now?: () => number;
}

/**
 * The live menu tree of Capture, cached per Capture process ID. Built in the background (read-only, lowest priority)
 * when Capture's PID is first seen or changes, served from memory to the Property Inspector, and rebuilt on "Refresh".
 * Also the source of truth for self-healing a catalog path that doesn't exist in this Capture version.
 */
export class MenuCache {
  private log: Logger;
  private now: () => number;
  private building: Promise<void> | undefined;
  pid: number | undefined;
  commands: FlatCommand[] = [];
  builtAt = 0;
  error: string | undefined;
  /** Number of complete tree reads (tests). */
  builds = 0;
  /** Called after every successful build (the plugin redraws keys: healed paths may have changed). */
  onBuilt?: () => void;
  /** The raw live tree (exact titles as Capture reports them). Every path sent to Capture is resolved against it. */
  tree: MenuNode[] = [];

  constructor(
    private ax: AxBridge,
    private opts: MenuCacheOptions = {},
  ) {
    this.log = opts.logger ?? nullLogger;
    this.now = opts.now ?? Date.now;
  }

  get ready(): boolean {
    return this.builtAt > 0 && !this.error;
  }

  private fresh(): boolean {
    if (!this.builtAt) return false;
    if (this.ax.pid !== undefined) return this.ax.pid === this.pid;
    return this.now() - this.builtAt < TTL_WITHOUT_PID_MS;
  }

  /**
   * THE path resolver for clicks, polling and the startup report (see resolve.ts). Resolves against the live tree:
   *   ok      → `target` holds Capture's exact titles; send it;
   *   missing → nothing in this Capture matches (`suggestions` = closest live titles); do not click, show "?";
   *   pending → the tree hasn't been read (yet, or at all): `target` is the catalog path with "…" as "...", unverified.
   */
  resolve(entry: EntryLike): CacheResolution {
    if (this.tree.length === 0) return { state: "pending", target: { path: entry.menuPath.map((p) => p.replace(/…/g, "...")), match: entry.match } };
    const r = resolveEntry(this.tree, entry);
    return r.ok ? { state: "ok", target: r.target, via: r.via } : { state: "missing", target: r.target, suggestions: r.suggestions };
  }

  /** Called when Capture's process ID becomes known or changes (a new Capture launch has a new tree). */
  onPid(pid: number): void {
    if (pid !== this.pid) void this.ensure(true).catch(() => undefined);
  }

  /** Capture (re)started, or came back: the tree may differ. */
  invalidate(): void {
    this.builtAt = 0;
  }

  /** Serve from the cache; (re)build in the background when there is none, the PID changed, or `force`. */
  async ensure(force = false): Promise<{ commands: FlatCommand[]; error?: string }> {
    if (force && this.building) await this.building.catch(() => undefined); // a forced read must not return an older in-flight one
    if (!force && this.fresh()) return { commands: this.commands };
    if (!this.building) {
      this.building = this.build().finally(() => {
        this.building = undefined;
      });
    }
    await this.building;
    return { commands: this.commands, error: this.error };
  }

  private async build(): Promise<void> {
    const t0 = this.now();
    try {
      // READ-ONLY: walks the menu bar, one top-level menu per request at the lowest priority; never clicks anything.
      const tree = await this.ax.dumpMenus();
      this.tree = tree;
      this.commands = flattenMenu(tree);
      this.pid = this.ax.pid;
      this.builtAt = this.now();
      this.error = undefined;
      this.builds++;
      this.log.info(`Menu tree cached${this.pid !== undefined ? ` for Capture pid ${this.pid}` : ""}: ${this.commands.length} commands in ${this.now() - t0} ms`);
      this.reportDiff();
      this.onBuilt?.();
    } catch (e) {
      this.error = describeMenuError(e);
      this.log.warn(`Menu tree could not be read: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Startup comparison. Uses the very same resolver as a key press: "found" here means "clickable". */
  private reportDiff(): void {
    if (!this.opts.entries) return;
    const { missing, moved, extra } = diffCatalog(this.tree, this.opts.entries);
    const path = (p: string[]): string => p.join(" > ");
    if (missing.length) {
      this.log.warn(
        `Catalog entries not found in this Capture's menus (${missing.length}): ${join(missing.map((m) => `${path(m.entry.menuPath)}${m.suggestions.length ? ` (closest: ${m.suggestions.join(" | ")})` : ""}`), 1500)}`,
      );
    } else this.log.info("Every catalog menu entry is clickable in this Capture's menus");
    if (moved.length) this.log.info(`Catalog entries found at a different path (${moved.length}): ${join(moved.map((m) => `${path(m.entry.menuPath)} -> ${path(m.to)} (${m.via})`), 1500)}`);
    if (extra.length) this.log.info(`Capture commands with no catalog entry (${extra.length}): ${join(extra.map(path), 1500)}`);
  }
}

export type CacheResolution =
  | { state: "ok"; target: MenuTarget; via: "path" | "fallback" | "name" }
  | { state: "missing"; target: MenuTarget; suggestions: string[] }
  | { state: "pending"; target: MenuTarget };

export function describeMenuError(e: unknown): string {
  const k = (e as { kind?: string })?.kind;
  if (k === "noPermission" || k === "noAutomation") return "Allow Access: give Stream Deck access in System Settings → Privacy & Security → Accessibility (and Automation → System Events).";
  if (k === "notRunning") return "Capture is not running. Open Capture, then press Refresh.";
  return `Could not read Capture's menus: ${(e as Error)?.message ?? e}`;
}
