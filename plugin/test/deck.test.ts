// Handoff 21 unit tests: Deck Control (ON/OFF, idle switch-off, order of the OFF steps), remembered values (resume), the engine's
// gate, and the CITP link's brief vs persistent connections against a stub Capture over real TCP sockets.
import assert from "node:assert/strict";
import test from "node:test";
import { drivenSignature, mapChannels } from "../src/fixtures/attrs.ts";
import { CAEX, decodeMessage, UNIDENTIFIED } from "../src/fixtures/citp.ts";
import { CitpSession } from "../src/fixtures/citpSession.ts";
import { DeckControl, DECK_KEY, VALUES_KEY, ValueMemory } from "../src/fixtures/deck.ts";
import { DmxEngine, type Target, type Transport } from "../src/fixtures/engine.ts";
import { CitpLink } from "../src/fixtures/link.ts";
import { loadChannels } from "../src/fixtures/modes.ts";
import { buildModel, isShutterStrobeName } from "../src/fixtures/pages.ts";
import { FixtureService } from "../src/fixtures/service.ts";
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
const MD = "bbbbbbbb-0000-0000-0000-0000000000a9";
const channelsOf = (list: SynthChannel[]) => {
  const l = loadChannels(buildObject(buildModeBlock({ guid: MD, channels: list })), MD, list.length, drivenSignature);
  assert.ok(l.ok, l.error);
  return l.channels;
};
const ch = channelsOf(movingHead());
const MODEL = buildModel(ch);
const MAP = mapChannels(ch);
const target = (key: string, address: number): Target => ({ key, universe: 1, address, map: MAP, model: MODEL });
const P = (name: string) => MODEL.byName.get(name.toLowerCase())!;

/** A deck with recorded steps and a manual idle timer. */
function makeDeck(globals?: GlobalSettings) {
  const steps: string[] = [];
  const logs: string[] = [];
  let fire: (() => void) | undefined;
  let armedMs = 0;
  const deck = new DeckControl({
    start: async () => void steps.push("start"),
    stop: async () => void steps.push("stop (LeaveShow + close)"),
    release: async () => void steps.push("release (termination frames)"),
    afterOff: async () => void steps.push("save values"),
    log: (l) => logs.push(l),
    globals,
    setTimer: (fn, ms) => {
      fire = fn;
      armedMs = ms;
      return "T";
    },
    clearTimer: () => {
      fire = undefined;
    },
  });
  return {
    deck,
    steps,
    logs,
    fireIdle: () => {
      const f = fire;
      fire = undefined; // a fired timer is gone
      f?.();
    },
    armed: () => (fire ? armedMs : 0),
  };
}

// ------------------------------------------------------------------ Deck Control

test("deck: OFF at start; a knob/key (activity) switches ON at once and starts the session; the idle timer switches OFF: termination → LeaveShow + close → save", async () => {
  const d = makeDeck();
  assert.equal(d.deck.on, false);
  assert.equal(d.armed(), 0, "no idle timer while OFF");
  d.deck.activity("Pan dial");
  assert.equal(d.deck.on, true, "ON synchronously, so the DMX that follows is allowed");
  await d.deck.settled();
  assert.deepEqual(d.steps, ["start"]);
  assert.equal(d.armed(), 120000, "default idle time 120 s");
  assert.match(d.logs.join("\n"), /deck control ON \(Pan dial\)/);
  d.deck.activity("Tilt dial"); // already ON: only re-arms
  await d.deck.settled();
  assert.deepEqual(d.steps, ["start"]);
  d.fireIdle();
  assert.equal(d.deck.on, false);
  await d.deck.settled();
  assert.deepEqual(d.steps, ["start", "release (termination frames)", "stop (LeaveShow + close)", "save values"]);
  assert.match(d.logs.at(-1)!, /^deck control OFF \(idle 120 s\): output terminated, LeaveShow sent, CITP connection closed/);
  assert.equal(d.armed(), 0);
});

test("deck: the key toggles; Release (setOn false) when OFF does nothing; idle 0 = never; the idle time is validated, saved and loaded", async () => {
  const { g, state } = memGlobals({ other: 1 });
  const d = makeDeck(g);
  await d.deck.toggle("Deck Control key");
  assert.equal(d.deck.on, true);
  await d.deck.toggle("Deck Control key");
  assert.equal(d.deck.on, false);
  await d.deck.setOn(false, "Release key");
  assert.deepEqual(d.steps, ["start", "release (termination frames)", "stop (LeaveShow + close)", "save values"], "OFF twice = one OFF");
  assert.match((await d.deck.setIdleSeconds(-1))!, /0 to 3600/);
  assert.match((await d.deck.setIdleSeconds(1.5))!, /whole number/);
  assert.equal(await d.deck.setIdleSeconds(0), null);
  assert.deepEqual(state.obj, { other: 1, [DECK_KEY]: { idleSeconds: 0 } }, "merged into the global settings");
  d.deck.activity("Home Selected key");
  assert.equal(d.deck.on, true);
  assert.equal(d.armed(), 0, "0 = never switches OFF by itself");
  assert.equal(await d.deck.setIdleSeconds(30), null);
  assert.equal(d.armed(), 30000, "a new idle time applies at once");
  const d2 = makeDeck(g);
  await d2.deck.load();
  assert.equal(d2.deck.idleSeconds, 30, "loaded after a restart");
});

test("deck: switching OFF stops the DMX synchronously, before the CITP stop; a knob right after OFF switches ON again after the stop", async () => {
  const order: string[] = [];
  let releaseSync = false;
  const deck = new DeckControl({
    start: async () => void order.push("start"),
    stop: async () => {
      await sleep(20);
      order.push("stop");
    },
    release: () => {
      releaseSync = true; // DmxEngine.release clears the engine before its first await
      order.push("release");
      return sleep(5);
    },
    log: () => undefined,
  });
  deck.activity("Pan dial");
  void deck.setOn(false, "Deck Control key");
  assert.equal(releaseSync, true, "release ran synchronously inside setOn(false)");
  deck.activity("Pan dial"); // turned again at once
  await deck.settled();
  // the DMX stops at once (even before the queued CITP start of the first ON ran); the CITP steps keep their order
  assert.deepEqual(order, ["release", "start", "stop", "start"]);
  assert.equal(deck.on, true);
});

// ------------------------------------------------------------------ remembered values

test("values: remembered per show and fixture, written to the global settings (debounced, flush), loaded after a restart; malformed entries ignored", async () => {
  const { g, state } = memGlobals({ keep: true, fixtureValuesMigration: { version: 1, pending: {} }, [VALUES_KEY]: { "Old Show": { k1: { ch0: 0.25, bad: 3, ch1: 7 } } } });
  const m = new ValueMemory(g, 10);
  await m.load();
  assert.deepEqual([...m.get("Old Show", "k1")!], [["ch0", 0.25]], "out-of-range and non-channel ids dropped");
  m.set("My Show", "k1", new Map([["ch0", 0.6], ["ch5", 0.123456789]]));
  m.set("My Show", "k1", new Map([["ch5", 0.5]]));
  assert.deepEqual([...m.get("My Show", "k1")!], [["ch0", 0.6], ["ch5", 0.5]], "merged");
  assert.equal(m.get("My Show", "k2"), undefined);
  assert.equal(m.get("Other Show", "k1"), undefined, "per show");
  assert.equal(state.sets, 0, "not written on every tick (and no migration write: already migrated)");
  await sleep(40);
  assert.equal(state.sets, 1, "written once, shortly after");
  assert.deepEqual((state.obj[VALUES_KEY] as any)["My Show"], { k1: { ch0: 0.6, ch5: 0.5 } });
  assert.equal(state.obj.keep, true, "other keys kept");
  m.set("My Show", "k2", new Map([["ch2", 1]]));
  await m.flush();
  assert.equal(state.sets, 2);
  const again = new ValueMemory(g);
  await again.load();
  assert.deepEqual([...again.get("My Show", "k2")!], [["ch2", 1]]);
});

test("values migration (v0.7.1, once): stored shutter/strobe values are deleted when the fixture's channel names are known; nothing else; logged; not repeated", async () => {
  const stored = { "Show A": { solaframe: { ch0: 0.7, ch38: 1, ch39: 0, ch40: 0.8, ch16: 0.3 }, rogue: { ch6: 1, ch0: 0.2 } }, "Show B": { solaframe: { ch38: 1 } } };
  const { g, state } = memGlobals({ [VALUES_KEY]: stored });
  const logs: string[] = [];
  const m = new ValueMemory(g, 10, (l) => logs.push(l));
  await m.load();
  assert.match(logs[0], /values migration \(v0\.7\.1\): 3 stored fixture\(s\) will lose their stored shutter\/strobe values/);
  assert.deepEqual((state.obj.fixtureValuesMigration as any).pending, { "Show A": ["solaframe", "rogue"], "Show B": ["solaframe"] }, "the marks are saved at once");
  assert.equal(m.get("Show A", "solaframe"), undefined, "until its channel names are known the fixture starts from home, never from the old 255");
  // names of the SolaFrame's channels: 39 "Shutter/LED Functions", 40 "Shutter/LED", 17 "Blade 1 Angle A", 41 "Dim Coarse"
  const names: Record<number, string> = { 0: "Pan", 38: "Shutter/LED Functions", 39: "Shutter/LED", 40: "Dim Coarse", 16: "Blade 1 Angle A", 6: "Shutter" };
  const isSS = (id: string) => isShutterStrobeName(names[Number(id.slice(2))] ?? "");
  assert.deepEqual([...m.get("Show A", "solaframe", isSS)!], [["ch0", 0.7], ["ch40", 0.8], ["ch16", 0.3]], "only Shutter/LED Functions and Shutter/LED removed; pan, dim and the blade kept");
  assert.match(logs.at(-1)!, /removed the stored shutter\/strobe value\(s\) of channel\(s\) 39, 40 for fixture solaframe in show "Show A"/);
  assert.deepEqual([...m.get("Show A", "rogue", isSS)!], [["ch0", 0.2]], "the Rogue's Shutter (7) removed");
  await m.flush();
  assert.deepEqual((state.obj.fixtureValuesMigration as any).pending, { "Show B": ["solaframe"] });
  assert.deepEqual((state.obj[VALUES_KEY] as any)["Show A"].solaframe, { ch0: 0.7, ch40: 0.8, ch16: 0.3 });
  // a restart: the migration does not start again; Show B is still pending until its fixture is read
  const again = new ValueMemory(g, 10, (l) => logs.push(l));
  const before = logs.length;
  await again.load();
  assert.equal(logs.length, before, "no second migration");
  assert.deepEqual([...again.get("Show A", "solaframe")!], [["ch0", 0.7], ["ch40", 0.8], ["ch16", 0.3]]);
  assert.equal(again.isPending("Show B", "solaframe"), true);
  assert.equal(again.isPending("Show A", "solaframe"), false);
  // a values change on an already migrated fixture keeps everything
  again.set("Show A", "solaframe", new Map([["ch39", 1]]));
  assert.equal(again.get("Show A", "solaframe")!.get("ch39"), 1, "a value sent by v0.7.1 is kept");
});

test("engine: nothing is touched or sent while not allowed (Deck Control OFF); resume starts from the stored values, home only for channels never touched", async () => {
  const mem = new ValueMemory(memGlobals().g, 10_000);
  let allowed = false;
  const sent: number[] = [];
  const tr: Transport = { send: (_p, u) => void sent.push(u), close: async () => undefined };
  const engine = new DmxEngine({ transport: () => tr, setInterval: () => "H", clearInterval: () => undefined, allowed: () => allowed, resume: (k) => mem.get("S", k), remember: (k, v) => mem.set("S", k, v) });
  const t = target("k1", 285);
  assert.equal(engine.adjust([{ target: t, params: [P("Pan")] }], () => 0.9), false);
  engine.home([t]);
  engine.setMany([t], { pan: 0.1 });
  assert.equal(engine.active, false);
  assert.equal(sent.length, 0, "no DMX while OFF");
  allowed = true;
  engine.adjust([{ target: t, params: [P("Pan")] }], () => 0.9);
  engine.adjust([{ target: t, params: [P("Dimmer")] }], () => 0.3);
  assert.equal(engine.active, true);
  assert.deepEqual([...mem.get("S", "k1")!].sort(), [["ch0", 0.9], ["ch5", 0.3]].sort(), "remembered as it was sent");
  await engine.release();
  // after OFF→ON: the value shown is the remembered one, and the first touch of ANOTHER channel keeps pan and dimmer where they were
  assert.equal(engine.paramValue(t, P("Pan")), 0.9, "shown before any touch");
  engine.adjust([{ target: t, params: [P("Tilt")] }], (c) => c + 0.1);
  const s = engine.slots(1);
  const b = 284;
  assert.equal((s[b + 0] << 8) | s[b + 1], Math.round(0.9 * 65535), "pan resumed, not snapped to 50 %");
  assert.equal(s[b + 5], Math.round(0.3 * 255), "dimmer resumed, not snapped to 100 %");
  assert.equal((s[b + 2] << 8) | s[b + 3], Math.round(0.6 * 65535), "tilt was never touched: home 50 % + 10 %");
  assert.equal(s[b + 7], 255, "red never touched: its home value");
  // Home Selected stores the home values
  engine.home([t]);
  assert.equal(mem.get("S", "k1")!.get("ch0"), 0.5);
  assert.equal(mem.get("S", "k1")!.get("ch5"), 1);
});

test("service: every fixture knob turn / tap-home / fixture key goes through Deck Control first (switches it ON); a Main page without a dimmer shows — named Intensity", async () => {
  const objects: Record<string, Buffer> = { "aaaaaaaa-0000-0000-0000-0000000000b1": buildObject(buildModeBlock({ guid: MD, channels: movingHead() })), "aaaaaaaa-0000-0000-0000-0000000000b2": buildObject(buildModeBlock({ guid: "bbbbbbbb-0000-0000-0000-0000000000b2", channels: [{ name: "Pan" }, { name: "Tilt" }, { name: "Red" }] })) };
  const show = new ShowModel({ libraryPath: "/x", open: () => ({ libPath: "x", readObjectByGuid: (g: string) => objects[g], close: () => undefined }) as never });
  const calls: string[] = [];
  const deck = { on: false, idleSeconds: 120, activity: (w: string) => void (calls.push(w), (deck.on = true)), setIdleSeconds: async () => null };
  const engine = new DmxEngine({ transport: () => ({ send: () => undefined, close: async () => undefined }), setInterval: () => "H", clearInterval: () => undefined, allowed: () => deck.on });
  const svc = new FixtureService(show, new SetupStore(memGlobals().g), engine);
  svc.deck = deck;
  const mk = (index: number, fx: string, mode: string, n: number) => ({
    index, identifier: 700 + index, manufacturer: "M", name: `F${index}`, mode: "Std", channelCount: n, isDimmer: 0,
    ids: [{ type: 2, name: "", size: 16, hex: "", guid: null, guidRaw: fx, value: null }, { type: 3, name: "", size: 16, hex: "", guid: null, guidRaw: mode, value: null }, { type: 4, name: "", size: 16, hex: "", guid: null, guidRaw: `00000000-0000-0000-0000-00000000070${index}`, value: null }],
    patched: 0, universe: 0, universeChannel: 0, unit: "", channel: 10 + index, circuit: "", note: "", position: [0, 0, 0] as [number, number, number], angles: [0, 0, 0] as [number, number, number],
  });
  show.setConnected(true);
  show.setShowName("S");
  show.applyList(0, [mk(0, "aaaaaaaa-0000-0000-0000-0000000000b1", MD, 14), mk(1, "aaaaaaaa-0000-0000-0000-0000000000b2", "bbbbbbbb-0000-0000-0000-0000000000b2", 3)]);
  await svc.setAddress(show.fixtures[0].key, { universe: 1, address: 1 });
  await svc.setAddress(show.fixtures[1].key, { universe: 1, address: 100 });
  svc.onSelectionEvent([700]);
  assert.equal(svc.attrRotate(0, 5, false), true, "the turn is applied (Deck Control switched ON first)");
  assert.equal(engine.active, true);
  deck.on = false;
  svc.attrHome(1);
  deck.on = false;
  svc.homeSelected();
  deck.on = false;
  svc.stepPage(1);
  deck.on = false;
  svc.rotate("pan", 1, false);
  svc.home("pan");
  svc.rotateSelect(1);
  assert.deepEqual(calls, ["Attribute 1 dial", "Attribute 2 dial", "Home Selected key", "Page key", "Pan dial", "Pan dial", "Select dial"]);
  svc.onSelectionEvent([701]);
  assert.equal(svc.pageName(), "Main");
  assert.deepEqual([0, 1, 2].map((i) => svc.attrReadout(i).label), ["Pan", "Tilt", "Intensity"]);
  assert.equal(svc.attrReadout(2).value, null, "— on dial 4");
  assert.equal(svc.attrReadout(2).param, null);
  assert.ok(show.types.get(show.fixtures[1].typeKey)!.notes.some((n) => /no dimmer\/intensity channel.*channels: 1 "Pan", 2 "Tilt", 3 "Red"/.test(n)), "the type's channel names are logged once");
});

// ------------------------------------------------------------------ the CITP link over real sockets

const FXG = "aaaaaaaa-0000-0000-0000-0000000000c9";
async function makeLink() {
  const stub = await startPatchStub(
    [
      { mfr: "T", name: "Wash", mode: "Std", channels: 14, channel: 203, fixtureGuid: FXG, modeGuid: MD, instanceId: "00000000-0000-0000-0000-0000000000d1", identifier: UNIDENTIFIED },
      { mfr: "T", name: "Wash", mode: "Std", channels: 14, channel: 204, fixtureGuid: FXG, modeGuid: MD, instanceId: "00000000-0000-0000-0000-0000000000d2", identifier: 4242 },
    ],
    { showName: "LINK SHOW" },
  );
  const logs: string[] = [];
  const objects: Record<string, Buffer> = { [FXG]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) };
  const session = new CitpSession({ host: "127.0.0.1", port: stub.port, timing: { backoffMin: 50, backoffMax: 200, rerequestMs: 400, firstRetryMs: 300, discoverMs: 50 }, log: (l) => logs.push(`CITP: ${l}`) });
  let link!: CitpLink;
  const show = new ShowModel({ libraryPath: "/x", open: () => ({ libPath: "x", readObjectByGuid: (g: string) => objects[g], close: () => undefined }) as never, request: () => link.requestList("t"), reconnect: () => link.reconnect("t"), log: (l) => logs.push(l) });
  const engine = new DmxEngine({ transport: () => ({ send: () => undefined, close: async () => undefined }), setInterval: () => "H", clearInterval: () => undefined });
  const svc = new FixtureService(show, new SetupStore(memGlobals().g), engine, (l) => logs.push(l));
  link = new CitpLink(session, show, svc, (l) => logs.push(l), undefined, 100, 2000);
  link.attach();
  const codes = () => stub.received.map((m) => {
    const d = decodeMessage(m);
    return d.layer === "CAEX" ? `CAEX:${d.code}` : `${d.layer}:${m.toString("latin1", 20, 24)}`;
  });
  return { stub, session, show, svc, link, logs, codes };
}
const C = (code: number) => `CAEX:${code}`;
const waitFor = async <T>(f: () => T | undefined | false, ms = 3000, what = "condition"): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
};

test("link: a brief connection = PNam → EnterShow → FixtureListRequest → FixtureIdentify (0xffffffff only) → LeaveShow → close; the list stays, nothing is held, no reconnect", async () => {
  const L = await makeLink();
  try {
    await L.link.briefSync("start-up");
    // (the empty LaserFeedList answers Capture's GetLaserFeedList, as in every session)
    assert.deepEqual(L.codes(), ["PINF:PNam", C(CAEX.LaserFeedList), C(CAEX.EnterShow), C(CAEX.FixtureListRequest), C(CAEX.FixtureIdentify), C(CAEX.LeaveShow)]);
    assert.deepEqual(L.stub.identifies, [[["00000000-0000-0000-0000-0000000000d1", 100001]]], "only the unidentified fixture; Capture's 4242 kept");
    await waitFor(() => L.stub.clients.size === 0 || undefined, 1000, "stub sees the connection closed");
    assert.equal(L.session.active, false, "the session loop has ended");
    assert.equal(L.link.mode, "off");
    assert.equal(L.show.fixtures.length, 2);
    assert.equal(L.show.status, "ok", "our own close is not an error");
    assert.equal(L.show.connected, false);
    assert.match(L.logs.join("\n"), /brief sync \(start-up\): \d+ ms, 2 fixture\(s\), connection closed/);
    const n = L.stub.received.length;
    await sleep(400);
    assert.equal(L.stub.received.length, n, "no reconnect, no periodic list request");
    assert.equal(L.stub.clients.size, 0);
    // a second brief connection sees the identifier now stored in "Capture": nothing to identify
    await L.link.briefSync("Setup panel");
    assert.equal(L.stub.identifies.length, 1, "no FixtureIdentify the second time");
    assert.equal(L.link.briefs.length, 2);
    // two requests at once share one brief connection
    await Promise.all([L.link.briefSync("a"), L.link.briefSync("b")]);
    assert.equal(L.stub.of(CAEX.EnterShow).length, 3);
  } finally {
    await L.link.stop();
    await L.stub.close();
  }
});

test("link: ON holds the persistent session (selection arrives, list re-requested); OFF sends LeaveShow and closes, no reconnect; while ON a 'read the show' is only a list request", async () => {
  const L = await makeLink();
  try {
    await L.link.briefSync("start-up");
    await L.link.startPersistent();
    await waitFor(() => L.stub.clients.size === 1 || undefined, 2000, "persistent connection");
    await waitFor(() => L.show.connected || undefined, 2000, "connected");
    await waitFor(() => L.stub.of(CAEX.FixtureListRequest).length >= 2 || undefined, 2000, "list on the persistent session");
    const enters = L.stub.of(CAEX.EnterShow).length;
    L.link.requestList("Setup key");
    await sleep(100);
    assert.equal(L.stub.of(CAEX.EnterShow).length, enters, "no new connection while ON");
    L.stub.select([4242]);
    await waitFor(() => L.logs.some((l) => /Capture selected Ch 204/.test(l)) || undefined, 2000, "selection followed");
    await L.link.stopPersistent();
    assert.equal(L.stub.of(CAEX.LeaveShow).length, 2, "LeaveShow from the brief connection and from OFF");
    await waitFor(() => L.stub.clients.size === 0 || undefined, 1000, "closed");
    assert.equal(L.show.status, "ok");
    assert.equal(L.show.fixtures.length, 2, "the list stays while OFF");
    const n = L.stub.received.length;
    await sleep(500);
    assert.equal(L.stub.received.length, n, "OFF: no reconnect");
    assert.equal(L.session.active, false);
  } finally {
    await L.link.stop();
    await L.stub.close();
  }
});

test("link (v0.7.2): the persistent connection closing clears the selection (dropped socket, OFF); a brief connection never does", async () => {
  const L = await makeLink();
  try {
    await L.link.briefSync("start-up");
    // OFF: a hand-picked fixture survives a brief connection's close
    await L.svc.setAddress(L.show.fixtures[0].key, { universe: 1, address: 1 });
    L.svc.selection.step(1);
    const picked = L.svc.selection.keys;
    assert.equal(picked.length, 1);
    await L.link.briefSync("Setup panel");
    assert.equal(L.link.briefs.length, 2);
    assert.deepEqual(L.svc.selection.keys, picked, "a brief connection's close leaves the selection alone");
    assert.ok(!L.logs.some((l) => /selection cleared/.test(l)));
    // ON: Capture selects; a brief sync while ON (only a list request) leaves it alone
    await L.link.startPersistent();
    await waitFor(() => L.show.connected || undefined, 2000, "connected");
    L.stub.select([4242]);
    await waitFor(() => L.logs.some((l) => /Capture selected Ch 204/.test(l)) || undefined, 2000, "selection followed");
    const sel = L.svc.selection.keys;
    assert.equal(sel.length, 1);
    await L.link.briefSync("Setup key");
    await sleep(100);
    assert.deepEqual(L.svc.selection.keys, sel, "a brief sync while ON leaves the selection alone");
    // the stub drops the connection: cleared, and it stays cleared after the reconnect (Capture does not resend its selection)
    L.stub.drop();
    await waitFor(() => L.logs.some((l) => /CITP connection closed: selection cleared/.test(l)) || undefined, 2000, "cleared on close");
    assert.deepEqual(L.svc.selection.keys, []);
    assert.deepEqual(L.svc.selection.view().targets, []);
    await waitFor(() => L.show.connected || undefined, 3000, "reconnected");
    assert.deepEqual(L.svc.selection.keys, []);
    // a new selection, then OFF: cleared again
    L.stub.select([4242]);
    await waitFor(() => L.svc.selection.keys.length === 1 || undefined, 2000, "selected again");
    const before = L.logs.filter((l) => /selection cleared/.test(l)).length;
    await L.link.stopPersistent();
    assert.deepEqual(L.svc.selection.keys, []);
    assert.equal(L.logs.filter((l) => /CITP connection closed: selection cleared/.test(l)).length, before + 1);
  } finally {
    await L.link.stop();
    await L.stub.close();
  }
});

test("service (v0.7.2): onLinkClosed clears the selection, logs it and keeps output; Deck Control OFF calls it on every path (key, idle, Release)", async () => {
  const steps: string[] = [];
  const cleared: string[] = [];
  let fire: (() => void) | undefined;
  const deck = new DeckControl({
    start: async () => void steps.push("start"),
    stop: async () => void steps.push("stop"),
    release: async () => void steps.push("release"),
    onOff: (why) => void cleared.push(why),
    log: () => undefined,
    setTimer: (fn) => ((fire = fn), "T"),
    clearTimer: () => (fire = undefined),
  });
  deck.activity("knob");
  await deck.toggle("Deck Control key");
  assert.deepEqual(cleared, ["deck control OFF"], "the key");
  deck.activity("knob");
  fire?.();
  await deck.settled();
  assert.deepEqual(cleared.length, 2, "idle");
  deck.activity("knob");
  await deck.setOn(false, "Release key");
  assert.equal(cleared.length, 3, "Release");
  await deck.setOn(false, "Release key");
  assert.equal(cleared.length, 3, "already OFF: nothing");
  assert.ok(steps.indexOf("release") > -1);
});

test("link: a brief connection when Capture is not there fails once (the reason is shown) and does not keep retrying", async () => {
  const L = await makeLink();
  await L.stub.close();
  try {
    const t0 = Date.now();
    await L.link.briefSync("start-up");
    assert.ok(Date.now() - t0 < 1500, "gives up at once instead of waiting out the 2 s brief timeout");
    assert.equal(L.session.delays.length, 0, "one attempt: no back-off wait, no second attempt");
    assert.equal(L.show.status, "error");
    assert.match(L.show.error ?? "", /could not connect/);
    assert.equal(L.session.active, false, "no retry loop");
    assert.match(L.logs.join("\n"), /brief sync \(start-up\): no fixture list after \d+ ms/);
  } finally {
    await L.link.stop();
  }
});
