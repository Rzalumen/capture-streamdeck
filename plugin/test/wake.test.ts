// Handoff 30 (v0.11.0) unit tests: Wake (engine + service) and the automatic wake when Capture opens a show, against a stub Capture
// over real TCP sockets (the stub reports its patch only after the SDMX declaration, like the real Capture).
import assert from "node:assert/strict";
import test from "node:test";
import { drivenSignature, mapChannels } from "../src/fixtures/attrs.ts";
import { CitpSession } from "../src/fixtures/citpSession.ts";
import { DeckControl, DECK_KEY, MIGRATION_KEY, VALUES_KEY, ValueMemory } from "../src/fixtures/deck.ts";
import { DmxEngine, type Target, type Transport } from "../src/fixtures/engine.ts";
import { CitpLink } from "../src/fixtures/link.ts";
import { loadChannels } from "../src/fixtures/modes.ts";
import { buildModel } from "../src/fixtures/pages.ts";
import { parseDataPacket } from "../src/fixtures/sacn.ts";
import { AUTO_WAKE_HINT, FixtureService } from "../src/fixtures/service.ts";
import { runSetupCommand } from "../src/fixtures/setupCommands.ts";
import { SetupStore } from "../src/fixtures/setup.ts";
import { ShowModel } from "../src/fixtures/show.ts";
import { GlobalSettings } from "../src/lib/globals.ts";
import { buildModeBlock, buildObject, movingHead, startPatchStub, type SynthChannel } from "./fixtures/synth.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const memGlobals = (initial: Record<string, unknown> = {}) => {
  const state = { obj: JSON.parse(JSON.stringify(initial)) as Record<string, unknown>, sets: 0 };
  const g = new GlobalSettings({ get: async () => JSON.parse(JSON.stringify(state.obj)), set: async (o) => void (state.sets++, (state.obj = JSON.parse(JSON.stringify(o)))) });
  return { g, state };
};
const waitFor = async <T>(f: () => T | undefined | false, ms = 3000, what = "condition"): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
};
const MD = "bbbbbbbb-0000-0000-0000-0000000000b0";
const FXG = "aaaaaaaa-0000-0000-0000-0000000000b0";
const channelsOf = (list: SynthChannel[]) => {
  const l = loadChannels(buildObject(buildModeBlock({ guid: MD, channels: list })), MD, list.length, drivenSignature);
  assert.ok(l.ok, l.error);
  return l.channels;
};
const ch = channelsOf(movingHead());
const MODEL = buildModel(ch);
const MAP = mapChannels(ch);
const target = (key: string, universe: number, address: number): Target => ({ key, universe, address, map: MAP, model: MODEL });
const P = (name: string) => MODEL.byName.get(name.toLowerCase())!;
const b16 = (v: number): [number, number] => [Math.round(v * 65535) >> 8, Math.round(v * 65535) & 0xff];
const b8 = (v: number): number => Math.round(v * 255);

/** Records every frame per universe. */
function recorder() {
  const frames: { u: number; slots: number[] }[] = [];
  let opened = 0;
  const transport = (): Transport => {
    opened++;
    return { send: (p, u) => void frames.push({ u, slots: [...parseDataPacket(p).slots] }), close: async () => undefined };
  };
  return { frames, transport, opened: () => opened, last: (u: number) => frames.filter((f) => f.u === u).at(-1)?.slots };
}

// ------------------------------------------------------------------ the setting

test("deck (v0.11.0): 'Wake automatically when Capture opens the show' is on by default, saved beside the idle time, loaded after a restart; the idle save keeps it", async () => {
  const { g, state } = memGlobals({ other: 1 });
  const logs: string[] = [];
  const d = new DeckControl({ start: async () => undefined, log: (l) => logs.push(l), globals: g, setTimer: () => "T", clearTimer: () => undefined });
  await d.load();
  assert.equal(d.autoWake, true, "on by default");
  assert.equal(await d.setAutoWake(false), null);
  assert.deepEqual(state.obj, { other: 1, [DECK_KEY]: { idleSeconds: 120, autoWake: false } });
  assert.equal(logs.at(-1), "wake automatically when Capture opens the show: off");
  assert.equal(await d.setIdleSeconds(30), null);
  assert.deepEqual(state.obj[DECK_KEY], { idleSeconds: 30, autoWake: false }, "the idle save keeps the wake setting");
  const d2 = new DeckControl({ start: async () => undefined, log: () => undefined, globals: g });
  await d2.load();
  assert.deepEqual([d2.autoWake, d2.idleSeconds], [false, 30], "loaded after a restart");
  const d3 = new DeckControl({ start: async () => undefined, log: () => undefined, globals: memGlobals({ [DECK_KEY]: { idleSeconds: 60 } }).g });
  await d3.load();
  assert.equal(d3.autoWake, true, "settings saved before v0.11.0 (no autoWake): on");
  assert.match(AUTO_WAKE_HINT, /^Changes made in Capture while the Stream Deck app wasn't running are overwritten by the deck's memory when the show opens\.$/);
});

// ------------------------------------------------------------------ engine

test("engine.wake (v0.11.0): stored values in as resumed values (NOT deck-owned), recorded as Capture's levels, output starts for exactly the woken universes even while the knobs are disarmed; nothing stored = nothing started; twice = the same frames", () => {
  const stored: Record<string, Map<string, number>> = {
    a: new Map([["ch0", 0.25], ["ch2", 0.75], ["ch5", 0.5]]),
    b: new Map([["ch0", 0.9], ["ch7", 0.2]]),
    c: new Map([["ch5", 0.33], ["ch12", 0.6]]),
  };
  const rec = recorder();
  let remembered = 0;
  let tick: (() => void) | undefined;
  const engine = new DmxEngine({ transport: rec.transport, setInterval: (fn) => ((tick = fn), "H"), clearInterval: () => undefined, allowed: () => false, resume: (k) => stored[k], remember: () => void remembered++ });
  const A = target("a", 1, 1);
  const B = target("b", 1, 100);
  const C = target("c", 2, 1);
  const D = target("d", 1, 200); // addressed, nothing stored
  assert.equal(engine.hasStored("a"), true);
  assert.equal(engine.hasStored("d"), false);
  assert.deepEqual(engine.wake([D]), [], "nothing stored: nothing woken");
  assert.equal(engine.active, false, "and nothing started");
  assert.equal(rec.opened(), 0, "no transport (no sACN socket)");
  const woken = engine.wake([A, B, C, D]);
  assert.deepEqual(woken, ["a", "b", "c"]);
  assert.equal(engine.active, true, "started although the knobs are disarmed (allowed() = false)");
  assert.equal(rec.opened(), 1, "one transport");
  assert.deepEqual(engine.universes, [1, 2], "exactly the woken fixtures' universes");
  assert.equal(engine.isTouched("d"), false, "the unstored fixture is not woken");
  assert.equal(remembered, 0, "Wake remembers nothing new");
  for (const [k, ids] of [["a", ["ch0", "ch2", "ch5"]], ["b", ["ch0", "ch7"]], ["c", ["ch5", "ch12"]]] as const)
    for (const id of ids) assert.equal(engine.isDeckSet(k, id), false, `${k}/${id}: resumed, not knob-owned`);
  const u1 = rec.last(1)!;
  const u2 = rec.last(2)!;
  assert.deepEqual([u1[0], u1[1]], b16(0.25), "A pan");
  assert.deepEqual([u1[2], u1[3]], b16(0.75), "A tilt");
  assert.equal(u1[5], b8(0.5), "A dimmer");
  assert.deepEqual([u1[99], u1[100]], b16(0.9), "B pan");
  assert.equal(u1[99 + 7], b8(0.2), "B red");
  assert.equal(u2[5], b8(0.33), "C dimmer (universe 2)");
  assert.deepEqual([u2[12], u2[13]], b16(0.6), "C zoom");
  assert.equal(u1[6], 255, "a channel never stored: its home value");
  assert.deepEqual(u1.slice(199, 213), Array(14).fill(0), "the unstored fixture's slots: 0 (the known limit)");
  for (const [off, v] of [[0, b16(0.25)[0]], [1, b16(0.25)[1]], [5, b8(0.5)]] as const) assert.equal(engine.knownLevel(1, off), v, "recorded as what Capture is told");
  assert.equal(engine.knownLevel(1, 6), undefined, "only the stored values are recorded");
  // a second Wake: the same frames (next 40 fps tick), no second transport
  const n = rec.frames.length;
  engine.wake([A, B, C, D]);
  tick!();
  assert.equal(rec.frames.length, n + 2, "the next frame on both universes");
  assert.deepEqual(rec.last(1), u1);
  assert.deepEqual(rec.last(2), u2);
  assert.equal(rec.opened(), 1);
});

test("engine.wake (v0.11.0): on a fixture the knob owns, Wake puts the stored values back and gives up ownership; Capture's earlier level is overwritten", () => {
  const stored = new Map([["ch0", 0.4]]);
  const rec = recorder();
  const engine = new DmxEngine({ transport: rec.transport, setInterval: () => "H", clearInterval: () => undefined, resume: () => stored });
  const A = target("a", 1, 1);
  engine.adjust([{ target: A, params: [P("Pan")] }], () => 0.8);
  assert.equal(engine.isDeckSet("a", "ch0"), true);
  assert.deepEqual([...engine.slots(1).slice(0, 2)], b16(0.8));
  engine.wake([A]);
  assert.equal(engine.isDeckSet("a", "ch0"), false);
  assert.deepEqual([...engine.slots(1).slice(0, 2)], b16(0.4), "the stored value is sent again");
  assert.deepEqual([engine.knownLevel(1, 0), engine.knownLevel(1, 1)], b16(0.4), "and is what Capture is told");
});

// ------------------------------------------------------------------ service + link against a stub Capture

const INST = (n: number) => `00000000-0000-0000-0000-0000000000${n}`;
const SHOW = "WAKE SHOW";
/** Ch 201 + 202 on u1, Ch 203 on u2 (stored), Ch 204 on u1 (addressed, nothing stored). */
async function makeRig(opts: { autoWake?: boolean; stored?: boolean } = {}) {
  const stub = await startPatchStub(
    [
      { mfr: "T", name: "Wash", mode: "Std", channels: 14, channel: 201, fixtureGuid: FXG, modeGuid: MD, instanceId: INST(61), identifier: 601, patch: { universe: 1, address: 1 } },
      { mfr: "T", name: "Wash", mode: "Std", channels: 14, channel: 202, fixtureGuid: FXG, modeGuid: MD, instanceId: INST(62), identifier: 602, patch: { universe: 1, address: 100 } },
      { mfr: "T", name: "Wash", mode: "Std", channels: 14, channel: 203, fixtureGuid: FXG, modeGuid: MD, instanceId: INST(63), identifier: 603, patch: { universe: 2, address: 1 } },
      { mfr: "T", name: "Wash", mode: "Std", channels: 14, channel: 204, fixtureGuid: FXG, modeGuid: MD, instanceId: INST(64), identifier: 604, patch: { universe: 1, address: 200 } },
    ],
    { showName: SHOW },
  );
  const values = opts.stored === false ? {} : { [SHOW]: { [INST(61)]: { ch0: 0.25, ch5: 0.5 }, [INST(62)]: { ch0: 0.9 }, [INST(63)]: { ch5: 0.33 } } };
  const { g, state } = memGlobals({ [VALUES_KEY]: values, [MIGRATION_KEY]: { version: 1, pending: {} }, [DECK_KEY]: { idleSeconds: 0, autoWake: opts.autoWake ?? true } });
  const logs: string[] = [];
  const objects: Record<string, Buffer> = { [FXG]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) };
  const session = new CitpSession({ host: "127.0.0.1", port: stub.port, timing: { backoffMin: 50, backoffMax: 200, rerequestMs: 400, firstRetryMs: 300, discoverMs: 50 }, log: (l) => logs.push(`CITP: ${l}`) });
  let link!: CitpLink;
  const show = new ShowModel({ libraryPath: "/x", open: () => ({ libPath: "x", readObjectByGuid: (gd: string) => objects[gd], close: () => undefined }) as never, request: () => link.requestList("t"), reconnect: () => link.reconnect("t"), log: (l) => logs.push(l) });
  const memory = new ValueMemory(g, 10_000);
  const rec = recorder();
  let deck!: DeckControl;
  const engine = new DmxEngine({ transport: rec.transport, setInterval: () => "H", clearInterval: () => undefined, allowed: () => deck.on, resume: (k) => memory.get(show.showName, k), remember: (k, v) => memory.set(show.showName, k, v) });
  const setup = new SetupStore(g);
  const svc = new FixtureService(show, setup, engine, (l) => logs.push(l));
  deck = new DeckControl({ start: async () => undefined, log: (l) => logs.push(l), globals: g, setTimer: () => "T", clearTimer: () => undefined });
  await Promise.all([setup.load(), memory.load(), deck.load()]);
  svc.deck = deck;
  link = new CitpLink(session, show, svc, (l) => logs.push(l), undefined, 100);
  link.attach();
  const wakes = (auto: boolean) => logs.filter((l) => (auto ? /^Wake \(automatic\): \d+ fixture\(s\) restored/ : /^Wake: \d+ fixture\(s\) restored/).test(l)).length;
  return { stub, session, show, svc, link, logs, rec, engine, deck, state, wakes, close: async () => (await link.stop(), await stub.close()) };
}

test("service.wake (v0.11.0): Woke 3 on universes 1, 2 (Capture's patch), the unstored fixture named and not woken; the knobs stay disarmed and the selection unchanged; twice = the same frames; not connected = waiting; nothing stored = nothing", async () => {
  const R = await makeRig({ autoWake: false });
  try {
    await R.link.startPersistent();
    await waitFor(() => (R.svc.patchActive() && R.svc.controllables().length === 4) || undefined, 3000, "Capture's patch taken");
    await sleep(100);
    assert.equal(R.rec.opened(), 0, "setting off: no automatic wake, nothing sent");
    assert.equal(R.wakes(true), 0);
    R.stub.select([604]);
    await waitFor(() => R.svc.selection.keys.length === 1 || undefined, 2000, "Ch 204 selected in Capture");
    const sel = [...R.svc.selection.keys];
    const r = R.svc.wake();
    assert.deepEqual(r, { outcome: "woken", n: 3, universes: [1, 2] });
    assert.equal(R.logs.filter((l) => l.startsWith("Wake")).join("\n"), "Wake: 3 fixture(s) restored on universe(s) 1, 2\nWake: no stored values for Ch 204 Wash (not woken)");
    assert.equal(R.deck.on, false, "Wake does not arm the knobs");
    assert.ok(!R.logs.some((l) => /deck control ON/.test(l)));
    assert.deepEqual(R.svc.selection.keys, sel, "the selection is unchanged");
    assert.deepEqual(R.engine.universes, [1, 2]);
    assert.equal(R.engine.isTouched(INST(64)), false);
    const u1 = R.rec.last(1)!;
    const u2 = R.rec.last(2)!;
    assert.deepEqual([u1[0], u1[1], u1[5]], [...b16(0.25), b8(0.5)]);
    assert.deepEqual([u1[99], u1[100]], b16(0.9));
    assert.equal(u2[5], b8(0.33));
    assert.deepEqual(R.svc.wake(), { outcome: "woken", n: 3, universes: [1, 2] }, "a repeat press");
    assert.deepEqual(R.rec.last(1), u1, "the same frames");
    assert.deepEqual(R.rec.last(2), u2);
    assert.equal(R.rec.opened(), 1);
    // a ChBk on a woken channel: Capture takes it (the deck did not own it: no "Capture took" line)
    R.stub.chbk(1, 6, [40]); // Ch 201's dimmer
    await waitFor(() => R.engine.knownLevel(1, 5) === 40 || undefined, 2000, "ChBk applied");
    assert.equal(R.engine.slots(1)[5], 40, "Capture's level is sent");
    assert.equal(R.engine.paramValue(target(INST(61), 1, 1), P("Dimmer")), 40 / 255);
    assert.ok(!R.logs.some((l) => /Capture took/.test(l)), "no 'Capture took': the woken value was not knob-owned");
  } finally {
    await R.close();
  }
  const N = await makeRig({ autoWake: false, stored: false });
  try {
    assert.deepEqual(N.svc.wake(), { outcome: "waiting", n: 0, universes: [] }, "not connected yet");
    assert.match(N.logs.at(-1)!, /^Wake: waiting for Capture/);
    await N.link.startPersistent();
    await waitFor(() => N.svc.controllables().length === 4 || undefined, 3000, "patch");
    assert.deepEqual(N.svc.wake(), { outcome: "nothing", n: 0, universes: [] });
    assert.equal(N.logs.at(-1), `Wake: nothing stored for show "${SHOW}" (4 addressed fixture(s)): nothing sent`);
    assert.equal(N.rec.opened(), 0, "nothing sent");
  } finally {
    await N.close();
  }
});

test("automatic wake (v0.11.0): plugin start = one; a drop + reconnect while output runs = none; LeaveShow + EnterShow + declared list = exactly one; a different show with nothing stored = none (logged once); setting off = none", async () => {
  const R = await makeRig();
  try {
    await R.link.startPersistent();
    await waitFor(() => R.wakes(true) === 1 || undefined, 3000, "automatic wake at start");
    assert.equal(R.logs.find((l) => l.startsWith("Wake (automatic)")), "Wake (automatic): 3 fixture(s) restored on universe(s) 1, 2");
    assert.ok(R.logs.indexOf("Capture's patch: 4 of 4 fixture(s) patched") < R.logs.indexOf("Wake (automatic): 3 fixture(s) restored on universe(s) 1, 2"), "after the declared patch list");
    assert.equal(R.deck.on, false, "not armed");
    await sleep(900); // several more (declared) lists: still one
    assert.equal(R.wakes(true), 1);
    // the connection drops and comes back while output runs: no wake
    R.stub.drop();
    await waitFor(() => R.logs.some((l) => /CITP connection closed: selection cleared/.test(l)) || undefined, 2000, "dropped");
    await waitFor(() => (R.show.connected && R.stub.declaredConns.size === 1) || undefined, 3000, "reconnected and declared");
    await sleep(600);
    assert.equal(R.engine.active, true, "output kept running");
    assert.equal(R.wakes(true), 1, "no wake on a reconnect while output runs");
    // Capture closes and reopens the show: exactly one wake
    R.stub.leaveShow();
    await waitFor(() => R.engine.active === false || undefined, 2000, "released on LeaveShow");
    R.stub.enterShow(SHOW);
    await waitFor(() => R.wakes(true) === 2 || undefined, 3000, "automatic wake after the reopen");
    await sleep(900);
    assert.equal(R.wakes(true), 2, "exactly one");
    assert.equal(R.engine.active, true);
    // a different show with nothing stored: released, no wake, "nothing stored" logged once
    R.stub.enterShow("OTHER SHOW");
    await waitFor(() => R.logs.some((l) => l === 'Wake (automatic): nothing stored for show "OTHER SHOW" (4 addressed fixture(s)): nothing sent') || undefined, 3000, "nothing stored");
    assert.equal(R.engine.active, false);
    R.stub.leaveShow();
    R.stub.enterShow("OTHER SHOW");
    await sleep(900);
    assert.equal(R.logs.filter((l) => /Wake \(automatic\): nothing stored/.test(l)).length, 1, "logged once");
    assert.equal(R.engine.active, false);
    // the setting off (Setup panel command): LeaveShow + EnterShow of the stored show = no wake
    assert.equal(await runSetupCommand(R.svc, { cmd: "autowake", on: false }), null);
    assert.equal((R.state.obj[DECK_KEY] as { autoWake: boolean }).autoWake, false, "saved");
    R.stub.enterShow(SHOW);
    await sleep(900);
    assert.equal(R.wakes(true), 2, "setting off: none");
    assert.equal(R.engine.active, false, "nothing sent");
    assert.equal(R.svc.setupView().deck?.autoWake, false, "the panel shows it off");
  } finally {
    await R.close();
  }
});

test("automatic wake (v0.11.0): typed addresses (Capture's patch not available) are used once the declared list is in; a list before the declaration does not wake", async () => {
  const R = await makeRig();
  try {
    for (const f of R.stub.fixtures) f.patch = undefined; // Patched=0 everywhere: fallback to typed addresses
    await R.svc.setup.setMany(SHOW, { [INST(61)]: { universe: 3, address: 10 }, [INST(62)]: { universe: 3, address: 50 } });
    await R.link.startPersistent();
    await waitFor(() => R.wakes(true) === 1 || undefined, 3000, "automatic wake on the typed addresses");
    assert.equal(R.logs.find((l) => l.startsWith("Wake (automatic)")), "Wake (automatic): 2 fixture(s) restored on universe(s) 3");
    assert.equal(R.svc.afterList(0, false), undefined);
    assert.equal(R.wakes(true), 1);
  } finally {
    await R.close();
  }
});
