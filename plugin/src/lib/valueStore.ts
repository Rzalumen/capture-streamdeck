/**
 * Capture has no OSC getters, so the plugin remembers the last value it sent per (view, property).
 * Persisted values live in Stream Deck global settings; "sent this session" is memory only, which is
 * what drives the greyed "~" on the touch strip until a dial first sends something this session.
 */
export interface Persist {
  load(): Promise<Record<string, number | boolean>>;
  save(values: Record<string, number | boolean>): Promise<void>;
}

const key = (view: string, prop: string): string => `${view}/${prop}`;

export class ValueStore {
  private values: Record<string, number | boolean> = {};
  private sent = new Set<string>();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(
    private persist: Persist,
    private saveDelayMs = 400,
  ) {}

  async init(): Promise<void> {
    try {
      this.values = { ...(await this.persist.load()) };
    } catch {
      this.values = {};
    }
  }

  get(view: string, prop: string): number | boolean | undefined {
    return this.values[key(view, prop)];
  }

  getNumber(view: string, prop: string, fallback: number): number {
    const v = this.get(view, prop);
    return typeof v === "number" ? v : fallback;
  }

  getBool(view: string, prop: string, fallback = false): boolean {
    const v = this.get(view, prop);
    return typeof v === "boolean" ? v : fallback;
  }

  /** True once a value has been sent for this (view, property) in this plugin session. */
  wasSentThisSession(view: string, prop: string): boolean {
    return this.sent.has(key(view, prop));
  }

  /** Update the tracked value (e.g. the dial moved) without claiming it has been sent yet. */
  setValue(view: string, prop: string, v: number | boolean): void {
    this.values[key(view, prop)] = v;
  }

  /** Record a value that has just been sent to Capture. */
  recordSent(view: string, prop: string, v: number | boolean): void {
    this.values[key(view, prop)] = v;
    this.sent.add(key(view, prop));
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.persist.save({ ...this.values }).catch(() => undefined);
    }, this.saveDelayMs);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.persist.save({ ...this.values });
  }
}
