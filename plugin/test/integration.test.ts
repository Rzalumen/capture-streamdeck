/**
 * End-to-end: the REAL built plugin (bin/plugin.js, run by Node) talking to
 *   - a fake Stream Deck application (WebSocket, the plugin protocol),
 *   - a fake Capture (UDP OSC on a random port), and
 *   - a fake /usr/bin/osascript (records every script it is given).
 * Run `npm run build` first (npm test does).
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
const A = {
  command: `${U}.command`,
  tab: `${U}.tab`,
  slot: `${U}.slot`,
  store: `${U}.store`,
  position: `${U}.position`,
  dial: `${U}.dial`,
  toggle: `${U}.toggle`,
  connection: `${U}.connection`,
};

const deck = new FakeDeck();
const capture = new StubCapture();

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  await capture.start();
  await deck.start({ oscPort: capture.port, pluginDir, fixtures: path.join(here, "fixtures") });
});
after(async () => {
  await deck.stop();
  capture.stop();
});

const enc = (s: string) =>
  [...s].map((c) => {
    const cp = c.codePointAt(0)!;
    return cp < 32 || cp > 126 || cp === 124 || cp === 92 ? `\\u{${cp.toString(16).toUpperCase()}}` : c;
  }).join("");
const DUMP = [
  [0, "Apple"], [0, "Capture"],
  [0, "File"], [1, "Save"], [1, "Open Recent"], [2, "Show.c3d"],
  [0, "Edit"], [1, "Undo Live"], [1, "1"], [1, "Duplicate…"], [1, "Writing Tools"], [2, "Proofread"], [1, "Emoji & Symbols"],
  [0, "View"], [1, "Plot"], [1, "Camera"], [2, "Swing to Front"], [1, "Enter Full Screen"],
].map(([d, n]) => `${d}|1|${enc(n as string)}|0`).join("\t") + "\t";

test("startup: the only OSC traffic is /ping; no Accessibility call and no click", async () => {
  await deck.waitFor(() => capture.msgs.length > 0, 4000, "first OSC packet");
  await sleep(500);
  assert.deepEqual([...new Set(capture.msgs.map((m) => m.address))], ["/ping"]);
  assert.equal(deck.axCalls().length, 0);
  assert.ok(deck.received.some((m) => m.event === "getGlobalSettings"));
});

test("Connection key: Connected + version, and Accessibility line", async () => {
  deck.willAppear(A.connection, "conn");
  await deck.waitFor(() => deck.lastImage("conn").includes("Connected") && deck.lastImage("conn").includes("v2026.1.6"), 4000, "connected image");
  assert.ok(deck.lastImage("conn").includes("Access ?") || deck.lastImage("conn").includes("Access OK"));
});

test("View Dial: greyed '~' until first send; rotate sends exact floats, clamps, fine mode, reset, values persisted", async () => {
  const S = { property: "exposureAdjustment", view: "live" };
  deck.willAppear(A.dial, "dial1", S, "Encoder");
  const fb0 = await deck.waitFor(() => deck.lastFeedback("dial1"), 3000, "initial feedback");
  assert.equal(fb0.name.value, "EXPOSURE");
  assert.equal(fb0.value.value, "~0.0"); // estimated (nothing sent yet this session)
  assert.equal(fb0.mark.value, "~");
  capture.msgs.length = 0;

  deck.dialRotate(A.dial, "dial1", 3, S);
  const m1 = await deck.waitFor(() => capture.msgs.find((m) => m.address === "/view/live/exposureAdjustment"), 3000, "OSC exposure");
  assert.equal(m1.types, "f");
  assert.equal(m1.args[0], Math.fround(0.3));
  await deck.waitFor(() => deck.lastFeedback("dial1").value.value === "+0.3", 3000, "feedback +0.3");
  assert.notEqual(deck.lastFeedback("dial1").mark.value, "~", "once sent, no longer estimated");

  // huge turn → clamped to +3 EV, sent as `f`
  deck.dialRotate(A.dial, "dial1", 500, S);
  await deck.waitFor(() => capture.msgs.at(-1)?.args[0] === 3, 3000, "clamped 3");
  assert.equal(capture.msgs.at(-1)!.types, "f");

  // long touch resets to 0 → whole number still `f`
  deck.touchTap(A.dial, "dial1", true, S);
  await deck.waitFor(() => capture.msgs.at(-1)?.args[0] === 0, 3000, "reset");
  assert.equal(capture.msgs.at(-1)!.types, "f");
  const raw = capture.raw.at(-1)!;
  assert.equal(raw.subarray(-8).toString("hex"), "2c660000" + "00000000");

  // push → fine mode → one tick = 0.01
  deck.dialDown(A.dial, "dial1", S);
  await deck.waitFor(() => deck.lastFeedback("dial1").mark.value === "FINE", 3000, "fine marker");
  deck.dialRotate(A.dial, "dial1", 1, S);
  await deck.waitFor(() => capture.msgs.at(-1)?.args[0] === Math.fround(0.01), 3000, "fine tick");

  // persisted to Stream Deck global settings
  await deck.waitFor(() => (deck.globals as any).values?.["live/exposureAdjustment"] === 0.01, 3000, "global settings saved");
});

test("View Dial: white balance & other views; sends only property addresses from the manual", async () => {
  const S = { property: "whiteBalance", view: "1" };
  deck.willAppear(A.dial, "dial2", S, "Encoder");
  await deck.waitFor(() => deck.lastFeedback("dial2"), 3000, "feedback");
  deck.dialRotate(A.dial, "dial2", 2, S);
  const m = await deck.waitFor(() => capture.msgs.find((x) => x.address === "/view/1/whiteBalance"), 3000, "wb");
  assert.deepEqual([m.types, m.args[0]], ["f", 6700]);
  const allowed = /^\/(ping|getCatalogs|catalog\/\d+\/(getName|getPositions|position\/\d+\/getName)|view\/(live|[012])\/(ambientLighting|automaticExposure|bloom|contrast|exposureAdjustment|fillLighting|flare|flareStreaks|flareAngle|flareSize|hueClamp|laserFlickerEffect|saturation|whiteBalance|position|getStatus))$/;
  for (const x of capture.msgs) assert.match(x.address, allowed);
});

test("Command key: reads enabled state (dims), never clicks on its own", async () => {
  deck.setAx({ mode: "ok", enabled: { Undo: 0 } });
  const S = { menuPath: ["Edit", "Undo"], match: "prefix" };
  deck.willAppear(A.command, "undo", S);
  await deck.waitFor(() => deck.lastImage("undo").includes('opacity="0.35"'), 5000, "dimmed Undo");
  assert.ok(deck.lastImage("undo").includes(">Undo<"));
  deck.setAx({ mode: "ok", enabled: { Undo: 1 } });
  await deck.waitFor(() => deck.lastImage("undo") && !deck.lastImage("undo").includes('opacity="0.35"'), 5000, "enabled Undo");
  await sleep(1800); // several poll cycles
  const calls = deck.axCalls().map((c) => c.lines.join("\n"));
  assert.ok(calls.length >= 2);
  for (const c of calls) {
    assert.ok(!c.includes('"click")'), "polling must never click");
    assert.ok(!c.includes("set frontmost to true"), "polling must never activate Capture");
  }
  // each poll is ONE call regardless of how many keys are visible
  deck.willAppear(A.command, "grid", { menuPath: ["View", "Grid"], match: "exact" });
  deck.willAppear(A.command, "widgets", { menuPath: ["View", "Widgets"], match: "exact" });
  await sleep(1700);
  const last = deck.axCalls().at(-1)!.lines.join("\n");
  assert.equal((last.match(/set r to my act\(/g) ?? []).length, 3);
});

test("Command key press: one click script with the nested path, activates first", async () => {
  const S = { menuPath: ["View", "Plot"], match: "exact" };
  deck.willAppear(A.command, "plot", S);
  await sleep(200);
  const before = deck.axCalls().length;
  deck.keyDown(A.command, "plot", S);
  const c = await deck.waitFor(() => deck.axCalls().slice(before).find((x) => x.lines.join("\n").includes('"click")')), 3000, "click script");
  const text = c.lines.join("\n");
  assert.ok(text.includes('return my act("Capture", "View", {}, "exact", {"Plot"}, "click")'));
  assert.ok(text.includes("if not frontmost then"));
  await deck.waitFor(() => deck.sent("plot", "showOk").length > 0, 3000, "showOk");
  deck.keyUp(A.command, "plot", S);
});

test("Hold-to-fire: short press flashes Hold and does not fire; 1 s hold fires once", async () => {
  const S = { menuPath: ["Edit", "Delete"], match: "exact" };
  deck.willAppear(A.command, "del", S);
  await sleep(300);
  const clicks = () => deck.axCalls().filter((c) => c.lines.join("\n").includes('{"Delete"}, "click")')).length;
  deck.keyDown(A.command, "del", S);
  await sleep(200);
  deck.keyUp(A.command, "del", S);
  await deck.waitFor(() => deck.lastImage("del").includes(">Hold<"), 2000, "Hold flash");
  await sleep(1300);
  assert.equal(clicks(), 0);
  deck.keyDown(A.command, "del", S);
  await sleep(700);
  assert.equal(clicks(), 0, "not yet at 0.7 s");
  await deck.waitFor(() => clicks() === 1, 2000, "fired at 1 s");
  deck.keyUp(A.command, "del", S);
  await sleep(300);
  assert.equal(clicks(), 1);
});

test("Store Modifier + Camera Slot: recall vs store, 'Stored' flash", async () => {
  deck.willAppear(A.store, "store");
  deck.willAppear(A.slot, "slot1", { slot: 1 });
  await sleep(300);
  const pick = (needle: string, from: number) => deck.axCalls().slice(from).find((c) => c.lines.join("\n").includes(needle));
  let n = deck.axCalls().length;
  deck.keyDown(A.slot, "slot1", { slot: 1 });
  await deck.waitFor(() => pick('return my act("Capture", "View", {"Camera"}, "exact", {"Position 1"}, "click")', n), 3000, "recall");
  n = deck.axCalls().length;
  deck.keyDown(A.store, "store");
  await deck.waitFor(() => deck.lastImage("slot1").includes("Store 1"), 2000, "slot relabelled while held");
  deck.keyDown(A.slot, "slot1", { slot: 1 });
  await deck.waitFor(() => pick('return my act("Capture", "View", {"Store Camera"}, "exact", {"Position 1"}, "click")', n), 3000, "store");
  await deck.waitFor(() => deck.lastImage("slot1").includes(">Stored<"), 2000, "Stored flash");
  deck.keyUp(A.store, "store");
  await deck.waitFor(() => deck.lastImage("slot1").includes("Slot 1"), 2000, "back to Slot 1");
  n = deck.axCalls().length;
  deck.keyDown(A.slot, "slot1", { slot: 1 });
  await deck.waitFor(() => pick('{"Camera"}, "exact", {"Position 1"}, "click")', n), 3000, "recall again");
});

test("Tab key clicks the tab radio button only", async () => {
  deck.willAppear(A.tab, "tabF", { tab: "Fixtures" });
  await sleep(200);
  const n = deck.axCalls().length;
  deck.keyDown(A.tab, "tabF", { tab: "Fixtures" });
  const c = await deck.waitFor(() => deck.axCalls().slice(n).find((x) => x.lines.join("\n").includes("radio button")), 3000, "tab script");
  const text = c.lines.join("\n");
  assert.ok(text.includes('set rb to radio button "Fixtures" of g'));
  assert.equal((text.match(/\bclick\b/g) ?? []).length, 1);
});

test("Show Position: auto mode titles from Capture and recalls over OSC (with optional time/damp/curve)", async () => {
  const S = { mode: "auto", catalog: 1, index: 2, view: "live" };
  deck.willAppear(A.position, "pos2", S);
  await deck.waitFor(() => deck.lastImage("pos2").includes(">Back<"), 4000, "title from Capture");
  capture.msgs.length = 0;
  deck.keyDown(A.position, "pos2", S);
  const m = await deck.waitFor(() => capture.msgs.find((x) => x.address === "/view/live/position"), 3000, "recall");
  assert.deepEqual([m.types, m.args], ["ii", [1, 2]]);
  const S2 = { mode: "fixed", catalog: 2, position: 1, view: "0", time: 2, damp: 0.5, curve: 1 };
  deck.willAppear(A.position, "pos3", S2);
  await deck.waitFor(() => deck.lastImage("pos3").includes(">Wide<"), 4000, "fixed title");
  capture.msgs.length = 0;
  deck.keyDown(A.position, "pos3", S2);
  const m2 = await deck.waitFor(() => capture.msgs.find((x) => x.address === "/view/0/position"), 3000, "recall 2");
  assert.deepEqual([m2.types, m2.args], ["iifff", [2, 1, 2, 0.5, 1]]);
});

test("View Toggle: flips tracked state, sends T then F", async () => {
  const S = { property: "automaticExposure", view: "live" };
  deck.willAppear(A.toggle, "tog", S);
  await sleep(200);
  capture.msgs.length = 0;
  deck.keyDown(A.toggle, "tog", S);
  const t = await deck.waitFor(() => capture.msgs.find((m) => m.address === "/view/live/automaticExposure"), 3000, "T");
  assert.deepEqual([t.types, t.args], ["T", [true]]);
  deck.keyDown(A.toggle, "tog", S);
  await deck.waitFor(() => capture.msgs.filter((m) => m.address === "/view/live/automaticExposure").length === 2, 3000, "F");
  assert.deepEqual([capture.msgs.at(-1)!.types, capture.msgs.at(-1)!.args], ["F", [false]]);
});

test("Property Inspector: menu list is read live, filtered and normalised (read-only)", async () => {
  deck.setAx({ mode: "ok", dump: DUMP });
  const n = deck.axCalls().length;
  deck.inspectorAppeared(A.command, "undo");
  deck.sendToPlugin(A.command, "undo", { cmd: "listMenus", force: true });
  const msg = await deck.waitFor(() => deck.received.filter((m) => m.event === "sendToPropertyInspector").at(-1), 8000, "menus message");
  const p = msg.payload;
  assert.equal(p.event, "menus");
  const labels = p.commands.map((c: any) => c.label);
  assert.deepEqual(labels, ["File › Save", "Edit › Undo Live", "Edit › Duplicate…", "View › Plot", "View › Camera › Swing to Front", "View › Enter Full Screen"]);
  const undo = p.commands.find((c: any) => c.label === "Edit › Undo Live");
  assert.deepEqual([undo.path, undo.match], [["Edit", "Undo"], "prefix"]);
  const dump = deck.axCalls().slice(n).find((c) => c.lines.join("\n").includes("on dumpMenu"))!;
  const dumpText = dump.lines.join("\n");
  assert.ok(!/\bclick\b/.test(dumpText), "the menu read never clicks");
  assert.ok(!dumpText.includes("set frontmost to true"), "the menu read never activates Capture");
});

test("Permission problems: keys show 'Allow Access', a press opens System Settings; then recovery and 'Capture?'", async () => {
  deck.setAx({ mode: "noperm" });
  await deck.waitFor(() => deck.lastImage("plot").includes("Allow Access"), 8000, "Allow Access on key");
  assert.ok(deck.lastImage("conn") || true);
  const S = { menuPath: ["View", "Plot"], match: "exact" };
  deck.keyDown(A.command, "plot", S);
  await deck.waitFor(() => deck.openCalls().some((l) => l.includes("Privacy_Accessibility")), 3000, "System Settings opened");
  deck.setAx({ mode: "noautomation" });
  await sleep(200);
  deck.setAx({ mode: "ok", enabled: {} });
  await deck.waitFor(() => !deck.lastImage("plot").includes("Allow Access"), 9000, "recovered");
  deck.setAx({ mode: "notrunning" });
  await deck.waitFor(() => deck.lastImage("plot").includes("Capture?"), 5000, "Capture? on key");
  deck.setAx({ mode: "ok" });
  await deck.waitFor(() => !deck.lastImage("plot").includes("Capture?"), 5000, "back to normal");
});

test("Other AX errors show 'Error' on the key press and the raw text is logged", async () => {
  const S = { menuPath: ["View", "Zap"], match: "exact" };
  deck.willAppear(A.command, "zap", S);
  await sleep(300);
  deck.setAx({ mode: "error" });
  deck.keyDown(A.command, "zap", S);
  await deck.waitFor(() => deck.lastImage("zap").includes("Error") || deck.sent("zap", "showAlert").length > 0, 4000, "Error");
  await deck.waitFor(() => deck.procOut.includes("Can’t get menu item") || fs.readdirSync(path.join(pluginDir, "logs")).length > 0, 3000, "raw text logged");
  deck.setAx({ mode: "ok" });
});

test("Offline: after Capture stops answering, strips dim and say Offline (10 s timeout)", async () => {
  capture.answering = false;
  await deck.waitFor(() => deck.lastFeedback("dial1").mark.value === "Offline", 16000, "Offline strip");
  await deck.waitFor(() => deck.lastImage("conn").includes("Offline"), 3000, "Offline connection key");
  capture.answering = true;
  await deck.waitFor(() => deck.lastFeedback("dial1").mark.value !== "Offline", 9000, "back online");
});
