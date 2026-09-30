import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { nullLogger, type Logger } from "./log.js";

/** Newline-delimited JSON protocol with `com.rezabehjat.capture.sdPlugin/ax/worker.js` (see the header there). */
export interface WorkerRequest {
  op: string;
  [k: string]: unknown;
}

export interface WorkerReply {
  id: number;
  ok: boolean;
  result?: string;
  pid?: number;
  error?: { message: string; number?: number; internal?: boolean; clickAttempted?: boolean };
}

/** The worker process could not be started, keeps crashing, or is disabled. The caller may fall back to per-call osascript. */
export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}
/** The worker exited (or was killed) while this request was in flight. Whether the request ran is unknown. */
export class WorkerExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerExitError";
  }
}
export class WorkerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerTimeoutError";
  }
}

export type SpawnWorker = () => ChildProcessWithoutNullStreams;

/** How to start the worker. Test hooks: CAPTURE_TEST_WORKER = path of a node script standing in for `osascript -l JavaScript worker.js`. */
export function defaultSpawn(workerPath: string): SpawnWorker {
  return () => {
    const fake = process.env.CAPTURE_TEST_WORKER;
    if (fake) return spawn(process.execPath, [fake], { stdio: ["pipe", "pipe", "pipe"] });
    return spawn(process.env.CAPTURE_TEST_OSASCRIPT || "/usr/bin/osascript", ["-l", "JavaScript", workerPath], { stdio: ["pipe", "pipe", "pipe"] });
  };
}

interface Pending {
  resolve: (r: WorkerReply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  op: string;
}

export interface WorkerClientOptions {
  spawn: SpawnWorker;
  logger?: Logger;
  /** Consecutive starts that died without ever answering before the client gives up (default 3). */
  maxStartFailures?: number;
}

/**
 * Owns the ONE long-running worker process. Starts it lazily, restarts it after it exits, kills it when a request
 * times out (a click that opened a modal dialog can block it), and gives up after `maxStartFailures` dead starts.
 * It knows nothing about Accessibility — only about lines of JSON.
 */
export class WorkerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = "";
  private stderrTail = "";
  private answered = false;
  private startFailures = 0;
  private disabled = false;
  private log: Logger;
  /** Number of times a worker process has been started (tests + logs). */
  starts = 0;

  constructor(private opts: WorkerClientOptions) {
    this.log = opts.logger ?? nullLogger;
  }

  get running(): boolean {
    return !!this.child;
  }
  get usable(): boolean {
    return !this.disabled;
  }

  /** Stop using the worker for good (until `enable`). */
  disable(reason: string): void {
    if (!this.disabled) this.log.warn(`AX worker disabled: ${reason}`);
    this.disabled = true;
    this.kill();
  }
  enable(): void {
    this.disabled = false;
    this.startFailures = 0;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.disabled) throw new WorkerUnavailableError("AX worker is disabled");
    if (this.child) return this.child;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.opts.spawn();
    } catch (e) {
      this.noteStartFailure(`spawn failed: ${(e as Error).message}`);
      throw new WorkerUnavailableError(`could not start the AX worker: ${(e as Error).message}`);
    }
    this.starts++;
    this.answered = false;
    this.buf = "";
    this.stderrTail = "";
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.onData(child, d));
    child.stderr.on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    child.stdin.on("error", () => undefined); // an exit shows up through 'exit'; don't crash on EPIPE
    child.on("error", (e) => this.onExit(child, `process error: ${e.message}`));
    child.on("exit", (code, signal) => this.onExit(child, `exited (code ${code}, signal ${signal})`));
    this.log.info(`AX worker started (#${this.starts})`);
    return child;
  }

  private onData(child: ChildProcessWithoutNullStreams, d: string): void {
    if (child !== this.child) return;
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let reply: WorkerReply;
      try {
        reply = JSON.parse(line) as WorkerReply;
      } catch {
        this.log.warn(`AX worker: unparseable line: ${line.slice(0, 200)}`);
        continue;
      }
      this.answered = true;
      this.startFailures = 0;
      const p = this.pending.get(reply.id);
      if (!p) {
        if (reply.id !== undefined) this.log.warn(`AX worker: reply for unknown request ${reply.id}`);
        continue;
      }
      this.pending.delete(reply.id);
      clearTimeout(p.timer);
      p.resolve(reply);
    }
  }

  private noteStartFailure(why: string): void {
    this.startFailures++;
    this.log.warn(`AX worker start failure ${this.startFailures}: ${why}`);
    if (this.startFailures >= (this.opts.maxStartFailures ?? 3)) this.disable(`${this.startFailures} starts in a row died before answering`);
  }

  private onExit(child: ChildProcessWithoutNullStreams, why: string): void {
    if (child !== this.child) return;
    this.child = undefined;
    const tail = this.stderrTail.trim();
    this.log.warn(`AX worker ${why}${tail ? `; stderr: ${tail.slice(-500)}` : ""}`);
    if (!this.answered) this.noteStartFailure(why);
    const err = new WorkerExitError(`AX worker ${why}${tail ? `: ${tail.slice(-300)}` : ""}`);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  kill(): void {
    const c = this.child;
    if (!c) return;
    this.child = undefined; // ignore its later 'exit'
    try {
      c.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      c.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    const err = new WorkerExitError("AX worker was stopped");
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /** Send one request and wait for its reply. Rejects with WorkerUnavailable/Exit/Timeout errors. */
  request(req: WorkerRequest, timeoutMs: number): Promise<WorkerReply> {
    return new Promise<WorkerReply>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.start();
      } catch (e) {
        reject(e as Error);
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        // A stuck call (e.g. a click that opened a modal dialog) blocks the worker: kill it, the next request starts a fresh one.
        this.log.warn(`AX worker request ${req.op} timed out after ${timeoutMs} ms; restarting the worker`);
        reject(new WorkerTimeoutError(`AX worker request "${req.op}" timed out after ${timeoutMs} ms`));
        this.kill();
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, op: req.op });
      const line = JSON.stringify({ ...req, id }).replace(/[\u007f-￿]/g, (c) => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4));
      try {
        child.stdin.write(line + "\n");
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new WorkerExitError(`could not write to the AX worker: ${(e as Error).message}`));
      }
    });
  }

  close(): void {
    this.kill();
  }
}
