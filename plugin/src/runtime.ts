import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import streamDeck from "@elgato/streamdeck";
import { ENTRIES } from "./catalog/index.js";
import { AxBridge, type AxStatus } from "./lib/axBridge.js";
import { defaultSpawn, WorkerClient } from "./lib/axWorker.js";
import { MenuCache } from "./lib/menuCache.js";
import { AxKeyRegistry } from "./lib/axKeys.js";
import { CatalogCache } from "./lib/discovery.js";
import { LatestValueLimiter } from "./lib/limiter.js";
import type { Logger } from "./lib/log.js";
import { boolArgs, numberArgs, viewAddress, type ViewId, findNumberProperty } from "./lib/properties.js";
import { ConnectionMonitor, OscClient } from "./lib/oscClient.js";
import { StoreModifier } from "./lib/storeModifier.js";
import { ValueStore } from "./lib/valueStore.js";
import { GlobalSettings } from "./lib/globals.js";
import { DmxEngine, UdpTransport } from "./fixtures/engine.js";
import { CitpLink } from "./fixtures/link.js";
import { CitpSession, timingFromEnv } from "./fixtures/citpSession.js";
import { SACN_PORT } from "./fixtures/sacn.js";
import { FixtureService } from "./fixtures/service.js";
import { SetupStore } from "./fixtures/setup.js";
import { ShowModel } from "./fixtures/show.js";
import type { JsonObject } from "@elgato/utils";

const log: Logger = streamDeck.logger;

/** Shared plugin services. Nothing here sends anything at construction time. */
class Runtime {
  readonly log = log;
  readonly osc = new OscClient({ logger: log, port: Number(process.env.CAPTURE_TEST_OSC_PORT) || undefined }); // env: test hook only
  readonly monitor = new ConnectionMonitor(this.osc, { logger: log });
  /** One long-running `osascript -l JavaScript` process (ax/worker.js). CAPTURE_NO_WORKER=1 → spawn per call (v0.1 behaviour). */
  readonly worker = process.env.CAPTURE_NO_WORKER
    ? undefined
    : new WorkerClient({ spawn: defaultSpawn(fileURLToPath(new URL("../ax/worker.js", import.meta.url))), logger: log });
  readonly ax = new AxBridge({ logger: log, worker: this.worker });
  readonly axKeys = new AxKeyRegistry(this.ax, { logger: log });
  /** Capture's menu tree, cached per Capture process ID. */
  readonly menus = new MenuCache(this.ax, { logger: log, entries: ENTRIES });
  readonly catalogs = new CatalogCache(this.osc);
  readonly storeModifier = new StoreModifier();
  /** Stream Deck global settings are one shared object: everything merges its own keys through here (never setGlobalSettings directly). */
  readonly globals = new GlobalSettings({
    get: () => streamDeck.settings.getGlobalSettings<JsonObject>() as Promise<Record<string, unknown>>,
    set: (all) => streamDeck.settings.setGlobalSettings(all as unknown as JsonObject),
  });
  readonly values = new ValueStore({
    load: async () => {
      const g = (await this.globals.read()) as { values?: Record<string, number | boolean> };
      return g.values ?? {};
    },
    save: async (values) => {
      await this.globals.update({ values });
    },
  });

  /**
   * Fixture control (v0.5): a persistent CITP session follows Capture's show and selection, identifies fixtures, reads patch changes;
   * library channel lists, per-show address setup, DMX over sACN. Nothing is sent to DMX until the user touches a fixture.
   * Env (tests only): CAPTURE_TEST_CITP_PORT / CAPTURE_TEST_CITP_TIMING / CAPTURE_TEST_LIBRARY / CAPTURE_TEST_SACN_PORT /
   * CAPTURE_TEST_SACN_NO_MULTICAST=1; CAPTURE_TEST_NO_CITP=1 does not start the CITP session.
   */
  readonly citp = new CitpSession({
    host: process.env.CAPTURE_TEST_CITP_PORT ? "127.0.0.1" : undefined,
    port: Number(process.env.CAPTURE_TEST_CITP_PORT) || undefined,
    timing: timingFromEnv(process.env.CAPTURE_TEST_CITP_TIMING),
    log: (l) => log.info(`CITP: ${l}`),
  });
  readonly fixtures = new FixtureService(
    new ShowModel({
      request: () => this.citp.requestList(),
      reconnect: () => this.citp.reconnectNow(),
      libraryPath: process.env.CAPTURE_TEST_LIBRARY || undefined,
      log: (l) => log.info(`Fixtures: ${l}`),
    }),
    new SetupStore(this.globals),
    new DmxEngine({ transport: () => new UdpTransport(Number(process.env.CAPTURE_TEST_SACN_PORT) || SACN_PORT, "127.0.0.1", process.env.CAPTURE_TEST_SACN_NO_MULTICAST !== "1") }),
    (l) => log.info(`Fixtures: ${l}`),
  );
  readonly link = new CitpLink(this.citp, this.fixtures.show, this.fixtures, (l) => log.info(`Fixtures: ${l}`));

  /** Dial sends: at most 30 msg/s per (view, property), always the newest value. */
  readonly limiter = new LatestValueLimiter<{ view: ViewId; prop: string; v: number }>((_k, s) => {
    const p = findNumberProperty(s.prop);
    if (!p) return;
    this.osc
      .send(viewAddress(s.view, s.prop), numberArgs(p, s.v))
      .then(() => {
        this.values.recordSent(s.view, s.prop, s.v);
        this.emitValueSent(s.view, s.prop);
      })
      .catch((e) => log.warn("OSC send failed", e));
  }, 30);

  /** Everything that shows a sent value (every dial / toggle instance) listens here. */
  private valueListeners: ((view: string, prop: string) => void)[] = [];
  onValueSent(fn: (view: string, prop: string) => void): void {
    this.valueListeners.push(fn);
  }
  private emitValueSent(view: string, prop: string): void {
    for (const fn of this.valueListeners) fn(view, prop);
  }

  async sendBool(view: ViewId, prop: string, on: boolean): Promise<void> {
    await this.osc.send(viewAddress(view, prop), boolArgs(on));
    this.values.recordSent(view, prop, on);
    this.emitValueSent(view, prop);
  }

  async init(): Promise<void> {
    await this.osc.open();
    // The only traffic on startup: /ping (5 s cadence) — connection monitor.
    this.monitor.start();
    // Stored values come from Stream Deck's global settings; never let a slow answer block the connection.
    await Promise.race([this.values.init(), new Promise((r) => setTimeout(r, 4000))]);
    await Promise.race([this.fixtures.setup.load(), new Promise((r) => setTimeout(r, 4000))]);
    this.installExitHandlers();
    // CITP session (stays connected, reconnects with back-off). Nothing goes to DMX from here.
    if (process.env.CAPTURE_TEST_NO_CITP !== "1") this.link.start();

    // Accessibility side (read-only, background): one summary line per minute, and the menu tree cached per Capture PID.
    this.ax.startSummary();
    this.ax.onPid = (pid) => this.menus.onPid(pid);
    const prev = this.ax.onStatus;
    let last = this.ax.status;
    this.ax.onStatus = (st) => {
      prev?.(st);
      if (st === "ok" && last === "notRunning") this.menus.invalidate(); // Capture was (re)started
      last = st;
    };
    this.menus.onBuilt = () => this.axKeys.redrawAll();
    void (async () => {
      await this.ax.check("bg");
      if (this.ax.status === "ok") await this.menus.ensure();
    })().catch((e) => log.warn("Background menu read failed", e));
  }

  /** On exit: stop DMX output with Stream_Terminated on every universe in use (SIGKILL cannot be caught; receivers time out on their own). */
  private installExitHandlers(): void {
    let exiting = false;
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.once(sig, () => {
        if (exiting) return;
        exiting = true;
        log.info(`${sig}: releasing DMX output`);
        void this.link.stop().catch(() => undefined);
        void this.fixtures.engine.release().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref();
      });
    }
  }

  openSystemSettings(status: AxStatus): void {
    const pane = status === "noAutomation" ? "Privacy_Automation" : "Privacy_Accessibility";
    const url = `x-apple.systempreferences:com.apple.preference.security?${pane}`;
    execFile(process.env.CAPTURE_TEST_OPEN || "/usr/bin/open", [url], (err) => {
      if (err) log.error("Could not open System Settings", err.message);
    });
  }
}

export const rt = new Runtime();
