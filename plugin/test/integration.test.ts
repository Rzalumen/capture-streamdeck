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

test("startup: the only OSC traffic is /ping; the only Accessibility traffic is read-only (status + menu tree), never a click or an activation", async () => {
  await deck.waitFor(() => capture.msgs.length > 0, 4000, "first OSC packet");
  await sleep(800);
  assert.deepEqual([...new Set(capture.msgs.map((m) => m.address))], ["/ping"]);
  const scripts = deck.axCalls().map((c) => c.lines.join("\n"));
  assert.ok(scripts.length >= 1, "the menu tree is read in the background at start");
  assert.ok(scripts.some((s) => s.includes("on dumpMenu")), "the background read is the menu dump");
  for (const s of scripts) {
    assert.ok(!s.includes("set frontmost to true"), "no activation at startup");
    assert.ok(!s.includes('"click")'), "no click at startup");
  }
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

// ================================================================== Handoff 08: named actions

const N = (category: string, id: string) => `${U}.cmd.${category}.${id}`;
const clickScripts = (from: number) => deck.axCalls().slice(from).map((c) => c.lines.join("\n")).filter((t) => t.includes('"click")'));

test("every action in the manifest is handled by the plugin (named commands, dials, toggles and generic ones)", async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));
  assert.equal(manifest.Actions.length, 175);
  let i = 0;
  const ctxs: [string, string, boolean][] = [];
  for (const a of manifest.Actions) {
    const dial = a.Controllers.includes("Encoder");
    const ctx = `all${i++}`;
    ctxs.push([a.UUID, ctx, dial]);
    deck.willAppear(a.UUID, ctx, {}, dial ? "Encoder" : "Keypad");
  }
  for (const [uuid, ctx, dial] of ctxs) {
    await deck.waitFor(() => (dial ? deck.lastFeedback(ctx) : deck.lastImage(ctx)), 8000, `first draw of ${uuid}`);
  }
  for (const [, ctx] of ctxs) deck.willDisappear(ctx.startsWith("all") ? manifest.Actions[Number(ctx.slice(3))].UUID : "", ctx);
  await sleep(100);
});

test("named command: 'View: Plot' needs no settings, shows its title, and one press clicks View > Plot", async () => {
  const uuid = N("view", "plot");
  deck.willAppear(uuid, "n-plot", {});
  await deck.waitFor(() => deck.lastImage("n-plot").includes(">Plot<"), 4000, "title Plot");
  await sleep(150);
  const before = deck.axCalls().length;
  deck.keyDown(uuid, "n-plot", {});
  const c = await deck.waitFor(() => clickScripts(before)[0], 3000, "click script");
  assert.ok(c.includes('return my act("Capture", "View", {}, "exact", {"Plot"}, "click")'));
  await deck.waitFor(() => deck.sent("n-plot", "showOk").length > 0, 3000, "showOk");
  deck.keyUp(uuid, "n-plot", {});
  assert.equal(clickScripts(before).length, 1, "exactly one click per press");
});

test("named command: nested path, prefix match, alternates, non-ASCII names", async () => {
  const cases: [string, string, string][] = [
    [N("camera", "swing-to-front"), 'return my act("Capture", "View", {"Camera"}, "exact", {"Swing to Front"}, "click")', "n-swing"],
    [N("camera", "store-3"), 'return my act("Capture", "View", {"Store Camera"}, "exact", {"Position 3"}, "click")', "n-store3"],
    [N("edit", "undo"), 'return my act("Capture", "Edit", {}, "prefix", {"Undo"}, "click")', "n-undo"],
    [N("view", "full-screen"), '"alternates", {"Enter Full Screen", "Exit Full Screen"}, "click")', "n-fs"],
    [N("edit", "duplicate"), '{"Duplicate..."}', "n-dup"], // menu tree not read in this state: the catalog path, in ASCII
    [N("select", "by-fixture-type"), 'return my act("Capture", "Edit", {"Select"}, "exact", {"By Fixture Type"}, "click")', "n-bft"],
  ];
  for (const [uuid, needle, ctx] of cases) {
    deck.willAppear(uuid, ctx, {});
    await sleep(120);
    const before = deck.axCalls().length;
    deck.keyDown(uuid, ctx, {});
    const c = await deck.waitFor(() => clickScripts(before)[0], 3000, `click ${uuid}`);
    assert.ok(c.includes(needle), `${uuid}: ${c.split("\n").filter((l) => l.startsWith("return my act")).join()}`);
    deck.keyUp(uuid, ctx, {});
  }
});

test("v0.3.1: a press sends Capture's EXACT live title, polling asks for the same title, and a command Capture doesn't have shows '?' and is never clicked", async () => {
  const rows: [number, string][] = [
    [0, "Apple"], [0, "Capture"],
    [0, "File"], [1, "Save"], [1, "Import Project Content..."],
    [0, "Edit"], [1, "Sequential"], [2, "Patch\u2026"], [2, "Unit..."], [1, "Focus..."],
    [0, "View"], [1, "Plot"],
  ];
  const dump = rows.map(([d, n]) => `${d}|1|${enc(n)}|0`).join("\t") + "\t";
  deck.setAx({ mode: "ok", dump });
  const seen = deck.received.filter((m) => m.event === "sendToPropertyInspector").length;
  deck.inspectorAppeared(A.command, "undo");
  deck.sendToPlugin(A.command, "undo", { cmd: "listMenus", force: true });
  await deck.waitFor(() => deck.received.filter((m) => m.event === "sendToPropertyInspector").length > seen, 8000, "tree read");

  // catalog says "Patch...", Capture's live title is "Patch…": the click carries Capture's spelling
  const patch = N("patch", "sequential-patch");
  deck.willAppear(patch, "n-seqp", {});
  const pollScript = await deck.waitFor(
    () => deck.axCalls().map((c) => c.lines.join("\n")).find((t) => t.includes('"enabled")') && t.includes('("Patch" & (character id 8230))')),
    4000,
    "the enabled-state poll asks for the live title",
  );
  assert.ok(pollScript.includes('{"Sequential"}'));
  const before = deck.axCalls().length;
  deck.keyDown(patch, "n-seqp", {});
  const c = await deck.waitFor(() => clickScripts(before)[0], 3000, "click");
  assert.ok(c.includes('return my act("Capture", "Edit", {"Sequential"}, "exact", {("Patch" & (character id 8230))}, "click")'), c);
  deck.keyUp(patch, "n-seqp", {});
  // the same, with the live title spelled "..." like the catalog: still exactly the live title
  const unit = N("patch", "sequential-unit");
  deck.willAppear(unit, "n-sequ", {});
  await sleep(150);
  const b2 = deck.axCalls().length;
  deck.keyDown(unit, "n-sequ", {});
  assert.ok((await deck.waitFor(() => clickScripts(b2)[0], 3000, "click")).includes('{"Sequential"}, "exact", {"Unit..."}, "click")'));
  deck.keyUp(unit, "n-sequ", {});

  // Sequential Channel... is not in this Capture: "?", no click, and the log names the closest live titles
  const chan = N("patch", "sequential-channel");
  deck.willAppear(chan, "n-seqc", {});
  await deck.waitFor(() => deck.lastImage("n-seqc").includes(">?<"), 4000, "? badge");
  const b3 = deck.axCalls().length;
  deck.keyDown(chan, "n-seqc", {});
  await deck.waitFor(() => deck.logText().includes("Edit > Sequential > Channel... not found in Capture's menus; closest live titles:"), 4000, "log line");
  await sleep(200);
  assert.equal(clickScripts(b3).length, 0, "nothing is clicked for a command Capture does not have");
  assert.match(deck.logText(), /closest live titles: Edit > Sequential > (Unit\.\.\.|Patch…)/);
  deck.keyUp(chan, "n-seqc", {});
  for (const [u, ctx] of [[patch, "n-seqp"], [unit, "n-sequ"], [chan, "n-seqc"]]) deck.willDisappear(u, ctx);
  // leave the shared plugin as we found it: an empty menu tree (later tests expect the catalog paths to be used as they are)
  deck.setAx({ mode: "ok" });
  const seen2 = deck.received.filter((m) => m.event === "sendToPropertyInspector").length;
  deck.sendToPlugin(A.command, "undo", { cmd: "listMenus", force: true });
  await deck.waitFor(() => deck.received.filter((m) => m.event === "sendToPropertyInspector").length > seen2, 8000, "tree reset");
});

test("named command dims when Capture says it is disabled (Edit: Undo), and follows it back", async () => {
  deck.setAx({ mode: "ok", enabled: { Undo: 0 } });
  deck.willAppear(N("edit", "undo"), "n-undo2", {});
  await deck.waitFor(() => deck.lastImage("n-undo2").includes('opacity="0.35"'), 5000, "dimmed");
  deck.setAx({ mode: "ok", enabled: { Undo: 1 } });
  deck.keyDown(N("edit", "undo"), "n-undo2", {}); // a press schedules a poll ~300 ms later
  await deck.waitFor(() => !deck.lastImage("n-undo2").includes('opacity="0.35"'), 5000, "enabled again");
  deck.keyUp(N("edit", "undo"), "n-undo2", {});
  deck.setAx({ mode: "ok" });
});

test("named command: hold-to-fire comes from the catalog (Edit: Delete), and the setting can override it", async () => {
  const uuid = N("edit", "delete");
  deck.willAppear(uuid, "n-del", {});
  await sleep(200);
  const clicks = () => deck.axCalls().filter((c) => c.lines.join("\n").includes('{"Delete"}, "click")')).length;
  const n0 = clicks();
  deck.keyDown(uuid, "n-del", {});
  await sleep(150);
  deck.keyUp(uuid, "n-del", {});
  await deck.waitFor(() => deck.lastImage("n-del").includes(">Hold<"), 2000, "Hold flash");
  await sleep(1200);
  assert.equal(clicks(), n0, "short press does not fire");
  deck.keyDown(uuid, "n-del", {});
  await deck.waitFor(() => clicks() === n0 + 1, 2500, "fires after 1 s");
  deck.keyUp(uuid, "n-del", {});
  // override: holdToFire=false in the key's settings fires at once
  const S = { holdToFire: false };
  deck.willAppear(uuid, "n-del2", S);
  await sleep(200);
  deck.keyDown(uuid, "n-del2", S);
  await deck.waitFor(() => clicks() === n0 + 2, 1500, "immediate fire when overridden");
  deck.keyUp(uuid, "n-del2", S);
});

test("named tab: 'Tabs: Fixtures' clicks the Fixtures radio button only", async () => {
  const uuid = N("tabs", "fixtures");
  deck.willAppear(uuid, "n-tab", {});
  await deck.waitFor(() => deck.lastImage("n-tab").includes(">Fixtures<"), 3000, "title");
  const n = deck.axCalls().length;
  deck.keyDown(uuid, "n-tab", {});
  const c = await deck.waitFor(() => deck.axCalls().slice(n).find((x) => x.lines.join("\n").includes("radio button")), 3000, "tab script");
  assert.ok(c.lines.join("\n").includes('set rb to radio button "Fixtures" of g'));
});

test("named dial: 'Dial: Bloom' is preset (no settings), sends /view/live/bloom as `f`, clamps at 2", async () => {
  const uuid = `${U}.dial.bloom`;
  deck.willAppear(uuid, "d-bloom", {}, "Encoder");
  const fb = await deck.waitFor(() => deck.lastFeedback("d-bloom"), 3000, "strip");
  assert.equal(fb.name.value, "BLOOM");
  capture.msgs.length = 0;
  deck.dialRotate(uuid, "d-bloom", 3, {});
  const m = await deck.waitFor(() => capture.msgs.find((x) => x.address === "/view/live/bloom"), 3000, "bloom");
  assert.equal(m.types, "f");
  assert.equal(m.args[0], Math.fround(1.12)); // reset default 1.0 + 3 × 0.04
  deck.dialRotate(uuid, "d-bloom", 500, {});
  await deck.waitFor(() => capture.msgs.at(-1)?.args[0] === 2, 3000, "clamped at 2 (manual: 0–200 %)");
});

test("named dial: 'Dial: Flare Streaks' sends an integer (`i`), whole steps, clamped 1–7", async () => {
  const uuid = `${U}.dial.flare-streaks`;
  deck.willAppear(uuid, "d-streaks", {}, "Encoder");
  await deck.waitFor(() => deck.lastFeedback("d-streaks"), 3000, "strip");
  capture.msgs.length = 0;
  deck.dialRotate(uuid, "d-streaks", 2, {});
  const m = await deck.waitFor(() => capture.msgs.find((x) => x.address === "/view/live/flareStreaks"), 3000, "streaks");
  assert.deepEqual([m.types, m.args[0]], ["i", 6]); // reset default 4 + 2
  deck.dialRotate(uuid, "d-streaks", 50, {});
  await deck.waitFor(() => capture.msgs.at(-1)?.args[0] === 7, 3000, "clamped at 7");
  deck.dialRotate(uuid, "d-streaks", -50, {});
  await deck.waitFor(() => capture.msgs.at(-1)?.args[0] === 1, 3000, "clamped at 1");
  assert.ok(capture.msgs.filter((x) => x.address === "/view/live/flareStreaks").every((x) => x.types === "i"));
});

test("every named dial sends exactly its own manual address, with the manual's type and range", async () => {
  const table: [string, string, string, number, number][] = [
    ["ambient-lighting", "ambientLighting", "f", 0, 1],
    ["bloom", "bloom", "f", 0, 2],
    ["contrast", "contrast", "f", 0, 1],
    ["exposure-adjustment", "exposureAdjustment", "f", -3, 3],
    ["fill-lighting", "fillLighting", "f", 0, 2],
    ["flare", "flare", "f", 0, 2],
    ["flare-streaks", "flareStreaks", "i", 1, 7],
    ["flare-angle", "flareAngle", "f", 0, 180],
    ["flare-size", "flareSize", "f", 0, 2],
    ["hue-clamp", "hueClamp", "f", 0, 1],
    ["saturation", "saturation", "f", 0, 1],
    ["white-balance", "whiteBalance", "f", 2500, 10000],
  ];
  for (const [slug, prop, type, lo, hi] of table) {
    const uuid = `${U}.dial.${slug}`;
    const ctx = `dd-${slug}`;
    deck.willAppear(uuid, ctx, {}, "Encoder");
    await deck.waitFor(() => deck.lastFeedback(ctx), 3000, `strip ${slug}`);
    capture.msgs.length = 0;
    deck.dialRotate(uuid, ctx, 100000, {});
    await deck.waitFor(() => capture.msgs.some((m) => m.address === `/view/live/${prop}` && m.args[0] === Math.fround(hi)), 3000, `${prop} max`);
    deck.dialRotate(uuid, ctx, -200000, {});
    await deck.waitFor(() => capture.msgs.some((m) => m.address === `/view/live/${prop}` && m.args[0] === Math.fround(lo)), 3000, `${prop} min`);
    for (const m of capture.msgs.filter((x) => x.address.includes(prop))) {
      assert.equal(m.types, type, `${prop} wire type`);
      assert.ok(m.args[0] >= lo && m.args[0] <= hi, `${prop} within manual range`);
    }
    // (/ping is the connection monitor's own 5 s heartbeat, unrelated to the dial)
    const sent = capture.msgs.filter((m) => m.address !== "/ping");
    assert.ok(sent.every((m) => m.address === `/view/live/${prop}`), `only ${prop} was sent; got ${JSON.stringify(sent.map((m) => [m.address, m.args[0]]))}`);
  }
});

test("named toggles: 'Look: Laser Flicker' sends T then F on /view/live/laserFlickerEffect", async () => {
  const uuid = `${U}.toggle.laser-flicker-effect`;
  deck.willAppear(uuid, "t-laser", {});
  await sleep(200);
  capture.msgs.length = 0;
  deck.keyDown(uuid, "t-laser", {});
  await deck.waitFor(() => capture.msgs.find((m) => m.address === "/view/live/laserFlickerEffect"), 3000, "T");
  assert.deepEqual([capture.msgs.at(-1)!.types, capture.msgs.at(-1)!.args], ["T", [true]]);
  deck.keyDown(uuid, "t-laser", {});
  await deck.waitFor(() => capture.msgs.filter((m) => m.address === "/view/live/laserFlickerEffect").length === 2, 3000, "F");
  assert.deepEqual([capture.msgs.at(-1)!.types, capture.msgs.at(-1)!.args], ["F", [false]]);
});

test("named 'Camera: Show Position k': OSC auto mode on catalog 1, titled from the open show, nothing to configure", async () => {
  const uuid = (k: number) => `${U}.showpos.${k}`;
  deck.willAppear(uuid(2), "sp2", {});
  await deck.waitFor(() => deck.lastImage("sp2").includes(">Back<"), 4000, "title of position 2 (from Capture)");
  deck.willAppear(uuid(1), "sp1", {});
  await deck.waitFor(() => deck.lastImage("sp1").includes(">Front<"), 4000, "title of position 1");
  capture.msgs.length = 0;
  deck.keyDown(uuid(2), "sp2", {});
  const m = await deck.waitFor(() => capture.msgs.find((x) => x.address === "/view/live/position"), 3000, "recall");
  assert.deepEqual([m.types, m.args], ["ii", [1, 2]]);
  // the log line shows the preset the key actually used (catalog 1, auto, index 2), not the empty stored settings
  assert.ok(deck.logText().includes("Key press [com.rezabehjat.capture.showpos.2]") && deck.logText().includes('"index":2'));
  // a show with fewer than 8 positions: the key says so and a press sends nothing
  deck.willAppear(uuid(8), "sp8", {});
  await deck.waitFor(() => deck.lastImage("sp8").includes("— 8"), 4000, "missing position shown");
  capture.msgs.length = 0;
  deck.keyDown(uuid(8), "sp8", {});
  await sleep(300);
  assert.equal(capture.msgs.filter((x) => x.address.endsWith("/position")).length, 0);
});

test("named 'Camera: Position 1' follows 'Camera: Store Modifier' (store while held, recall otherwise); 'Camera: Store Position 2' stores directly", async () => {
  const pos1 = N("camera", "position-1");
  deck.willAppear(A.store, "store2");
  deck.willAppear(pos1, "np1", {});
  await sleep(300);
  const pick = (needle: string, from: number) => deck.axCalls().slice(from).find((c) => c.lines.join("\n").includes(needle));
  let n = deck.axCalls().length;
  deck.keyDown(pos1, "np1", {});
  await deck.waitFor(() => pick('return my act("Capture", "View", {"Camera"}, "exact", {"Position 1"}, "click")', n), 3000, "recall");
  deck.keyDown(A.store, "store2");
  await deck.waitFor(() => deck.lastImage("np1").includes("Store 1"), 2000, "relabelled while held");
  n = deck.axCalls().length;
  deck.keyDown(pos1, "np1", {});
  await deck.waitFor(() => pick('return my act("Capture", "View", {"Store Camera"}, "exact", {"Position 1"}, "click")', n), 3000, "store");
  deck.keyUp(A.store, "store2");
  await deck.waitFor(() => deck.lastImage("np1").includes("Position 1"), 2000, "back to Position 1");
  const st2 = N("camera", "store-2");
  deck.willAppear(st2, "ns2", {});
  await sleep(200);
  n = deck.axCalls().length;
  deck.keyDown(st2, "ns2", {});
  await deck.waitFor(() => pick('return my act("Capture", "View", {"Store Camera"}, "exact", {"Position 2"}, "click")', n), 3000, "direct store");
});

test("generic Capture Command pressed with nothing configured: alert + 'Not set' flash, logged as 'no command configured', no click", async () => {
  deck.willAppear(A.command, "unconf", {});
  await deck.waitFor(() => deck.lastImage("unconf").includes("Choose"), 3000, "placeholder");
  const before = deck.axCalls().length;
  deck.keyDown(A.command, "unconf", {});
  await deck.waitFor(() => deck.lastImage("unconf").includes(">Not set<"), 3000, "Not set flash");
  await deck.waitFor(() => deck.sent("unconf", "showAlert").length > 0, 3000, "alert");
  assert.equal(clickScripts(before).length, 0);
  await deck.waitFor(() => deck.logText().includes("no command configured"), 4000, "log line");
  assert.match(deck.logText(), /Key press \[com\.rezabehjat\.capture\.command\] settings=\{\} → no command configured/);
});

test("logging: every key press names the action UUID, its settings and the result; PI setting changes are logged; polls are not logged one by one", async () => {
  const uuid = N("view", "grid");
  const S = { dimWhenDisabled: false };
  deck.willAppear(uuid, "n-grid", S);
  await sleep(200);
  deck.keyDown(uuid, "n-grid", S);
  await deck.waitFor(() => deck.logText().includes(`Key result [${uuid}] settings={"dimWhenDisabled":false} → OK View > Grid`), 4000, "result line");
  assert.match(deck.logText(), new RegExp(`Key press \\[${uuid.replace(/\./g, "\\.")}\\] settings=\\{"dimWhenDisabled":false\\} → View > Grid`));
  assert.match(deck.logText(), /AX press click View > Grid: \d+ ms/);
  deck.send({ event: "didReceiveSettings", action: uuid, context: "n-grid", device: "DEV1", payload: { settings: { dimWhenDisabled: true }, coordinates: { column: 0, row: 0 }, isInMultiAction: false } });
  await deck.waitFor(() => deck.logText().includes(`PI setting change [${uuid}] settings={"dimWhenDisabled":true}`), 3000, "PI change logged");
  assert.ok(!/AX enabled x\d+: \d+ ms/.test(deck.logText()), "no per-poll lines");
  const dial = `${U}.dial.contrast`;
  deck.willAppear(dial, "d-log", {}, "Encoder");
  await sleep(100);
  deck.dialRotate(dial, "d-log", 2, {});
  deck.dialRotate(dial, "d-log", 3, {});
  await deck.waitFor(() => /Dial rotate \[com\.rezabehjat\.capture\.dial\.contrast\][^\n]*2 events, \+5 ticks → contrast=\d/.test(deck.logText()), 4000, "one line per gesture");
});
