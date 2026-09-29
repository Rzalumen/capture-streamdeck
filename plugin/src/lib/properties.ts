/**
 * Capture view properties settable over OSC.
 *
 * Source of truth: Capture 2026 manual, Appendix §21.4.3 "OSC"
 *   https://www.capture.se/Manual/en-UK/2026/Appendix.html
 * cross-checked against the confirmed table in handoff 07 (bitfocus/companion-module-capture-visualiser, MIT).
 *
 * Where the two disagree the MANUAL WINS:
 *   - bloom        manual [0..2] (0-200 %)   table said 0..1
 *   - fillLighting manual [0..2] (0-200 %)   table said 0..1
 * Additional properties documented by the manual and absent from the table:
 *   contrast, saturation, flare, flareStreaks (int), flareAngle, flareSize.
 *
 * Capture has NO getters for these (values cannot be read back), so the plugin tracks last-sent values.
 * `reset` values are the plugin's own neutral defaults, NOT Capture's defaults (the manual doesn't state them).
 */
import { oscBool, oscF, oscI, type OscArg } from "./osc.js";

export type ViewId = "live" | "0" | "1" | "2";
export const VIEW_IDS: ViewId[] = ["live", "0", "1", "2"];
export const VIEW_LABEL: Record<ViewId, string> = { live: "Live view", "0": "Alpha", "1": "Beta", "2": "Gamma" };

export type Unit = "percent" | "ev" | "kelvin" | "degrees" | "count";

export interface NumberProperty {
  kind: "number";
  id: string;
  label: string;
  short: string;
  min: number;
  max: number;
  /** "f" = float32, "i" = int32 (wire type). */
  wire: "f" | "i";
  unit: Unit;
  /** Default step per dial tick, in native units. */
  step: number;
  /** Plugin default for the reset value (native units). */
  reset: number;
}

export interface BoolProperty {
  kind: "bool";
  id: string;
  label: string;
  short: string;
}

export type Property = NumberProperty | BoolProperty;

const N = (p: Omit<NumberProperty, "kind">): NumberProperty => ({ kind: "number", ...p });

export const NUMBER_PROPERTIES: NumberProperty[] = [
  N({ id: "exposureAdjustment", label: "Exposure", short: "EXPOSURE", min: -3, max: 3, wire: "f", unit: "ev", step: 0.1, reset: 0 }),
  N({ id: "ambientLighting", label: "Ambient", short: "AMBIENT", min: 0, max: 1, wire: "f", unit: "percent", step: 0.02, reset: 0.5 }),
  N({ id: "bloom", label: "Bloom", short: "BLOOM", min: 0, max: 2, wire: "f", unit: "percent", step: 0.04, reset: 1 }),
  N({ id: "whiteBalance", label: "White Balance", short: "WHITE BAL", min: 2500, max: 10000, wire: "f", unit: "kelvin", step: 100, reset: 6500 }),
  N({ id: "fillLighting", label: "Fill", short: "FILL", min: 0, max: 2, wire: "f", unit: "percent", step: 0.04, reset: 1 }),
  N({ id: "hueClamp", label: "Hue Clamp", short: "HUE CLAMP", min: 0, max: 1, wire: "f", unit: "percent", step: 0.02, reset: 0.5 }),
  N({ id: "contrast", label: "Contrast", short: "CONTRAST", min: 0, max: 1, wire: "f", unit: "percent", step: 0.02, reset: 0.5 }),
  N({ id: "saturation", label: "Saturation", short: "SATURATION", min: 0, max: 1, wire: "f", unit: "percent", step: 0.02, reset: 0.5 }),
  N({ id: "flare", label: "Flare", short: "FLARE", min: 0, max: 2, wire: "f", unit: "percent", step: 0.04, reset: 1 }),
  N({ id: "flareSize", label: "Flare Size", short: "FLARE SIZE", min: 0, max: 2, wire: "f", unit: "percent", step: 0.04, reset: 1 }),
  N({ id: "flareAngle", label: "Flare Angle", short: "FLARE ANGLE", min: 0, max: 180, wire: "f", unit: "degrees", step: 5, reset: 0 }),
  N({ id: "flareStreaks", label: "Flare Streaks", short: "STREAKS", min: 1, max: 7, wire: "i", unit: "count", step: 1, reset: 4 }),
];

export const BOOL_PROPERTIES: BoolProperty[] = [
  { kind: "bool", id: "automaticExposure", label: "Auto Exposure", short: "AUTO EXP" },
  { kind: "bool", id: "laserFlickerEffect", label: "Laser Flicker", short: "LASER" },
];

export const PROPERTIES: Property[] = [...NUMBER_PROPERTIES, ...BOOL_PROPERTIES];

export function findProperty(id: string): Property | undefined {
  return PROPERTIES.find((p) => p.id === id);
}
export function findNumberProperty(id: string): NumberProperty | undefined {
  const p = findProperty(id);
  return p?.kind === "number" ? p : undefined;
}
export function findBoolProperty(id: string): BoolProperty | undefined {
  const p = findProperty(id);
  return p?.kind === "bool" ? p : undefined;
}

export function normaliseView(v: unknown): ViewId {
  const s = String(v ?? "live");
  return (VIEW_IDS as string[]).includes(s) ? (s as ViewId) : "live";
}

export function viewAddress(view: ViewId, property: string): string {
  return `/view/${view}/${property}`;
}

// ---------------------------------------------------------------- maths

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function decimalsOf(x: number): number {
  if (!Number.isFinite(x) || Number.isInteger(x)) return 0;
  const s = x.toString();
  if (s.includes("e-")) return parseInt(s.split("e-")[1], 10) + (s.split("e-")[0].split(".")[1]?.length ?? 0);
  return s.split(".")[1]?.length ?? 0;
}

export const FINE_DIVISOR = 10;

/**
 * New value after `ticks` dial ticks: value + ticks × step (÷10 in fine mode), clamped to the
 * property's range and rounded to the step's precision to avoid float drift (0.1+0.2…).
 * Integer properties always round to whole numbers and never step by less than 1.
 */
export function applyTicks(p: NumberProperty, value: number, ticks: number, step: number, fine: boolean): number {
  let eff = fine ? step / FINE_DIVISOR : step;
  if (p.wire === "i") eff = Math.max(1, Math.round(step));
  const raw = value + ticks * eff;
  const rounded = p.wire === "i" ? Math.round(raw) : Number(raw.toFixed(Math.min(8, decimalsOf(eff) + 1)));
  return clamp(rounded, p.min, p.max);
}

export function clampToProperty(p: NumberProperty, v: number): number {
  return p.wire === "i" ? clamp(Math.round(v), p.min, p.max) : clamp(v, p.min, p.max);
}

/** 0..1 position within the range, for the touch-strip bar. */
export function fraction(p: NumberProperty, v: number): number {
  return (clamp(v, p.min, p.max) - p.min) / (p.max - p.min);
}

export function formatValue(p: NumberProperty, v: number): { value: string; unit: string } {
  switch (p.unit) {
    case "percent":
      return { value: String(Math.round(v * 100)), unit: "%" };
    case "ev":
      return { value: (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1), unit: "EV" };
    case "kelvin":
      return { value: String(Math.round(v)), unit: "K" };
    case "degrees":
      return { value: String(Math.round(v)), unit: "°" };
    default:
      return { value: String(Math.round(v)), unit: "" };
  }
}

// ---------------------------------------------------------------- OSC arg builders

/** OSC arguments for a numeric property. Floats are ALWAYS `f`, even for whole numbers. */
export function numberArgs(p: NumberProperty, v: number): OscArg[] {
  const c = clampToProperty(p, v);
  return [p.wire === "i" ? oscI(c) : oscF(c)];
}

export function boolArgs(on: boolean): OscArg[] {
  return [oscBool(on)];
}

/**
 * `/view/<view>/position` arguments: catalog (i), position (i), then optionally time (f 0–600 s),
 * damp (f 0–1, only with time) and curve (f 0–1, only with time and damp).
 * Manual §21.4.3: catalogNr and positionNr range 1–255.
 */
export interface RecallOptions {
  time?: number;
  damp?: number;
  curve?: number;
}
export function positionArgs(catalog: number, position: number, o: RecallOptions = {}): OscArg[] {
  const args: OscArg[] = [oscI(clamp(Math.round(catalog), 1, 255)), oscI(clamp(Math.round(position), 1, 255))];
  const hasTime = o.time !== undefined && Number.isFinite(o.time);
  if (!hasTime) return args;
  args.push(oscF(clamp(o.time as number, 0, 600)));
  const hasDamp = o.damp !== undefined && Number.isFinite(o.damp);
  if (!hasDamp) return args;
  args.push(oscF(clamp(o.damp as number, 0, 1)));
  const hasCurve = o.curve !== undefined && Number.isFinite(o.curve);
  if (hasCurve) args.push(oscF(clamp(o.curve as number, 0, 1)));
  return args;
}
