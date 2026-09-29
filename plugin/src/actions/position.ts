import streamDeck, { action, type DidReceiveSettingsEvent, type KeyAction, type KeyDownEvent, type SendToPluginEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { nthPosition, type CatalogInfo } from "../lib/discovery.js";
import { normaliseView, positionArgs, viewAddress, type ViewId } from "../lib/properties.js";
import { rt } from "../runtime.js";
import { draw, Flasher, num, optNum } from "./util.js";

type Settings = {
  mode?: "fixed" | "auto";
  catalog?: number | string;
  /** fixed mode: position number */
  position?: number | string;
  /** auto mode: k-th position of the catalog */
  index?: number | string;
  view?: string;
  time?: number | string;
  damp?: number | string;
  curve?: number | string;
};

interface Ctx {
  action: KeyAction<Settings>;
  s: Settings;
  flasher: Flasher;
}

const REFRESH_MS = 15_000;

function resolve(s: Settings, cat: CatalogInfo | undefined): { nr: number; name: string } | undefined {
  if (s.mode === "auto") {
    const k = Math.max(1, Math.round(num(s.index, 1)));
    const p = nthPosition(cat, k);
    return p ? { nr: p.nr, name: p.name } : undefined;
  }
  const nr = Math.max(1, Math.round(num(s.position, 1)));
  const p = cat?.positions.find((x) => x.nr === nr);
  return { nr, name: p?.name ?? "" };
}

@action({ UUID: "com.rezabehjat.capture.position" })
export class ShowPosition extends SingletonAction<Settings> {
  private ctxs = new Map<string, Ctx>();
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    super();
    rt.monitor.on("change", () => {
      for (const c of this.ctxs.values()) this.view(c);
      if (rt.monitor.state.connected) void this.refresh(false);
    });
  }

  private catalogNr = (c: Ctx): number => Math.max(1, Math.round(num(c.s.catalog, 1)));

  private view(c: Ctx): void {
    const cat = rt.catalogs.peek(this.catalogNr(c));
    const r = resolve(c.s, cat);
    const idx = c.s.mode === "auto" ? Math.round(num(c.s.index, 1)) : Math.round(num(c.s.position, 1));
    const missing = c.s.mode === "auto" && cat !== undefined && !r;
    const label = missing ? `— ${idx}` : r?.name || `Pos ${r?.nr ?? idx}`;
    const offline = !rt.monitor.state.connected;
    draw(c.action, {
      icon: "position",
      label,
      dim: offline || missing,
      badge: r?.name || cat ? undefined : "~",
      big: c.flasher.flash?.text,
      tone: c.flasher.flash?.tone,
    });
  }

  private attach(a: KeyAction<Settings>, s: Settings): void {
    const c: Ctx = { action: a, s, flasher: new Flasher(() => this.view(c)) };
    this.ctxs.set(a.id, c);
    this.view(c);
    void this.refresh(true);
    if (!this.timer) this.timer = setInterval(() => void this.refresh(false), REFRESH_MS);
  }

  /** Read names from Capture (discovery only). On appear and every 15 s while any key is visible. */
  private async refresh(force: boolean): Promise<void> {
    if (this.ctxs.size === 0 || !rt.monitor.state.connected && !force) return;
    const wanted = new Set([...this.ctxs.values()].map((c) => this.catalogNr(c)));
    for (const nr of wanted) {
      try {
        await rt.catalogs.get(nr, force ? 1000 : REFRESH_MS - 1000);
      } catch {
        /* offline or no such catalog: keys keep what they have */
      }
    }
    for (const c of this.ctxs.values()) this.view(c);
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
    if (this.ctxs.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** OSC camera recall: /view/<view>/position catalog position [time [damp [curve]]]. */
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    try {
      const nr = this.catalogNr(c);
      let cat = rt.catalogs.peek(nr);
      if (c.s.mode === "auto" && !cat) cat = await rt.catalogs.get(nr, REFRESH_MS);
      const r = resolve(c.s, cat);
      if (!r) {
        ev.action.showAlert().catch(() => undefined);
        return;
      }
      const view: ViewId = normaliseView(c.s.view);
      await rt.osc.send(viewAddress(view, "position"), positionArgs(nr, r.nr, { time: optNum(c.s.time), damp: optNum(c.s.damp), curve: optNum(c.s.curve) }));
    } catch (e) {
      rt.log.warn("Show Position failed", e);
      ev.action.showAlert().catch(() => undefined);
    }
  }

  // ---- Property Inspector: catalog / position names (OSC discovery, read-only)
  override async onSendToPlugin(ev: SendToPluginEvent<{ cmd?: string }, Settings>): Promise<void> {
    if (ev.payload?.cmd === "listCatalogs") await this.sendCatalogs();
  }
  private async sendCatalogs(): Promise<void> {
    let catalogs: CatalogInfo[] = [];
    let error: string | null = null;
    try {
      const { walkCatalogs } = await import("../lib/discovery.js");
      catalogs = await walkCatalogs(rt.osc, 1200);
    } catch {
      error = "Capture did not answer over OSC (is it open with OSC on 127.0.0.1:4004?).";
    }
    await streamDeck.ui.sendToPropertyInspector({ event: "catalogs", catalogs: catalogs as unknown as never, error });
  }
}
