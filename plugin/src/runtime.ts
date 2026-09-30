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
  readonly values = new ValueStore({
    load: async () => {
      const g = await streamDeck.settings.getGlobalSettings<{ values?: Record<string, number | boolean> }>();
      return g.values ?? {};
    },
    save: async (values) => {
      await streamDeck.settings.setGlobalSettings({ values } as unknown as JsonObject);
    },
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

  openSystemSettings(status: AxStatus): void {
    const pane = status === "noAutomation" ? "Privacy_Automation" : "Privacy_Accessibility";
    const url = `x-apple.systempreferences:com.apple.preference.security?${pane}`;
    execFile(process.env.CAPTURE_TEST_OPEN || "/usr/bin/open", [url], (err) => {
      if (err) log.error("Could not open System Settings", err.message);
    });
  }
}

export const rt = new Runtime();
