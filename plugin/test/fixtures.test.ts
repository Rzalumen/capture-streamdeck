// Handoff 15 unit tests: attribute resolution, dial maths, defaults, engine rules, setup storage, selection, service wiring.
import assert from "node:assert/strict";
import test from "node:test";
import { ALL_ATTRS, dialAttr, drivenSignature, homeValue, isAdditiveColourName, mapChannels, renderFixture, stepFraction, writeSlot } from "../src/fixtures/attrs.ts";
import { DmxEngine, type Target, type Transport } from "../src/fixtures/engine.ts";
import { parseDataPacket, OPT_TERMINATED } from "../src/fixtures/sacn.ts";
import { Selection, STALE_NOTE, toTarget, type Controllable } from "../src/fixtures/selection.ts";
import type { ShowFixture } from "../src/fixtures/show.ts";
import { IdentifyPlanner, FIRST_IDENTIFIER, MAX_ATTEMPTS, RESEND_AFTER_MS } from "../src/fixtures/identify.ts";
import { UNIDENTIFIED, decodeFixtureModify, decodeMessage, isAllowedOutgoing, buildFixtureIdentify, buildFixtureListRequest, buildNack, buildLeaveShow, buildEnterShow, buildPNam, buildLaserFeedList, buildHeader, CAEX, type CaexFixture } from "../src/fixtures/citp.ts";
import { buildModifyMessage, buildSelectionMessage } from "./fixtures/synth.ts";
import { FixtureService } from "../src/fixtures/service.ts";
import { autoFill, checkSetup, SetupStore, showKey, validateAddress } from "../src/fixtures/setup.ts";
import { ShowModel } from "../src/fixtures/show.ts";
import { loadChannels } from "../src/fixtures/modes.ts";
import { buildModel } from "../src/fixtures/pages.ts";
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
const modelOf = (list: ReturnType<typeof movingHead>) => buildModel(channelsOf(list));

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
const target = (key: string, universe: number, address: number, list = movingHead()): Target => ({ key, universe, address, map: mapOf(list), model: modelOf(list) });

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

test("engine: set() on several targets sets them all; setMany only writes what a fixture has", () => {
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

const ctl = (n: number, name: string, typeKey: string, universe: number, address: number, list = movingHead(), position: [number, number, number] = [0, 0, 0], channel = n): Controllable => ({
  fixture: { key: `k${n}`, identifier: n, channel, manufacturer: "M", name, mode: "Std", channelCount: list.length, fixtureGuid: null, modeGuid: null, typeKey, position },
  map: mapOf(list),
  model: modelOf(list),
  addr: { universe, address },
});
const plain = (n: number, name: string, typeKey = "T", channel = n, position: [number, number, number] = [0, 0, 0]): ShowFixture => ({ key: `k${n}`, identifier: n, channel, manufacturer: "M", name, mode: "Std", channelCount: 14, fixtureGuid: null, modeGuid: null, typeKey, position });
const selOf = (list: Controllable[], extra: ShowFixture[] = []) => new Selection(() => [...list.map((c) => c.fixture), ...extra], () => list);

test("selection: Capture's selection becomes the deck selection — single, several, strip texts", () => {
  const list = [ctl(1, "Rogue R2X Wash", "T1", 1, 1), ctl(2, "Rogue R2X Wash", "T1", 1, 100), ctl(3, "Spot", "T2", 1, 200), ctl(203, "Rogue R2X Wash", "T1", 1, 285)];
  const s = selOf(list);
  assert.equal(s.view().primary!.fixture.key, "k1", "before any click: the first controllable fixture");
  s.onCapture(["k203"]);
  let v = s.view();
  assert.deepEqual([v.line1, v.line2, v.note, v.mark], ["Rogue R2X Wash", "Ch 203 · 1/285", "", "4/4"]);
  assert.deepEqual(v.targets.map((c) => c.fixture.key), ["k203"]);
  s.onCapture(["k2", "k203"]);
  v = s.view();
  assert.deepEqual(v.targets.map((c) => c.fixture.key), ["k2", "k203"], "in Capture's selection order");
  assert.deepEqual([v.line1, v.line2, v.mark], ["Rogue R2X Wash ×2", "Ch 2 +1", "×2"]);
  s.onCapture(["k1", "k3"]);
  assert.equal(s.view().line1, "2 fixtures", "mixed models");
  assert.equal(s.view().stale, false);
});

test("selection: an empty Capture selection keeps the last one, marked; the next click replaces it; the Select dial picks one by hand until then", () => {
  const list = [ctl(1, "A", "T", 1, 1), ctl(2, "A", "T", 1, 100), ctl(3, "A", "T", 1, 200)];
  const s = selOf(list);
  s.onCapture([]);
  assert.equal(s.view().stale, false, "nothing was selected yet: nothing to mark");
  s.onCapture(["k2"]);
  s.onCapture([]);
  let v = s.view();
  assert.deepEqual(v.targets.map((c) => c.fixture.key), ["k2"], "still drives the last selection");
  assert.equal(v.stale, true);
  assert.equal(v.note, STALE_NOTE);
  s.step(1);
  v = s.view();
  assert.deepEqual([v.primary!.fixture.key, v.stale, v.note], ["k3", false, ""], "manual choice is not 'stale'");
  s.step(1);
  assert.equal(s.view().primary!.fixture.key, "k1", "wraps");
  s.step(-1);
  assert.equal(s.view().primary!.fixture.key, "k3");
  s.onCapture(["k1", "k2"]);
  assert.deepEqual(s.view().targets.map((c) => c.fixture.key), ["k1", "k2"], "Capture's next click overrides the manual choice");
  s.clear();
  assert.deepEqual(s.keys, []);
});

test("selection: selected fixtures that are not controllable — none, or some; Capture Channel 0 shows the position hint", () => {
  const list = [ctl(1, "A", "T", 1, 1), ctl(7, "ColorBlaze 72", "T9", 1, 300, movingHead(), [1.3, 4, -0.9], 0)];
  const nothing = plain(50, "Rogue R2X Wash", "T1", 203);
  const s = selOf(list, [nothing]);
  s.onCapture(["k50"]);
  let v = s.view();
  assert.deepEqual([v.line1, v.line2, v.targets.length, v.uncontrollable], ["Rogue R2X Wash", "No address — Setup", 0, 1]);
  assert.equal(v.note, "Ch 203");
  s.onCapture(["k1", "k50"]);
  v = s.view();
  assert.deepEqual([v.targets.length, v.uncontrollable, v.note], [1, 1, "1 without address"], "drives the one that can be driven");
  s.onCapture(["k7"]);
  v = s.view();
  assert.deepEqual([v.line1, v.line2, v.note], ["ColorBlaze 72", "SL 1.3 · US 0.9", "1/300"]);
  s.onCapture(["k7", "k1"]);
  assert.equal(s.view().line2, "SL 1.3 · US 0.9 +1");
});

test("selection: nothing at all", () => {
  const s = selOf([]);
  assert.equal(s.view().primary, undefined);
  assert.equal(s.view().targets.length, 0);
  s.step(1);
  s.onCapture(["gone"]);
  assert.equal(s.view().targets.length, 0, "a key that is not in the show is ignored");
});

// ------------------------------------------------------------------ service (show model + setup + selection + engine)

const OBJ_MOVING = buildObject(buildModeBlock({ guid: MD, channels: movingHead() }));
const OBJ_CMY = buildObject(buildModeBlock({ guid: "bbbbbbbb-0000-0000-0000-000000000002", channels: cmyHead() }));
/** A colour-cell fixture: Dimmer and Red 1..5 / Green 1..5 / Blue 1..5 (15 + 1 channels). */
const cellHead = () => [{ name: "Dimmer" }, ...[1, 2, 3, 4, 5].flatMap((n) => [{ name: `Red ${n}` }, { name: `Green ${n}` }, { name: `Blue ${n}` }])];
const FX3 = "aaaaaaaa-0000-0000-0000-000000000004";
const OBJ_CELLS = buildObject(buildModeBlock({ guid: "bbbbbbbb-0000-0000-0000-000000000004", channels: cellHead() }));
const FX2 = "aaaaaaaa-0000-0000-0000-000000000002";
const BAD = "aaaaaaaa-0000-0000-0000-000000000003";
function fixtureList(): CaexFixture[] {
  const mk = (index: number, channel: number, name: string, mode: string, channelCount: number, fixtureGuid: string, modeGuid: string, inst: string, pos: [number, number, number] = [0, 0, 0], identifier = 100 + index): CaexFixture => ({
    index, identifier, manufacturer: "M", name, mode, channelCount, isDimmer: 0,
    ids: [{ type: 2, name: "", size: 16, hex: "", guid: null, guidRaw: fixtureGuid, value: null }, { type: 3, name: "", size: 16, hex: "", guid: null, guidRaw: modeGuid, value: null }, { type: 4, name: "", size: 16, hex: "", guid: null, guidRaw: inst, value: null }],
    patched: 0, universe: 0, universeChannel: 0, unit: "", channel, circuit: "", note: "", position: pos, angles: [0, 0, 0],
  });
  return [
    mk(0, 203, "Rogue R2X Wash", "Std", 14, FX, MD, "00000000-0000-0000-0000-0000000000a1", [4, 6, 2]),
    mk(1, 204, "Rogue R2X Wash", "Std", 14, FX, MD, "00000000-0000-0000-0000-0000000000a2", [-4, 6, -2]),
    mk(2, 5, "Colour Mixer", "Std", 8, FX2, "bbbbbbbb-0000-0000-0000-000000000002", "00000000-0000-0000-0000-0000000000a3"),
    mk(3, 9, "Unknown Thing", "Std", 8, BAD, MD, "00000000-0000-0000-0000-0000000000a4"),
    mk(4, 0, "Cell Bar", "Std", 16, FX3, "bbbbbbbb-0000-0000-0000-000000000004", "00000000-0000-0000-0000-0000000000a5", [1.3, 3, -0.9]),
  ];
}
const ID = { rogue203: 100, rogue204: 101, mixer: 102, unknown: 103, cells: 104 };
async function makeService(opts: { list?: CaexFixture[]; request?: () => boolean } = {}) {
  const objects: Record<string, Buffer> = { [FX]: OBJ_MOVING, [FX2]: OBJ_CMY, [FX3]: OBJ_CELLS };
  let opened = 0;
  const logs: string[] = [];
  const show = new ShowModel({
    libraryPath: "/nonexistent/Library.c2z",
    open: () => {
      opened++;
      return { libPath: "x", readObjectByGuid: (g) => { if (!objects[g]) throw new Error("not in library"); return objects[g]; }, close: () => undefined };
    },
    request: opts.request,
    log: (l) => logs.push(l),
  });
  const { g, state } = memGlobals();
  const setup = new SetupStore(g);
  const e = makeEngine();
  const svc = new FixtureService(show, setup, e.engine, (l) => logs.push(l));
  show.setConnected(true);
  show.setShowName("My Show");
  show.applyList(0, opts.list ?? fixtureList());
  return { svc, show, setup, e, state, logs, opened: () => opened };
}

test("service: the show model parses each type once, and 'controllable' = parsed safely + has an address", async () => {
  const { svc, show, opened } = await makeService();
  assert.equal(show.status, "ok");
  assert.equal(show.showName, "My Show");
  assert.equal(show.fixtures.length, 5);
  assert.equal(show.types.size, 4);
  assert.equal(opened(), 1);
  show.applyList(0, fixtureList());
  assert.equal(opened(), 1, "a list with no new type does not open the library again");
  assert.equal(svc.controllables().length, 0, "no addresses yet");
  const v = svc.setupView();
  assert.deepEqual(v.fixtures.map((f) => f.channel), [0, 5, 9, 203, 204], "ordered by Capture channel");
  assert.equal(v.fixtures.find((f) => f.channel === 9)!.parsed, false);
  assert.match(v.fixtures.find((f) => f.channel === 9)!.parseError!, /library/);
  assert.equal(v.fixtures.find((f) => f.channel === 203)!.hasPanTilt, true);
  assert.match(v.fixtures.find((f) => f.channel === 203)!.position, /^SL 4\.0 · DS 2\.0 · H 6\.0$/);
  assert.match(v.fixtures.find((f) => f.channel === 204)!.position, /^SR 4\.0 · US 2\.0/);
  const unknown = show.fixtures.find((f) => f.channel === 9)!;
  assert.equal(await svc.setAddress(unknown.key, { universe: 1, address: 1 }), null);
  assert.equal(svc.controllables().length, 0, "a type that did not parse is never controllable");
  assert.equal(await svc.setAddress(show.fixtures[0].key, { universe: 1, address: 285 }), null);
  assert.deepEqual(svc.controllables().map((c) => c.fixture.channel), [203]);
  assert.match(v.blackoutWarning, /BLACKS OUT/);
});

test("showModel: Type 0 replaces, Type 1/2 add or replace single fixtures, FixtureRemove removes, identifiers resolve", async () => {
  const { show } = await makeService();
  assert.equal(show.resolve(ID.rogue203)!.channel, 203);
  assert.equal(show.resolve(UNIDENTIFIED), undefined);
  const extra = { ...fixtureList()[0], index: 0, identifier: 500, channel: 777, ids: fixtureList()[0].ids.map((d) => (d.type === 4 ? { ...d, guidRaw: "00000000-0000-0000-0000-0000000000ff" } : d)) };
  show.applyList(1, [extra]);
  assert.equal(show.fixtures.length, 6, "a Type 1 list adds");
  assert.equal(show.resolve(500)!.channel, 777);
  show.applyList(2, [{ ...extra, identifier: 501 }]);
  assert.equal(show.fixtures.length, 6, "a Type 2 list replaces the fixture with the same CaptureInstanceId");
  assert.equal(show.resolve(500), undefined);
  assert.equal(show.resolve(501)!.channel, 777);
  show.remove([501]);
  assert.equal(show.fixtures.length, 5);
  show.applyList(0, fixtureList().slice(0, 2));
  assert.equal(show.fixtures.length, 2, "a Type 0 list replaces everything");
  // numbers we assigned but Capture has not echoed yet
  show.pendingIds = new Map([[100001, show.fixtures[0].key]]);
  assert.equal(show.resolve(100001)!.key, show.fixtures[0].key);
  show.clear();
  assert.equal(show.fixtures.length, 0);
  assert.equal(show.resolve(ID.rogue203), undefined);
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

test("service: setup is stored per show name; a different show shows none of it", async () => {
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

test("service: dials act on the selection — additive vs subtractive, missing attribute is a no-op and sends nothing, fine mode, knob press = home attribute", async () => {
  const { svc, show, e } = await makeService();
  await svc.autoFill([show.fixtures[0].key], { universe: 1, address: 285 });
  await svc.setAddress(show.fixtures[2].key, { universe: 2, address: 1 });
  assert.deepEqual(svc.controllables().map((c) => c.fixture.channel), [5, 203]);
  assert.equal(svc.selection.view().primary!.fixture.channel, 5, "nothing selected in Capture yet: the first controllable fixture");
  assert.equal(svc.readout("red-cyan").attr, "cyan");
  assert.equal(svc.readout("white").value, null);
  assert.equal(svc.rotate("white", 1, false), false);
  assert.equal(svc.rotate("zoom", 1, false), false);
  assert.equal(svc.home("zoom"), false);
  assert.equal(e.engine.active, false);
  assert.equal(e.tr.sent.length, 0);
  assert.deepEqual([svc.readout("intensity").value, svc.readout("intensity").touched], [1, false]);
  assert.equal(svc.rotate("red-cyan", 5, false), true);
  assert.equal(svc.readout("red-cyan").value, 0.05);
  assert.equal(svc.readout("red-cyan").touched, true);
  assert.deepEqual(e.engine.universes, [2]);
  assert.equal(e.engine.slots(2)[1], Math.round(0.05 * 255), "cyan is the second channel");
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
  assert.equal(svc.home("pan"), true);
  assert.equal(svc.readout("pan").value, 0.5);
  assert.equal(svc.home("red-cyan"), true);
  assert.equal(svc.readout("red-cyan").value, 1);
});

test("service: Capture's selection events — single, several, empty, a fixture without an address, an unknown identifier", async () => {
  let requests = 0;
  const { svc, show, e, logs } = await makeService({ request: () => (requests++, true) });
  await svc.autoFill([show.fixtures[0].key, show.fixtures[1].key], { universe: 1, address: 1 });
  svc.onSelectionEvent([ID.rogue204]);
  assert.deepEqual(svc.selection.view().targets.map((c) => c.fixture.channel), [204]);
  assert.match(logs.at(-1)!, /Capture selected Ch 204: 1 controllable/);
  svc.onSelectionEvent([ID.rogue203, ID.rogue204]);
  assert.deepEqual(svc.selection.view().targets.map((c) => c.fixture.channel), [203, 204]);
  svc.onSelectionEvent([]);
  assert.deepEqual(svc.selection.view().targets.map((c) => c.fixture.channel), [203, 204], "empty: the last selection stays");
  assert.equal(svc.selection.view().stale, true);
  svc.onSelectionEvent([ID.mixer]);
  let v = svc.selection.view();
  assert.deepEqual([v.targets.length, v.line2, v.line1], [0, "No address — Setup", "Colour Mixer"], "selected but no address");
  assert.equal(svc.rotate("pan", 1, false), false, "nothing to drive");
  assert.equal(e.tr.sent.length, 0);
  svc.onSelectionEvent([ID.rogue203, ID.mixer]);
  assert.deepEqual(svc.selection.view().targets.map((c) => c.fixture.channel), [203]);
  assert.equal(svc.selection.view().uncontrollable, 1);
  assert.equal(requests, 0);
  svc.onSelectionEvent([424242]);
  assert.equal(requests, 1, "an identifier we do not know asks for a fresh list");
  assert.match(logs.at(-1)!, /not in the list/);
  assert.deepEqual(svc.selection.view().targets.map((c) => c.fixture.channel), [203], "and the selection is left alone");
  // a number we assigned and Capture has not echoed yet resolves too
  show.pendingIds = new Map([[100001, show.fixtures[1].key]]);
  svc.onSelectionEvent([100001]);
  assert.deepEqual(svc.selection.view().targets.map((c) => c.fixture.channel), [204]);
  svc.onShowGone("Capture left the show");
  assert.deepEqual(svc.selection.keys, []);
});

test("service: several selected fixtures move together, each relative to its own value; Home touches only the selected ones", async () => {
  const { svc, show, e } = await makeService();
  await svc.autoFill([show.fixtures[0].key, show.fixtures[1].key], { universe: 1, address: 1 });
  await svc.setAddress(show.fixtures[2].key, { universe: 1, address: 100 });
  svc.onSelectionEvent([ID.mixer]);
  svc.rotate("intensity", -10, false); // the mixer is out of the way: it must stay as it is
  const mixerBefore = [...e.engine.slots(1).subarray(99, 107)];
  svc.onSelectionEvent([ID.rogue203]);
  svc.rotate("intensity", -10, false);
  assert.equal(svc.readout("intensity").value, 0.9);
  svc.onSelectionEvent([ID.rogue203, ID.rogue204]);
  svc.rotate("intensity", -10, false);
  let s = e.engine.slots(1);
  assert.deepEqual([s[5], s[14 + 5]], [Math.round(0.8 * 255), Math.round(0.9 * 255)], "each relative to its own value: 0.9 → 0.8 and 1.0 → 0.9");
  svc.rotate("pan", 10, false);
  svc.rotate("tilt", -20, false);
  assert.equal(svc.readout("pan").multi, 2);
  assert.equal(svc.homeSelected(), true);
  s = e.engine.slots(1);
  assert.deepEqual([s[0], s[2], s[5]], [0x80, 0x80, 255], "full home: pan/tilt 50 %, intensity 100 %");
  assert.deepEqual([s[14], s[16], s[14 + 5]], [0x80, 0x80, 255]);
  assert.deepEqual([...s.subarray(99, 107)], mixerBefore, "the fixture that was not selected is untouched");
  // knob press: the attribute only
  svc.rotate("pan", 10, false);
  svc.rotate("intensity", -30, false);
  assert.equal(svc.home("pan"), true);
  s = e.engine.slots(1);
  assert.equal(s[0], 0x80);
  assert.equal(s[5], Math.round(0.7 * 255), "intensity was not homed by the pan knob");
});

test("service: a colour with several cells — one knob moves every cell of it, pressing the knob homes them all", async () => {
  const { svc, show, e } = await makeService();
  await svc.setAddress(show.fixtures[4].key, { universe: 1, address: 20 });
  const map = svc.controllables()[0].map;
  assert.equal(map.attrs.red!.length, 5);
  assert.equal(map.attrs.green!.length, 5);
  assert.equal(map.attrs.blue!.length, 5);
  svc.onSelectionEvent([ID.cells]);
  assert.equal(svc.rotate("red-cyan", -40, false), true);
  const s = e.engine.slots(1);
  const reds = [1, 4, 7, 10, 13].map((o) => s[19 + o]);
  assert.deepEqual(reds, [153, 153, 153, 153, 153], "Red 1..5 moved as one");
  const greens = [2, 5, 8, 11, 14].map((o) => s[19 + o]);
  assert.deepEqual(greens, [255, 255, 255, 255, 255], "Green was not touched by the red knob");
  assert.equal(svc.home("red-cyan"), true);
  const h = e.engine.slots(1);
  assert.deepEqual([1, 4, 7, 10, 13].map((o) => h[19 + o]), [255, 255, 255, 255, 255], "pressing the knob homes every cell");
  assert.equal(svc.readout("red-cyan").value, 1);
});

test("service: Capture's patch changes (FixtureModify, bit 0x01) — stored 1-based, refused on overlap / range, Patched=0 clears, other bits ignored", async () => {
  let requests = 0;
  const { svc, show, setup, logs } = await makeService({ request: () => (requests++, true) });
  const k203 = show.fixtures[0].key;
  const k204 = show.fixtures[1].key;
  const mod = (identifier: number, universe: number, channel: number, patched = 1, changed = 0x01) => ({ identifier, changed, patched, universe, universeChannel: channel });
  await svc.onModify([mod(ID.rogue203, 0, 284)]);
  assert.deepEqual(setup.get("My Show", k203), { universe: 1, address: 285 }, "0-based on the wire, 1-based in the setup");
  assert.equal(logs.at(-1), "address from Capture Ch 203 -> 1/285");
  assert.equal(svc.controllables().length, 1, "it is controllable straight away");
  // 204 on top of 203's channels: refused
  await svc.onModify([mod(ID.rogue204, 0, 290)]);
  assert.equal(setup.get("My Show", k204), undefined);
  assert.match(logs.at(-1)!, /Ch 204 -> 1\/291 refused: overlaps/);
  // past 512
  await svc.onModify([mod(ID.rogue204, 0, 505)]);
  assert.equal(setup.get("My Show", k204), undefined);
  assert.match(logs.at(-1)!, /refused: .*past 512/);
  // fine: a free place, on another universe
  await svc.onModify([mod(ID.rogue204, 2, 0)]);
  assert.deepEqual(setup.get("My Show", k204), { universe: 3, address: 1 });
  // other changed bits (unit, circuit, note, position) do not touch the address
  await svc.onModify([{ ...mod(ID.rogue204, 5, 5), changed: 0x08 | 0x10 | 0x20 }]);
  assert.deepEqual(setup.get("My Show", k204), { universe: 3, address: 1 });
  // the same address again changes nothing
  const n = logs.length;
  await svc.onModify([mod(ID.rogue204, 2, 0)]);
  assert.equal(logs.length, n);
  // unpatched: the entry goes
  await svc.onModify([mod(ID.rogue203, 0, 0, 0)]);
  assert.equal(setup.get("My Show", k203), undefined);
  assert.match(logs.at(-1)!, /Ch 203 -> unpatched/);
  // an unidentified or unknown fixture cannot be mapped: a fresh list is asked for
  await svc.onModify([mod(UNIDENTIFIED, 0, 5)]);
  assert.equal(requests, 1);
  assert.match(logs.at(-1)!, /not in the list/);
});

test("service: Release stops output; moving the address of a fixture that is being driven releases it, an unrelated change does not", async () => {
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
  await svc.setAddress(show.fixtures[1].key, { universe: 1, address: 400 }); // another fixture: output carries on
  assert.equal(e.engine.active, true);
  await svc.setAddress(show.fixtures[0].key, { universe: 1, address: 290 }); // the live fixture moves: stop first
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.engine.active, false);
  assert.ok(e.tr.sent.some((x) => x.p.terminated));
});

test("service: LeaveShow / a different show clears the selection and releases output", async () => {
  const { svc, show, e } = await makeService();
  await svc.setAddress(show.fixtures[0].key, { universe: 1, address: 285 });
  svc.onSelectionEvent([ID.rogue203]);
  svc.rotate("pan", 1, false);
  assert.equal(e.engine.active, true);
  svc.onShowGone("Capture left the show");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.engine.active, false);
  assert.deepEqual(svc.selection.keys, []);
  assert.equal(show.setShowName("My Show"), false, "the same show again is not a change");
  assert.equal(show.setShowName("Other Show"), true);
  assert.equal(show.fixtures.length, 0, "a different show forgets the old fixtures");
});

test("service: nothing is sent just by reading the show, selecting, or pressing Home with nothing controllable", async () => {
  const { svc, e } = await makeService();
  svc.rotateSelect(1);
  svc.onSelectionEvent([ID.rogue203]);
  assert.equal(svc.homeSelected(), false);
  assert.equal(svc.rotate("pan", 1, false), false);
  assert.equal(e.tr.sent.length, 0);
  assert.equal(e.created(), 0);
});

test("showModel: not connected → status error with the reason; sync() asks for a list and waits for it; a library that cannot be opened makes no type controllable", async () => {
  let reconnects = 0;
  const m = new ShowModel({ reconnect: () => reconnects++, syncWaitMs: 30 });
  assert.equal(m.status, "idle");
  m.setConnected(false, "Capture not found");
  assert.deepEqual([m.status, m.error], ["error", "Capture not found"]);
  await m.sync();
  assert.equal(reconnects, 1, "re-reading while not connected skips the back-off");
  assert.equal(m.status, "error");
  m.setConnected(true);
  let asked = 0;
  const m2 = new ShowModel({ request: () => (asked++, true), syncWaitMs: 2000, open: () => { throw new Error("ENOENT"); }, libraryPath: "/x" });
  m2.setConnected(true);
  const p = m2.sync();
  assert.equal(asked, 1);
  assert.equal(m2.status, "syncing");
  m2.applyList(0, fixtureList());
  await p;
  assert.equal(m2.status, "ok");
  assert.ok([...m2.types.values()].every((t) => !t.ok && /cannot open the Capture library/.test(t.error!)));
});

// ------------------------------------------------------------------ identification and the CITP wire

const inst = (n: number): string => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
const cx = (n: number, identifier: number, guid: string | null = inst(n)): CaexFixture => ({
  index: n, identifier, manufacturer: "M", name: `F${n}`, mode: "S", channelCount: 4, isDimmer: 0,
  ids: guid ? [{ type: 4, name: "", size: 16, hex: "", guid: null, guidRaw: guid, value: null }] : [],
  patched: 0, universe: 0, universeChannel: 0, unit: "", channel: n, circuit: "", note: "", position: [0, 0, 0], angles: [0, 0, 0],
});

test("identify: only fixtures at 0xffffffff, Capture's own identifiers are kept, new numbers start at 100001 and skip numbers in use", () => {
  const p = new IdentifyPlanner(() => 0);
  const all = [cx(1, 7), cx(2, UNIDENTIFIED), cx(3, FIRST_IDENTIFIER), cx(4, UNIDENTIFIED), cx(5, UNIDENTIFIED, null)];
  const plan = p.plan(all);
  assert.deepEqual(plan.items.map((i) => [i.guidRaw, i.identifier]), [[inst(2), 100002], [inst(4), 100003]]);
  assert.deepEqual([plan.existing, plan.skipped, plan.total], [2, 1, 5], "two already identified, one without a CaptureInstanceId");
  assert.equal(plan.items[0].guid.toString("hex"), inst(2).replaceAll("-", ""), "the 16 bytes exactly as received");
  p.sent(plan.items);
  assert.deepEqual([...p.pendingIds()], [[100002, inst(2)], [100003, inst(4)]]);
});

test("identify: nothing to do when every fixture has an identifier; a fixture added later gets the next unused number; no re-identify", () => {
  let t = 0;
  const p = new IdentifyPlanner(() => t);
  const first = [cx(1, UNIDENTIFIED), cx(2, UNIDENTIFIED)];
  const plan1 = p.plan(first);
  assert.deepEqual(plan1.items.map((i) => i.identifier), [100001, 100002]);
  p.sent(plan1.items);
  // Capture confirms
  const after = [cx(1, 100001), cx(2, 100002)];
  const plan2 = p.plan(after);
  assert.equal(plan2.items.length, 0);
  assert.equal(plan2.confirmed, 2);
  assert.equal(p.pendingCount, 0);
  // a new fixture appears mid-session (a Type 1 list merged into the set)
  const plan3 = p.plan([...after, cx(3, UNIDENTIFIED)]);
  assert.deepEqual(plan3.items.map((i) => [i.guidRaw, i.identifier]), [[inst(3), 100003]]);
  assert.equal(plan3.existing, 2, "the two identified fixtures are not sent again");
  // unrelated numbers Capture already uses are skipped
  const p2 = new IdentifyPlanner(() => 0);
  assert.equal(p2.plan([cx(1, 100001), cx(2, 100002), cx(3, UNIDENTIFIED)]).items[0].identifier, 100003);
});

test("identify: a fixture we sent that still shows 0xffffffff is retried with the same number — not within 5 s, at most 3 times; a different number from Capture wins", () => {
  let t = 1000;
  const p = new IdentifyPlanner(() => t);
  const all = [cx(1, UNIDENTIFIED)];
  let plan = p.plan(all);
  p.sent(plan.items);
  assert.equal(p.plan(all).items.length, 0, "just sent: wait for the confirming list");
  for (let n = 2; n <= MAX_ATTEMPTS; n++) {
    t += RESEND_AFTER_MS + 1;
    plan = p.plan(all);
    assert.deepEqual(plan.items.map((i) => i.identifier), [100001], "same number again");
    p.sent(plan.items);
  }
  t += RESEND_AFTER_MS + 1;
  plan = p.plan(all);
  assert.equal(plan.items.length, 0, "attempts used up");
  assert.equal(plan.skipped, 1);
  p.reset();
  assert.equal(p.plan(all).items.length, 1, "a new connection starts again");
  const p3 = new IdentifyPlanner(() => 0);
  p3.sent(p3.plan([cx(1, UNIDENTIFIED)]).items);
  const r = p3.plan([cx(1, 555)]);
  assert.deepEqual([r.mismatched, r.confirmed, r.items.length], [1, 0, 0]);
});

test("allowlist: FixtureIdentify is allowed only when well-formed; every other forbidden message is still refused", () => {
  const ok = buildFixtureIdentify([{ guid: Buffer.alloc(16, 7), identifier: 100001 }]);
  assert.equal(isAllowedOutgoing(ok), true);
  assert.equal(isAllowedOutgoing(ok.subarray(0, ok.length - 1)), false, "truncated");
  const lying = Buffer.from(ok);
  lying.writeUInt16LE(2, 24);
  assert.equal(isAllowedOutgoing(lying), false, "count does not match the body");
  assert.throws(() => buildFixtureIdentify([]), /1\.\.65535/);
  assert.throws(() => buildFixtureIdentify([{ guid: Buffer.alloc(15), identifier: 1 }]), /16 bytes/);
  for (const m of [buildPNam("x"), buildLaserFeedList(1, []), buildEnterShow("x"), buildLeaveShow(), buildFixtureListRequest(), buildNack(3)]) assert.equal(isAllowedOutgoing(m), true);
  const caexMsg = (code: number): Buffer => {
    const b = Buffer.alloc(24);
    buildHeader(24, "CAEX").copy(b);
    b.writeUInt32LE(code, 20);
    return b;
  };
  for (const code of [CAEX.FixtureList, CAEX.FixtureModify, CAEX.FixtureRemove, CAEX.FixtureSelection, 0x00020301 /* FixtureConsoleStatus */, 0x00020400 /* SetFixtureTransformationSpace */]) assert.equal(isAllowedOutgoing(caexMsg(code)), false, `0x${code.toString(16)}`);
});

test("wire: FixtureSelection, FixtureRemove and FixtureModify decode per spec F (all fields present, bits say which changed)", () => {
  assert.deepEqual(decodeMessage(buildSelectionMessage([5, 100001, 0xffffffff])).selection, [5, 100001, 0xffffffff]);
  assert.deepEqual(decodeMessage(buildSelectionMessage([])).selection, []);
  const msg = buildModifyMessage([
    { identifier: 100001, changed: 0x01, patched: 1, universe: 0, universeChannel: 284, unit: "u", channel: 203, circuit: "c", note: "n" },
    { identifier: 7, changed: 0x1e, patched: 0, universe: 3, universeChannel: 511 },
  ]);
  const r = decodeFixtureModify(msg);
  assert.equal(r.error, null);
  assert.equal(r.items.length, 2);
  assert.deepEqual([r.items[0].identifier, r.items[0].changed, r.items[0].patched, r.items[0].universe, r.items[0].universeChannel, r.items[0].unit, r.items[0].channel, r.items[0].circuit, r.items[0].note], [100001, 1, 1, 0, 284, "u", 203, "c", "n"]);
  assert.deepEqual([r.items[1].changed, r.items[1].patched, r.items[1].universe, r.items[1].universeChannel], [0x1e, 0, 3, 511]);
  assert.deepEqual(decodeMessage(msg).modify!.items.map((i) => i.identifier), [100001, 7]);
  // cut off inside the second entry: the first is complete, the second keeps its patch fields, and the error says so
  const cut = decodeFixtureModify(msg.subarray(0, msg.length - 30));
  assert.ok(cut.error);
  assert.equal(cut.items[0].channel, 203);
  assert.equal(cut.items[1].universeChannel, 511);
});

test("toTarget carries the 1-based address", () => {
  const c = ctl(1, "A", "T", 3, 17);
  assert.deepEqual({ ...toTarget(c), map: undefined, model: undefined }, { key: "k1", universe: 3, address: 17, map: undefined, model: undefined });
  assert.equal(toTarget(c).model, c.model);
});

test("attrs: all coarse channels with the same base name and a cell number belong to that colour", () => {
  const m = mapOf(cellHead() as ReturnType<typeof movingHead>);
  assert.deepEqual([m.attrs.red!.length, m.attrs.green!.length, m.attrs.blue!.length], [5, 5, 5]);
  assert.deepEqual(m.attrs.red!.map((s) => s.coarse.name), ["Red 1", "Red 2", "Red 3", "Red 4", "Red 5"]);
  assert.equal(m.attrs.intensity!.length, 1);
});
