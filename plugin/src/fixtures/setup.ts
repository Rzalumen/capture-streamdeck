/**
 * The per-show address setup. Capture never sends the patch over CITP (Patched=0 for every fixture), so the universe and DMX address
 * of each fixture the plugin may drive are entered by the user and stored here: per show name, keyed by the fixture's
 * CaptureInstanceId (stable per fixture), in the plugin's Stream Deck global settings.
 */
import type { GlobalSettings } from "../lib/globals.js";

export interface Address {
  universe: number;
  address: number;
}
export type SetupData = Record<string, Record<string, Address>>;

export const MAX_UNIVERSE = 16;
export const SETUP_KEY = "fixtureSetup";
export const showKey = (showName: string | null | undefined): string => (showName && showName.trim() ? showName : "(unnamed show)");

/** null when fine. channelCount (optional) also checks that the fixture fits in the universe. */
export function validateAddress(universe: unknown, address: unknown, channelCount?: number): string | null {
  if (!Number.isInteger(universe) || (universe as number) < 1 || (universe as number) > MAX_UNIVERSE) return `universe must be a whole number from 1 to ${MAX_UNIVERSE}`;
  if (!Number.isInteger(address) || (address as number) < 1 || (address as number) > 512) return "address must be a whole number from 1 to 512";
  if (channelCount !== undefined && (address as number) + channelCount - 1 > 512) return `${channelCount} channels starting at ${address as number} would end at ${(address as number) + channelCount - 1}, past 512`;
  return null;
}

export interface SetupEntry {
  key: string;
  label: string;
  channelCount: number;
  addr: Address;
}

/** Problems per fixture key: out of range, past 512, or overlapping another fixture's channels in the same universe. Empty map = clean. */
export function checkSetup(entries: SetupEntry[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (k: string, m: string): void => void out.set(k, [...(out.get(k) ?? []), m]);
  const ok: SetupEntry[] = [];
  for (const e of entries) {
    const bad = validateAddress(e.addr.universe, e.addr.address, e.channelCount);
    if (bad) add(e.key, bad);
    else ok.push(e);
  }
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      const a = ok[i];
      const b = ok[j];
      if (a.addr.universe !== b.addr.universe) continue;
      const aEnd = a.addr.address + a.channelCount - 1;
      const bEnd = b.addr.address + b.channelCount - 1;
      if (a.addr.address <= bEnd && b.addr.address <= aEnd) {
        add(a.key, `overlaps ${b.label} (${b.addr.universe}/${b.addr.address}–${bEnd})`);
        add(b.key, `overlaps ${a.label} (${a.addr.universe}/${a.addr.address}–${aEnd})`);
      }
    }
  }
  return out;
}

/**
 * Auto-fill: consecutive fixtures (in the order given) from `start`, each one starting right after the previous one's last channel.
 * A fixture that would not fit before 512 starts at address 1 of the next universe. Fails (assigns nothing) past universe MAX_UNIVERSE.
 */
export function autoFill(items: { key: string; channelCount: number }[], start: Address): { ok: true; assign: Record<string, Address> } | { ok: false; error: string } {
  const first = validateAddress(start.universe, start.address);
  if (first) return { ok: false, error: `start: ${first}` };
  const assign: Record<string, Address> = {};
  let u = start.universe;
  let a = start.address;
  for (const it of items) {
    if (!Number.isInteger(it.channelCount) || it.channelCount < 1 || it.channelCount > 512) return { ok: false, error: `${it.key}: a fixture with ${it.channelCount} channels does not fit in a universe` };
    if (a + it.channelCount - 1 > 512) {
      u++;
      a = 1;
    }
    if (u > MAX_UNIVERSE) return { ok: false, error: `the fixtures do not fit before universe ${MAX_UNIVERSE}` };
    assign[it.key] = { universe: u, address: a };
    a += it.channelCount;
  }
  return { ok: true, assign };
}

const cleanAddress = (v: unknown): Address | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const { universe, address } = v as Record<string, unknown>;
  return validateAddress(universe, address) === null ? { universe: universe as number, address: address as number } : undefined;
};

export class SetupStore {
  private data: SetupData = {};
  private listeners: (() => void)[] = [];
  constructor(private globals: GlobalSettings) {}

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Reads the stored setup (malformed entries are ignored). Never throws. */
  async load(): Promise<void> {
    try {
      const g = await this.globals.read();
      const raw = g[SETUP_KEY];
      const data: SetupData = {};
      if (raw && typeof raw === "object") {
        for (const [show, m] of Object.entries(raw as Record<string, unknown>)) {
          if (!m || typeof m !== "object") continue;
          for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
            const a = cleanAddress(v);
            if (a) (data[show] ??= {})[k] = a;
          }
        }
      }
      this.data = data;
    } catch {
      /* keep what we have */
    }
  }

  forShow(showName: string | null): Record<string, Address> {
    return { ...(this.data[showKey(showName)] ?? {}) };
  }
  get(showName: string | null, key: string): Address | undefined {
    return this.data[showKey(showName)]?.[key];
  }

  /** Set (or with null clear) one fixture's address. Range is validated here; overlaps are reported by checkSetup, not refused. */
  async set(showName: string | null, key: string, addr: Address | null): Promise<string | null> {
    if (addr) {
      const bad = validateAddress(addr.universe, addr.address);
      if (bad) return bad;
    }
    return this.setMany(showName, { [key]: addr });
  }

  async setMany(showName: string | null, changes: Record<string, Address | null>): Promise<string | null> {
    for (const a of Object.values(changes)) {
      if (!a) continue;
      const bad = validateAddress(a.universe, a.address);
      if (bad) return bad;
    }
    const s = showKey(showName);
    const next: SetupData = { ...this.data, [s]: { ...(this.data[s] ?? {}) } };
    for (const [k, a] of Object.entries(changes)) {
      if (a) next[s][k] = { universe: a.universe, address: a.address };
      else delete next[s][k];
    }
    if (!Object.keys(next[s]).length) delete next[s];
    const prev = this.data;
    this.data = next;
    try {
      await this.globals.update({ [SETUP_KEY]: next });
    } catch (e) {
      this.data = prev;
      return `could not save the setup: ${(e as Error).message}`;
    }
    for (const fn of this.listeners) fn();
    return null;
  }
}
