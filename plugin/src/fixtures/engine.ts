/**
 * The DMX engine (sACN E1.31). The rules:
 *  - NOTHING is sent until the user touches a fixture; a universe is sent only after a fixture on it was touched.
 *  - Once active: every active universe is sent at 40 fps (all 512 slots; everything not set by a touched fixture is 0 — this BLACKS OUT
 *    whatever else is on that universe) until `release()` or plugin exit, which send Stream_Terminated (3 frames) on every universe in use.
 *  - A fixture's state starts from its defaults on first touch (attrs.ts: pan/tilt 50 %, intensity 100 %, shutter 255, additive colours
 *    full, everything else 0).
 */
import dgram from "node:dgram";
import { localIPv4 } from "./citpSync.js";
import { ALL_ATTRS, defaultValues, homeValue, renderFixture, type AttrId, type ChannelMap } from "./attrs.js";
import { buildDataPacket, DEFAULT_PRIORITY, multicastAddress, OPT_TERMINATED, SACN_PORT } from "./sacn.js";

export const SOURCE_NAME = "capture-streamdeck";
/** Fixed CID: any constant 16 bytes, the same on every run so receivers see one source. */
export const CID = Buffer.from("5f0d2a6e0c4b4d1e9a3f7b21c8d64e05", "hex");
export const FPS = 40;

export interface Target {
  key: string;
  universe: number;
  /** 1-based DMX address of the fixture's first channel. */
  address: number;
  map: ChannelMap;
}

export interface Transport {
  send(packet: Buffer, universe: number): void;
  /** Resolves when everything handed to `send` has left (or after a short timeout), then releases the sockets. */
  close(): Promise<void>;
}

/** Unicast to the host (default 127.0.0.1, where Capture listens) plus the sACN multicast group on every IPv4 interface. */
export class UdpTransport implements Transport {
  private socks: { sock: dgram.Socket; dest: (u: number) => string; ready: boolean }[] = [];
  private pending = 0;
  errors = 0;
  firstError: string | null = null;
  constructor(
    private port = SACN_PORT,
    host = "127.0.0.1",
    multicast = true,
  ) {
    this.open(null, () => host);
    if (multicast) for (const i of localIPv4()) this.open(i.address, multicastAddress);
  }
  private open(iface: string | null, dest: (u: number) => string): void {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const entry = { sock, dest, ready: iface === null };
    sock.on("error", (e: NodeJS.ErrnoException) => {
      this.errors++;
      this.firstError ??= `${e.code ?? ""} ${e.message}`;
    });
    if (iface) {
      sock.bind(0, iface, () => {
        try {
          sock.setMulticastInterface(iface);
          sock.setMulticastTTL(1);
          sock.setMulticastLoopback(true);
          entry.ready = true;
        } catch (e) {
          this.errors++;
          this.firstError ??= `${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`;
        }
      });
    }
    this.socks.push(entry);
  }
  send(packet: Buffer, universe: number): void {
    for (const s of this.socks) {
      if (!s.ready) continue;
      this.pending++;
      try {
        s.sock.send(packet, this.port, s.dest(universe), (e) => {
          this.pending--;
          if (e) {
            this.errors++;
            this.firstError ??= `${(e as NodeJS.ErrnoException).code ?? ""} ${e.message}`;
          }
        });
      } catch (e) {
        this.pending--;
        this.errors++;
        this.firstError ??= (e as Error).message;
      }
    }
  }
  async close(): Promise<void> {
    const t0 = Date.now();
    while (this.pending > 0 && Date.now() - t0 < 500) await new Promise((r) => setTimeout(r, 5));
    for (const s of this.socks) {
      try {
        s.sock.close();
      } catch {
        /* already closed */
      }
    }
    this.socks = [];
  }
}

interface FixState {
  universe: number;
  address: number;
  map: ChannelMap;
  values: Partial<Record<AttrId, number>>;
}

export interface EngineOptions {
  /** Called when the first fixture is touched (a fresh transport per run of output). */
  transport: () => Transport;
  fps?: number;
  priority?: number;
  /** Test hooks. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export class DmxEngine {
  private fixtures = new Map<string, FixState>();
  private seq = new Map<number, number>();
  private transport: Transport | undefined;
  private timer: unknown;
  private listeners: (() => void)[] = [];
  /** Counters for the log / Status key. */
  frames = 0;
  private lastSlots = new Map<number, Uint8Array>();

  constructor(private o: EngineOptions) {}

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** True while frames are going out. */
  get active(): boolean {
    return this.timer !== undefined;
  }
  get universes(): number[] {
    return [...new Set([...this.fixtures.values()].map((f) => f.universe))].sort((a, b) => a - b);
  }
  get touchedCount(): number {
    return this.fixtures.size;
  }
  isTouched(key: string): boolean {
    return this.fixtures.has(key);
  }

  /** Current value of an attribute (the default if the fixture has not been touched yet); undefined when the fixture lacks the attribute. */
  value(t: Target, a: AttrId): number | undefined {
    if (!t.map.attrs[a]?.length) return undefined;
    return this.fixtures.get(t.key)?.values[a] ?? homeValue(a);
  }

  /** The user touched these fixtures: start them from their defaults if new, set `a` to `v` on each that has it, and make sure output is running. */
  set(targets: Target[], a: AttrId, v: number): void {
    const hit = targets.filter((t) => t.map.attrs[a]?.length);
    if (!hit.length) return;
    for (const t of hit) this.touch(t).values[a] = Math.min(1, Math.max(0, v));
    this.start();
    this.emit();
  }

  /** Relative move: each target's attribute becomes `fn(its own current value)` (default value if untouched). One emit for all. */
  setEach(targets: Target[], a: AttrId, fn: (current: number) => number): void {
    const hit = targets.filter((t) => t.map.attrs[a]?.length);
    if (!hit.length) return;
    for (const t of hit) {
      const st = this.touch(t);
      st.values[a] = Math.min(1, Math.max(0, fn(st.values[a] ?? homeValue(a))));
    }
    this.start();
    this.emit();
  }

  /** Home key: these fixtures go back to their first-touch defaults (pan/tilt 50 %, intensity 100 %, additive colours full, the rest 0). */
  home(targets: Target[]): void {
    if (!targets.length) return;
    for (const t of targets) {
      const st = this.touch(t);
      st.values = defaultValues(t.map);
    }
    this.start();
    this.emit();
  }

  /** Where each touched fixture is currently sent (key -> universe/address). */
  touchedAddresses(): Map<string, { universe: number; address: number }> {
    return new Map([...this.fixtures].map(([k, f]) => [k, { universe: f.universe, address: f.address }]));
  }

  /** Set several attributes at once (Home Selected). Only attributes a fixture has are written; if none apply, nothing is touched. */
  setMany(targets: Target[], values: Partial<Record<AttrId, number>>): void {
    let any = false;
    for (const t of targets) {
      const mine = ALL_ATTRS.filter((a) => values[a] !== undefined && t.map.attrs[a]?.length);
      if (!mine.length) continue;
      const st = this.touch(t);
      for (const a of mine) st.values[a] = Math.min(1, Math.max(0, values[a] as number));
      any = true;
    }
    if (!any) return;
    this.start();
    this.emit();
  }

  private touch(t: Target): FixState {
    const have = this.fixtures.get(t.key);
    if (have && have.universe === t.universe && have.address === t.address) return have;
    const st: FixState = { universe: t.universe, address: t.address, map: t.map, values: defaultValues(t.map) };
    this.fixtures.set(t.key, st);
    return st;
  }

  /** All 512 slots of one universe as they would be sent now. */
  slots(universe: number): Uint8Array {
    const s = new Uint8Array(512);
    for (const f of this.fixtures.values()) if (f.universe === universe) renderFixture(s, f.address - 1, f.map, f.values);
    return s;
  }

  private start(): void {
    if (this.timer !== undefined) return;
    this.transport = this.o.transport();
    const fps = this.o.fps ?? FPS;
    this.frame();
    this.timer = (this.o.setInterval ?? ((fn, ms) => setInterval(fn, ms)))(() => this.frame(), 1000 / fps);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private packet(universe: number, slots: Uint8Array, options = 0): Buffer {
    const n = ((this.seq.get(universe) ?? 0) + 1) & 0xff;
    this.seq.set(universe, n);
    return buildDataPacket({ cid: CID, sourceName: SOURCE_NAME, universe, sequence: n, priority: this.o.priority ?? DEFAULT_PRIORITY, options, slots });
  }

  private frame(): void {
    if (!this.transport) return;
    for (const u of this.universes) {
      const slots = this.slots(u);
      this.lastSlots.set(u, slots);
      this.transport.send(this.packet(u, slots), u);
      this.frames++;
    }
  }

  /**
   * Stop all output: 3 Stream_Terminated frames on every universe in use, then forget every fixture state (the next touch starts from
   * defaults again). Safe to call when idle (does nothing and sends nothing).
   */
  async release(): Promise<void> {
    if (this.timer === undefined) {
      this.fixtures.clear();
      return;
    }
    (this.o.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout)))(this.timer);
    this.timer = undefined;
    const tr = this.transport;
    this.transport = undefined;
    const used = this.universes;
    if (tr) {
      for (let k = 0; k < 3; k++) for (const u of used) tr.send(this.packet(u, this.lastSlots.get(u) ?? this.slots(u), OPT_TERMINATED), u);
    }
    this.fixtures.clear();
    this.lastSlots.clear();
    this.emit();
    await tr?.close();
  }
}
