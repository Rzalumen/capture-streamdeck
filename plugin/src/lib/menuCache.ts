import type { AxBridge } from "./axBridge.js";
import { nullLogger, type Logger } from "./log.js";
import type { MenuTarget } from "./applescript.js";
import { diffCatalog, flattenMenu, normName, resolveMissing, type CatalogLike, type FlatCommand } from "./menu.js";

const TTL_WITHOUT_PID_MS = 10 * 60_000;

const join = (xs: string[], max = 700): string => {
  const s = xs.join("; ");
  return s.length > max ? `${s.slice(0, max)}… (+${xs.length} total)` : s;
};

export interface MenuCacheOptions {
  logger?: Logger;
  entries?: CatalogLike[];
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
  private liveKeys = new Set<string>();

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
   * Where to click for a catalog entry: its own path, or — when the live tree (once read) doesn't contain that path —
   * the fallback path / unique same-named command found there. Never guesses when the tree hasn't been read.
   */
  effective(entry: CatalogLike & { menuPath: string[] }): MenuTarget {
    const primary: MenuTarget = { path: entry.menuPath, match: entry.match };
    if (!this.ready || this.liveKeys.has(JSON.stringify(entry.menuPath.map(normName)))) return primary;
    return resolveMissing(entry, this.commands) ?? primary;
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
      this.commands = flattenMenu(tree);
      this.liveKeys = new Set(this.commands.map((c) => JSON.stringify(c.path.map(normName))));
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

  private reportDiff(): void {
    if (!this.opts.entries) return;
    const { missing, extra } = diffCatalog(this.commands, this.opts.entries);
    if (missing.length) this.log.warn(`Catalog entries not found in this Capture's menus (${missing.length}): ${join(missing.map((m) => m.menuPath.join(" > ")))}`);
    else this.log.info("Every catalog menu entry exists in this Capture's menus");
    if (extra.length) this.log.info(`Capture commands with no catalog entry (${extra.length}): ${join(extra.map((c) => c.path.join(" > ")), 1500)}`);
  }
}

export function describeMenuError(e: unknown): string {
  const k = (e as { kind?: string })?.kind;
  if (k === "noPermission" || k === "noAutomation") return "Allow Access: give Stream Deck access in System Settings → Privacy & Security → Accessibility (and Automation → System Events).";
  if (k === "notRunning") return "Capture is not running. Open Capture, then press Refresh.";
  return `Could not read Capture's menus: ${(e as Error)?.message ?? e}`;
}
