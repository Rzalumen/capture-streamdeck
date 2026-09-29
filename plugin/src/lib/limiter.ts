export interface TimerApi {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}
export const realTimers: TimerApi = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * Latest-value-wins sender: at most `perSecond` sends per second per key (default 30).
 * While throttled only the newest value is kept and sent when the interval elapses.
 */
export class LatestValueLimiter<V> {
  private readonly interval: number;
  private state = new Map<string, { last: number; timer?: unknown; pending?: { v: V } }>();

  constructor(
    private send: (key: string, v: V) => void,
    perSecond = 30,
    private timers: TimerApi = realTimers,
  ) {
    this.interval = 1000 / perSecond;
  }

  push(key: string, v: V): void {
    const s = this.state.get(key) ?? { last: -Infinity };
    this.state.set(key, s);
    const now = this.timers.now();
    const wait = s.last + this.interval - now;
    if (wait <= 0 && !s.timer) {
      s.last = now;
      this.send(key, v);
      return;
    }
    s.pending = { v };
    if (!s.timer) {
      s.timer = this.timers.setTimeout(() => {
        s.timer = undefined;
        const p = s.pending;
        s.pending = undefined;
        if (p) {
          s.last = this.timers.now();
          this.send(key, p.v);
        }
      }, Math.max(0, wait));
    }
  }

  cancelAll(): void {
    for (const s of this.state.values()) if (s.timer) this.timers.clearTimeout(s.timer);
    this.state.clear();
  }
}
