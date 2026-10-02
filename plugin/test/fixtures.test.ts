// Handoff 15 unit tests: attribute resolution, dial maths, defaults, engine rules, setup storage, selection, service wiring.
import assert from "node:assert/strict";
import test from "node:test";
import { ALL_ATTRS, dialAttr, drivenSignature, homeValue, isAdditiveColourName, mapChannels, renderFixture, stepFraction, writeSlot } from "../src/fixtures/attrs.ts";
import { DmxEngine, type Target, type Transport } from "../src/fixtures/engine.ts";
import { parseDataPacket, OPT_TERMINATED } from "../src/fixtures/sacn.ts";
import { Selection, toTarget, type Controllable } from "../src/fixtures/selection.ts";
import { FixtureService } from "../src/fixtures/service.ts";
import { autoFill, checkSetup, SetupStore, showKey, validateAddress } from "../src/fixtures/setup.ts";
import { ShowModel } from "../src/fixtures/show.ts";
import { loadChannels } from "../src/fixtures/modes.ts";
import { GlobalSettings } from "../src/lib/globals.ts";
import { buildModeBlock, buildObject, cmyHead, movingHead } from "./fixtures/synth.ts";

const FX = "aaaaaaaa-0000-0000-0000-000000000001";
const MD = "bbbbbbbb-0000-0000-0000-000000000001";
const channelsOf = (list: ReturnType<typeof movingHead>) => {
  const obj = buildObject(buildModeBlock({ guid: MD, channels: list }));
  const l = loadChannels(obj, MD, list.length, drivenSignature);
  assert.ok(l.ok, l.error);
  return l.channels;
};
const mapOf = (list: ReturnType<typeof movingHead>) => mapChannels(channelsOf(list));

// ------------------------------------------------------------------ attribute resolution

test("attrs: a moving head resolves pan/tilt (16-bit), dimmer, shutter, colours, extra additive and zoom; speed is not pan", () => {
  const m = mapOf(movingHead());
  assert.equal(m.attrs.pan![0].coarse.offset, 0);
  assert.equal(m.attrs.pan![0].fine!.offset, 1);
  assert.equal(m.attrs.tilt![0].coarse.offset, 2);
  assert.equal(m.attrs.intensity![0].coarse.offset, 5);
  assert.equal(m.shutter!.coarse.offset, 6);
  assert.deepEqual(["red", "green", "blue", "white"].map((a) => m.attrs[a as "red"]![0].coarse.offset), [7, 8, 9, 10]);
  assert.deepEqual(m.extraAdditive.map((s) => s.coarse.name), ["Amber"]);
  assert.equal(m.attrs.zoom![0].fine!.offset, 13);
  assert.equal(m.attrs.focus, undefined);
  // "Pan/Tilt Speed" (offset 4) serves nothing
  for (const a of ALL_ATTRS) for (const s of m.attrs[a] ?? []) assert.notEqual(s.coarse.offset, 4);
});

test("attrs: additive vs subtractive resolution of the colour dials", () => {
  const rgb = mapOf(movingHead());
  assert.equal(dialAttr(rgb, "red-cyan"), "red");
  assert.equal(dialAttr(rgb, "green-magenta"), "green");
  assert.equal(dialAttr(rgb, "blue-yellow"), "blue");
  assert.equal(dialAttr(rgb, "white"), "white");
  const cmy = mapOf(cmyHead());
  assert.equal(dialAttr(cmy, "red-cyan"), "cyan");
  assert.equal(dialAttr(cmy, "green-magenta"), "magenta");
  assert.equal(dialAttr(cmy, "blue-yellow"), "yellow");
  assert.equal(dialAttr(cmy, "white"), null);
  assert.equal(dialAttr(cmy, "focus"), "focus");
  assert.equal(dialAttr(cmy, "iris"), "iris");
  assert.equal(dialAttr(cmy, "zoom"), null);
  // both systems present: the additive channel wins
  const both = mapOf([{ name: "Red" }, { name: "Cyan" }, { name: "Green" }, { name: "Magenta" }, { name: "Blue" }, { name: "Yellow" }, { name: "Pan" }]);
  assert.equal(dialAttr(both, "red-cyan"), "red");
  assert.equal(dialAttr(both, "blue-yellow"), "blue");
});

test("attrs: whole words and the not-the-value list (Pan Speed, Dimmer Curve, Zoom Mode, Red Strobe, White Balance, Panel are not the value)", () => {
  const m = mapOf([{ name: "Pan Speed" }, { name: "Panel" }, { name: "Dimmer Curve" }, { name: "Zoom Mode" }, { name: "Red Strobe" }, { name: "White Balance" }, { name: "Focus Macro" }, { name: "Intensity" }, { name: "Red 1" }, { name: "Red 2" }]);
  assert.equal(m.attrs.pan, undefined);
  assert.equal(m.attrs.zoom, undefined);
  assert.equal(m.attrs.focus, undefined);
  assert.equal(m.attrs.white, undefined);
  assert.equal(m.attrs.intensity![0].coarse.name, "Intensity");
  assert.deepEqual(m.attrs.red!.map((s) => s.coarse.name), ["Red 1", "Red 2"]); // all matching colour channels (cells)
  assert.equal(isAdditiveColourName("Warm White"), true);
  assert.equal(isAdditiveColourName("Cyan"), false);
});

// ------------------------------------------------------------------ dial maths

test("dial maths: ±1 % per tick, 0.1 % in fine mode, clamped, no float drift", () => {
  assert.equal(stepFraction(0.5, 1, false), 0.51);
  assert.equal(stepFraction(0.5, -3, false), 0.47);
  assert.equal(stepFraction(0.5, 1, true), 0.501);
  assert.equal(stepFraction(0.5, -10, true), 0.49);
  assert.equal(stepFraction(0.995, 1, false), 1);
  assert.equal(stepFraction(0.005, -1, false), 0);
  let v = 0;
  for (let i = 0; i < 100; i++) v = stepFraction(v, 1, false);
  assert.equal(v, 1);
  v = 0;
  for (let i = 0; i < 1000; i++) v = stepFraction(v, 1, true);
  assert.equal(v, 1);
});

test("dial maths: 16-bit values use coarse+fine; 8-bit rounds; fine steps move the fine byte", () => {
  const m = mapOf(movingHead());
  const slots = new Uint8Array(512);
  writeSlot(slots, 0, m.attrs.pan![0], 0.5);
  assert.deepEqual([slots[0], slots[1]], [0x80, 0x00]); // round(0.5 × 65535) = 32768 = 0x8000
  writeSlot(slots, 0, m.attrs.pan![0], 1);
  assert.deepEqual([slots[0], slots[1]], [0xff, 0xff]);
  writeSlot(slots, 0, m.attrs.pan![0], 0.501);
  const v = Math.round(0.501 * 65535);
  assert.deepEqual([slots[0], slots[1]], [v >> 8, v & 0xff]);
  assert.notEqual(slots[1], 0, "a 0.1 % step is visible in the fine byte");
  writeSlot(slots, 0, m.attrs.intensity![0], 0.5);
  assert.equal(slots[5], 128);
  writeSlot(slots, 0, m.attrs.intensity![0], 2);
  assert.equal(slots[5], 255);
});

// ------------------------------------------------------------------ default state

test("default state: pan/tilt 50 %, intensity 100 %, shutter 255, additive colours full, everything else 0", () => {
  const m = mapOf(movingHead());
  const s = new Uint8Array(512);
  const values: Partial<Record<(typeof ALL_ATTRS)[number], number>> = {};
  for (const a of ALL_ATTRS) if (m.attrs[a]) values[a] = homeValue(a);
  renderFixture(s, 100, m, values);
  const ch = (n: number): number => s[100 + n - 1]; // 1-based channel
  assert.deepEqual([ch(1), ch(2), ch(3), ch(4)], [0x80, 0, 0x80, 0]);
  assert.equal(ch(5), 0, "Pan/Tilt Speed stays 0");
  assert.equal(ch(6), 255);
  assert.equal(ch(7), 255, "shutter");
  assert.deepEqual([ch(8), ch(9), ch(10), ch(11), ch(12)], [255, 255, 255, 255, 255]);
  assert.deepEqual([ch(13), ch(14)], [0, 0], "zoom 0");
  for (let i = 0; i < 512; i++) if (i < 100 || i >= 114) assert.equal(s[i], 0, `slot ${i + 1} outside the fixture is 0`);
});

// ------------------------------------------------------------------ engine

class FakeTransport implements Transport {
  sent: { universe: number; p: ReturnType<typeof parseDataPacket> }[] = [];
  closed = false;
  send(packet: Buffer, universe: number): void {
    this.sent.push({ universe, p: parseDataPacket(packet) });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}
function makeEngine() {
  const tr = new FakeTransport();
  let tick: (() => void) | undefined;
  let created = 0;
  const cleared: unknown[] = [];
  const engine = new DmxEngine({
    transport: () => {
      created++;
      return tr;
    },
    setInterval: (fn) => {
      tick = fn;
      return "H";
    },
    clearInterval: (h) => {
      cleared.push(h);
      tick = undefined;
    },
  });
  return { engine, tr, tick: () => tick?.(), created: () => created, cleared, running: () => tick !== undefined };
}
const target = (key: string, universe: number, address: number, list = movingHead()): Target => ({ key, universe, address, map: mapOf(list) });

test("engine: nothing is sent, and no socket is even created, until a fixture is touched", () => {
  const e = makeEngine();
  assert.equal(e.engine.active, false);
  e.tick();
  assert.equal(e.tr.sent.length, 0);
  assert.equal(e.created(), 0);
  assert.equal(e.running(), false);
  // reading a value (the strip) is not a touch
  const t = target("a", 1, 285);
  assert.equal(e.engine.value(t, "pan"), 0.5);
  assert.equal(e.engine.value(t, "focus"), undefined);
  assert.equal(e.tr.sent.length, 0);
  // an attribute the fixture lacks is not a touch either
  e.engine.set([t], "focus", 0.3);
  assert.equal(e.engine.active, false);
  assert.equal(e.tr.sent.length, 0);
});

test("engine: first touch starts output of that universe only, from defaults, every other slot 0", () => {
  const e = makeEngine();
  const t = target("a", 1, 285);
  e.engine.set([t], "pan", 0.25);
  assert.equal(e.engine.active, true);
  assert.deepEqual(e.engine.universes, [1]);
  const last = e.tr.sent.at(-1)!;
  assert.equal(last.universe, 1);
  assert.equal(last.p.universe, 1);
  assert.equal(last.p.terminated, false);
  const slot = (n: number): number => last.p.slots[285 + n - 2]; // channel n of the fixture at address 285
  assert.equal(slot(1), Math.round(0.25 * 65535) >> 8);
  assert.equal(slot(3), 0x80, "tilt default 50 %");
  assert.equal(slot(6), 255, "intensity default 100 %");
  assert.equal(slot(7), 255, "shutter");
  assert.equal(slot(8), 255, "red full");
  for (let i = 0; i < 512; i++) if (i < 284 || i >= 284 + 14) assert.equal(last.p.slots[i], 0);
  // 40 fps: each tick sends one more frame for each active universe, nothing on other universes
  e.tick();
  e.tick();
  assert.equal(e.tr.sent.filter((s) => s.universe === 1).length, 3);
  assert.ok(e.tr.sent.every((s) => s.universe === 1));
});

test("engine: a second universe starts only when a fixture on it is touched; sequence numbers count per universe", () => {
  const e = makeEngine();
  e.engine.set([target("a", 1, 1)], "tilt", 0.4);
  e.tick();
  assert.ok(e.tr.sent.every((s) => s.universe === 1));
  e.engine.set([target("b", 3, 20)], "intensity", 0.2);
  assert.equal(e.tr.sent.filter((s) => s.universe === 3).length, 0, "the new universe goes out with the next 40 fps frame");
  e.tick();
  e.tick();
  assert.deepEqual(e.engine.universes, [1, 3]);
  const u3 = e.tr.sent.filter((s) => s.universe === 3);
  assert.equal(u3.length, 2);
  assert.deepEqual(u3.map((s) => s.p.sequence), [1, 2]);
  assert.equal(u3[0].p.slots[19 + 5], Math.round(0.2 * 255));
});

test("engine: Release sends Stream_Terminated x3 on every universe in use, then nothing more; a later touch starts again from defaults", async () => {
  const e = makeEngine();
  e.engine.set([target("a", 1, 1)], "pan", 0.9);
  e.engine.set([target("b", 2, 1)], "pan", 0.9);
  e.tick();
  const before = e.tr.sent.length;
  await e.engine.release();
  const term = e.tr.sent.slice(before).filter((s) => s.p.terminated);
  assert.equal(term.length, 6);
  for (const u of [1, 2]) assert.equal(term.filter((s) => s.universe === u).length, 3);
  assert.ok(e.tr.sent.slice(before).every((s) => (s.p.options & OPT_TERMINATED) !== 0), "only termination frames after Release");
  assert.equal(e.tr.closed, true);
  assert.equal(e.engine.active, false);
  assert.equal(e.running(), false, "the 40 fps timer is gone");
  const n = e.tr.sent.length;
  e.tick();
  assert.equal(e.tr.sent.length, n, "nothing is sent after Release");
  // release when idle sends nothing
  await e.engine.release();
  assert.equal(e.tr.sent.length, n);
  // a new touch starts from defaults again
  assert.equal(e.engine.value(target("a", 1, 1), "pan"), 0.5);
});

test("engine: all-of-type sets every target; Home sets only what a fixture has", () => {
  const e = makeEngine();
  const ts = [target("a", 1, 1), target("b", 1, 100), target("c", 1, 200)];
  e.engine.set(ts, "intensity", 0.4);
  const last = e.tr.sent.at(-1)!.p.slots;
  assert.deepEqual([last[5], last[104], last[204]], [102, 102, 102]);
  e.engine.setMany([target("d", 1, 300, cmyHead())], { pan: 0.5, tilt: 0.5, intensity: 1 });
  assert.equal(e.engine.isTouched("d"), true);
});

// ------------------------------------------------------------------ setup

const memGlobals = (initial: Record<string, unknown> = {}) => {
  const state = { obj: { ...initial } as Record<string, unknown>, sets: 0, failGet: false };
  const g = new GlobalSettings({
    get: async () => {
      if (state.failGet) throw new Error("no answer");
      return JSON.parse(JSON.stringify(state.obj));
    },
    set: async (o) => {
      state.sets++;
      state.obj = JSON.parse(JSON.stringify(o));
    },
  });
  return { state, g };
};

test("global settings: updates merge (other keys survive) and are serialised; a failed read never wipes anything", async () => {
  const { state, g } = memGlobals({ values: { "live/bloom": 1 }, keep: true });
  await Promise.all([g.update({ a: 1 }), g.update({ b: 2 }), g.update({ a: 3 })]);
  assert.deepEqual(state.obj, { values: { "live/bloom": 1 }, keep: true, a: 3, b: 2 });
  state.failGet = true;
  await assert.rejects(g.update({ c: 1 }));
  assert.equal("c" in state.obj, false);
  assert.deepEqual(state.obj.values, { "live/bloom": 1 });
});

test("setup: saved per show name keyed by CaptureInstanceId, reloaded, and the other global keys are kept", async () => {
  const { state, g } = memGlobals({ values: { "live/bloom": 5 } });
  const s = new SetupStore(g);
  await s.load();
  assert.equal(await s.set("Show A", "inst-1", { universe: 1, address: 285 }), null);
  assert.equal(await s.set("Show A", "inst-2", { universe: 2, address: 1 }), null);
  assert.equal(await s.set("Show B", "inst-1", { universe: 4, address: 10 }), null);
  assert.deepEqual(state.obj.values, { "live/bloom": 5 });
  const s2 = new SetupStore(g);
  await s2.load();
  assert.deepEqual(s2.get("Show A", "inst-1"), { universe: 1, address: 285 });
  assert.deepEqual(s2.get("Show B", "inst-1"), { universe: 4, address: 10 });
  assert.equal(s2.get("Show C", "inst-1"), undefined);
  assert.equal(await s2.set("Show A", "inst-2", null), null);
  assert.equal(s2.get("Show A", "inst-2"), undefined);
  assert.equal(showKey(null), "(unnamed show)");
});

test("setup: ranges (universe 1–16, address 1–512) are refused; a read failure on load keeps nothing wrong", async () => {
  const { g } = memGlobals();
  const s = new SetupStore(g);
  for (const [u, a] of [[0, 1], [17, 1], [1, 0], [1, 513], [1.5, 1], [1, 2.2]] as const) assert.match((await s.set("S", "k", { universe: u, address: a }))!, /must be/);
  assert.equal(s.get("S", "k"), undefined);
  assert.equal(validateAddress(1, 500, 13), null);
  assert.match(validateAddress(1, 500, 14)!, /past 512/);
  assert.equal(validateAddress(1, 1, 512), null);
});

test("setup: overlaps and the 512 limit are reported for both fixtures; touching ranges are fine; other universes are independent", () => {
  const e = (key: string, universe: number, address: number, n: number) => ({ key, label: key, channelCount: n, addr: { universe, address } });
  const p = checkSetup([e("a", 1, 1, 56), e("b", 1, 56, 10), e("c", 1, 66, 10), e("d", 2, 1, 56), e("f", 1, 510, 10)]);
  assert.deepEqual([...p.keys()].sort(), ["a", "b", "f"]);
  assert.match(p.get("a")![0], /overlaps b/);
  assert.match(p.get("b")![0], /overlaps a/);
  assert.match(p.get("f")![0], /past 512/);
  assert.equal(p.has("c"), false, "c starts right after b ends");
  assert.equal(p.has("d"), false);
});

test("setup: auto-fill sequential, wraps into the next universe, stops at universe 16", () => {
  const r = autoFill([{ key: "a", channelCount: 56 }, { key: "b", channelCount: 56 }, { key: "c", channelCount: 56 }], { universe: 1, address: 285 });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.assign, { a: { universe: 1, address: 285 }, b: { universe: 1, address: 341 }, c: { universe: 1, address: 397 } });
  const w = autoFill([{ key: "a", channelCount: 300 }, { key: "b", channelCount: 300 }], { universe: 1, address: 1 });
  assert.ok(w.ok);
  if (w.ok) assert.deepEqual(w.assign.b, { universe: 2, address: 1 });
  const x = autoFill([{ key: "a", channelCount: 300 }, { key: "b", channelCount: 300 }], { universe: 16, address: 1 });
  assert.equal(x.ok, false);
  assert.equal(autoFill([{ key: "a", channelCount: 1 }], { universe: 0, address: 1 }).ok, false);
  // result of an auto-fill is overlap-free
  const items = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, channelCount: 56 }));
  const f = autoFill(items, { universe: 3, address: 20 });
  assert.ok(f.ok);
  if (f.ok) assert.equal(checkSetup(items.map((it) => ({ key: it.key, label: it.key, channelCount: 56, addr: f.assign[it.key] }))).size, 0);
});

// ------------------------------------------------------------------ selection

const ctl = (n: number, name: string, typeKey: string, universe: number, address: number, list = movingHead()): Controllable => ({
  fixture: { key: `k${n}`, identifier: n, channel: n, manufacturer: "M", name, mode: "Std", channelCount: list.length, fixtureGuid: null, modeGuid: null, typeKey, position: [0, 0, 0] },
  map: mapOf(list),
  addr: { universe, address },
});

test("selection: rotate steps through controllable fixtures (wraps), push toggles single ↔ all of this type, strip texts", () => {
  const list = [ctl(1, "Rogue R2X Wash", "T1", 1, 1), ctl(2, "Rogue R2X Wash", "T1", 1, 100), ctl(3, "Spot", "T2", 1, 200), ctl(203, "Rogue R2X Wash", "T1", 1, 285)];
  const s = new Selection(() => list);
  assert.equal(s.view().primary!.fixture.key, "k1");
  s.step(1);
  assert.equal(s.view().primary!.fixture.key, "k2");
  s.step(2);
  assert.equal(s.view().primary!.fixture.key, "k203");
  s.step(1);
  assert.equal(s.view().primary!.fixture.key, "k1", "wraps");
  s.step(-1);
  assert.equal(s.view().primary!.fixture.key, "k203");
  assert.deepEqual([s.view().line1, s.view().line2], ["Rogue R2X Wash", "Ch 203 · 1/285"]);
  s.toggle();
  const v = s.view();
  assert.equal(v.mode, "type");
  assert.equal(v.line1, "All Rogue R2X Wash");
  assert.equal(v.line2, "3 fixtures");
  assert.deepEqual(v.targets.map((c) => c.fixture.key), ["k1", "k2", "k203"]);
  s.step(-3);
  assert.equal(s.view().primary!.fixture.key, "k1", "stepping works in all-of-type mode");
  s.toggle();
  assert.equal(s.view().mode, "single");
  assert.equal(s.view().targets.length, 1);
});

test("selection: empty list, and a selected fixture that disappears falls back to the first", () => {
  let list: Controllable[] = [];
  const s = new Selection(() => list);
  assert.equal(s.view().primary, undefined);
  assert.equal(s.view().targets.length, 0);
  s.step(1);
  list = [ctl(1, "A", "T", 1, 1), ctl(2, "A", "T", 1, 100)];
  s.step(1);
  assert.equal(s.view().primary!.fixture.key, "k2");
  list = [ctl(1, "A", "T", 1, 1)];
  assert.equal(s.view().primary!.fixture.key, "k1");
});

// ------------------------------------------------------------------ service (show model + setup + selection + engine)

const OBJ_MOVING = buildObject(buildModeBlock({ guid: MD, channels: movingHead() }));
const OBJ_CMY = buildObject(buildModeBlock({ guid: "bbbbbbbb-0000-0000-0000-000000000002", channels: cmyHead() }));
const FX2 = "aaaaaaaa-0000-0000-0000-000000000002";
const BAD = "aaaaaaaa-0000-0000-0000-000000000003";
function fixtureList(): any[] {
  const base = { ok: true as const, showName: "My Show", log: [] as string[] };
  const mk = (index: number, channel: number, name: string, mode: string, channelCount: number, fixtureGuid: string, modeGuid: string, inst: string, pos: [number, number, number] = [0, 0, 0]) => ({
    index, identifier: 100 + index, manufacturer: "M", name, mode, channelCount, isDimmer: 0,
    ids: [{ type: 2, name: "", size: 16, hex: "", guid: null, guidRaw: fixtureGuid, value: null }, { type: 3, name: "", size: 16, hex: "", guid: null, guidRaw: modeGuid, value: null }, { type: 4, name: "", size: 16, hex: "", guid: null, guidRaw: inst, value: null }],
    patched: 0, universe: 0, universeChannel: 0, unit: "", channel, circuit: "", note: "", position: pos, angles: [0, 0, 0],
  });
  return [{ ...base, fixtures: [
    mk(0, 203, "Rogue R2X Wash", "Std", 14, FX, MD, "00000000-0000-0000-0000-0000000000a1", [4, 6, 2]),
    mk(1, 204, "Rogue R2X Wash", "Std", 14, FX, MD, "00000000-0000-0000-0000-0000000000a2", [-4, 6, -2]),
    mk(2, 5, "Colour Mixer", "Std", 8, FX2, "bbbbbbbb-0000-0000-0000-000000000002", "00000000-0000-0000-0000-0000000000a3"),
    mk(3, 9, "Unknown Thing", "Std", 8, BAD, MD, "00000000-0000-0000-0000-0000000000a4"),
  ] }];
}
async function makeService() {
  const objects: Record<string, Buffer> = { [FX]: OBJ_MOVING, [FX2]: OBJ_CMY };
  const [sync] = fixtureList();
  const show = new ShowModel({
    sync: async () => sync,
    libraryPath: "/nonexistent/Library.c2z",
    open: () => ({ libPath: "x", readObjectByGuid: (g) => { if (!objects[g]) throw new Error("not in library"); return objects[g]; }, close: () => undefined }),
  });
  const { g, state } = memGlobals();
  const setup = new SetupStore(g);
  const e = makeEngine();
  const svc = new FixtureService(show, setup, e.engine);
  await show.sync();
  return { svc, show, setup, e, state };
}

test("service: show model syncs, parses each type once, and 'controllable' = parsed safely + has an address", async () => {
  const { svc, show } = await makeService();
  assert.equal(show.status, "ok");
  assert.equal(show.showName, "My Show");
  assert.equal(show.fixtures.length, 4);
  assert.equal(show.types.size, 3);
  assert.equal(svc.controllables().length, 0, "no addresses yet");
  const v = svc.setupView();
  assert.deepEqual(v.fixtures.map((f) => f.channel), [5, 9, 203, 204], "ordered by Capture channel");
  assert.equal(v.fixtures.find((f) => f.channel === 9)!.parsed, false);
  assert.match(v.fixtures.find((f) => f.channel === 9)!.parseError!, /library/);
  assert.equal(v.fixtures.find((f) => f.channel === 203)!.hasPanTilt, true);
  assert.equal(v.fixtures.find((f) => f.channel === 5)!.hasPanTilt, true);
  assert.match(v.fixtures.find((f) => f.channel === 203)!.position, /^SL 4\.0 · DS 2\.0 · H 6\.0$/);
  assert.match(v.fixtures.find((f) => f.channel === 204)!.position, /^SR 4\.0 · US 2\.0/);
  // the fixture that did not parse can be given an address but is never controllable
  assert.equal(await svc.setAddress(show.fixtures[3].key, { universe: 1, address: 1 }), null);
  assert.equal(svc.controllables().length, 0);
  assert.equal(await svc.setAddress(show.fixtures[0].key, { universe: 1, address: 285 }), null);
  assert.deepEqual(svc.controllables().map((c) => c.fixture.channel), [203]);
  assert.match(v.blackoutWarning, /BLACKS OUT/);
});

test("service: overlapping or out-of-range addresses make fixtures not controllable and are reported", async () => {
  const { svc, show } = await makeService();
  const [a, b] = [show.fixtures[0].key, show.fixtures[1].key];
  assert.equal(await svc.setAddress(a, { universe: 1, address: 285 }), null);
  assert.equal(await svc.setAddress(b, { universe: 1, address: 290 }), null);
  assert.equal(svc.controllables().length, 0);
  const v = svc.setupView();
  assert.match(v.fixtures.find((f) => f.channel === 203)!.issues[0], /overlaps/);
  assert.match((await svc.setAddress(b, { universe: 1, address: 505 }))!, /past 512/);
  assert.equal(await svc.setAddress(b, { universe: 1, address: 299 }), null);
  assert.equal(svc.controllables().length, 2);
  assert.match((await svc.setAddress(b, { universe: 99, address: 1 }))!, /universe/);
  assert.match((await svc.setAddress("nope", { universe: 1, address: 1 }))!, /unknown fixture/);
});

test("service: setup is stored per show name; reading a different show shows none of it", async () => {
  const { svc, show, setup } = await makeService();
  await svc.setAddress(show.fixtures[0].key, { universe: 1, address: 285 });
  assert.equal(svc.controllables().length, 1);
  show.showName = "Another Show";
  assert.equal(svc.controllables().length, 0);
  assert.deepEqual(setup.forShow("My Show")[show.fixtures[0].key], { universe: 1, address: 285 });
});

test("service: auto-fill from the setup helper; the key is the CaptureInstanceId", async () => {
  const { svc, show } = await makeService();
  assert.equal(show.fixtures[0].key, "00000000-0000-0000-0000-0000000000a1");
  const keys = [show.fixtures[1].key, show.fixtures[0].key];
  assert.equal(await svc.autoFill(keys, { universe: 1, address: 285 }), null);
  const v = svc.setupView();
  assert.deepEqual(v.fixtures.find((f) => f.channel === 203)!.addr, { universe: 1, address: 285 });
  assert.deepEqual(v.fixtures.find((f) => f.channel === 204)!.addr, { universe: 1, address: 299 });
  assert.match((await svc.autoFill(keys, { universe: 16, address: 500 }))!, /do not fit/);
  assert.match((await svc.autoFill([], { universe: 1, address: 1 }))!, /no fixtures/);
});

test("service: dials act on the selection — additive vs subtractive, missing attribute is a no-op and sends nothing, fine mode, home", async () => {
  const { svc, show, e } = await makeService();
  await svc.autoFill([show.fixtures[0].key], { universe: 1, address: 285 });
  await svc.setAddress(show.fixtures[2].key, { universe: 2, address: 1 });
  // controllable order by channel: Colour Mixer (5), Rogue (203)
  assert.deepEqual(svc.controllables().map((c) => c.fixture.channel), [5, 203]);
  assert.equal(svc.selection.view().primary!.fixture.channel, 5);
  // CMY fixture: Red|Cyan is cyan; White and Zoom are missing → "—", rotating does nothing and sends nothing
  assert.equal(svc.readout("red-cyan").attr, "cyan");
  assert.equal(svc.readout("white").value, null);
  assert.equal(svc.rotate("white", 1, false), false);
  assert.equal(svc.rotate("zoom", 1, false), false);
  assert.equal(svc.home("zoom"), false);
  assert.equal(e.engine.active, false);
  assert.equal(e.tr.sent.length, 0);
  // before a touch the readout shows the default and "not touched"
  assert.deepEqual([svc.readout("intensity").value, svc.readout("intensity").touched], [1, false]);
  assert.equal(svc.rotate("red-cyan", 5, false), true);
  assert.equal(svc.readout("red-cyan").value, 0.05);
  assert.equal(svc.readout("red-cyan").touched, true);
  assert.deepEqual(e.engine.universes, [2]);
  assert.equal(e.engine.slots(2)[1], Math.round(0.05 * 255), "cyan is the second channel");
  // Rogue: Red|Cyan is red (additive), 16-bit pan and fine mode
  svc.rotateSelect(1);
  assert.equal(svc.readout("red-cyan").attr, "red");
  assert.equal(svc.readout("red-cyan").value, 1);
  svc.rotate("red-cyan", -10, false);
  assert.equal(svc.readout("red-cyan").value, 0.9);
  svc.rotate("pan", 1, true);
  assert.equal(svc.readout("pan").value, 0.501);
  const s = e.engine.slots(1);
  assert.deepEqual([s[284], s[285]], [Math.round(0.501 * 65535) >> 8, Math.round(0.501 * 65535) & 0xff]);
  assert.equal(s[284 + 7], Math.round(0.9 * 255), "red channel");
  // long touch = home
  assert.equal(svc.home("pan"), true);
  assert.equal(svc.readout("pan").value, 0.5);
  assert.equal(svc.home("red-cyan"), true);
  assert.equal(svc.readout("red-cyan").value, 1);
});

test("service: all-of-type applies to every fixture of the type; Home Selected sets pan/tilt 50 % and intensity 100 %", async () => {
  const { svc, show, e } = await makeService();
  await svc.autoFill([show.fixtures[0].key, show.fixtures[1].key], { universe: 1, address: 1 });
  assert.deepEqual(svc.controllables().map((c) => c.fixture.channel), [203, 204]);
  svc.toggleSelectMode();
  assert.equal(svc.selection.view().targets.length, 2);
  svc.rotate("intensity", -50, false);
  const s = e.engine.slots(1);
  assert.deepEqual([s[5], s[14 + 5]], [128, 128].map((v) => Math.round(0.5 * 255)));
  svc.rotate("pan", 10, false);
  svc.rotate("tilt", -20, false);
  assert.equal(svc.homeSelected(), true);
  const h = e.engine.slots(1);
  assert.deepEqual([h[0], h[2], h[5]], [0x80, 0x80, 255]);
  assert.deepEqual([h[14], h[16], h[14 + 5]], [0x80, 0x80, 255]);
});

test("service: Release stops output and sends the termination frames; changing the setup while live releases output", async () => {
  const { svc, show, e } = await makeService();
  await svc.setAddress(show.fixtures[0].key, { universe: 1, address: 285 });
  svc.rotate("pan", 1, false);
  assert.equal(e.engine.active, true);
  const n = e.tr.sent.length;
  await svc.release();
  assert.equal(e.engine.active, false);
  assert.equal(e.tr.sent.slice(n).filter((x) => x.p.terminated).length, 3);
  svc.rotate("pan", 1, false);
  assert.equal(e.engine.active, true);
  await svc.setAddress(show.fixtures[0].key, { universe: 1, address: 290 }); // a live fixture moves: stop first
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.engine.active, false);
  assert.ok(e.tr.sent.some((x) => x.p.terminated));
});

test("service: nothing is sent just by reading the show, selecting, or pressing Home Selected with nothing controllable", async () => {
  const { svc, e } = await makeService();
  svc.rotateSelect(1);
  svc.toggleSelectMode();
  assert.equal(svc.homeSelected(), false);
  assert.equal(svc.rotate("pan", 1, false), false);
  assert.equal(e.tr.sent.length, 0);
  assert.equal(e.created(), 0);
});

test("showModel: a failed sync keeps the last good model and reports the error; a library that cannot be opened makes no type controllable", async () => {
  const { show } = await makeService();
  const m = new ShowModel({ sync: async () => ({ ok: false, error: "no CITP", fixtures: [], showName: null, log: [] }) });
  await m.sync();
  assert.equal(m.status, "error");
  assert.equal(m.error, "no CITP");
  const [sync] = fixtureList();
  const m2 = new ShowModel({ sync: async () => sync, open: () => { throw new Error("ENOENT"); }, libraryPath: "/x" });
  await m2.sync();
  assert.equal(m2.status, "ok");
  assert.ok([...m2.types.values()].every((t) => !t.ok && /cannot open the Capture library/.test(t.error!)));
  assert.equal(show.status, "ok");
});

test("toTarget carries the 1-based address", () => {
  const c = ctl(1, "A", "T", 3, 17);
  assert.deepEqual({ ...toTarget(c), map: undefined }, { key: "k1", universe: 3, address: 17, map: undefined });
});
