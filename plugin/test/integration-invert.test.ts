/**
 * End-to-end (Handoff 31, v0.12.0) on the REAL built plugin (bin/plugin.js): per-fixture Pan / Tilt invert and the patch-conflict wording,
 * with a stub Capture that reports its patch after the SDMX declaration, a synthetic library, a UDP listener for sACN and the fake
 * Stream Deck application. Ch 201 at 1/1 and Ch 202 at 1/100 (moving heads), Ch 203 and Ch 205 both at 1/285 (a patch conflict), Ch 209
 * a conventional (no Pan/Tilt) at 1/400.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDataPacket, type ParsedPacket } from "../src/fixtures/sacn.ts";
import { FakeDeck, sleep } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";
import { buildLibraryFile, buildModeBlock, buildObject, conventional, movingHead, startPatchStub, type CitpStub } from "./fixtures/synth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../com.rezabehjat.capture.sdPlugin");
const U = "com.rezabehjat.capture";
const A = { setup: `${U}.fixtures.setup`, select: `${U}.fixture.select`, a1: `${U}.fixture.attr1`, a2: `${U}.fixture.attr2` };
const FX = "aaaaaaaa-0000-0000-0000-0000000000c7";
const MD = "bbbbbbbb-0000-0000-0000-0000000000c7";
const FXC = "aaaaaaaa-0000-0000-0000-0000000000c8";
const MDC = "bbbbbbbb-0000-0000-0000-0000000000c8";
const I = (n: number) => `00000000-0000-0000-0000-0000000000${n}`;
const SHOW = "INVERT SHOW";
const ID = { a: 801, b: 802, c: 803, d: 805, e: 809 };

let deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "invert-e2e-"));
const lib = path.join(tmp, "Library.c2z");
const sacn = dgram.createSocket("udp4");
const packets: ParsedPacket[] = [];
let citp: CitpStub;
const env = (): Record<string, string> => ({
  CAPTURE_TEST_CITP_PORT: String(citp.port),
  CAPTURE_TEST_CITP_TIMING: "300,1000,1500,800,200",
  CAPTURE_TEST_LIBRARY: lib,
  CAPTURE_TEST_SACN_PORT: String(sacn.address().port),
  CAPTURE_TEST_SACN_NO_MULTICAST: "1",
});
const startDeck = async (): Promise<void> => {
  await deck.start({ oscPort: capture.port, pluginDir, fixtures: path.join(here, "fixtures"), env: env() });
  deck.willAppear(A.select, "sel", {}, "Encoder");
  deck.willAppear(A.a1, "a1", {}, "Encoder");
  deck.willAppear(A.a2, "a2", {}, "Encoder");
  deck.willAppear(A.setup, "setup", {});
  deck.inspectorAppeared(A.setup, "setup");
};

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  fs.writeFileSync(lib, buildLibraryFile({ [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })), [FXC]: buildObject(buildModeBlock({ guid: MDC, channels: conventional() })) }));
  const mh = (ch: number, id: number, inst: string, u: number, a: number) => ({ mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: ch, fixtureGuid: FX, modeGuid: MD, instanceId: inst, identifier: id, patch: { universe: u, address: a } });
  citp = await startPatchStub(
    [mh(201, ID.a, I(81), 1, 1), mh(202, ID.b, I(82), 1, 100), mh(203, ID.c, I(83), 1, 285), mh(205, ID.d, I(85), 1, 285), { mfr: "Test", name: "Par", mode: "1ch", channels: 1, channel: 209, fixtureGuid: FXC, modeGuid: MDC, instanceId: I(89), identifier: ID.e, patch: { universe: 1, address: 400 } }],
    { showName: SHOW },
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
  deck.globals = { fixtureDeck: { idleSeconds: 0, autoWake: false } };
  await startDeck();
});
after(async () => {
  await deck.stop();
  capture.stop();
  await citp.close();
  sacn.close();
});

const pan16 = (p: ParsedPacket, base: number): number => (p.slots[base - 1] << 8) | p.slots[base];
const P16 = (v: number): number => Math.round(v * 65535);
const waitLog = (re: RegExp, what: string, ms = 4000): Promise<unknown> => deck.waitFor(() => re.test(deck.logText()) || undefined, ms, what);
const count = (re: RegExp): number => deck.logText().split("\n").filter((l) => re.test(l)).length;
const waitPacket = (pred: (p: ParsedPacket) => boolean, what: string): Promise<ParsedPacket> => {
  const n0 = packets.length;
  return deck.waitFor(() => packets.slice(Math.max(0, n0 - 1)).reverse().find((p) => !p.terminated && pred(p)), 3000, what);
};
const waitStrip = (ctx: string, pred: (fb: any) => boolean, what: string): Promise<any> => deck.waitFor(() => (deck.lastFeedback(ctx) && pred(deck.lastFeedback(ctx)) ? deck.lastFeedback(ctx) : undefined), 3000, what);
const lastSetup = (): any => deck.received.filter((m) => m.event === "sendToPropertyInspector" && m.payload?.event === "setup").at(-1)?.payload;
const getView = async (pred: (v: any) => boolean, what: string): Promise<any> => {
  let asked = 0;
  return deck.waitFor(() => {
    const v = lastSetup()?.view;
    if (v && pred(v)) return v;
    if (Date.now() - asked > 300) {
      asked = Date.now();
      deck.sendToPlugin(A.setup, "setup", { cmd: "get" });
    }
    return undefined;
  }, 5000, what);
};
const row = (v: any, ch: number): any => v.fixtures.find((f: any) => f.channel === ch);
const selectAB = async (): Promise<void> => {
  citp.select([ID.a, ID.b]);
  await waitStrip("sel", (f) => f.line2.value.startsWith("Ch 201"), "201 + 202 selected in Capture (201 first)");
};

test("start-up: patch conflict for 203/205 on both rows and logged once per pair (new wording); toggles only for the axes a type has", async () => {
  await waitLog(/Fixtures: Capture's patch: 5 of 5 fixture\(s\) patched/, "Capture's patch", 8000);
  await waitLog(/Fixtures: patch conflict in Capture: Ch 20[35] and Ch 20[35] both at 1\/285 \(fix the patch in Capture\)/, "conflict logged");
  const v = await getView((x) => x.patch?.patched === 5, "panel in patch mode");
  assert.deepEqual(row(v, 203).shared, ["⚠ patch conflict with Ch 205 at 1/285 — fix in Capture"]);
  assert.deepEqual(row(v, 205).shared, ["⚠ patch conflict with Ch 203 at 1/285 — fix in Capture"]);
  assert.equal(row(v, 203).controllable && row(v, 205).controllable, true, "behaviour unchanged: both controllable");
  assert.deepEqual([row(v, 201).axes, row(v, 201).invertPan, row(v, 201).invertTilt], [["pan", "tilt"], false, false]);
  assert.deepEqual(row(v, 209).axes, [], "the conventional: no toggles");
  await sleep(1800); // more lists
  assert.equal(count(/patch conflict in Capture/), 1, "once per pair");
  assert.doesNotMatch(deck.logText(), /share 1\/285/, "the old wording is gone");
});

test("Invert Pan on 201 (in patch mode; addresses stay read-only): a +3 turn lowers 201's Pan by what it raises 202's, coarse and fine (16-bit pair); the strip shows the true % and 'Pan ⇄'", async () => {
  await selectAB();
  deck.dialRotate(A.a1, "a1", 10); // both to 60 % first, so an inverted VALUE would show
  await waitPacket((p) => pan16(p, 1) === P16(0.6) && pan16(p, 100) === P16(0.6), "both at 60 %");
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: I(81), universe: 3, address: 1 });
  await deck.waitFor(() => /Addresses come from Capture's patch/.test(lastSetup()?.error ?? "") || undefined, 3000, "address refused");
  deck.sendToPlugin(A.setup, "setup", { cmd: "invert", key: I(81), axis: "pan", on: true });
  await waitLog(/Fixtures: Ch 201 Rogue R2X Wash: Pan inverted/, "logged");
  const v = await getView((x) => row(x, 201).invertPan === true, "saved");
  assert.equal(lastSetup().error, null);
  assert.deepEqual(row(v, 201).addr, { universe: 1, address: 1, src: "capture" }, "the address is unchanged");
  assert.deepEqual((deck.globals as any).fixtureInvert, { [SHOW]: { [I(81)]: { invertPan: true } } });
  await waitStrip("a1", (f) => f.name.value === "Pan ⇄", "strip label Pan ⇄");
  deck.dialRotate(A.a1, "a1", 3);
  await waitPacket((p) => pan16(p, 1) === P16(0.57) && pan16(p, 100) === P16(0.63), "201: 57 %, 202: 63 %");
  await waitStrip("a1", (f) => f.value.value === "57.0" && f.name.value === "Pan ⇄", "the true % on the strip");
  // fine mode: push the dial, +3 = 0.3 %
  deck.dialDown(A.a1, "a1");
  await waitStrip("a1", (f) => f.mark.value.includes("FINE"), "fine on");
  deck.dialRotate(A.a1, "a1", 3);
  await waitPacket((p) => pan16(p, 1) === P16(0.567) && pan16(p, 100) === P16(0.633), "fine: 201 56.7 %, 202 63.3 %");
  deck.dialDown(A.a1, "a1");
  await waitStrip("a1", (f) => !f.mark.value.includes("FINE"), "fine off");
  // Tilt is not inverted
  deck.dialRotate(A.a2, "a2", 2);
  await waitPacket((p) => ((p.slots[2] << 8) | p.slots[3]) === P16(0.52) && ((p.slots[101] << 8) | p.slots[102]) === P16(0.52), "tilt both +2 %");
  assert.equal(deck.lastFeedback("a2").name.value, "Tilt");
  // 202 first: no mark
  citp.select([ID.b, ID.a]);
  await waitStrip("a1", (f) => f.name.value === "Pan", "202 first: plain Pan");
});

test("the invert survives a re-patch in Capture (FixtureModify), a show reload and a plugin restart; another show does not inherit it", async () => {
  // re-patch 201 to 2/1 (the stub's own patch follows, so the next lists agree)
  citp.fixtures.find((f) => f.channel === 201)!.patch = { universe: 2, address: 1 };
  citp.modify([{ identifier: ID.a, changed: 0x01, patched: 1, universe: 1, universeChannel: 0 }]);
  await waitLog(/address from Capture's patch Ch 201 Rogue R2X Wash -> 2\/1/, "re-patched");
  await getView((x) => row(x, 201).addr?.universe === 2 && row(x, 201).invertPan === true, "re-patched, still inverted");
  citp.select([ID.a]);
  await waitStrip("sel", (f) => f.line2.value.startsWith("Ch 201"), "201 selected");
  await waitStrip("a1", (f) => f.name.value === "Pan ⇄", "still Pan ⇄");
  deck.dialRotate(A.a1, "a1", 2);
  await deck.waitFor(() => packets.slice(-40).reverse().find((p) => p.universe === 2 && !p.terminated && pan16(p, 1) === P16(0.547)), 3000, "201 on u2: 56.7 % − 2 %");
  // show reload
  citp.leaveShow();
  await waitLog(/Fixtures: Capture left the show/, "left");
  citp.enterShow(SHOW);
  await getView((x) => x.showName === SHOW && row(x, 201)?.invertPan === true, "kept after a show reload");
  // plugin restart
  await deck.stop(); // SIGTERM: the remembered values are flushed on exit
  await sleep(300);
  const globals = JSON.parse(JSON.stringify(deck.globals));
  assert.equal(Math.round(globals.fixtureValues[SHOW][I(81)].ch0 * 1000), 547, "201's pan stored (true value)");
  deck = new FakeDeck();
  deck.globals = globals;
  packets.length = 0;
  await startDeck();
  await waitLog(/Fixtures: Capture's patch: 5 of 5 fixture\(s\) patched/, "patch after restart", 8000);
  await getView((x) => row(x, 201)?.invertPan === true, "loaded after a restart");
  citp.select([ID.a]);
  await waitStrip("sel", (f) => f.line2.value.startsWith("Ch 201"), "201 selected");
  await waitStrip("a1", (f) => f.name.value === "Pan ⇄", "Pan ⇄ after the restart");
  deck.dialRotate(A.a1, "a1", 1);
  await deck.waitFor(() => packets.slice().reverse().find((p) => p.universe === 2 && !p.terminated && pan16(p, 1) === P16(0.537)), 3000, "inverted after the restart: 54.7 % − 1 %");
  // another show: not inherited
  citp.enterShow("OTHER INVERT SHOW");
  const v = await getView((x) => x.showName === "OTHER INVERT SHOW" && row(x, 201)?.addr, "the other show");
  assert.equal(row(v, 201).invertPan, false, "per show");
  citp.select([ID.a]);
  await waitStrip("a1", (f) => f.name.value === "Pan", "plain Pan in the other show");
  deck.sendToPlugin(A.setup, "setup", { cmd: "invert", key: I(81), axis: "pan", on: false });
  await waitLog(/Fixtures: Ch 201 Rogue R2X Wash: Pan normal/, "the 'normal' log line");
});
