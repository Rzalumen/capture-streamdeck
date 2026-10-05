/**
 * Attribute pages (Handoff 20, v0.6; Main page Handoff 21, v0.7): every channel of a fixture type becomes a knob parameter on exactly
 * one page, from its NAME only (whole words, case-insensitive, camelCase split; a trailing number/letter on a word is ignored:
 * "Frost2" = frost, "Shutter1A" = shutter + "1a"). No fixture type is known here.
 *
 *   Main             dial 1 = the first pan, 2 = the first tilt, 3 = the first dimmer / intensity / dim, 4 = the first zoom ("—" when missing)
 *   Colour           red green blue white amber lime uv cyan magenta yellow cto ctb ctc, colour/color (wheel)
 *   Beam             zoom, focus, iris, frost, diffusion, edge; and shutter / strobe (not framing) — v0.7.1 merged Strobe/Shutter in
 *   Shutters         blade, framing / frame, "shutter" + a number or letter ("Shutter 1A"), shutter rotation
 *   Gobo/FX          gobo, prism, animation, effect, fx, rotation, index
 *   Other            everything else, so nothing is unreachable (also a second pan, tilt, dimmer or zoom channel)
 *   (hidden)         function / functions / control / auto (whole words): on no page, always sent at 0 (Handoff 22)
 *
 * A name that also has a speed/time/mode/macro/control ... word (NOT_THE_VALUE) is never the value of a group: it goes to Other.
 * Fine channels (role 2) are never parameters of their own: they ride with their coarse channel (16-bit).
 * Colour: mixing channels (red … ctb, not wheels) whose names are equal once the numbers are removed ("Red 1" … "Red 5") are ONE knob.
 * Channels at offsets where candidate parses disagree (Handoff 13) are never driven, so they are on no page (`excluded`).
 * Labels (Handoff 21 addendum): a 16-bit knob whose coarse channel's name ends in the word "Coarse" is labelled without it ("Focus Coarse"
 * + "Focus Fine" → "Focus"). The pairing itself always comes from the library's role/pair records, never from the names.
 */
import { isAdditiveColourName, type Slot } from "./attrs.js";
import { NOT_THE_VALUE, tokens, type Channel } from "./modes.js";

export type GroupId = "main" | "colour" | "beam" | "shutters" | "gobo" | "other";
/** v0.10.1 (Handoff 29): after Main, Shutters · Beam · Colour · Gobo/FX · Other (was Colour · Beam · Shutters · …). */
export const GROUP_ORDER: readonly GroupId[] = ["main", "shutters", "beam", "colour", "gobo", "other"];
export const GROUP_LABEL: Record<GroupId, string> = { main: "Main", colour: "Colour", beam: "Beam", shutters: "Shutters", gobo: "Gobo/FX", other: "Other" };
/** What a channel name is (before the Main page takes the first pan, tilt, dimmer and zoom). */
export type Kind = "pan" | "tilt" | "dimmer" | "zoom" | "strobe" | "colour" | "beam" | "shutters" | "gobo" | "other";
/** The Main page's dials 1–4 (v0.7.1), and what each shows when the fixture has no such channel. */
export const MAIN_KINDS = ["pan", "tilt", "dimmer", "zoom"] as const;
export const MAIN_LABELS = ["Pan", "Tilt", "Intensity", "Zoom"] as const;
/** Knobs per page (v0.7.1: all four dials are Attribute dials). */
export const PER_PAGE = 4;
/** Whole words that hide a channel from every page (Handoff 22): it is still sent, always at 0. */
const HIDDEN_WORDS = ["function", "functions", "control", "auto"];

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
  /** The first group on the page (Main pages: "main"). */
  group: GroupId;
  /** Every group with a channel on this page, in group order (v0.7.1: pages are filled across groups). */
  groups?: GroupId[];
  /** "Colour", or "Shutters" with part "1/3". */
  label: string;
  part: string;
  /** One per dial (2–4). The Main page keeps its positions: null = the fixture has no such channel ("—"). */
  params: (Param | null)[];
  /** What a null dial is called ("Intensity"). */
  placeholders?: string[];
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
  /** Hidden channels (function / control / auto, Handoff 22): on no page, always sent at 0, never stored. Offsets incl. fine partners. */
  hidden: number[];
  /** No dimmer/intensity channel: Main shows "—" on dial 4. */
  noIntensity: boolean;
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

/** Handoff 22: a channel whose name has the whole word function / functions / control / auto is never on a page (always 0). */
export function isHiddenName(name: string): boolean {
  const { raw, base } = words(name);
  return [...raw, ...base].some((t) => HIDDEN_WORDS.includes(t));
}

/** Handoff 22 migration: a shutter or strobe channel (not a framing blade), whose stored value may be the old bad 255. */
export function isShutterStrobeName(name: string): boolean {
  const { raw, base } = words(name);
  return starts(base, "shutter", "strobe") && !isFramingShutter(raw, base);
}

/** What one channel name is (first rule that matches). */
export function kindOf(name: string): Kind {
  const { raw, base } = words(name);
  if (base.some((t) => NOT_THE_VALUE.has(t))) return "other";
  if (has(base, "pan")) return "pan";
  if (has(base, "tilt")) return "tilt";
  if (has(base, "dimmer", "intensity", "dim")) return "dimmer";
  const framing = isFramingShutter(raw, base);
  if (!framing && starts(base, "shutter", "strobe")) return "strobe";
  if (has(base, ...COLOUR_WORDS)) return "colour";
  if (has(base, "zoom")) return "zoom";
  if (has(base, "focus", "iris", "frost", "diffusion", "diffuser", "edge")) return "beam";
  if (framing) return "shutters";
  if (has(base, "gobo", "gobos", "prism", "prisms", "animation", "anim", "effect", "effects", "fx", "rotation", "rot", "index")) return "gobo";
  return "other";
}

/** The group a channel of this kind goes to when it is NOT the first pan / tilt / dimmer / zoom (those are on Main). Strobe/shutter is part of Beam (v0.7.1). */
const GROUP_OF_KIND: Record<Kind, GroupId> = { pan: "other", tilt: "other", dimmer: "other", zoom: "beam", strobe: "beam", colour: "colour", beam: "beam", shutters: "shutters", gobo: "gobo", other: "other" };

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
 * Home values (Handoff 22, Reza's table; first touch, Home Selected, strip-tap home). 16-bit channels: the same %, coarse and fine both set.
 *   pan, tilt 50 % · dimmer / intensity / dim 100 %
 *   shutter value channels ("Shutter", "Shutter/LED", "Shutter/Strobe": a shutter word, not a function/mode/control/speed channel and
 *     not a framing blade) 100 % (open) · strobe-only channels ("Strobe") 0 · shutter function/mode/control channels 0
 *   zoom, iris, focus 50 % · frost, diffusion (and edge) 0
 *   framing blades (insertion) 0 = fully out · blade angle, frame rotation, shutter rotation 50 % — but a blade name with an END letter
 *     ("Blade 1 Angle A", "Blade 1A") is an insertion end: 0
 *   additive colour 100 % · subtractive, CTO, CTB, colour wheel 0 · gobo, prism, animation, effect and their rotate/index 0 · the rest 0
 */
export function homeFor(name: string, kind: Kind = kindOf(name)): number {
  const { base } = words(name);
  switch (kind) {
    case "pan":
    case "tilt":
      return 0.5;
    case "dimmer":
      return 1;
    case "strobe":
      return starts(base, "shutter") ? 1 : 0;
    case "zoom":
      return 0.5;
    case "beam":
      return has(base, "focus", "iris") ? 0.5 : 0;
    case "shutters": {
      // blade angle / frame rotation / shutter rotation 50 %; insertion 0. A name that also names a blade END ("Blade 1 Angle A",
      // "Blade 1A") is an insertion end (its depth sets the angle): 0, so a default never cuts into the beam.
      const { raw } = words(name);
      const end = raw.some((t) => /^[a-d]$/.test(t) || /^\d+[a-d]$/.test(t));
      return has(base, "angle", "rotation", "rot", "rotate") && !end ? 0.5 : 0;
    }
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
  const hidden: number[] = [];
  const main: (Param | null)[] = [null, null, null, null];
  for (const c of channels) {
    if (c.role === 2 && claimed.has(c.offset)) continue; // a fine half: it rides with its coarse channel
    const s = slotOf(c);
    if (bad.has(c.offset) || (s.fine && bad.has(s.fine.offset))) {
      excluded.push(c.offset, ...(s.fine ? [s.fine.offset] : []));
      continue;
    }
    if (isHiddenName(c.name)) {
      hidden.push(c.offset, ...(s.fine ? [s.fine.offset] : []));
      continue;
    }
    const kind = kindOf(c.name);
    const mainSlot = (MAIN_KINDS as readonly string[]).indexOf(kind);
    const onMain = mainSlot >= 0 && !main[mainSlot];
    const group: GroupId = onMain ? "main" : GROUP_OF_KIND[kind];
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
    const p: Param = { id: `ch${c.offset}`, name: c.name, group, slots: [s], home: homeFor(c.name, kind), sixteen };
    if (onMain) main[mainSlot] = p;
    if (group === "colour" && mergeable(c.name)) colourByKey.set(cellKey(c.name), p);
    params.push(p);
  }
  // merged colour cells: one title ("Red"), home from that title
  for (const p of params) {
    if (p.group !== "colour" || p.slots.length < 2) continue;
    p.name = cellTitle(p.slots[0].coarse.name);
    p.home = isAdditiveColourName(p.name) ? 1 : 0;
  }
  // "Focus Coarse" (16-bit) → "Focus": the knob is the pair, so "Coarse" says nothing
  for (const p of params) {
    if (p.slots.length !== 1 || !p.slots[0].fine) continue;
    const short = p.name.replace(/[\s_-]+coarse$/i, "").trim();
    if (short && short !== p.name) p.name = short;
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
  if (main.some(Boolean)) pages.push({ group: "main", label: GROUP_LABEL.main, part: "", params: main, placeholders: [...MAIN_LABELS] });
  // v0.7.1 (Handoff 22, "at most 8 pages"): after Main, the channels run in group order (v0.10.1: Shutters · Beam · Colour · Gobo/FX · Other) and
  // fill every page with 4, so a small remainder of one group shares a page with the start of the next. A page is titled by the groups
  // on it ("Colour · Beam"); a title that repeats is numbered ("Shutters 1/2").
  const rest = GROUP_ORDER.filter((g) => g !== "main").flatMap((g) => params.filter((p) => p.group === g));
  const packed: Page[] = [];
  for (let i = 0; i < rest.length; i += PER_PAGE) {
    const ps = rest.slice(i, i + PER_PAGE);
    const groups = GROUP_ORDER.filter((g) => ps.some((p) => p.group === g));
    packed.push({ group: groups[0], groups, label: groups.map((g) => GROUP_LABEL[g]).join(" · "), part: "", params: ps });
  }
  const count = new Map<string, number>();
  for (const pg of packed) count.set(pg.label, (count.get(pg.label) ?? 0) + 1);
  const seenLabel = new Map<string, number>();
  for (const pg of packed) {
    const n = count.get(pg.label)!;
    if (n < 2) continue;
    const k = (seenLabel.get(pg.label) ?? 0) + 1;
    seenLabel.set(pg.label, k);
    pg.part = `${k}/${n}`;
  }
  pages.push(...packed);
  const byName = new Map(params.map((p) => [p.name.toLowerCase(), p]));
  const byOffset = new Map<number, Param>();
  for (const p of params) for (const s of p.slots) {
    byOffset.set(s.coarse.offset, p);
    if (s.fine) byOffset.set(s.fine.offset, p);
  }
  return { params, pages, byName, byOffset, excluded: excluded.sort((a, b) => a - b), hidden: hidden.sort((a, b) => a - b), noIntensity: !main[2] };
}

/** "Shutters 1/3", "Colour". */
export const pageTitle = (p: Page): string => (p.part ? `${p.label} ${p.part}` : p.label);

/** The parameter of another fixture's model that "the same knob" drives: same name (case-insensitive), or none. */
export const sameParam = (model: FixtureModel, p: Param): Param | undefined => model.byName.get(p.name.toLowerCase());
