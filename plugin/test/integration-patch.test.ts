/**
 * End-to-end (Handoff 28, v0.10.0) on the REAL built plugin (bin/plugin.js) with a stub Capture that, like the real one, reports its
 * patch (Patched=1 + universe/address) only after the plugin declared its universes; a synthetic library; a UDP listener for sACN; the
 * fake Stream Deck application.
 *  - start-up with no Deck press: connected and declared, addresses from Capture's patch (a stored typed entry replaced and logged),
 *    Patched=0 / universe 17 not controllable, two fixtures sharing an address both controllable; Setup read-only; no sACN, one connection;
 *  - a knob drives the Capture-patched address; a re-patch in Capture (FixtureModify) moves it (driven: released first); the shared
 *    address is driven by a knob on either fixture.
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
const A = { setup: `${U}.fixtures.setup`, deck: `${U}.fixtures.deck`, select: `${U}.fixture.select`, a1: `${U}.fixture.attr1` };
const FX = "aaaaaaaa-0000-0000-0000-0000000000a8";
const MD = "bbbbbbbb-0000-0000-0000-0000000000a8";
const I = (n: number) => `00000000-0000-0000-0000-0000000000${n}`;
const SHOW = "PATCH SHOW";
// Ch 202 at 1/444, Ch 203 and Ch 205 BOTH at 1/285 (as in Reza's show), Ch 204 not patched, Ch 207 on universe 17
const FIXTURES = [
  { ch: 202, id: 501, inst: I(51), patch: { universe: 1, address: 444 } },
  { ch: 203, id: 502, inst: I(52), patch: { universe: 1, address: 285 } },
  { ch: 205, id: 503, inst: I(53), patch: { universe: 1, address: 285 } },
  { ch: 204, id: 504, inst: I(54), patch: undefined },
  { ch: 207, id: 505, inst: I(55), patch: { universe: 17, address: 1 } },
];

const deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patch-e2e-"));
const lib = path.join(tmp, "Library.c2z");
const sacn = dgram.createSocket("udp4");
const packets: ParsedPacket[] = [];
let citp: CitpStub;

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  fs.writeFileSync(lib, buildLibraryFile({ [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) }));
  citp = await startPatchStub(
    FIXTURES.map((f) => ({ mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: f.ch, fixtureGuid: FX, modeGuid: MD, instanceId: f.inst, identifier: f.id, patch: f.patch })),
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
  // a typed entry from an earlier session: Ch 202 at 2/1 (wrong); Capture's patch must replace it
  deck.globals = { fixtureSetup: { [SHOW]: { [I(51)]: { universe: 2, address: 1 } } } };
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

const at = (p: ParsedPacket, address: number): number => p.slots[address - 1];
const pan16 = (p: ParsedPacket, base: number): number => (at(p, base) << 8) | at(p, base + 1);
const waitPacket = async (pred: (p: ParsedPacket) => boolean, what: string): Promise<ParsedPacket> => {
  const n0 = packets.length;
  return deck.waitFor(() => packets.slice(Math.max(0, n0 - 1)).reverse().find((p) => !p.terminated && pred(p)), 3000, what);
};
const waitLog = (re: RegExp, what: string, ms = 3000): Promise<unknown> => deck.waitFor(() => re.test(deck.logText()) || undefined, ms, what);
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
const select = async (id: number, ch: number): Promise<void> => {
  citp.select([id]);
  await waitStrip("sel", (f) => f.line2.value.startsWith(`Ch ${ch}`), `selected in Capture: Ch ${ch}`);
};

test("start-up, no Deck press: addresses from Capture's patch (typed 2/1 replaced, logged); Patched=0 and universe 17 not controllable; 203 and 205 share 1/285, both controllable; Setup read-only; no sACN; one connection", async () => {
  await waitLog(/Fixtures: Capture's patch: 4 of 5 fixture\(s\) patched/, "Capture's patch taken", 8000);
  assert.match(deck.logText(), /Fixtures: address from Capture's patch Ch 202 Rogue R2X Wash -> 1\/444 \(was 2\/1, typed\)/);
  assert.match(deck.logText(), /Fixtures: address from Capture's patch Ch 207 Rogue R2X Wash 17\/1: universe not declared \(1-16\) — not controllable/);
  assert.match(deck.logText(), /Fixtures: patch conflict in Capture: Ch 20[35] and Ch 20[35] both at 1\/285 \(fix the patch in Capture\)/); // v0.12.0 wording
  assert.doesNotMatch(deck.logText(), /deck control ON/);
  deck.willAppear(A.setup, "setup", {});
  deck.inspectorAppeared(A.setup, "setup");
  const v = await getView((x) => x.patch?.patched === 4, "panel in patch mode");
  assert.deepEqual(v.patch, { patched: 4, total: 5 });
  assert.deepEqual(row(v, 202).addr, { universe: 1, address: 444, src: "capture" });
  assert.equal(row(v, 202).controllable, true);
  for (const c of [203, 205]) {
    assert.deepEqual(row(v, c).addr, { universe: 1, address: 285, src: "capture" });
    assert.equal(row(v, c).controllable, true, `Ch ${c} controllable despite sharing`);
  }
  assert.deepEqual(row(v, 203).shared, ["⚠ patch conflict with Ch 205 at 1/285 — fix in Capture"]);
  assert.deepEqual(row(v, 205).shared, ["⚠ patch conflict with Ch 203 at 1/285 — fix in Capture"]);
  assert.equal(row(v, 204).addr, null);
  assert.equal(row(v, 204).controllable, false);
  assert.equal(row(v, 207).controllable, false);
  assert.match(row(v, 207).issues.join(" "), /universe not declared \(1-16\)/);
  assert.equal(v.controllable, 3);
  // typing is refused while Capture's patch is the source
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: I(54), universe: 1, address: 1 });
  await deck.waitFor(() => /Addresses come from Capture's patch/.test(lastSetup()?.error ?? "") || undefined, 3000, "set refused");
  assert.equal((deck.globals as any).fixtureSetup[SHOW][I(54)], undefined);
  assert.deepEqual((deck.globals as any).fixtureSetup[SHOW][I(51)], { universe: 1, address: 444, src: "capture" }, "stored as Capture's");
  assert.equal(packets.length, 0, "no sACN before a touch");
  assert.equal(citp.clients.size, 1);
  assert.equal(citp.of(CAEX.EnterShow).length, 1, "one connection");
});

test("Deck ON, select 202, turn Pan: the frames carry it at Capture's 1/444", async () => {
  deck.willAppear(A.deck, "deckkey", {});
  deck.willAppear(A.select, "sel", {}, "Encoder");
  deck.willAppear(A.a1, "a1", {}, "Encoder");
  deck.keyDown(A.deck, "deckkey");
  await waitLog(/deck control ON \(Deck Control key\)/, "ON");
  await select(501, 202);
  deck.dialRotate(A.a1, "a1", 10);
  await waitPacket((x) => pan16(x, 444) === Math.round(0.6 * 65535), "202 pan 60 % at 1/444");
});

test("re-patch 202 in Capture to 1/100 (FixtureModify): Setup shows it, the driven fixture is released first, the knob drives it there; then back to 1/444", async () => {
  const t0 = packets.length;
  citp.fixtures[0].patch = { universe: 1, address: 100 };
  citp.modify([{ identifier: 501, changed: 0x01, patched: 1, universe: 0, universeChannel: 99 }]);
  await waitLog(/Fixtures: address from Capture's patch Ch 202 Rogue R2X Wash -> 1\/100 \(was 1\/444, from Capture\)/, "re-patch logged");
  await waitLog(/the address of a fixture that is being driven changed: releasing output/, "released first");
  await deck.waitFor(() => (packets.slice(t0).filter((x) => x.terminated).length === 3 ? true : undefined), 3000, "termination ×3 (release, as before)");
  const v = await getView((x) => row(x, 202)?.addr?.address === 100, "Setup shows 1/100");
  assert.equal(row(v, 202).controllable, true);
  await select(501, 202);
  deck.dialRotate(A.a1, "a1", 5);
  await waitPacket((x) => pan16(x, 100) === Math.round(0.65 * 65535), "202 pan 65 % at 1/100 (continued from its value)");
  citp.fixtures[0].patch = { universe: 1, address: 444 };
  citp.modify([{ identifier: 501, changed: 0x01, patched: 1, universe: 0, universeChannel: 443 }]);
  await getView((x) => row(x, 202)?.addr?.address === 444, "back at 1/444");
});

test("the shared address: a knob on 203 and a knob on 205 both drive 1/285", async () => {
  await select(502, 203);
  deck.dialRotate(A.a1, "a1", 10);
  await waitPacket((x) => pan16(x, 285) === Math.round(0.6 * 65535), "203 drives 1/285");
  await select(503, 205);
  deck.dialRotate(A.a1, "a1", -10);
  await waitPacket((x) => pan16(x, 285) === Math.round(0.4 * 65535), "205 drives the same slots");
  await sleep(100);
  assert.equal(citp.of(CAEX.EnterShow).length, 1, "still one connection");
});
