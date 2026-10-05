/**
 * End-to-end (Handoff 23, v0.7.2): the deck drives ONLY what Capture selected during the current Deck Control ON connection.
 * REAL built plugin (bin/plugin.js), stub CITP server, synthetic library, a UDP listener for sACN, the fake Stream Deck application.
 * Two controllable fixtures: A (Ch 201, first in channel order — the old fallback) and B (Ch 202).
 *  - ON, select B, turn Pan: only B's slots change;
 *  - OFF; ON by a knob turn: nothing changes (no fallback to A, no carry-over of B), strip "Click a light / in Capture";
 *  - select B, turn: only B, continuing from B's stored value;
 *  - the stub drops the connection and reconnects with no selection: a turn moves nothing;
 *  - LeaveShow + EnterShow with no selection (Reza's 18:29–18:31 log): a turn moves nothing;
 *  - an empty FixtureSelection, then a turn: nothing moves.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAEX } from "../src/fixtures/citp.ts";
import { parseDataPacket, type ParsedPacket } from "../src/fixtures/sacn.ts";
import { FakeDeck, sleep } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";
import { buildLibraryFile, buildModeBlock, buildObject, movingHead, startPatchStub, type CitpStub } from "./fixtures/synth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../com.rezabehjat.capture.sdPlugin");
const U = "com.rezabehjat.capture";
const A_ = { setup: `${U}.fixtures.setup`, deck: `${U}.fixtures.deck`, home: `${U}.fixtures.home`, select: `${U}.fixture.select`, a1: `${U}.fixture.attr1` };
const FX = "aaaaaaaa-0000-0000-0000-0000000000f1";
const MD = "bbbbbbbb-0000-0000-0000-0000000000f1";
const INST_A = "00000000-0000-0000-0000-0000000000f1";
const INST_B = "00000000-0000-0000-0000-0000000000f2";
const ID_A = 501;
const ID_B = 502;
const ADDR_A = 1;
const ADDR_B = 15;
const N = 14; // channels per fixture

const deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sel-e2e-"));
const lib = path.join(tmp, "Library.c2z");
const sacn = dgram.createSocket("udp4");
const packets: ParsedPacket[] = [];
let citp: CitpStub;

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  fs.writeFileSync(lib, buildLibraryFile({ [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) }));
  citp = await startPatchStub(
    [
      { mfr: "Test", name: "Wash A", mode: "Std", channels: N, channel: 201, fixtureGuid: FX, modeGuid: MD, instanceId: INST_A, position: [-2, 6, 2], identifier: ID_A },
      { mfr: "Test", name: "Wash B", mode: "Std", channels: N, channel: 202, fixtureGuid: FX, modeGuid: MD, instanceId: INST_B, position: [2, 6, 2], identifier: ID_B },
    ],
    { showName: "SEL SHOW" },
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
const waitStrip = (ctx: string, pred: (fb: any) => boolean, what: string): Promise<any> => deck.waitFor(() => (deck.lastFeedback(ctx) && pred(deck.lastFeedback(ctx)) ? deck.lastFeedback(ctx) : undefined), 3000, what);
const waitTitle = (ctx: string, t: string): Promise<unknown> => deck.waitFor(() => deck.sent(ctx, "setTitle").at(-1)?.payload.title === t || undefined, 4000, `title ${JSON.stringify(t)}`);
const live = (from: number): ParsedPacket[] => packets.slice(from).filter((p) => !p.terminated);
/** Universe-1 slots (1-based) that differ between two frames. */
const changed = (a: ParsedPacket | undefined, b: ParsedPacket): number[] => [...b.slots].map((v, i) => (v !== (a ? a.slots[i] : 0) ? i + 1 : 0)).filter(Boolean);
const inA = (s: number): boolean => s >= ADDR_A && s < ADDR_A + N;
const inB = (s: number): boolean => s >= ADDR_B && s < ADDR_B + N;
const panB = (p: ParsedPacket): number => (p.slots[ADDR_B - 1] << 8) | p.slots[ADDR_B];
const noSelection = (what: string): Promise<any> => waitStrip("sel", (f) => f.line1.value === "Click a light" && f.line2.value === "in Capture", what);
const selectB = async (): Promise<void> => {
  await deck.waitFor(() => citp.clients.size === 1 || undefined, 4000, "persistent session");
  citp.select([ID_B]);
  await waitStrip("sel", (f) => f.line2.value === `Ch 202 · 1/${ADDR_B}`, "B selected in Capture");
};
/** Turns Pan and checks that NO slot of A or B changes in any sACN frame sent afterwards (compared with the frame before). */
const turnMovesNothing = async (what: string): Promise<void> => {
  await sleep(100);
  const n0 = packets.length;
  const before = packets.filter((p) => !p.terminated).at(-1);
  deck.dialRotate(A_.a1, "a1", 5);
  await sleep(500);
  for (const p of live(n0)) assert.deepEqual(changed(before, p).filter((s) => inA(s) || inB(s)), [], `${what}: no slot of A or B changes`);
};

test("setup: both fixtures addressed (Deck Control OFF); nothing selected; no DMX", async () => {
  deck.willAppear(A_.deck, "deckkey", {});
  deck.willAppear(A_.select, "sel", {}, "Encoder");
  deck.willAppear(A_.a1, "a1", {}, "Encoder");
  deck.willAppear(A_.setup, "setup", {});
  deck.inspectorAppeared(A_.setup, "setup");
  await deck.waitFor(() => /brief sync \(Setup panel\): \d+ ms, 2 fixture/.test(deck.logText()) || undefined, 8000, "fixture list read");
  deck.sendToPlugin(A_.setup, "setup", { cmd: "set", key: INST_A, universe: 1, address: ADDR_A });
  deck.sendToPlugin(A_.setup, "setup", { cmd: "set", key: INST_B, universe: 1, address: ADDR_B });
  await deck.waitFor(() => (lastSetupView()?.view?.controllable === 2 ? true : undefined), 3000, "A and B controllable");
  await waitTitle("deckkey", "Deck OFF");
  await noSelection("nothing selected yet");
  assert.equal(packets.length, 0);
});

test("ON, select B, turn Pan: only B's slots change", async () => {
  deck.keyDown(A_.deck, "deckkey");
  await waitTitle("deckkey", "Deck ON");
  await selectB();
  assert.equal(packets.length, 0, "selecting sends nothing");
  deck.dialRotate(A_.a1, "a1", 10);
  const p = await deck.waitFor(() => live(0).find((x) => panB(x) === Math.round(0.6 * 65535)), 3000, "B pan 60 %");
  for (const x of live(0)) assert.ok(changed(undefined, x).every(inB), "every non-zero slot is one of B's");
  assert.ok(p.slots.subarray(ADDR_A - 1, ADDR_A - 1 + N).every((v) => v === 0), "A untouched");
});

test("OFF; ON by a knob turn: nothing moves, no fallback to A and no carry-over of B; the strip reads 'Click a light / in Capture'", async () => {
  deck.keyDown(A_.deck, "deckkey");
  await waitTitle("deckkey", "Deck OFF");
  await deck.waitFor(() => citp.clients.size === 0 || undefined, 3000, "closed");
  assert.match(deck.logText(), /Fixtures: deck control OFF: selection cleared/);
  await noSelection("OFF cleared the selection");
  // in Capture the user now clicks and moves A with the mouse: the deck sees none of it (no connection)
  const n0 = packets.length;
  deck.dialRotate(A_.a1, "a1", 5);
  await waitTitle("deckkey", "Deck ON");
  await deck.waitFor(() => citp.clients.size === 1 || undefined, 4000, "persistent session");
  await sleep(500);
  assert.equal(packets.length, n0, "no sACN packet at all after the turn (nothing selected in this connection)");
  await noSelection("still nothing selected");
});

test("select B, turn Pan: only B's slots change, continuing from B's stored value", async () => {
  await selectB();
  const n0 = packets.length;
  deck.dialRotate(A_.a1, "a1", 5);
  await deck.waitFor(() => live(n0).find((x) => panB(x) === Math.round(0.65 * 65535)), 3000, "B pan 65 % (resumed from 60 %)");
  for (const x of live(n0)) assert.ok(changed(undefined, x).every(inB), "only B's slots are non-zero");
});

test("the stub drops the connection; it reconnects with no selection: a turn moves nothing", async () => {
  const enters = citp.of(CAEX.EnterShow).length;
  citp.drop();
  await deck.waitFor(() => (citp.of(CAEX.EnterShow).length > enters && citp.clients.size === 1) || undefined, 5000, "reconnected");
  await deck.waitFor(() => /Fixtures: CITP connection closed: selection cleared/.test(deck.logText()) || undefined, 2000, "cleared on close");
  await noSelection("after the reconnect");
  await turnMovesNothing("after a reconnect");
});

test("LeaveShow and EnterShow again with no selection (the 18:29–18:31 case): a turn moves nothing", async () => {
  await selectB(); // something selected before the show is reopened
  citp.leaveShow();
  await deck.waitFor(() => /Capture left the show/.test(deck.logText()) || undefined, 3000, "left");
  const lists = citp.of(CAEX.FixtureListRequest).length;
  citp.enterShow("SEL SHOW");
  await deck.waitFor(() => citp.of(CAEX.FixtureListRequest).length > lists || undefined, 3000, "list asked again");
  await waitStrip("sel", (f) => f.line1.value === "Click a light" && f.mark.value === "", "show back, nothing selected");
  await sleep(300);
  await turnMovesNothing("after LeaveShow/EnterShow");
});

test("an empty FixtureSelection, then a turn: nothing moves", async () => {
  await selectB();
  const n0 = packets.length;
  deck.dialRotate(A_.a1, "a1", 1);
  await deck.waitFor(() => live(n0).length > 0 || undefined, 3000, "B moves while selected");
  citp.select([]);
  await noSelection("empty selection");
  assert.match(deck.logText(), /Capture's selection is empty: nothing selected on the deck/);
  await turnMovesNothing("after an empty selection");
  // Home moves nothing either
  deck.willAppear(A_.home, "home", {});
  const n1 = packets.length;
  const before = packets.filter((p) => !p.terminated).at(-1);
  deck.keyDown(A_.home, "home");
  await sleep(400);
  for (const p of live(n1)) assert.deepEqual(changed(before, p).filter((s) => inA(s) || inB(s)), [], "Home with nothing selected changes nothing");
});
