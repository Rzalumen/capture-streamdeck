/**
 * Everything the actions and the Setup page use: show model + address setup + selection + DMX engine, wired together.
 * A fixture is CONTROLLABLE when its type parsed safely, the setup gives it an address and that address has no problem (range,
 * past 512, overlap). Output is released whenever the setup changes or a different show is read, so no stale address stays live.
 */
import { dialAttr, stepFraction, homeValue, type AttrId, type DialId } from "./attrs.js";
import type { DmxEngine } from "./engine.js";
import { Selection, toTarget, type Controllable } from "./selection.js";
import { autoFill, checkSetup, showKey, validateAddress, type Address, type SetupEntry, type SetupStore } from "./setup.js";
import { positionHint, type ShowModel } from "./show.js";

export const BLACKOUT_WARNING = "While output is on, every universe you touch is sent in full: all slots that are not set by a fixture you touched are 0. That BLACKS OUT anything else on that universe, including fixtures that are not set up here.";

export interface SetupFixtureView {
  key: string;
  channel: number;
  manufacturer: string;
  name: string;
  mode: string;
  channelCount: number;
  typeKey: string;
  position: string;
  hasPanTilt: boolean;
  /** The type's channel list parsed safely. */
  parsed: boolean;
  parseError: string | null;
  notes: string[];
  addr: Address | null;
  issues: string[];
  controllable: boolean;
}
export interface SetupView {
  status: string;
  error: string | null;
  showName: string | null;
  fixtures: SetupFixtureView[];
  controllable: number;
  active: boolean;
  universes: number[];
  blackoutWarning: string;
}

export interface DialReadout {
  /** What the dial controls on the selected fixture (null: the fixture lacks it, or nothing is selected). */
  attr: AttrId | null;
  label: string;
  /** 0..1, or null when not available ("—"). */
  value: number | null;
  /** True once the selected fixture has been touched (output is going out); false = the value shown is what a touch would start from. */
  touched: boolean;
  all: boolean;
}

export interface StatusView {
  showName: string | null;
  syncStatus: string;
  error: string | null;
  controllable: number;
  fixtures: number;
  active: boolean;
  universes: number[];
}

const DIAL_LABEL: Record<DialId, string> = { pan: "Pan", tilt: "Tilt", intensity: "Intensity", zoom: "Zoom", focus: "Focus", iris: "Iris", "red-cyan": "Red|Cyan", "green-magenta": "Green|Magenta", "blue-yellow": "Blue|Yellow", white: "White" };
const ATTR_LABEL: Record<AttrId, string> = { pan: "Pan", tilt: "Tilt", intensity: "Intensity", zoom: "Zoom", focus: "Focus", iris: "Iris", red: "Red", green: "Green", blue: "Blue", white: "White", cyan: "Cyan", magenta: "Magenta", yellow: "Yellow" };

export class FixtureService {
  readonly selection: Selection;
  private listeners: (() => void)[] = [];
  private lastShow: string | null | undefined;

  constructor(
    readonly show: ShowModel,
    readonly setup: SetupStore,
    readonly engine: DmxEngine,
    private log: (s: string) => void = () => undefined,
  ) {
    this.selection = new Selection(() => this.controllables());
    show.onChange(() => {
      if (show.status === "ok" && this.lastShow !== undefined && this.lastShow !== show.showName && this.engine.active) {
        this.log(`a different show was read ("${show.showName ?? ""}"): releasing output`);
        void this.engine.release();
      }
      if (show.status === "ok") this.lastShow = show.showName;
      this.emit();
    });
    setup.onChange(() => {
      if (this.engine.active) {
        this.log("the address setup changed: releasing output");
        void this.engine.release();
      }
      this.emit();
    });
    engine.onChange(() => this.emit());
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------------ model

  private issues(): Map<string, string[]> {
    const saved = this.setup.forShow(this.show.showName);
    const entries: SetupEntry[] = [];
    for (const f of this.show.fixtures) {
      const a = saved[f.key];
      if (a) entries.push({ key: f.key, label: `${f.name} Ch ${f.channel}`, channelCount: f.channelCount, addr: a });
    }
    return checkSetup(entries);
  }

  /** Controllable fixtures in Capture-channel order. */
  controllables(): Controllable[] {
    const saved = this.setup.forShow(this.show.showName);
    const issues = this.issues();
    const out: Controllable[] = [];
    for (const f of this.show.fixtures) {
      const addr = saved[f.key];
      const t = this.show.types.get(f.typeKey);
      if (!addr || !t?.ok || !t.map || issues.has(f.key)) continue;
      out.push({ fixture: f, map: t.map, addr });
    }
    return out.sort((a, b) => a.fixture.channel - b.fixture.channel || a.fixture.identifier - b.fixture.identifier);
  }

  setupView(): SetupView {
    const saved = this.setup.forShow(this.show.showName);
    const issues = this.issues();
    const ctl = new Set(this.controllable().map((c) => c.fixture.key));
    const fixtures = this.show.fixtures
      .map<SetupFixtureView>((f) => {
        const t = this.show.types.get(f.typeKey);
        return {
          key: f.key,
          channel: f.channel,
          manufacturer: f.manufacturer,
          name: f.name,
          mode: f.mode,
          channelCount: f.channelCount,
          typeKey: f.typeKey,
          position: positionHint(f.position),
          hasPanTilt: !!t?.hasPanTilt,
          parsed: !!t?.ok,
          parseError: t && !t.ok ? (t.error ?? "unknown") : null,
          notes: t?.notes ?? [],
          addr: saved[f.key] ?? null,
          issues: issues.get(f.key) ?? [],
          controllable: ctl.has(f.key),
        };
      })
      .sort((a, b) => a.channel - b.channel);
    return { status: this.show.status, error: this.show.error, showName: this.show.showName, fixtures, controllable: ctl.size, active: this.engine.active, universes: this.engine.universes, blackoutWarning: BLACKOUT_WARNING };
  }

  private controllable(): Controllable[] {
    return this.controllables();
  }

  status(): StatusView {
    return { showName: this.show.showName, syncStatus: this.show.status, error: this.show.error, controllable: this.controllables().length, fixtures: this.show.fixtures.length, active: this.engine.active, universes: this.engine.universes };
  }

  // ------------------------------------------------------------------ setup edits (Property Inspector)

  /** Set or clear one fixture's address. Returns an error text, or null when saved. */
  async setAddress(key: string, addr: Address | null): Promise<string | null> {
    const f = this.show.fixtures.find((x) => x.key === key);
    if (!f) return "unknown fixture (read the show again)";
    if (addr) {
      const bad = validateAddress(addr.universe, addr.address, f.channelCount);
      if (bad) return bad;
    }
    return this.setup.set(this.show.showName, key, addr);
  }

  /** Auto-fill sequential from a start address over `keys` (in Capture channel order). Returns an error text, or null when saved. */
  async autoFill(keys: string[], start: Address): Promise<string | null> {
    const items = keys
      .map((k) => this.show.fixtures.find((f) => f.key === k))
      .filter((f): f is NonNullable<typeof f> => !!f)
      .sort((a, b) => a.channel - b.channel || a.identifier - b.identifier);
    if (!items.length) return "no fixtures to fill";
    const r = autoFill(items.map((f) => ({ key: f.key, channelCount: f.channelCount })), start);
    if (!r.ok) return r.error;
    return this.setup.setMany(this.show.showName, r.assign);
  }

  // ------------------------------------------------------------------ dials and keys

  /** Rotate the Select dial. */
  rotateSelect(ticks: number): void {
    this.selection.step(ticks);
    this.emit();
  }
  /** Push on the Select dial: single ↔ all of this type. */
  toggleSelectMode(): void {
    this.selection.toggle();
    this.emit();
  }

  readout(dial: DialId): DialReadout {
    const v = this.selection.view();
    const all = v.mode === "type";
    if (!v.primary) return { attr: null, label: DIAL_LABEL[dial], value: null, touched: false, all };
    const attr = dialAttr(v.primary.map, dial);
    if (!attr) return { attr: null, label: DIAL_LABEL[dial], value: null, touched: false, all };
    return { attr, label: ATTR_LABEL[attr], value: this.engine.value(toTarget(v.primary), attr) ?? null, touched: this.engine.isTouched(v.primary.fixture.key), all };
  }

  /** Rotate an attribute dial: ±1 % per tick (0.1 % fine). The value of the selected fixture is the reference; "all of type" sets them all to it. */
  rotate(dial: DialId, ticks: number, fine: boolean): boolean {
    const v = this.selection.view();
    if (!v.primary || !ticks) return false;
    const attr = dialAttr(v.primary.map, dial);
    if (!attr) return false;
    const cur = this.engine.value(toTarget(v.primary), attr) ?? homeValue(attr);
    this.engine.set(v.targets.map(toTarget), attr, stepFraction(cur, ticks, fine));
    return true;
  }

  /** Long touch: the attribute's home value. */
  home(dial: DialId): boolean {
    const v = this.selection.view();
    if (!v.primary) return false;
    const attr = dialAttr(v.primary.map, dial);
    if (!attr) return false;
    this.engine.set(v.targets.map(toTarget), attr, homeValue(attr));
    return true;
  }

  /** Home Selected key: pan/tilt 50 %, intensity 100 % on the selection. */
  homeSelected(): boolean {
    const v = this.selection.view();
    if (!v.primary) return false;
    const before = this.engine.active;
    this.engine.setMany(v.targets.map(toTarget), { pan: homeValue("pan"), tilt: homeValue("tilt"), intensity: homeValue("intensity") });
    return this.engine.active || before;
  }

  async release(): Promise<void> {
    await this.engine.release();
    this.emit();
  }

  /** Key of the current show in the setup store. */
  get showKeyName(): string {
    return showKey(this.show.showName);
  }
}
