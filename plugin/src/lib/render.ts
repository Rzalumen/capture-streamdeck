import { ICONS } from "./icons.js";

/** Look (handoff 07). */
export const COLORS = {
  bg: "#121417",
  text: "#E8E8E8",
  accent: "#F5B82E",
  red: "#E5484D",
  track: "#2A2E33",
} as const;

/** Blend `fg` over `bg` at `alpha` (used to get "35 % opacity" on surfaces that can't do opacity). */
export function mix(fg: string, bg: string, alpha: number): string {
  const p = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = (i: number): string =>
    Math.round(p(fg, i) * alpha + p(bg, i) * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  return `#${c(0)}${c(1)}${c(2)}`.toUpperCase();
}

export const DIM_ALPHA = 0.35;

export type Tone = "normal" | "accent" | "red";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FONT = "-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif";
const KEY = 144;

/** Rough text width (px) at font-size 1 for bold UI text; conservative on purpose. */
const charW = 0.58;

export interface LabelLayout {
  lines: string[];
  size: number;
}

/** Fit a label into `width` px: try one line at 22→14 px, then wrap on spaces onto two lines. */
export function layoutLabel(label: string, width = 128): LabelLayout {
  const text = label.trim();
  const fits = (s: string, size: number): boolean => s.length * size * charW <= width;
  for (const size of [22, 20, 18, 16]) if (fits(text, size)) return { lines: [text], size };
  const words = text.split(/\s+/);
  if (words.length > 1) {
    for (const size of [20, 18, 16, 14]) {
      let best: string[] | undefined;
      for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(" ");
        const b = words.slice(i).join(" ");
        if (fits(a, size) && fits(b, size)) {
          if (!best || Math.abs(a.length - b.length) < Math.abs(best[0].length - best[1].length)) best = [a, b];
        }
      }
      if (best) return { lines: best, size };
    }
  }
  const size = 14;
  const max = Math.floor(width / (size * charW));
  if (words.length > 1) {
    const a = words.slice(0, Math.ceil(words.length / 2)).join(" ");
    const b = words.slice(Math.ceil(words.length / 2)).join(" ");
    const cut = (s: string): string => (s.length > max ? s.slice(0, max - 1) + "…" : s);
    return { lines: [cut(a), cut(b)], size };
  }
  return { lines: [text.length > max ? text.slice(0, max - 1) + "…" : text], size };
}

export interface KeyOptions {
  icon: string;
  label: string;
  tone?: Tone;
  /** 35 % opacity (disabled command / offline). */
  dim?: boolean;
  /** Small text in the top-right corner (e.g. "~", "STORE"). */
  badge?: string;
  /** Highlight ring (held / toggled on). */
  active?: boolean;
  /** Replace the icon with big text (e.g. "Hold", "Error"). */
  big?: string;
}

/** 144×144 key image as an SVG string. */
export function keySvg(o: KeyOptions): string {
  const tone = o.tone ?? "normal";
  const fg = tone === "red" ? COLORS.red : tone === "accent" ? COLORS.accent : COLORS.text;
  const inner = ICONS[o.icon] ?? ICONS.command;
  const { lines, size } = layoutLabel(o.label);
  const ty = lines.length === 1 ? 124 : 110;
  const text = lines
    .map(
      (l, i) =>
        `<text x="72" y="${ty + i * (size + 2)}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="600" fill="${fg}">${esc(l)}</text>`,
    )
    .join("");
  const iconY = lines.length === 1 ? 18 : 12;
  const bigSize = o.big ? Math.max(14, Math.min(30, Math.floor(128 / (o.big.length * charW)))) : 0;
  const body = o.big
    ? `<text x="72" y="${lines.length === 1 ? 68 : 60}" text-anchor="middle" font-family="${FONT}" font-size="${bigSize}" font-weight="700" fill="${fg}">${esc(o.big)}</text>`
    : `<g transform="translate(${72 - 32} ${iconY}) scale(${64 / 24})" fill="none" stroke="${fg}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
  const ring = o.active ? `<rect x="5" y="5" width="134" height="134" rx="14" fill="none" stroke="${COLORS.accent}" stroke-width="4"/>` : "";
  const badge = o.badge
    ? `<text x="134" y="24" text-anchor="end" font-family="${FONT}" font-size="20" font-weight="700" fill="${COLORS.accent}">${esc(o.badge)}</text>`
    : "";
  const g = o.dim ? ` opacity="${DIM_ALPHA}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY}" height="${KEY}" viewBox="0 0 ${KEY} ${KEY}"><rect width="${KEY}" height="${KEY}" fill="${COLORS.bg}"/><g${g}>${ring}${body}${text}${badge}</g></svg>`;
}

export const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
export const keyImage = (o: KeyOptions): string => svgDataUrl(keySvg(o));

// ------------------------------------------------------------------ touch strip (200 × 100)

export interface StripState {
  name: string;
  value: string;
  unit: string;
  /** 0..1 */
  fraction: number;
  fine: boolean;
  /** true until a value has been sent this session → greyed, with "~" */
  estimated: boolean;
  offline: boolean;
}

/** Feedback payload for layouts/dial.json (item keys: bg, name, value, unit, bar, mark). */
export function stripFeedback(s: StripState): Record<string, unknown> {
  const grey = mix(COLORS.text, COLORS.bg, 0.5);
  const dimText = mix(COLORS.text, COLORS.bg, DIM_ALPHA);
  const dimAccent = mix(COLORS.accent, COLORS.bg, DIM_ALPHA);
  const nameColor = s.offline ? dimAccent : COLORS.accent;
  const valueColor = s.offline ? dimText : s.estimated ? grey : COLORS.text;
  const barColor = s.offline || s.estimated ? dimAccent : COLORS.accent;
  const mark = s.offline ? "Offline" : s.fine ? "FINE" : s.estimated ? "~" : "";
  return {
    name: { value: s.name, color: nameColor },
    value: { value: s.estimated && !s.offline ? `~${s.value}` : s.value, color: valueColor },
    unit: { value: s.unit, color: s.offline ? dimText : grey },
    bar: { value: Math.round(Math.min(1, Math.max(0, s.fraction)) * 100), bar_fill_c: barColor },
    mark: { value: mark, color: s.offline ? COLORS.red : COLORS.accent },
  };
}

// ------------------------------------------------------------------ connection key

export interface ConnectionView {
  connected: boolean;
  version?: string;
  /** Result of the last Accessibility call. */
  ax: "unknown" | "ok" | "noPermission" | "noAutomation" | "notRunning" | "error";
  /** Median osascript latency, ms. */
  latencyMs?: number;
  checking?: boolean;
  /** Line for the last `getStatus` answer, e.g. "Live: Alpha". */
  live?: string;
}

export function axLine(ax: ConnectionView["ax"]): { text: string; tone: Tone } {
  switch (ax) {
    case "ok":
      return { text: "Access OK", tone: "normal" };
    case "noPermission":
    case "noAutomation":
      return { text: "Allow Access", tone: "red" };
    case "notRunning":
      return { text: "Capture?", tone: "red" };
    case "error":
      return { text: "AX Error", tone: "red" };
    default:
      return { text: "Access ?", tone: "normal" };
  }
}

export function connectionSvg(v: ConnectionView): string {
  const grey = mix(COLORS.text, COLORS.bg, 0.6);
  const head = v.checking ? "Checking…" : v.connected ? "Connected" : "Offline";
  const headColor = v.checking ? COLORS.text : v.connected ? COLORS.accent : COLORS.red;
  const sub = v.connected ? (v.live ?? (v.version ? `v${v.version}` : "")) : "OSC 4004";
  const ax = axLine(v.ax);
  const axColor = ax.tone === "red" ? COLORS.red : grey;
  const axText = v.latencyMs !== undefined && v.ax === "ok" ? `${ax.text} ${Math.round(v.latencyMs)}ms` : ax.text;
  const inner = ICONS.connection;
  const t = (y: number, size: number, color: string, s: string, w = 600): string =>
    `<text x="72" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="${w}" fill="${color}">${esc(s)}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY}" height="${KEY}" viewBox="0 0 ${KEY} ${KEY}"><rect width="${KEY}" height="${KEY}" fill="${COLORS.bg}"/>` +
    `<g transform="translate(52 12) scale(${40 / 24})" fill="none" stroke="${v.connected ? COLORS.accent : COLORS.red}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</g>` +
    t(80, 21, headColor, head, 700) +
    t(104, 16, grey, sub, 500) +
    t(128, axText.length > 14 ? 13 : 15, axColor, axText, 600) +
    `</svg>`
  );
}

// ------------------------------------------------------------------ fixtures (v0.4)

export interface FixtureStripState {
  name: string;
  /** 0..1, or null → "—" (the fixture lacks the attribute / nothing selected). */
  value: number | null;
  fine: boolean;
  /** Acting on every fixture of the selected type. */
  all: boolean;
  /** The value shown is the starting value; nothing has been sent for this fixture yet. */
  untouched: boolean;
}

/** Feedback for layouts/dial.json on the fixture attribute dials: name, value in %, bar, marks ALL / FINE / ~. */
export function fixtureStripFeedback(s: FixtureStripState): Record<string, unknown> {
  const grey = mix(COLORS.text, COLORS.bg, 0.5);
  if (s.value === null) {
    const dim = mix(COLORS.text, COLORS.bg, DIM_ALPHA);
    return {
      name: { value: s.name, color: mix(COLORS.accent, COLORS.bg, DIM_ALPHA) },
      value: { value: "—", color: dim },
      unit: { value: "", color: dim },
      bar: { value: 0, bar_fill_c: mix(COLORS.accent, COLORS.bg, DIM_ALPHA) },
      mark: { value: s.all ? "ALL" : "", color: COLORS.accent },
    };
  }
  const pct = (Math.round(s.value * 1000) / 10).toFixed(1);
  const marks = [s.all ? "ALL" : "", s.fine ? "FINE" : "", s.untouched && !s.all && !s.fine ? "~" : ""].filter(Boolean).join(" ");
  return {
    name: { value: s.name, color: COLORS.accent },
    value: { value: s.untouched ? `~${pct}` : pct, color: s.untouched ? grey : COLORS.text },
    unit: { value: "%", color: grey },
    bar: { value: Math.round(Math.min(1, Math.max(0, s.value)) * 100), bar_fill_c: s.untouched ? mix(COLORS.accent, COLORS.bg, DIM_ALPHA) : COLORS.accent },
    mark: { value: marks, color: COLORS.accent },
  };
}

/** Feedback for layouts/select.json. */
export function selectStripFeedback(s: { line1: string; line2: string; mode: "single" | "type"; index: number; count: number }): Record<string, unknown> {
  const grey = mix(COLORS.text, COLORS.bg, 0.5);
  const none = s.count === 0;
  return {
    name: { value: "FIXTURE", color: COLORS.accent },
    mark: { value: none ? "" : `${s.mode === "type" ? "ALL · " : ""}${s.index + 1}/${s.count}`, color: COLORS.accent },
    line1: { value: s.line1, color: none ? grey : COLORS.text },
    line2: { value: s.line2, color: grey },
  };
}

export interface FixtureStatusView {
  /** "ok" once a show was read; "syncing" while reading; "error" / "idle" otherwise. */
  sync: "idle" | "syncing" | "ok" | "error";
  showName: string | null;
  controllable: number;
  fixtures: number;
  active: boolean;
  universes: number[];
}

/** The Fixtures: Status key (144×144): show name, controllable count, output state (with the blackout reminder while output is on). */
export function fixtureStatusSvg(v: FixtureStatusView): string {
  const grey = mix(COLORS.text, COLORS.bg, 0.6);
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const t = (y: number, size: number, color: string, s: string, w = 600): string =>
    `<text x="72" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="${w}" fill="${color}">${esc(s)}</text>`;
  let head: string;
  let headColor: string = COLORS.text;
  if (v.sync === "syncing") head = "Reading…";
  else if (v.sync === "ok") head = clip(v.showName ?? "(unnamed show)", 13);
  else {
    head = v.sync === "error" ? "No show" : "Not read";
    headColor = COLORS.red;
  }
  const count = v.sync === "ok" || v.fixtures ? `${v.controllable} of ${v.fixtures} ready` : "press to read";
  const out = v.active ? `OUTPUT ON  U${v.universes.join(",")}` : "output off";
  const warn = v.active ? t(130, 11, COLORS.red, "rest of the universe = 0", 500) : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY}" height="${KEY}" viewBox="0 0 ${KEY} ${KEY}"><rect width="${KEY}" height="${KEY}" fill="${COLORS.bg}"/>` +
    `<g transform="translate(54 8) scale(${36 / 24})" fill="none" stroke="${v.active ? COLORS.accent : grey}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS["fx-status"]}</g>` +
    t(68, 17, headColor, head, 700) +
    t(90, 15, grey, count, 500) +
    t(112, out.length > 16 ? 13 : 15, v.active ? COLORS.accent : grey, out, 700) +
    warn +
    `</svg>`
  );
}
