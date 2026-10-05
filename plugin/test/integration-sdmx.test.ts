/**
 * End-to-end (Handoff 26, v0.8.0) on the REAL built plugin (bin/plugin.js) with a stub Capture that, like the real one, sends SDMX Capa
 * on connect and ChBk level deltas later; a synthetic library; a UDP listener for sACN; the fake Stream Deck application.
 *  - start-up (Deck OFF): the brief connection sends no SDMX;
 *  - Deck ON: PNam, LaserFeedList, EnterShow, SXSr + SXUS 1-16 (exact bytes), FixtureListRequest; Capa and the declaration logged;
 *  - the deck drives fixture A (Ch 203); Capture reports levels for fixture B (Ch 202): the frames now carry B's levels while A keeps
 *    the knob values (frame diff); a block on A's knob channel does not change the output and is logged as a disagreement; Blind=1
 *    and a truncated ChBk change nothing; unconfigured slots ride along (overlay only);
 *  - Deck OFF -> ON: B's levels are still in the frames; B's untouched channels resume from Capture's levels, not from home.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAEX, UNIDENTIFIED, buildSxsr, buildSxus } from "../src/fixtures/citp.ts";
import { parseDataPacket, type ParsedPacket } from "../src/fixtures/sacn.ts";
import { FakeDeck, sleep } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";
import { buildChBk, buildLibraryFile, buildModeBlock, buildObject, movingHead, startPatchStub, type CitpStub } from "./fixtures/synth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../com.rezabehjat.capture.sdPlugin");
const U = "com.rezabehjat.capture";
const A = {
  setup: `${U}.fixtures.setup`,
  deck: `${U}.fixtures.deck`,
  select: `${U}.fixture.select`,
  a1: `${U}.fixture.attr1`,
  a2: `${U}.fixture.attr2`,
  a3: `${U}.fixture.attr3`,
};
const FX = "aaaaaaaa-0000-0000-0000-0000000000f1";
const MD = "bbbbbbbb-0000-0000-0000-0000000000f1";
const INST_A = "00000000-0000-0000-0000-0000000000f1";
const INST_B = "00000000-0000-0000-0000-0000000000f2";
const ID_A = 100001;
const ID_B = 100002;
const ADDR_A = 285;
const ADDR_B = 444;
// movingHead: 1/2 Pan, 3/4 Tilt, 5 Pan/Tilt Speed, 6 Dimmer, 7 Shutter, 8 Red, 9 Green, 10 Blue, 11 White, 12 Amber, 13/14 Zoom

const deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdmx-e2e-"));
const lib = path.join(tmp, "Library.c2z");
const sacn = dgram.createSocket("udp4");
const packets: ParsedPacket[] = [];
let citp: CitpStub;

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  fs.writeFileSync(lib, buildLibraryFile({ [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) }));
  citp = await startPatchStub(
    [
      { mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 203, fixtureGuid: FX, modeGuid: MD, instanceId: INST_A, identifier: UNIDENTIFIED },
      { mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 202, fixtureGuid: FX, modeGuid: MD, instanceId: INST_B, identifier: UNIDENTIFIED },
    ],
    { showName: "SDMX SHOW" },
  );
  citp.sendCapa = true;
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

const names = (msgs: Buffer[]): string[] => msgs.map((m) => (m.toString("latin1", 16, 20) === "CAEX" ? `CAEX:0x${m.readUInt32LE(20).toString(16)}` : m.toString("latin1", 16, 24)));
const sdmxSent = (): Buffer[] => citp.received.filter((m) => m.toString("latin1", 16, 20) === "SDMX");
const at = (p: ParsedPacket, address: number): number => p.slots[address - 1];
const pan16 = (p: ParsedPacket, base: number): number => (at(p, base) << 8) | at(p, base + 1);
const live = (): ParsedPacket[] => packets.filter((p) => !p.terminated);
const waitPacket = async (pred: (p: ParsedPacket) => boolean, what: string): Promise<ParsedPacket> => {
  const n0 = packets.length;
  return deck.waitFor(() => packets.slice(Math.max(0, n0 - 1)).reverse().find((p) => !p.terminated && pred(p)), 3000, what);
};
const waitLog = (re: RegExp, what: string, ms = 3000): Promise<unknown> => deck.waitFor(() => re.test(deck.logText()) || undefined, ms, what);
const waitStrip = (ctx: string, pred: (fb: any) => boolean, what: string): Promise<any> => deck.waitFor(() => (deck.lastFeedback(ctx) && pred(deck.lastFeedback(ctx)) ? deck.lastFeedback(ctx) : undefined), 3000, what);
/** Slots (1-based addresses) that differ between two frames. */
const changed = (a: ParsedPacket, b: ParsedPacket): number[] => [...b.slots].map((v, i) => (v !== a.slots[i] ? i + 1 : 0)).filter(Boolean);
const select = async (id: number, ch: number): Promise<void> => {
  citp.select([id]);
  await waitStrip("sel", (f) => f.line2.value.startsWith(`Ch ${ch}`), `selected in Capture: Ch ${ch}`);
};
const lastSetupView = (): any => deck.received.filter((m) => m.event === "sendToPropertyInspector" && m.payload?.event === "setup").at(-1)?.payload;

test("start-up brief connection: no SDMX; addresses set (A 1/285, B 1/444)", async () => {
  await waitLog(/Fixtures: brief sync \(start-up\): \d+ ms, 2 fixture\(s\), connection closed/, "brief sync", 8000);
  assert.equal(sdmxSent().length, 0, "the brief connection sent no SDMX");
  assert.match(deck.logText(), /CITP: SDMX Capa received: 2, 3, 4, 101, 102, 105/, "Capa is logged on the brief connection too (nothing is sent back)");
  deck.willAppear(A.setup, "setup", {});
  deck.inspectorAppeared(A.setup, "setup");
  await waitLog(/brief sync \(Setup panel\)/, "brief sync for the panel", 6000);
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST_A, universe: 1, address: ADDR_A });
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST_B, universe: 1, address: ADDR_B });
  await deck.waitFor(() => (lastSetupView()?.view?.controllable === 2 ? true : undefined), 3000, "both addresses saved");
  deck.sendToPlugin(A.setup, "setup", { cmd: "idle", seconds: 0 });
  await deck.waitFor(() => lastSetupView()?.view?.deck?.idleSeconds === 0 || undefined, 3000, "idle off");
  await deck.waitFor(() => citp.clients.size === 0 || undefined, 3000, "brief connections closed");
  assert.equal(sdmxSent().length, 0, "still no SDMX after the panel's brief connections");
});

test("Deck ON: the declaration follows our EnterShow (exact bytes), once; the deck drives A", async () => {
  deck.willAppear(A.deck, "deckkey", {});
  deck.willAppear(A.select, "sel", {}, "Encoder");
  for (const k of ["a1", "a2", "a3"] as const) deck.willAppear(A[k], k, {}, "Encoder");
  const n0 = citp.received.length;
  deck.keyDown(A.deck, "deckkey");
  await waitLog(/CITP: declared sACN universes 1-16 \(SXSr \+ 16 SXUS\)/, "declaration logged", 5000);
  await deck.waitFor(() => citp.of(CAEX.FixtureListRequest).length && citp.received.length >= n0 + 21 ? true : undefined, 3000, "list request after the declaration");
  const seq = citp.received.slice(n0);
  assert.deepEqual(names(seq).slice(0, 21), ["PINFPNam", "CAEX:0x30101", "CAEX:0x20100", "SDMXSXSr", ...Array(16).fill("SDMXSXUS"), "CAEX:0x20200"]);
  assert.deepEqual(seq[3], buildSxsr(1));
  for (let u = 1; u <= 16; u++) assert.deepEqual(seq[3 + u], buildSxus(u));
  // byte-level against the real run's first and last SXUS
  assert.equal(seq[4].toString("hex"), "43495450010000002600000001000000" + "53444d58" + "53585553" + "00" + Buffer.from("BSRE1.31/1/1\0").toString("hex"));
  assert.equal(seq[19].toString("hex"), "43495450010000002700000001000000" + "53444d58" + "53585553" + "0f" + Buffer.from("BSRE1.31/16/1\0").toString("hex"));
  assert.match(deck.logText(), /CITP: SDMX Capa received: 2, 3, 4, 101, 102, 105/);
  await select(ID_A, 203);
  await waitStrip("a1", (f) => f.name.value === "Pan", "Main page: Pan");
  deck.dialRotate(A.a1, "a1", 10); // A pan 60 %
  const p = await waitPacket((x) => pan16(x, ADDR_A) === Math.round(0.6 * 65535), "A pan 60 %");
  assert.deepEqual([...p.slots.subarray(ADDR_B - 1, ADDR_B - 1 + 14)], Array(14).fill(0), "B: nothing known yet -> 0");
  assert.equal(sdmxSent().length, 17, "declared once on this connection");
  for (const m of sdmxSent()) assert.ok(["SXSr", "SXUS"].includes(m.toString("latin1", 20, 24)), "only SXSr / SXUS were ever sent");
});

test("ChBk for B: B's slots carry Capture's levels while A keeps the knob values (frame diff); store + log", async () => {
  const before = live().at(-1)!;
  citp.push(Buffer.from("43495450010000002200000001000000" + "53444d58" + "4368426b" + "0000bb010400" + "16b3dcb0", "hex")); // the real ChBk: u1 a444 x4
  citp.chbk(1, ADDR_B + 5, [128]); // B dimmer
  const p = await waitPacket((x) => at(x, ADDR_B) === 22 && at(x, ADDR_B + 5) === 128, "B at Capture's levels");
  assert.deepEqual(changed(before, p), [ADDR_B, ADDR_B + 1, ADDR_B + 2, ADDR_B + 3, ADDR_B + 5], "ONLY B's reported slots changed");
  assert.deepEqual([at(p, ADDR_B), at(p, ADDR_B + 1), at(p, ADDR_B + 2), at(p, ADDR_B + 3)], [22, 179, 220, 176]);
  assert.equal(pan16(p, ADDR_A), Math.round(0.6 * 65535), "A keeps the knob value");
  await waitLog(/Fixtures: Capture levels u1 a444-447 = 22,179,220,176 -> Ch 202 ch 1-4/, "log line for B's pan/tilt");
  await waitLog(/Fixtures: Capture levels u1 a449 = 128 -> Ch 202 ch 6/, "log line for B's dimmer");
  // A still turns
  deck.dialRotate(A.a1, "a1", 5);
  const q = await waitPacket((x) => pan16(x, ADDR_A) === Math.round(0.65 * 65535), "A pan 65 %");
  assert.equal(at(q, ADDR_B), 22, "B stays at Capture's level while A moves");
  assert.equal(at(q, ADDR_B + 5), 128);
});

test("ChBk on A's knob channel: output keeps the deck value, disagreement logged; Blind=1 and truncated ChBk change nothing; unconfigured slots ride along", async () => {
  const want = Math.round(0.65 * 65535);
  citp.chbk(1, ADDR_A, [1, 2, 64, 0]); // A pan (deck set it) + A tilt (deck did not)
  const p = await waitPacket((x) => at(x, ADDR_A + 2) === 64, "A tilt follows Capture");
  assert.equal(pan16(p, ADDR_A), want, "A's pan is the deck's");
  await waitLog(/Fixtures: Capture levels u1 a285-288 disagree with channels the deck set \(deck value kept; possibly Capture echoing our sACN\): Ch 203 "Pan": Capture 0\.4 %, deck 65\.0 %/, "disagreement logged");
  const before = live().at(-1)!;
  citp.chbk(1, ADDR_B + 5, [9], 1); // Blind
  const real = buildChBk(1, ADDR_B + 7, [200, 200]);
  const trunc = Buffer.from(real.subarray(0, real.length - 1));
  trunc.writeUInt32LE(trunc.length, 8);
  citp.push(trunc);
  await waitLog(/Fixtures: Capture levels u1 a449 Blind=1: blind \(preview\) levels, ignored/, "Blind logged");
  await waitLog(/CITP: SDMX ChBk malformed \(need 2 byte\(s\).*\); ignored\. hex: 43 49 54 50 01 00 00 00 1f 00 00 00 01 00 00 00 53 44 4d 58 43 68 42 6b 00 00 c2 01 02 00 c8$/m, "truncated logged with hex");
  await sleep(200);
  assert.deepEqual(changed(before, live().at(-1)!), [], "Blind and truncated: no slot changed");
  citp.chbk(1, 50, [5, 6, 7, 8]);
  const u = await waitPacket((x) => at(x, 50) === 5, "unconfigured slots");
  assert.deepEqual([at(u, 50), at(u, 51), at(u, 52), at(u, 53)], [5, 6, 7, 8]);
  await waitLog(/Fixtures: Capture levels u1 a50-53 = 5,6,7,8 \(no configured fixture\) -> overlay only/, "overlay-only log");
  // B selected: the strip shows Capture's value as the remembered value (~)
  await select(ID_B, 202);
  await waitStrip("a1", (f) => f.value.value === `~${(((22 << 8) | 179) / 65535 * 100).toFixed(1)}`, "B pan strip = ~Capture's value");
  await waitStrip("a3", (f) => f.value.value === `~${((128 / 255) * 100).toFixed(1)}`, "B dimmer strip = ~Capture's value");
});

test("Deck OFF -> ON: B's levels stay in the frames; B's untouched channels resume from Capture's levels, not home", async () => {
  deck.keyDown(A.deck, "deckkey");
  await deck.waitFor(() => citp.clients.size === 0 || undefined, 3000, "OFF: closed");
  await waitLog(/deck control OFF \(Deck Control key\)/, "OFF");
  await deck.waitFor(() => ((deck.globals as any).fixtureValues?.["SDMX SHOW"]?.[INST_B]?.ch5 !== undefined ? true : undefined), 3000, "B's values saved");
  const saved = (deck.globals as any).fixtureValues["SDMX SHOW"][INST_B];
  assert.equal(Math.round(saved.ch0 * 65535), (22 << 8) | 179, "B pan stored from Capture");
  assert.equal(Math.round(saved.ch5 * 255), 128, "B dimmer stored from Capture");
  const decl0 = sdmxSent().length;
  deck.keyDown(A.deck, "deckkey"); // ON
  await deck.waitFor(() => (sdmxSent().length === decl0 + 17 ? true : undefined), 5000, "declared again on the new connection");
  await select(ID_A, 203);
  deck.dialRotate(A.a1, "a1", 5); // A pan 70 %
  const p = await waitPacket((x) => pan16(x, ADDR_A) === Math.round(0.7 * 65535), "A pan 70 %");
  assert.deepEqual([at(p, ADDR_B), at(p, ADDR_B + 1), at(p, ADDR_B + 2), at(p, ADDR_B + 3), at(p, ADDR_B + 5)], [22, 179, 220, 176, 128], "B's levels survived OFF -> ON");
  assert.deepEqual([at(p, 50), at(p, 53)], [5, 8], "unconfigured slots too");
  // now drive B: its tilt by the knob, everything else from Capture's levels (not home: dimmer would be 255, pan 0x8000)
  await select(ID_B, 202);
  deck.dialRotate(A.a2, "a2", 1); // B tilt +1 %
  const tilt = Math.round(Math.min(1, ((220 << 8) | 176) / 65535 + 0.01) * 10000) / 10000;
  const q = await waitPacket((x) => ((at(x, ADDR_B + 2) << 8) | at(x, ADDR_B + 3)) === Math.round(tilt * 65535), "B tilt +1 % from Capture's level");
  assert.equal(pan16(q, ADDR_B), (22 << 8) | 179, "B pan: Capture's level, not home 50 %");
  assert.equal(at(q, ADDR_B + 5), 128, "B dimmer: Capture's level, not home 100 %");
  assert.equal(pan16(q, ADDR_A), Math.round(0.7 * 65535), "A keeps its knob value");
});
