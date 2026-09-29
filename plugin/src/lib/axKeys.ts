import type { MenuTarget } from "./applescript.js";
import type { AxBridge, AxStatus } from "./axBridge.js";
import { nullLogger, type Logger } from "./log.js";
import type { KeyOptions, Tone } from "./render.js";

export interface AxKey {
  id: string;
  /** Menu commands whose enabled state this key shows (polled in one batch with all other keys). */
  targets?: MenuTarget[];
  redraw(): void;
}

export const targetId = (t: MenuTarget): string => JSON.stringify([t.path, t.match]);

/**
 * All keys that depend on Capture's Accessibility tree register here. While at least one is visible
 * the registry polls the enabled state of every registered target — in ONE osascript call — on
 * appear and every `intervalMs` (1.5 s). Polling only READS; it never clicks and never activates Capture.
 * While Accessibility access is missing it backs off to `backoffMs`.
 */
export class AxKeyRegistry {
  private keys = new Map<string, AxKey>();
  private enabled = new Map<string, boolean | null>();
  private timer: NodeJS.Timeout | undefined;
  private lastPoll = 0;
  private polling = false;

  constructor(
    private ax: AxBridge,
    private opts: { intervalMs?: number; backoffMs?: number; logger?: Logger; now?: () => number } = {},
  ) {
    const prev = ax.onStatus;
    ax.onStatus = (s) => {
      prev?.(s);
      this.redrawAll();
    };
  }

  private get intervalMs(): number {
    return this.opts.intervalMs ?? 1500;
  }
  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  get size(): number {
    return this.keys.size;
  }

  register(k: AxKey): void {
    this.keys.set(k.id, k);
    if (!this.timer) this.timer = setInterval(() => void this.tick(), Math.min(this.intervalMs, 1500));
    void this.pollNow();
  }

  unregister(id: string): void {
    this.keys.delete(id);
    if (this.keys.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** undefined = not polled yet, null = menu item not found, boolean = enabled state. */
  isEnabled(t: MenuTarget): boolean | null | undefined {
    return this.enabled.get(targetId(t));
  }

  redrawAll(): void {
    for (const k of this.keys.values()) {
      try {
        k.redraw();
      } catch (e) {
        (this.opts.logger ?? nullLogger).error("redraw failed", e);
      }
    }
  }

  private async tick(): Promise<void> {
    const bad = this.ax.status === "noPermission" || this.ax.status === "noAutomation";
    if (bad && this.now - this.lastPoll < (this.opts.backoffMs ?? 5000)) return;
    await this.pollNow();
  }

  async pollNow(): Promise<void> {
    if (this.polling || this.keys.size === 0) return;
    this.polling = true;
    this.lastPoll = this.now;
    try {
      const targets = new Map<string, MenuTarget>();
      for (const k of this.keys.values()) for (const t of k.targets ?? []) targets.set(targetId(t), t);
      if (targets.size === 0) {
        await this.ax.check();
      } else {
        const list = [...targets.entries()];
        const res = await this.ax.enabledStates(list.map(([, t]) => t));
        list.forEach(([id], i) => this.enabled.set(id, res[i]));
      }
    } catch {
      /* status has been recorded by the bridge; keys redraw from it */
    } finally {
      this.polling = false;
      this.redrawAll();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.keys.clear();
  }
}

// ---------------------------------------------------------------- what an AX-dependent key shows

export interface Flash {
  text: string;
  tone?: Tone;
}

/** What to show when Accessibility/Capture is not usable, or undefined when all is well. */
export function axProblem(s: AxStatus): { label: string; tone: Tone } | undefined {
  switch (s) {
    case "noPermission":
    case "noAutomation":
      return { label: "Allow Access", tone: "red" };
    case "notRunning":
      return { label: "Capture?", tone: "red" };
    case "error":
      return { label: "Error", tone: "red" };
    default:
      return undefined;
  }
}

export interface AxKeyView {
  label: string;
  icon: string;
  /** true/false/null(not found)/undefined(unknown yet) */
  enabled?: boolean | null;
  dimWhenDisabled?: boolean;
  ax: AxStatus;
  flash?: Flash;
  active?: boolean;
}

export function axKeyOptions(v: AxKeyView): KeyOptions {
  if (v.flash) return { icon: v.icon, label: v.label, big: v.flash.text, tone: v.flash.tone ?? "accent" };
  const p = axProblem(v.ax);
  if (p) return { icon: v.icon, label: p.label, tone: p.tone };
  const disabled = v.enabled === false && v.dimWhenDisabled !== false;
  return { icon: v.icon, label: v.label, dim: disabled, badge: v.enabled === null ? "?" : undefined, active: v.active };
}
