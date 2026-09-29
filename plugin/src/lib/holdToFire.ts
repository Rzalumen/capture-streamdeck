import { realTimers, type TimerApi } from "./limiter.js";

export const HOLD_MS = 1000;

/** Commands that are destructive enough to default to hold-to-fire (matched on the last path element). */
export const HOLD_BY_DEFAULT = ["Delete", "Unpatch", "Remove Filters", "Remove Gobos", "Cut", "Paste"];

export function defaultHoldToFire(path: string[]): boolean {
  const last = (path[path.length - 1] ?? "").replace(/(…|\.\.\.)$/, "").trim();
  return HOLD_BY_DEFAULT.some((n) => n.toLowerCase() === last.toLowerCase());
}

/**
 * Hold-to-fire state machine, one instance per key context.
 *  keyDown: starts the timer. Reaching `holdMs` fires once.
 *  keyUp before the threshold: nothing fires, `onShortPress` (flash "Hold") is called.
 *  keyUp after firing: ignored.
 */
export class HoldToFire {
  private timer: unknown;
  private fired = false;
  private down = false;

  constructor(
    private onFire: () => void,
    private onShortPress: () => void,
    private holdMs = HOLD_MS,
    private timers: TimerApi = realTimers,
  ) {}

  get isDown(): boolean {
    return this.down;
  }

  keyDown(): void {
    this.cancelTimer();
    this.down = true;
    this.fired = false;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.down && !this.fired) {
        this.fired = true;
        this.onFire();
      }
    }, this.holdMs);
  }

  keyUp(): void {
    if (!this.down) return;
    this.down = false;
    if (!this.fired) {
      this.cancelTimer();
      this.onShortPress();
    }
    this.fired = false;
  }

  /** Key left the screen / plugin stopping: cancel without side effects. */
  cancel(): void {
    this.cancelTimer();
    this.down = false;
    this.fired = false;
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
