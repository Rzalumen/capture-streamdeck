#!/usr/bin/env node
// Stands in for `osascript -l JavaScript ax/worker.js`: same newline-delimited JSON protocol.
// Behaviour comes from the JSON file named in FAKE_AX_STATE (re-read on every request) — the same file the fake osascript uses.
// Every request is appended to FAKE_AX_LOG as {"worker":true,"req":{…}} (when set). Extra ops for tests: crash, hang, echo.
import fs from "node:fs";
import readline from "node:readline";

const state = () => {
  try {
    return JSON.parse(fs.readFileSync(process.env.FAKE_AX_STATE, "utf8"));
  } catch {
    return { mode: "ok" };
  }
};
const log = (req) => process.env.FAKE_AX_LOG && fs.appendFileSync(process.env.FAKE_AX_LOG, JSON.stringify({ worker: true, req }) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function chunksOf(dump) {
  const recs = String(dump ?? "").split("\t").filter(Boolean);
  const chunks = [];
  for (const r of recs) {
    if (r.startsWith("0|")) chunks.push("");
    if (chunks.length) chunks[chunks.length - 1] += r + "\t";
  }
  return chunks;
}

async function handle(req) {
  log(req);
  const st = state();
  if (req.op === "crash") process.exit(1);
  if (req.op === "hang") return;
  if (req.op === "echo") {
    await new Promise((r) => setTimeout(r, req.delayMs ?? 0));
    return out({ id: req.id, ok: true, result: String(req.value ?? "") });
  }
  if (st.workerDelayMs) await new Promise((r) => setTimeout(r, st.workerDelayMs));
  if (req.op === "enabled" && st.enabledDelayMs) await new Promise((r) => setTimeout(r, st.enabledDelayMs));
  if (req.op === "dumpTop" && st.dumpDelayMs) await new Promise((r) => setTimeout(r, st.dumpDelayMs));
  if (req.op === "click" && st.crashOnClick) {
    // die in the middle of a click, once
    delete st.crashOnClick;
    fs.writeFileSync(process.env.FAKE_AX_STATE, JSON.stringify(st));
    process.exit(1);
  }
  const pid = st.pid ?? 4242;
  const err = (message, number, extra = {}) => out({ id: req.id, ok: false, error: { message, ...(number !== undefined ? { number } : {}), ...extra } });
  if (st.mode === "noperm") return err("osascript is not allowed assistive access.", -25211);
  if (st.mode === "noperm-numberonly") return err("An error occurred. (-25211)");
  if (st.mode === "noautomation") return err("Not authorized to send Apple events to System Events.", -1743);
  if (st.mode === "internal") return err("SE.processes.byName(...).menuBars is not a function", undefined, { internal: true });
  if (st.mode === "unclassified") return err("Something odd happened");
  if (st.mode === "error") return err('Can’t get menu item "Zap".', -1728);
  if (st.mode === "notrunning") return out({ id: req.id, ok: true, result: "NOTRUNNING" });
  const ok = (result) => out({ id: req.id, ok: true, result, pid });
  switch (req.op) {
    case "hello":
      return out({ id: req.id, ok: true, result: "fake-worker" });
    case "check":
      return ok("OK");
    case "menubar":
      return ok(String(chunksOf(st.dump).length));
    case "dumpTop":
      return ok(chunksOf(st.dump)[req.index] ?? "");
    case "enabled":
      return ok(
        req.targets
          .map((t) => {
            const v = st.enabled?.[t.path.at(-1)];
            return v === undefined ? "1" : v === null ? "?" : v ? "1" : "0";
          })
          .join(","),
      );
    case "click":
      return ok(st.disabledClicks?.includes(req.path.at(-1)) ? "DISABLED" : "OK");
    case "tab":
      return ok("OK");
    default:
      return err(`Unknown op ${req.op}`, undefined, { internal: true });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  if (line.startsWith("garbage")) return;
  void handle(JSON.parse(line));
});
if (process.env.FAKE_WORKER_NOISE) process.stdout.write("this is not json\n");
