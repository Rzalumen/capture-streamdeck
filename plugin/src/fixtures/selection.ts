/** Which fixture(s) the attribute dials act on: one controllable fixture, or every controllable fixture of its type. */
import type { ChannelMap } from "./attrs.js";
import type { Target } from "./engine.js";
import type { Address } from "./setup.js";
import type { ShowFixture } from "./show.js";

export interface Controllable {
  fixture: ShowFixture;
  map: ChannelMap;
  addr: Address;
}
export const toTarget = (c: Controllable): Target => ({ key: c.fixture.key, universe: c.addr.universe, address: c.addr.address, map: c.map });

export type SelectMode = "single" | "type";

export interface SelectionView {
  mode: SelectMode;
  /** The fixture the Select dial is on (undefined when nothing is controllable). */
  primary?: Controllable;
  /** What the attribute dials act on: just the primary, or every controllable fixture of its type. */
  targets: Controllable[];
  /** Strip text: `Rogue R2X Wash` / `Ch 203 · 1/285`, or `All Rogue R2X Wash` / `4 fixtures`. */
  line1: string;
  line2: string;
}

export class Selection {
  private selKey: string | undefined;
  mode: SelectMode = "single";
  constructor(private list: () => Controllable[]) {}

  private resolve(): { list: Controllable[]; index: number } {
    const list = this.list();
    let index = list.findIndex((c) => c.fixture.key === this.selKey);
    if (index < 0) {
      index = 0;
      this.selKey = list[0]?.fixture.key;
    }
    return { list, index };
  }

  /** Rotate: step through the controllable fixtures (wraps around). */
  step(ticks: number): void {
    const { list, index } = this.resolve();
    if (!list.length || !ticks) return;
    const n = list.length;
    this.selKey = list[(((index + ticks) % n) + n) % n].fixture.key;
  }

  /** Push: single ↔ all of this type. */
  toggle(): void {
    this.mode = this.mode === "single" ? "type" : "single";
  }

  view(): SelectionView {
    const { list, index } = this.resolve();
    const primary = list[index];
    if (!primary) return { mode: this.mode, targets: [], line1: "No fixture", line2: "Fixtures: Setup" };
    if (this.mode === "type") {
      const targets = list.filter((c) => c.fixture.typeKey === primary.fixture.typeKey);
      return { mode: "type", primary, targets, line1: `All ${primary.fixture.name}`, line2: `${targets.length} fixture${targets.length === 1 ? "" : "s"}` };
    }
    return { mode: "single", primary, targets: [primary], line1: primary.fixture.name, line2: `Ch ${primary.fixture.channel} · ${primary.addr.universe}/${primary.addr.address}` };
  }
}
