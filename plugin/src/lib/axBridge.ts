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
import { DroppedError, SerialQueue } from "./queue.js";
import { Samples } from "./stats.js";
import { WorkerExitError, WorkerTimeoutError, WorkerUnavailableError, type WorkerClient, type WorkerRequest } from "./axWorker.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when killed by timeout. */
  code: number | null;
  timedOut?: boolean;
}

/** Runs osascript with the given `-e` lines. Injectable so tests can fake it. This is the per-call fallback path. */
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

/** "No such menu item" (-1728): the command isn't where the catalog says it is. */
export const isNotFound = (e: unknown): boolean => e instanceof AxError && /\(-1728\)|-1728|No such menu/i.test(e.raw);

/**
 * Map osascript / worker error text to an error kind. Real wording (to be confirmed on Reza's Mac):
 *   "System Events got an error: osascript is not allowed assistive access. (-25211)"   (also seen with -1719)
 *   "Not authorized to send Apple events to System Events. (-1743)"
 * We match the TEXT first and the codes second; anything unrecognised is a generic "error" whose raw text is logged verbatim.
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

/** press = a user's key press (top priority); poll = enabled-state read; bg = background menu-tree read. */
export type CallKind = "press" | "poll" | "bg";
const LEVEL: Record<CallKind, number> = { press: 0, poll: 2, bg: 3 };

export interface AxOptions {
  runner?: Runner;
  /** The persistent worker. Without one, every call is a spawned osascript (the v0.1 behaviour). */
  worker?: WorkerClient;
  logger?: Logger;
  now?: () => number;
  clickTimeoutMs?: number;
  readTimeoutMs?: number;
  dumpTimeoutMs?: number;
}

interface Call {
  label: string;
  kind: CallKind;
  req: WorkerRequest;
  /** AppleScript equivalent for the per-call fallback (undefined = no fallback exists for this op). */
  lines?: string[];
  timeoutMs: number;
  /** Safe to run a second time (no click involved). */
  readOnly: boolean;
  coalesceKey?: string;
}

type Outcome = { t: "ok"; out: string; via: "worker" | "osascript" } | { t: "timeout"; via: "worker" | "osascript" } | { t: "fail"; text: string; via: "worker" | "osascript" };

/**
 * Accessibility bridge: everything Capture-side goes through one queue so calls never overlap.
 *  - presses (clicks, tab clicks, the Connection check) jump ahead of everything and drop any waiting poll;
 *  - polls (enabled states) come next; background reads (menu tree for the Property Inspector) last;
 *  - calls go to the persistent worker when there is one, otherwise (or if the worker fails) to a spawned osascript.
 * Latency is collected per kind and summarised in one log line per window (`summaryLine`).
 */
export class AxBridge {
  private q = new SerialQueue();
  private runner: Runner;
  private worker: WorkerClient | undefined;
  private log: Logger;
  private now: () => number;
  private all = new Samples(200);
  private press = new Samples();
  private pressService = new Samples();
  private poll = new Samples();
  private bg = new Samples();
  private fallbackCalls = 0;
  private internalErrors = 0;
  private summaryTimer: NodeJS.Timeout | undefined;
  status: AxStatus = "unknown";
  lastError = "";
  /** Process ID of Capture as last reported by the worker. */
  pid: number | undefined;
  onStatus?: (s: AxStatus) => void;
  onPid?: (pid: number) => void;
  private opts: Required<Pick<AxOptions, "clickTimeoutMs" | "readTimeoutMs" | "dumpTimeoutMs">>;

  constructor(o: AxOptions = {}) {
    this.runner = o.runner ?? osascriptRunner;
    this.worker = o.worker;
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

  /** "worker" while the persistent worker is in use, "osascript" for per-call spawns. */
  get transport(): "worker" | "osascript" {
    return this.worker?.usable ? "worker" : "osascript";
  }

  private setStatus(s: AxStatus): void {
    if (s !== this.status) {
      this.status = s;
      this.onStatus?.(s);
    }
  }

  private notePid(pid: number): void {
    if (pid !== this.pid) {
      this.pid = pid;
      this.onPid?.(pid);
    }
  }

  /** Median service latency of the last 200 calls, ms (undefined before the first call). */
  latency(): { median: number; count: number; max: number } | undefined {
    if (!this.all.count) return undefined;
    return { median: this.all.median, count: this.all.count, max: this.all.max };
  }

  /** Press latency (key event → result), for the run notes. */
  pressLatency(): { median: number; p95: number; count: number } | undefined {
    return this.press.count ? { median: this.press.median, p95: this.press.p95, count: this.press.count } : undefined;
  }

  /** One-line summary of the calls since the last one (undefined when there were none). Resets the window. */
  summaryLine(): string | undefined {
    if (!this.press.count && !this.poll.count && !this.bg.count) return undefined;
    const line =
      `AX summary: press ${this.press.describe()}${this.press.count ? ` (service median ${Math.round(this.pressService.median)} ms)` : ""}` +
      ` | poll ${this.poll.describe()} | bg ${this.bg.describe()} | via ${this.transport}${this.fallbackCalls ? `, ${this.fallbackCalls} fallback calls` : ""}`;
    this.press.reset();
    this.pressService.reset();
    this.poll.reset();
    this.bg.reset();
    this.fallbackCalls = 0;
    return line;
  }

  /** Log `summaryLine()` every `everyMs` (60 s). */
  startSummary(everyMs = 60_000): void {
    if (this.summaryTimer) return;
    this.summaryTimer = setInterval(() => {
      const l = this.summaryLine();
      if (l) this.log.info(l);
    }, everyMs);
    this.summaryTimer.unref?.();
  }

  stop(): void {
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    this.summaryTimer = undefined;
    this.worker?.close();
  }

  // ------------------------------------------------------------------ transport

  private async viaRunner(c: Call): Promise<Outcome> {
    if (!c.lines) throw new WorkerUnavailableError(`no osascript fallback for "${c.req.op}"`);
    this.fallbackCalls += this.worker ? 1 : 0;
    const r = await this.runner(c.lines, c.timeoutMs);
    if (r.timedOut) return { t: "timeout", via: "osascript" };
    if (r.code !== 0) return { t: "fail", text: r.stderr, via: "osascript" };
    return { t: "ok", out: r.stdout.trim(), via: "osascript" };
  }

  private async execute(c: Call): Promise<Outcome> {
    const w = this.worker;
    if (!w || !w.usable) return this.viaRunner(c);
    let reply;
    try {
      reply = await w.request(c.req, c.timeoutMs);
    } catch (e) {
      if (e instanceof WorkerTimeoutError) return { t: "timeout", via: "worker" };
      if (e instanceof WorkerExitError) {
        // Whether a click ran is unknown: never repeat it. Reads are safe to repeat.
        if (c.readOnly && c.lines) return this.viaRunner(c);
        return { t: "fail", text: e.message, via: "worker" };
      }
      if (e instanceof WorkerUnavailableError) return this.viaRunner(c);
      throw e;
    }
    if (reply.pid !== undefined) this.notePid(reply.pid);
    if (reply.ok) {
      this.internalErrors = 0;
      return { t: "ok", out: (reply.result ?? "").trim(), via: "worker" };
    }
    const err = reply.error ?? { message: "worker error" };
    const text = err.number !== undefined && !err.message.includes(String(err.number)) ? `${err.message} (${err.number})` : err.message;
    if (err.internal && !err.clickAttempted) {
      // A bug in the worker script / an API mismatch (not an Accessibility answer): log verbatim and use the spawned osascript.
      this.log.error(`AX worker internal error on ${c.label}: ${text}`);
      if (++this.internalErrors >= 2) w.disable(`internal errors: ${text}`);
      if (c.lines) return this.viaRunner(c);
      return { t: "fail", text, via: "worker" };
    }
    if (c.readOnly && c.lines && classifyAxError(text).kind === "error" && !/-1728|No such menu/i.test(text)) {
      // An error we can't classify from the worker: ask the authoritative osascript so the real code/text is logged.
      this.log.warn(`AX worker ${c.label} failed with unclassified error "${text}"; re-running through osascript`);
      return this.viaRunner(c);
    }
    return { t: "fail", text, via: "worker" };
  }

  private async exec(c: Call): Promise<string> {
    const enqueued = this.now();
    return this.q.enqueue(
      async () => {
        const t0 = this.now();
        const o = await this.execute(c);
        const t1 = this.now();
        const service = t1 - t0;
        this.all.add(service);
        if (c.kind === "press") {
          this.press.add(t1 - enqueued);
          this.pressService.add(service);
          this.log.info(`AX press ${c.label}: ${t1 - enqueued} ms (queued ${t0 - enqueued} ms, ${service} ms via ${o.via})${o.t === "timeout" ? " TIMED OUT" : ""}`);
        } else if (c.kind === "poll") this.poll.add(service);
        else this.bg.add(service);

        if (o.t === "timeout") {
          this.lastError = `${o.via === "worker" ? "AX worker" : "osascript"} timed out after ${c.timeoutMs} ms`;
          throw Object.assign(new AxError("error", this.lastError), { timedOut: true });
        }
        if (o.t === "fail") {
          const cl = classifyAxError(o.text);
          this.lastError = cl.raw;
          this.log.error(`AX ${c.label} failed (${cl.kind}): ${cl.raw}`);
          this.setStatus(cl.kind);
          throw new AxError(cl.kind, cl.raw);
        }
        if (o.out === "NOTRUNNING") {
          this.setStatus("notRunning");
          throw new AxError("notRunning", "Capture is not running");
        }
        this.setStatus("ok");
        return o.out;
      },
      { level: LEVEL[c.kind], coalesceKey: c.coalesceKey, tag: c.kind === "poll" ? "poll" : undefined },
    );
  }

  /** A press arrived: no waiting poll is worth running any more. */
  private dropPolls(): void {
    const n = this.q.dropWaiting("poll");
    if (n) this.log.debug(`dropped ${n} waiting poll(s) for a press`);
  }

  // ------------------------------------------------------------------ operations

  /** Click a menu command. Only ever call this from a user's key press. */
  async clickMenu(t: MenuTarget): Promise<ClickResult> {
    this.dropPolls();
    try {
      const out = await this.exec({
        label: `click ${t.path.join(" > ")}`,
        kind: "press",
        req: { op: "click", path: t.path, match: t.match },
        lines: buildClickMenu(t),
        timeoutMs: this.opts.clickTimeoutMs,
        readOnly: false,
      });
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
    this.dropPolls();
    const out = await this.exec({
      label: `tab ${tab}`,
      kind: "press",
      req: { op: "tab", tab },
      lines: buildClickTab(tab),
      timeoutMs: this.opts.clickTimeoutMs,
      readOnly: false,
    });
    if (out === "NOTAB") throw new AxError("error", `Tab bar "${tab}" not found in any Capture window`);
    return "OK";
  }

  /** Enabled state for all targets in one call; null = not found. Read-only, never activates Capture. */
  async enabledStates(targets: MenuTarget[]): Promise<(boolean | null)[]> {
    if (targets.length === 0) return [];
    const out = await this.exec({
      label: `enabled x${targets.length}`,
      kind: "poll",
      req: { op: "enabled", targets },
      lines: buildEnabledBatch(targets),
      timeoutMs: this.opts.readTimeoutMs,
      readOnly: true,
      coalesceKey: "poll",
    });
    return parseEnabledBatch(out, targets.length);
  }

  /**
   * Read the whole menu bar (filtered). Read-only, lowest priority. With the worker it is read one top-level menu at a
   * time, so a key press never waits behind more than one menu's worth of reading.
   */
  async dumpMenus(): Promise<MenuNode[]> {
    if (this.worker?.usable) {
      try {
        const n = parseInt(
          await this.exec({ label: "menu bar", kind: "bg", req: { op: "menubar" }, timeoutMs: this.opts.readTimeoutMs, readOnly: true }),
          10,
        );
        if (Number.isFinite(n) && n > 0) {
          let raw = "";
          for (let i = 0; i < n; i++) {
            // each reply is trimmed by exec: records are TAB-separated, so put the separator back between menus
            raw += "\t" + (await this.exec({ label: `menu ${i + 1}/${n}`, kind: "bg", req: { op: "dumpTop", index: i }, timeoutMs: this.opts.dumpTimeoutMs, readOnly: true }));
          }
          return parseMenuDump(raw);
        }
      } catch (e) {
        if (!(e instanceof WorkerUnavailableError)) throw e;
        this.log.warn("menu dump: worker unavailable, reading the whole menu bar with osascript");
      }
    }
    const out = await this.exec({ label: "menu dump", kind: "bg", req: { op: "dump" }, lines: buildMenuDump(), timeoutMs: this.opts.dumpTimeoutMs, readOnly: true, coalesceKey: "menu-dump" });
    return parseMenuDump(out);
  }

  /** Is Capture running and is Accessibility usable? Read-only; never throws. Runs at press priority (Connection key). */
  async check(kind: "press" | "poll" | "bg" = "press"): Promise<AxStatus> {
    if (kind === "press") this.dropPolls();
    try {
      await this.exec({ label: "check", kind, req: { op: "check" }, lines: buildCheck(), timeoutMs: this.opts.readTimeoutMs, readOnly: true, coalesceKey: kind === "poll" ? "poll" : undefined });
    } catch (e) {
      if (!(e instanceof DroppedError)) {
        /* status already set */
      }
    }
    return this.status;
  }
}
