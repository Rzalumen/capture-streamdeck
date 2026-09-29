import { execFile } from "node:child_process";
import streamDeck from "@elgato/streamdeck";
import { AxBridge, type AxStatus } from "./lib/axBridge.js";
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
  readonly ax = new AxBridge({ logger: log });
  readonly axKeys = new AxKeyRegistry(this.ax, { logger: log });
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
        this.onValueSent?.(s.view, s.prop);
      })
      .catch((e) => log.warn("OSC send failed", e));
  }, 30);

  onValueSent?: (view: string, prop: string) => void;

  async sendBool(view: ViewId, prop: string, on: boolean): Promise<void> {
    await this.osc.send(viewAddress(view, prop), boolArgs(on));
    this.values.recordSent(view, prop, on);
    this.onValueSent?.(view, prop);
  }

  async init(): Promise<void> {
    await this.osc.open();
    // The only traffic on startup: /ping (5 s cadence) — connection monitor.
    this.monitor.start();
    // Stored values come from Stream Deck's global settings; never let a slow answer block the connection.
    await Promise.race([this.values.init(), new Promise((r) => setTimeout(r, 4000))]);
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
