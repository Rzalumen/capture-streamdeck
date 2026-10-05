/**
 * The show model (v0.5): what Capture's CITP FixtureLists say (kept merged: Type 0 replaces, Type 1/2 add or replace single fixtures,
 * FixtureRemove removes) plus, per fixture TYPE (model + mode), the channel list parsed from the Capture library with all the safety
 * rules of modes.ts. A fixture is "controllable" only when its type parsed safely AND the setup gives it an address (see service.ts).
 * The CITP connection itself lives in citpSession.ts; link.ts feeds this model.
 */
import { UNIDENTIFIED, type CaexFixture } from "./citp.js";
import { defaultLibraryPath, openLibrary, type Library } from "./library.js";
import { loadChannels, type Channel } from "./modes.js";
import { drivenSignature, mapChannels, type ChannelMap } from "./attrs.js";
import { buildModel, type FixtureModel } from "./pages.js";

/** v0.10.0: what Setup / Status / the Setup panel show while the session is not connected (it keeps retrying). */
export const WAITING = "Waiting for Capture";

/** The parser's warning when it could not prove the parse is the only one (Handoff 20: shown on the Setup panel). */
export const UNPROVEN_MARK = "uniqueness is not proven";

export interface ShowFixture {
  /** Stable key for the setup: CaptureInstanceId (identifier type 0x04); falls back to the FixtureList identifier. */
  key: string;
  identifier: number;
  /** Capture's own Channel number. */
  channel: number;
  manufacturer: string;
  name: string;
  mode: string;
  channelCount: number;
  fixtureGuid: string | null;
  modeGuid: string | null;
  /** Fixtures of one type share model, mode and channel layout. */
  typeKey: string;
  position: [number, number, number];
}

export interface TypeInfo {
  typeKey: string;
  ok: boolean;
  error?: string;
  channels: Channel[];
  map?: ChannelMap;
  /** Every channel as a knob parameter on a page (Handoff 20). */
  model?: FixtureModel;
  /** The parse is consistent but the parser ran out of search budget before proving no other parse exists. */
  unproven?: boolean;
  /** Offsets where candidate channel lists disagree (never driven). */
  differOffsets?: number[];
  hasPanTilt: boolean;
  /** Ambiguity note / mapping warnings, for the log and the Setup page. */
  notes: string[];
}

export type SyncStatus = "idle" | "syncing" | "ok" | "error";

export interface ShowOptions {
  /** Asks the session for a fresh FixtureList (true when a request went out). */
  request?: () => boolean;
  /** Skips the session's back-off wait. */
  reconnect?: () => void;
  libraryPath?: string;
  open?: (path: string) => Library;
  log?: (line: string) => void;
  /** How long `sync()` waits for the next list (default 8 s). */
  syncWaitMs?: number;
}

/** Stage left/right from X, up/down stage from Z, height from Y (right-handed, Z downstage, Y up as CAEX describes it; NOT verified against a real show). */
export function positionHint(p: [number, number, number]): string {
  const [x, y, z] = p;
  const r = (n: number): string => (Math.round(Math.abs(n) * 10) / 10).toFixed(1);
  return `${x >= 0 ? "SL" : "SR"} ${r(x)} · ${z >= 0 ? "DS" : "US"} ${r(z)} · H ${(Math.round(y * 10) / 10).toFixed(1)}`;
}

/** The position without the height, for the strip: `SL 1.3 · US 0.9`. */
export function positionShort(p: [number, number, number]): string {
  return positionHint(p).split(" · ").slice(0, 2).join(" · ");
}

export class ShowModel {
  status: SyncStatus = "idle";
  error: string | null = null;
  showName: string | null = null;
  fixtures: ShowFixture[] = [];
  types = new Map<string, TypeInfo>();
  syncedAt: number | null = null;
  connected = false;
  /** identifier -> key of numbers we just assigned (FixtureIdentify) that Capture's list does not show yet. */
  pendingIds = new Map<number, string>();
  private raw = new Map<string, CaexFixture>();
  private byId = new Map<number, ShowFixture>();
  private listWaiters: (() => void)[] = [];
  private lastSig = "";
  private listeners: (() => void)[] = [];

  constructor(private opts: ShowOptions = {}) {}

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }
  private log(s: string): void {
    this.opts.log?.(s);
  }

  /** Every fixture Capture has told us about, as Capture reported it (the merged set). */
  rawFixtures(): CaexFixture[] {
    return [...this.raw.values()];
  }

  /** The fixture behind a Capture FixtureIdentifier (including numbers we assigned and Capture has not echoed yet). */
  resolve(identifier: number): ShowFixture | undefined {
    if (identifier === UNIDENTIFIED) return undefined;
    const f = this.byId.get(identifier >>> 0);
    if (f) return f;
    const key = this.pendingIds.get(identifier >>> 0);
    return key ? this.fixtures.find((x) => x.key === key) : undefined;
  }

  // ------------------------------------------------------------------ session events

  /** The session connected, lost the connection or failed to connect (`reason` says why). */
  setConnected(connected: boolean, reason?: string): void {
    const err = connected ? null : `${WAITING}: ${reason ?? "not connected (retrying)"}`;
    if (this.connected === connected && (connected || this.error === err) && this.status !== "idle") return;
    this.connected = connected;
    this.status = connected ? "syncing" : "error";
    this.error = err;
    this.emit();
  }

  /** We closed the connection ourselves (plugin exit): the list stays; this is not an error. */
  setOffline(): void {
    this.connected = false;
    if (this.status === "syncing") {
      this.status = this.fixtures.length ? "ok" : "error";
      this.error = this.fixtures.length ? null : "Capture sent no FixtureList (is a show open?)";
    }
    this.emit();
  }

  /** Capture entered a show. A different name than before clears the old show's fixtures. Returns true when the show changed. */
  setShowName(name: string | null): boolean {
    const changed = this.showName !== null && this.showName !== name;
    if (changed) this.clear();
    this.showName = name;
    this.emit();
    return changed;
  }

  /** LeaveShow, or a show change: forget the fixtures. */
  clear(): void {
    this.raw.clear();
    this.byId.clear();
    this.pendingIds = new Map();
    this.fixtures = [];
    this.lastSig = "";
    this.status = this.connected ? "syncing" : "error";
    if (!this.connected) this.error = `${WAITING}: not connected (retrying)`;
    this.emit();
  }

  /**
   * A FixtureList message. Type 0 (or unknown) replaces everything; Type 1 and 2 add or replace the fixtures they carry. Returns the
   * message's fixtures by the keys the model uses (v0.10.0: the service reads Capture's patch from them).
   */
  applyList(type: number | null, list: CaexFixture[]): Map<string, CaexFixture> {
    const keyed = this.keyed(list);
    if (type === 1 || type === 2) for (const [k, f] of keyed) this.raw.set(k, f);
    else this.raw = new Map(keyed);
    this.rebuild();
    this.status = "ok";
    this.error = null;
    this.syncedAt = Date.now();
    const sig = `${this.fixtures.length}|${this.fixtures.map((f) => f.identifier).join(",")}`;
    if (sig !== this.lastSig || type === 1 || type === 2) {
      const ok = [...this.types.values()].filter((t) => t.ok).length;
      this.log(`show "${this.showName ?? "(unnamed)"}": ${this.fixtures.length} fixture(s)${type === 1 ? " (new fixtures added)" : type === 2 ? " (fixtures exchanged)" : ""}, ${ok}/${this.types.size} type(s) parsed safely`);
    }
    this.lastSig = sig;
    const waiters = this.listWaiters;
    this.listWaiters = [];
    for (const w of waiters) w();
    this.emit();
    return keyed;
  }

  /** FixtureRemove: drop fixtures by identifier. */
  remove(ids: number[]): void {
    let n = 0;
    for (const [k, f] of [...this.raw]) {
      if (ids.includes(f.identifier) && f.identifier !== UNIDENTIFIED) {
        this.raw.delete(k);
        n++;
      }
    }
    if (!n) return;
    this.rebuild();
    this.log(`Capture removed ${n} fixture(s)`);
    this.emit();
  }

  private keyed(list: CaexFixture[]): Map<string, CaexFixture> {
    const out = new Map<string, CaexFixture>();
    for (const f of list) {
      const inst = f.ids.find((d) => d.type === 0x04);
      let k = inst ? (inst.guidRaw ?? inst.guid ?? inst.value ?? inst.hex) : `fixture-${f.identifier}`;
      if (!k) k = `fixture-${f.identifier}`;
      // a Type 1/2 fixture replaces the one with the same key; only two fixtures of ONE message sharing a key get a suffix
      while (out.has(k)) k += `#${f.index}`;
      out.set(k, f);
    }
    return out;
  }

  private rebuild(): void {
    const fixtures: ShowFixture[] = [...this.raw].map(([key, f]) => {
      const fixtureGuid = f.ids.find((d) => d.type === 0x02)?.guidRaw ?? null;
      const modeGuid = f.ids.find((d) => d.type === 0x03)?.guidRaw ?? null;
      return {
        key,
        identifier: f.identifier,
        channel: f.channel,
        manufacturer: f.manufacturer,
        name: f.name,
        mode: f.mode,
        channelCount: f.channelCount,
        fixtureGuid,
        modeGuid,
        typeKey: fixtureGuid && modeGuid ? `${fixtureGuid}|${modeGuid}|${f.channelCount}` : `name:${f.manufacturer}|${f.name}|${f.mode}|${f.channelCount}`,
        position: f.position,
      };
    });
    this.parseTypes(fixtures, false);
    this.fixtures = fixtures;
    this.byId = new Map(fixtures.filter((f) => f.identifier !== UNIDENTIFIED).map((f) => [f.identifier >>> 0, f]));
  }

  // ------------------------------------------------------------------ asking for a list

  /** Asks Capture for a fresh list without waiting. True when a request went out. */
  requestRefresh(): boolean {
    return this.opts.request?.() ?? false;
  }

  /**
   * "Read the show again": reconnects now when not connected, re-reads the library types that failed, asks for a fresh list and waits
   * for it (up to `syncWaitMs`). Never throws.
   */
  async sync(): Promise<void> {
    this.parseTypes(this.fixtures, true);
    if (!this.connected) {
      this.status = "syncing";
      this.emit();
      this.opts.reconnect?.();
    } else if (!this.requestRefresh()) {
      // connected but Capture is not in a show: nothing to ask; the list arrives with EnterShow
      this.emit();
      return;
    } else {
      this.status = "syncing";
      this.emit();
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, this.opts.syncWaitMs ?? 8000);
      const self = this;
      function done(): void {
        clearTimeout(t);
        self.listWaiters = self.listWaiters.filter((w) => w !== done);
        resolve();
      }
      this.listWaiters.push(done);
    });
    if (this.status === "syncing") {
      this.status = this.fixtures.length ? "ok" : "error";
      if (!this.fixtures.length) this.error = this.connected ? "Capture sent no FixtureList (is a show open?)" : `${WAITING}: not connected (retrying)`;
      this.emit();
    }
  }

  /**
   * Each type once, and only the ones not parsed yet (`retryFailed` also re-reads those that failed). A library problem makes the
   * type "not controllable" with the reason; it never throws. The library is not even opened when nothing is new.
   */
  private parseTypes(fixtures: ShowFixture[], retryFailed: boolean): void {
    const types = this.types;
    const reps = new Map<string, ShowFixture>();
    for (const f of fixtures) if (!reps.has(f.typeKey) && (!types.has(f.typeKey) || (retryFailed && !types.get(f.typeKey)?.ok))) reps.set(f.typeKey, f);
    if (!reps.size) return;
    const libPath = this.opts.libraryPath ?? defaultLibraryPath();
    let lib: Library | undefined;
    let libError: string | undefined;
    try {
      lib = (this.opts.open ?? openLibrary)(libPath);
    } catch (e) {
      libError = `cannot open the Capture library ${libPath}: ${(e as Error).message}`;
    }
    try {
      for (const [typeKey, f] of reps) {
        const bad = (error: string): TypeInfo => ({ typeKey, ok: false, error, channels: [], hasPanTilt: false, notes: [] });
        if (!f.fixtureGuid || !f.modeGuid) {
          types.set(typeKey, bad("Capture did not send both identifiers (AtlaBaseFixtureId, AtlaBaseModeId) for this fixture"));
          continue;
        }
        if (!lib) {
          types.set(typeKey, bad(libError ?? "no library"));
          continue;
        }
        try {
          const obj = lib.readObjectByGuid(f.fixtureGuid);
          const l = loadChannels(obj, f.modeGuid, f.channelCount, drivenSignature);
          if (!l.ok) {
            types.set(typeKey, bad(l.error ?? "channel list did not parse"));
            this.log(`type ${f.name} (${f.mode}): not controllable: ${l.error}`);
            continue;
          }
          const map = mapChannels(l.channels);
          const model = buildModel(l.channels, l.differOffsets);
          const notes = [...l.warnings, ...(l.note ? [l.note] : []), ...map.warnings];
          if (model.noIntensity) notes.push(`no dimmer/intensity channel (Main shows "—" on dial 4); channels: ${l.channels.map((c) => `${c.offset + 1} "${c.name}"`).join(", ")}`);
          if (model.excluded.length) notes.push(`channel(s) ${model.excluded.map((o) => o + 1).join(", ")} are on no knob page: the candidate channel lists disagree there`);
          const unproven = l.warnings.some((w) => w.includes(UNPROVEN_MARK));
          types.set(typeKey, { typeKey, ok: true, channels: l.channels, map, model, unproven, differOffsets: l.differOffsets, hasPanTilt: !!(map.attrs.pan || map.attrs.tilt), notes });
          for (const n of notes) this.log(`type ${f.name} (${f.mode}): ${n}`);
        } catch (e) {
          types.set(typeKey, bad(`cannot read ${f.fixtureGuid}.c2o from the library: ${(e as Error).message}`));
        }
      }
    } finally {
      lib?.close();
    }
  }
}
