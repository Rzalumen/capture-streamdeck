import { type DialAction, type DialDownEvent, type DialRotateEvent, type DidReceiveSettingsEvent, SingletonAction, type TouchTapEvent, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { applyTicks, clampToProperty, findNumberProperty, formatValue, fraction, normaliseView, NUMBER_PROPERTIES, type NumberProperty, type ViewId } from "../lib/properties.js";
import { stripFeedback } from "../lib/render.js";
import { rt } from "../runtime.js";
import { logEvent, logSettingsChange, num } from "./util.js";

type Settings = {
  property?: string;
  view?: string;
  step?: number | string;
  reset?: number | string;
};

interface Ctx {
  action: DialAction<Settings>;
  prop: NumberProperty;
  view: ViewId;
  step: number;
  reset: number;
  fine: boolean;
  /** Rotation events since the last log line (a turn of the dial is dozens of events; one line per gesture). */
  rot: { ticks: number; events: number; timer?: NodeJS.Timeout };
}

function parse(s: Settings, preset?: NumberProperty): Pick<Ctx, "prop" | "view" | "step" | "reset"> {
  const prop = preset ?? findNumberProperty(s.property ?? "") ?? NUMBER_PROPERTIES[0];
  const step = num(s.step, prop.step);
  return {
    prop,
    view: normaliseView(s.view),
    step: step > 0 ? step : prop.step,
    reset: clampToProperty(prop, num(s.reset, prop.reset)),
  };
}

/** Turn = adjust a view setting over OSC. The generic "View Dial" picks the property in its Property Inspector; the named "Dial: …" actions have it preset. */
abstract class DialBase extends SingletonAction<Settings> {
  private ctxs = new Map<string, Ctx>();

  /** Preset property (named dials); undefined for the generic dial. */
  protected preset?: NumberProperty;

  constructor() {
    super();
    rt.onValueSent(() => this.redrawAll());
    rt.monitor.on("change", () => this.redrawAll());
  }

  private redrawAll(): void {
    for (const c of this.ctxs.values()) this.view(c);
  }

  private current(c: Ctx): number {
    return clampToProperty(c.prop, rt.values.getNumber(c.view, c.prop.id, c.reset));
  }

  private view(c: Ctx): void {
    const v = this.current(c);
    const f = formatValue(c.prop, v);
    const fb = stripFeedback({
      name: c.prop.short + (c.view === "live" ? "" : ` · ${c.view === "0" ? "α" : c.view === "1" ? "β" : "γ"}`),
      value: f.value,
      unit: f.unit,
      fraction: fraction(c.prop, v),
      fine: c.fine,
      estimated: !rt.values.wasSentThisSession(c.view, c.prop.id),
      offline: !rt.monitor.state.connected,
    });
    c.action.setFeedback(fb as never).catch((e) => rt.log.warn("setFeedback failed", e));
  }

  private attach(a: DialAction<Settings>, s: Settings): void {
    const prev = this.ctxs.get(a.id);
    const c: Ctx = { action: a, ...parse(s, this.preset), fine: prev?.fine ?? false, rot: prev?.rot ?? { ticks: 0, events: 0 } };
    this.ctxs.set(a.id, c);
    this.view(c);
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (ev.action.isDial()) this.attach(ev.action, ev.payload.settings ?? {});
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    logSettingsChange(this.manifestId, ev.payload.settings);
    if (ev.action.isDial()) this.attach(ev.action, ev.payload.settings ?? {});
  }
  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    const c = this.ctxs.get(ev.action.id);
    if (c?.rot.timer) clearTimeout(c.rot.timer);
    this.ctxs.delete(ev.action.id);
  }

  /** New value = current + ticks × step (÷10 in fine mode), clamped. Sent over OSC at ≤ 30 msg/s, latest value wins. */
  override onDialRotate(ev: DialRotateEvent<Settings>): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    const next = applyTicks(c.prop, this.current(c), ev.payload.ticks, c.step, c.fine);
    this.set(c, next);
    this.logRotation(c, ev.payload.ticks);
  }

  /** One log line per turn of the dial: sums the ticks and reports the final value after 400 ms of quiet. */
  private logRotation(c: Ctx, ticks: number): void {
    c.rot.ticks += ticks;
    c.rot.events++;
    if (c.rot.timer) clearTimeout(c.rot.timer);
    c.rot.timer = setTimeout(() => {
      const v = this.current(c);
      logEvent("Dial rotate", this.manifestId, { property: c.prop.id, view: c.view, step: c.step, fine: c.fine }, `${c.rot.events} events, ${c.rot.ticks > 0 ? "+" : ""}${c.rot.ticks} ticks → ${c.prop.id}=${v} (/view/${c.view}/${c.prop.id})`);
      c.rot = { ticks: 0, events: 0 };
    }, 400);
    c.rot.timer.unref?.();
  }

  private set(c: Ctx, v: number): void {
    rt.values.setValue(c.view, c.prop.id, v);
    rt.limiter.push(`${c.view}/${c.prop.id}`, { view: c.view, prop: c.prop.id, v });
    this.redrawAll(); // shows the new value at once; the "~" clears when the first send completes
  }

  /** Push toggles fine mode. */
  override onDialDown(ev: DialDownEvent<Settings>): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    c.fine = !c.fine;
    logEvent("Dial push", this.manifestId, { property: c.prop.id, view: c.view }, `fine mode ${c.fine ? "on" : "off"}`);
    this.view(c);
  }

  /** Touch toggles fine mode; a long touch resets to the reset value. */
  override onTouchTap(ev: TouchTapEvent<Settings>): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    if (ev.payload.hold) {
      this.set(c, c.reset);
      logEvent("Dial long touch", this.manifestId, { property: c.prop.id, view: c.view }, `reset → ${c.prop.id}=${c.reset}`);
    } else {
      c.fine = !c.fine;
      logEvent("Dial touch", this.manifestId, { property: c.prop.id, view: c.view }, `fine mode ${c.fine ? "on" : "off"}`);
      this.view(c);
    }
  }
}

export class ViewDial extends DialBase {
  override readonly manifestId = "com.rezabehjat.capture.dial";
}

/** "Dial: Bloom" etc. */
export class NamedDial extends DialBase {
  override readonly manifestId: string;
  constructor(uuid: string, prop: NumberProperty) {
    super();
    this.manifestId = uuid;
    this.preset = prop;
  }
}
