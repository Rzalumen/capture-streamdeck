import { action, type DialAction, type DialDownEvent, type DialRotateEvent, type DidReceiveSettingsEvent, SingletonAction, type TouchTapEvent, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { applyTicks, clampToProperty, findNumberProperty, formatValue, fraction, normaliseView, NUMBER_PROPERTIES, type NumberProperty, type ViewId } from "../lib/properties.js";
import { stripFeedback } from "../lib/render.js";
import { rt } from "../runtime.js";
import { num } from "./util.js";

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
}

function parse(s: Settings): Pick<Ctx, "prop" | "view" | "step" | "reset"> {
  const prop = findNumberProperty(s.property ?? "") ?? NUMBER_PROPERTIES[0];
  const step = num(s.step, prop.step);
  return {
    prop,
    view: normaliseView(s.view),
    step: step > 0 ? step : prop.step,
    reset: clampToProperty(prop, num(s.reset, prop.reset)),
  };
}

@action({ UUID: "com.rezabehjat.capture.dial" })
export class ViewDial extends SingletonAction<Settings> {
  private ctxs = new Map<string, Ctx>();

  constructor() {
    super();
    rt.onValueSent = () => this.redrawAll();
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
    const c: Ctx = { action: a, ...parse(s), fine: prev?.fine ?? false };
    this.ctxs.set(a.id, c);
    this.view(c);
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (ev.action.isDial()) this.attach(ev.action, ev.payload.settings ?? {});
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    if (ev.action.isDial()) this.attach(ev.action, ev.payload.settings ?? {});
  }
  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.ctxs.delete(ev.action.id);
  }

  /** New value = current + ticks × step (÷10 in fine mode), clamped. Sent over OSC at ≤ 30 msg/s, latest value wins. */
  override onDialRotate(ev: DialRotateEvent<Settings>): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    const next = applyTicks(c.prop, this.current(c), ev.payload.ticks, c.step, c.fine);
    this.set(c, next);
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
    this.view(c);
  }

  /** Touch toggles fine mode; a long touch resets to the reset value. */
  override onTouchTap(ev: TouchTapEvent<Settings>): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    if (ev.payload.hold) this.set(c, c.reset);
    else {
      c.fine = !c.fine;
      this.view(c);
    }
  }
}
