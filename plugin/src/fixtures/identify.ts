/**
 * Fixture identification (v0.5). Capture reports FixtureIdentifier 0xffffffff for a fixture nobody identified, and then sends no
 * FixtureSelection / FixtureModify for it. One FixtureIdentify (proven on a real Capture) gives each such fixture a number, keyed by
 * its CaptureInstanceId bytes exactly as received.
 *
 * Rules: only fixtures whose identifier is 0xffffffff are ever sent; a fixture that already has an identifier keeps it (Capture's
 * own number is reused, never replaced); new numbers are the next unused ones from 100001 upward, skipping every number Capture
 * already reports and every number we have just assigned. A fixture we sent but that still shows 0xffffffff after a fresh list is
 * retried (the same number) at most MAX_ATTEMPTS times per connection, never sooner than RESEND_AFTER_MS after the last send.
 */
import { UNIDENTIFIED, type CaexFixture } from "./citp.js";

export const FIRST_IDENTIFIER = 100001;
export const MAX_ATTEMPTS = 3;
export const RESEND_AFTER_MS = 5000;

export interface IdentifyItem {
  guid: Buffer;
  guidRaw: string;
  identifier: number;
}
export interface IdentifyPlan {
  items: IdentifyItem[];
  /** Fixtures that already have an identifier (Capture's own, reused as is). */
  existing: number;
  /** Fixtures at 0xffffffff that cannot be identified (no usable CaptureInstanceId) or have run out of attempts. */
  skipped: number;
  total: number;
}

/** The fixture's CaptureInstanceId as raw-order guid string and its 16 bytes, or null. */
export function instanceOf(f: CaexFixture): { guidRaw: string; bytes: Buffer } | null {
  const inst = f.ids.find((d) => d.type === 0x04);
  if (!inst || !inst.guidRaw || inst.size !== 16) return null;
  const bytes = Buffer.from(inst.guidRaw.replaceAll("-", ""), "hex");
  return bytes.length === 16 ? { guidRaw: inst.guidRaw, bytes } : null;
}

export class IdentifyPlanner {
  private pending = new Map<string, { identifier: number; attempts: number; sentAt: number }>();

  constructor(private now: () => number = Date.now) {}

  /** identifier -> fixture key (the CaptureInstanceId) for numbers we assigned and Capture has not confirmed yet. */
  pendingIds(): Map<number, string> {
    return new Map([...this.pending].map(([k, v]) => [v.identifier, k]));
  }
  get pendingCount(): number {
    return this.pending.size;
  }
  reset(): void {
    this.pending.clear();
  }

  /**
   * `all` = every fixture Capture has told us about (the merged list, not just the latest message). Confirms pending ones, then plans
   * what to send now. Does not send; call `sent()` afterwards.
   */
  plan(all: CaexFixture[]): IdentifyPlan & { confirmed: number; mismatched: number } {
    const used = new Set<number>();
    let existing = 0;
    for (const f of all) if (f.identifier !== UNIDENTIFIED) used.add(f.identifier >>> 0);
    let confirmed = 0;
    let mismatched = 0;
    // pending entries that Capture now reports with an identifier are done
    for (const f of all) {
      const inst = instanceOf(f);
      if (!inst) continue;
      const p = this.pending.get(inst.guidRaw);
      if (p && f.identifier !== UNIDENTIFIED) {
        if (f.identifier === p.identifier) confirmed++;
        else mismatched++;
        this.pending.delete(inst.guidRaw);
      }
    }
    // numbers in flight are taken
    for (const p of this.pending.values()) used.add(p.identifier);
    const items: IdentifyItem[] = [];
    let skipped = 0;
    let next = FIRST_IDENTIFIER;
    const nextFree = (): number => {
      while (used.has(next)) next++;
      used.add(next);
      return next;
    };
    const t = this.now();
    for (const f of all) {
      if (f.identifier !== UNIDENTIFIED) {
        existing++;
        continue;
      }
      const inst = instanceOf(f);
      if (!inst) {
        skipped++;
        continue;
      }
      const p = this.pending.get(inst.guidRaw);
      if (p) {
        if (t - p.sentAt < RESEND_AFTER_MS) continue; // just sent: wait for the list that confirms it
        if (p.attempts >= MAX_ATTEMPTS) {
          skipped++;
          continue;
        }
        items.push({ guid: inst.bytes, guidRaw: inst.guidRaw, identifier: p.identifier });
        continue;
      }
      items.push({ guid: inst.bytes, guidRaw: inst.guidRaw, identifier: nextFree() });
    }
    return { items, existing, skipped, total: all.length, confirmed, mismatched };
  }

  /** Record that `items` were sent (starts the attempt count / resend timer). */
  sent(items: IdentifyItem[]): void {
    const t = this.now();
    for (const i of items) {
      const p = this.pending.get(i.guidRaw);
      this.pending.set(i.guidRaw, { identifier: i.identifier, attempts: (p?.attempts ?? 0) + 1, sentAt: t });
    }
  }
}
