/**
 * Wires the CITP session to the show model, the identification and the fixture service. Pure plumbing: every decision lives in the
 * class it calls.
 */
import { UNIDENTIFIED } from "./citp.js";
import type { CitpSession } from "./citpSession.js";
import { IdentifyPlanner } from "./identify.js";
import type { FixtureService } from "./service.js";
import type { ShowModel } from "./show.js";

export const VERIFY_AFTER_MS = 2000;

export class CitpLink {
  readonly planner: IdentifyPlanner;
  private verify: NodeJS.Timeout | undefined;

  constructor(
    private session: CitpSession,
    private show: ShowModel,
    private svc: FixtureService,
    private log: (s: string) => void,
    planner = new IdentifyPlanner(),
    private verifyMs = VERIFY_AFTER_MS,
  ) {
    this.planner = planner;
  }

  start(): void {
    const { session, show, svc } = this;
    session.on("state", (c, reason) => {
      show.setConnected(c, reason);
      if (!c) {
        this.planner.reset();
        show.pendingIds = new Map();
      }
    });
    session.on("show", (name) => {
      const changed = show.setShowName(name);
      if (changed) svc.onShowGone(`a different show was entered ("${name ?? ""}")`);
    });
    session.on("leave", () => {
      show.clear();
      this.planner.reset();
      svc.onShowGone("Capture left the show");
    });
    session.on("list", (e) => {
      show.applyList(e.type, e.fixtures);
      void this.identify();
    });
    session.on("selection", (ids) => svc.onSelectionEvent(ids));
    session.on("modify", (items) => void svc.onModify(items));
    session.on("remove", (ids) => {
      show.remove(ids);
      svc.onRemoved();
    });
    session.start();
  }

  async stop(): Promise<void> {
    if (this.verify) clearTimeout(this.verify);
    await this.session.stop();
  }

  /** Identify what is still at 0xffffffff (the merged list), log the counts, ask for a verifying list shortly after. */
  private async identify(): Promise<void> {
    const all = this.show.rawFixtures();
    const plan = this.planner.plan(all);
    this.show.pendingIds = this.planner.pendingIds();
    if (plan.confirmed || plan.mismatched) this.log(`identify: Capture confirmed ${plan.confirmed} identifier(s)${plan.mismatched ? `, ${plan.mismatched} differ from what we sent (Capture's own is used)` : ""}`);
    if (!plan.items.length) {
      if (plan.skipped) this.log(`identify: ${plan.skipped} fixture(s) left unidentified (no CaptureInstanceId, or retries used up)`);
      return;
    }
    const allowed = new Set(all.filter((f) => f.identifier === UNIDENTIFIED).flatMap((f) => f.ids.filter((d) => d.type === 0x04 && d.guidRaw).map((d) => d.guidRaw as string)));
    const lo = Math.min(...plan.items.map((i) => i.identifier));
    const hi = Math.max(...plan.items.map((i) => i.identifier));
    this.log(`identify: ${plan.existing} of ${plan.total} fixture(s) already have an identifier; sending ${plan.items.length} new (${lo}–${hi})${plan.skipped ? `, ${plan.skipped} cannot be identified` : ""}`);
    const n = await this.session.identify(plan.items, allowed);
    if (!n) return;
    this.planner.sent(plan.items.slice(0, plan.items.length));
    this.show.pendingIds = this.planner.pendingIds();
    if (this.verify) clearTimeout(this.verify);
    this.verify = setTimeout(() => this.session.requestList(), this.verifyMs);
    this.verify.unref?.();
  }
}
