// Handoff 31 (v0.12.0) unit tests: per-fixture Pan / Tilt invert (the knob direction only), stored per show and per fixture key.
import assert from "node:assert/strict";
import test from "node:test";
import { drivenSignature } from "../src/fixtures/attrs.ts";
import type { CaexFixture } from "../src/fixtures/citp.ts";
import { DmxEngine } from "../src/fixtures/engine.ts";
import { loadChannels } from "../src/fixtures/modes.ts";
import { buildModel } from "../src/fixtures/pages.ts";
import { FixtureService, PATCH_READ_ONLY, axisOf, axisParams } from "../src/fixtures/service.ts";
import { runSetupCommand } from "../src/fixtures/setupCommands.ts";
import { INVERT_KEY, SetupStore } from "../src/fixtures/setup.ts";
import { ShowModel } from "../src/fixtures/show.ts";
import { GlobalSettings } from "../src/lib/globals.ts";
import { stripLabel } from "../src/lib/render.ts";
import { buildModeBlock, buildObject, conventional, movingHead, solaFrame750, type SynthChannel } from "./fixtures/synth.ts";

const FX = "aaaaaaaa-0000-0000-0000-0000000000f1";
const MD = "bbbbbbbb-0000-0000-0000-0000000000f1";
const FXC = "aaaaaaaa-0000-0000-0000-0000000000f2";
const MDC = "bbbbbbbb-0000-0000-0000-0000000000f2";
const memGlobals = () => {
  const state = { obj: {} as Record<string, unknown> };
  return { g: new GlobalSettings({ get: async () => JSON.parse(JSON.stringify(state.obj)), set: async (o) => void (state.obj = JSON.parse(JSON.stringify(o))) }), state };
};
const inst = (i: number) => `00000000-0000-0000-0000-0000000008${String(i).padStart(2, "0")}`;
const fx = (i: number, channel: number, patch?: [number, number], conv = false): CaexFixture => ({
  index: i, identifier: 800 + i, manufacturer: "M", name: conv ? "Par" : "Wash", mode: "Std", channelCount: conv ? 1 : 14, isDimmer: 0,
  ids: [{ type: 2, name: "", size: 16, hex: "", guid: null, guidRaw: conv ? FXC : FX, value: null }, { type: 3, name: "", size: 16, hex: "", guid: null, guidRaw: conv ? MDC : MD, value: null }, { type: 4, name: "", size: 16, hex: "", guid: null, guidRaw: inst(i), value: null }],
  patched: patch ? 1 : 0, universe: patch ? patch[0] - 1 : 0, universeChannel: patch ? patch[1] - 1 : 0,
  unit: "", channel, circuit: "", note: "", position: [0, 0, 0], angles: [0, 0, 0],
});

async function rig(globals = memGlobals()) {
  const objects: Record<string, Buffer> = { [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })), [FXC]: buildObject(buildModeBlock({ guid: MDC, channels: conventional() })) };
  const show = new ShowModel({ libraryPath: "/x", open: () => ({ libPath: "x", readObjectByGuid: (g: string) => objects[g], close: () => undefined }) as never });
  const logs: string[] = [];
  const engine = new DmxEngine({ transport: () => ({ send: () => undefined, close: async () => undefined }), setInterval: () => "H", clearInterval: () => undefined });
  const setup = new SetupStore(globals.g);
  await setup.load();
  const svc = new FixtureService(show, setup, engine, (l) => logs.push(l));
  show.setConnected(true);
  show.setShowName("S");
  const list = async (fixtures: CaexFixture[], declared = true, type = 0) => svc.onPatchList(type, show.applyList(type, fixtures), declared);
  return { show, svc, engine, setup, logs, globals, list };
}
const LIST = [fx(1, 201, [1, 1]), fx(2, 202, [1, 100]), fx(3, 209, [1, 400], true)];
const key = (show: ShowModel, ch: number) => show.fixtures.find((f) => f.channel === ch)!.key;
const pan = (s: Uint8Array, base: number) => (s[base - 1] << 8) | s[base];
const tilt = (s: Uint8Array, base: number) => (s[base + 1] << 8) | s[base + 2];
const P16 = (v: number) => Math.round(v * 65535);

test("axes: the Main page's Pan and Tilt (coarse/fine pair = one parameter); a second pan or Pan/Tilt Speed is not an axis; a conventional has none", () => {
  const ch = (list: SynthChannel[], g: string) => {
    const l = loadChannels(buildObject(buildModeBlock({ guid: g, channels: list })), g, list.length, drivenSignature);
    assert.ok(l.ok, l.error);
    return buildModel(l.channels);
  };
  const m = ch(movingHead(), MD);
  const a = axisParams(m);
  assert.deepEqual([a.pan?.name, a.pan?.sixteen, a.tilt?.name, a.tilt?.sixteen], ["Pan", true, "Tilt", true]);
  assert.equal(axisOf(m, m.byName.get("pan/tilt speed")!), null);
  assert.equal(axisOf(m, m.byName.get("pan")!), "pan");
  assert.equal(axisOf(m, m.byName.get("tilt")!), "tilt");
  const two = ch([{ name: "Pan", role: 1, pair: 1 }, { name: "Pan Fine", role: 2, pair: 0 }, { name: "Pan 2" }, { name: "Dimmer" }], MD);
  assert.equal(axisParams(two).tilt, null, "no tilt: one axis only");
  assert.equal(axisOf(two, two.byName.get("pan 2")!), null, "a second pan (page Other) is not the axis");
  assert.deepEqual(axisParams(ch(conventional(), MDC)), { pan: null, tilt: null });
  const sf = ch(solaFrame750(), MD);
  assert.deepEqual([axisParams(sf).pan?.name, axisParams(sf).tilt?.name], ["Pan", "Tilt"]);
});

test("invert Pan on A: a +3 turn lowers A's Pan by what it raises B's — coarse and fine, the 16-bit pair as a whole; the DMX and the stored/shown value are the true value; Tilt untouched; home unchanged", async () => {
  const R = await rig();
  await R.list(LIST);
  const A = key(R.show, 201);
  R.svc.onSelectionEvent([801, 802]); // A and B
  R.svc.attrRotate(0, 10, false); // both 60 % before the invert (so a value-inversion would show)
  assert.equal(await R.svc.setInvert(A, "pan", true), null);
  assert.deepEqual(R.logs.filter((l) => /: Pan /.test(l)), ["Ch 201 Wash: Pan inverted"]);
  R.svc.attrRotate(0, 3, false);
  let s = R.engine.slots(1);
  assert.equal(pan(s, 1), P16(0.57), "A: 60 % − 3 %");
  assert.equal(pan(s, 100), P16(0.63), "B: 60 % + 3 %");
  // fine mode (0.1 %): the same, on the 16-bit pair
  R.svc.attrRotate(0, 3, true);
  s = R.engine.slots(1);
  assert.equal(pan(s, 1), P16(0.567));
  assert.equal(pan(s, 100), P16(0.633));
  // the strip: A first → its true value and "Pan ⇄"; B first → no mark
  const r = R.svc.attrReadout(0);
  assert.deepEqual([r.label, r.inverted, r.value], ["Pan", true, 0.567]);
  assert.equal(stripLabel(r.label, r.inverted), "Pan ⇄");
  // Tilt is not inverted
  R.svc.attrRotate(1, 4, false);
  s = R.engine.slots(1);
  assert.equal(tilt(s, 1), P16(0.54));
  assert.equal(tilt(s, 100), P16(0.54));
  assert.equal(R.svc.attrReadout(1).inverted, false);
  // the fixed (hand-placed) Pan dial follows the same rule
  R.svc.rotate("pan", 2, false);
  s = R.engine.slots(1);
  assert.equal(pan(s, 1), P16(0.547));
  assert.equal(pan(s, 100), P16(0.653));
  assert.equal(R.svc.readout("pan").inverted, true);
  // home (strip tap) is unchanged by the invert
  R.svc.attrHome(0);
  s = R.engine.slots(1);
  assert.equal(pan(s, 1), 0x8000);
  assert.equal(pan(s, 100), 0x8000);
  // ChBk on A's pan: Capture's true value, not inverted
  R.svc.onCaptureLevels({ blind: 0, universeIndex: 0, firstChannel: 0, levels: [0x40, 0x00] } as never);
  assert.equal(R.svc.attrReadout(0).value, 0x4000 / 65535, "Capture's true value");
  assert.equal(pan(R.engine.slots(1), 1), 0x4000, "sent as Capture sent it");
  R.svc.attrRotate(0, 1, false);
  assert.equal(pan(R.engine.slots(1), 1), P16(0.24), "the next turn continues from Capture's value (25.0 %), inverted: 24.0 %");
  // B selected first: no mark
  R.svc.onSelectionEvent([802, 801]);
  assert.equal(R.svc.attrReadout(0).inverted, false);
  // normal again
  assert.equal(await runSetupCommand(R.svc, { cmd: "invert", key: A, axis: "pan", on: false }), null);
  assert.equal(R.logs.at(-1), "Ch 201 Wash: Pan normal");
  const before = pan(R.engine.slots(1), 1);
  R.svc.attrRotate(0, 1, false);
  assert.equal(pan(R.engine.slots(1), 1) > before, true, "A moves up again");
});

test("stripLabel: ' ⇄' after an inverted name within 15 characters; unchanged otherwise", () => {
  assert.equal(stripLabel("Pan"), "Pan");
  assert.equal(stripLabel("Pan", true), "Pan ⇄");
  assert.equal(stripLabel("Tilt", true), "Tilt ⇄");
  assert.equal(stripLabel("A very long channel name"), "A very long ch…", "as before v0.12.0");
  assert.equal(stripLabel("A very long channel name", true), "A very long … ⇄");
  assert.equal(stripLabel("A very long channel name", true).length, 15, "the same 15 characters");
  assert.equal(stripLabel("Pan Rotation 1", true), "Pan Rotation… ⇄");
});

test("invert is stored per show and per fixture KEY: kept through a re-patch (FixtureModify), a plugin restart and a show reload; another show does not inherit it", async () => {
  const globals = memGlobals();
  const R = await rig(globals);
  await R.list(LIST);
  const A = key(R.show, 201);
  await R.svc.setInvert(A, "pan", true);
  await R.svc.setInvert(A, "tilt", true);
  await R.svc.setInvert(A, "tilt", false);
  assert.deepEqual(globals.state.obj[INVERT_KEY], { S: { [A]: { invertPan: true } } }, "only true flags, by key");
  // re-patch in Capture: A moves to 2/1
  await R.svc.onModify([{ identifier: 801, changed: 0x01, patched: 1, universe: 1, universeChannel: 0 }]);
  assert.deepEqual(R.setup.get("S", A), { universe: 2, address: 1, src: "capture" });
  assert.equal(R.setup.invert("S", A).invertPan, true, "kept after the re-patch");
  R.svc.onSelectionEvent([801]);
  R.svc.attrRotate(0, 5, false);
  assert.equal(pan(R.engine.slots(2), 1), P16(0.45), "still inverted at the new address");
  // plugin restart: a new store loads it
  const R2 = await rig(globals);
  await R2.list(LIST);
  assert.equal(R2.setup.invert("S", A).invertPan, true, "loaded after a restart");
  assert.equal(R2.svc.setupView().fixtures.find((f) => f.channel === 201)!.invertPan, true);
  // show reload (LeaveShow + EnterShow of the same show)
  R2.svc.onShowGone("Capture left the show");
  R2.show.clear();
  R2.show.setShowName("S");
  await R2.list(LIST);
  assert.equal(R2.svc.setupView().fixtures.find((f) => f.channel === 201)!.invertPan, true, "kept after a show reload");
  // another show with the same fixtures: not inherited
  R2.show.setShowName("OTHER");
  R2.svc.onShowGone("a different show");
  await R2.list(LIST);
  assert.equal(R2.svc.setupView().fixtures.find((f) => f.channel === 201)!.invertPan, false, "per show");
  R2.svc.onSelectionEvent([801]);
  R2.svc.attrRotate(0, 5, false);
  assert.equal(pan(R2.engine.slots(1), 1), P16(0.55), "not inverted in the other show");
});

test("Setup: toggles only for the axes a type has; editable while Capture's patch is the source (addresses read-only); bad commands refused; malformed stored flags ignored", async () => {
  const globals = memGlobals();
  globals.state.obj[INVERT_KEY] = { S: { [inst(2)]: { invertPan: "yes", invertTilt: true }, [inst(3)]: 7 } };
  const R = await rig(globals);
  await R.list(LIST);
  assert.equal(R.svc.patchActive(), true);
  const v = R.svc.setupView();
  const row = (c: number) => v.fixtures.find((f) => f.channel === c)!;
  assert.deepEqual([row(201).axes, row(201).invertPan, row(201).invertTilt], [["pan", "tilt"], false, false]);
  assert.deepEqual([row(202).invertPan, row(202).invertTilt], [false, true], "only a boolean true counts");
  assert.deepEqual(row(209).axes, [], "a conventional: no toggles");
  assert.equal(await R.svc.setAddress(key(R.show, 201), { universe: 3, address: 1 }), PATCH_READ_ONLY, "addresses read-only");
  assert.equal(await runSetupCommand(R.svc, { cmd: "invert", key: key(R.show, 201), axis: "tilt", on: true }), null, "the invert is editable in patch mode");
  assert.equal(R.svc.setupView().fixtures.find((f) => f.channel === 201)!.invertTilt, true);
  assert.equal(R.logs.at(-1), "Ch 201 Wash: Tilt inverted");
  assert.match((await R.svc.setInvert(key(R.show, 209), "pan", true))!, /no Pan channel/);
  assert.match((await R.svc.setInvert("nope", "pan", true))!, /unknown fixture/);
  assert.match((await R.svc.setInvert(key(R.show, 201), "zoom" as never, true))!, /pan or tilt/);
});
