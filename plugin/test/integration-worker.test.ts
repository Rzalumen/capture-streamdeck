/**
 * End-to-end with the PERSISTENT WORKER: the real built plugin, a fake Stream Deck app, a fake Capture (OSC), and a fake
 * worker process (test/fixtures/fake-worker.mjs) standing in for `osascript -l JavaScript ax/worker.js`.
 * Checks the plugin's use of the worker: startup reads, polling policy, presses first, menu cache per pid, crash recovery.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeDeck, sleep } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../com.rezabehjat.capture.sdPlugin");
const U = "com.rezabehjat.capture";
const N = (category: string, id: string) => `${U}.cmd.${category}.${id}`;
const deck = new FakeDeck();
const capture = new StubCapture();

const DUMP = ["0|1|Apple|1", "0|1|Capture|1", "0|1|File|1", "1|1|Save|0", "0|1|Edit|1", "1|1|Undo Live|0", "1|1|Zap Thing|0", "0|1|View|1", "1|1|Plot|0", "1|1|Grid|0", ""].join("\t");

const reqs = () =>
  deck.axCalls().flatMap((c: any) => (c.worker ? [c.req] : []));
const ops = (from = 0) => reqs().slice(from).map((r: any) => r.op);

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  await capture.start();
  await deck.start({ oscPort: capture.port, pluginDir, fixtures: path.join(here, "fixtures"), worker: true, ax: { mode: "ok", dump: DUMP } });
});
after(async () => {
  await deck.stop();
  capture.stop();
});

test("startup: one worker, read-only requests only (status check + menu tree), served without spawning osascript per call", async () => {
  await deck.waitFor(() => ops().includes("dumpTop"), 6000, "background menu read");
  await sleep(300);
  const o = ops();
  assert.equal(o[0], "check");
  assert.deepEqual([...new Set(o)].sort(), ["check", "dumpTop", "menubar"]);
  assert.equal(o.filter((x) => x === "menubar").length, 1);
  assert.equal(o.filter((x) => x === "dumpTop").length, 5, "one request per top-level menu");
  assert.deepEqual([...new Set(capture.msgs.map((m) => m.address))], ["/ping"]);
  assert.match(deck.logText(), /AX worker started \(#1\)/);
  assert.match(deck.logText(), /Menu tree cached for Capture pid 4242: 5 commands/);
  assert.match(deck.logText(), /Catalog entries not found in this Capture's menus/);
  assert.match(deck.logText(), /Capture commands with no catalog entry \(\d+\): [^\n]*Edit > Zap Thing/);
});

test("a named key press goes to the worker as ONE click request and is logged with its latency", async () => {
  const uuid = N("view", "plot");
  deck.willAppear(uuid, "w-plot", {});
  await deck.waitFor(() => deck.lastImage("w-plot").includes(">Plot<"), 3000, "drawn");
  await sleep(200);
  const n = reqs().length;
  deck.keyDown(uuid, "w-plot", {});
  await deck.waitFor(() => reqs().slice(n).find((r: any) => r.op === "click"), 3000, "click request");
  const click = reqs().slice(n).find((r: any) => r.op === "click");
  assert.deepEqual([click.path, click.match], [["View", "Plot"], "exact"]);
  await deck.waitFor(() => deck.sent("w-plot", "showOk").length > 0, 3000, "showOk");
  assert.equal(reqs().slice(n).filter((r: any) => r.op === "click").length, 1);
  assert.match(deck.logText(), /AX press click View > Plot: \d+ ms \(queued \d+ ms, \d+ ms via worker\)/);
  deck.keyUp(uuid, "w-plot", {});
});

test("polling policy: a page of keys appearing is ONE batched poll; a press is followed by a poll ~300 ms later; idle polling is ≥ 5 s apart", async () => {
  await sleep(600);
  let n = reqs().length;
  const keys = [N("view", "grid"), N("view", "wireframe"), N("edit", "undo"), N("edit", "copy"), N("edit", "cut")];
  keys.forEach((k, i) => deck.willAppear(k, `pg${i}`, {}));
  await deck.waitFor(() => reqs().slice(n).find((r: any) => r.op === "enabled"), 3000, "poll after appear");
  await sleep(300);
  const polls = reqs().slice(n).filter((r: any) => r.op === "enabled");
  assert.equal(polls.length, 1, "all five keys in one poll");
  assert.ok(polls[0].targets.length >= 5);
  assert.ok(polls[0].targets.some((t: any) => t.path.join(">") === "Edit>Undo" && t.match === "prefix"));

  // after a press: a poll within ~300 ms (not immediately, not seconds later)
  await sleep(300);
  n = reqs().length;
  const t0 = Date.now();
  deck.keyDown(N("view", "grid"), "pg0", {});
  await deck.waitFor(() => reqs().slice(n).find((r: any) => r.op === "click"), 3000, "click");
  await deck.waitFor(() => reqs().slice(n).find((r: any) => r.op === "enabled"), 3000, "poll after press");
  const dt = Date.now() - t0;
  assert.ok(dt >= 250 && dt < 1200, `poll came ${dt} ms after the press`);
  deck.keyUp(N("view", "grid"), "pg0", {});

  // idle: nothing more than one poll in ~3.5 s (interval is 5 s)
  await sleep(700);
  n = reqs().length;
  await sleep(3500);
  assert.ok(ops(n).filter((o) => o === "enabled").length <= 1, `idle polls: ${ops(n).join(",")}`);
  keys.forEach((_, i) => deck.willDisappear(keys[i], `pg${i}`));
});

test("presses first: a press that arrives during a poll runs right after that poll; the queued poll is dropped, never one in front of a press", async () => {
  deck.setAx({ mode: "ok", dump: DUMP, enabledDelayMs: 400 });
  const uuid = N("view", "grid");
  const n = reqs().length;
  deck.willAppear(uuid, "pp", {});
  await deck.waitFor(() => ops(n).includes("enabled"), 3000, "poll running (slow)");
  const t0 = Date.now();
  deck.keyDown(uuid, "pp", {});
  await deck.waitFor(() => ops(n).includes("click"), 3000, "click");
  const waited = Date.now() - t0;
  assert.ok(waited < 700, `press waited ${waited} ms (poll remainder ≤ 400 ms)`);
  assert.equal(ops(n).indexOf("enabled"), 0);
  assert.ok(ops(n).indexOf("click") === 1, `click is next after the running poll: ${ops(n).join(",")}`);
  deck.keyUp(uuid, "pp", {});
  deck.setAx({ mode: "ok", dump: DUMP });
  deck.willDisappear(uuid, "pp");
});

test("menu tree: served from the cache to the Property Inspector; 'Refresh' re-reads; a new Capture pid re-reads by itself", async () => {
  const S = { menuPath: ["View", "Plot"], match: "exact" };
  deck.willAppear(`${U}.command`, "gen", S);
  let n = reqs().length;
  deck.inspectorAppeared(`${U}.command`, "gen");
  deck.sendToPlugin(`${U}.command`, "gen", { cmd: "listMenus", force: false });
  const msg = await deck.waitFor(() => deck.received.filter((m) => m.event === "sendToPropertyInspector").at(-1), 4000, "menus");
  assert.equal(msg.payload.event, "menus");
  assert.ok(msg.payload.commands.length >= 4);
  assert.equal(ops(n).filter((o) => o === "dumpTop").length, 0, "served from the cache: no new reading");

  n = reqs().length;
  const before = deck.received.filter((m) => m.event === "sendToPropertyInspector").length;
  deck.sendToPlugin(`${U}.command`, "gen", { cmd: "listMenus", force: true });
  await deck.waitFor(() => deck.received.filter((m) => m.event === "sendToPropertyInspector").length > before, 5000, "refreshed menus");
  assert.equal(ops(n).filter((o) => o === "dumpTop").length, 5, "Refresh reads the tree again");

  // Capture restarted: new pid seen by the next poll → the tree is rebuilt without anyone asking
  n = reqs().length;
  deck.setAx({ mode: "ok", dump: DUMP, pid: 5555 });
  deck.keyDown(`${U}.command`, "gen", S); // any press → a poll shortly after → new pid noticed
  await deck.waitFor(() => /Menu tree cached for Capture pid 5555/.test(deck.logText()), 6000, "rebuilt for the new pid");
  deck.keyUp(`${U}.command`, "gen", S);
  deck.setAx({ mode: "ok", dump: DUMP, pid: 5555 });
});

test("worker crash during a click: the click is not repeated, the key says Error, the next press works with a restarted worker", async () => {
  const uuid = N("view", "wireframe");
  deck.willAppear(uuid, "cr", {});
  await sleep(200);
  deck.setAx({ mode: "ok", dump: DUMP, pid: 5555, crashOnClick: true });
  const n = reqs().length;
  deck.keyDown(uuid, "cr", {});
  await deck.waitFor(() => deck.sent("cr", "showAlert").length > 0 || deck.lastImage("cr").includes("Error"), 4000, "error shown");
  assert.equal(ops(n).filter((o) => o === "click").length, 1, "one click request, never re-sent");
  assert.match(deck.logText(), /AX worker exited/);
  deck.keyUp(uuid, "cr", {});
  await sleep(300);
  deck.keyDown(uuid, "cr", {});
  await deck.waitFor(() => deck.sent("cr", "showOk").length > 0, 4000, "next press works");
  assert.match(deck.logText(), /AX worker started \(#2\)/);
  deck.keyUp(uuid, "cr", {});
});

test("permission errors come through the worker with their real code: 'Allow Access', press opens System Settings; recovers", async () => {
  const uuid = N("view", "grid");
  deck.willAppear(uuid, "perm", {});
  await sleep(200);
  deck.setAx({ mode: "noperm", dump: DUMP });
  deck.keyDown(uuid, "perm", {});
  await deck.waitFor(() => deck.lastImage("perm").includes("Allow Access"), 6000, "Allow Access");
  deck.keyUp(uuid, "perm", {});
  deck.keyDown(uuid, "perm", {});
  await deck.waitFor(() => deck.openCalls().some((l) => l.includes("Privacy_Accessibility")), 3000, "System Settings opened");
  deck.keyUp(uuid, "perm", {});
  deck.setAx({ mode: "ok", dump: DUMP });
  await deck.waitFor(() => !deck.lastImage("perm").includes("Allow Access"), 9000, "recovered");
  assert.match(deck.logText(), /AX click View > Grid failed \(noPermission\): osascript is not allowed assistive access\. \(-25211\)/);
});
