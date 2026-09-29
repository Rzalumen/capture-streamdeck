import { realTimers, type TimerApi } from "./limiter.js";

/**
 * Tracks whether any "Store Modifier" key is held (key down → key up).
 * Safety: a lost key-up must never leave the deck silently overwriting camera positions, so a held
 * modifier auto-releases after `maxHoldMs` (default 30 s) and whenever its key leaves the screen.
 */
export class StoreModifier {
  private held = new Map<string, unknown>();
  onChange?: (held: boolean) => void;

  constructor(
    private maxHoldMs = 30000,
    private timers: TimerApi = realTimers,
  ) {}

  get isHeld(): boolean {
    return this.held.size > 0;
  }

  down(context: string): void {
    const was = this.isHeld;
    const old = this.held.get(context);
    if (old !== undefined) this.timers.clearTimeout(old);
    this.held.set(
      context,
      this.timers.setTimeout(() => this.up(context), this.maxHoldMs),
    );
    if (!was) this.onChange?.(true);
  }

  up(context: string): void {
    const t = this.held.get(context);
    if (t === undefined && !this.held.has(context)) return;
    if (t !== undefined) this.timers.clearTimeout(t);
    this.held.delete(context);
    if (!this.isHeld) this.onChange?.(false);
  }

  releaseAll(): void {
    for (const c of [...this.held.keys()]) this.up(c);
  }
}

export type SlotAction = { kind: "recall"; slot: number; path: string[] } | { kind: "store"; slot: number; path: string[] };

/** Which menu command a Camera Slot press fires: View > Camera > Position N, or View > Store Camera > Position N. */
export function slotAction(slot: number, storeHeld: boolean): SlotAction {
  const n = Math.min(5, Math.max(1, Math.round(slot)));
  return storeHeld
    ? { kind: "store", slot: n, path: ["View", "Store Camera", `Position ${n}`] }
    : { kind: "recall", slot: n, path: ["View", "Camera", `Position ${n}`] };
}
