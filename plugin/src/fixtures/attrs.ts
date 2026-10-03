/**
 * Generic attribute resolution from a fixture's own parsed channel list. No fixture type is known here: everything comes from channel
 * NAMES (whole words, case-insensitive; channels whose name also has a speed/mode/curve ... word are not the value channel — the same
 * rules as research/lib/modes.mjs and research/lib/extras.mjs).
 *
 *  pan, tilt, zoom, focus, iris, intensity (dimmer/intensity/dim) — one channel (+ its fine partner when it is the coarse half of a pair)
 *  red, green, blue, white (additive), cyan, magenta, yellow (subtractive) — EVERY channel with that word (cells, "Red 1".."Red 8", ...)
 *  shutter (shutter/strobe) — held at a fixed value, not a dial
 *  additive extras (amber, lime, uv ...) — held full with the other additive colours, not a dial
 */
import { NOT_THE_VALUE, tokens, type Channel } from "./modes.js";

export type AttrId = "pan" | "tilt" | "intensity" | "zoom" | "focus" | "iris" | "red" | "green" | "blue" | "white" | "cyan" | "magenta" | "yellow";

export const SINGLE_ATTRS = ["pan", "tilt", "intensity", "zoom", "focus", "iris"] as const;
export const COLOUR_ATTRS = ["red", "green", "blue", "white", "cyan", "magenta", "yellow"] as const;
export const ALL_ATTRS: readonly AttrId[] = [...SINGLE_ATTRS, ...COLOUR_ATTRS];

/** The dial ids of the plugin: one per Stream Deck dial action. The colour dials resolve to additive-if-present else subtractive. */
export type DialId = "pan" | "tilt" | "intensity" | "zoom" | "focus" | "iris" | "red-cyan" | "green-magenta" | "blue-yellow" | "white";
export const DIAL_IDS: readonly DialId[] = ["pan", "tilt", "intensity", "zoom", "focus", "iris", "red-cyan", "green-magenta", "blue-yellow", "white"];
const COLOUR_PAIRS: Record<string, [AttrId, AttrId | null]> = { "red-cyan": ["red", "cyan"], "green-magenta": ["green", "magenta"], "blue-yellow": ["blue", "yellow"], white: ["white", null] };

/** One DMX parameter: its coarse (or only) channel and the fine partner when it is 16-bit. */
export interface Slot {
  coarse: Channel;
  fine: Channel | null;
}

export interface ChannelMap {
  attrs: Partial<Record<AttrId, Slot[]>>;
  /** Shutter / strobe: held at the shutter value (255) when the fixture is first touched. */
  shutter: Slot | null;
  /** Additive emitters that have no dial (amber, lime, uv ...): held full. */
  extraAdditive: Slot[];
  warnings: string[];
}

const ADDITIVE = new Set(["red", "green", "blue", "white", "amber", "lime", "uv"]);
/** Never part of a colour value: correction / tint channels, strobe/shutter channels (and the other colour system's words). */
const NEVER = new Set(["cyan", "magenta", "yellow", "cto", "ctb", "ctc", "cmy", "correction", "corr", "balance", "minus", "plus", "tint", "temperature", "temp", "strobe", "shutter", "flash"]);
const EXCLUDE_FOR_COLOUR = new Set([...NEVER].filter((w) => !["cyan", "magenta", "yellow"].includes(w)));

/** True when the channel NAME is an additive colour emitter (has an additive word, no never-word, no speed/mode/curve ... word). */
export function isAdditiveColourName(name: string): boolean {
  const t = tokens(name);
  return t.some((w) => ADDITIVE.has(w)) && !t.some((w) => NEVER.has(w) || NOT_THE_VALUE.has(w));
}

const notValue = (t: string[]): boolean => t.some((w) => NOT_THE_VALUE.has(w));

const SINGLE_MATCH: Record<(typeof SINGLE_ATTRS)[number], (t: string) => boolean> = {
  pan: (t) => t === "pan",
  tilt: (t) => t === "tilt",
  intensity: (t) => t.startsWith("dimmer") || t.startsWith("intensity") || t === "dim",
  zoom: (t) => t === "zoom",
  focus: (t) => t === "focus",
  iris: (t) => t === "iris",
};
const SHUTTER = (t: string): boolean => t.startsWith("shutter") || t.startsWith("strobe");

/** Resolve every attribute of a parsed channel list. A channel serves one attribute only (first in the order above wins). */
export function mapChannels(channels: Channel[]): ChannelMap {
  const used = new Set<number>();
  const warnings: string[] = [];
  const attrs: ChannelMap["attrs"] = {};
  const slotOf = (c: Channel): Slot => ({ coarse: c, fine: c.role === 1 ? (channels[c.pair] ?? null) : null });
  const take = (s: Slot): void => {
    used.add(s.coarse.offset);
    if (s.fine) used.add(s.fine.offset);
  };

  for (const a of SINGLE_ATTRS) {
    const m = SINGLE_MATCH[a];
    const good = channels.filter((c) => c.role !== 2 && !used.has(c.offset) && tokens(c.name).some(m) && !notValue(tokens(c.name)));
    if (!good.length) continue;
    const s = slotOf(good[0]);
    take(s);
    attrs[a] = [s];
    if (good.length > 1) warnings.push(`${a}: several channels match; using ${good[0].offset + 1} "${good[0].name}", ignoring ${good.slice(1).map((c) => `${c.offset + 1} "${c.name}"`).join(", ")}`);
  }
  // shutter: first value channel
  const sh = channels.filter((c) => c.role !== 2 && !used.has(c.offset) && tokens(c.name).some(SHUTTER) && !notValue(tokens(c.name)));
  let shutter: Slot | null = null;
  if (sh.length) {
    shutter = slotOf(sh[0]);
    take(shutter);
  }
  for (const a of COLOUR_ATTRS) {
    const good = channels.filter((c) => {
      if (c.role === 2 || used.has(c.offset)) return false;
      const t = tokens(c.name);
      return t.includes(a) && !notValue(t) && !t.some((w) => EXCLUDE_FOR_COLOUR.has(w));
    });
    if (!good.length) continue;
    const slots = good.map(slotOf);
    for (const s of slots) take(s);
    attrs[a] = slots;
  }
  // other additive emitters (amber, lime, uv ...) — held full with the rest
  const extraAdditive: Slot[] = [];
  for (const c of channels) {
    if (c.role === 2 || used.has(c.offset) || !isAdditiveColourName(c.name)) continue;
    const s = slotOf(c);
    take(s);
    extraAdditive.push(s);
  }
  return { attrs, shutter, extraAdditive, warnings };
}

/** What the attribute mapping means for the channels the plugin WRITES: used as the signature that candidate channel lists must agree on. */
export function drivenSignature(channels: Channel[]): Record<string, Channel[]> {
  const m = mapChannels(channels);
  const out: Record<string, Channel[]> = {};
  const flat = (slots: Slot[]): Channel[] => slots.flatMap((s) => (s.fine ? [s.coarse, s.fine] : [s.coarse]));
  for (const a of ALL_ATTRS) out[a] = flat(m.attrs[a] ?? []);
  out.shutter = m.shutter ? flat([m.shutter]) : [];
  out.extraAdditive = flat(m.extraAdditive);
  return out;
}

/** Which attribute a dial acts on for this fixture: the additive colour when the fixture has it, otherwise the subtractive one. */
export function dialAttr(map: ChannelMap, dial: DialId): AttrId | null {
  const pair = COLOUR_PAIRS[dial];
  if (!pair) return map.attrs[dial as AttrId]?.length ? (dial as AttrId) : null;
  const [add, sub] = pair;
  if (map.attrs[add]?.length) return add;
  if (sub && map.attrs[sub]?.length) return sub;
  return null;
}

/** Home / default value (fraction 0..1) of an attribute: pan/tilt 50 %, intensity 100 %, additive colours full, everything else 0. */
export function homeValue(a: AttrId): number {
  switch (a) {
    case "pan":
    case "tilt":
      return 0.5;
    case "intensity":
    case "red":
    case "green":
    case "blue":
    case "white":
      return 1;
    default:
      return 0;
  }
}

export const SHUTTER_OPEN_RAW = 255;

/** 8-bit: round(f×255). 16-bit pair: round(f×65535) split into coarse (high) and fine (low) byte. */
export function writeSlot(slots: Uint8Array, base: number, s: Slot, fraction: number): void {
  const f = Math.min(1, Math.max(0, fraction));
  if (s.fine) {
    const v = Math.round(f * 65535);
    slots[base + s.coarse.offset] = v >> 8;
    slots[base + s.fine.offset] = v & 0xff;
  } else slots[base + s.coarse.offset] = Math.round(f * 255);
}

/** Dial maths: current + ticks × step (1 %, or 0.1 % in fine mode), clamped to 0..1 and kept on a 0.01 % grid so repeated steps don't drift. */
export function stepFraction(current: number, ticks: number, fine: boolean): number {
  const step = fine ? 0.001 : 0.01;
  const v = Math.min(1, Math.max(0, current + ticks * step));
  return Math.round(v * 10000) / 10000;
}

/** The fixture's state at first touch: every attribute at its home value. */
export function defaultValues(map: ChannelMap): Partial<Record<AttrId, number>> {
  const v: Partial<Record<AttrId, number>> = {};
  for (const a of ALL_ATTRS) if (map.attrs[a]?.length) v[a] = homeValue(a);
  return v;
}

/** All slot writes for one fixture: held values (shutter, extra additive) first, then the attribute values. Everything else stays as it was (0). */
export function renderFixture(slots: Uint8Array, base: number, map: ChannelMap, values: Partial<Record<AttrId, number>>, shutterRaw = SHUTTER_OPEN_RAW): void {
  if (map.shutter) {
    slots[base + map.shutter.coarse.offset] = shutterRaw & 0xff;
    if (map.shutter.fine) slots[base + map.shutter.fine.offset] = 0;
  }
  for (const s of map.extraAdditive) writeSlot(slots, base, s, 1);
  for (const a of ALL_ATTRS) {
    const v = values[a];
    if (v === undefined) continue;
    for (const s of map.attrs[a] ?? []) writeSlot(slots, base, s, v);
  }
}
