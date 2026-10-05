/**
 * Wires the CITP session to the show model, the identification and the fixture service. Pure plumbing: every decision lives in the
 * class it calls.
 *
 * Handoff 21: the session is no longer always on. `startPersistent()` (the first Deck Control arm) runs the v0.6 persistent session;
 * v0.9.0 (Handoff 27): the deck never stops it again (`stopPersistent()` is no longer called by Deck Control; only plugin exit,
 * `stop()`, closes it). Before the first arm, `briefSync()` connects briefly — PNam → EnterShow → FixtureList → FixtureIdentify (0xffffffff only)
 * → LeaveShow → close — and logs how long it took. Our own disconnects ("quiet") keep the fixture list (the show goes offline, not
 * into an error) and ignore anything Capture says while we close.
 */
import { UNIDENTIFIED } from "./citp.js";
import type { CitpSession } from "./citpSession.js";
import { IdentifyPlanner } from "./identify.js";
import type { FixtureService } from "./service.js";
import type { ShowModel } from "./show.js";

export const VERIFY_AFTER_MS = 2000;
/** How long a brief connection waits for Capture's FixtureList before it gives up. */
export const BRIEF_TIMEOUT_MS = 8000;

export type LinkMode = "off" | "brief" | "on";

export class CitpLink {
  readonly planner: IdentifyPlanner;
  private verify: NodeJS.Timeout | undefined;
  mode: LinkMode = "off";
  /** We are closing the connection ourselves: no error state, Capture's messages are ignored. */
  private quiet = false;
  private ops: Promise<void> = Promise.resolve();
  private briefRun: Promise<void> | undefined;
  private briefListWaiter: (() => void) | undefined;
  private identifying: Promise<void> = Promise.resolve();
  private attached = false;
  /** Brief connections so far (tests / log): [why, ms, fixtures]. */
  readonly briefs: { why: string; ms: number; fixtures: number; ok: boolean }[] = [];

  constructor(
    private session: CitpSession,
    private show: ShowModel,
    private svc: FixtureService,
    private log: (s: string) => void,
    planner = new IdentifyPlanner(),
    private verifyMs = VERIFY_AFTER_MS,
    private briefTimeoutMs = BRIEF_TIMEOUT_MS,
  ) {
    this.planner = planner;
  }

  /** Subscribes to the session's events (once). Starts nothing: see briefSync / startPersistent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const { session, show, svc } = this;
    session.on("state", (c, reason) => {
      if (c) show.setConnected(true);
      else if (this.quiet || (this.mode === "brief" && !reason)) show.setOffline();
      else show.setConnected(false, reason);
      if (!c) {
        this.planner.reset();
        show.pendingIds = new Map();
      }
      // v0.7.2: the persistent (ON) connection closed (OFF, Capture quit or reopened, dropped socket): its selection goes with it.
      // `reason` is only set for a failed attempt (never connected); a brief connection ("brief") leaves the selection alone.
      if (!c && !reason && this.mode === "on") svc.onLinkClosed("CITP connection closed");
    });
    session.on("show", (name) => {
      if (this.quiet) return;
      const changed = show.setShowName(name);
      if (changed) svc.onShowGone(`a different show was entered ("${name ?? ""}")`);
    });
    session.on("leave", () => {
      if (this.quiet) return;
      show.clear();
      this.planner.reset();
      svc.onShowGone("Capture left the show");
    });
    session.on("list", (e) => {
      if (this.quiet) return;
      show.applyList(e.type, e.fixtures);
      this.identifying = this.identify();
      const w = this.briefListWaiter;
      this.briefListWaiter = undefined;
      w?.();
    });
    session.on("selection", (ids) => {
      if (!this.quiet) svc.onSelectionEvent(ids);
    });
    session.on("modify", (items) => {
      if (!this.quiet) void svc.onModify(items);
    });
    // v0.8.0: Capture's DMX levels (SDMX ChBk) are used only on the persistent (Deck ON) session, never while we close it.
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

  /** v0.6 behaviour: attach and hold the persistent session (tests / CAPTURE_TEST_PERSISTENT). */
  start(): void {
    this.attach();
    void this.startPersistent();
  }

  /** The first Deck Control arm: the persistent session (after any brief connection in progress). A no-op while it is held. */
  startPersistent(): Promise<void> {
    this.attach();
    this.ops = this.ops.then(async () => {
      await this.briefRun;
      if (this.mode === "on") return;
      this.quiet = false;
      this.mode = "on";
      this.session.start();
    });
    return this.ops;
  }

  /** LeaveShow, close, no reconnect; the fixture list stays (offline). v0.9.0: not used by Deck Control any more (disarm keeps the link). */
  stopPersistent(): Promise<void> {
    this.ops = this.ops.then(async () => {
      if (this.mode !== "on") return;
      if (this.verify) clearTimeout(this.verify);
      this.quiet = true;
      try {
        await this.session.stop();
      } finally {
        this.quiet = false;
        this.mode = "off";
      }
    });
    return this.ops;
  }

  /** Plugin exit: whatever is open is closed (LeaveShow when we entered). */
  async stop(): Promise<void> {
    if (this.verify) clearTimeout(this.verify);
    this.quiet = true;
    await this.session.stop();
  }

  /** Ask for the list: on the persistent session when Deck Control is ON, otherwise a brief connection. Returns true when something went out. */
  requestList(why: string): boolean {
    if (this.mode === "on") return this.session.requestList();
    void this.briefSync(why);
    return true;
  }

  /** Reconnect now when ON; a brief connection when OFF. */
  reconnect(why: string): void {
    if (this.mode === "on") this.session.reconnectNow();
    else void this.briefSync(why);
  }

  /**
   * Read the fixture list (and identify fixtures at 0xffffffff) over a brief connection, then LeaveShow and close. While Deck Control
   * is ON it only asks the persistent session for a fresh list. A brief connection already running is reused.
   */
  briefSync(why: string): Promise<void> {
    this.attach();
    if (this.mode === "on") {
      this.session.requestList();
      return Promise.resolve();
    }
    if (this.briefRun) return this.briefRun;
    const run = (this.ops = this.ops.then(() => (this.mode === "on" ? undefined : this.brief(why))));
    this.briefRun = run.finally(() => {
      if (this.briefRun === wrapped) this.briefRun = undefined;
    });
    const wrapped = this.briefRun;
    return wrapped;
  }

  private async brief(why: string): Promise<void> {
    const t0 = Date.now();
    this.mode = "brief";
    this.quiet = false;
    let gotList = false;
    const listed = new Promise<void>((r) => {
      this.briefListWaiter = () => {
        gotList = true;
        r();
      };
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, this.briefTimeoutMs);
      timer.unref?.();
    });
    this.session.start({ once: true });
    try {
      await Promise.race([listed, timeout, this.session.whenStopped()]);
      if (gotList) await this.identifying;
    } finally {
      if (timer) clearTimeout(timer);
      this.briefListWaiter = undefined;
      if (this.verify) clearTimeout(this.verify);
      this.quiet = true;
      await this.session.stop();
      this.quiet = false;
      this.mode = "off";
    }
    const ms = Date.now() - t0;
    const n = this.show.fixtures.length;
    this.briefs.push({ why, ms, fixtures: n, ok: gotList });
    this.log(gotList ? `brief sync (${why}): ${ms} ms, ${n} fixture(s), connection closed` : `brief sync (${why}): no fixture list after ${ms} ms${this.show.error ? ` (${this.show.error})` : ""}, connection closed`);
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
