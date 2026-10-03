/**
 * End-to-end (Handoff 20): the REAL built plugin (bin/plugin.js) with a stub CITP server, a synthetic Library.c2z holding a
 * SolaFrame-LIKE (made-up) framing spot and a wash, a UDP listener for sACN and the fake Stream Deck application.
 * Select the spot in "Capture" → Page ▶ to Shutters → turn Attribute 2 → sACN changes only on that blade's slot.
 * Run `npm run build` first (npm test does).
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UNIDENTIFIED } from "../src/fixtures/citp.ts";
import { parseDataPacket, type ParsedPacket } from "../src/fixtures/sacn.ts";
import { FakeDeck, sleep } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";
import { buildLibraryFile, buildModeBlock, buildObject, framingHead, movingHead, startPatchStub, type CitpStub } from "./fixtures/synth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../com.rezabehjat.capture.sdPlugin");
const U = "com.rezabehjat.capture";
const A = {
  setup: `${U}.fixtures.setup`,
  release: `${U}.fixtures.release`,
  home: `${U}.fixtures.home`,
  prev: `${U}.fixtures.page-prev`,
  next: `${U}.fixtures.page-next`,
  select: `${U}.fixture.select`,
  a1: `${U}.fixture.attr1`,
  a2: `${U}.fixture.attr2`,
  a3: `${U}.fixture.attr3`,
};
const FX_SPOT = "aaaaaaaa-0000-0000-0000-0000000000c1";
const MD_SPOT = "bbbbbbbb-0000-0000-0000-0000000000c1";
const FX_WASH = "aaaaaaaa-0000-0000-0000-0000000000c2";
const MD_WASH = "bbbbbbbb-0000-0000-0000-0000000000c2";
const INST_SPOT = "00000000-0000-0000-0000-0000000000c1";
const INST_WASH = "00000000-0000-0000-0000-0000000000c2";
const ID = { spot: 100001, wash: 100002 };
const SPOT_ADDR = 420; // as Reza set the SolaFrame
const WASH_ADDR = 285;

const deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pages-e2e-"));
const sacn = dgram.createSocket("udp4");
const packets: ParsedPacket[] = [];
let citp: CitpStub;

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  const lib = path.join(tmp, "Library.c2z");
  fs.writeFileSync(lib, buildLibraryFile({ [FX_SPOT]: buildObject(buildModeBlock({ guid: MD_SPOT, channels: framingHead() })), [FX_WASH]: buildObject(buildModeBlock({ guid: MD_WASH, channels: movingHead() })) }));
  citp = await startPatchStub(
    [
      { mfr: "Test", name: "Framing Spot", mode: "Std", channels: 37, channel: 207, fixtureGuid: FX_SPOT, modeGuid: MD_SPOT, instanceId: INST_SPOT, position: [0, 6, 0], identifier: UNIDENTIFIED },
      { mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 203, fixtureGuid: FX_WASH, modeGuid: MD_WASH, instanceId: INST_WASH, position: [4, 6, 2], identifier: UNIDENTIFIED },
    ],
    { showName: "PAGES SHOW" },
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
      CAPTURE_TEST_CITP_TIMING: "300,1000,1500,800,200",
      CAPTURE_TEST_LIBRARY: lib,
      CAPTURE_TEST_SACN_PORT: String(sacn.address().port),
      CAPTURE_TEST_SACN_NO_MULTICAST: "1",
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
const slot = (p: ParsedPacket, base: number, channel: number): number => p.slots[base - 1 + channel - 1];
const waitPacket = async (pred: (p: ParsedPacket) => boolean, what: string): Promise<ParsedPacket> => {
  const n0 = packets.length;
  return deck.waitFor(() => packets.slice(Math.max(0, n0 - 1)).reverse().find(pred), 3000, what);
};
const strip = (ctx: string): any => deck.lastFeedback(ctx);
const waitStrip = (ctx: string, pred: (fb: any) => boolean, what: string): Promise<any> => deck.waitFor(() => (deck.lastFeedback(ctx) && pred(deck.lastFeedback(ctx)) ? deck.lastFeedback(ctx) : undefined), 3000, what);
const waitTitle = (ctx: string, t: string): Promise<unknown> => deck.waitFor(() => deck.sent(ctx, "setTitle").at(-1)?.payload.title === t || undefined, 3000, `title of ${ctx} = ${JSON.stringify(t)}`);
const changed = (a: ParsedPacket, b: ParsedPacket): number[] => [...b.slots].map((v, i) => (v !== a.slots[i] ? i + 1 : 0)).filter(Boolean);

test("Setup panel: addresses saved; the spot's Channels list (37 rows, 8/16-bit, page) and the 'check against Capture's patch view' mark", async () => {
  deck.willAppear(A.setup, "setup", {});
  deck.inspectorAppeared(A.setup, "setup");
  let asked = 0;
  await deck.waitFor(() => {
    if (lastSetupView()?.view?.fixtures?.length === 2) return true;
    if (Date.now() - asked > 500) {
      asked = Date.now();
      deck.sendToPlugin(A.setup, "setup", { cmd: "get" }); // ask again until Capture's list has arrived
    }
    return undefined;
  }, 8000, "setup view with two fixtures");
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST_SPOT, universe: 1, address: SPOT_ADDR });
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST_WASH, universe: 1, address: WASH_ADDR });
  const v = (await deck.waitFor(() => (lastSetupView()?.view?.controllable === 2 ? lastSetupView() : undefined), 3000, "two controllable")).view;
  const spot = v.fixtures.find((f: any) => f.key === INST_SPOT);
  const t = v.types[spot.typeKey];
  assert.equal(t.channels.length, 37);
  assert.equal(t.unproven, true, "the 37-channel synthetic spot hits the parser's search budget, like the SolaFrame 750 did");
  assert.equal(spot.unproven, true);
  assert.deepEqual(t.channels[27], { n: 28, name: "Shutter 1B", bits: "8-bit", pair: null, page: "Shutters 1/3" });
  assert.deepEqual(t.channels[6], { n: 7, name: "Dimmer", bits: "16-bit", pair: 8, page: "Intensity" });
  assert.deepEqual(t.channels[7], { n: 8, name: "Dimmer Fine", bits: "16-bit fine", pair: 7, page: "" });
  const wash = v.fixtures.find((f: any) => f.key === INST_WASH);
  assert.equal(v.types[wash.typeKey].unproven, false);
  assert.equal(packets.length, 0, "no DMX before a user touch");
});

test("select the spot in Capture → Page ▶ to Shutters → turn Attribute 2 → sACN changes only on that blade's slot; press = blade out", async () => {
  deck.willAppear(A.select, "sel", {}, "Encoder");
  for (const k of ["a1", "a2", "a3"] as const) deck.willAppear(A[k], k, {}, "Encoder");
  deck.willAppear(A.prev, "prev", {});
  deck.willAppear(A.next, "next", {});
  citp.select([ID.spot]);
  await waitStrip("sel", (f) => f.line1.value === "Framing Spot" && f.line2.value === `Ch 207 · 1/${SPOT_ADDR}`, "strip shows the spot");
  await waitTitle("next", "Page ▶\nPosition");
  await waitTitle("prev", "◀ Page\nPosition");
  assert.deepEqual(["a1", "a2", "a3"].map((k) => strip(k).name.value), ["Pan", "Tilt", "Position"]);
  assert.equal(strip("a3").value.value, "—", "dial 4 has nothing on the Position page");
  for (let i = 0; i < 6; i++) deck.keyDown(A.next, "next");
  await waitTitle("next", "Page ▶\nShutters\n1/3");
  await waitStrip("a2", (f) => f.name.value === "Shutter 1B", "Attribute 2 = Shutter 1B");
  assert.deepEqual(["a1", "a3"].map((k) => strip(k).name.value), ["Shutter 1A", "Shutter 2A"]);
  assert.equal(strip("a2").value.value, "~0.0", "blades start out (0 %), nothing sent yet");
  assert.equal(packets.length, 0);

  // first touch: output starts from the defaults
  deck.dialRotate(A.a2, "a2", 10);
  const first = await waitPacket((p) => slot(p, SPOT_ADDR, 28) === Math.round(0.1 * 255), "Shutter 1B 10 %");
  assert.deepEqual([slot(first, SPOT_ADDR, 1), slot(first, SPOT_ADDR, 3)], [0x80, 0x80], "pan/tilt 50 %");
  assert.equal(slot(first, SPOT_ADDR, 6), 255, "Shutter/Strobe open");
  assert.deepEqual([slot(first, SPOT_ADDR, 7), slot(first, SPOT_ADDR, 8)], [255, 255], "16-bit dimmer 100 %");
  for (const c of [27, 29, 30, 31, 32, 33, 34, 35]) assert.equal(slot(first, SPOT_ADDR, c), 0, `the other blades out (channel ${c})`);
  for (let i = 0; i < 512; i++) if (i < SPOT_ADDR - 1 || i >= SPOT_ADDR - 1 + 37) assert.equal(first.slots[i], 0, `slot ${i + 1} outside the spot`);

  // the next turn changes that blade's slot only
  const before = packets.at(-1)!;
  deck.dialRotate(A.a2, "a2", 15);
  const after = await waitPacket((p) => slot(p, SPOT_ADDR, 28) === Math.round(0.25 * 255), "Shutter 1B 25 %");
  assert.deepEqual(changed(before, after), [SPOT_ADDR + 27], "only Shutter 1B (channel 28 of the spot) changed");
  await waitStrip("a2", (f) => f.value.value === "25.0", "strip shows 25.0 %");

  // a blade on the next page
  deck.keyDown(A.next, "next");
  await waitTitle("next", "Page ▶\nShutters\n2/3");
  await waitStrip("a3", (f) => f.name.value === "Shutter 3B", "Attribute 3 = Shutter 3B");
  const b2 = packets.at(-1)!;
  deck.dialRotate(A.a3, "a3", 40);
  const a2 = await waitPacket((p) => slot(p, SPOT_ADDR, 32) === Math.round(0.4 * 255), "Shutter 3B 40 %");
  assert.deepEqual(changed(b2, a2), [SPOT_ADDR + 31], "only Shutter 3B changed");

  // press Attribute 3 = that blade home (out), Shutter 1B keeps its value
  deck.dialDown(A.a3, "a3");
  const h = await waitPacket((p) => slot(p, SPOT_ADDR, 32) === 0, "Shutter 3B out");
  assert.equal(slot(h, SPOT_ADDR, 28), Math.round(0.25 * 255));
  // back to the first Shutters page: Shutter 1B still at 25 %
  deck.keyDown(A.prev, "prev");
  await waitTitle("prev", "◀ Page\nShutters\n1/3");
  await waitStrip("a2", (f) => f.name.value === "Shutter 1B" && f.value.value === "25.0", "Shutter 1B still 25 %");
  await deck.waitFor(() => /Fixtures: ◀ Page.*page: Shutters 1\/3|page: Shutters 1\/3/.test(deck.logText()) || undefined, 3000, "page change logged");
});

test("select the wash (a different type): pages reset to Position; the spot keeps its blade; the wash's own pages", async () => {
  citp.select([ID.wash]);
  await waitStrip("sel", (f) => f.line2.value === `Ch 203 · 1/${WASH_ADDR}`, "strip shows the wash");
  await waitTitle("next", "Page ▶\nPosition");
  const before = packets.at(-1)!;
  deck.keyDown(A.next, "next");
  await waitTitle("next", "Page ▶\nIntensity");
  await waitStrip("a1", (f) => f.name.value === "Dimmer", "Attribute 1 = Dimmer");
  deck.dialRotate(A.a1, "a1", -30);
  const p = await waitPacket((x) => slot(x, WASH_ADDR, 6) === Math.round(0.7 * 255), "wash dimmer 70 %");
  assert.equal(slot(p, SPOT_ADDR, 28), Math.round(0.25 * 255), "the spot keeps its blade");
  const diff = changed(before, p);
  assert.ok(diff.every((s) => s >= WASH_ADDR && s < WASH_ADDR + 14), `only the wash's slots changed: ${diff}`);
  // back to the spot: Position again (a different type than the wash)
  citp.select([ID.spot]);
  await waitTitle("next", "Page ▶\nPosition");
  await sleep(100);
  deck.keyDown(A.release, "rel");
});
