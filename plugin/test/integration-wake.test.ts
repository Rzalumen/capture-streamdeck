/**
 * End-to-end (Handoff 30, v0.11.0) on the REAL built plugin (bin/plugin.js): Wake (the key and the automatic wake) with a stub Capture
 * that reports its patch after the SDMX declaration, a synthetic library, a UDP listener for sACN and the fake Stream Deck application.
 * The show has three fixtures with stored values (Ch 201 and 202 on universe 1, Ch 203 on universe 2) and one patched fixture with
 * nothing stored (Ch 204 on universe 1). The plugin starts with the automatic wake OFF so that the key can be checked first.
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
const A = { setup: `${U}.fixtures.setup`, deck: `${U}.fixtures.deck`, wake: `${U}.fixtures.wake`, select: `${U}.fixture.select`, a1: `${U}.fixture.attr1` };
const FX = "aaaaaaaa-0000-0000-0000-0000000000b7";
const MD = "bbbbbbbb-0000-0000-0000-0000000000b7";
const I = (n: number) => `00000000-0000-0000-0000-0000000000${n}`;
const SHOW = "WAKE SHOW";
const F = [
  { ch: 201, id: 701, inst: I(71), patch: { universe: 1, address: 1 } },
  { ch: 202, id: 702, inst: I(72), patch: { universe: 1, address: 100 } },
  { ch: 203, id: 703, inst: I(73), patch: { universe: 2, address: 1 } },
  { ch: 204, id: 704, inst: I(74), patch: { universe: 1, address: 200 } },
];
const STORED = { [I(71)]: { ch0: 0.25, ch2: 0.75, ch5: 0.5 }, [I(72)]: { ch0: 0.9, ch7: 0.2 }, [I(73)]: { ch5: 0.33, ch12: 0.6 } };

let deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wake-e2e-"));
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

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  fs.writeFileSync(lib, buildLibraryFile({ [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) }));
  citp = await startPatchStub(
    F.map((f) => ({ mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: f.ch, fixtureGuid: FX, modeGuid: MD, instanceId: f.inst, identifier: f.id, patch: f.patch })),
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
  deck.globals = { fixtureValues: { [SHOW]: STORED }, fixtureValuesMigration: { version: 1, pending: {} }, fixtureDeck: { idleSeconds: 0, autoWake: false } };
  await deck.start({ oscPort: capture.port, pluginDir, fixtures: path.join(here, "fixtures"), env: env() });
});
after(async () => {
  await deck.stop();
  capture.stop();
  await citp.close().catch(() => undefined);
  sacn.close();
});

const at = (p: ParsedPacket, address: number): number => p.slots[address - 1];
const b16 = (v: number): [number, number] => [Math.round(v * 65535) >> 8, Math.round(v * 65535) & 0xff];
const b8 = (v: number): number => Math.round(v * 255);
const waitLog = (re: RegExp, what: string, ms = 4000): Promise<unknown> => deck.waitFor(() => re.test(deck.logText()) || undefined, ms, what);
const count = (re: RegExp): number => deck.logText().split("\n").filter((l) => re.test(l)).length;
const AUTO = /Fixtures: Wake \(automatic\): \d+ fixture\(s\) restored/;
const KEY = /Fixtures: Wake: \d+ fixture\(s\) restored/;
const waitFlash = (text: string): Promise<unknown> => deck.waitFor(() => deck.lastImageRaw("wake").includes(`>${text}<`) || undefined, 3000, `flash ${text}`);
const lastSetup = (): any => deck.received.filter((m) => m.event === "sendToPropertyInspector" && m.payload?.event === "setup").at(-1)?.payload;
const live = (from: number, u: number): ParsedPacket[] => packets.slice(from).filter((p) => p.universe === u && !p.terminated);
/** The plugin process's UDP sockets (/proc), null where /proc is not available. */
function udpSocketsOfPlugin(): number | null {
  const pid = deck.proc?.pid;
  if (!pid || !fs.existsSync(`/proc/${pid}/fd`) || !fs.existsSync("/proc/net/udp")) return null;
  const inodes = new Set<string>();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (m) inodes.add(m[1]);
    } catch {
      /* closed meanwhile */
    }
  }
  let n = 0;
  for (const f of ["/proc/net/udp", "/proc/net/udp6"]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length >= 10 && inodes.has(c[9])) n++;
    }
  }
  return n;
}
let udpBaseline: number | null = null;
/** The stored values in the frames of universe 1 / 2 (Ch 201 at 1, Ch 202 at 100, Ch 203 at 1 on u2). */
const assertStored = (u1: ParsedPacket, u2: ParsedPacket, dimmer201 = b8(0.5)): void => {
  assert.deepEqual([at(u1, 1), at(u1, 2)], b16(0.25), "Ch 201 pan");
  assert.deepEqual([at(u1, 3), at(u1, 4)], b16(0.75), "Ch 201 tilt");
  assert.equal(at(u1, 6), dimmer201, "Ch 201 dimmer");
  assert.deepEqual([at(u1, 100), at(u1, 101)], b16(0.9), "Ch 202 pan");
  assert.equal(at(u1, 107), b8(0.2), "Ch 202 red");
  assert.equal(at(u2, 6), b8(0.33), "Ch 203 dimmer");
  assert.deepEqual([at(u2, 13), at(u2, 14)], b16(0.6), "Ch 203 zoom");
  assert.equal(at(u1, 7), 255, "a channel never stored is at its home value (Shutter open)");
  assert.deepEqual([...u1.slots.slice(199, 213)], Array(14).fill(0), "Ch 204 (nothing stored) is not woken: 0 (the known limit)");
};

test("start-up with the automatic wake OFF: declared, Capture's patch taken, no wake, no sACN and no sACN socket", async () => {
  await waitLog(/Fixtures: Capture's patch: 4 of 4 fixture\(s\) patched/, "Capture's patch taken", 8000);
  await sleep(1200);
  assert.equal(count(AUTO), 0);
  assert.doesNotMatch(deck.logText(), /Wake \(automatic\): nothing stored/);
  assert.equal(packets.length, 0, "no sACN");
  udpBaseline = udpSocketsOfPlugin();
  if (process.platform === "linux") assert.notEqual(udpBaseline, null, "/proc is readable here");
});

test("Wake key: face WAKE; Woke 3 (2 s); universes 1 and 2 start with exactly the stored values; Ch 204 logged, not woken; the knobs stay disarmed and Capture's selection stays; one sACN socket (/proc)", async () => {
  deck.willAppear(A.wake, "wake", {});
  deck.willAppear(A.deck, "deckkey", {});
  deck.willAppear(A.select, "sel", {}, "Encoder");
  await deck.waitFor(() => deck.lastTitle("wake") === "WAKE" || undefined, 3000, "key face WAKE");
  citp.select([704]);
  await deck.waitFor(() => deck.lastFeedback("sel")?.line2.value.startsWith("Ch 204") || undefined, 3000, "Ch 204 selected in Capture");
  const sel0 = JSON.stringify(deck.lastFeedback("sel"));
  if (udpBaseline !== null) assert.equal(udpSocketsOfPlugin(), udpBaseline, "no sACN socket before Wake");
  deck.keyDown(A.wake, "wake");
  await waitFlash("Woke 3");
  await waitLog(/Fixtures: Wake: 3 fixture\(s\) restored on universe\(s\) 1, 2/, "the Wake line");
  assert.match(deck.logText(), /Fixtures: Wake: no stored values for Ch 204 Rogue R2X Wash \(not woken\)/);
  const u1 = await deck.waitFor(() => live(0, 1).at(-1), 3000, "universe 1");
  const u2 = await deck.waitFor(() => live(0, 2).at(-1), 3000, "universe 2");
  assertStored(u1, u2);
  assert.deepEqual([...new Set(packets.map((p) => p.universe))].sort(), [1, 2], "only the woken universes");
  if (udpBaseline !== null) assert.equal(udpSocketsOfPlugin(), udpBaseline + 1, "exactly one sACN socket after Wake (/proc)");
  assert.doesNotMatch(deck.logText(), /deck control ON/, "Wake does not arm the knobs");
  assert.match(deck.lastImageRaw("deckkey"), /#2A2E33/i, "the Deck key stays grey (OFF)");
  assert.equal(JSON.stringify(deck.lastFeedback("sel")), sel0, "the selection is unchanged");
  await sleep(1300);
  assert.ok(deck.lastImageRaw("wake").includes(">Woke 3<"), "still flashing after 1.3 s");
  await deck.waitFor(() => !deck.lastImageRaw("wake").includes(">Woke 3<") || undefined, 1500, "flash gone after 2 s");
});

test("Wake twice: the same frames, no error, still one sACN socket", async () => {
  const before1 = live(0, 1).at(-1)!;
  const before2 = live(0, 2).at(-1)!;
  const n0 = packets.length;
  deck.keyDown(A.wake, "wake");
  await waitFlash("Woke 3");
  await deck.waitFor(() => count(KEY) === 2 || undefined, 3000, "second Wake logged");
  await sleep(300);
  const a1 = live(n0, 1);
  const a2 = live(n0, 2);
  assert.ok(a1.length > 5 && a2.length > 5);
  for (const p of a1) assert.deepEqual([...p.slots], [...before1.slots]);
  for (const p of a2) assert.deepEqual([...p.slots], [...before2.slots]);
  assert.doesNotMatch(deck.logText(), /Error|failed/);
  if (udpBaseline !== null) assert.equal(udpSocketsOfPlugin(), udpBaseline + 1);
});

test("after Wake, a ChBk on a woken channel: Capture takes it (the last move wins: frames and store follow Capture; the deck did not own it)", async () => {
  citp.chbk(1, 6, [40]); // Ch 201's dimmer moved in Capture
  const n0 = packets.length;
  await deck.waitFor(() => live(n0, 1).find((p) => at(p, 6) === 40), 3000, "Capture's level in the frames");
  await deck.waitFor(() => (Math.round(((deck.globals as any).fixtureValues?.[SHOW]?.[I(71)]?.ch5 ?? -1) * 255) === 40 ? true : undefined), 4000, "and in the store");
  assert.doesNotMatch(deck.logText(), /Capture took/, "no 'Capture took': the woken value was not knob-owned");
});

test("automatic wake: a drop + reconnect while output runs = none; LeaveShow + EnterShow + declared list = exactly one; the setting off = none", async () => {
  deck.willAppear(A.setup, "setup", {});
  deck.inspectorAppeared(A.setup, "setup");
  deck.sendToPlugin(A.setup, "setup", { cmd: "autowake", on: true });
  await deck.waitFor(() => lastSetup()?.view?.deck?.autoWake === true || undefined, 3000, "automatic wake on");
  assert.deepEqual((deck.globals as any).fixtureDeck, { idleSeconds: 0, autoWake: true }, "saved with the other Deck setting");
  // the connection drops and comes back while output runs
  const pnams = () => citp.received.filter((m) => m.toString("latin1", 16, 24) === "PINFPNam").length;
  const p0 = pnams();
  citp.drop();
  await deck.waitFor(() => (pnams() === p0 + 1 && citp.declaredConns.size === 1) || undefined, 5000, "reconnected and declared");
  await sleep(1200); // several declared lists
  assert.equal(count(AUTO), 0, "no wake on a reconnect while output runs");
  assert.ok(live(packets.length - 20, 1).length > 0, "output kept running");
  // Capture closes and reopens the show
  const t0 = packets.length;
  citp.leaveShow();
  await deck.waitFor(() => packets.slice(t0).filter((p) => p.terminated).length >= 6 || undefined, 3000, "released (termination on both universes)");
  const n1 = packets.length;
  citp.enterShow(SHOW);
  await waitLog(/Fixtures: Wake \(automatic\): 3 fixture\(s\) restored on universe\(s\) 1, 2/, "automatic wake after the reopen");
  const u1 = await deck.waitFor(() => live(n1, 1).at(-1), 3000, "u1 again");
  const u2 = await deck.waitFor(() => live(n1, 2).at(-1), 3000, "u2 again");
  assertStored(u1, u2, 40); // Ch 201's dimmer: the store followed Capture's ChBk (40)
  await sleep(1200);
  assert.equal(count(AUTO), 1, "exactly one");
  assert.doesNotMatch(deck.logText(), /deck control ON/, "not armed");
  // the setting off: LeaveShow + EnterShow = none
  deck.sendToPlugin(A.setup, "setup", { cmd: "autowake", on: false });
  await deck.waitFor(() => lastSetup()?.view?.deck?.autoWake === false || undefined, 3000, "automatic wake off");
  const t1 = packets.length;
  citp.leaveShow();
  await deck.waitFor(() => packets.slice(t1).filter((p) => p.terminated).length >= 6 || undefined, 3000, "released");
  await sleep(100);
  const n2 = packets.length;
  const lists = count(/show "WAKE SHOW": 4 fixture/);
  citp.enterShow(SHOW);
  await deck.waitFor(() => count(/show "WAKE SHOW": 4 fixture/) > lists || undefined, 4000, "list again");
  await sleep(1200);
  assert.equal(count(AUTO), 1, "setting off: none");
  assert.equal(packets.length, n2, "nothing sent");
});

test("not stored for this show: Wake flashes Nothing stored and sends nothing", async () => {
  citp.enterShow("EMPTY SHOW");
  await waitLog(/show "EMPTY SHOW": 4 fixture/, "the other show's list");
  await sleep(300);
  const n0 = packets.length;
  deck.keyDown(A.wake, "wake");
  await waitFlash("Nothing stored");
  await waitLog(/Fixtures: Wake: nothing stored for show "EMPTY SHOW" \(4 addressed fixture\(s\)\): nothing sent/, "logged");
  await sleep(300);
  assert.equal(packets.length, n0, "nothing sent");
});

test("plugin start with stored values (automatic wake on): exactly one wake; then Capture gone: Wake flashes Waiting and sends nothing new", async () => {
  citp.enterShow(SHOW);
  const globals = JSON.parse(JSON.stringify(deck.globals));
  globals.fixtureDeck.autoWake = true;
  await deck.stop();
  await sleep(300);
  deck = new FakeDeck();
  deck.globals = globals;
  packets.length = 0;
  await deck.start({ oscPort: capture.port, pluginDir, fixtures: path.join(here, "fixtures"), env: env() });
  await waitLog(/Fixtures: Wake \(automatic\): 3 fixture\(s\) restored on universe\(s\) 1, 2/, "automatic wake at plugin start", 8000);
  const u1 = await deck.waitFor(() => live(0, 1).at(-1), 3000, "u1");
  const u2 = await deck.waitFor(() => live(0, 2).at(-1), 3000, "u2");
  assertStored(u1, u2, 40);
  await sleep(1200);
  assert.equal(count(AUTO), 1, "exactly one");
  // Capture goes away
  deck.willAppear(A.wake, "wake", {});
  await citp.close();
  await waitLog(/CITP: connection to Capture closed/, "connection closed");
  deck.keyDown(A.wake, "wake");
  await waitFlash("Waiting");
  await waitLog(/Fixtures: Wake: waiting for Capture \(not connected or no show open\): nothing sent/, "logged");
  assert.equal(count(KEY), 0, "no Wake ran");
});
