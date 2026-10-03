import type { KeyAction } from "@elgato/streamdeck";
import { AxError, type AxStatus } from "../lib/axBridge.js";
import type { Flash } from "../lib/axKeys.js";
import { keyImage, type KeyOptions } from "../lib/render.js";
import { rt } from "../runtime.js";

export const num = (v: unknown, fallback: number): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return fallback;
};

export const optNum = (v: unknown): number | undefined => {
  const n = num(v, NaN);
  return Number.isFinite(n) ? n : undefined;
};

/** Last title set per key, so an unchanged title is not sent again on every redraw. */
const titles = new Map<string, string>();

/** The key's image (icon, flash text, ring, badge) and its name as Stream Deck title text (v0.5: labels are not drawn into images). */
export function draw(action: KeyAction, o: KeyOptions): void {
  action.setImage(keyImage(o)).catch((e) => rt.log.warn("setImage failed", e));
  if (titles.get(action.id) !== o.label) {
    titles.set(action.id, o.label);
    action.setTitle(o.label).catch((e) => rt.log.warn("setTitle failed", e));
  }
}

/** Per-key temporary message ("Hold", "Stored", "Error"…). */
export class Flasher {
  flash: Flash | undefined;
  private timer: NodeJS.Timeout | undefined;
  constructor(private redraw: () => void) {}
  show(f: Flash, ms = 1200): void {
    this.flash = f;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flash = undefined;
      this.timer = undefined;
      this.redraw();
    }, ms);
    this.redraw();
  }
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flash = undefined;
  }
}

/**
 * A key that needs Accessibility failed (or its status says it can't work).
 * Returns true if the press was consumed by opening System Settings.
 */
export function openSettingsIfBlocked(): boolean {
  const s: AxStatus = rt.ax.status;
  if (s === "noPermission" || s === "noAutomation") {
    rt.openSystemSettings(s);
    return true;
  }
  return false;
}

/** Map a failed Accessibility call onto the key: flash text + alert. Raw error text is logged verbatim by the bridge. */
export function reportAxFailure(action: KeyAction, e: unknown, flasher: Flasher): void {
  if (e instanceof AxError) {
    if (e.kind === "noPermission" || e.kind === "noAutomation") flasher.show({ text: "Allow Access", tone: "red" }, 2500);
    else if (e.kind === "notRunning") flasher.show({ text: "Capture?", tone: "red" }, 2000);
    else {
      rt.log.error(`Accessibility error: ${e.raw}`);
      flasher.show({ text: "Error", tone: "red" }, 2000);
      action.showAlert().catch(() => undefined);
    }
  } else {
    rt.log.error("Unexpected error", e);
    flasher.show({ text: "Error", tone: "red" }, 2000);
    action.showAlert().catch(() => undefined);
  }
}

/** Settings as one compact log-safe string. */
export function showSettings(s: unknown): string {
  const t = JSON.stringify(s ?? {});
  return t.length > 400 ? `${t.slice(0, 400)}…` : t;
}

/** One log line per key/dial event: what happened, on which action (UUID), with which settings, and the result. */
export function logEvent(what: string, uuid: string | undefined, settings: unknown, result?: string): void {
  rt.log.info(`${what} [${uuid ?? "?"}] settings=${showSettings(settings)}${result !== undefined ? ` → ${result}` : ""}`);
}

/** A Property Inspector edit reached the plugin as didReceiveSettings. */
export function logSettingsChange(uuid: string | undefined, settings: unknown): void {
  rt.log.info(`PI setting change [${uuid ?? "?"}] settings=${showSettings(settings)}`);
}
