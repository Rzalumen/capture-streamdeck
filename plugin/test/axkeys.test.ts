import test from "node:test";
import assert from "node:assert/strict";
import { AxBridge, type ExecResult, type Runner } from "../src/lib/axBridge.ts";
import { AxKeyRegistry, axKeyOptions, axProblem } from "../src/lib/axKeys.ts";

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0 });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEL = { path: ["Edit", "Delete"], match: "exact" as const };
const UNDO = { path: ["Edit", "Undo"], match: "prefix" as const };

test("registry: one batched call for all visible keys, enabled state exposed, redraws", async () => {
  const calls: string[][] = [];
  const runner: Runner = async (lines) => {
    calls.push(lines);
    return ok("1,0");
  };
  const ax = new AxBridge({ runner });
  const reg = new AxKeyRegistry(ax, { intervalMs: 30 });
  let redraws = 0;
  reg.register({ id: "a", targets: [DEL], redraw: () => redraws++ });
  reg.register({ id: "b", targets: [UNDO, DEL], redraw: () => redraws++ });
  await wait(20);
  // both keys visible, DEL is shared → 2 unique targets in one call
  const first = calls[0];
  assert.equal(first.filter((l) => l.includes("my act(")).length >= 1, true);
  await wait(120);
  assert.ok(calls.length >= 2, "polls repeatedly while visible");
  assert.ok(redraws > 0);
  assert.equal(typeof reg.isEnabled(DEL), "boolean");
  const before = calls.length;
  reg.unregister("a");
  reg.unregister("b");
  await wait(100);
  assert.equal(calls.length, before, "no polling once nothing is visible");
});

test("registry: reads only — never a click, never activates", async () => {
  const seen: string[] = [];
  const runner: Runner = async (lines) => {
    seen.push(lines.join("\n"));
    return ok("1");
  };
  const reg = new AxKeyRegistry(new AxBridge({ runner }), { intervalMs: 20 });
  reg.register({ id: "a", targets: [DEL], redraw() {} });
  await wait(90);
  reg.stop();
  assert.ok(seen.length > 0);
  for (const s of seen) {
    assert.ok(s.includes('"enabled")'));
    assert.ok(!s.includes('"click")'));
    assert.ok(!s.includes("set frontmost to true"));
  }
});

test("registry: permission error → keys see noPermission and polling backs off", async () => {
  let n = 0;
  const runner: Runner = async () => {
    n++;
    return { stdout: "", stderr: "execution error: System Events got an error: osascript is not allowed assistive access. (-25211)", code: 1 };
  };
  const ax = new AxBridge({ runner });
  const reg = new AxKeyRegistry(ax, { intervalMs: 20, backoffMs: 500 });
  reg.register({ id: "a", targets: [DEL], redraw() {} });
  await wait(200);
  reg.stop();
  assert.equal(ax.status, "noPermission");
  assert.ok(n <= 2, `backed off (${n} calls)`);
});

test("registry with only tab keys still checks status", async () => {
  const seen: string[] = [];
  const runner: Runner = async (lines) => (seen.push(lines.join("\n")), ok("NOTRUNNING"));
  const ax = new AxBridge({ runner });
  const reg = new AxKeyRegistry(ax, { intervalMs: 500 });
  reg.register({ id: "t", redraw() {} });
  await wait(60);
  reg.stop();
  assert.equal(ax.status, "notRunning");
});

test("key views: Allow Access / Capture? / Error / dim when disabled / flash", () => {
  assert.deepEqual(axProblem("noPermission"), { label: "Allow Access", tone: "red" });
  assert.deepEqual(axProblem("noAutomation"), { label: "Allow Access", tone: "red" });
  assert.deepEqual(axProblem("notRunning"), { label: "Capture?", tone: "red" });
  assert.deepEqual(axProblem("error"), { label: "Error", tone: "red" });
  assert.equal(axProblem("ok"), undefined);
  const base = { label: "Undo", icon: "undo", ax: "ok" as const };
  assert.equal(axKeyOptions({ ...base, enabled: false }).dim, true);
  assert.equal(axKeyOptions({ ...base, enabled: false, dimWhenDisabled: false }).dim, false);
  assert.equal(axKeyOptions({ ...base, enabled: true }).dim, false);
  assert.equal(axKeyOptions({ ...base, enabled: null }).badge, "?");
  assert.equal(axKeyOptions({ ...base, ax: "noPermission" }).label, "Allow Access");
  assert.equal(axKeyOptions({ ...base, ax: "notRunning", enabled: true }).label, "Capture?");
  assert.equal(axKeyOptions({ ...base, flash: { text: "Hold" } }).big, "Hold");
  assert.equal(axKeyOptions({ ...base, flash: { text: "Hold" }, ax: "noPermission" }).big, "Hold"); // flash wins briefly
});
