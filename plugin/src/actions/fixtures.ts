import streamDeck, { type DialAction, type DialDownEvent, type DialRotateEvent, type KeyAction, type KeyDownEvent, type PropertyInspectorDidAppearEvent, type SendToPluginEvent, SingletonAction, type TouchTapEvent, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { FIXTURE_KEY_UUIDS, FIXTURE_KEYS, FIXTURE_SELECT_UUID, FIXTURE_DIALS } from "../catalog/fixtures.js";
import type { DialId } from "../fixtures/attrs.js";
import { fixtureStatusSvg, fixtureStripFeedback, selectStripFeedback, svgDataUrl } from "../lib/render.js";
import { runSetupCommand, type SetupCommand } from "../fixtures/setupCommands.js";
import { rt } from "../runtime.js";
import { draw, Flasher, logEvent } from "./util.js";

const svc = () => rt.fixtures;

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
  /** Push: home this attribute on the selected fixture(s) (a colour: every cell of it). */
  override onDialDown(ev: DialDownEvent): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    const done = svc().home(this.dial);
    const r = svc().readout(this.dial);
    logEvent("Dial push", this.manifestId, undefined, done ? `home ${r.attr}${r.multi > 1 ? ` on ${r.multi} fixtures` : ""}` : "attribute missing or nothing selected: nothing done");
    this.view(c);
  }
  /** Tap on the strip: fine mode on/off. (A long touch does nothing: homing is the knob press and the Home key.) */
  override onTouchTap(ev: TouchTapEvent): void {
    const c = this.ctxs.get(ev.action.id);
    if (c && !ev.payload.hold) this.toggleFine(c, "Dial touch");
  }
}

export const fixtureDialActions = (): SingletonAction[] => FIXTURE_DIALS.map((d) => new FixtureAttrDial(d.uuid, d.id));

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
    super(FIXTURE_KEY_UUIDS.setup, FIXTURE_KEYS[0]);
  }
  protected view(c: KeyCtx): void {
    const st = svc().status();
    const f = c.flasher.flash;
    draw(c.action, { icon: this.def.icon, label: this.def.title, badge: st.controllable ? String(st.controllable) : undefined, big: f?.text, tone: f?.tone });
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const c = this.ctxs.get(ev.action.id);
    logEvent("Key press", this.manifestId, undefined, "read the show again");
    c?.flasher.show({ text: "Reading…" }, 1500);
    await svc().show.sync();
  }

  /** The Property Inspector appeared (log only: tells us whether it ever shows up). */
  override onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent): void {
    rt.log.info("Fixtures: setup inspector opened");
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

/** Fixtures: Release — stops all output (Stream_Terminated on every universe in use). */
export class FixturesRelease extends FixtureKey {
  constructor() {
    super(FIXTURE_KEY_UUIDS.release, FIXTURE_KEYS[1]);
  }
  protected view(c: KeyCtx): void {
    const on = svc().engine.active;
    const f = c.flasher.flash;
    draw(c.action, { icon: this.def.icon, label: this.def.title, active: on, tone: on ? "accent" : "normal", badge: on ? "ON" : undefined, big: f?.text });
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const was = svc().engine.universes;
    await svc().release();
    logEvent("Key press", this.manifestId, undefined, was.length ? `output released on universe(s) ${was.join(", ")}` : "nothing was sending");
    this.ctxs.get(ev.action.id)?.flasher.show({ text: was.length ? "Released" : "Idle" }, 1200);
  }
}

/** Fixtures: Home Selected — the selected fixture(s) only, at full home (pan/tilt 50 %, intensity 100 %, additive colours full, the rest 0). */
export class FixturesHome extends FixtureKey {
  constructor() {
    super(FIXTURE_KEY_UUIDS.home, FIXTURE_KEYS[2]);
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
    super(FIXTURE_KEY_UUIDS.status, FIXTURE_KEYS[3]);
  }
  protected view(c: KeyCtx): void {
    const st = svc().status();
    c.action.setImage(svgDataUrl(fixtureStatusSvg({ sync: st.syncStatus as never, showName: st.showName, controllable: st.controllable, fixtures: st.fixtures, active: st.active, universes: st.universes }))).catch(() => undefined);
  }
  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    logEvent("Key press", this.manifestId, undefined, "read the show again");
    await svc().show.sync();
  }
}
