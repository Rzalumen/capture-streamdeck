// Handoff 28 (v0.10.0) unit tests: addresses from Capture's patch (FixtureLists after our SDMX declaration), the fallback to typed
// addresses, overlaps from Capture's patch, undeclared universes / past 512, FixtureModify while Capture's patch is the source.
import assert from "node:assert/strict";
import test from "node:test";
import { drivenSignature } from "../src/fixtures/attrs.ts";
import type { CaexFixture } from "../src/fixtures/citp.ts";
import { DmxEngine } from "../src/fixtures/engine.ts";
import { loadChannels } from "../src/fixtures/modes.ts";
import { PATCH_READ_ONLY, FixtureService } from "../src/fixtures/service.ts";
import { SetupStore, checkSetup, sharedNotes, type SetupEntry } from "../src/fixtures/setup.ts";
import { ShowModel } from "../src/fixtures/show.ts";
import { GlobalSettings } from "../src/lib/globals.ts";
import { buildModeBlock, buildObject, movingHead } from "./fixtures/synth.ts";

const FX = "aaaaaaaa-0000-0000-0000-0000000000e9";
const MD = "bbbbbbbb-0000-0000-0000-0000000000e9";
const memGlobals = () => {
  const state = { obj: {} as Record<string, unknown> };
  return { g: new GlobalSettings({ get: async () => JSON.parse(JSON.stringify(state.obj)), set: async (o) => void (state.obj = JSON.parse(JSON.stringify(o))) }), state };
};
const inst = (i: number) => `00000000-0000-0000-0000-0000000009${String(i).padStart(2, "0")}`;
/** A CAEX fixture as Capture sends it; `patch` = [universe 1-based, address 1-based] or undefined (Patched=0). */
const fx = (i: number, channel: number, patch?: [number, number], channelCount = 14): CaexFixture => ({
  index: i, identifier: 900 + i, manufacturer: "M", name: `Wash`, mode: "Std", channelCount, isDimmer: 0,
  ids: [{ type: 2, name: "", size: 16, hex: "", guid: null, guidRaw: FX, value: null }, { type: 3, name: "", size: 16, hex: "", guid: null, guidRaw: MD, value: null }, { type: 4, name: "", size: 16, hex: "", guid: null, guidRaw: inst(i), value: null }],
  patched: patch ? 1 : 0, universe: patch ? patch[0] - 1 : 0, universeChannel: patch ? patch[1] - 1 : 0,
  unit: "", channel, circuit: "", note: "", position: [0, 0, 0], angles: [0, 0, 0],
});

async function rig() {
  const objects: Record<string, Buffer> = { [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) };
  const show = new ShowModel({ libraryPath: "/x", open: () => ({ libPath: "x", readObjectByGuid: (g: string) => objects[g], close: () => undefined }) as never });
  const logs: string[] = [];
  const engine = new DmxEngine({ transport: () => ({ send: () => undefined, close: async () => undefined }), setInterval: () => "H", clearInterval: () => undefined });
  const { g, state } = memGlobals();
  const setup = new SetupStore(g);
  const svc = new FixtureService(show, setup, engine, (l) => logs.push(l));
  show.setConnected(true);
  show.setShowName("S");
  /** A FixtureList as the link hands it over: applied to the show model, then to the service. */
  const list = async (fixtures: CaexFixture[], declared = true, type = 0) => svc.onPatchList(type, show.applyList(type, fixtures), declared);
  return { show, svc, engine, setup, logs, state, list };
}
const ctl = (svc: FixtureService) => svc.controllables().map((c) => `Ch ${c.fixture.channel} ${c.addr.universe}/${c.addr.address}`);
const ch = (show: ShowModel, n: number) => show.fixtures.find((f) => f.channel === n)!;

test("a declared list with Patched=1: addresses from Capture (typed entries replaced and logged), Patched=0 not controllable, Setup read-only", async () => {
  const R = await rig();
  // first the list arrives without the patch (undeclared, or Capture still at Patched=0), and the user types addresses
  await R.list([fx(1, 202), fx(2, 203), fx(3, 204)], false);
  await R.svc.setAddress(ch(R.show, 202).key, { universe: 2, address: 1 });
  await R.svc.setAddress(ch(R.show, 204).key, { universe: 1, address: 100 });
  assert.deepEqual(ctl(R.svc), ["Ch 202 2/1", "Ch 204 1/100"]);
  assert.equal(R.svc.patchActive(), false);
  // the declared list carries Capture's patch: 202 at 1/444, 203 at 1/285, 204 not patched
  await R.list([fx(1, 202, [1, 444]), fx(2, 203, [1, 285]), fx(3, 204)]);
  assert.equal(R.svc.patchActive(), true);
  assert.deepEqual(ctl(R.svc), ["Ch 202 1/444", "Ch 203 1/285"], "Capture's addresses; 204 (Patched=0) is not controllable");
  assert.ok(R.logs.includes("Capture's patch: 2 of 3 fixture(s) patched"), R.logs.join("\n"));
  assert.ok(R.logs.includes("address from Capture's patch Ch 202 Wash -> 1/444 (was 2/1, typed)"));
  assert.ok(R.logs.includes("address from Capture's patch Ch 203 Wash -> 1/285 (was none)"));
  assert.ok(R.logs.includes("address from Capture's patch Ch 204 Wash -> none (not patched in Capture; was 1/100, typed)"));
  // stored as Capture's (replaces the typed entries in the global settings)
  const stored = (R.state.obj.fixtureSetup as any).S;
  assert.deepEqual(stored[ch(R.show, 202).key], { universe: 1, address: 444, src: "capture" });
  assert.equal(stored[ch(R.show, 204).key], undefined);
  // the same list again: nothing new is logged
  const n = R.logs.length;
  await R.list([fx(1, 202, [1, 444]), fx(2, 203, [1, 285]), fx(3, 204)]);
  assert.deepEqual(R.logs.slice(n), []);
  // Setup is read-only now
  assert.equal(await R.svc.setAddress(ch(R.show, 204).key, { universe: 1, address: 1 }), PATCH_READ_ONLY);
  assert.equal(await R.svc.setAddress(ch(R.show, 202).key, null), PATCH_READ_ONLY);
  assert.equal(await R.svc.autoFill([ch(R.show, 204).key], { universe: 1, address: 1 }), PATCH_READ_ONLY);
  const v = R.svc.setupView();
  assert.deepEqual(v.patch, { patched: 2, total: 3 });
  assert.equal(v.fixtures.find((f) => f.channel === 202)!.fromCapture, true);
  assert.equal(v.fixtures.find((f) => f.channel === 204)!.addr, null);
  // a different show: Capture's patch belongs to the show
  R.svc.onShowGone("a different show");
  assert.equal(R.svc.patchActive(), false);
});

test("fallback: lists before the declaration are ignored; a declared list with no Patched=1 keeps the typed entries (logged once); the overlap refusal applies to typed entries", async () => {
  const R = await rig();
  await R.list([fx(1, 202, [1, 444]), fx(2, 203)], false); // not declared: even a Patched=1 is not used
  assert.equal(R.svc.patchActive(), false);
  assert.deepEqual(ctl(R.svc), []);
  await R.svc.setAddress(ch(R.show, 202).key, { universe: 1, address: 1 });
  await R.svc.setAddress(ch(R.show, 203).key, { universe: 1, address: 5 }); // overlaps 202 (1-14)
  await R.list([fx(1, 202), fx(2, 203)]);
  await R.list([fx(1, 202), fx(2, 203)]);
  assert.equal(R.logs.filter((l) => /Capture's patch was not available/.test(l)).length, 1, "logged once");
  assert.equal(R.svc.patchActive(), false);
  assert.deepEqual(ctl(R.svc), [], "typed overlap: both refused, as before");
  const v = R.svc.setupView();
  assert.equal(v.patch, null);
  assert.match(v.fixtures.find((f) => f.channel === 203)!.issues.join(" "), /overlaps Wash Ch 202/);
  await R.svc.setAddress(ch(R.show, 203).key, { universe: 1, address: 100 });
  assert.deepEqual(ctl(R.svc), ["Ch 202 1/1", "Ch 203 1/100"], "typed entries work as before");
});

test("overlap from Capture's patch: both fixtures stay controllable; v0.12.0: both Setup rows say '⚠ patch conflict … fix in Capture', logged once per pair as a patch conflict; a knob on either drives the shared slots", async () => {
  const R = await rig();
  await R.list([fx(1, 203, [1, 285]), fx(2, 205, [1, 285]), fx(3, 204, [1, 229])]);
  assert.deepEqual(ctl(R.svc), ["Ch 203 1/285", "Ch 204 1/229", "Ch 205 1/285"]);
  const v = R.svc.setupView();
  assert.deepEqual(v.fixtures.find((f) => f.channel === 203)!.shared, ["⚠ patch conflict with Ch 205 at 1/285 — fix in Capture"]);
  assert.deepEqual(v.fixtures.find((f) => f.channel === 205)!.shared, ["⚠ patch conflict with Ch 203 at 1/285 — fix in Capture"]);
  assert.deepEqual(v.fixtures.find((f) => f.channel === 204)!.shared, []);
  assert.deepEqual(v.fixtures.find((f) => f.channel === 203)!.issues, []);
  assert.equal(R.logs.filter((l) => /patch conflict in Capture/.test(l)).length, 1);
  assert.ok(R.logs.includes("patch conflict in Capture: Ch 203 and Ch 205 both at 1/285 (fix the patch in Capture)") || R.logs.includes("patch conflict in Capture: Ch 205 and Ch 203 both at 1/285 (fix the patch in Capture)"), R.logs.join("\n"));
  assert.ok(!R.logs.some((l) => /share 1\/285/.test(l)), "the old wording is gone");
  await R.list([fx(1, 203, [1, 285]), fx(2, 205, [1, 285]), fx(3, 204, [1, 229])]);
  assert.equal(R.logs.filter((l) => /patch conflict in Capture/.test(l)).length, 1, "not again (once per pair)");
  // a knob on 203, then on 205: the shared slots carry the last move
  R.svc.onSelectionEvent([901]);
  R.svc.attrRotate(0, 10, false); // 203 pan 60 %
  let s = R.engine.slots(1);
  assert.equal((s[284] << 8) | s[285], Math.round(0.6 * 65535));
  R.svc.onSelectionEvent([902]);
  R.svc.attrRotate(0, -10, false); // 205 pan 40 %
  s = R.engine.slots(1);
  assert.equal((s[284] << 8) | s[285], Math.round(0.4 * 65535), "205 drives the same slots");
  // the pure functions: a typed + a Capture entry overlapping is still refused
  const e = (key: string, address: number, capture: boolean): SetupEntry => ({ key, label: key, short: key, channelCount: 14, addr: { universe: 1, address, ...(capture ? { src: "capture" as const } : {}) } });
  assert.equal(checkSetup([e("a", 1, true), e("b", 1, true)]).size, 0);
  assert.equal(checkSetup([e("a", 1, true), e("b", 1, false)]).size, 2);
  assert.equal(checkSetup([e("a", 1, false), e("b", 1, false)]).size, 2);
  assert.equal(sharedNotes([e("a", 1, true), e("b", 1, false)]).size, 0);
});

test("Capture's patch on universe 17 or past 512: not controllable, logged, shown in Setup", async () => {
  const R = await rig();
  await R.list([fx(1, 207, [17, 1]), fx(2, 208, [1, 500]), fx(3, 209, [16, 499])]);
  assert.deepEqual(ctl(R.svc), ["Ch 209 16/499"]);
  assert.ok(R.logs.includes("address from Capture's patch Ch 207 Wash 17/1: universe not declared (1-16) — not controllable"), R.logs.join("\n"));
  assert.ok(R.logs.some((l) => /^address from Capture's patch Ch 208 Wash 1\/500: 14 channels starting at 500 would end at 513, past 512 — not controllable$/.test(l)));
  const v = R.svc.setupView();
  assert.deepEqual(v.fixtures.find((f) => f.channel === 207)!.issues, ["Capture's patch: 17/1: universe not declared (1-16)"]);
  assert.equal(v.fixtures.find((f) => f.channel === 207)!.controllable, false);
  const n = R.logs.length;
  await R.list([fx(1, 207, [17, 1]), fx(2, 208, [1, 500]), fx(3, 209, [16, 499])]);
  assert.deepEqual(R.logs.slice(n), [], "not logged again");
});

test("FixtureModify while Capture's patch is the source: a re-patch updates the address (a driven fixture is released first, the next frames use the new address); an unpatch clears; Type 1 lists update too", async () => {
  const R = await rig();
  await R.list([fx(1, 202, [1, 444]), fx(2, 203, [1, 285])]);
  R.svc.onSelectionEvent([901]);
  R.svc.attrRotate(0, 10, false);
  assert.equal(R.engine.active, true);
  assert.deepEqual(R.engine.touchedAddresses().get(ch(R.show, 202).key), { universe: 1, address: 444 });
  // re-patch 202 to 1/100 in Capture
  await R.svc.onModify([{ identifier: 901, changed: 0x01, patched: 1, universe: 0, universeChannel: 99 }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(R.logs.includes("address from Capture's patch Ch 202 Wash -> 1/100 (was 1/444, from Capture)"));
  assert.ok(R.logs.includes("the address of a fixture that is being driven changed: releasing output"), "released first");
  assert.equal(R.engine.active, false);
  R.svc.onSelectionEvent([901]);
  R.svc.attrRotate(0, 5, false);
  assert.deepEqual(R.engine.touchedAddresses().get(ch(R.show, 202).key), { universe: 1, address: 100 }, "the next frames use the new address");
  const s = R.engine.slots(1);
  const old = s[443];
  assert.notEqual((s[99] << 8) | s[100], 0, "pan at 1/100");
  R.svc.attrRotate(0, 10, false);
  const s2 = R.engine.slots(1);
  assert.notEqual((s2[99] << 8) | s2[100], (s[99] << 8) | s[100], "the knob moves the new address");
  assert.equal(s2[443], old, "the old 1/444 is no longer driven (it keeps the last level sent there, which Capture holds)");
  // an overlap made by a re-patch is accepted (Capture's patch)
  await R.svc.onModify([{ identifier: 902, changed: 0x01, patched: 1, universe: 0, universeChannel: 99 }]);
  assert.deepEqual(ctl(R.svc), ["Ch 202 1/100", "Ch 203 1/100"]);
  // unpatch 203
  await R.svc.onModify([{ identifier: 902, changed: 0x01, patched: 0, universe: 0, universeChannel: 0 }]);
  assert.ok(R.logs.includes("address from Capture's patch Ch 203 Wash -> none (not patched in Capture; was 1/100, from Capture)"));
  assert.deepEqual(ctl(R.svc), ["Ch 202 1/100"]);
  // a Type 1 list (new fixture) with its patch
  await R.list([fx(3, 204, [2, 1])], true, 1);
  assert.deepEqual(ctl(R.svc), ["Ch 202 1/100", "Ch 204 2/1"]);
  // a modify without the patch bit changes nothing
  const n = R.logs.length;
  await R.svc.onModify([{ identifier: 901, changed: 0x02, patched: 1, universe: 3, universeChannel: 3 }]);
  assert.deepEqual(R.logs.slice(n), []);
});
