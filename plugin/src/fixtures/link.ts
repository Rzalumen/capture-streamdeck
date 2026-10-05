/**
 * Wires the CITP session to the show model, the identification and the fixture service. Pure plumbing: every decision lives in the
 * class it calls.
 *
 * v0.10.0 (Handoff 28): the persistent session is opened at plugin start (`startPersistent()`), with our EnterShow and the SDMX
 * declaration, and held until plugin exit (`stop()`). The brief connections of v0.7–v0.9 are gone: Setup, Status and the Setup panel
 * ask the held session for a fresh list. Our own disconnect ("quiet", plugin exit) keeps the fixture list and ignores anything Capture
 * says while we close. FixtureLists are passed on to the service with whether they came after our declaration on this connection
 * (only those can carry Capture's patch).
 * v0.11.0 (Handoff 30): every EnterShow tells the service (automatic wake when no output is running); after a declared list is
 * applied the service may run that wake.
 */
import { UNIDENTIFIED } from "./citp.js";
import type { CitpSession } from "./citpSession.js";
import { IdentifyPlanner } from "./identify.js";
import type { FixtureService } from "./service.js";
import type { ShowModel } from "./show.js";

export const VERIFY_AFTER_MS = 2000;

/** "off" until startPersistent() (plugin start), then "on" for the life of the plugin. */
export type LinkMode = "off" | "on";

export class CitpLink {
  readonly planner: IdentifyPlanner;
  private verify: NodeJS.Timeout | undefined;
  mode: LinkMode = "off";
  /** We are closing the connection ourselves: no error state, Capture's messages are ignored. */
  private quiet = false;
  private ops: Promise<void> = Promise.resolve();
  private identifying: Promise<void> = Promise.resolve();
  private attached = false;

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

  /** Subscribes to the session's events (once). Starts nothing: see startPersistent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const { session, show, svc } = this;
    session.on("state", (c, reason) => {
      if (c) show.setConnected(true);
      else if (this.quiet) show.setOffline();
      else show.setConnected(false, reason);
      if (!c) {
        this.planner.reset();
        show.pendingIds = new Map();
      }
      // v0.7.2: the persistent connection closed (Capture quit or reopened, dropped socket): its selection goes with it.
      // `reason` is only set for a failed attempt (never connected).
      if (!c && !reason && this.mode === "on") svc.onLinkClosed("CITP connection closed");
    });
    session.on("show", (name) => {
      if (this.quiet) return;
      const changed = show.setShowName(name);
      if (changed) svc.onShowGone(`a different show was entered ("${name ?? ""}")`);
      svc.onShowEntered(); // v0.11.0: arms the automatic wake when no output is running
    });
    session.on("leave", () => {
      if (this.quiet) return;
      show.clear();
      this.planner.reset();
      svc.onShowGone("Capture left the show");
    });
    session.on("list", (e) => {
      if (this.quiet) return;
      const keyed = show.applyList(e.type, e.fixtures);
      // v0.11.0: a pending automatic wake runs once the declared list's addresses are applied
      void svc.onPatchList(e.type, keyed, e.declared).then(() => svc.afterList(e.type, e.declared));
      this.identifying = this.identify();
    });
    session.on("selection", (ids) => {
      if (!this.quiet) svc.onSelectionEvent(ids);
    });
    session.on("modify", (items) => {
      if (!this.quiet) void svc.onModify(items);
    });
    // v0.8.0: Capture's DMX levels (SDMX ChBk) are used only on the persistent session, never while we close it.
    session.on("levels", (e) => {
      if (this.quiet || this.mode !== "on") return;
      svc.onCaptureLevels(e);
    });
    session.on("remove", (ids) => {
      if (this.quiet) return;
      show.remove(ids);
      svc.onRemoved();
    });
  }

  /** Attach and hold the persistent session (tests). */
  start(): void {
    this.attach();
    void this.startPersistent();
  }

  /** Plugin start (v0.10.0): open the persistent session and keep it until plugin exit. A no-op while it is held. */
  startPersistent(): Promise<void> {
    this.attach();
    this.ops = this.ops.then(async () => {
      if (this.mode === "on") return;
      this.quiet = false;
      this.mode = "on";
      this.session.start();
    });
    return this.ops;
  }

  /** Plugin exit: whatever is open is closed (LeaveShow when we entered). */
  async stop(): Promise<void> {
    if (this.verify) clearTimeout(this.verify);
    this.quiet = true;
    await this.session.stop();
  }

  /** Ask the held session for the list. Returns true when a request went out (connected and in a show). */
  requestList(_why: string): boolean {
    return this.mode === "on" && this.session.requestList();
  }

  /** Try to connect now instead of waiting out the back-off (no-op when connected). */
  reconnect(_why: string): void {
    if (this.mode === "on") this.session.reconnectNow();
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
