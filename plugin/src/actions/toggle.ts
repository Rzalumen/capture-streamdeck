import { action, type DidReceiveSettingsEvent, type KeyAction, type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { BOOL_PROPERTIES, findBoolProperty, normaliseView, type BoolProperty, type ViewId } from "../lib/properties.js";
import { rt } from "../runtime.js";
import { draw } from "./util.js";

type Settings = { property?: string; view?: string };
interface Ctx {
  action: KeyAction<Settings>;
  prop: BoolProperty;
  view: ViewId;
}

const ICON: Record<string, string> = { automaticExposure: "autoexposure", laserFlickerEffect: "laser" };

@action({ UUID: "com.rezabehjat.capture.toggle" })
export class ViewToggle extends SingletonAction<Settings> {
  private ctxs = new Map<string, Ctx>();

  constructor() {
    super();
    rt.monitor.on("change", () => this.redrawAll());
  }

  private redrawAll(): void {
    for (const c of this.ctxs.values()) this.view(c);
  }

  private view(c: Ctx): void {
    const on = rt.values.getBool(c.view, c.prop.id, false);
    const sent = rt.values.wasSentThisSession(c.view, c.prop.id);
    draw(c.action, {
      icon: ICON[c.prop.id] ?? "command",
      label: `${c.prop.label} ${on ? "On" : "Off"}`,
      active: on,
      badge: sent ? undefined : "~",
      dim: !rt.monitor.state.connected,
    });
    c.action.setState(on ? 1 : 0).catch(() => undefined);
  }

  private attach(a: KeyAction<Settings>, s: Settings): void {
    const c: Ctx = { action: a, prop: findBoolProperty(s.property ?? "") ?? BOOL_PROPERTIES[0], view: normaliseView(s.view) };
    this.ctxs.set(a.id, c);
    this.view(c);
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (ev.action.isKey()) this.attach(ev.action, ev.payload.settings ?? {});
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    if (ev.action.isKey()) this.attach(ev.action, ev.payload.settings ?? {});
  }
  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.ctxs.delete(ev.action.id);
  }

  /** Flips the tracked state and sends T/F. (Capture has no getter, so the first press after install may need a second press.) */
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    const next = !rt.values.getBool(c.view, c.prop.id, false);
    try {
      await rt.sendBool(c.view, c.prop.id, next);
    } catch (e) {
      rt.log.warn("Toggle send failed", e);
      ev.action.showAlert().catch(() => undefined);
    }
    this.redrawAll();
  }
}
