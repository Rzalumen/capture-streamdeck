/**
 * End-to-end (Handoff 15, 18): the REAL built plugin (bin/plugin.js) with
 *   - a stub CITP server (persistent session: PNam → EnterShow → FixtureListRequest → FixtureList, FixtureIdentify, then unsolicited
 *     FixtureSelection / FixtureModify / FixtureList / LeaveShow, and dropped connections),
 *   - a synthetic Library.c2z holding the fixtures' mode blocks,
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
import { ALLOWED_OUTGOING_CAEX, CAEX, UNIDENTIFIED, decodeMessage, isWellFormedDeclaration } from "../src/fixtures/citp.ts";
import { parseDataPacket, type ParsedPacket } from "../src/fixtures/sacn.ts";
import { FakeDeck, sleep } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";
import { buildLibraryFile, buildModeBlock, buildObject, movingHead, startPatchStub, type CitpStub } from "./fixtures/synth.ts";

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
const FXC = "aaaaaaaa-0000-0000-0000-000000000004";
const MDC = "bbbbbbbb-0000-0000-0000-000000000004";
const INST1 = "00000000-0000-0000-0000-0000000000a1";
const INST2 = "00000000-0000-0000-0000-0000000000a2";
const INST3 = "00000000-0000-0000-0000-0000000000a3";
const INST4 = "00000000-0000-0000-0000-0000000000a4";
const CELLS_ID = 7777; // Capture's own identifier for the cell bar: reused, never replaced
const cellHead = () => [{ name: "Dimmer" }, ...[1, 2, 3, 4, 5].flatMap((n) => [{ name: `Red ${n}` }, { name: `Green ${n}` }, { name: `Blue ${n}` }])];

const deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fx-e2e-"));
const sacn = dgram.createSocket("udp4");
const packets: ParsedPacket[] = [];
let citp: CitpStub;

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  const lib = path.join(tmp, "Library.c2z");
  fs.writeFileSync(lib, buildLibraryFile({ [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })), [FXC]: buildObject(buildModeBlock({ guid: MDC, channels: cellHead() })) }));
  citp = await startPatchStub(
    [
      { mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 203, fixtureGuid: FX, modeGuid: MD, instanceId: INST1, position: [4, 6, 2], identifier: UNIDENTIFIED },
      { mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 204, fixtureGuid: FX, modeGuid: MD, instanceId: INST2, position: [-4, 6, 2], identifier: UNIDENTIFIED },
      { mfr: "Test", name: "ColorBlaze 72", mode: "Std", channels: 16, channel: 0, fixtureGuid: FXC, modeGuid: MDC, instanceId: INST3, position: [1.3, 4, -0.9], identifier: CELLS_ID },
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
    env: {
      CAPTURE_TEST_CITP_PORT: String(citp.port),
      CAPTURE_TEST_CITP_TIMING: "300,1000,1500,800,200", // back-off 0.3 → 1 s, list every 1.5 s, first retry 0.8 s
      CAPTURE_TEST_LIBRARY: lib,
      CAPTURE_TEST_SACN_PORT: String(sacn.address().port),
      CAPTURE_TEST_SACN_NO_MULTICAST: "1",
      CAPTURE_TEST_DECK_ON: "1", // Handoff 21: these v0.5/v0.6 tests run with Deck Control ON from the start (the persistent session)
    },
  });
});
after(async () => {
  await deck.stop();
  capture.stop();
  await citp.close();
  sacn.close();
});

const lastSetupView = (): any => deck.received.filter((m) => m.event === "sendToPropertyInspector" && m.payload?.event === "setup").at(-1)?.payload;
const slot = (p: ParsedPacket, universeAddress: number, channel: number): number => p.slots[universeAddress - 1 + channel - 1];
const waitPacket = async (pred: (p: ParsedPacket) => boolean, what: string): Promise<ParsedPacket> => {
  const n0 = packets.length;
  return deck.waitFor(() => packets.slice(Math.max(0, n0 - 1)).reverse().find(pred), 3000, what);
};
const strip = (ctx: string): any => deck.lastFeedback(ctx);
const waitStrip = (ctx: string, pred: (fb: any) => boolean, what: string): Promise<any> => deck.waitFor(() => (deck.lastFeedback(ctx) && pred(deck.lastFeedback(ctx)) ? deck.lastFeedback(ctx) : undefined), 3000, what);
/** Slots (1-based, whole universe 1) that differ between two frames. */
const changed = (a: ParsedPacket, b: ParsedPacket): number[] => [...b.slots].map((v, i) => (v !== a.slots[i] ? i + 1 : 0)).filter(Boolean);
const IDS = { r203: 100001, r204: 100002, cells: CELLS_ID };

test("persistent session: PNam, EnterShow, one FixtureIdentify for the unidentified fixtures only (Capture's own identifier is reused), nothing else sent, no DMX", async () => {
  deck.willAppear(A.status, "st");
  await deck.waitFor(() => deck.lastImage("st").includes("E2E SHOW"), 8000, "status key shows the show name");
  await deck.waitFor(() => citp.identifies.length >= 1, 4000, "FixtureIdentify");
  assert.deepEqual(citp.identifies[0], [[INST1, IDS.r203], [INST2, IDS.r204]], "the 16 bytes as received, 100001 upward, the cell bar (7777) not included");
  assert.ok(deck.lastImage("st").includes("0 of 3 ready"));
  assert.ok(deck.lastImage("st").includes("output off"));
  // every message the plugin sent is PINF/CAEX and on the allowlist (+ the well-formed FixtureIdentify), or (v0.8.0, persistent
  // session) one of our well-formed SDMX SXSr / SXUS declarations
  for (const m of citp.received) {
    const d = decodeMessage(m);
    if (d.layer === "SDMX") {
      assert.ok(isWellFormedDeclaration(m), `SDMX ${m.toString("latin1", 20, 24)} is a well-formed declaration`);
      continue;
    }
    assert.ok(d.layer === "PINF" || d.layer === "CAEX", `layer ${d.layer}`);
    if (d.layer === "CAEX") assert.ok(ALLOWED_OUTGOING_CAEX.has(d.code!) || d.code === CAEX.FixtureIdentify, `CAEX 0x${d.code!.toString(16)} is allowed`);
  }
  for (const code of [CAEX.FixtureList, CAEX.FixtureModify, CAEX.FixtureRemove, CAEX.FixtureSelection]) assert.equal(citp.of(code).length, 0, `0x${code.toString(16)} is never sent`);
  assert.equal(citp.of(CAEX.EnterShow).length, 1, "our own EnterShow, once");
  assert.equal(citp.received.filter((m) => m.toString("latin1", 16, 20) === "SDMX").length, 17, "v0.8.0: the declaration, once (SXSr + 16 SXUS)");
  // the list is asked for again every 1.5 s, and identified fixtures are never identified again
  await sleep(2200);
  assert.ok(citp.of(CAEX.FixtureListRequest).length >= 2, "periodic FixtureListRequest");
  assert.equal(citp.identifies.length, 1, "no re-identify");
  assert.match(deck.logText(), /Fixtures: identify: 1 of 3 fixture\(s\) already have an identifier; sending 2 new \(100001–100002\)/);
  assert.equal(packets.length, 0, "no DMX before a user touch");
});

test("Fixtures: Setup — the key panel lists the show, saves addresses per show and keys them by CaptureInstanceId; pressing the key only re-reads the show (no browser, no server)", async () => {
  deck.willAppear(A.setup, "setup");
  deck.inspectorAppeared(A.setup, "setup");
  deck.sendToPlugin(A.setup, "setup", { cmd: "get" });
  const v = await deck.waitFor(() => lastSetupView()?.view?.fixtures?.length === 3 && lastSetupView(), 4000, "setup view");
  assert.equal(v.view.showName, "E2E SHOW");
  assert.deepEqual(v.view.fixtures.map((f: any) => [f.channel, f.name, f.hasPanTilt, f.parsed, f.key]), [
    [0, "ColorBlaze 72", false, true, INST3],
    [203, "Rogue R2X Wash", true, true, INST1],
    [204, "Rogue R2X Wash", true, true, INST2],
  ]);
  assert.match(v.view.blackoutWarning, /BLACKS OUT/);
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST1, universe: 17, address: 1 });
  await deck.waitFor(() => /universe must be/.test(lastSetupView()?.error ?? ""), 3000, "range error");
  assert.deepEqual((deck.globals as any).fixtureSetup ?? {}, {});
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST1, universe: 1, address: 285 });
  await deck.waitFor(() => lastSetupView()?.view?.controllable === 1 && !lastSetupView().error, 3000, "controllable 1");
  assert.deepEqual((deck.globals as any).fixtureSetup, { "E2E SHOW": { [INST1]: { universe: 1, address: 285 } } });
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST2, universe: 1, address: 290 });
  await deck.waitFor(() => lastSetupView()?.view?.fixtures?.[2]?.issues?.length === 1 && lastSetupView().view.controllable === 0, 3000, "overlap reported");
  assert.match(lastSetupView().view.fixtures[1].issues[0], /overlaps/);
  deck.sendToPlugin(A.setup, "setup", { cmd: "autofill", keys: [INST2, INST1], universe: 1, address: 285 });
  await deck.waitFor(() => lastSetupView()?.view?.controllable === 2, 3000, "auto-fill");
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST3, universe: 1, address: 20 });
  await deck.waitFor(() => lastSetupView()?.view?.controllable === 3, 3000, "cell bar");
  await deck.waitFor(() => deck.lastImage("st").includes("3 of 3 ready"), 3000, "status shows 3 ready");
  assert.equal(packets.length, 0, "still no DMX: setting addresses is not a touch");

  // the key press re-reads the show: a FixtureListRequest goes out, and nothing is opened
  const n0 = citp.of(CAEX.FixtureListRequest).length;
  deck.willAppear(A.setup, "setupkey");
  deck.keyDown(A.setup, "setupkey");
  await deck.waitFor(() => citp.of(CAEX.FixtureListRequest).length > n0, 3000, "a fresh FixtureListRequest");
  assert.deepEqual(deck.openCalls(), [], "no browser");
  assert.match(deck.logText(), /Key press.*read the show again/);
  assert.doesNotMatch(deck.logText(), /setup page/);
});

test("no HTTP server: the bundle has none, and the plugin process is listening on no TCP port", async () => {
  const bundle = fs.readFileSync(path.join(pluginDir, "bin/plugin.js"), "utf8");
  assert.ok(!/setup page: listening|\/setup-web\.js|setup-web\.html/.test(bundle));
  const srcFiles = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of srcFiles(path.resolve(here, "../src"))) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /node:http|createServer/, `${path.basename(f)} must not serve HTTP`);
  const pid = deck.proc!.pid!;
  if (fs.existsSync(`/proc/${pid}/fd`) && fs.existsSync("/proc/net/tcp")) {
    const inodes = new Set<string>();
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      try {
        const l = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        const m = /^socket:\[(\d+)\]$/.exec(l);
        if (m) inodes.add(m[1]);
      } catch {
        /* closed meanwhile */
      }
    }
    const listening: string[] = [];
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, "utf8").split("\n").slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c[3] === "0A" && inodes.has(c[9])) listening.push(c[1]);
      }
    }
    assert.deepEqual(listening, [], "no listening TCP socket in the plugin process");
  }
});

test("key titles: the key's name is its Stream Deck title; the image carries no label text", async () => {
  deck.willAppear(A.home, "home");
  deck.willAppear(A.release, "rel");
  await deck.waitFor(() => deck.sent("home", "setTitle").length > 0 && deck.sent("rel", "setTitle").length > 0, 3000, "titles");
  assert.equal(deck.sent("home", "setTitle").at(-1)!.payload.title, "Home Light", "v0.7.3: Home Selected was renamed Home Light");
  assert.equal(deck.sent("rel", "setTitle").at(-1)!.payload.title, "Release");
  assert.ok(!deck.lastImageRaw("home").includes("Home Light"), "the label is not drawn into the image");
  assert.ok(!/<text/.test(deck.lastImageRaw("home")));
});

test("the deck follows Capture's selection: click 203 → strip shows it; knobs drive 203 only (sACN changes only on its 14 slots)", async () => {
  deck.willAppear(A.select, "sel", {}, "Encoder");
  deck.willAppear(A.pan, "pan", {}, "Encoder");
  deck.willAppear(A.tilt, "tilt", {}, "Encoder");
  deck.willAppear(A.intensity, "int", {}, "Encoder");
  deck.willAppear(A.focus, "focus", {}, "Encoder");
  deck.willAppear(A.redCyan, "rc", {}, "Encoder");
  citp.select([IDS.r203]);
  const fb = await waitStrip("sel", (f) => f.line2.value === "Ch 203 · 1/285", "strip shows Ch 203");
  assert.equal(fb.line1.value, "Rogue R2X Wash");
  assert.equal(fb.note.value, "");
  assert.equal((await deck.waitFor(() => strip("pan"), 3000, "pan")).value.value, "~50.0", "the starting value, nothing sent yet");
  assert.equal(strip("focus").value.value, "—", "no Focus channel on this fixture");
  assert.equal(strip("rc").name.value, "Red");
  deck.dialRotate(A.focus, "focus", 3);
  await sleep(300);
  assert.equal(packets.length, 0, "a missing attribute does not start output");
  deck.dialRotate(A.pan, "pan", 5);
  const first = await deck.waitFor(() => packets[0], 3000, "first sACN packet");
  assert.equal(first.universe, 1);
  assert.equal(first.priority, 100);
  assert.equal(first.sourceName, "capture-streamdeck");
  const p = await waitPacket((x) => slot(x, 285, 1) === Math.round(0.55 * 65535) >> 8, "pan 55 %");
  assert.deepEqual([slot(p, 285, 3), slot(p, 285, 4)], [0x80, 0x00], "tilt default 50 %");
  assert.equal(slot(p, 285, 6), 255, "intensity default 100 %");
  assert.equal(slot(p, 285, 7), 255, "shutter 255");
  for (let i = 0; i < 512; i++) if (i < 284 || i >= 284 + 14) assert.equal(p.slots[i], 0, `slot ${i + 1} outside the fixture`);
  assert.ok([...p.slots.subarray(298, 312)].every((b) => b === 0), "204 is not touched");
  assert.ok(packets.every((x) => x.universe === 1));
  // a turn changes slots of the selected fixture only
  const before = packets.at(-1)!;
  deck.dialRotate(A.intensity, "int", -20);
  const after = await waitPacket((x) => slot(x, 285, 6) === Math.round(0.8 * 255), "intensity 80 %");
  assert.deepEqual(changed(before, after), [290], "only 203's intensity slot (285 + 5) changed");
});

test("click 204 → the knobs now drive 204; 203 keeps its value", async () => {
  citp.select([IDS.r204]);
  await waitStrip("sel", (f) => f.line2.value === "Ch 204 · 1/299", "strip shows Ch 204");
  const before = packets.at(-1)!;
  deck.dialRotate(A.tilt, "tilt", 10);
  const p = await waitPacket((x) => slot(x, 299, 3) === Math.round(0.6 * 65535) >> 8, "204 tilt 60 %");
  assert.equal(slot(p, 285, 6), Math.round(0.8 * 255), "203 keeps its intensity");
  const diff = changed(before, p).filter((s) => s > 0);
  assert.ok(diff.every((s) => s >= 299 && s < 299 + 14), `only 204's slots changed: ${diff}`);
});

test("several selected: ×2 on the strip, each fixture moves relative to its own value", async () => {
  citp.select([IDS.r203, IDS.r204]);
  const fb = await waitStrip("sel", (f) => f.line1.value === "Rogue R2X Wash ×2", "×2");
  assert.equal(fb.mark.value, "×2");
  deck.dialRotate(A.intensity, "int", -10);
  const p = await waitPacket((x) => slot(x, 285, 6) === Math.round(0.7 * 255) && slot(x, 299, 6) === Math.round(0.9 * 255), "203: 0.8 → 0.7 and 204: 1.0 → 0.9");
  assert.ok(p);
  assert.equal(strip("pan").mark.value.startsWith("×2"), true);
});

test("an empty selection clears (v0.7.2): the strip reads 'Click a light / in Capture' and a turn moves nothing", async () => {
  citp.select([]);
  const fb = await waitStrip("sel", (f) => f.line1.value === "Click a light" && f.line2.value === "in Capture", "cleared");
  assert.equal(fb.note.value, "");
  await deck.waitFor(() => /Capture's selection is empty: nothing selected on the deck/.test(deck.logText()) || undefined, 2000, "logged");
  await sleep(100);
  const n0 = packets.length;
  const before = packets.at(-1)!;
  deck.dialRotate(A.intensity, "int", -10);
  await sleep(400);
  const after = packets.slice(n0).filter((x) => !x.terminated);
  assert.ok(after.every((x) => changed(before, x).length === 0), "no slot changed after the turn");
});

test("Home key: only the selected fixture goes home; tap the strip = home that attribute; push = fine (Handoff 21); long touch does nothing", async () => {
  citp.select([IDS.r203]);
  await waitStrip("sel", (f) => f.line2.value === "Ch 203 · 1/285" && f.note.value === "", "203 selected");
  deck.dialRotate(A.pan, "pan", 10);
  deck.dialRotate(A.tilt, "tilt", -20);
  await waitPacket((x) => slot(x, 285, 3) === Math.round(0.3 * 65535) >> 8 && slot(x, 285, 1) === Math.round(0.65 * 65535) >> 8, "203 moved");
  const other = [...packets.at(-1)!.slots.subarray(298, 312)];
  deck.keyDown(A.home, "home");
  const h = await waitPacket((x) => slot(x, 285, 3) === 0x80 && slot(x, 285, 1) === 0x80 && slot(x, 285, 6) === 255, "203 at home");
  assert.deepEqual([...h.slots.subarray(298, 312)], other, "204 did not move");
  // tap the strip: pan only
  deck.dialRotate(A.pan, "pan", 10);
  deck.dialRotate(A.intensity, "int", -30);
  await waitPacket((x) => slot(x, 285, 6) === Math.round(0.7 * 255) && slot(x, 285, 1) === Math.round(0.6 * 65535) >> 8, "pan 60 %, intensity 70 %");
  deck.touchTap(A.pan, "pan", false);
  const k = await waitPacket((x) => slot(x, 285, 1) === 0x80 && slot(x, 285, 6) === Math.round(0.7 * 255), "pan homed, intensity not");
  assert.ok(k);
  // push = fine mode; a long touch does nothing
  deck.dialDown(A.pan, "pan");
  await waitStrip("pan", (f) => f.mark.value.includes("FINE"), "fine on");
  deck.dialRotate(A.pan, "pan", 1);
  await waitPacket((x) => slot(x, 285, 1) === Math.round(0.501 * 65535) >> 8 && slot(x, 285, 2) === (Math.round(0.501 * 65535) & 0xff), "pan 50.1 % in the fine byte");
  deck.touchTap(A.pan, "pan", true);
  await sleep(300);
  assert.ok(strip("pan").mark.value.includes("FINE"), "long touch changed nothing");
  assert.equal(packets.at(-1)!.slots[284], Math.round(0.501 * 65535) >> 8, "and did not home");
  deck.dialDown(A.pan, "pan");
  await waitStrip("pan", (f) => !f.mark.value.includes("FINE"), "fine off");
});

test("a colour with several cells: the Red knob moves Red 1–5 together, tapping its strip homes them all; Channel 0 shows the position hint", async () => {
  citp.select([IDS.cells]);
  const fb = await waitStrip("sel", (f) => f.line1.value === "ColorBlaze 72", "cell bar selected");
  assert.equal(fb.line2.value, "SL 1.3 · US 0.9");
  assert.equal(fb.note.value, "1/20");
  deck.dialRotate(A.redCyan, "rc", -40);
  const p = await waitPacket((x) => slot(x, 20, 2) === 153, "red 60 %");
  assert.deepEqual([2, 5, 8, 11, 14].map((c) => slot(p, 20, c)), [153, 153, 153, 153, 153], "Red 1..5");
  assert.deepEqual([3, 6, 9, 12, 15].map((c) => slot(p, 20, c)), [255, 255, 255, 255, 255], "Green untouched");
  deck.touchTap(A.redCyan, "rc", false);
  const h = await waitPacket((x) => slot(x, 20, 2) === 255, "red homed");
  assert.deepEqual([2, 5, 8, 11, 14].map((c) => slot(h, 20, c)), [255, 255, 255, 255, 255], "tapping the strip homes every cell");
  await deck.waitFor(() => /Fixtures: Capture selected ColorBlaze 72: 1 controllable/.test(deck.logText()), 3000, "selection logged");
});

test("patch changes from Capture (FixtureModify, bit 0x01): address stored 1-based, overlap refused, Patched=0 clears; a driven fixture that moves releases output", async () => {
  citp.select([IDS.r204]);
  await waitStrip("sel", (f) => f.line2.value === "Ch 204 · 1/299", "204 selected");
  const n0 = packets.length;
  // 203 and 204 are on 285 / 299; move 204 to 1/400 (0-based on the wire: universe 0, channel 399)
  citp.modify([{ identifier: IDS.r204, changed: 0x01, patched: 1, universe: 0, universeChannel: 399 }]);
  await deck.waitFor(() => (deck.globals as any).fixtureSetup?.["E2E SHOW"]?.[INST2]?.address === 400, 3000, "address stored");
  assert.deepEqual((deck.globals as any).fixtureSetup["E2E SHOW"][INST2], { universe: 1, address: 400 });
  assert.match(deck.logText(), /Fixtures: address from Capture Ch 204 -> 1\/400/);
  await deck.waitFor(() => packets.slice(n0).filter((p) => p.terminated).length >= 3, 3000, "output released because a driven fixture moved");
  await waitStrip("sel", (f) => f.line2.value === "Ch 204 · 1/400", "strip shows the new address");
  // an overlap is refused: 203 onto 204's channels (0-based 405 = address 406)
  citp.modify([{ identifier: IDS.r203, changed: 0x01, patched: 1, universe: 0, universeChannel: 405 }]);
  await deck.waitFor(() => /Ch 203 -> 1\/406 refused: overlaps/.test(deck.logText()), 3000, "overlap refused");
  assert.deepEqual((deck.globals as any).fixtureSetup["E2E SHOW"][INST1], { universe: 1, address: 285 }, "203 stays where it was");
  // a modify that does not carry the patch bit changes nothing
  citp.modify([{ identifier: IDS.r203, changed: 0x10, patched: 1, universe: 5, universeChannel: 5, note: "new note" }]);
  await sleep(300);
  assert.deepEqual((deck.globals as any).fixtureSetup["E2E SHOW"][INST1], { universe: 1, address: 285 });
  // unpatched: the entry goes
  citp.modify([{ identifier: IDS.r204, changed: 0x01, patched: 0, universe: 0, universeChannel: 0 }]);
  await deck.waitFor(() => !(deck.globals as any).fixtureSetup["E2E SHOW"][INST2], 3000, "cleared by Patched=0");
  await waitStrip("sel", (f) => f.line2.value === "No address — Setup", "strip says no address");
  assert.equal(citp.of(CAEX.FixtureModify).length, 0, "FixtureModify is never sent");
  // put it back so the next tests have two fixtures
  citp.modify([{ identifier: IDS.r204, changed: 0x01, patched: 1, universe: 0, universeChannel: 298 }]);
  await waitStrip("sel", (f) => f.line2.value === "Ch 204 · 1/299", "back at 1/299");
});

test("a fixture added in Capture mid-session gets the next unused identifier (one FixtureIdentify for it alone)", async () => {
  const n = citp.identifies.length;
  const added = { mfr: "Test", name: "SolaFrame 750", mode: "Std", channels: 14, channel: 301, fixtureGuid: FX, modeGuid: MD, instanceId: INST4, position: [0, 0, 0] as [number, number, number], identifier: UNIDENTIFIED };
  citp.fixtures.push(added);
  citp.list(1, [added]); // a Type 1 list: the new fixture only
  await deck.waitFor(() => citp.identifies.length === n + 1, 4000, "FixtureIdentify for the new fixture");
  assert.deepEqual(citp.identifies.at(-1), [[INST4, 100003]], "100001 and 100002 are in use; Capture's own 7777 is left alone");
  await deck.waitFor(() => deck.lastImage("st").includes("4 fixtures") || deck.lastImage("st").includes("of 4"), 3000, "four fixtures");
  await sleep(1800);
  assert.equal(citp.identifies.length, n + 1, "nothing is identified twice");
  citp.select([100003]);
  await waitStrip("sel", (f) => f.line1.value === "SolaFrame 750", "the new fixture is selectable");
  assert.equal(strip("sel").line2.value, "No address — Setup");
});

test("connection lost: the session reconnects with back-off, says PNam and EnterShow again and asks for the list; LeaveShow clears the selection and releases output", async () => {
  deck.dialRotate(A.pan, "pan", 1); // not controllable (SolaFrame has no address): nothing happens
  citp.select([IDS.r203]);
  await waitStrip("sel", (f) => f.line2.value === "Ch 203 · 1/285", "203 selected");
  deck.dialRotate(A.pan, "pan", 1);
  await deck.waitFor(() => packets.at(-1) && !packets.at(-1)!.terminated && slot(packets.at(-1)!, 285, 1) !== 0, 3000, "output on");
  const pnams = citp.received.filter((m) => m.toString("latin1", 16, 24) === "PINFPNam").length;
  citp.drop();
  await deck.waitFor(() => citp.received.filter((m) => m.toString("latin1", 16, 24) === "PINFPNam").length === pnams + 1, 5000, "reconnect with a new PNam");
  await deck.waitFor(() => citp.of(CAEX.EnterShow).length === 2, 3000, "EnterShow again");
  assert.match(deck.logText(), /CITP: connection to Capture closed/);
  assert.match(deck.logText(), /CITP: connected to 127\.0\.0\.1:/);
  // v0.7.2: the selection went with the connection, and Capture does not resend it on reconnect: a turn moves nothing
  assert.match(deck.logText(), /Fixtures: CITP connection closed: selection cleared/);
  await waitStrip("sel", (f) => f.line1.value === "Click a light", "selection cleared by the drop");
  const nr = packets.length;
  const before = packets.at(-1)!;
  deck.dialRotate(A.pan, "pan", 5);
  await sleep(400);
  assert.ok(packets.slice(nr).every((x) => changed(before, x).length === 0), "after the reconnect a turn changes no slot");
  // dropping the connection does not stop DMX (the user's output carries on); LeaveShow does
  const n0 = packets.length;
  citp.leaveShow();
  await deck.waitFor(() => packets.slice(n0).filter((p) => p.terminated).length >= 3, 3000, "output released on LeaveShow");
  await waitStrip("sel", (f) => f.line1.value === "Click a light" && f.mark.value === "", "selection cleared, fixtures forgotten");
  // Capture enters its show again: the list comes back, the setup is still there, nothing is selected. v0.11.0 (Handoff 30): no output
  // runs, so the automatic wake (on by default) puts the stored values back (Ch 203's among them), once (before: no DMX until a touch)
  const n1 = packets.length;
  const wakes = (): number => deck.logText().split("\n").filter((l) => /Fixtures: Wake \(automatic\): \d+ fixture\(s\) restored/.test(l)).length;
  const w0 = wakes();
  citp.enterShow("E2E SHOW");
  await deck.waitFor(() => deck.lastImage("st").includes("E2E SHOW") && /of 4 ready|ready/.test(deck.lastImage("st")), 4000, "show is back");
  await deck.waitFor(() => wakes() === w0 + 1 || undefined, 4000, "one automatic wake");
  assert.match(deck.logText(), /Fixtures: Wake \(automatic\): \d+ fixture\(s\) restored on universe\(s\) 1\n/, "every addressed fixture this file stored values for (all on universe 1)");
  await deck.waitFor(() => packets.slice(n1).find((p) => !p.terminated && slot(p, 285, 1) === slot(before, 285, 1)), 3000, "the stored values are sent again");
  await sleep(900);
  assert.equal(wakes(), w0 + 1, "exactly one");
  await waitStrip("sel", (f) => f.line1.value === "Click a light", "still nothing selected");
});

test("a different show: selection cleared, output released, the other show's setup is empty", async () => {
  citp.select([IDS.r203]);
  await waitStrip("sel", (f) => f.line2.value === "Ch 203 · 1/285", "203 selected");
  deck.dialRotate(A.pan, "pan", 1);
  await deck.waitFor(() => packets.at(-1) && !packets.at(-1)!.terminated, 3000, "output on");
  const n0 = packets.length;
  citp.enterShow("OTHER SHOW");
  await deck.waitFor(() => packets.slice(n0).filter((p) => p.terminated).length >= 3, 3000, "released on a show change");
  await deck.waitFor(() => deck.lastImage("st").includes("OTHER SHOW") && deck.lastImage("st").includes("0 of"), 4000, "status shows the other show with nothing set up");
  assert.match(deck.logText(), /a different show was entered \("OTHER SHOW"\): releasing output/);
  citp.enterShow("E2E SHOW");
  await deck.waitFor(() => deck.lastImage("st").includes("E2E SHOW") && !deck.lastImage("st").includes("0 of"), 4000, "back in the first show");
});

test("Fixtures: Release (kept for old keys), v0.9.0: disarms only — no Stream_Terminated, no LeaveShow, the connection stays, identical frames keep going, the selection stays", async () => {
  citp.select([IDS.r203]);
  await waitStrip("sel", (f) => f.line2.value === "Ch 203 · 1/285", "203 selected");
  deck.dialRotate(A.tilt, "tilt", 1);
  await deck.waitFor(() => deck.lastImage("st").includes("OUTPUT ON"), 3000, "status shows output on");
  assert.ok(deck.lastImage("st").includes("U1"));
  assert.ok(deck.lastImage("st").includes("rest of the universe = 0"), "the blackout reminder is on the Status key");
  await sleep(100);
  const ref = packets.filter((x) => !x.terminated).at(-1)!;
  const n0 = packets.length;
  const leaves = citp.of(CAEX.LeaveShow).length;
  const enters = citp.of(CAEX.EnterShow).length;
  deck.keyDown(A.release, "rel");
  await deck.waitFor(() => /Fixtures: deck control OFF \(Release key\): knobs disarmed; output and the CITP connection keep running/.test(deck.logText()) || undefined, 3000, "Release logged");
  await sleep(1200);
  const after = packets.slice(n0);
  assert.equal(after.filter((p) => p.terminated).length, 0, "no Stream_Terminated");
  assert.ok(after.length >= 30, `frames keep going (${after.length} in 1.2 s)`);
  for (const p of after) assert.deepEqual([...p.slots], [...ref.slots], "identical slot values");
  assert.equal(citp.of(CAEX.LeaveShow).length, leaves, "no LeaveShow");
  assert.equal(citp.of(CAEX.EnterShow).length, enters);
  assert.equal(citp.clients.size, 1, "the connection stays");
  assert.ok(deck.lastImage("st").includes("OUTPUT ON"), "the Status key still shows output on");
  assert.equal(strip("sel").line2.value, "Ch 203 · 1/285", "the selection stays");
});

test("after Release a knob turn re-arms and moves the still-selected light at once, from where it was (no snap to home); plugin exit (SIGTERM) sends the termination frames and LeaveShow", async () => {
  const last = packets.filter((x) => !x.terminated).at(-1)!;
  const tilt0 = (slot(last, 285, 3) << 8) | slot(last, 285, 4);
  const pan0 = (slot(last, 285, 1) << 8) | slot(last, 285, 2);
  const int0 = slot(last, 285, 6);
  assert.ok(pan0 !== 0x8000 || int0 !== 255 || tilt0 !== 0x8000, "203 is somewhere other than home, so a snap would show");
  const enters = citp.of(CAEX.EnterShow).length;
  deck.dialRotate(A.tilt, "tilt", -10);
  await deck.waitFor(() => /Fixtures: deck control ON \(Tilt dial\)/.test(deck.logText()) || undefined, 3000, "re-armed by the turn");
  const want = Math.round((Math.round((tilt0 / 65535) * 10000) / 10000 - 0.1) * 65535);
  const p = await waitPacket((x) => !x.terminated && Math.abs(((slot(x, 285, 3) << 8) | slot(x, 285, 4)) - want) <= 7, "tilt −10 % from where it was");
  assert.equal((slot(p, 285, 1) << 8) | slot(p, 285, 2), pan0, "pan where it was, not 50 %");
  assert.equal(slot(p, 285, 6), int0, "intensity where it was, not 100 %");
  assert.equal(citp.of(CAEX.EnterShow).length, enters, "no new EnterShow: same connection");
  assert.doesNotMatch(deck.logText(), /deck control OFF: selection cleared/);
  const n0 = packets.length;
  const leaves = citp.of(CAEX.LeaveShow).length;
  await sleep(300);
  deck.proc!.kill("SIGTERM");
  await deck.waitFor(() => packets.slice(n0).filter((x) => x.terminated).length >= 3, 4000, "termination frames on exit");
  await deck.waitFor(() => citp.of(CAEX.LeaveShow).length > leaves, 3000, "LeaveShow on exit");
});
