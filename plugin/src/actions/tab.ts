import { type KeyAction, type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { TABS, type TabName } from "../lib/applescript.js";
import { AxError } from "../lib/axBridge.js";
import { axKeyOptions } from "../lib/axKeys.js";
import { rt } from "../runtime.js";
import { draw, Flasher, logEvent, logSettingsChange, openSettingsIfBlocked, reportAxFailure } from "./util.js";

type Settings = { tab?: string };
interface Ctx {
  action: KeyAction<Settings>;
  tab: TabName;
  flasher: Flasher;
}

const isTab = (t: unknown): t is TabName => (TABS as readonly string[]).includes(String(t));

abstract class TabKeys extends SingletonAction<Settings> {
  private ctxs = new Map<string, Ctx>();

  /** The tab this key switches to (undefined → Design). */
  protected abstract tabFor(s: Settings): TabName;

  private view(c: Ctx): void {
    draw(c.action, axKeyOptions({ label: c.tab, icon: `tab-${c.tab.toLowerCase()}`, ax: rt.ax.status, flash: c.flasher.flash }));
  }

  private attach(a: KeyAction<Settings>, s: Settings): void {
    const c: Ctx = { action: a, tab: this.tabFor(s), flasher: new Flasher(() => this.view(c)) };
    this.ctxs.set(a.id, c);
    rt.axKeys.unregister(a.id);
    rt.axKeys.register({ id: a.id, redraw: () => this.view(c) });
    this.view(c);
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (ev.action.isKey()) this.attach(ev.action, ev.payload.settings ?? {});
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    if (!ev.action.isKey()) return;
    logSettingsChange(this.manifestId, ev.payload.settings);
    this.attach(ev.action, ev.payload.settings ?? {});
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
    if (openSettingsIfBlocked()) {
      logEvent("Key press", this.manifestId, ev.payload.settings, `blocked: Accessibility ${rt.ax.status}; opened System Settings`);
      return;
    }
    const t0 = Date.now();
    try {
      await rt.ax.clickTab(c.tab);
      logEvent("Key press", this.manifestId, ev.payload.settings, `tab ${c.tab}: OK in ${Date.now() - t0} ms`);
      ev.action.showOk().catch(() => undefined);
    } catch (e) {
      logEvent("Key press", this.manifestId, ev.payload.settings, `tab ${c.tab}: ERROR ${e instanceof AxError ? `${e.kind}: ${e.raw}` : String(e)}`);
      reportAxFailure(c.action, e, c.flasher);
    } finally {
      rt.axKeys.pressed();
    }
  }
}

/** "Capture Tab": the tab is chosen in the Property Inspector. */
export class CaptureTab extends TabKeys {
  override readonly manifestId = "com.rezabehjat.capture.tab";
  protected tabFor(s: Settings): TabName {
    return isTab(s.tab) ? s.tab : "Design";
  }
}

/** "Tabs: Fixtures" etc.: one per tab, nothing to configure. */
export class NamedTab extends TabKeys {
  override readonly manifestId: string;
  constructor(
    uuid: string,
    private tab: TabName,
  ) {
    super();
    this.manifestId = uuid;
  }
  protected tabFor(): TabName {
    return this.tab;
  }
}
