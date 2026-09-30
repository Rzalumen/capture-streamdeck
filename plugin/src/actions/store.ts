import { action, type KeyAction, type KeyDownEvent, type KeyUpEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { rt } from "../runtime.js";
import { draw, logEvent } from "./util.js";
import { setStoreKeysRedraw } from "./slot.js";

/** A held modifier: while this key is down, Camera Slot keys store instead of recall. */
@action({ UUID: "com.rezabehjat.capture.store" })
export class StoreModifierKey extends SingletonAction {
  private keys = new Map<string, KeyAction>();

  constructor() {
    super();
    setStoreKeysRedraw(() => this.redrawAll());
  }

  private redrawAll(): void {
    const held = rt.storeModifier.isHeld;
    for (const a of this.keys.values()) {
      draw(a, { icon: "store", label: "Store", active: held, tone: held ? "accent" : "normal" });
      a.setState(held ? 1 : 0).catch(() => undefined);
    }
  }

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    this.keys.set(ev.action.id, ev.action);
    this.redrawAll();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.keys.delete(ev.action.id);
    rt.storeModifier.up(ev.action.id); // a key that leaves the screen can never leave the modifier stuck
  }

  override onKeyDown(ev: KeyDownEvent): void {
    logEvent("Key down", this.manifestId, undefined, "store modifier held");
    rt.storeModifier.down(ev.action.id);
  }

  override onKeyUp(ev: KeyUpEvent): void {
    logEvent("Key up", this.manifestId, undefined, "store modifier released");
    rt.storeModifier.up(ev.action.id);
  }
}
