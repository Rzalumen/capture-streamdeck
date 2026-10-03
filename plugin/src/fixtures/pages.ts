/**
 * Attribute pages (Handoff 20, v0.6): every channel of a fixture type becomes a knob parameter on exactly one page, from its NAME only
 * (whole words, case-insensitive, camelCase split; a trailing number/letter on a word is ignored: "Frost2" = frost, "Shutter1A" = shutter
 * + "1a"). No fixture type is known here.
 *
 *   Position         pan, tilt
 *   Intensity        dimmer, intensity, shutter / strobe (a framing shutter goes to Shutters)
 *   Colour           red green blue white amber lime uv cyan magenta yellow cto ctb ctc, colour/color (wheel)
 *   Beam             zoom, focus, iris, frost, diffusion, edge
 *   Shutters         blade, framing / frame, "shutter" + a number or letter ("Shutter 1A"), shutter rotation
 *   Gobo/Prism/FX    gobo, prism, animation, effect, fx, rotation, index
 *   Other            everything else, so nothing is unreachable
 *
 * A name that also has a speed/time/mode/macro/control ... word (NOT_THE_VALUE) is never the value of a group: it goes to Other.
 * Fine channels (role 2) are never parameters of their own: they ride with their coarse channel (16-bit).
 * Colour: mixing channels (red … ctb, not wheels) whose names are equal once the numbers are removed ("Red 1" … "Red 5") are ONE knob.
 * Channels at offsets where candidate parses disagree (Handoff 13) are never driven, so they are on no page (`excluded`).
 */
import { isAdditiveColourName, type Slot } from "./attrs.js";
import { NOT_THE_VALUE, tokens, type Channel } from "./modes.js";

export type GroupId = "position" | "intensity" | "colour" | "beam" | "shutters" | "gobo" | "other";
export const GROUP_ORDER: readonly GroupId[] = ["position", "intensity", "colour", "beam", "shutters", "gobo", "other"];
export const GROUP_LABEL: Record<GroupId, string> = { position: "Position", intensity: "Intensity", colour: "Colour", beam: "Beam", shutters: "Shutters", gobo: "Gobo/Prism/FX", other: "Other" };
/** Knobs per page (dials 2–4). */
export const PER_PAGE = 3;

export interface Param {
  /** Unique within the type: `ch<offset of the first coarse channel>`. */
  id: string;
  /** Knob title: the channel name; for merged colour cells the shared name ("Red"). Unique within the type (a duplicate gets " #2"). */
  name: string;
  group: GroupId;
  /** Every channel this knob writes (one, or all cells of a colour), each with its fine partner when 16-bit. */
  slots: Slot[];
  /** Home value, 0..1 (raw percentage of the DMX range). */
  home: number;
  /** True when every slot is 16-bit. */
  sixteen: boolean;
}

export interface Page {
  group: GroupId;
  /** "Colour", or "Shutters" with part "1/3". */
  label: string;
  part: string;
  params: Param[];
}

export interface FixtureModel {
  params: Param[];
  pages: Page[];
  /** Lower-case name → parameter (to drive "the channel of the same name" on another type). */
  byName: Map<string, Param>;
  /** Coarse/8-bit (or fine) offset → the parameter writing it. */
  byOffset: Map<number, Param>;
  /** Channels on no page (candidate parses disagree there), never driven. */
  excluded: number[];
}

/** Word tokens, each with a trailing number/letter suffix removed for matching ("frost2" → "frost", "shutter1a" → "shutter"). */
function words(name: string): { raw: string[]; base: string[] } {
  const raw = tokens(name);
  return { raw, base: raw.map((t) => t.replace(/(?<=[a-z])\d+[a-z]?$/, "")) };
}
const isNumberish = (t: string): boolean => /^\d+[a-z]?$/.test(t) || /^[a-z]$/.test(t);
const has = (b: string[], ...w: string[]): boolean => b.some((t) => w.includes(t));
const starts = (b: string[], ...w: string[]): boolean => b.some((t) => w.some((x) => t.startsWith(x)));

/** A framing shutter: blade / framing, or "shutter" followed by a number/letter, or a shutter rotation. */
function isFramingShutter(raw: string[], base: string[]): boolean {
  if (has(base, "blade", "blades", "framing", "frame", "frames")) return true;
  if (!has(base, "shutter", "shutters")) return false;
  if (has(base, "rotation", "rot", "rotate")) return true;
  if (raw.some((t) => /^shutters?\d+[a-z]?$/.test(t))) return true;
  const i = raw.findIndex((t) => t === "shutter" || t === "shutters");
  return i >= 0 && i + 1 < raw.length && isNumberish(raw[i + 1]);
}

const MIX_WORDS = ["red", "green", "blue", "white", "amber", "lime", "uv", "cyan", "magenta", "yellow", "cto", "ctb", "ctc"];
const COLOUR_WORDS = [...MIX_WORDS, "colour", "color", "colours", "colors"];
/** Only mixing channels merge into one knob per colour; two colour wheels stay two knobs. */
const mergeable = (name: string): boolean => {
  const { base } = words(name);
  return has(base, ...MIX_WORDS) && !has(base, "colour", "color", "colours", "colors", "wheel");
};

/** The group of one channel name (first rule that matches, in GROUP_ORDER). */
export function groupOf(name: string): GroupId {
  const { raw, base } = words(name);
  if (base.some((t) => NOT_THE_VALUE.has(t))) return "other";
  if (has(base, "pan", "tilt")) return "position";
  const framing = isFramingShutter(raw, base);
  if (!framing && (starts(base, "dimmer", "intensity") || has(base, "shutter", "strobe"))) return "intensity";
  if (has(base, ...COLOUR_WORDS)) return "colour";
  if (has(base, "zoom", "focus", "iris", "frost", "diffusion", "diffuser", "edge")) return "beam";
  if (framing) return "shutters";
  if (has(base, "gobo", "gobos", "prism", "prisms", "animation", "anim", "effect", "effects", "fx", "rotation", "rot", "index")) return "gobo";
  return "other";
}

/** Colour cells merge on the name without its numbers ("Red 3" → "red", "Cell 2 Red" → "cell red"). */
const cellKey = (name: string): string =>
  words(name)
    .raw.map((t) => t.replace(/(?<=[a-z])\d+$/, ""))
    .filter((t) => !/^\d+$/.test(t))
    .join(" ");
const cellTitle = (name: string): string =>
  name
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*([/·-])\s*$/, "")
    .trim() || name;

/**
 * Home values (Handoff 20 §4): pan/tilt 50 %; dimmer/intensity 100 %; the FIRST shutter/strobe channel at 255 (as in v0.5: open), other
 * shutter/strobe channels 0; additive colour 100 %, subtractive / CTO / wheels 0; zoom, focus, iris, frost 0 (their v0.5 default);
 * framing shutters 0 (blades out); everything else 0.
 */
function homeOf(group: GroupId, name: string, firstShutter: boolean, sixteen: boolean): number {
  const { base } = words(name);
  switch (group) {
    case "position":
      return 0.5;
    case "intensity":
      if (starts(base, "dimmer", "intensity")) return 1;
      if (!firstShutter) return 0;
      return sixteen ? 0xff00 / 0xffff : 1; // coarse 255, fine 0 (the v0.5 shutter value)
    case "colour":
      return isAdditiveColourName(name) ? 1 : 0;
    default:
      return 0;
  }
}

/**
 * Builds the knob parameters and pages of one fixture type from its parsed channel list. `excludedOffsets`: offsets where candidate
 * channel lists disagree; a parameter touching one of them is left out (never driven).
 */
export function buildModel(channels: Channel[], excludedOffsets: readonly number[] = []): FixtureModel {
  const bad = new Set(excludedOffsets);
  const claimed = new Set<number>();
  for (const c of channels) if (c.role === 1 && channels[c.pair]?.role === 2 && channels[c.pair].pair === c.offset) claimed.add(c.pair);
  const slotOf = (c: Channel): Slot => ({ coarse: c, fine: c.role === 1 && claimed.has(c.pair) ? channels[c.pair] : null });

  const params: Param[] = [];
  const colourByKey = new Map<string, Param>();
  const excluded: number[] = [];
  let shutterSeen = false;
  for (const c of channels) {
    if (c.role === 2 && claimed.has(c.offset)) continue; // a fine half: it rides with its coarse channel
    const s = slotOf(c);
    if (bad.has(c.offset) || (s.fine && bad.has(s.fine.offset))) {
      excluded.push(c.offset, ...(s.fine ? [s.fine.offset] : []));
      continue;
    }
    const group = groupOf(c.name);
    const sixteen = !!s.fine;
    if (group === "colour" && mergeable(c.name)) {
      const k = cellKey(c.name);
      const p = colourByKey.get(k);
      if (p) {
        p.slots.push(s);
        p.sixteen = p.sixteen && sixteen;
        continue;
      }
    }
    const { base } = words(c.name);
    const isShutter = group === "intensity" && !starts(base, "dimmer", "intensity");
    const p: Param = { id: `ch${c.offset}`, name: c.name, group, slots: [s], home: homeOf(group, c.name, isShutter && !shutterSeen, sixteen), sixteen };
    if (isShutter) shutterSeen = true;
    if (group === "colour" && mergeable(c.name)) colourByKey.set(cellKey(c.name), p);
    params.push(p);
  }
  // merged colour cells: one title ("Red"), home from that title
  for (const p of params) {
    if (p.group !== "colour" || p.slots.length < 2) continue;
    p.name = cellTitle(p.slots[0].coarse.name);
    p.home = isAdditiveColourName(p.name) ? 1 : 0;
  }
  // unique names within the type
  const seen = new Map<string, number>();
  for (const p of params) {
    const k = p.name.toLowerCase();
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > 1) p.name = `${p.name} #${n}`;
  }

  const pages: Page[] = [];
  for (const g of GROUP_ORDER) {
    const ps = params.filter((p) => p.group === g);
    if (!ps.length) continue;
    const n = Math.ceil(ps.length / PER_PAGE);
    for (let i = 0; i < n; i++) pages.push({ group: g, label: GROUP_LABEL[g], part: n > 1 ? `${i + 1}/${n}` : "", params: ps.slice(i * PER_PAGE, (i + 1) * PER_PAGE) });
  }
  const byName = new Map(params.map((p) => [p.name.toLowerCase(), p]));
  const byOffset = new Map<number, Param>();
  for (const p of params) for (const s of p.slots) {
    byOffset.set(s.coarse.offset, p);
    if (s.fine) byOffset.set(s.fine.offset, p);
  }
  return { params, pages, byName, byOffset, excluded: excluded.sort((a, b) => a - b) };
}

/** "Shutters 1/3", "Colour". */
export const pageTitle = (p: Page): string => (p.part ? `${p.label} ${p.part}` : p.label);

/** The parameter of another fixture's model that "the same knob" drives: same name (case-insensitive), or none. */
export const sameParam = (model: FixtureModel, p: Param): Param | undefined => model.byName.get(p.name.toLowerCase());
