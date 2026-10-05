/**
 * The persistent CITP session (v0.5). It stays connected to Capture, reconnects with back-off (2 s -> 30 s) and turns what Capture
 * sends into events; it never decides anything about fixtures itself.
 *
 * Outgoing, everything behind `isAllowedOutgoing` (citp.ts): PNam, an empty LaserFeedList, our own EnterShow (once per connection),
 * FixtureListRequest (on EnterShow, after 5 s if no list came, every 30 s while entered, and when asked), NACK (Reason 3) for
 * requests we do not serve, LeaveShow when we stop, and FixtureIdentify ONLY for fixtures the caller says are still at 0xffffffff
 * (`identify()` refuses every entry that is not in the caller's `allowed` set).
 * v0.8.0 (Handoff 26): right after our EnterShow, the SDMX universe declaration (one SXSr "BSRE1.31/1/1" + one SXUS per universe
 * 1-16), once per connection, with `{sdmxDeclare: true}` on exactly those sends. v0.10.0: the session is the only connection there is
 * (the brief `once` connections are gone), opened at plugin start; a FixtureList event says whether it came after our declaration.
 * Never sent: FixtureList, FixtureModify, FixtureRemove, FixtureSelection, FixtureConsoleStatus, SetFixtureTransformationSpace,
 * SDMX ChBk / ChLs / Capa / UNam / EnId (no DMX over CITP).
 *
 * Events: state(connected) | show(name) | leave() | list({type, fixtures}) | selection(ids) | modify(items) | remove(ids) |
 * levels(ChBk) (v0.8.0: Capture's DMX levels; Capa is only logged; a malformed ChBk is logged with its hex and not emitted).
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import {
  CAEX,
  CitpFramer,
  buildEnterShow,
  buildFixtureIdentify,
  buildFixtureListRequest,
  buildLaserFeedList,
  buildLeaveShow,
  buildNack,
  buildPNam,
  buildDeclaration,
  DECLARED_UNIVERSES,
  decodeMessage,
  hexOf,
  isAllowedOutgoing,
  parseFixtureIdentify,
  type AllowOptions,
  type CaexFixture,
  type ChBk,
  type ModifyItem,
  type SdmxDecoded,
} from "./citp.js";
import { SYNC_NAME, discover, localIPv4, lsofPorts, tryConnect } from "./citpSync.js";

export interface SessionTiming {
  backoffMin: number;
  backoffMax: number;
  /** FixtureListRequest period while connected and entered. */
  rerequestMs: number;
  /** Retry of the first FixtureListRequest when no list came. */
  firstRetryMs: number;
  /** Wait for Capture's UDP announcement per attempt. */
  discoverMs: number;
}
export const DEFAULT_TIMING: SessionTiming = { backoffMin: 2000, backoffMax: 30000, rerequestMs: 30000, firstRetryMs: 5000, discoverMs: 5000 };

/** Test hook: "backoffMin,backoffMax,rerequestMs[,firstRetryMs[,discoverMs]]" in milliseconds. */
export function timingFromEnv(v: string | undefined): SessionTiming {
  if (!v) return DEFAULT_TIMING;
  const n = v.split(",").map((x) => Number(x.trim()));
  if (n.length < 3 || n.some((x) => !Number.isFinite(x) || x <= 0)) return DEFAULT_TIMING;
  return { backoffMin: n[0], backoffMax: n[1], rerequestMs: n[2], firstRetryMs: n[3] ?? DEFAULT_TIMING.firstRetryMs, discoverMs: n[4] ?? DEFAULT_TIMING.discoverMs };
}

export interface FixtureListEvent {
  /** FixtureList Type: 0 = the existing list, 1 = new fixtures, 2 = exchanged fixtures. */
  type: number | null;
  fixtures: CaexFixture[];
  /** v0.10.0: received after our SDMX declaration on this connection (only such a list can carry Capture's patch). */
  declared: boolean;
}

interface Events {
  /** `reason` is set when a connection attempt failed. */
  state: (connected: boolean, reason?: string) => void;
  show: (name: string | null) => void;
  leave: () => void;
  list: (e: FixtureListEvent) => void;
  selection: (ids: number[]) => void;
  modify: (items: ModifyItem[]) => void;
  remove: (ids: number[]) => void;
  /** v0.8.0: one decoded SDMX ChBk (Blind is passed on; the receiver decides). */
  levels: (e: ChBk) => void;
}

export interface SessionOptions {
  /** Fixed target (tests); otherwise discovery + lsof. */
  host?: string;
  port?: number;
  timing?: SessionTiming;
  log?: (s: string) => void;
}

const REQUESTS = new Set<number>([CAEX.GetLiveViewStatus, CAEX.GetLiveViewImage, CAEX.FixtureListRequest, CAEX.FixtureIdentify]);

export class CitpSession {
  private handlers: { [K in keyof Events]: Events[K][] } = { state: [], show: [], leave: [], list: [], selection: [], modify: [], remove: [], levels: [] };
  private t: SessionTiming;
  private running = false;
  /** v0.10.0: the "retrying" line is logged once per run of failed attempts, not on every retry. */
  private retryNoted = false;
  private sock: net.Socket | undefined;
  private lastGood: { h: string; p: number } | undefined;
  private wake: (() => void) | undefined;
  private chain: Promise<void> = Promise.resolve();
  private weEntered = false;
  /** v0.8.0: the universe declaration was queued on this connection. */
  private declared = false;
  /** v0.10.0: every declaration message has been handed to the socket on this connection (FixtureLists after that may carry the patch). */
  private declarationSent = false;
  /** Capture sent EnterShow on this connection and has not left. */
  entered = false;
  connected = false;
  showName: string | null = null;
  private gotList = false;
  private timers: NodeJS.Timeout[] = [];
  private loopDone: Promise<void> = Promise.resolve();
  private lastError = "";
  /** Counters for tests / the log. */
  sent = { identify: 0, listRequest: 0, declarations: 0 };
  /** The waits between connection attempts so far (ms), for the log and tests. */
  readonly delays: number[] = [];

  constructor(private o: SessionOptions = {}) {
    this.t = o.timing ?? DEFAULT_TIMING;
  }

  on<K extends keyof Events>(ev: K, fn: Events[K]): void {
    this.handlers[ev].push(fn);
  }
  private emit<K extends keyof Events>(ev: K, ...args: Parameters<Events[K]>): void {
    for (const fn of this.handlers[ev] as ((...a: Parameters<Events[K]>) => void)[]) {
      try {
        fn(...args);
      } catch (e) {
        this.log(`handler for ${ev} failed: ${(e as Error).message}`);
      }
    }
  }
  private log(s: string): void {
    this.o.log?.(s);
  }

  /** True while the connection loop runs. */
  get active(): boolean {
    return this.running;
  }

  /** Start the connection loop: connect, reconnect with back-off (2 s -> 30 s) until stop(). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.loop();
  }

  /** Leave the show (when we entered), close and stop reconnecting. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    const s = this.sock;
    if (s && !s.destroyed) {
      if (this.weEntered) await this.send("LeaveShow", buildLeaveShow());
      await new Promise((r) => setTimeout(r, 100));
      s.destroy();
    }
    await this.loopDone;
  }

  /** Skip the back-off wait: try to connect right now (no-op when connected). */
  reconnectNow(): void {
    this.wake?.();
  }

  /** Ask Capture for its fixture list (only while connected and in the show). Returns whether a request went out. */
  requestList(): boolean {
    if (!this.connected || !this.entered) return false;
    this.sent.listRequest++;
    void this.send("FixtureListRequest", buildFixtureListRequest());
    return true;
  }

  /**
   * Send ONE FixtureIdentify. Entries whose CaptureInstanceId is not in `allowed` (the caller's current set of fixtures still at
   * 0xffffffff, as raw-order GUID strings) are dropped and logged. Returns the number of entries sent.
   */
  async identify(items: { guid: Buffer; guidRaw: string; identifier: number }[], allowed: ReadonlySet<string>): Promise<number> {
    const ok = items.filter((i) => allowed.has(i.guidRaw) && i.guid.length === 16);
    if (ok.length !== items.length) this.log(`REFUSED ${items.length - ok.length} FixtureIdentify entr${items.length - ok.length === 1 ? "y" : "ies"}: fixture is not unidentified`);
    if (!ok.length || !this.connected || !this.entered) return 0;
    const sent = await this.send("FixtureIdentify", buildFixtureIdentify(ok.map((i) => ({ guid: i.guid, identifier: i.identifier }))));
    if (sent) this.sent.identify += ok.length;
    return sent ? ok.length : 0;
  }

  // ------------------------------------------------------------------ connection loop

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done(): void {
        clearTimeout(t);
        self.wake = undefined;
        resolve();
      }
      this.wake = done;
    });
  }

  private async loop(): Promise<void> {
    let delay = this.t.backoffMin;
    let attempt = 0;
    while (this.running) {
      attempt++;
      let established = false;
      try {
        established = await this.connectOnce(attempt);
      } catch (e) {
        this.noteError(attempt, `CITP error: ${(e as Error).message}`);
      }
      if (!this.running) break;
      if (established) {
        delay = this.t.backoffMin;
        attempt = 0;
        this.retryNoted = false;
      }
      // v0.10.0: once per run of failed attempts (the reason itself is logged by noteError when it changes), not on every retry
      if (!this.retryNoted) {
        this.retryNoted = true;
        this.log(`retrying in ${delay < 1000 ? `${delay} ms` : `${delay / 1000} s`} (then with back-off up to ${this.t.backoffMax / 1000} s; not logged again until connected)`);
      }
      this.delays.push(delay);
      await this.sleep(delay);
      delay = Math.min(delay * 2, this.t.backoffMax);
    }
  }

  private noteError(attempt: number, msg: string): void {
    // log the first failure of a streak, and a changed reason; not the same line every 30 s
    if (attempt === 1 || msg !== this.lastError) this.log(msg);
    this.lastError = msg;
    this.emit("state", false, msg);
  }

  private async connectOnce(attempt: number): Promise<boolean> {
    const ifaces = localIPv4();
    const cands: { h: string; p: number }[] = [];
    const add = (h: string, p: number): void => {
      if (!cands.some((c) => c.h === h && c.p === p)) cands.push({ h, p });
    };
    if (this.lastGood) add(this.lastGood.h, this.lastGood.p);
    if (this.o.port) {
      add(this.o.host ?? "127.0.0.1", this.o.port);
    } else {
      let ports: number[] = [];
      const hosts: string[] = [];
      if (!this.lastGood) {
        const found = await discover(ifaces, this.t.discoverMs, (s) => this.log(s));
        if (found) {
          ports = [found.port];
          if (found.from) hosts.push(found.from);
        }
      }
      if (!this.running) return false;
      if (!ports.length) ports = await lsofPorts();
      if (!ports.length && !this.lastGood) {
        this.noteError(attempt, "Capture not found: it did not announce itself (UDP 4809) and lsof shows no listening Capture TCP port. Is Capture running with a show open?");
        return false;
      }
      for (const h of ["127.0.0.1", ...hosts, ...ifaces.map((i) => i.address)]) for (const p of ports) add(h, p);
    }
    let target: { h: string; p: number } | undefined;
    let socket: net.Socket | undefined;
    for (const c of cands) {
      if (!this.running) return false;
      const r = await tryConnect(c.h, c.p);
      if (r.socket) {
        socket = r.socket;
        target = c;
        break;
      }
    }
    if (!socket || !target) {
      this.lastGood = undefined; // the port may have changed (Capture restarted): look again next time
      this.noteError(attempt, `could not connect to Capture's CITP port (tried ${cands.map((c) => `${c.h}:${c.p}`).join(", ")})`);
      return false;
    }
    this.lastGood = target;
    this.lastError = "";
    this.log(`connected to ${target.h}:${target.p}`);
    await this.run(socket);
    return true;
  }

  /** One connection, until it closes. */
  private run(s: net.Socket): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sock = s;
      this.chain = Promise.resolve();
      this.connected = true;
      this.entered = false;
      this.weEntered = false;
      this.declared = false;
      this.declarationSent = false;
      this.gotList = false;
      const framer = new CitpFramer();
      const sourceKey = randomBytes(4).readUInt32LE(0);
      this.emit("state", true);

      const clearTimers = (): void => {
        for (const t of this.timers) {
          clearTimeout(t);
          clearInterval(t);
        }
        this.timers = [];
      };
      const enter = (): void => {
        if (!this.weEntered) {
          this.weEntered = true;
          void this.send("EnterShow", buildEnterShow(SYNC_NAME));
          this.declare();
        }
        this.requestList();
        clearTimers();
        const retry = setTimeout(() => {
          if (!this.gotList) this.requestList();
        }, this.t.firstRetryMs);
        const every = setInterval(() => this.requestList(), this.t.rerequestMs);
        retry.unref?.();
        every.unref?.();
        this.timers.push(retry, every);
      };

      s.on("data", (d) => {
        for (const m of framer.push(d).messages) {
          const dm = decodeMessage(m);
          if (dm.layer === "SDMX") {
            if (dm.sdmx) this.onSdmx(dm.sdmx, m);
            continue;
          }
          switch (dm.code) {
            case CAEX.GetLaserFeedList:
              void this.send("LaserFeedList (empty)", buildLaserFeedList(sourceKey, []));
              break;
            case CAEX.EnterShow:
              if (dm.layer !== "CAEX") break;
              this.entered = true;
              this.gotList = false;
              this.showName = dm.showName ?? this.showName;
              this.emit("show", this.showName);
              enter();
              break;
            case CAEX.LeaveShow:
              if (dm.layer !== "CAEX") break;
              this.entered = false;
              clearTimers();
              this.emit("leave");
              break;
            case CAEX.FixtureList:
              if (!this.entered) break; // an answer that was still on its way when Capture left the show
              if (dm.fixtures && !dm.fixtures.error) {
                this.gotList = true;
                this.emit("list", { type: dm.fixtures.type, fixtures: dm.fixtures.fixtures, declared: this.declarationSent });
              } else this.log(`FixtureList did not decode: ${dm.fixtures?.error ?? "unknown error"}`);
              break;
            case CAEX.FixtureSelection:
              if (dm.selection) this.emit("selection", dm.selection);
              break;
            case CAEX.FixtureModify:
              if (dm.modify) {
                if (dm.modify.error) this.log(`FixtureModify decoded only partly: ${dm.modify.error}`);
                if (dm.modify.items.length) this.emit("modify", dm.modify.items);
              }
              break;
            case CAEX.FixtureRemove:
              if (dm.remove) this.emit("remove", dm.remove);
              break;
            default:
              if (dm.layer === "CAEX" && dm.code !== null && REQUESTS.has(dm.code)) void this.send("NACK (refused)", buildNack(3));
          }
        }
      });
      s.on("error", () => undefined);
      s.on("close", () => {
        clearTimers();
        const was = this.connected;
        this.connected = false;
        this.entered = false;
        this.sock = undefined;
        if (was) {
          this.log("connection to Capture closed");
          this.emit("state", false);
        }
        resolve();
      });
      void this.send("PNam", buildPNam(SYNC_NAME));
    });
  }

  /**
   * v0.8.0: declare where our DMX comes from (sACN universes 1-16), once per connection, right after our EnterShow: SXSr base 1, then
   * SXUS 1..16, byte for byte what the probe sent on the real Capture. Only this path passes `{sdmxDeclare: true}` to the allowlist.
   */
  private declare(): void {
    if (this.declared) return;
    this.declared = true;
    const msgs = buildDeclaration(DECLARED_UNIVERSES);
    const sock = this.sock;
    const sends = msgs.map((d) => this.send(d.label, d.buf, { sdmxDeclare: true }));
    void Promise.all(sends).then((ok) => {
      const n = ok.filter(Boolean).length;
      if (n === msgs.length) {
        if (this.sock === sock) this.declarationSent = true;
        this.sent.declarations++;
        const u = DECLARED_UNIVERSES;
        this.log(`declared sACN universes ${u[0]}-${u[u.length - 1]} (SXSr + ${u.length} SXUS)`);
      } else this.log(`SDMX declaration incomplete: ${n} of ${msgs.length} message(s) went out`);
    });
  }

  /** v0.8.0: what Capture sends on the SDMX layer. Never throws; nothing malformed is passed on. */
  private onSdmx(d: SdmxDecoded, raw: Buffer): void {
    if (d.error) {
      this.log(`SDMX ${d.type ?? "?"} malformed (${d.error}); ignored. hex: ${hexOf(raw, 96)}`);
      return;
    }
    if (d.caps) {
      this.log(`SDMX Capa received: ${d.caps.join(", ") || "none"}`);
      return;
    }
    if (d.chbk) {
      this.emit("levels", d.chbk);
      return;
    }
    this.log(`SDMX ${d.type ?? "?"} received (not used): ${hexOf(raw, 96)}`);
  }

  /** Serialised, allowlist-checked write. Resolves true when the bytes were handed to the socket. */
  private send(label: string, buf: Buffer, allow: AllowOptions = {}): Promise<boolean> {
    const r = this.chain.then(
      () =>
        new Promise<boolean>((res) => {
          if (!isAllowedOutgoing(buf, allow)) {
            this.log(`REFUSED to send ${label}: not on the outgoing allowlist`);
            return res(false);
          }
          const s = this.sock;
          if (!s || s.destroyed) return res(false);
          if (label === "FixtureIdentify") {
            const n = parseFixtureIdentify(buf)?.length ?? 0;
            this.log(`sending FixtureIdentify for ${n} fixture(s)`);
          }
          s.write(buf, () => res(true));
        }),
    );
    this.chain = r.then(() => undefined);
    return r;
  }
}
