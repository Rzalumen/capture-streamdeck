import { action, type KeyAction, type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { VIEW_LABEL, type ViewId } from "../lib/properties.js";
import { connectionSvg, svgDataUrl, type ConnectionView } from "../lib/render.js";
import { rt } from "../runtime.js";
import { logEvent } from "./util.js";

@action({ UUID: "com.rezabehjat.capture.connection" })
export class Connection extends SingletonAction {
  private keys = new Map<string, KeyAction>();
  private checking = false;
  private live: string | undefined;

  constructor() {
    super();
    rt.monitor.on("change", () => this.redrawAll());
    const prev = rt.ax.onStatus;
    rt.ax.onStatus = (s) => {
      prev?.(s);
      this.redrawAll();
    };
  }

  private snapshot(): ConnectionView {
    const st = rt.monitor.state;
    return {
      connected: st.connected,
      version: st.version,
      ax: rt.ax.status,
      latencyMs: rt.ax.latency()?.median,
      checking: this.checking,
      live: st.connected ? this.live : undefined,
    };
  }

  private redrawAll(): void {
    const img = svgDataUrl(connectionSvg(this.snapshot()));
    for (const a of this.keys.values()) a.setImage(img).catch(() => undefined);
  }

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    this.keys.set(ev.action.id, ev.action);
    this.redrawAll();
  }
  override onWillDisappear(ev: WillDisappearEvent): void {
    this.keys.delete(ev.action.id);
  }

  /** Re-checks everything: OSC ping, Accessibility (read-only), and the live-view status query. */
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (this.checking) return;
    logEvent("Key press", this.manifestId, undefined, `re-check (Accessibility ${rt.ax.status}, transport ${rt.ax.transport})`);
    if (rt.ax.status === "noPermission" || rt.ax.status === "noAutomation") rt.openSystemSettings(rt.ax.status);
    this.checking = true;
    this.redrawAll();
    try {
      const [conn] = await Promise.all([rt.monitor.check(1500), rt.ax.check()]);
      this.live = undefined;
      logEvent("Key result", this.manifestId, undefined, `OSC ${conn.connected ? `connected (Capture ${conn.version ?? "?"})` : "offline"}, Accessibility ${rt.ax.status}`);
      if (conn.connected) {
        try {
          const r = await rt.osc.request("/view/live/getStatus", [], "/view/live/status", 1000);
          const idx = Number(r.args[0]);
          this.live = idx < 0 ? "No live view" : `Live: ${VIEW_LABEL[String(idx) as ViewId] ?? idx}`;
        } catch {
          /* status query is optional */
        }
      }
    } finally {
      this.checking = false;
      this.redrawAll();
    }
  }
}
