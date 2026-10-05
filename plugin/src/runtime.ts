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
import { DeckControl, ValueMemory } from "./fixtures/deck.js";
import { isShutterStrobeName } from "./fixtures/pages.js";
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
   * Fixture control: library channel lists, per-show address setup (v0.10.0: from Capture's patch when it sends it), DMX over sACN.
   * v0.10.0 (Handoff 28): the persistent session (selection, patch, levels; EnterShow + the SDMX declaration) is opened at plugin start
   * and held until plugin exit; Deck Control only arms the knobs (v0.9.0). Nothing is sent to DMX, and no sACN socket exists, until
   * the user touches a fixture or a Wake runs (v0.11.0: the Wake key, or automatically when Capture opens the show; Setup setting).
   * Env (tests only): CAPTURE_TEST_CITP_PORT / CAPTURE_TEST_CITP_TIMING / CAPTURE_TEST_LIBRARY / CAPTURE_TEST_SACN_PORT /
   * CAPTURE_TEST_SACN_NO_MULTICAST=1; CAPTURE_TEST_NO_CITP=1 makes no CITP connection at all; CAPTURE_TEST_DECK_ON=1 starts with
   * Deck Control ON (armed).
   */
  readonly citp = new CitpSession({
    host: process.env.CAPTURE_TEST_CITP_PORT ? "127.0.0.1" : undefined,
    port: Number(process.env.CAPTURE_TEST_CITP_PORT) || undefined,
    timing: timingFromEnv(process.env.CAPTURE_TEST_CITP_TIMING),
    log: (l) => log.info(`CITP: ${l}`),
  });
  /** The last value the deck sent for every channel of every fixture, per show (resume instead of snapping to home). */
  readonly memory = new ValueMemory(this.globals, 1000, (l) => log.info(`Fixtures: ${l}`));
  /** Handoff 22 migration: which stored parameter ids of this fixture are shutter/strobe channels (undefined until its type is parsed). */
  private shutterIds(key: string): ((id: string) => boolean) | undefined {
    const f = this.fixtures.show.fixtures.find((x) => x.key === key);
    const t = f && this.fixtures.show.types.get(f.typeKey);
    if (!t?.ok) return undefined;
    return (id) => {
      const c = t.channels[Number(id.slice(2))];
      return !!c && isShutterStrobeName(c.name);
    };
  }
  readonly fixtures: FixtureService = new FixtureService(
    new ShowModel({
      request: () => this.link.requestList("read the show"),
      reconnect: () => this.link.reconnect("read the show"),
      libraryPath: process.env.CAPTURE_TEST_LIBRARY || undefined,
      log: (l) => log.info(`Fixtures: ${l}`),
    }),
    new SetupStore(this.globals),
    new DmxEngine({
      transport: () => new UdpTransport(Number(process.env.CAPTURE_TEST_SACN_PORT) || SACN_PORT, "127.0.0.1", process.env.CAPTURE_TEST_SACN_NO_MULTICAST !== "1"),
      allowed: () => this.deck.on,
      resume: (key) => this.memory.get(this.fixtures.show.showName, key, this.shutterIds(key)),
      remember: (key, values) => this.memory.set(this.fixtures.show.showName, key, values),
    }),
    (l) => log.info(`Fixtures: ${l}`),
  );
  readonly link = new CitpLink(this.citp, this.fixtures.show, this.fixtures, (l) => log.info(`Fixtures: ${l}`));
  /**
   * Deck Control = arming the knobs (v0.9.0, Handoff 27). The persistent session is opened at plugin start (v0.10.0); disarming
   * sends and closes nothing (output keeps running). Only plugin exit, or Capture leaving / changing the show, ends output.
   */
  readonly deck = new DeckControl({
    start: () => this.link.startPersistent(),
    afterOff: () => this.memory.flush(),
    log: (l) => log.info(`Fixtures: ${l}`),
    globals: this.globals,
  });

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
    await Promise.race([Promise.all([this.fixtures.setup.load(), this.memory.load(), this.deck.load()]), new Promise((r) => setTimeout(r, 4000))]);
    this.fixtures.deck = this.deck;
    this.deck.onChange(() => this.fixtures.notify());
    this.installExitHandlers();
    // v0.10.0: the persistent session from start-up (EnterShow, declaration, fixture list, identification, Capture's patch). Deck
    // Control starts disarmed; nothing goes to DMX (and no sACN socket is opened) until a fixture is touched or woken (v0.11.0: with
    // the automatic wake on, the stored values go out as soon as Capture's show and addresses are in).
    if (process.env.CAPTURE_TEST_NO_CITP !== "1") {
      this.link.attach();
      void this.link.startPersistent();
      if (process.env.CAPTURE_TEST_DECK_ON === "1") void this.deck.setOn(true, "test start-up");
    }

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
        void Promise.all([this.fixtures.engine.release(), this.memory.flush()]).finally(() => process.exit(0));
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
