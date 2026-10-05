import streamDeck, { type DialAction, type DialDownEvent, type DialRotateEvent, type KeyAction, type KeyDownEvent, type PropertyInspectorDidAppearEvent, type SendToPluginEvent, SingletonAction, type TouchTapEvent, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { FIXTURE_ATTR_DIALS, FIXTURE_KEY_UUIDS, FIXTURE_SELECT_UUID, FIXTURE_DIALS, fixtureKey } from "../catalog/fixtures.js";
import type { DialId } from "../fixtures/attrs.js";
import { attrStripFeedback, deckKeySvg, deckState, fixtureStatusSvg, fixtureStripFeedback, selectStripFeedback, svgDataUrl, type HeaderInput } from "../lib/render.js";
import { runSetupCommand, type SetupCommand } from "../fixtures/setupCommands.js";
import { rt } from "../runtime.js";
import { draw, Flasher, logEvent } from "./util.js";

const svc = () => rt.fixtures;
/** Fixture activity that sends no DMX (fine mode, Setup, Status): restarts the idle timer while Deck Control is ON, never switches it ON. */
const keepAlive = (why: string): void => {
  if (rt.deck.on) rt.deck.activity(why);
};

/** v0.7.3 (Handoff 24): the Deck state and what the header line of the Attribute strips / the Deck key show. */
export const deckHeader = (): HeaderInput => {
  const v = svc().selection.view();
  const pg = svc().pages();
  return {
    state: deckState(rt.deck.on, v.targets.length > 0),
    line1: v.line1,
    line2: v.line2,
    page: svc().pageName(),
    pageIndex: pg.index,
    pageCount: pg.pages.length,
  };
};

// ------------------------------------------------------------------ Fixture: Select

/** Shows what the deck is driving (Capture's selection). Rotate: pick one controllable fixture by hand until Capture's next click. */
export class FixtureSelect extends SingletonAction {
  override readonly manifestId = FIXTURE_SELECT_UUID;
  private dials = new Map<string, DialAction>();

  constructor() {
    super();
    svc().onChange(() => this.redraw());
  }
  private redraw(): void {
    const v = svc().selection.view();
    const fb = selectStripFeedback({ line1: v.line1, line2: v.line2, note: v.note, mark: v.mark, count: v.count });
    for (const d of this.dials.values()) d.setFeedback(fb as never).catch((e) => rt.log.warn("setFeedback failed", e));
  }
  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isDial()) return;
    this.dials.set(ev.action.id, ev.action);
    this.redraw();
  }
  override onWillDisappear(ev: WillDisappearEvent): void {
    this.dials.delete(ev.action.id);
  }
  override onDialRotate(ev: DialRotateEvent): void {
    svc().rotateSelect(ev.payload.ticks);
    const v = svc().selection.view();
    logEvent("Dial rotate", this.manifestId, undefined, `${ev.payload.ticks > 0 ? "+" : ""}${ev.payload.ticks} → ${v.line1} · ${v.line2}`);
  }
}

// ------------------------------------------------------------------ Fixture: Pan / Tilt / ...

interface Ctx {
  action: DialAction;
  fine: boolean;
  rot: { ticks: number; events: number; timer?: NodeJS.Timeout };
}

/** One attribute dial: rotate ±1 %/tick (16-bit aware), push = home this attribute on the selected fixture(s), tap the strip = fine (0.1 %). No-op with "—" when the fixture lacks it. */
export class FixtureAttrDial extends SingletonAction {
  override readonly manifestId: string;
  private ctxs = new Map<string, Ctx>();

  constructor(
    uuid: string,
    private dial: DialId,
  ) {
    super();
    this.manifestId = uuid;
    svc().onChange(() => this.redrawAll());
  }

  private redrawAll(): void {
    for (const c of this.ctxs.values()) this.view(c);
  }
  private view(c: Ctx): void {
    const r = svc().readout(this.dial);
    const fb = fixtureStripFeedback({ name: r.label, value: r.value, fine: c.fine, multi: r.multi, untouched: !r.touched });
    c.action.setFeedback(fb as never).catch((e) => rt.log.warn("setFeedback failed", e));
  }

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isDial()) return;
    const c: Ctx = { action: ev.action, fine: this.ctxs.get(ev.action.id)?.fine ?? false, rot: { ticks: 0, events: 0 } };
    this.ctxs.set(ev.action.id, c);
    this.view(c);
  }
  override onWillDisappear(ev: WillDisappearEvent): void {
    const c = this.ctxs.get(ev.action.id);
    if (c?.rot.timer) clearTimeout(c.rot.timer);
    this.ctxs.delete(ev.action.id);
  }

  override onDialRotate(ev: DialRotateEvent): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    const done = svc().rotate(this.dial, ev.payload.ticks, c.fine);
    if (!done) this.view(c);
    // one log line per turn of the dial
    c.rot.ticks += ev.payload.ticks;
    c.rot.events++;
    if (c.rot.timer) clearTimeout(c.rot.timer);
    c.rot.timer = setTimeout(() => {
      const r = svc().readout(this.dial);
      logEvent("Dial rotate", this.manifestId, { fine: c.fine }, `${c.rot.events} events, ${c.rot.ticks > 0 ? "+" : ""}${c.rot.ticks} ticks → ${r.attr ?? "(attribute missing)"}=${r.value === null ? "—" : `${(r.value * 100).toFixed(1)}%`}${r.multi > 1 ? ` (${r.multi} fixtures)` : ""}`);
      c.rot = { ticks: 0, events: 0 };
    }, 400);
    c.rot.timer.unref?.();
  }

  private toggleFine(c: Ctx, what: string): void {
    c.fine = !c.fine;
    logEvent(what, this.manifestId, undefined, `fine mode ${c.fine ? "on" : "off"}`);
    this.view(c);
  }
  /** Push (Handoff 21): fine mode on/off. */
  override onDialDown(ev: DialDownEvent): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    keepAlive("fine mode");
    this.toggleFine(c, "Dial push");
  }
  /** Tap on the strip (Handoff 21): home this attribute on the selected fixture(s) (a colour: every cell of it). A long touch does nothing. */
  override onTouchTap(ev: TouchTapEvent): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c || ev.payload.hold) return;
    const done = svc().home(this.dial);
    const r = svc().readout(this.dial);
    logEvent("Dial touch", this.manifestId, undefined, done ? `home ${r.attr}${r.multi > 1 ? ` on ${r.multi} fixtures` : ""}` : "attribute missing or nothing selected: nothing done");
    this.view(c);
  }
}

export const fixtureDialActions = (): SingletonAction[] => FIXTURE_DIALS.map((d) => new FixtureAttrDial(d.uuid, d.id));

// ------------------------------------------------------------------ Fixture: Attribute 1 / 2 / 3 (v0.6)

/** Strip title: the channel name, shortened to what fits the strip's name field. */
const stripName = (s: string): string => (s.length > 15 ? `${s.slice(0, 14)}…` : s);

/**
 * A generic attribute dial: shows and drives channel `slot` of the current attribute page (◀ Page / Page ▶) of the selected fixture(s).
 * Rotate ±1 %/tick (16-bit aware), push = home that channel, tap the strip = fine (0.1 %). "—" when the page has no channel here.
 */
export class FixtureSlotDial extends SingletonAction {
  override readonly manifestId: string;
  private ctxs = new Map<string, Ctx>();

  constructor(
    uuid: string,
    private slot: number,
  ) {
    super();
    this.manifestId = uuid;
    svc().onChange(() => this.redrawAll());
    // v0.7.3: the header line shows the Deck state, so it changes the moment Deck Control turns ON/OFF
    rt.deck.onChange(() => this.redrawAll());
  }
  private redrawAll(): void {
    for (const c of this.ctxs.values()) this.view(c);
  }
  private view(c: Ctx): void {
    const r = svc().attrReadout(this.slot);
    const fb = attrStripFeedback({ name: stripName(r.label), value: r.value, fine: c.fine, multi: r.multi, untouched: !r.touched, slot: this.slot, header: deckHeader() });
    c.action.setFeedback(fb as never).catch((e) => rt.log.warn("setFeedback failed", e));
  }
  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isDial()) return;
    const c: Ctx = { action: ev.action, fine: this.ctxs.get(ev.action.id)?.fine ?? false, rot: { ticks: 0, events: 0 } };
    this.ctxs.set(ev.action.id, c);
    this.view(c);
  }
  override onWillDisappear(ev: WillDisappearEvent): void {
    const c = this.ctxs.get(ev.action.id);
    if (c?.rot.timer) clearTimeout(c.rot.timer);
    this.ctxs.delete(ev.action.id);
  }
  override onDialRotate(ev: DialRotateEvent): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    const done = svc().attrRotate(this.slot, ev.payload.ticks, c.fine);
    if (!done) this.view(c);
    c.rot.ticks += ev.payload.ticks;
    c.rot.events++;
    if (c.rot.timer) clearTimeout(c.rot.timer);
    c.rot.timer = setTimeout(() => {
      const r = svc().attrReadout(this.slot);
      logEvent("Dial rotate", this.manifestId, { fine: c.fine }, `${c.rot.events} events, ${c.rot.ticks > 0 ? "+" : ""}${c.rot.ticks} ticks → ${r.page || "(no page)"}: ${r.param ? `"${r.param.name}"` : "(no channel here)"}=${r.value === null ? "—" : `${(r.value * 100).toFixed(1)}%`}${r.multi > 1 ? ` (${r.multi} fixtures)` : ""}`);
      c.rot = { ticks: 0, events: 0 };
    }, 400);
    c.rot.timer.unref?.();
  }
  /** Push (Handoff 21): fine mode on/off. */
  override onDialDown(ev: DialDownEvent): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    keepAlive("fine mode");
    c.fine = !c.fine;
    logEvent("Dial push", this.manifestId, undefined, `fine mode ${c.fine ? "on" : "off"}`);
    this.view(c);
  }
  /** Tap on the strip (Handoff 21): home that channel on the selected fixture(s). A long touch does nothing. */
  override onTouchTap(ev: TouchTapEvent): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c || ev.payload.hold) return;
    const done = svc().attrHome(this.slot);
    const r = svc().attrReadout(this.slot);
    logEvent("Dial touch", this.manifestId, undefined, done ? `home "${r.param?.name}" (${r.page})${r.multi > 1 ? ` on ${r.multi} fixtures` : ""}` : "no channel here or nothing selected: nothing done");
    this.view(c);
  }
}

export const fixtureSlotDialActions = (): SingletonAction[] => FIXTURE_ATTR_DIALS.map((d) => new FixtureSlotDial(d.uuid, d.slot));

// ------------------------------------------------------------------ keys

interface KeyCtx {
  action: KeyAction;
  flasher: Flasher;
}

abstract class FixtureKey extends SingletonAction {
  protected ctxs = new Map<string, KeyCtx>();
  constructor(
    override readonly manifestId: string,
    protected def: { title: string; icon: string },
  ) {
    super();
    svc().onChange(() => this.redrawAll());
  }
  protected redrawAll(): void {
    for (const c of this.ctxs.values()) this.view(c);
  }
  protected abstract view(c: KeyCtx): void;
  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    const c: KeyCtx = { action: ev.action, flasher: new Flasher(() => this.view(c)) };
    this.ctxs.set(ev.action.id, c);
    this.view(c);
  }
  override onWillDisappear(ev: WillDisappearEvent): void {
    this.ctxs.get(ev.action.id)?.flasher.clear();
    this.ctxs.delete(ev.action.id);
  }
}

/**
 * Fixtures: Setup. The address table lives in this key's panel in the Stream Deck app (Property Inspector). Pressing the key only
 * reads the show again (asks Capture for a fresh FixtureList).
 */
export class FixturesSetup extends FixtureKey {
  constructor() {
    super(FIXTURE_KEY_UUIDS.setup, fixtureKey(FIXTURE_KEY_UUIDS.setup));
  }
  protected view(c: KeyCtx): void {
    const st = svc().status();
    const f = c.flasher.flash;
    draw(c.action, { icon: this.def.icon, label: this.def.title, badge: st.controllable ? String(st.controllable) : undefined, big: f?.text, tone: f?.tone });
  }
  /** Reads the show again: a brief connection while Deck Control is OFF (it does not switch it ON), a fresh list request while ON. */
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const c = this.ctxs.get(ev.action.id);
    logEvent("Key press", this.manifestId, undefined, "read the show again");
    c?.flasher.show({ text: "Reading…" }, 1500);
    keepAlive("Setup key");
    if (rt.deck.on) await svc().show.sync();
    else await rt.link.briefSync("Setup key");
  }

  /** The Property Inspector appeared: read the fixture list (brief connection while Deck Control is OFF). */
  override onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent): void {
    rt.log.info("Fixtures: setup inspector opened");
    if (!rt.deck.on && process.env.CAPTURE_TEST_NO_CITP !== "1") void rt.link.briefSync("Setup panel");
  }

  /** The Setup Property Inspector's messages: {cmd: "get" | "resync" | "set" | "clear" | "autofill", ...}. */
  override async onSendToPlugin(ev: SendToPluginEvent<{ cmd?: string }, Record<string, never>>): Promise<void> {
    const m = (ev.payload ?? {}) as SetupCommand;
    const send = async (error: string | null = null): Promise<void> => {
      await streamDeck.ui.sendToPropertyInspector({ event: "setup", view: svc().setupView() as never, error });
    };
    const error = await runSetupCommand(svc(), m, () => send());
    await send(error);
  }
}

/** Fixtures: Release — kept for keys placed earlier (Handoff 21): switches Deck Control OFF (termination frames, LeaveShow, close). */
export class FixturesRelease extends FixtureKey {
  constructor() {
    super(FIXTURE_KEY_UUIDS.release, fixtureKey(FIXTURE_KEY_UUIDS.release));
  }
  protected view(c: KeyCtx): void {
    const on = svc().engine.active;
    const f = c.flasher.flash;
    draw(c.action, { icon: this.def.icon, label: this.def.title, active: on, tone: on ? "accent" : "normal", badge: on ? "ON" : undefined, big: f?.text });
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const was = svc().engine.universes;
    const on = rt.deck.on;
    await rt.deck.setOn(false, "Release key");
    logEvent("Key press", this.manifestId, undefined, `${on ? "deck control OFF" : "deck control was already OFF"}${was.length ? `; output released on universe(s) ${was.join(", ")}` : ""}`);
    this.ctxs.get(ev.action.id)?.flasher.show({ text: was.length ? "Released" : "Idle" }, 1200);
  }
}

/** Fixtures: Home Light (v0.7.3; was "Home Selected", same UUID) — the selected fixture(s) only, at full home (pan/tilt 50 %, intensity 100 %, additive colours full, the rest 0). */
export class FixturesHome extends FixtureKey {
  constructor() {
    super(FIXTURE_KEY_UUIDS.home, fixtureKey(FIXTURE_KEY_UUIDS.home));
  }
  protected view(c: KeyCtx): void {
    const f = c.flasher.flash;
    draw(c.action, { icon: this.def.icon, label: this.def.title, big: f?.text, tone: f?.tone, dim: !f && svc().selection.view().primary === undefined });
  }
  override onKeyDown(ev: KeyDownEvent): void {
    const ok = svc().homeSelected();
    const v = svc().selection.view();
    logEvent("Key press", this.manifestId, undefined, ok ? `home: ${v.line1} · ${v.line2}` : "no controllable fixture selected: nothing done");
    if (!ok) this.ctxs.get(ev.action.id)?.flasher.show({ text: "None", tone: "red" }, 1200);
  }
}

/** Fixtures: Status — show name, controllable count, output state. */
export class FixturesStatus extends FixtureKey {
  constructor() {
    super(FIXTURE_KEY_UUIDS.status, fixtureKey(FIXTURE_KEY_UUIDS.status));
  }
  protected view(c: KeyCtx): void {
    const st = svc().status();
    c.action.setImage(svgDataUrl(fixtureStatusSvg({ sync: st.syncStatus as never, showName: st.showName, controllable: st.controllable, fixtures: st.fixtures, active: st.active, universes: st.universes }))).catch(() => undefined);
  }
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    logEvent("Key press", this.manifestId, undefined, "read the show again");
    keepAlive("Status key");
    if (rt.deck.on) await svc().show.sync();
    else await rt.link.briefSync("Status key");
  }
}

/** Fixtures: ◀ Page / Page ▶ — cycle the attribute pages for the Attribute dials. The title is the current page's name ("Main", "Colour 1/2"). */
export class FixturesPage extends FixtureKey {
  constructor(private dir: -1 | 1) {
    super(dir < 0 ? FIXTURE_KEY_UUIDS.pagePrev : FIXTURE_KEY_UUIDS.pageNext, fixtureKey(dir < 0 ? FIXTURE_KEY_UUIDS.pagePrev : FIXTURE_KEY_UUIDS.pageNext));
  }
  protected view(c: KeyCtx): void {
    const name = svc().pageName();
    const f = c.flasher.flash;
    draw(c.action, { icon: this.def.icon, label: name ? name.replace(/ (\d+\/\d+)$/, "\n$1").replace(/ · /g, "\n") : this.def.title, big: f?.text, tone: f?.tone, dim: !f && !name });
  }
  override onKeyDown(ev: KeyDownEvent): void {
    const ok = svc().stepPage(this.dir);
    logEvent("Key press", this.manifestId, undefined, ok ? `page: ${svc().pageName()} (${svc().pages().index + 1} of ${svc().pages().pages.length})` : "no controllable fixture selected: no pages");
    if (!ok) this.ctxs.get(ev.action.id)?.flasher.show({ text: "None", tone: "red" }, 1200);
  }
}

/**
 * Fixtures: Deck Control (Handoff 21; v0.7.3 look). The whole key is the state colour: grey "DECK OFF", amber "CLICK A LIGHT" (ON, nothing
 * selected in Capture), green "DECK ON" + "Ch …" (driving). No Stream Deck title (the image carries the text). Redraws on Deck changes
 * and on selection changes (click ↔ driving).
 */
export class FixturesDeck extends FixtureKey {
  private titled = new Set<string>();
  constructor() {
    super(FIXTURE_KEY_UUIDS.deck, fixtureKey(FIXTURE_KEY_UUIDS.deck));
    rt.deck.onChange(() => this.redrawAll());
  }
  protected view(c: KeyCtx): void {
    const v = svc().selection.view();
    const state = deckState(rt.deck.on, v.targets.length > 0);
    const p = v.primary?.fixture;
    const ch = p ? (p.channel ? `Ch ${p.channel}` : p.name.slice(0, 10)) : "";
    c.action.setImage(svgDataUrl(deckKeySvg(state, v.targets.length > 1 ? `${ch} +${v.targets.length - 1}` : ch))).catch((e) => rt.log.warn("setImage failed", e));
    if (!this.titled.has(c.action.id)) {
      this.titled.add(c.action.id);
      c.action.setTitle("").catch((e) => rt.log.warn("setTitle failed", e));
    }
  }
  override onWillDisappear(ev: WillDisappearEvent): void {
    this.titled.delete(ev.action.id);
    super.onWillDisappear(ev);
  }
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    const to = !rt.deck.on;
    logEvent("Key press", this.manifestId, undefined, `deck control ${to ? "ON" : "OFF"}`);
    await rt.deck.toggle("Deck Control key");
  }
}

/** Fixtures: Next Fixture (v0.7.1) — the next controllable fixture (the Select dial left the profile). Title: "Next" + the fixture selected now. */
export class FixturesNext extends FixtureKey {
  constructor() {
    super(FIXTURE_KEY_UUIDS.next, fixtureKey(FIXTURE_KEY_UUIDS.next));
  }
  protected view(c: KeyCtx): void {
    const p = svc().selection.view().primary;
    const f = c.flasher.flash;
    const what = p ? (p.fixture.channel ? `Ch ${p.fixture.channel}` : p.fixture.name.slice(0, 10)) : "";
    draw(c.action, { icon: this.def.icon, label: what ? `Next\n${what}` : "Next\nFixture", big: f?.text, tone: f?.tone, dim: !f && !p });
  }
  override onKeyDown(ev: KeyDownEvent): void {
    const n = svc().controllables().length;
    svc().nextFixture();
    const v = svc().selection.view();
    logEvent("Key press", this.manifestId, undefined, n ? `next fixture → ${v.line1} · ${v.line2}` : "no controllable fixture");
    if (!n) this.ctxs.get(ev.action.id)?.flasher.show({ text: "None", tone: "red" }, 1200);
  }
}
