/**
 * End-to-end (Handoff 21): Deck Control on the REAL built plugin (bin/plugin.js) with a stub CITP server, a synthetic library, a UDP
 * listener for sACN and the fake Stream Deck application.
 *  - v0.10.0 start-up: the persistent session with no Deck press (PNam → EnterShow → declaration → list → FixtureIdentify), held (/proc);
 *    no sACN and no sACN socket (/proc) until the first fixture touch; Setup / Status / the Setup panel are list requests on it (one
 *    connection for the whole run);
 *  - ON by the Deck Control key, by a knob turn, by a fixture key; idle auto-OFF disarms only (v0.9.0);
 *  - resume after OFF → ON and after a plugin restart; push = fine, tap = home.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAEX, UNIDENTIFIED, decodeMessage } from "../src/fixtures/citp.ts";
import { parseDataPacket, type ParsedPacket } from "../src/fixtures/sacn.ts";
import { FakeDeck, sleep } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";
import { buildLibraryFile, buildModeBlock, buildObject, movingHead, startPatchStub, type CitpStub } from "./fixtures/synth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../com.rezabehjat.capture.sdPlugin");
const U = "com.rezabehjat.capture";
const A = {
  setup: `${U}.fixtures.setup`,
  status: `${U}.fixtures.status`,
  home: `${U}.fixtures.home`,
  deck: `${U}.fixtures.deck`,
  next: `${U}.fixtures.page-next`,
  select: `${U}.fixture.select`,
  a1: `${U}.fixture.attr1`,
  a2: `${U}.fixture.attr2`,
  a3: `${U}.fixture.attr3`,
};
const FX = "aaaaaaaa-0000-0000-0000-0000000000e1";
const MD = "bbbbbbbb-0000-0000-0000-0000000000e1";
const INST = "00000000-0000-0000-0000-0000000000e1";
const ADDR = 285;
const ID = 100001;

let deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-e2e-"));
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
  citp = await startPatchStub([{ mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 203, fixtureGuid: FX, modeGuid: MD, instanceId: INST, position: [4, 6, 2], identifier: UNIDENTIFIED }], { showName: "DECK SHOW" });
  sacn.on("message", (m) => {
    try {
      packets.push(parseDataPacket(m));
    } catch {
      /* not an E1.31 data packet */
    }
  });
  await new Promise<void>((r) => sacn.bind(0, "127.0.0.1", r));
  await capture.start();
  await deck.start({ oscPort: capture.port, pluginDir, fixtures: path.join(here, "fixtures"), env: env() });
});
after(async () => {
  await deck.stop();
  capture.stop();
  await citp.close();
  sacn.close();
});

const codes = (from = 0): string[] =>
  citp.received.slice(from).map((m) => {
    const d = decodeMessage(m);
    return d.layer === "CAEX" ? `CAEX:0x${d.code!.toString(16)}` : `${d.layer}:${m.toString("latin1", 20, 24)}`;
  });
const C = (c: number): string => `CAEX:0x${c.toString(16)}`;
const lastSetupView = (): any => deck.received.filter((m) => m.event === "sendToPropertyInspector" && m.payload?.event === "setup").at(-1)?.payload;
const slot = (p: ParsedPacket, channel: number): number => p.slots[ADDR - 1 + channel - 1];
const pan16 = (p: ParsedPacket): number => (slot(p, 1) << 8) | slot(p, 2);
const waitPacket = async (pred: (p: ParsedPacket) => boolean, what: string): Promise<ParsedPacket> => {
  const n0 = packets.length;
  return deck.waitFor(() => packets.slice(Math.max(0, n0 - 1)).reverse().find(pred), 3000, what);
};
const strip = (ctx: string): any => deck.lastFeedback(ctx);
const waitStrip = (ctx: string, pred: (fb: any) => boolean, what: string): Promise<any> => deck.waitFor(() => (deck.lastFeedback(ctx) && pred(deck.lastFeedback(ctx)) ? deck.lastFeedback(ctx) : undefined), 3000, what);
/** v0.7.3: the Deck key draws its state into its image (no title): grey = off, amber = click a light, green = driving. */
const deckKeyState = (ctx: string): "off" | "click" | "driving" | "" => {
  const m = /^<svg[^>]*><rect[^>]*fill="(#[0-9A-F]{6})"/i.exec(deck.lastImageRaw(ctx));
  return m ? (({ "#2A2E33": "off", "#F5B82E": "click", "#3DD68C": "driving" }) as Record<string, "off" | "click" | "driving">)[m[1].toUpperCase()] ?? "" : "";
};
const waitDeck = (ctx: string, want: "off" | "on" | "click" | "driving"): Promise<unknown> =>
  deck.waitFor(() => { const s = deckKeyState(ctx); return (want === "on" ? s === "click" || s === "driving" : s === want) || undefined; }, 4000, `Deck key ${want}`);
const waitTitle = (ctx: string, t: string): Promise<unknown> => deck.waitFor(() => deck.sent(ctx, "setTitle").at(-1)?.payload.title === t || undefined, 4000, `title ${JSON.stringify(t)}`);

/** v0.7.2: the deck drives only what Capture selected in this ON connection. Waits for the persistent session, then "clicks" Ch 203 in Capture. */
const selectInCapture = async (): Promise<void> => {
  await deck.waitFor(() => citp.clients.size === 1 || undefined, 3000, "persistent session");
  citp.select([ID]);
  await waitStrip("sel", (f) => f.line2.value.startsWith("Ch 203"), "selected in Capture: Ch 203");
};
const noSelection = (what: string): Promise<any> => waitStrip("sel", (f) => f.line1.value === "Click a light" && f.line2.value === "in Capture", what);

/** v0.10.0: the plugin process's UDP sockets (/proc/net/udp*), or null where /proc is not available. The OSC client has one from the
 * start; the sACN transport adds one on the first fixture touch. */
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

/**
 * The plugin process's TCP connections to the stub's CITP port, read from /proc (null where /proc is not available).
 * Matches the process's socket inodes against /proc/net/tcp entries whose REMOTE port is the stub's port.
 */
function citpSocketsOfPlugin(): number | null {
  const pid = deck.proc?.pid;
  if (!pid || !fs.existsSync(`/proc/${pid}/fd`) || !fs.existsSync("/proc/net/tcp")) return null;
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
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10) continue;
      const remotePort = parseInt(c[2].split(":")[1], 16);
      if (remotePort === citp.port && inodes.has(c[9])) n++;
    }
  }
  return n;
}

test("v0.10.0 start-up: the persistent session opens and declares with no Deck press (PNam → LaserFeedList → EnterShow → SXSr + 16 SXUS → list → FixtureIdentify); held (/proc); no sACN and no sACN socket", async () => {
  deck.willAppear(A.deck, "deckkey", {});
  await waitDeck("deckkey", "off");
  await deck.waitFor(() => (citp.identifies.length === 1 && /CITP: declared sACN universes 1-16/.test(deck.logText())) || undefined, 8000, "declared and identified at start-up");
  assert.deepEqual(codes().slice(0, 22), ["PINF:PNam", C(CAEX.LaserFeedList), C(CAEX.EnterShow), "SDMX:SXSr", ...Array(16).fill("SDMX:SXUS"), C(CAEX.FixtureListRequest), C(CAEX.FixtureIdentify)]);
  assert.deepEqual(citp.identifies, [[[INST, ID]]]);
  assert.doesNotMatch(deck.logText(), /brief sync/, "no brief connection any more");
  assert.doesNotMatch(deck.logText(), /deck control ON/, "Deck Control stays OFF");
  await sleep(1800); // longer than the session's list period (1.5 s): the session is held, lists keep being asked for
  assert.equal(citp.clients.size, 1, "held");
  assert.equal(citp.of(CAEX.LeaveShow).length, 0);
  assert.ok(citp.of(CAEX.FixtureListRequest).length >= 2, "periodic list requests on the held session");
  const socks = citpSocketsOfPlugin();
  if (process.platform === "linux") assert.notEqual(socks, null, "/proc is readable here");
  if (socks !== null) assert.equal(socks, 1, "one TCP socket to the CITP port in the plugin process (/proc)");
  assert.equal(packets.length, 0, "no sACN");
  udpBaseline = udpSocketsOfPlugin();
  assert.ok(deck.lastImageRaw("deckkey").length > 0);
});

test("v0.10.0: Setup panel / Setup key / Status key are list requests on the held session (exactly one connection, no Deck ON); the panel shows the Deck Control state and saves the idle time", async () => {
  const enters = citp.of(CAEX.EnterShow).length;
  const pnams = citp.received.filter((m) => m.toString("latin1", 16, 24) === "PINFPNam").length;
  const lists0 = citp.of(CAEX.FixtureListRequest).length;
  deck.willAppear(A.setup, "setup", {});
  deck.inspectorAppeared(A.setup, "setup");
  await deck.waitFor(() => /Fixtures: setup inspector opened/.test(deck.logText()) || undefined, 3000, "panel opened");
  deck.sendToPlugin(A.setup, "setup", { cmd: "get" });
  await deck.waitFor(() => (lastSetupView()?.view?.fixtures?.length === 1 ? true : undefined), 6000, "the panel lists the show (read at start-up)");
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST, universe: 1, address: ADDR });
  const v = (await deck.waitFor(() => (lastSetupView()?.view?.controllable === 1 ? lastSetupView() : undefined), 3000, "address saved")).view;
  assert.deepEqual(v.deck, { on: false, idleSeconds: 120 });
  assert.equal(v.patch, null, "this stub sends Patched=0: typed addresses (fallback)");
  assert.equal(v.connected, true);
  deck.keyDown(A.setup, "setup");
  deck.willAppear(A.status, "st", {});
  deck.keyDown(A.status, "st");
  await deck.waitFor(() => (citp.of(CAEX.FixtureListRequest).length >= lists0 + 3 ? true : undefined), 3000, "panel, Setup key and Status key each asked the held session");
  assert.doesNotMatch(deck.logText(), /deck control ON/, "none of these switches Deck Control ON");
  assert.equal(citp.clients.size, 1);
  assert.equal(citp.of(CAEX.EnterShow).length, enters, "no new EnterShow");
  assert.equal(citp.received.filter((m) => m.toString("latin1", 16, 24) === "PINFPNam").length, pnams, "no new connection");
  assert.equal(citp.identifies.length, 1, "identified once");
  assert.equal(packets.length, 0);
  if (udpBaseline !== null) assert.equal(udpSocketsOfPlugin(), udpBaseline, "still no sACN socket (/proc)");
  // idle time: validated and saved
  deck.sendToPlugin(A.setup, "setup", { cmd: "idle", seconds: 99999 });
  await deck.waitFor(() => /0 to 3600/.test(lastSetupView()?.error ?? "") || undefined, 3000, "range error");
  deck.sendToPlugin(A.setup, "setup", { cmd: "idle", seconds: 1 });
  await deck.waitFor(() => (lastSetupView()?.view?.deck?.idleSeconds === 1 && !lastSetupView().error) || undefined, 3000, "idle 1 s saved");
  assert.deepEqual((deck.globals as any).fixtureDeck, { idleSeconds: 1 });
});

test("ON by a knob turn: Deck Control switches ON but moves NOTHING until Capture selects a light; then the knob drives it; v0.9.0: idle 1 s → OFF only disarms: no termination, no LeaveShow, no close (/proc), identical frames continue, selection kept", async () => {
  deck.willAppear(A.select, "sel", {}, "Encoder");
  for (const k of ["a1", "a2", "a3"] as const) deck.willAppear(A[k], k, {}, "Encoder");
  await noSelection("no selection yet: Click a light / in Capture");
  const leaves = citp.of(CAEX.LeaveShow).length;
  const n0 = packets.length;
  deck.dialRotate(A.a1, "a1", 10);
  await waitDeck("deckkey", "on");
  assert.match(deck.logText(), /Fixtures: deck control ON \(Attribute 1 dial\)/);
  await selectInCapture();
  assert.equal(packets.length, n0, "the turn before any selection sent no sACN at all");
  await waitStrip("a1", (f) => f.name.value === "Pan", "Main page: Pan");
  deck.dialRotate(A.a1, "a1", 10);
  const p = await waitPacket((x) => !x.terminated && pan16(x) === Math.round(0.6 * 65535), "pan 60 %");
  assert.equal(slot(p, 6), 255, "intensity starts at home (never touched in this show)");
  if (udpBaseline !== null) assert.equal(udpSocketsOfPlugin(), udpBaseline + 1, "the first touch opened the sACN socket (/proc; so the baseline before it means something)");
  // no further activity: after 1 s it disarms by itself, and nothing else happens
  await deck.waitFor(() => /Fixtures: deck control OFF \(idle 1 s\): knobs disarmed; output and the CITP connection keep running/.test(deck.logText()) || undefined, 5000, "idle OFF logged");
  await waitDeck("deckkey", "off");
  const nOff = packets.length;
  await sleep(600);
  assert.equal(packets.filter((x) => x.terminated).length, 0, "no Stream_Terminated");
  assert.equal(citp.of(CAEX.LeaveShow).length, leaves, "no LeaveShow");
  assert.equal(citp.clients.size, 1, "the stub still has the connection");
  const socks = citpSocketsOfPlugin();
  if (socks !== null) assert.equal(socks, 1, "the plugin process still holds its CITP socket (/proc)");
  const after = packets.slice(nOff);
  assert.ok(after.length >= 15, `frames keep going while disarmed (${after.length} in 600 ms)`);
  for (const x of after) assert.deepEqual([...x.slots], [...p.slots], "identical slot values while disarmed");
  assert.doesNotMatch(deck.logText(), /deck control OFF: selection cleared/);
  await waitStrip("sel", (f) => f.line2.value.startsWith("Ch 203"), "the selection is kept while disarmed");
});

test("v0.9.0: while disarmed a turn re-arms and moves the still-selected light at once (no new connection, no second EnterShow); push = fine, tap = home that channel; OFF/ON by the key; Home Light arms; values saved", async () => {
  deck.sendToPlugin(A.setup, "setup", { cmd: "idle", seconds: 0 }); // never, for the rest of the file
  await deck.waitFor(() => lastSetupView()?.view?.deck?.idleSeconds === 0 || undefined, 3000, "idle off");
  const enters = citp.of(CAEX.EnterShow).length;
  const pnams = citp.received.filter((m) => m.toString("latin1", 16, 24) === "PINFPNam").length;
  deck.dialRotate(A.a1, "a1", 5); // arms and moves: the selection is still Ch 203
  await waitDeck("deckkey", "on");
  await waitPacket((x) => !x.terminated && pan16(x) === Math.round(0.65 * 65535), "65 %: continued from 60 %, not from 50 %");
  assert.equal(citp.of(CAEX.EnterShow).length, enters, "no second EnterShow on re-arm");
  assert.equal(citp.received.filter((m) => m.toString("latin1", 16, 24) === "PINFPNam").length, pnams, "no new connection");
  // push = fine mode
  deck.dialDown(A.a1, "a1");
  await waitStrip("a1", (f) => f.mark.value.includes("FINE"), "fine on");
  deck.dialRotate(A.a1, "a1", 1);
  await waitPacket((x) => pan16(x) === Math.round(0.651 * 65535), "fine step 0.1 %");
  deck.dialDown(A.a1, "a1");
  await waitStrip("a1", (f) => !f.mark.value.includes("FINE"), "fine off");
  // tap = home that channel
  deck.dialRotate(A.a3, "a3", -40); // dimmer 60 %
  await waitPacket((x) => slot(x, 6) === Math.round(0.6 * 255), "dimmer 60 %");
  deck.touchTap(A.a1, "a1", false);
  await waitPacket((x) => pan16(x) === 0x8000 && slot(x, 6) === Math.round(0.6 * 255), "pan home, dimmer kept");
  deck.dialRotate(A.a1, "a1", 20); // pan 70 %
  await waitPacket((x) => pan16(x) === Math.round(0.7 * 65535), "pan 70 %");
  // the key: OFF (disarm only)
  deck.keyDown(A.deck, "deckkey");
  await waitDeck("deckkey", "off");
  assert.match(deck.logText(), /deck control OFF \(Deck Control key\): knobs disarmed/);
  assert.equal(citp.clients.size, 1, "still connected");
  // Home Light arms and homes the still-selected light
  deck.willAppear(A.home, "home", {});
  deck.keyDown(A.home, "home");
  await waitDeck("deckkey", "on");
  assert.match(deck.logText(), /deck control ON \(Home Light key\)/);
  await waitPacket((x) => !x.terminated && pan16(x) === 0x8000 && slot(x, 6) === 255, "Home Light: the selected light at home");
  deck.dialRotate(A.a1, "a1", 25); // 75 %
  await waitPacket((x) => pan16(x) === Math.round(0.75 * 65535), "pan 75 %");
  deck.keyDown(A.deck, "deckkey"); // OFF: the values are saved
  await waitDeck("deckkey", "off");
  await deck.waitFor(() => (deck.globals as any).fixtureValues?.["DECK SHOW"]?.[INST]?.ch0 === 0.75 || undefined, 3000, "values saved in the global settings");
  assert.equal(citp.of(CAEX.EnterShow).length, enters, "one EnterShow for the whole connection");
  assert.equal(packets.filter((x) => x.terminated).length, 0, "never terminated");
});

test("resume after a plugin restart: a new plugin process starts OFF and the first turn continues from the stored 75 %", async () => {
  const globals = JSON.parse(JSON.stringify(deck.globals));
  // Handoff 22 migration check: pretend these values were written by v0.7 (no migration mark) with the old bad shutter value
  delete globals.fixtureValuesMigration;
  globals.fixtureValues["DECK SHOW"][INST].ch6 = 0.3; // channel 7 "Shutter"
  // v0.9.0: plugin exit is the one deck-side end: termination ×3 on the started universe, then LeaveShow
  const leaves = citp.of(CAEX.LeaveShow).length;
  const t0 = packets.length;
  await deck.stop(); // SIGTERM
  await deck.waitFor(() => (packets.slice(t0).filter((x) => x.terminated).length === 3 && citp.of(CAEX.LeaveShow).length === leaves + 1) || undefined, 3000, "exit: termination ×3 + LeaveShow");
  assert.deepEqual([...new Set(packets.slice(t0).filter((x) => x.terminated).map((x) => x.universe))], [1]);
  await sleep(500);
  deck = new FakeDeck();
  deck.globals = globals;
  packets.length = 0;
  await deck.start({ oscPort: capture.port, pluginDir, fixtures: path.join(here, "fixtures"), env: env() });
  await deck.waitFor(() => (/CITP: declared sACN universes 1-16/.test(deck.logText()) && /show "DECK SHOW": 1 fixture/.test(deck.logText())) || undefined, 8000, "session and list after restart");
  deck.willAppear(A.select, "sel", {}, "Encoder");
  deck.willAppear(A.a1, "a1", {}, "Encoder");
  await noSelection("a new process: nothing selected");
  deck.dialRotate(A.a1, "a1", -5); // switches ON, moves nothing
  await deck.waitFor(() => /deck control ON \(Attribute 1 dial\)/.test(deck.logText()) || undefined, 3000, "ON");
  await selectInCapture();
  assert.equal(packets.length, 0, "the turn before the selection sent nothing");
  await waitStrip("a1", (f) => f.value.value === "~75.0", "the strip shows the stored value before any touch");
  deck.dialRotate(A.a1, "a1", -5);
  const p = await waitPacket((x) => !x.terminated && pan16(x) === Math.round(0.7 * 65535), "70 %: resumed from 75 %");
  assert.equal(slot(p, 6), 255, "dimmer: last value sent before the restart was 100 % (Home Selected)");
  assert.equal(slot(p, 7), 255, "the stored v0.7 Shutter value (30 %) was deleted by the migration: home 100 % (open)");
  assert.match(deck.logText(), /values migration \(v0\.7\.1\): 1 stored fixture\(s\) will lose their stored shutter\/strobe values/);
  assert.match(deck.logText(), /values migration \(v0\.7\.1\): removed the stored shutter\/strobe value\(s\) of channel\(s\) 7 for fixture/);
  deck.willAppear(A.deck, "deckkey2", {});
  await waitDeck("deckkey2", "on");
});
