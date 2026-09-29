import { action, type KeyAction, type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { TABS, type TabName } from "../lib/applescript.js";
import { axKeyOptions } from "../lib/axKeys.js";
import { rt } from "../runtime.js";
import { draw, Flasher, openSettingsIfBlocked, reportAxFailure } from "./util.js";

type Settings = { tab?: string };
interface Ctx {
  action: KeyAction<Settings>;
  tab: TabName;
  flasher: Flasher;
}

const tabOf = (s: Settings): TabName => ((TABS as readonly string[]).includes(s.tab ?? "") ? (s.tab as TabName) : "Design");

@action({ UUID: "com.rezabehjat.capture.tab" })
export class CaptureTab extends SingletonAction<Settings> {
  private ctxs = new Map<string, Ctx>();

  private view(c: Ctx): void {
    draw(c.action, axKeyOptions({ label: c.tab, icon: `tab-${c.tab.toLowerCase()}`, ax: rt.ax.status, flash: c.flasher.flash }));
  }

  private attach(a: KeyAction<Settings>, s: Settings): void {
    const c: Ctx = { action: a, tab: tabOf(s), flasher: new Flasher(() => this.view(c)) };
    this.ctxs.set(a.id, c);
    rt.axKeys.unregister(a.id);
    rt.axKeys.register({ id: a.id, redraw: () => this.view(c) });
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

  /** Clicks exactly one thing in Capture's window: the radio button of the chosen tab. */
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    if (openSettingsIfBlocked()) return;
    try {
      await rt.ax.clickTab(c.tab);
      ev.action.showOk().catch(() => undefined);
    } catch (e) {
      reportAxFailure(c.action, e, c.flasher);
    }
  }
}
