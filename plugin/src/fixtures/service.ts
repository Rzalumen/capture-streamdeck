/**
 * Everything the actions and the Setup panel use: show model + address setup + selection + DMX engine, wired together.
 * A fixture is CONTROLLABLE when its type parsed safely, the setup gives it an address and that address has no problem (range,
 * past 512, overlap). Output is released on LeaveShow, a different show, and when the setup moves or removes the address of a fixture
 * that is being driven, so no stale address stays live. Capture's own selection (FixtureSelection) and patch changes (FixtureModify,
 * bit 0x01) arrive here through link.ts.
 */
import { dialAttr, stepFraction, homeValue, type AttrId, type DialId } from "./attrs.js";
import type { ModifyItem } from "./citp.js";
import type { DmxEngine, Target } from "./engine.js";
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
  /** How many fixtures the dial drives (> 1: several selected; the value shown is the first one's). */
  multi: number;
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
  private lastRefresh = 0;

  constructor(
    readonly show: ShowModel,
    readonly setup: SetupStore,
    readonly engine: DmxEngine,
    private log: (s: string) => void = () => undefined,
  ) {
    this.selection = new Selection(
      () => this.show.fixtures,
      () => this.controllables(),
    );
    show.onChange(() => this.emit());
    setup.onChange(() => {
      this.reconcile();
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
    const what = `Ch ${f.channel} ${f.name}`;
    if (addr) {
      const bad = validateAddress(addr.universe, addr.address, f.channelCount);
      if (bad) {
        this.log(`set ${what} -> ${addr.universe}/${addr.address} rejected: ${bad}`);
        return bad;
      }
    }
    const err = await this.setup.set(this.show.showName, key, addr);
    if (err) this.log(`set ${what} not saved: ${err}`);
    else this.log(addr ? `set ${what} -> ${addr.universe}/${addr.address}` : `cleared ${what}`);
    return err;
  }

  /** Auto-fill sequential from a start address over `keys` (in Capture channel order). Returns an error text, or null when saved. */
  async autoFill(keys: string[], start: Address): Promise<string | null> {
    const items = keys
      .map((k) => this.show.fixtures.find((f) => f.key === k))
      .filter((f): f is NonNullable<typeof f> => !!f)
      .sort((a, b) => a.channel - b.channel || a.identifier - b.identifier);
    if (!items.length) return "no fixtures to fill";
    const r = autoFill(items.map((f) => ({ key: f.key, channelCount: f.channelCount })), start);
    if (!r.ok) {
      this.log(`auto-fill from ${start.universe}/${start.address} failed: ${r.error}`);
      return r.error;
    }
    const err = await this.setup.setMany(this.show.showName, r.assign);
    if (err) this.log(`auto-fill not saved: ${err}`);
    else for (const f of items) this.log(`set Ch ${f.channel} ${f.name} -> ${r.assign[f.key].universe}/${r.assign[f.key].address} (auto-fill)`);
    return err;
  }

  // ------------------------------------------------------------------ Capture events (via link.ts)

  /** A different show was entered, or Capture left the show: nothing is selected any more and output stops. */
  onShowGone(why: string): void {
    this.selection.clear();
    if (this.engine.active) {
      this.log(`${why}: releasing output`);
      void this.engine.release();
    }
    this.emit();
  }

  /** FixtureSelection from Capture: the deck selection becomes exactly those fixtures (the controllable ones are driven). */
  onSelectionEvent(ids: number[]): void {
    const keys: string[] = [];
    const missing: number[] = [];
    for (const id of ids) {
      const f = this.show.resolve(id);
      if (f) keys.push(f.key);
      else missing.push(id);
    }
    if (!ids.length) {
      this.selection.onCapture([]);
      this.log("Capture's selection is empty: keeping the last selection (marked not selected in Capture)");
    } else {
      if (missing.length) {
        this.log(`Capture selected ${missing.length} fixture(s) not in the list (identifier ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}): asking for a fresh list`);
        if (Date.now() - this.lastRefresh > 2000) {
          this.lastRefresh = Date.now();
          this.show.requestRefresh();
        }
      }
      if (keys.length) {
        this.selection.onCapture(keys);
        const v = this.selection.view();
        const chans = keys.map((k) => this.show.fixtures.find((f) => f.key === k)).map((f) => (f ? (f.channel ? `Ch ${f.channel}` : f.name) : "?"));
        this.log(`Capture selected ${chans.slice(0, 6).join(", ")}${chans.length > 6 ? ", …" : ""}: ${v.targets.length} controllable${v.uncontrollable ? `, ${v.uncontrollable} without address` : ""}`);
      }
    }
    this.emit();
  }

  /** FixtureRemove: Capture deleted fixtures. */
  onRemoved(): void {
    this.emit();
  }

  /**
   * FixtureModify. Only the patch bit (0x01) is used: the fixture's universe and address (converted to 1-based) go into the setup when
   * they fit and do not overlap another fixture; Patched=0 clears the entry. Nothing is ever sent back to Capture.
   */
  async onModify(items: ModifyItem[]): Promise<void> {
    for (const it of items) {
      if (!(it.changed & 0x01)) continue;
      const f = this.show.resolve(it.identifier);
      if (!f) {
        this.log(`patch change for fixture identifier ${it.identifier >>> 0 === 0xffffffff ? "0xffffffff (unidentified)" : it.identifier} which is not in the list: asking for a fresh list`);
        if (Date.now() - this.lastRefresh > 2000) {
          this.lastRefresh = Date.now();
          this.show.requestRefresh();
        }
        continue;
      }
      const what = f.channel ? `Ch ${f.channel}` : f.name;
      const saved = this.setup.get(this.show.showName, f.key);
      if (!it.patched) {
        if (saved) {
          const err = await this.setup.set(this.show.showName, f.key, null);
          this.log(err ? `address of ${what} not cleared: ${err}` : `address from Capture ${what} -> unpatched (cleared ${saved.universe}/${saved.address})`);
        }
        continue;
      }
      const addr: Address = { universe: it.universe + 1, address: it.universeChannel + 1 };
      if (saved && saved.universe === addr.universe && saved.address === addr.address) continue;
      const bad = validateAddress(addr.universe, addr.address, f.channelCount);
      if (bad) {
        this.log(`address from Capture ${what} -> ${addr.universe}/${addr.address} refused: ${bad}`);
        continue;
      }
      const all = this.setup.forShow(this.show.showName);
      const entries: SetupEntry[] = [];
      for (const x of this.show.fixtures) {
        const a = x.key === f.key ? addr : all[x.key];
        if (a) entries.push({ key: x.key, label: `${x.name} Ch ${x.channel}`, channelCount: x.channelCount, addr: a });
      }
      const problem = checkSetup(entries).get(f.key);
      if (problem) {
        this.log(`address from Capture ${what} -> ${addr.universe}/${addr.address} refused: ${problem.join("; ")}`);
        continue;
      }
      const err = await this.setup.set(this.show.showName, f.key, addr);
      this.log(err ? `address from Capture ${what} not saved: ${err}` : `address from Capture ${what} -> ${addr.universe}/${addr.address}`);
    }
  }

  /** The setup moved or removed the address of a fixture we are driving (or made it invalid): stop output. */
  private reconcile(): void {
    const touched = this.engine.touchedAddresses();
    if (!touched.size) return;
    const saved = this.setup.forShow(this.show.showName);
    const issues = this.issues();
    for (const [key, a] of touched) {
      const s = saved[key];
      if (!s || s.universe !== a.universe || s.address !== a.address || issues.has(key)) {
        this.log("the address of a fixture that is being driven changed: releasing output");
        void this.engine.release();
        return;
      }
    }
  }

  // ------------------------------------------------------------------ dials and keys

  /** Rotate the Select dial: choose one controllable fixture by hand (Capture's next click overrides it). */
  rotateSelect(ticks: number): void {
    this.selection.step(ticks);
    this.emit();
  }

  /** The targets of a dial, grouped by the attribute each fixture resolves the dial to (an RGB and a CMY fixture can be selected together). */
  private groups(dial: DialId): Map<AttrId, Target[]> {
    const out = new Map<AttrId, Target[]>();
    for (const c of this.selection.view().targets) {
      const attr = dialAttr(c.map, dial);
      if (attr) out.set(attr, [...(out.get(attr) ?? []), toTarget(c)]);
    }
    return out;
  }

  readout(dial: DialId): DialReadout {
    const v = this.selection.view();
    const none = (): DialReadout => ({ attr: null, label: DIAL_LABEL[dial], value: null, touched: false, multi: v.targets.length });
    if (!v.primary) return none();
    const attr = dialAttr(v.primary.map, dial);
    if (!attr) return none();
    return { attr, label: ATTR_LABEL[attr], value: this.engine.value(toTarget(v.primary), attr) ?? null, touched: this.engine.isTouched(v.primary.fixture.key), multi: v.targets.length };
  }

  /** Rotate an attribute dial: ±1 % per tick (0.1 % fine), each selected fixture relative to its own value. */
  rotate(dial: DialId, ticks: number, fine: boolean): boolean {
    if (!ticks) return false;
    const g = this.groups(dial);
    for (const [attr, ts] of g) this.engine.setEach(ts, attr, (cur) => stepFraction(cur, ticks, fine));
    return g.size > 0;
  }

  /** Knob press: this attribute goes to its home value on every selected fixture (all cells of a colour). */
  home(dial: DialId): boolean {
    const g = this.groups(dial);
    for (const [attr, ts] of g) this.engine.set(ts, attr, homeValue(attr));
    return g.size > 0;
  }

  /** Home key: the selected fixtures (only) at full home, the same defaults as at first touch. */
  homeSelected(): boolean {
    const v = this.selection.view();
    if (!v.targets.length) return false;
    this.engine.home(v.targets.map(toTarget));
    return true;
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
