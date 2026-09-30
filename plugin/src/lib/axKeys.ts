import type { MenuTarget } from "./applescript.js";
import type { AxBridge, AxStatus } from "./axBridge.js";
import { nullLogger, type Logger } from "./log.js";
import { DroppedError } from "./queue.js";
import type { KeyOptions, Tone } from "./render.js";

export interface AxKey {
  id: string;
  /** Menu commands whose enabled state this key shows (polled in one batch with all other keys). May be a function so a self-healed path is picked up. */
  targets?: MenuTarget[] | (() => MenuTarget[]);
  redraw(): void;
}

export const targetId = (t: MenuTarget): string => JSON.stringify([t.path, t.match]);

export interface RegistryOptions {
  /** Idle polling period while keys are visible (default 5000 ms). */
  intervalMs?: number;
  /** Poll this long after a press (default 300 ms): the press usually changed which commands are enabled. */
  afterPressMs?: number;
  /** Batching delay after keys appear (default 25 ms): a whole page of keys appearing costs ONE poll. */
  appearDelayMs?: number;
  backoffMs?: number;
  logger?: Logger;
  now?: () => number;
}

/**
 * All keys that depend on Capture's Accessibility tree register here (registered = visible: from willAppear to
 * willDisappear). While at least one is visible the registry polls the enabled state of every registered target in ONE
 * request:
 *   - right after keys appear (batched),
 *   - `afterPressMs` after each press,
 *   - otherwise every `intervalMs` (5 s).
 * There is never more than one poll in flight, and a poll that is still waiting when a press arrives is dropped by the
 * bridge (the after-press poll replaces it). Polling only READS; it never clicks and never activates Capture.
 * While Accessibility access is missing it backs off to `backoffMs`.
 */
export class AxKeyRegistry {
  private keys = new Map<string, AxKey>();
  private enabled = new Map<string, boolean | null>();
  private interval: NodeJS.Timeout | undefined;
  private soon: NodeJS.Timeout | undefined;
  private soonAt = 0;
  private lastPoll = 0;
  private polling = false;
  /** Number of polls started (tests). */
  polls = 0;

  constructor(
    private ax: AxBridge,
    private opts: RegistryOptions = {},
  ) {
    const prev = ax.onStatus;
    ax.onStatus = (s) => {
      prev?.(s);
      this.redrawAll();
    };
  }

  private get intervalMs(): number {
    return this.opts.intervalMs ?? 5000;
  }
  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  get size(): number {
    return this.keys.size;
  }

  register(k: AxKey): void {
    this.keys.set(k.id, k);
    if (!this.interval) {
      this.interval = setInterval(() => void this.tick(), this.intervalMs);
      this.interval.unref?.();
    }
    this.pollSoon(this.opts.appearDelayMs ?? 25);
  }

  unregister(id: string): void {
    this.keys.delete(id);
    if (this.keys.size === 0) {
      if (this.interval) clearInterval(this.interval);
      this.interval = undefined;
      if (this.soon) clearTimeout(this.soon);
      this.soon = undefined;
    }
  }

  /** A user press was just handled: check what changed shortly afterwards. */
  pressed(): void {
    this.pollSoon(this.opts.afterPressMs ?? 300, true);
  }

  /** Poll in `ms`. An earlier pending poll wins unless `replace` (used after a press, which is worth waiting for). */
  private pollSoon(ms: number, replace = false): void {
    if (this.keys.size === 0) return;
    const at = this.now + ms;
    if (this.soon) {
      if (!replace && this.soonAt <= at) return;
      clearTimeout(this.soon);
    }
    this.soonAt = at;
    this.soon = setTimeout(() => {
      this.soon = undefined;
      void this.pollNow();
    }, ms);
    this.soon.unref?.();
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
    this.polls++;
    this.lastPoll = this.now;
    let changed = false;
    try {
      const targets = new Map<string, MenuTarget>();
      for (const k of this.keys.values()) for (const t of typeof k.targets === "function" ? k.targets() : (k.targets ?? [])) targets.set(targetId(t), t);
      if (targets.size === 0) {
        await this.ax.check("poll");
      } else {
        const list = [...targets.entries()];
        const res = await this.ax.enabledStates(list.map(([, t]) => t));
        list.forEach(([id], i) => {
          if (this.enabled.get(id) !== res[i]) changed = true;
          this.enabled.set(id, res[i]);
        });
      }
    } catch (e) {
      // Dropped for a press: the after-press poll follows. Anything else: the bridge has recorded the status; keys redraw from it.
      if (!(e instanceof DroppedError)) changed = true;
    } finally {
      this.polling = false;
      if (changed) this.redrawAll();
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.soon) clearTimeout(this.soon);
    this.interval = undefined;
    this.soon = undefined;
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
