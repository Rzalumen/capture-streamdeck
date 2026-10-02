/**
 * The show model: what Capture's CITP FixtureList says (read-only, once per sync) plus, per fixture TYPE (model + mode), the channel
 * list parsed from the Capture library with all the safety rules of modes.ts. A fixture is "controllable" only when its type parsed
 * safely AND the setup gives it an address (see service.ts).
 */
import type { CaexFixture } from "./citp.js";
import { readShow, type SyncResult } from "./citpSync.js";
import { defaultLibraryPath, openLibrary, type Library } from "./library.js";
import { loadChannels, type Channel } from "./modes.js";
import { drivenSignature, mapChannels, type ChannelMap } from "./attrs.js";

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
  hasPanTilt: boolean;
  /** Ambiguity note / mapping warnings, for the log and the Setup page. */
  notes: string[];
}

export type SyncStatus = "idle" | "syncing" | "ok" | "error";

export interface ShowOptions {
  sync?: () => Promise<SyncResult>;
  libraryPath?: string;
  open?: (path: string) => Library;
  log?: (line: string) => void;
}

const instanceKey = (f: CaexFixture, used: Set<string>): string => {
  const inst = f.ids.find((d) => d.type === 0x04);
  let k = inst ? (inst.guidRaw ?? inst.guid ?? inst.value ?? inst.hex) : `fixture-${f.identifier}`;
  if (!k) k = `fixture-${f.identifier}`;
  while (used.has(k)) k += `#${f.index}`;
  used.add(k);
  return k;
};

/** Stage left/right from X, up/down stage from Z, height from Y (right-handed, Z downstage, Y up as CAEX describes it; NOT verified against a real show). */
export function positionHint(p: [number, number, number]): string {
  const [x, y, z] = p;
  const r = (n: number): string => (Math.round(Math.abs(n) * 10) / 10).toFixed(1);
  return `${x >= 0 ? "SL" : "SR"} ${r(x)} · ${z >= 0 ? "DS" : "US"} ${r(z)} · H ${(Math.round(y * 10) / 10).toFixed(1)}`;
}

export class ShowModel {
  status: SyncStatus = "idle";
  error: string | null = null;
  showName: string | null = null;
  fixtures: ShowFixture[] = [];
  types = new Map<string, TypeInfo>();
  syncedAt: number | null = null;
  private inflight: Promise<void> | undefined;
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

  /** Runs one CITP sync (read-only). Concurrent calls share one run. */
  sync(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.status = "syncing";
    this.emit();
    this.inflight = this.run().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async run(): Promise<void> {
    let r: SyncResult;
    try {
      r = await (this.opts.sync ?? (() => readShow({ log: (l) => this.log(`CITP: ${l}`) })))();
    } catch (e) {
      r = { ok: false, error: `CITP error: ${(e as Error).message}`, fixtures: [], showName: null, log: [] };
    }
    if (!r.ok) {
      this.status = "error";
      this.error = r.error;
      this.log(`show sync failed: ${r.error}`);
      this.emit();
      return;
    }
    const used = new Set<string>();
    const fixtures: ShowFixture[] = r.fixtures.map((f) => {
      const fixtureGuid = f.ids.find((d) => d.type === 0x02)?.guidRaw ?? null;
      const modeGuid = f.ids.find((d) => d.type === 0x03)?.guidRaw ?? null;
      return {
        key: instanceKey(f, used),
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
    const types = this.parseTypes(fixtures);
    this.showName = r.showName;
    this.fixtures = fixtures;
    this.types = types;
    this.status = "ok";
    this.error = null;
    this.syncedAt = Date.now();
    this.log(`show "${r.showName ?? "(unnamed)"}": ${fixtures.length} fixture(s), ${[...types.values()].filter((t) => t.ok).length}/${types.size} type(s) parsed safely`);
    this.emit();
  }

  /** Each type once. A library problem makes every type "not controllable" with the reason; it never throws. */
  private parseTypes(fixtures: ShowFixture[]): Map<string, TypeInfo> {
    const types = new Map<string, TypeInfo>();
    const reps = new Map<string, ShowFixture>();
    for (const f of fixtures) if (!reps.has(f.typeKey)) reps.set(f.typeKey, f);
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
          const notes = [...l.warnings, ...(l.note ? [l.note] : []), ...map.warnings];
          types.set(typeKey, { typeKey, ok: true, channels: l.channels, map, hasPanTilt: !!(map.attrs.pan || map.attrs.tilt), notes });
          for (const n of notes) this.log(`type ${f.name} (${f.mode}): ${n}`);
        } catch (e) {
          types.set(typeKey, bad(`cannot read ${f.fixtureGuid}.c2o from the library: ${(e as Error).message}`));
        }
      }
    } finally {
      lib?.close();
    }
    return types;
  }
}
