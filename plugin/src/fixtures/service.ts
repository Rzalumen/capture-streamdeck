/**
 * Everything the actions and the Setup panel use: show model + address setup + selection + DMX engine, wired together.
 * A fixture is CONTROLLABLE when its type parsed safely, the setup gives it an address and that address has no problem (range,
 * past 512, overlap). Output is released on LeaveShow, a different show, and when the setup moves or removes the address of a fixture
 * that is being driven, so no stale address stays live. Capture's own selection (FixtureSelection) and patch changes (FixtureModify,
 * bit 0x01) arrive here through link.ts.
 */
import { dialAttr, stepFraction, homeValue, type AttrId, type DialId } from "./attrs.js";
import type { ModifyItem } from "./citp.js";
import type { DmxEngine, ParamTarget, Target } from "./engine.js";
import { GROUP_LABEL, pageTitle, sameParam, type Page, type Param } from "./pages.js";
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
  /** The type's parse is consistent but not proven unique: "check against Capture's patch view". */
  unproven: boolean;
  addr: Address | null;
  issues: string[];
  controllable: boolean;
}
/** One row of a type's channel list in the Setup panel (Handoff 20 §5). */
export interface SetupChannelView {
  /** 1-based channel number within the fixture (Capture's patch view numbering). */
  n: number;
  name: string;
  /** "8-bit", "16-bit" (the coarse half; `pair` = its fine channel) or "16-bit fine" (`pair` = its coarse channel). */
  bits: "8-bit" | "16-bit" | "16-bit fine";
  pair: number | null;
  /** The knob page it is on ("Shutters 1/3"), "" for a fine half, or a reason it is on none ("hidden (0)"). */
  page: string;
  /** Handoff 22: a hidden channel (function / control / auto): on no page, always sent at 0. Shown greyed out. Absent otherwise. */
  hidden?: true;
}
export interface SetupTypeView {
  channels: SetupChannelView[];
  unproven: boolean;
}

export interface SetupView {
  status: string;
  error: string | null;
  showName: string | null;
  fixtures: SetupFixtureView[];
  /** typeKey -> channel list (parsed types only). */
  types: Record<string, SetupTypeView>;
  /** Handoff 21: Deck Control state and the idle switch-off time (null without Deck Control, e.g. unit tests). */
  deck: { on: boolean; idleSeconds: number } | null;
  controllable: number;
  active: boolean;
  universes: number[];
  blackoutWarning: string;
}

/** What one generic Attribute dial shows. */
export interface AttrReadout {
  /** The parameter on this dial on the current page (null: no fixture, or the page has fewer parameters). */
  param: Param | null;
  label: string;
  value: number | null;
  touched: boolean;
  multi: number;
  /** "Shutters 1/3" (or "" with no fixture). */
  page: string;
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

/** A type's channel list for the Setup panel: every channel, 1-based, with its bit depth and the page it is on. */
export function channelList(channels: { offset: number; name: string; role: number; pair: number }[], model: import("./pages.js").FixtureModel): SetupChannelView[] {
  const pageOf = new Map<string, string>();
  for (const pg of model.pages) for (const p of pg.params) if (p) pageOf.set(p.id, pageTitle(pg));
  const excluded = new Set(model.excluded);
  const hidden = new Set(model.hidden);
  return channels.map((c) => {
    const bitsH: SetupChannelView["bits"] = c.role === 2 ? "16-bit fine" : c.role === 1 ? "16-bit" : "8-bit";
    if (hidden.has(c.offset)) return { n: c.offset + 1, name: c.name, bits: bitsH, pair: bitsH === "8-bit" ? null : c.pair + 1, page: "hidden (0)", hidden: true as const };
    const p = model.byOffset.get(c.offset);
    const fineOfP = !!p && p.slots.some((s) => s.fine?.offset === c.offset);
    const bits: SetupChannelView["bits"] = c.role === 2 ? "16-bit fine" : c.role === 1 ? "16-bit" : "8-bit";
    const pair = bits === "8-bit" ? null : c.pair + 1;
    const page = excluded.has(c.offset) ? "on no page: the candidate parses disagree here" : fineOfP ? "" : p ? (pageOf.get(p.id) ?? "") : "";
    return { n: c.offset + 1, name: c.name, bits, pair, page };
  });
}

/** Handoff 21: what the service needs from Deck Control. */
export interface DeckHooks {
  readonly on: boolean;
  /** A fixture knob or key was used: switches Deck Control ON when OFF, restarts the idle timer. */
  activity(why: string): void;
  readonly idleSeconds: number;
  setIdleSeconds(n: number): Promise<string | null>;
}

export class FixtureService {
  readonly selection: Selection;
  /** Handoff 21: set by the runtime. Without it (unit tests) everything behaves as if Deck Control were always ON. */
  deck: DeckHooks | undefined;
  private listeners: (() => void)[] = [];
  private lastRefresh = 0;
  /** The attribute page shown on the generic dials: its index within the pages of `typeKey` (the first selected fixture's type). */
  private pageState = { typeKey: "", index: 0 };

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
  /** Something outside the service changed what it shows (Deck Control): redraw everything. */
  notify(): void {
    this.emit();
  }
  private emit(): void {
    this.syncPage();
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
      if (!addr || !t?.ok || !t.map || !t.model || issues.has(f.key)) continue;
      out.push({ fixture: f, map: t.map, model: t.model, addr });
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
          unproven: !!t?.unproven,
          addr: saved[f.key] ?? null,
          issues: issues.get(f.key) ?? [],
          controllable: ctl.has(f.key),
        };
      })
      .sort((a, b) => a.channel - b.channel);
    const types: Record<string, SetupTypeView> = {};
    for (const f of fixtures) {
      const t = this.show.types.get(f.typeKey);
      if (types[f.typeKey] || !t?.ok || !t.model) continue;
      types[f.typeKey] = { channels: channelList(t.channels, t.model), unproven: !!t.unproven };
    }
    const deck = this.deck ? { on: this.deck.on, idleSeconds: this.deck.idleSeconds } : null;
    return { status: this.show.status, error: this.show.error, showName: this.show.showName, fixtures, types, deck, controllable: ctl.size, active: this.engine.active, universes: this.engine.universes, blackoutWarning: BLACKOUT_WARNING };
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

  /**
   * Deck Control OFF, or the persistent (ON) CITP connection closed for any reason: the selection belongs to that connection, so it
   * goes. Output is NOT released here (a dropped connection keeps output, as in v0.5). Brief connections never call this.
   */
  onLinkClosed(why: string): void {
    this.selection.clear();
    this.log(`${why}: selection cleared`);
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
      this.log("Capture's selection is empty: nothing selected on the deck");
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

  /** Fixtures: Next Fixture key (v0.7.1): the next controllable fixture, like one tick of the Select dial. */
  nextFixture(): boolean {
    this.deck?.activity("Next Fixture key");
    const before = this.selection.view().primary?.fixture.key;
    this.selection.step(1);
    this.emit();
    return this.selection.view().primary?.fixture.key !== before || this.controllables().length === 1;
  }

  /** Rotate the Select dial: choose one controllable fixture by hand (Capture's next click overrides it). */
  rotateSelect(ticks: number): void {
    this.deck?.activity("Select dial");
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
    this.deck?.activity(`${DIAL_LABEL[dial]} dial`);
    const g = this.groups(dial);
    for (const [attr, ts] of g) this.engine.setEach(ts, attr, (cur) => stepFraction(cur, ticks, fine));
    return g.size > 0;
  }

  /** Knob press: this attribute goes to its home value on every selected fixture (all cells of a colour). */
  home(dial: DialId): boolean {
    this.deck?.activity(`${DIAL_LABEL[dial]} dial`);
    const g = this.groups(dial);
    for (const [attr, ts] of g) this.engine.set(ts, attr, homeValue(attr));
    return g.size > 0;
  }

  /** Home key: the selected fixtures (only) at full home, the same defaults as at first touch. */
  homeSelected(): boolean {
    this.deck?.activity("Home Selected key");
    const v = this.selection.view();
    if (!v.targets.length) return false;
    this.engine.home(v.targets.map(toTarget));
    return true;
  }

  // ------------------------------------------------------------------ attribute pages (Handoff 20)

  /** Keeps the page within the first selected fixture's type: a different type starts at Main (or the first page). */
  private syncPage(): void {
    const primary = this.selection.view().primary;
    const typeKey = primary?.fixture.typeKey ?? "";
    const pages = primary?.model.pages ?? [];
    if (typeKey !== this.pageState.typeKey) {
      const pos = pages.findIndex((p) => p.group === "main");
      this.pageState = { typeKey, index: Math.max(0, pos) };
    } else if (this.pageState.index >= pages.length) this.pageState.index = 0;
  }

  /** The pages of the first selected fixture's type and the one shown now (undefined: nothing controllable selected). */
  pages(): { pages: Page[]; index: number; page?: Page } {
    this.syncPage();
    const pages = this.selection.view().primary?.model.pages ?? [];
    return { pages, index: this.pageState.index, page: pages[this.pageState.index] };
  }

  /** "Shutters 1/3"; "" when no fixture is selected. */
  pageName(): string {
    const p = this.pages().page;
    return p ? pageTitle(p) : "";
  }

  /** ◀ Page / Page ▶: cycle through the pages (wraps). False when there is nothing to page. */
  stepPage(d: number): boolean {
    this.deck?.activity("Page key");
    const { pages, index } = this.pages();
    if (!pages.length || !d) return false;
    const n = pages.length;
    this.pageState.index = (((index + d) % n) + n) % n;
    this.emit();
    return true;
  }

  /** What the generic Attribute dial `slot` (0..2) drives: the parameter on the current page and, per selected fixture, its parameter of the same name. */
  private attrItems(slot: number): { param: Param | null; items: ParamTarget[] } {
    const v = this.selection.view();
    const page = this.pages().page;
    const param = page?.params[slot] ?? null;
    if (!param || !v.primary) return { param: null, items: [] };
    const items: ParamTarget[] = [];
    for (const c of v.targets) {
      const p = c.model === v.primary.model ? param : sameParam(c.model, param);
      if (p) items.push({ target: toTarget(c), params: [p] });
    }
    return { param, items };
  }

  attrReadout(slot: number): AttrReadout {
    const v = this.selection.view();
    const page = this.pages().page;
    const { param } = this.attrItems(slot);
    const pageText = page ? pageTitle(page) : "";
    if (!param || !v.primary) return { param: null, label: page ? (page.placeholders?.[slot] ?? GROUP_LABEL[page.group]) : `Attribute ${slot + 1}`, value: null, touched: false, multi: v.targets.length, page: pageText };
    const t = toTarget(v.primary);
    return { param, label: param.name, value: this.engine.paramValue(t, param), touched: this.engine.isTouched(t.key), multi: v.targets.length, page: pageText };
  }

  /** Turn Attribute dial `slot`: ±1 % per tick (0.1 % fine), each selected fixture relative to its own value; fixtures without a channel of that name are skipped. */
  attrRotate(slot: number, ticks: number, fine: boolean): boolean {
    if (!ticks) return false;
    this.deck?.activity(`Attribute ${slot + 1} dial`);
    return this.engine.adjust(this.attrItems(slot).items, (cur) => stepFraction(cur, ticks, fine));
  }

  /** Press Attribute dial `slot`: that channel to its home value on every selected fixture that has it. */
  attrHome(slot: number): boolean {
    this.deck?.activity(`Attribute ${slot + 1} dial`);
    return this.engine.adjust(this.attrItems(slot).items, (_cur, p) => p.home);
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
