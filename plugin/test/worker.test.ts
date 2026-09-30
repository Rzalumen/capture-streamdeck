import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AxBridge, isNotFound, type ExecResult, type Runner } from "../src/lib/axBridge.ts";
import { WorkerClient, WorkerExitError, WorkerTimeoutError, WorkerUnavailableError } from "../src/lib/axWorker.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fixtures/fake-worker.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-test-"));
const stateFile = path.join(tmp, "state.json");
const logFile = path.join(tmp, "log.jsonl");
const setState = (s: object) => fs.writeFileSync(stateFile, JSON.stringify(s));
const reqLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).req) : []);
const ops = () => reqLog().map((r) => r.op + (r.op === "dumpTop" ? String(r.index) : ""));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0 });

function client(extra: Record<string, string> = {}, script = FAKE, maxStartFailures?: number): WorkerClient {
  return new WorkerClient({
    spawn: () => spawn(process.execPath, [script], { env: { ...process.env, FAKE_AX_STATE: stateFile, FAKE_AX_LOG: logFile, ...extra }, stdio: ["pipe", "pipe", "pipe"] }),
    maxStartFailures,
  });
}
const fresh = () => {
  setState({ mode: "ok" });
  fs.rmSync(logFile, { force: true });
};

test("WorkerClient: JSON round trip, replies matched by id (even out of order), noise on stdout ignored", async () => {
  fresh();
  const w = client({ FAKE_WORKER_NOISE: "1" });
  const slow = w.request({ op: "echo", value: "slow", delayMs: 80 }, 3000);
  const fast = w.request({ op: "echo", value: "fast", delayMs: 5 }, 3000);
  const [a, b] = await Promise.all([slow, fast]);
  assert.equal(a.result, "slow");
  assert.equal(b.result, "fast");
  assert.equal(w.starts, 1, "one process serves every request");
  w.close();
});

test("WorkerClient: non-ASCII request text survives (ASCII-escaped on the wire)", async () => {
  fresh();
  const w = client();
  const r = await w.request({ op: "echo", value: "Duplicate… “x”" }, 3000);
  assert.equal(r.result, "Duplicate… “x”");
  w.close();
});

test("WorkerClient: restarts after a crash; the in-flight request is rejected, the next one just works", async () => {
  fresh();
  const w = client();
  assert.equal((await w.request({ op: "echo", value: "1" }, 3000)).result, "1");
  await assert.rejects(w.request({ op: "crash" }, 3000), WorkerExitError);
  assert.equal(w.running, false);
  assert.equal((await w.request({ op: "echo", value: "2" }, 3000)).result, "2");
  assert.equal(w.starts, 2);
  assert.ok(w.usable, "one crash after answering does not disable the worker");
  w.close();
});

test("WorkerClient: a request that times out (e.g. a modal dialog blocking the click) kills the worker; the next one gets a fresh process", async () => {
  fresh();
  const w = client();
  await w.request({ op: "echo", value: "warm" }, 3000);
  await assert.rejects(w.request({ op: "hang" }, 150), WorkerTimeoutError);
  assert.equal((await w.request({ op: "echo", value: "again" }, 3000)).result, "again");
  assert.equal(w.starts, 2);
  w.close();
});

test("WorkerClient: gives up after repeated starts that never answer (falls back to per-call osascript)", async () => {
  const dead = path.join(tmp, "dead.mjs");
  fs.writeFileSync(dead, "process.exit(3)\n");
  const w = client({}, dead, 3);
  for (let i = 0; i < 3; i++) await assert.rejects(w.request({ op: "hello" }, 2000), WorkerExitError);
  assert.equal(w.usable, false);
  await assert.rejects(w.request({ op: "hello" }, 2000), WorkerUnavailableError);
  assert.equal(w.starts, 3);
  w.enable();
  assert.ok(w.usable);
});

// ---------------------------------------------------------------- AxBridge over the worker

const T = (name: string, match: "exact" | "prefix" = "exact") => ({ path: ["Edit", name], match });

test("bridge over worker: click / disabled / not running / tab / enabled batch / check, and the pid is reported", async () => {
  fresh();
  setState({ mode: "ok", disabledClicks: ["Delete"], enabled: { Undo: 0, Cut: null } });
  const runner: Runner = async () => assert.fail("no per-call osascript expected");
  const pids: number[] = [];
  const ax = new AxBridge({ runner, worker: client() });
  ax.onPid = (p) => pids.push(p);
  assert.equal(await ax.clickMenu({ path: ["View", "Plot"], match: "exact" }), "OK");
  assert.equal(await ax.clickMenu(T("Delete")), "DISABLED");
  assert.equal(await ax.clickTab("Fixtures"), "OK");
  assert.deepEqual(await ax.enabledStates([T("Undo", "prefix"), T("Copy"), T("Cut")]), [false, true, null]);
  assert.equal(await ax.check(), "ok");
  assert.deepEqual(pids, [4242]);
  assert.equal(ax.pid, 4242);
  assert.equal(ax.transport, "worker");
  const click = reqLog().find((r) => r.op === "click");
  assert.deepEqual([click.path, click.match], [["View", "Plot"], "exact"]);
  setState({ mode: "notrunning" });
  await assert.rejects(ax.clickMenu(T("Copy")), (e: any) => e.kind === "notRunning");
  assert.equal(ax.status, "notRunning");
  ax.stop();
});

test("bridge over worker: real error codes are mapped — assistive access, automation, code-only text, item missing, unclassified", async () => {
  fresh();
  const runner: Runner = async () => ok("1"); // authoritative osascript for the unclassified read
  const ax = new AxBridge({ runner, worker: client() });
  setState({ mode: "noperm" });
  await assert.rejects(ax.clickMenu(T("Copy")), (e: any) => e.kind === "noPermission");
  assert.equal(ax.status, "noPermission");
  setState({ mode: "noperm-numberonly" });
  await assert.rejects(ax.clickMenu(T("Copy")), (e: any) => e.kind === "noPermission", "-25211 alone is enough");
  setState({ mode: "noautomation" });
  await assert.rejects(ax.clickMenu(T("Copy")), (e: any) => e.kind === "noAutomation");
  assert.equal(ax.status, "noAutomation");
  setState({ mode: "error" });
  await assert.rejects(ax.clickMenu(T("Zap")), (e: any) => e.kind === "error" && isNotFound(e) && /Zap/.test(e.raw));
  assert.equal(ax.status, "error");
  setState({ mode: "unclassified" });
  await assert.rejects(ax.clickMenu(T("Copy")), (e: any) => e.kind === "error" && /Something odd/.test(e.raw), "a click is never re-run to find out more");
  ax.stop();
});

test("bridge over worker: an unclassified error on a READ is re-asked of the real osascript (authoritative text)", async () => {
  fresh();
  setState({ mode: "unclassified" });
  const calls: string[][] = [];
  const runner: Runner = async (lines) => (calls.push(lines), { stdout: "", stderr: "execution error: System Events got an error: osascript is not allowed assistive access. (-25211)", code: 1 });
  const ax = new AxBridge({ runner, worker: client() });
  await assert.rejects(ax.enabledStates([T("Copy")]), (e: any) => e.kind === "noPermission");
  assert.equal(calls.length, 1);
  ax.stop();
});

test("bridge over worker: an internal worker error falls back to osascript for that call, and two in a row disable the worker", async () => {
  fresh();
  setState({ mode: "internal" });
  const calls: string[][] = [];
  const runner: Runner = async (lines) => (calls.push(lines), ok(lines.some((l) => l.includes('"click")')) ? "OK" : "1"));
  const ax = new AxBridge({ runner, worker: client() });
  assert.equal(await ax.clickMenu(T("Copy")), "OK", "still works through osascript");
  assert.equal(ax.transport, "worker");
  assert.deepEqual(await ax.enabledStates([T("Copy")]), [true]);
  assert.equal(ax.transport, "osascript", "disabled after the second internal error");
  const before = reqLog().length;
  await ax.clickMenu(T("Cut"));
  assert.equal(reqLog().length, before, "the worker is not used any more");
  assert.equal(calls.length, 3);
  ax.stop();
});

test("bridge over worker: if the worker dies during a click the click is NOT repeated; a dying read falls back", async () => {
  fresh();
  const calls: string[][] = [];
  const runner: Runner = async (lines) => (calls.push(lines), ok("1"));
  const w = client();
  const ax = new AxBridge({ runner, worker: w });
  await ax.check();
  // make the next request a crash: the click op itself asks the fake to exit
  const orig = w.request.bind(w);
  w.request = (req, t) => orig(req.op === "click" ? { ...req, op: "crash" } : req, t);
  await assert.rejects(ax.clickMenu(T("Copy")), (e: any) => e.kind === "error" && /worker/i.test(e.raw));
  assert.equal(calls.length, 0, "no second click through osascript");
  w.request = (req, t) => orig(req.op === "enabled" ? { ...req, op: "crash" } : req, t);
  assert.deepEqual(await ax.enabledStates([T("Copy")]), [true], "a read is safe to repeat");
  assert.equal(calls.length, 1);
  ax.stop();
});

test("bridge over worker: a click that times out (modal dialog) is treated as delivered and the next press works", async () => {
  fresh();
  const w = client();
  const ax = new AxBridge({ runner: async () => assert.fail("no fallback"), worker: w, clickTimeoutMs: 150 });
  await ax.check();
  const orig = w.request.bind(w);
  w.request = (req, t) => orig(req.op === "click" ? { ...req, op: "hang" } : req, t);
  assert.equal(await ax.clickMenu({ path: ["File", "Save As…"], match: "exact" }), "OK");
  w.request = orig;
  assert.equal(await ax.clickMenu(T("Copy")), "OK");
  assert.equal(w.starts, 2, "a fresh worker took over");
  ax.stop();
});

test("bridge over worker: presses pre-empt polls — a waiting poll is dropped, the click runs right after the running one", async () => {
  fresh();
  setState({ mode: "ok", enabledDelayMs: 80 });
  const ax = new AxBridge({ runner: async () => assert.fail("no fallback"), worker: client() });
  await ax.check();
  fs.rmSync(logFile, { force: true });
  const poll1 = ax.enabledStates([T("Copy")]); // running
  await wait(20);
  const poll2 = ax.enabledStates([T("Cut")]); // waiting
  const res2 = Promise.allSettled([poll2]);
  const press = ax.clickMenu({ path: ["View", "Plot"], match: "exact" });
  const [r1, pr] = await Promise.all([poll1, press]);
  assert.deepEqual(r1, [true]);
  assert.equal(pr, "OK");
  assert.equal((await res2)[0].status, "rejected");
  assert.deepEqual(ops(), ["enabled", "click"], "the second poll never reached the worker");
  assert.equal(ax.queue.maxActive, 1);
  ax.stop();
});

test("bridge over worker: never more than one poll in flight (identical waiting polls coalesce)", async () => {
  fresh();
  setState({ mode: "ok", enabledDelayMs: 50 });
  const ax = new AxBridge({ runner: async () => assert.fail("no fallback"), worker: client() });
  await ax.check();
  fs.rmSync(logFile, { force: true });
  const ps = [ax.enabledStates([T("Copy")]), ax.enabledStates([T("Copy")]), ax.enabledStates([T("Copy")])];
  await Promise.all(ps);
  assert.equal(ops().filter((o) => o === "enabled").length, 2, "one running + one waiting (the other two coalesced into it)");
  assert.equal(ax.queue.maxActive, 1);
  ax.stop();
});

test("bridge over worker: the menu tree is read one top-level menu at a time, so a press slips in between menus", async () => {
  fresh();
  const dump = ["0|1|Apple|1", "0|1|File|1", "1|1|Save|0", "0|1|Edit|1", "1|1|Copy|0", "0|1|View|1", "1|1|Plot|0", ""].join("\t");
  setState({ mode: "ok", dump, dumpDelayMs: 60 });
  const ax = new AxBridge({ runner: async () => assert.fail("no fallback"), worker: client() });
  await ax.check();
  fs.rmSync(logFile, { force: true });
  const tree = ax.dumpMenus();
  await wait(90); // first menu chunk is being read
  const press = ax.clickMenu({ path: ["View", "Plot"], match: "exact" });
  const [t] = await Promise.all([tree, press]);
  assert.deepEqual(t.map((n) => [n.name, n.children.map((c) => c.name)]), [["File", ["Save"]], ["Edit", ["Copy"]], ["View", ["Plot"]]]);
  const o = ops();
  assert.equal(o[0], "menubar");
  assert.ok(o.indexOf("click") > 0 && o.indexOf("click") < o.lastIndexOf("dumpTop2"), `press ran before the last chunk: ${o.join(",")}`);
  ax.stop();
});

test("bridge: press latency (key event → result) and poll latency are summarised in ONE line, then the window resets", async () => {
  let now = 0;
  const durations = [40, 50, 60, 7, 9];
  let i = 0;
  const runner: Runner = async () => {
    now += durations[i++];
    return ok("1");
  };
  const lines: string[] = [];
  const ax = new AxBridge({ runner, now: () => now, logger: { trace() {}, debug() {}, info: (m: string) => lines.push(m), warn() {}, error() {} } });
  for (let k = 0; k < 3; k++) await ax.clickMenu({ path: ["View", "Plot"], match: "exact" });
  await ax.enabledStates([T("Copy")]);
  await ax.enabledStates([T("Cut")]);
  assert.deepEqual(ax.pressLatency(), { median: 50, p95: 60, count: 3 });
  assert.equal(lines.filter((l) => /^AX press/.test(l)).length, 3, "each press is logged");
  assert.equal(lines.filter((l) => /poll|enabled/i.test(l)).length, 0, "polls are not logged one by one");
  const s = ax.summaryLine()!;
  assert.match(s, /^AX summary: press n=3 median 50 ms p95 60 ms/);
  assert.match(s, /poll n=2 median 8 ms p95 9 ms/);
  assert.equal(ax.summaryLine(), undefined, "window reset");
});
