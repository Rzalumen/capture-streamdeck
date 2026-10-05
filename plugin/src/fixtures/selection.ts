/**
 * Which fixture(s) the attribute dials and the Home key act on (v0.7.2): only the fixtures Capture selected (FixtureSelection) during
 * the current Deck Control ON connection, narrowed to the controllable ones (type parsed safely + an address). There is no fallback
 * fixture: with nothing selected the dials and Home move nothing and the strip reads "Click a light / in Capture". An empty selection
 * in Capture clears; Deck Control OFF and the persistent connection closing clear too (FixtureService.onLinkClosed), so no selection
 * carries over from an earlier connection. The Select dial / Next Fixture key still pick one fixture by hand (an explicit choice)
 * until Capture's next click.
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
  /** Selected fixtures that cannot be driven (no address, type not parsed, address problem). */
  uncontrollable: number;
}

const modelOf = (f: ShowFixture): string => f.name || "Fixture";

export class Selection {
  private deckKeys: string[] = [];

  constructor(
    private all: () => ShowFixture[],
    private list: () => Controllable[],
  ) {}

  /** Capture's FixtureSelection, already mapped to fixture keys (selection order). An empty list clears. */
  onCapture(keys: string[]): void {
    this.deckKeys = [...keys];
  }

  /** LeaveShow / a different show / Deck Control OFF / the persistent connection closed: nothing selected any more. */
  clear(): void {
    this.deckKeys = [];
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
  }

  view(): SelectionView {
    const ctl = this.list();
    const known = new Map(this.all().map((f) => [f.key, f]));
    const keys = this.deckKeys.filter((k) => known.has(k));
    // nothing selected in Capture (in this connection): no fallback fixture, nothing is driven
    if (!keys.length) return { targets: [], line1: "Click a light", line2: "in Capture", note: "", mark: "", count: ctl.length, uncontrollable: 0 };
    const byKey = new Map(ctl.map((c) => [c.fixture.key, c]));
    const targets = keys.map((k) => byKey.get(k)).filter((c): c is Controllable => !!c);
    const uncontrollable = keys.length - targets.length;
    const first = targets[0];
    const join = (...p: string[]): string => p.filter(Boolean).join(" · ");
    if (!first) {
      const f = known.get(keys[0]) as ShowFixture;
      const hint = f.channel === 0 ? positionShort(f.position) : `Ch ${f.channel}`;
      return {
        targets: [],
        line1: keys.length > 1 ? `${keys.length} fixtures` : modelOf(f),
        line2: "No address — Setup",
        note: keys.length === 1 ? hint : "",
        mark: "",
        count: ctl.length,
        uncontrollable,
      };
    }
    const f = first.fixture;
    const addr = `${first.addr.universe}/${first.addr.address}`;
    const sameModel = targets.every((t) => t.fixture.typeKey === f.typeKey);
    const line1 = targets.length > 1 ? (sameModel ? `${modelOf(f)} ×${targets.length}` : `${targets.length} fixtures`) : modelOf(f);
    const extra = targets.length > 1 ? ` +${targets.length - 1}` : "";
    const line2 = f.channel === 0 ? `${positionShort(f.position)}${extra}` : `Ch ${f.channel}${targets.length > 1 ? extra : ` · ${addr}`}`;
    const note = join(f.channel === 0 && targets.length === 1 ? addr : "", uncontrollable ? `${uncontrollable} without address` : "");
    const index = ctl.findIndex((c) => c.fixture.key === f.key);
    return { primary: first, targets, line1, line2, note, mark: targets.length > 1 ? `×${targets.length}` : `${index + 1}/${ctl.length}`, count: ctl.length, uncontrollable };
  }
}
