/**
 * Handoff 21 (v0.7) / Handoff 27 (v0.9.0): "Deck Control" (arming the knobs) and the remembered channel values.
 *
 *  - v0.10.0 (Handoff 28): the persistent session is opened at plugin start (runtime.ts), not by the first arm; no DMX is sent until
 *    the first fixture touch. Arming (the Deck Control key, any fixture knob turn, strip tap, Home Light, ◀ Page / Page ▶) only lets
 *    the knobs change values (its `start` hook is a no-op while the session is held). v0.9.0: NOTHING on the deck's side ends it. Disarming (the key,
 *    the idle timer, the hidden Release key) only stops the knobs and Home Light changing values: no Stream_Terminated, no LeaveShow,
 *    no close; output keeps running with the same values. Evidence (v0.8.0 log, Reza's Mac, 2026-10-05): the old OFF (termination
 *    ×3, LeaveShow, close) reset the deck-driven lights in Capture once the universes were declared.
 *  - The connection and output end only on plugin exit (termination ×3 + LeaveShow), when Capture leaves / changes the show
 *    (release), and the connection is re-made after Capture closes it (output keeps running meanwhile).
 *
 * ValueMemory keeps the last value the deck sent for every channel of every fixture, per show name, in the global settings, so
 * output resumes where it was instead of snapping to the home values.
 */
import type { GlobalSettings } from "../lib/globals.js";
import { showKey } from "./setup.js";

// ------------------------------------------------------------------ remembered values

export const VALUES_KEY = "fixtureValues";
/** Handoff 22 one-time migration: { version: 1, pending: { show: [fixture keys whose stored shutter/strobe values must go] } }. */
export const MIGRATION_KEY = "fixtureValuesMigration";
export const DECK_KEY = "fixtureDeck";
export const DEFAULT_IDLE_SECONDS = 120;
export const MAX_IDLE_SECONDS = 3600;

/** show -> fixture key -> parameter id -> value 0..1 */
type ValueData = Record<string, Record<string, Record<string, number>>>;

export class ValueMemory {
  private data: ValueData = {};
  /** show -> fixture keys still waiting for the v0.7.1 shutter/strobe clean-up (their type was not known yet). */
  private pending: Record<string, string[]> = {};
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  constructor(
    private globals: GlobalSettings,
    private saveDelayMs = 1000,
    private log: (s: string) => void = () => undefined,
  ) {}

  /** Reads what was stored (malformed entries are ignored). Never throws. */
  async load(): Promise<void> {
    try {
      const g = await this.globals.read();
      const raw = g[VALUES_KEY];
      const data: ValueData = {};
      if (raw && typeof raw === "object") {
        for (const [show, fx] of Object.entries(raw as Record<string, unknown>)) {
          if (!fx || typeof fx !== "object") continue;
          for (const [key, vals] of Object.entries(fx as Record<string, unknown>)) {
            if (!vals || typeof vals !== "object") continue;
            for (const [id, v] of Object.entries(vals as Record<string, unknown>)) {
              if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 && /^ch\d+$/.test(id)) ((data[show] ??= {})[key] ??= {})[id] = v;
            }
          }
        }
      }
      this.data = data;
      // Handoff 22: on the first start of v0.7.1 every stored fixture is marked; its shutter/strobe values are deleted the first time its
      // channel names are known (get() with `isShutterStrobe`), so the old "first shutter = 255" never comes back.
      const mig = g[MIGRATION_KEY] as { version?: unknown; pending?: unknown } | undefined;
      if (mig && mig.version === 1) {
        const pend: Record<string, string[]> = {};
        for (const [show, keys] of Object.entries((mig.pending ?? {}) as Record<string, unknown>)) if (Array.isArray(keys)) pend[show] = keys.filter((k): k is string => typeof k === "string" && !!data[show]?.[k]);
        this.pending = pend;
      } else {
        this.pending = Object.fromEntries(Object.entries(data).map(([show, fx]) => [show, Object.keys(fx)]));
        const n = Object.values(this.pending).reduce((a, k) => a + k.length, 0);
        this.log(`values migration (v0.7.1): ${n} stored fixture(s) will lose their stored shutter/strobe values when their channel list is next read`);
        await this.globals.update({ [MIGRATION_KEY]: { version: 1, pending: this.pending } });
      }
    } catch {
      /* keep what we have */
    }
  }

  /** True while this fixture's stored values still wait for the shutter/strobe clean-up. */
  isPending(showName: string | null, key: string): boolean {
    return !!this.pending[showKey(showName)]?.includes(key);
  }

  /**
   * The stored values of one fixture in one show (undefined: never touched there). `isShutterStrobe(id)` (from the fixture's channel
   * names) runs the one-time clean-up first; a fixture still waiting for it returns nothing (home values) until its names are known.
   */
  get(showName: string | null, key: string, isShutterStrobe?: (id: string) => boolean): ReadonlyMap<string, number> | undefined {
    const s = showKey(showName);
    if (this.isPending(showName, key)) {
      if (!isShutterStrobe) return undefined;
      const v = this.data[s]?.[key] ?? {};
      const gone = Object.keys(v).filter(isShutterStrobe);
      for (const id of gone) delete v[id];
      this.pending[s] = (this.pending[s] ?? []).filter((k) => k !== key);
      if (!this.pending[s].length) delete this.pending[s];
      this.log(`values migration (v0.7.1): ${gone.length ? `removed the stored shutter/strobe value(s) of channel(s) ${gone.map((id) => Number(id.slice(2)) + 1).join(", ")}` : "no stored shutter/strobe values"} for fixture ${key} in show "${s}"`);
      this.dirty = true;
      void this.flush();
    }
    const v = this.data[s]?.[key];
    return v ? new Map(Object.entries(v)) : undefined;
  }

  /** Remember one fixture's values (merged over what was stored; written to the global settings shortly after). */
  set(showName: string | null, key: string, values: ReadonlyMap<string, number>): void {
    const s = showKey(showName);
    const cur = ((this.data[s] ??= {})[key] ??= {});
    for (const [id, v] of values) cur[id] = Math.round(v * 100000) / 100000;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), this.saveDelayMs);
    this.timer.unref?.();
  }

  /** Write now (Deck Control OFF, exit). Resolves when everything changed so far is written (or failed). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dirty) {
      this.dirty = false;
      const snapshot = JSON.parse(JSON.stringify({ [VALUES_KEY]: this.data, [MIGRATION_KEY]: { version: 1, pending: this.pending } })) as Record<string, unknown>;
      this.saving = this.saving.then(async () => {
        try {
          await this.globals.update(snapshot);
        } catch {
          this.dirty = true; // try again next time
        }
      });
    }
    await this.saving;
  }
}

// ------------------------------------------------------------------ Deck Control

export interface DeckOptions {
  /** Make sure the persistent CITP session is held (v0.10.0: it is, from plugin start; a no-op then). */
  start: () => Promise<void>;
  /** Called after a disarm (e.g. to save the remembered values). v0.9.0: disarming sends nothing and closes nothing. */
  afterOff?: () => Promise<void> | void;
  log: (s: string) => void;
  globals?: GlobalSettings;
  /** Test hooks. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class DeckControl {
  private _on = false;
  idleSeconds = DEFAULT_IDLE_SECONDS;
  private timer: unknown;
  private chain: Promise<void> = Promise.resolve();
  private listeners: (() => void)[] = [];

  constructor(private o: DeckOptions) {}

  get on(): boolean {
    return this._on;
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Reads the idle setting. Never throws. */
  async load(): Promise<void> {
    try {
      const d = (await this.o.globals?.read())?.[DECK_KEY] as { idleSeconds?: unknown } | undefined;
      const n = Number(d?.idleSeconds);
      if (d && Number.isInteger(n) && n >= 0 && n <= MAX_IDLE_SECONDS) this.idleSeconds = n;
    } catch {
      /* default */
    }
  }

  /** Setup panel: seconds without fixture activity before Deck Control switches OFF (0 = never). Returns an error text or null. */
  async setIdleSeconds(n: number): Promise<string | null> {
    if (!Number.isInteger(n) || n < 0 || n > MAX_IDLE_SECONDS) return `the idle time must be a whole number of seconds from 0 to ${MAX_IDLE_SECONDS} (0 = never)`;
    this.idleSeconds = n;
    this.arm();
    this.emit();
    try {
      await this.o.globals?.update({ [DECK_KEY]: { idleSeconds: n } });
    } catch (e) {
      return `could not save the idle time: ${(e as Error).message}`;
    }
    this.o.log(`deck control: switch OFF after ${n ? `${n} s without fixture activity` : "never (idle switch-off disabled)"}`);
    return null;
  }

  /**
   * A fixture knob or key was used. If Deck Control is OFF it switches ON first (synchronously, so the DMX that follows is allowed);
   * the idle timer restarts either way.
   */
  activity(why: string): void {
    if (!this._on) this.setOn(true, why);
    else this.arm();
  }

  toggle(why: string): Promise<void> {
    return this.setOn(!this._on, why);
  }

  /**
   * Arm (ON) or disarm (OFF). The flag changes at once. ON also makes sure the persistent CITP session is held (v0.10.0: it is
   * opened at plugin start, so this is a no-op). v0.9.0: OFF only disarms: no termination frames, no LeaveShow, no close, and the
   * selection stays (Capture's FixtureSelection keeps arriving on the connection).
   */
  setOn(on: boolean, why: string): Promise<void> {
    if (on === this._on) {
      if (on) this.arm();
      return this.chain;
    }
    this._on = on;
    if (on) {
      this.arm();
      this.o.log(`deck control ON (${why})`);
      this.emit();
      this.chain = this.chain.then(() => this.o.start().catch((e) => this.o.log(`deck control: starting the CITP session failed: ${(e as Error).message}`)));
      return this.chain;
    }
    this.disarm();
    this.emit();
    this.o.log(`deck control OFF (${why}): knobs disarmed; output and the CITP connection keep running`);
    this.chain = this.chain.then(async () => {
      try {
        await this.o.afterOff?.();
      } catch (e) {
        this.o.log(`deck control: saving after OFF failed: ${(e as Error).message}`);
      }
    });
    return this.chain;
  }

  private disarm(): void {
    if (this.timer !== undefined) (this.o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer);
    this.timer = undefined;
  }
  private arm(): void {
    this.disarm();
    if (!this._on || !this.idleSeconds) return;
    const s = this.idleSeconds;
    this.timer = (this.o.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
      this.timer = undefined;
      void this.setOn(false, `idle ${s} s`);
    }, s * 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Waits for the last switch to finish (tests). */
  settled(): Promise<void> {
    return this.chain;
  }
}
