import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { decodeMessage, encodeMessage, oscS, type OscArg, type OscMessage } from "./osc.js";
import { nullLogger, type Logger } from "./log.js";

export const CAPTURE_OSC_HOST = "127.0.0.1";
export const CAPTURE_OSC_PORT = 4004;

export class OscTimeoutError extends Error {
  constructor(address: string, ms: number) {
    super(`No OSC reply for ${address} within ${ms} ms`);
    this.name = "OscTimeoutError";
  }
}

interface Pending {
  replyAddress: string;
  resolve: (m: OscMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** UDP OSC client. Replies from Capture arrive on the sender's own socket. */
export class OscClient extends EventEmitter {
  private socket: dgram.Socket | undefined;
  private pending: Pending[] = [];
  readonly host: string;
  readonly port: number;
  private log: Logger;

  constructor(opts: { host?: string; port?: number; logger?: Logger } = {}) {
    super();
    this.host = opts.host ?? CAPTURE_OSC_HOST;
    this.port = opts.port ?? CAPTURE_OSC_PORT;
    this.log = opts.logger ?? nullLogger;
  }

  open(): Promise<void> {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket("udp4");
      this.socket = s;
      s.on("message", (buf) => this.onPacket(buf));
      s.on("error", (e) => {
        this.log.warn("OSC socket error", e);
      });
      s.once("error", reject);
      s.bind(0, "127.0.0.1", () => {
        s.removeListener("error", reject);
        resolve();
      });
    });
  }

  close(): void {
    for (const p of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("OSC client closed"));
    }
    this.pending = [];
    this.socket?.close();
    this.socket = undefined;
  }

  private onPacket(buf: Buffer): void {
    let msg: OscMessage;
    try {
      msg = decodeMessage(buf);
    } catch (e) {
      this.log.warn("Undecodable OSC packet", (e as Error).message);
      return;
    }
    const i = this.pending.findIndex((p) => p.replyAddress === msg.address);
    if (i >= 0) {
      const [p] = this.pending.splice(i, 1);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
    this.emit("message", msg);
  }

  /** Fire and forget. */
  send(address: string, args: OscArg[] = []): Promise<void> {
    const s = this.socket;
    if (!s) return Promise.reject(new Error("OSC client not open"));
    const buf = encodeMessage(address, args);
    return new Promise((resolve, reject) => {
      s.send(buf, this.port, this.host, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Send and wait for the reply message with `replyAddress` (default: same base, see callers). */
  async request(address: string, args: OscArg[], replyAddress: string, timeoutMs = 1500): Promise<OscMessage> {
    const reply = new Promise<OscMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== entry);
        reject(new OscTimeoutError(address, timeoutMs));
      }, timeoutMs);
      const entry: Pending = { replyAddress, resolve, reject, timer };
      this.pending.push(entry);
    });
    reply.catch(() => undefined); // avoid unhandled rejection if send fails first
    await this.send(address, args);
    return reply;
  }
}

export interface ConnectionState {
  connected: boolean;
  product?: string;
  version?: string;
}

/**
 * Connected = a /pong arrived within `timeoutMs` (default 10 s); a /ping is sent every `pingMs` (default 5 s).
 * /ping is the only thing sent on startup.
 */
export class ConnectionMonitor extends EventEmitter {
  private lastPong = 0;
  private info: { product?: string; version?: string } = {};
  private pingTimer: NodeJS.Timeout | undefined;
  private evalTimer: NodeJS.Timeout | undefined;
  private last: ConnectionState = { connected: false };
  private readonly pingMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private client: OscClient,
    opts: { pingMs?: number; timeoutMs?: number; now?: () => number; logger?: Logger } = {},
  ) {
    super();
    this.pingMs = opts.pingMs ?? 5000;
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.now = opts.now ?? Date.now;
    client.on("message", (m: OscMessage) => {
      if (m.address === "/pong") {
        this.lastPong = this.now();
        this.info = { product: String(m.args[0] ?? ""), version: String(m.args[1] ?? "") };
        this.evaluate();
      }
    });
  }

  get state(): ConnectionState {
    return this.compute();
  }

  private compute(): ConnectionState {
    const connected = this.lastPong > 0 && this.now() - this.lastPong < this.timeoutMs;
    return { connected, ...this.info };
  }

  private evaluate(): void {
    const s = this.compute();
    if (s.connected !== this.last.connected || s.version !== this.last.version) {
      this.last = s;
      this.emit("change", s);
    }
  }

  async pingNow(): Promise<void> {
    try {
      await this.client.send("/ping");
    } catch {
      /* socket problems show up as Offline */
    }
  }

  start(): void {
    if (this.pingTimer) return;
    void this.pingNow();
    this.pingTimer = setInterval(() => void this.pingNow(), this.pingMs);
    this.evalTimer = setInterval(() => this.evaluate(), Math.min(1000, Math.max(20, this.timeoutMs / 4)));
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.evalTimer) clearInterval(this.evalTimer);
    this.pingTimer = this.evalTimer = undefined;
  }

  /** Ping and wait up to `ms` for the pong (used by the Connection key). */
  async check(ms = 1500): Promise<ConnectionState> {
    try {
      await this.client.request("/ping", [], "/pong", ms);
    } catch {
      /* fall through */
    }
    this.evaluate();
    return this.compute();
  }
}

export { oscS };
