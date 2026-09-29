import { action, type KeyAction, type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from "@elgato/streamdeck";
import type { MenuTarget } from "../lib/applescript.js";
import { axKeyOptions } from "../lib/axKeys.js";
import { slotAction } from "../lib/storeModifier.js";
import { rt } from "../runtime.js";
import { draw, Flasher, num, openSettingsIfBlocked, reportAxFailure } from "./util.js";

type Settings = { slot?: number | string };
interface Ctx {
  action: KeyAction<Settings>;
  slot: number;
  flasher: Flasher;
}

const targets = (slot: number): { recall: MenuTarget; store: MenuTarget } => ({
  recall: { path: slotAction(slot, false).path, match: "exact" },
  store: { path: slotAction(slot, true).path, match: "exact" },
});

@action({ UUID: "com.rezabehjat.capture.slot" })
export class CameraSlot extends SingletonAction<Settings> {
  private ctxs = new Map<string, Ctx>();

  constructor() {
    super();
    rt.storeModifier.onChange = () => {
      for (const c of this.ctxs.values()) this.view(c);
      storeKeysRedraw?.();
    };
  }

  private view(c: Ctx): void {
    const held = rt.storeModifier.isHeld;
    const t = targets(c.slot);
    const o = axKeyOptions({
      label: held ? `Store ${c.slot}` : `Slot ${c.slot}`,
      icon: held ? "store" : "camera",
      enabled: rt.axKeys.isEnabled(held ? t.store : t.recall),
      ax: rt.ax.status,
      flash: c.flasher.flash,
      active: held,
    });
    draw(c.action, o);
  }

  private attach(a: KeyAction<Settings>, s: Settings): void {
    const slot = Math.min(5, Math.max(1, Math.round(num(s.slot, 1))));
    const c: Ctx = { action: a, slot, flasher: new Flasher(() => this.view(c)) };
    this.ctxs.set(a.id, c);
    const t = targets(slot);
    rt.axKeys.unregister(a.id);
    rt.axKeys.register({ id: a.id, targets: [t.recall, t.store], redraw: () => this.view(c) });
    this.view(c);
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (ev.action.isKey()) this.attach(ev.action, ev.payload.settings ?? {});
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    if (ev.action.isKey()) this.attach(ev.action, ev.payload.settings ?? {});
  }
  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.ctxs.get(ev.action.id)?.flasher.clear();
    this.ctxs.delete(ev.action.id);
    rt.axKeys.unregister(ev.action.id);
  }

  /** Recall: View > Camera > Position N. While a Store Modifier is held: View > Store Camera > Position N. */
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    if (openSettingsIfBlocked()) return;
    const a = slotAction(c.slot, rt.storeModifier.isHeld);
    try {
      const r = await rt.ax.clickMenu({ path: a.path, match: "exact" });
      if (r === "DISABLED") ev.action.showAlert().catch(() => undefined);
      else if (a.kind === "store") c.flasher.show({ text: "Stored", tone: "accent" }, 1200);
    } catch (e) {
      reportAxFailure(c.action, e, c.flasher);
    }
  }
}

/** Set by the Store Modifier action so slots can also refresh it. */
export let storeKeysRedraw: (() => void) | undefined;
export function setStoreKeysRedraw(fn: () => void): void {
  storeKeysRedraw = fn;
}
