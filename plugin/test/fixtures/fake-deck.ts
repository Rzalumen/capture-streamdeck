import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

export interface Sent {
  event: string;
  context?: string;
  payload?: any;
  [k: string]: any;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake Stream Deck application: speaks the plugin WebSocket protocol and runs the REAL built plugin. */
export class FakeDeck {
  wss!: WebSocketServer;
  sock?: WebSocket;
  received: Sent[] = [];
  globals: Record<string, unknown> = {};
  proc?: ChildProcess;
  procOut = "";
  pluginDir = "";
  /** The plugin's own log (Stream Deck SDK logger → <plugin>/logs/com.rezabehjat.capture.0.log, newest run). */
  logText(): string {
    const f = path.join(this.pluginDir, "logs", "com.rezabehjat.capture.0.log");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fakedeck-"));
  axState = path.join(this.tmp, "ax-state.json");
  axLog = path.join(this.tmp, "ax-log.jsonl");
  openLog = path.join(this.tmp, "open.log");

  setAx(state: object): void {
    fs.writeFileSync(this.axState, JSON.stringify(state));
  }
  axCalls(): { lines: string[] }[] {
    if (!fs.existsSync(this.axLog)) return [];
    return fs
      .readFileSync(this.axLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  openCalls(): string[] {
    return fs.existsSync(this.openLog) ? fs.readFileSync(this.openLog, "utf8").split("\n").filter(Boolean) : [];
  }

  async start(opts: { oscPort: number; pluginDir: string; fixtures: string; worker?: boolean; ax?: object; env?: Record<string, string> }): Promise<void> {
    this.pluginDir = opts.pluginDir;
    this.setAx(opts.ax ?? { mode: "ok" });
    this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => this.wss.on("listening", () => r()));
    const port = (this.wss.address() as { port: number }).port;
    this.wss.on("connection", (ws) => {
      this.sock = ws;
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString()) as Sent;
        this.received.push(m);
        if (m.event === "getGlobalSettings") {
          ws.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: this.globals } }));
        } else if (m.event === "setGlobalSettings") {
          this.globals = m.payload;
        }
      });
    });
    const info = {
      application: { font: "Arial", language: "en", platform: "mac", platformVersion: "26.6.2", version: "7.6.0.0" },
      colors: { buttonMouseOverBackgroundColor: "#464646", buttonPressedBackgroundColor: "#303030", buttonPressedBorderColor: "#646464", buttonPressedTextColor: "#969696", highlightColor: "#0078FF" },
      devicePixelRatio: 2,
      devices: [{ id: "DEV1", name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 }],
      plugin: { uuid: "com.rezabehjat.capture", version: "0.2.0.0" },
    };
    this.proc = spawn(
      process.execPath,
      ["bin/plugin.js", "-port", String(port), "-pluginUUID", "PLUGIN-UUID", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)],
      {
        cwd: opts.pluginDir,
        env: {
          ...process.env,
          CAPTURE_TEST_OSC_PORT: String(opts.oscPort),
          CAPTURE_TEST_OSASCRIPT: path.join(opts.fixtures, "fake-osascript.mjs"),
          // per-call osascript unless the test wants the persistent worker (then a fake worker process stands in for osascript -l JavaScript)
          ...(opts.worker ? { CAPTURE_TEST_WORKER: path.join(opts.fixtures, "fake-worker.mjs") } : { CAPTURE_NO_WORKER: "1" }),
          CAPTURE_TEST_OPEN: path.join(opts.fixtures, "fake-open.mjs"),
          FAKE_AX_STATE: this.axState,
          FAKE_AX_LOG: this.axLog,
          FAKE_OPEN_LOG: this.openLog,
          // no automatic CITP show read (UDP 4809 discovery, lsof) unless a test points the plugin at a stub CITP server
          ...(opts.env?.CAPTURE_TEST_CITP_PORT ? {} : { CAPTURE_TEST_NO_CITP: "1" }),
          ...(opts.env ?? {}),
        },
      },
    );
    this.proc.stdout?.on("data", (d) => (this.procOut += d));
    this.proc.stderr?.on("data", (d) => (this.procOut += d));
    await this.waitFor(() => this.received.some((m) => m.event === "registerPlugin" || m.event === "getGlobalSettings") || this.sock, 8000, "plugin registration");
    await sleep(300);
  }

  async stop(): Promise<void> {
    this.proc?.kill();
    this.wss?.close();
  }

  send(msg: object): void {
    this.sock!.send(JSON.stringify(msg));
  }

  willAppear(action: string, context: string, settings: object, controller: "Keypad" | "Encoder" = "Keypad", col = 0, row = 0): void {
    this.send({
      event: "willAppear",
      action,
      context,
      device: "DEV1",
      payload: { settings, coordinates: { column: col, row }, controller, isInMultiAction: false, state: 0, resources: {} },
    });
  }
  willDisappear(action: string, context: string): void {
    this.send({ event: "willDisappear", action, context, device: "DEV1", payload: { settings: {}, coordinates: { column: 0, row: 0 }, controller: "Keypad", isInMultiAction: false, state: 0, resources: {} } });
  }
  keyDown(action: string, context: string, settings: object = {}): void {
    this.send({ event: "keyDown", action, context, device: "DEV1", payload: { settings, coordinates: { column: 0, row: 0 }, isInMultiAction: false, state: 0 } });
  }
  keyUp(action: string, context: string, settings: object = {}): void {
    this.send({ event: "keyUp", action, context, device: "DEV1", payload: { settings, coordinates: { column: 0, row: 0 }, isInMultiAction: false, state: 0 } });
  }
  dialRotate(action: string, context: string, ticks: number, settings: object = {}): void {
    this.send({ event: "dialRotate", action, context, device: "DEV1", payload: { settings, coordinates: { column: 0, row: 0 }, controller: "Encoder", pressed: false, ticks } });
  }
  dialDown(action: string, context: string, settings: object = {}): void {
    this.send({ event: "dialDown", action, context, device: "DEV1", payload: { settings, coordinates: { column: 0, row: 0 }, controller: "Encoder" } });
  }
  touchTap(action: string, context: string, hold: boolean, settings: object = {}): void {
    this.send({ event: "touchTap", action, context, device: "DEV1", payload: { settings, coordinates: { column: 0, row: 0 }, controller: "Encoder", hold, tapPos: [50, 50] } });
  }
  /** Stream Deck tells the plugin which action's Property Inspector is showing before the PI talks to it. */
  inspectorAppeared(action: string, context: string): void {
    this.send({ event: "propertyInspectorDidAppear", action, context, device: "DEV1" });
  }
  sendToPlugin(action: string, context: string, payload: object): void {
    this.send({ event: "sendToPlugin", action, context, payload });
  }

  /** Messages the plugin sent to `context` matching `event` (newest last). */
  sent(context: string, event: string): Sent[] {
    return this.received.filter((m) => m.context === context && m.event === event);
  }
  lastImage(context: string): string {
    const m = this.sent(context, "setImage").at(-1);
    return m ? decodeURIComponent(String(m.payload.image).split(",")[1] ?? "") : "";
  }
  lastFeedback(context: string): any {
    return this.sent(context, "setFeedback").at(-1)?.payload;
  }

  async waitFor<T>(pred: () => T | undefined | false, ms = 4000, what = "condition"): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}\n--- plugin output ---\n${this.procOut.slice(-2000)}`);
      await sleep(25);
    }
  }
}
