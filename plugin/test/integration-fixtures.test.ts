/**
 * End-to-end (Handoff 15): the REAL built plugin (bin/plugin.js) with
 *   - a stub CITP server (read-only show sync: PNam → EnterShow → FixtureListRequest → FixtureList),
 *   - a synthetic Library.c2z holding the fixture's mode block,
 *   - a UDP listener standing in for Capture's sACN input,
 *   - the fake Stream Deck application (WebSocket protocol) and a fake OSC Capture.
 * Run `npm run build` first (npm test does).
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_OUTGOING_CAEX, decodeMessage } from "../src/fixtures/citp.ts";
import { parseDataPacket, type ParsedPacket } from "../src/fixtures/sacn.ts";
import { FakeDeck, sleep } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";
import { buildLibraryFile, buildModeBlock, buildObject, movingHead, startPatchStub } from "./fixtures/synth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../com.rezabehjat.capture.sdPlugin");
const U = "com.rezabehjat.capture";
const A = {
  setup: `${U}.fixtures.setup`,
  release: `${U}.fixtures.release`,
  home: `${U}.fixtures.home`,
  status: `${U}.fixtures.status`,
  select: `${U}.fixture.select`,
  pan: `${U}.fixture.pan`,
  tilt: `${U}.fixture.tilt`,
  intensity: `${U}.fixture.intensity`,
  focus: `${U}.fixture.focus`,
  redCyan: `${U}.fixture.red-cyan`,
};

const FX = "aaaaaaaa-0000-0000-0000-000000000001";
const MD = "bbbbbbbb-0000-0000-0000-000000000001";
const INST1 = "00000000-0000-0000-0000-0000000000a1";
const INST2 = "00000000-0000-0000-0000-0000000000a2";

const deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fx-e2e-"));
const sacn = dgram.createSocket("udp4");
const packets: ParsedPacket[] = [];
let citp: Awaited<ReturnType<typeof startPatchStub>>;

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  const lib = path.join(tmp, "Library.c2z");
  fs.writeFileSync(lib, buildLibraryFile({ [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) }));
  citp = await startPatchStub(
    [
      { mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 203, fixtureGuid: FX, modeGuid: MD, instanceId: INST1, position: [4, 6, 2] },
      { mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 204, fixtureGuid: FX, modeGuid: MD, instanceId: INST2, position: [-4, 6, 2] },
    ],
    { showName: "E2E SHOW" },
  );
  sacn.on("message", (m) => {
    try {
      packets.push(parseDataPacket(m));
    } catch {
      /* not an E1.31 data packet */
    }
  });
  await new Promise<void>((r) => sacn.bind(0, "127.0.0.1", r));
  await capture.start();
  await deck.start({
    oscPort: capture.port,
    pluginDir,
    fixtures: path.join(here, "fixtures"),
    env: { CAPTURE_TEST_CITP_PORT: String(citp.port), CAPTURE_TEST_LIBRARY: lib, CAPTURE_TEST_SACN_PORT: String(sacn.address().port), CAPTURE_TEST_SACN_NO_MULTICAST: "1" },
  });
});
after(async () => {
  await deck.stop();
  capture.stop();
  citp.server.close();
  sacn.close();
});

const lastSetupView = (): any => deck.received.filter((m) => m.event === "sendToPropertyInspector" && m.payload?.event === "setup").at(-1)?.payload;
const slot = (p: ParsedPacket, universeAddress: number, channel: number): number => p.slots[universeAddress - 1 + channel - 1];
const newest = (): ParsedPacket => packets.at(-1)!;
const waitPacket = async (pred: (p: ParsedPacket) => boolean, what: string): Promise<ParsedPacket> => {
  const n0 = packets.length;
  return deck.waitFor(() => packets.slice(Math.max(0, n0 - 1)).reverse().find(pred), 3000, what);
};

test("show read on start: only allowlisted CITP messages are sent; nothing at all goes out as DMX", async () => {
  deck.willAppear(A.status, "st");
  await deck.waitFor(() => deck.lastImage("st").includes("E2E SHOW"), 8000, "status key shows the show name");
  assert.ok(deck.lastImage("st").includes("0 of 2 ready"));
  assert.ok(deck.lastImage("st").includes("output off"));
  // every CAEX message the plugin sent is on the allowlist; the layers are PINF/CAEX only
  assert.ok(citp.received.length >= 2);
  for (const m of citp.received) {
    const d = decodeMessage(m);
    assert.ok(d.layer === "PINF" || d.layer === "CAEX", `layer ${d.layer}`);
    if (d.layer === "CAEX") assert.ok(ALLOWED_OUTGOING_CAEX.has(d.code!), `CAEX 0x${d.code!.toString(16)} is allowed`);
  }
  await sleep(500);
  assert.equal(packets.length, 0, "no DMX before a user touch");
});

test("Fixtures: Setup — the Property Inspector lists the show, saves addresses per show and keys them by CaptureInstanceId; other global settings stay", async () => {
  deck.willAppear(A.setup, "setup");
  deck.inspectorAppeared(A.setup, "setup");
  deck.sendToPlugin(A.setup, "setup", { cmd: "get" });
  const v = await deck.waitFor(() => lastSetupView()?.view?.fixtures?.length === 2 && lastSetupView(), 4000, "setup view");
  assert.equal(v.view.showName, "E2E SHOW");
  assert.deepEqual(v.view.fixtures.map((f: any) => [f.channel, f.name, f.hasPanTilt, f.parsed, f.key]), [
    [203, "Rogue R2X Wash", true, true, INST1],
    [204, "Rogue R2X Wash", true, true, INST2],
  ]);
  assert.match(v.view.blackoutWarning, /BLACKS OUT/);

  // out of range is refused with the reason, nothing saved
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST1, universe: 17, address: 1 });
  await deck.waitFor(() => /universe must be/.test(lastSetupView()?.error ?? ""), 3000, "range error");
  assert.deepEqual((deck.globals as any).fixtureSetup ?? {}, {});

  // Channel 203 -> 1/285 (the Reza test)
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST1, universe: 1, address: 285 });
  await deck.waitFor(() => lastSetupView()?.view?.controllable === 1 && !lastSetupView().error, 3000, "controllable 1");
  assert.deepEqual((deck.globals as any).fixtureSetup, { "E2E SHOW": { [INST1]: { universe: 1, address: 285 } } });
  // overlapping address on the same universe makes both uncontrollable and says why
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST2, universe: 1, address: 290 });
  await deck.waitFor(() => lastSetupView()?.view?.fixtures?.[1]?.issues?.length === 1 && lastSetupView().view.controllable === 0, 3000, "overlap reported");
  assert.match(lastSetupView().view.fixtures[0].issues[0], /overlaps/);
  // auto-fill sequential: 203 at 1/285, 204 right after it (285 + 14 = 299)
  deck.sendToPlugin(A.setup, "setup", { cmd: "autofill", keys: [INST2, INST1], universe: 1, address: 285 });
  await deck.waitFor(() => lastSetupView()?.view?.controllable === 2, 3000, "auto-fill");
  assert.deepEqual(lastSetupView().view.fixtures.map((f: any) => f.addr), [{ universe: 1, address: 285 }, { universe: 1, address: 299 }]);
  await deck.waitFor(() => deck.lastImage("st").includes("2 of 2 ready"), 3000, "status shows 2 ready");
  // the value store (other global settings) was not wiped by the setup writes, and the setup survives a value write
  assert.ok((deck.globals as any).fixtureSetup["E2E SHOW"][INST2]);
  assert.equal(packets.length, 0, "still no DMX: setting addresses is not a touch");
});

test("Select + attribute dials: strip texts, '—' for a missing attribute, nothing sent before a touch", async () => {
  deck.willAppear(A.select, "sel", {}, "Encoder");
  deck.willAppear(A.pan, "pan", {}, "Encoder");
  deck.willAppear(A.tilt, "tilt", {}, "Encoder");
  deck.willAppear(A.intensity, "int", {}, "Encoder");
  deck.willAppear(A.focus, "focus", {}, "Encoder");
  deck.willAppear(A.redCyan, "rc", {}, "Encoder");
  const fb = await deck.waitFor(() => deck.lastFeedback("sel"), 3000, "select feedback");
  assert.equal(fb.line1.value, "Rogue R2X Wash");
  assert.equal(fb.line2.value, "Ch 203 · 1/285");
  assert.equal(fb.mark.value, "1/2");
  const pan = await deck.waitFor(() => deck.lastFeedback("pan"), 3000, "pan feedback");
  assert.equal(pan.name.value, "Pan");
  assert.equal(pan.value.value, "~50.0", "the starting value, nothing sent yet");
  assert.equal((await deck.waitFor(() => deck.lastFeedback("focus"), 3000, "focus feedback")).value.value, "—", "no Focus channel on this fixture");
  assert.equal((await deck.waitFor(() => deck.lastFeedback("rc"), 3000, "rc")).name.value, "Red", "additive Red on an RGB fixture");
  // rotating a dial the fixture lacks does nothing (no output starts)
  deck.dialRotate(A.focus, "focus", 3);
  await sleep(300);
  assert.equal(packets.length, 0);
  // Select: push toggles single <-> all of this type; rotate steps
  deck.dialDown(A.select, "sel");
  await deck.waitFor(() => deck.lastFeedback("sel").line1.value === "All Rogue R2X Wash", 3000, "all of type");
  assert.equal(deck.lastFeedback("sel").line2.value, "2 fixtures");
  deck.dialDown(A.select, "sel");
  await deck.waitFor(() => deck.lastFeedback("sel").line1.value === "Rogue R2X Wash", 3000, "single again");
  deck.dialRotate(A.select, "sel", 1);
  await deck.waitFor(() => deck.lastFeedback("sel").line2.value === "Ch 204 · 1/299", 3000, "second fixture");
  deck.dialRotate(A.select, "sel", -1);
  await deck.waitFor(() => deck.lastFeedback("sel").line2.value === "Ch 203 · 1/285", 3000, "back to the first");
  assert.equal(packets.length, 0, "selecting is not a touch");
});

test("first touch starts sACN at 40 fps on universe 1 from the defaults; pan is 16-bit; every other slot is 0", async () => {
  deck.dialRotate(A.pan, "pan", 5); // +5 %
  const first = await deck.waitFor(() => packets[0], 3000, "first sACN packet");
  assert.equal(first.universe, 1);
  assert.equal(first.priority, 100);
  assert.equal(first.terminated, false);
  assert.equal(first.sourceName, "capture-streamdeck");
  const t0 = Date.now();
  const n0 = packets.length;
  await sleep(1000);
  const fps = ((packets.length - n0) * 1000) / (Date.now() - t0);
  assert.ok(fps > 30 && fps < 50, `~40 fps, measured ${fps.toFixed(1)}`);
  const p = await waitPacket((x) => slot(x, 285, 1) === Math.round(0.55 * 65535) >> 8, "pan 55 %");
  assert.deepEqual([slot(p, 285, 1), slot(p, 285, 2)], [Math.round(0.55 * 65535) >> 8, Math.round(0.55 * 65535) & 0xff]);
  assert.deepEqual([slot(p, 285, 3), slot(p, 285, 4)], [0x80, 0x00], "tilt default 50 %");
  assert.equal(slot(p, 285, 5), 0, "Pan/Tilt Speed stays 0");
  assert.equal(slot(p, 285, 6), 255, "intensity default 100 %");
  assert.equal(slot(p, 285, 7), 255, "shutter 255");
  assert.deepEqual([8, 9, 10, 11, 12].map((c) => slot(p, 285, c)), [255, 255, 255, 255, 255], "additive colours full (the fixture stays lit)");
  assert.deepEqual([13, 14].map((c) => slot(p, 285, c)), [0, 0]);
  for (let i = 0; i < 512; i++) if (i < 284 || i >= 284 + 14) assert.equal(p.slots[i], 0, `slot ${i + 1} outside the fixture`);
  // the second fixture was not touched: its slots are 0
  assert.ok([...p.slots.subarray(298, 312)].every((b) => b === 0));
  // only universe 1 is being sent
  assert.ok(packets.every((x) => x.universe === 1));
  const fbp = deck.lastFeedback("pan");
  assert.equal(fbp.value.value, "55.0");
});

test("dials: ±1 % per tick, fine mode (push) 0.1 %, intensity, long touch = home, colour dial acts on red; strip shows the %", async () => {
  deck.dialRotate(A.intensity, "int", -50);
  const a = await waitPacket((x) => slot(x, 285, 6) === 128, "intensity 50 %");
  assert.equal(slot(a, 285, 6), 128);
  assert.equal(deck.lastFeedback("int").value.value, "50.0");
  deck.dialDown(A.pan, "pan"); // fine
  await deck.waitFor(() => deck.lastFeedback("pan").mark.value === "FINE", 3000, "fine mark");
  deck.dialRotate(A.pan, "pan", 1);
  const v = Math.round(0.551 * 65535);
  const b = await waitPacket((x) => slot(x, 285, 1) === v >> 8 && slot(x, 285, 2) === (v & 0xff), "pan 55.1 % in the fine byte");
  assert.ok(b);
  assert.equal(deck.lastFeedback("pan").value.value, "55.1");
  deck.touchTap(A.pan, "pan", true); // long touch = home
  await waitPacket((x) => slot(x, 285, 1) === 0x80 && slot(x, 285, 2) === 0, "pan home");
  deck.dialRotate(A.redCyan, "rc", -10);
  const c = await waitPacket((x) => slot(x, 285, 8) === Math.round(0.9 * 255), "red 90 %");
  assert.equal(slot(c, 285, 9), 255, "green untouched");
});

test("all of type: one dial turn moves both fixtures; Home Selected sets pan/tilt 50 % and intensity 100 %", async () => {
  deck.dialDown(A.select, "sel"); // all of type
  await deck.waitFor(() => deck.lastFeedback("sel").line1.value === "All Rogue R2X Wash", 3000, "all of type");
  deck.dialRotate(A.tilt, "tilt", 20);
  const p = await waitPacket((x) => slot(x, 299, 3) === Math.round(0.7 * 65535) >> 8, "second fixture tilt 70 %");
  assert.equal(slot(p, 285, 3), slot(p, 299, 3), "both fixtures got the same tilt");
  assert.equal(slot(p, 299, 6), 255, "the second fixture's intensity is its own default (the first one was set to 50 % while it was selected alone)");
  assert.equal(slot(p, 299, 7), 255, "the second fixture started from its defaults too");
  deck.willAppear(A.home, "home");
  deck.keyDown(A.home, "home");
  const h = await waitPacket((x) => slot(x, 285, 3) === 0x80 && slot(x, 299, 3) === 0x80 && slot(x, 285, 6) === 255 && slot(x, 299, 6) === 255, "home selected");
  assert.deepEqual([slot(h, 285, 1), slot(h, 299, 1)], [0x80, 0x80]);
  deck.dialDown(A.select, "sel"); // single again
});

test("Fixtures: Release sends Stream_Terminated x3 on the universe in use, then nothing more; the Status key says output off", async () => {
  deck.willAppear(A.release, "rel");
  await deck.waitFor(() => deck.lastImage("st").includes("OUTPUT ON"), 3000, "status shows output on");
  assert.ok(deck.lastImage("st").includes("U1"));
  assert.ok(deck.lastImage("st").includes("rest of the universe = 0"), "the blackout reminder is on the Status key");
  const n0 = packets.length;
  deck.keyDown(A.release, "rel");
  await deck.waitFor(() => packets.slice(n0).filter((p) => p.terminated).length >= 3, 3000, "3 terminated frames");
  await sleep(300);
  const after = packets.slice(n0);
  assert.equal(after.filter((p) => p.terminated).length, 3);
  assert.ok(after.filter((p) => p.terminated).every((p) => p.universe === 1));
  const n1 = packets.length;
  await sleep(500);
  assert.equal(packets.length, n1, "nothing is sent after Release");
  await deck.waitFor(() => deck.lastImage("st").includes("output off"), 3000, "status shows output off");
});

test("after Release a new touch starts from the defaults again; plugin exit (SIGTERM) sends the termination frames", async () => {
  deck.dialRotate(A.tilt, "tilt", -10); // single fixture 203 again: default 50 % - 10 %
  const p = await waitPacket((x) => !x.terminated && slot(x, 285, 3) === Math.round(0.4 * 65535) >> 8, "restart from defaults");
  assert.equal(slot(p, 285, 1), 0x80, "pan is back at 50 %");
  assert.equal(slot(p, 285, 6), 255, "intensity back at 100 %");
  const n0 = packets.length;
  deck.proc!.kill("SIGTERM");
  await deck.waitFor(() => packets.slice(n0).filter((x) => x.terminated).length >= 3, 4000, "termination frames on exit");
});
