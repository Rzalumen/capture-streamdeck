import { execFile } from "node:child_process";
import {
  buildCheck,
  buildClickMenu,
  buildClickTab,
  buildEnabledBatch,
  buildMenuDump,
  type MenuTarget,
  type TabName,
} from "./applescript.js";
import { nullLogger, type Logger } from "./log.js";
import { parseEnabledBatch, parseMenuDump, type MenuNode } from "./menu.js";
import { SerialQueue } from "./queue.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when killed by timeout. */
  code: number | null;
  timedOut?: boolean;
}

/** Runs osascript with the given `-e` lines. Injectable so tests can fake it. */
export type Runner = (lines: string[], timeoutMs: number) => Promise<ExecResult>;

export const OSASCRIPT = "/usr/bin/osascript";
/** Test hook: point at a fake osascript (integration tests only). */
const osascriptPath = (): string => process.env.CAPTURE_TEST_OSASCRIPT || OSASCRIPT;

export const osascriptRunner: Runner = (lines, timeoutMs) =>
  new Promise((resolve) => {
    const args = lines.flatMap((l) => ["-e", l]);
    execFile(osascriptPath(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") || (e && typeof e.code === "string" ? `${e.code}: ${e.message}` : ""),
        code: e ? (typeof e.code === "number" ? e.code : e.killed ? null : 1) : 0,
        timedOut: !!e?.killed,
      });
    });
  });

/**
 * What the last Accessibility call told us.
 *  - noPermission: Stream Deck is not allowed assistive access  → key says "Allow Access"
 *  - noAutomation: not allowed to control System Events (-1743) → key says "Allow Access"
 *  - notRunning:   Capture isn't running                         → key says "Capture?"
 *  - error:        anything else                                → key says "Error" (raw text logged)
 */
export type AxStatus = "unknown" | "ok" | "noPermission" | "noAutomation" | "notRunning" | "error";

export class AxError extends Error {
  constructor(
    readonly kind: Exclude<AxStatus, "unknown" | "ok">,
    message: string,
    readonly raw: string = message,
  ) {
    super(message);
    this.name = "AxError";
  }
}

/**
 * Map osascript stderr to an error kind. Real osascript wording (to be confirmed on Reza's Mac):
 *   "System Events got an error: osascript is not allowed assistive access. (-25211)"   (also seen with -1719)
 *   "Not authorized to send Apple events to System Events. (-1743)"
 * We match the TEXT first and the codes second; anything unrecognised is a generic "error".
 */
export function classifyAxError(stderr: string): { kind: "noPermission" | "noAutomation" | "error"; raw: string } {
  const raw = stderr.trim();
  if (/not allowed assistive access/i.test(raw) || /\(-25211\)/.test(raw) || /assistive access/i.test(raw)) {
    return { kind: "noPermission", raw };
  }
  if (/not authori[sz]ed to send apple events/i.test(raw) || /\(-1743\)/.test(raw)) {
    return { kind: "noAutomation", raw };
  }
  return { kind: "error", raw };
}

export type ClickResult = "OK" | "DISABLED";

export interface AxOptions {
  runner?: Runner;
  logger?: Logger;
  now?: () => number;
  clickTimeoutMs?: number;
  readTimeoutMs?: number;
  dumpTimeoutMs?: number;
}

/**
 * Accessibility bridge: everything Capture-side goes through one queue so osascript calls never overlap.
 * Clicks are queued ahead of polling. Every call's latency is logged; `latency()` gives the median.
 */
export class AxBridge {
  private q = new SerialQueue();
  private runner: Runner;
  private log: Logger;
  private now: () => number;
  private samples: number[] = [];
  status: AxStatus = "unknown";
  lastError = "";
  onStatus?: (s: AxStatus) => void;
  private opts: Required<Pick<AxOptions, "clickTimeoutMs" | "readTimeoutMs" | "dumpTimeoutMs">>;

  constructor(o: AxOptions = {}) {
    this.runner = o.runner ?? osascriptRunner;
    this.log = o.logger ?? nullLogger;
    this.now = o.now ?? Date.now;
    this.opts = {
      clickTimeoutMs: o.clickTimeoutMs ?? 5000,
      readTimeoutMs: o.readTimeoutMs ?? 4000,
      dumpTimeoutMs: o.dumpTimeoutMs ?? 30000,
    };
  }

  get queue(): SerialQueue {
    return this.q;
  }

  private setStatus(s: AxStatus): void {
    if (s !== this.status) {
      this.status = s;
      this.onStatus?.(s);
    }
  }

  /** Median latency of the last 200 calls, ms (undefined before the first call). */
  latency(): { median: number; count: number; max: number } | undefined {
    if (!this.samples.length) return undefined;
    const s = [...this.samples].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    return { median, count: this.samples.length, max: s[s.length - 1] };
  }

  private async exec(label: string, lines: string[], timeoutMs: number, priority: boolean, coalesceKey?: string): Promise<string> {
    return this.q.enqueue(
      async () => {
        const t0 = this.now();
        const r = await this.runner(lines, timeoutMs);
        const ms = this.now() - t0;
        this.samples.push(ms);
        if (this.samples.length > 200) this.samples.shift();
        this.log.info(`AX ${label}: ${ms} ms${r.timedOut ? " (timed out)" : ""}`);
        if (this.samples.length >= 20 && this.samples.length % 20 === 0) {
          const l = this.latency();
          if (l && l.median > 300) this.log.warn(`AX median latency ${Math.round(l.median)} ms over the last ${l.count} calls (> 300 ms)`);
        }
        if (r.timedOut) {
          this.lastError = `osascript timed out after ${timeoutMs} ms`;
          throw Object.assign(new AxError("error", this.lastError), { timedOut: true });
        }
        if (r.code !== 0) {
          const c = classifyAxError(r.stderr);
          this.lastError = c.raw;
          this.log.error(`AX ${label} failed (${c.kind}): ${c.raw}`);
          this.setStatus(c.kind);
          throw new AxError(c.kind, c.raw);
        }
        const out = r.stdout.trim();
        if (out === "NOTRUNNING") {
          this.setStatus("notRunning");
          throw new AxError("notRunning", "Capture is not running");
        }
        this.setStatus("ok");
        return out;
      },
      { priority, coalesceKey },
    );
  }

  /** Click a menu command. Only ever call this from a user's key press. */
  async clickMenu(t: MenuTarget): Promise<ClickResult> {
    try {
      const out = await this.exec(`click ${t.path.join(" > ")}`, buildClickMenu(t), this.opts.clickTimeoutMs, true);
      return out === "DISABLED" ? "DISABLED" : "OK";
    } catch (e) {
      // A menu command that opens a modal dialog can hold the AX call open until the dialog closes.
      // The click has been delivered by then, so a timeout is not an error for a click.
      if ((e as { timedOut?: boolean }).timedOut) {
        this.log.warn(`click ${t.path.join(" > ")} timed out (modal dialog?) — treated as delivered`);
        return "OK";
      }
      throw e;
    }
  }

  /** Click one of the six tab radio buttons. Only ever call this from a user's key press. */
  async clickTab(tab: TabName): Promise<"OK"> {
    const out = await this.exec(`tab ${tab}`, buildClickTab(tab), this.opts.clickTimeoutMs, true);
    if (out === "NOTAB") throw new AxError("error", `Tab bar "${tab}" not found in any Capture window`);
    return "OK";
  }

  /** Enabled state for all targets in one osascript call; null = not found. Read-only, never activates Capture. */
  async enabledStates(targets: MenuTarget[]): Promise<(boolean | null)[]> {
    if (targets.length === 0) return [];
    const out = await this.exec(`enabled x${targets.length}`, buildEnabledBatch(targets), this.opts.readTimeoutMs, false, "enabled:" + JSON.stringify(targets));
    return parseEnabledBatch(out, targets.length);
  }

  /** Read the whole menu bar (filtered). Read-only. */
  async dumpMenus(): Promise<MenuNode[]> {
    const out = await this.exec("menu dump", buildMenuDump(), this.opts.dumpTimeoutMs, false, "menu-dump");
    return parseMenuDump(out);
  }

  /** Connection key: is Capture running and is Accessibility usable? Never throws. */
  async check(): Promise<AxStatus> {
    try {
      await this.exec("check", buildCheck(), this.opts.readTimeoutMs, true);
    } catch {
      /* status already set */
    }
    return this.status;
  }
}
