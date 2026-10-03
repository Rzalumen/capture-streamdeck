/**
 * Which fixture(s) the attribute dials and the Home key act on (v0.5): the fixtures selected in Capture (FixtureSelection), narrowed to
 * the controllable ones (type parsed safely + an address). The Select dial still picks one fixture by hand until Capture's next click.
 * An empty selection in Capture keeps the last deck selection, marked "(not selected in Capture)".
 */
import type { ChannelMap } from "./attrs.js";
import type { FixtureModel } from "./pages.js";
import type { Target } from "./engine.js";
import type { Address } from "./setup.js";
import { positionShort, type ShowFixture } from "./show.js";

export interface Controllable {
  fixture: ShowFixture;
  map: ChannelMap;
  model: FixtureModel;
  addr: Address;
}
export const toTarget = (c: Controllable): Target => ({ key: c.fixture.key, universe: c.addr.universe, address: c.addr.address, map: c.map, model: c.model });

export const STALE_NOTE = "(not selected in Capture)";

export interface SelectionView {
  /** The first controllable selected fixture (undefined when none is controllable). */
  primary?: Controllable;
  /** What the attribute dials and Home act on: the selected fixtures that are controllable. */
  targets: Controllable[];
  /** Strip text: model; `Ch 203 · 1/285` (or the position hint when the Capture Channel is 0); small note line. */
  line1: string;
  line2: string;
  note: string;
  /** Top right of the strip: `2/5` (place among the controllable fixtures), `×3` for several, "" for none. */
  mark: string;
  /** Number of controllable fixtures (for the mark). */
  count: number;
  /** Capture's selection was emptied: this is the last selection, no longer selected there. */
  stale: boolean;
  /** Selected fixtures that cannot be driven (no address, type not parsed, address problem). */
  uncontrollable: number;
}

const modelOf = (f: ShowFixture): string => f.name || "Fixture";

export class Selection {
  private deckKeys: string[] = [];
  stale = false;

  constructor(
    private all: () => ShowFixture[],
    private list: () => Controllable[],
  ) {}

  /** Capture's FixtureSelection, already mapped to fixture keys (selection order). An empty list keeps the last selection, marked stale. */
  onCapture(keys: string[]): void {
    if (!keys.length) {
      if (this.deckKeys.length) this.stale = true;
      return;
    }
    this.deckKeys = [...keys];
    this.stale = false;
  }

  /** LeaveShow / a different show: nothing selected any more. */
  clear(): void {
    this.deckKeys = [];
    this.stale = false;
  }

  get keys(): string[] {
    return [...this.deckKeys];
  }

  /** Select dial: choose one controllable fixture by hand (wraps around). Capture's next click overrides it. */
  step(ticks: number): void {
    const ctl = this.list();
    if (!ctl.length || !ticks) return;
    const cur = this.view().primary;
    const i = cur ? ctl.findIndex((c) => c.fixture.key === cur.fixture.key) : -1;
    const n = ctl.length;
    const to = i < 0 ? (ticks > 0 ? ticks - 1 : n + ticks) : i + ticks;
    this.deckKeys = [ctl[((to % n) + n) % n].fixture.key];
    this.stale = false;
  }

  view(): SelectionView {
    const ctl = this.list();
    const known = new Map(this.all().map((f) => [f.key, f]));
    let keys = this.deckKeys.filter((k) => known.has(k));
    let stale = this.stale;
    if (!keys.length) {
      // nothing selected yet: the first controllable fixture, so the knobs work before the first click in Capture
      if (!ctl.length) return { targets: [], line1: "No fixture", line2: "Select one in Capture", note: "", mark: "", count: 0, stale: false, uncontrollable: 0 };
      keys = [ctl[0].fixture.key];
      stale = false;
    }
    const byKey = new Map(ctl.map((c) => [c.fixture.key, c]));
    const targets = keys.map((k) => byKey.get(k)).filter((c): c is Controllable => !!c);
    const uncontrollable = keys.length - targets.length;
    const first = targets[0];
    const staleNote = stale ? STALE_NOTE : "";
    const join = (...p: string[]): string => p.filter(Boolean).join(" · ");
    if (!first) {
      const f = known.get(keys[0]) as ShowFixture;
      const hint = f.channel === 0 ? positionShort(f.position) : `Ch ${f.channel}`;
      return {
        targets: [],
        line1: keys.length > 1 ? `${keys.length} fixtures` : modelOf(f),
        line2: "No address — Setup",
        note: join(keys.length === 1 ? hint : "", staleNote),
        mark: "",
        count: ctl.length,
        stale,
        uncontrollable,
      };
    }
    const f = first.fixture;
    const addr = `${first.addr.universe}/${first.addr.address}`;
    const sameModel = targets.every((t) => t.fixture.typeKey === f.typeKey);
    const line1 = targets.length > 1 ? (sameModel ? `${modelOf(f)} ×${targets.length}` : `${targets.length} fixtures`) : modelOf(f);
    const extra = targets.length > 1 ? ` +${targets.length - 1}` : "";
    const line2 = f.channel === 0 ? `${positionShort(f.position)}${extra}` : `Ch ${f.channel}${targets.length > 1 ? extra : ` · ${addr}`}`;
    const note = join(f.channel === 0 && targets.length === 1 ? addr : "", uncontrollable ? `${uncontrollable} without address` : "", staleNote);
    const index = ctl.findIndex((c) => c.fixture.key === f.key);
    return { primary: first, targets, line1, line2, note, mark: targets.length > 1 ? `×${targets.length}` : `${index + 1}/${ctl.length}`, count: ctl.length, stale, uncontrollable };
  }
}
