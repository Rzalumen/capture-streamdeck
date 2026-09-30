import test from "node:test";
import assert from "node:assert/strict";
import { AxBridge, AxError, classifyAxError, type ExecResult, type Runner } from "../src/lib/axBridge.ts";

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr: string): ExecResult => ({ stdout: "", stderr, code: 1 });

function fake(responses: (ExecResult | ((lines: string[]) => ExecResult))[], calls: string[][] = [], delayMs = 0): Runner {
  let i = 0;
  return async (lines) => {
    calls.push(lines);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const r = responses[Math.min(i++, responses.length - 1)];
    return typeof r === "function" ? r(lines) : r;
  };
}

test("click builds the expected script and returns OK", async () => {
  const calls: string[][] = [];
  const ax = new AxBridge({ runner: fake([ok("OK")], calls) });
  assert.equal(await ax.clickMenu({ path: ["View", "Camera", "Swing to Front"], match: "exact" }), "OK");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('return my act("Capture", "View", {"Camera"}, "exact", {"Swing to Front"}, "click")'));
  assert.equal(ax.status, "ok");
});

test("click on a disabled item is reported, not an error", async () => {
  const ax = new AxBridge({ runner: fake([ok("DISABLED")]) });
  assert.equal(await ax.clickMenu({ path: ["Edit", "Undo"], match: "prefix" }), "DISABLED");
});

test("enabled batch: one call for many keys, parsed in order", async () => {
  const calls: string[][] = [];
  const ax = new AxBridge({ runner: fake([ok("1,0,?")], calls) });
  const r = await ax.enabledStates([
    { path: ["Edit", "Undo"], match: "prefix" },
    { path: ["Edit", "Delete"], match: "exact" },
    { path: ["View", "Nope"], match: "exact" },
  ]);
  assert.deepEqual(r, [true, false, null]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filter((l) => l.includes("my act(")).length, 3);
});

test("permission error maps to noPermission → 'Allow Access' (text and codes)", async () => {
  for (const msg of [
    "execution error: System Events got an error: osascript is not allowed assistive access. (-25211)",
    "execution error: System Events got an error: osascript is not allowed assistive access. (-1719)",
    "85:99: execution error: osascript is not allowed assistive access. (-25211)",
  ]) {
    assert.equal(classifyAxError(msg).kind, "noPermission", msg);
  }
  const ax = new AxBridge({ runner: fake([fail("execution error: System Events got an error: osascript is not allowed assistive access. (-25211)")]) });
  await assert.rejects(ax.clickMenu({ path: ["View", "Plot"], match: "exact" }), (e: unknown) => e instanceof AxError && e.kind === "noPermission");
  assert.equal(ax.status, "noPermission");
  assert.match(ax.lastError, /assistive access/);
});

test("automation denial (-1743) is its own kind, generic errors stay generic", () => {
  assert.equal(classifyAxError("Not authorized to send Apple events to System Events. (-1743)").kind, "noAutomation");
  assert.equal(classifyAxError("execution error: Can’t get menu item \"X\". (-1728)").kind, "error");
  assert.equal(classifyAxError("").kind, "error");
});

test("Capture not running → notRunning ('Capture?')", async () => {
  const ax = new AxBridge({ runner: fake([ok("NOTRUNNING")]) });
  await assert.rejects(ax.clickMenu({ path: ["View", "Plot"], match: "exact" }), (e: unknown) => e instanceof AxError && e.kind === "notRunning");
  assert.equal(ax.status, "notRunning");
  assert.equal(await ax.check(), "notRunning");
});

test("other errors → 'error', raw text kept verbatim", async () => {
  const raw = 'execution error: Can’t get menu item "Zap" of menu 1. (-1728)';
  const ax = new AxBridge({ runner: fake([fail(raw)]) });
  await assert.rejects(ax.enabledStates([{ path: ["View", "Zap"], match: "exact" }]), (e: unknown) => e instanceof AxError && e.kind === "error" && e.raw === raw);
  assert.equal(ax.status, "error");
  assert.equal(ax.lastError, raw);
});

test("a click that times out (modal dialog) counts as delivered; a timed-out poll is an error", async () => {
  const to: ExecResult = { stdout: "", stderr: "", code: null, timedOut: true };
  const ax = new AxBridge({ runner: fake([to, to]) });
  assert.equal(await ax.clickMenu({ path: ["Edit", "Duplicate…"], match: "exact" }), "OK");
  await assert.rejects(ax.enabledStates([{ path: ["Edit", "Duplicate…"], match: "exact" }]));
});

test("tab click", async () => {
  const calls: string[][] = [];
  const ax = new AxBridge({ runner: fake([ok("OK"), ok("NOTAB")], calls) });
  assert.equal(await ax.clickTab("Universes"), "OK");
  assert.ok(calls[0].includes('        set rb to radio button "Universes" of g'));
  await assert.rejects(ax.clickTab("Media"), /not found/);
});

test("menu dump is parsed and filtered", async () => {
  const raw = ["0|1|Apple|1", "0|1|File|1", "1|1|Save|0", "1|1|Open Recent|1", "2|1|x.c3d|0", "0|1|View|1", "1|1|Plot|0", ""].join("\t");
  const ax = new AxBridge({ runner: fake([ok(raw)]) });
  const tree = await ax.dumpMenus();
  assert.deepEqual(tree.map((t) => [t.name, t.children.map((c) => c.name)]), [
    ["File", ["Save"]],
    ["View", ["Plot"]],
  ]);
});

test("calls never overlap; a press drops the waiting polls; identical polls coalesce", async () => {
  const order: string[] = [];
  const runner: Runner = async (lines) => {
    order.push(lines.some((l) => l.includes('"click")')) ? "click" : "poll");
    await new Promise((r) => setTimeout(r, 15));
    return ok(lines.some((l) => l.includes('"click")')) ? "OK" : "1");
  };
  const ax = new AxBridge({ runner });
  const t = { path: ["Edit", "Delete"], match: "exact" as const };
  const p1 = ax.enabledStates([t]); // starts running: never interrupted
  const p2 = ax.enabledStates([{ ...t, path: ["Edit", "Cut"] }]); // waits
  const p3 = ax.enabledStates([{ ...t, path: ["Edit", "Cut"] }]); // identical → coalesced with p2
  const dropped = Promise.allSettled([p2, p3]);
  const c = ax.clickMenu({ path: ["View", "Plot"], match: "exact" }); // press: the waiting poll is dropped, click runs next
  await Promise.all([p1, c]);
  const [r2, r3] = await dropped;
  assert.equal(r2.status, "rejected");
  assert.equal((r2 as PromiseRejectedResult).reason.name, "DroppedError");
  assert.equal(r3.status, "rejected");
  assert.equal(ax.queue.maxActive, 1);
  assert.deepEqual(order, ["poll", "click"]);
});

test("latency median is tracked", async () => {
  let now = 0;
  const durations = [100, 500, 200];
  let i = 0;
  const runner: Runner = async () => {
    now += durations[i++];
    return ok("OK");
  };
  const ax = new AxBridge({ runner, now: () => now });
  for (let k = 0; k < 3; k++) await ax.check();
  assert.deepEqual(ax.latency(), { median: 200, count: 3, max: 500 });
});
