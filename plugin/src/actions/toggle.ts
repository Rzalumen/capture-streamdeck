import { type DidReceiveSettingsEvent, type KeyAction, type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { BOOL_PROPERTIES, findBoolProperty, normaliseView, type BoolProperty, type ViewId } from "../lib/properties.js";
import { rt } from "../runtime.js";
import { draw, logEvent, logSettingsChange } from "./util.js";

type Settings = { property?: string; view?: string };
interface Ctx {
  action: KeyAction<Settings>;
  prop: BoolProperty;
  view: ViewId;
}

const ICON: Record<string, string> = { automaticExposure: "autoexposure", laserFlickerEffect: "laser" };

abstract class ToggleBase extends SingletonAction<Settings> {
  private ctxs = new Map<string, Ctx>();
  protected preset?: BoolProperty;

  constructor() {
    super();
    rt.monitor.on("change", () => this.redrawAll());
    rt.onValueSent(() => this.redrawAll());
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
    const c: Ctx = { action: a, prop: this.preset ?? findBoolProperty(s.property ?? "") ?? BOOL_PROPERTIES[0], view: normaliseView(s.view) };
    this.ctxs.set(a.id, c);
    this.view(c);
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (ev.action.isKey()) this.attach(ev.action, ev.payload.settings ?? {});
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    logSettingsChange(this.manifestId, ev.payload.settings);
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
      logEvent("Key press", this.manifestId, ev.payload.settings, `OSC /view/${c.view}/${c.prop.id} ${next ? "T" : "F"}`);
    } catch (e) {
      logEvent("Key press", this.manifestId, ev.payload.settings, `ERROR ${(e as Error).message}`);
      rt.log.warn("Toggle send failed", e);
      ev.action.showAlert().catch(() => undefined);
    }
    this.redrawAll();
  }
}

export class ViewToggle extends ToggleBase {
  override readonly manifestId = "com.rezabehjat.capture.toggle";
}

/** "Toggle: Auto Exposure" etc. */
export class NamedToggle extends ToggleBase {
  override readonly manifestId: string;
  constructor(uuid: string, prop: BoolProperty) {
    super();
    this.manifestId = uuid;
    this.preset = prop;
  }
}
