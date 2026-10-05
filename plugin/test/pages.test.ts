// Handoff 20/21 unit tests: attribute pages from a fixture's channel names (Main page: Handoff 21), generic Attribute dials, page keys,
// home values, Setup channel list.
import assert from "node:assert/strict";
import test from "node:test";
import { defaultValues, drivenSignature, mapChannels, renderFixture } from "../src/fixtures/attrs.ts";
import { DmxEngine, renderModel, type Transport } from "../src/fixtures/engine.ts";
import { loadChannels, type Channel } from "../src/fixtures/modes.ts";
import { buildModel, homeFor, isHiddenName, kindOf, pageTitle, PER_PAGE, type FixtureModel, type Param } from "../src/fixtures/pages.ts";
import { channelList, FixtureService } from "../src/fixtures/service.ts";
import { SetupStore } from "../src/fixtures/setup.ts";
import { ShowModel } from "../src/fixtures/show.ts";
import type { CaexFixture } from "../src/fixtures/citp.ts";
import { GlobalSettings } from "../src/lib/globals.ts";
import { buildModeBlock, buildObject, cmyHead, conventional, framingHead, movingHead, solaFrame750, SOLAFRAME_750_FINE, SOLAFRAME_750_PATCH_VIEW, type SynthChannel } from "./fixtures/synth.ts";

const MD = "bbbbbbbb-0000-0000-0000-0000000000f1";
const channelsOf = (list: SynthChannel[]): Channel[] => {
  const l = loadChannels(buildObject(buildModeBlock({ guid: MD, channels: list })), MD, list.length, drivenSignature);
  assert.ok(l.ok, l.error);
  return l.channels;
};
const cellHead = (): SynthChannel[] => [{ name: "Dimmer" }, ...[1, 2, 3, 4, 5].flatMap((n) => [{ name: `Red ${n}` }, { name: `Green ${n}` }, { name: `Blue ${n}` }])];
const titles = (m: FixtureModel): string[] => m.pages.map(pageTitle);
const names = (m: FixtureModel): string[][] => m.pages.map((p) => p.params.map((x) => x?.name ?? "—"));

/** Every coarse or 8-bit channel is written by exactly one parameter on exactly one page; every fine channel only as the partner of its coarse one. */
function assertComplete(ch: Channel[], m: FixtureModel): void {
  const onPages = m.pages.flatMap((p) => p.params).filter((p): p is Param => !!p);
  assert.equal(new Set(onPages).size, onPages.length, "a parameter is on one page only");
  assert.equal(onPages.length, m.params.length, "every parameter is on a page");
  const writes = new Map<number, number>();
  for (const p of onPages) for (const s of p.slots) {
    writes.set(s.coarse.offset, (writes.get(s.coarse.offset) ?? 0) + 1);
    if (s.fine) {
      assert.equal(s.fine.role, 2, `${s.fine.name} is a fine channel`);
      assert.equal(s.fine.pair, s.coarse.offset, `${s.fine.name} pairs with ${s.coarse.name}`);
      writes.set(s.fine.offset, (writes.get(s.fine.offset) ?? 0) + 1);
    }
  }
  for (const c of ch) assert.equal(writes.get(c.offset), m.hidden.includes(c.offset) || m.excluded.includes(c.offset) ? undefined : 1, `channel ${c.offset + 1} "${c.name}" written ${m.hidden.includes(c.offset) ? "never (hidden)" : "exactly once"}`);
  for (const p of onPages) for (const s of p.slots) assert.notEqual(s.coarse.role, 2, `fine channel ${s.coarse.name} is never a knob of its own`);
  for (const pg of m.pages) assert.ok(pg.params.length >= 1 && pg.params.length <= PER_PAGE);
  if (m.pages[0]?.group === "main") assert.equal(m.pages[0].params.length, 4, "Main keeps its four positions");
}

// ------------------------------------------------------------------ grouping

test("kinds: whole-word name rules, in order; speed/mode names go to Other; framing shutters are not shutter/strobe; function/control/auto are hidden", () => {
  const cases: [string, string][] = [
    ["Pan", "pan"], ["TILT", "tilt"], ["PanFine", "pan"], ["Pan/Tilt Speed", "other"], ["Tilt Time", "other"], ["Pan Mode", "other"],
    ["Dimmer", "dimmer"], ["Intensity", "dimmer"], ["Dimmer2", "dimmer"], ["Dim Coarse", "dimmer"], ["Dimmer Curve", "other"], ["Dimmers", "other"],
    ["Shutter", "strobe"], ["Shutter/Strobe", "strobe"], ["Shutter/LED", "strobe"], ["Strobe", "strobe"], ["Red Strobe", "strobe"], ["Strobe Rate", "other"], ["Shutter Mode", "other"],
    ["Red 3", "colour"], ["Warm White", "colour"], ["UV", "colour"], ["CTO", "colour"], ["CTB", "colour"], ["Colour Wheel", "colour"], ["Color Wheel 2", "colour"], ["Green Correction", "colour"],
    ["Zoom", "zoom"], ["Zoom Coarse", "zoom"], ["Focus", "beam"], ["Iris", "beam"], ["Frost 2", "beam"], ["Frost2", "beam"], ["Diffusion", "beam"], ["Edge", "beam"],
    ["Shutter 1A", "shutters"], ["Shutter 4 B", "shutters"], ["Shutter1A", "shutters"], ["Shutter A", "shutters"], ["Blade 3", "shutters"], ["Framing Rotation", "shutters"], ["Shutter Rotation", "shutters"], ["Frame Rot", "shutters"],
    ["Gobo Wheel 1", "gobo"], ["Gobo 1 Rotation", "gobo"], ["Prism", "gobo"], ["Prism Rotation", "gobo"], ["Animation Wheel", "gobo"], ["Effect", "gobo"], ["FX Wheel", "gobo"], ["Gobo Index", "gobo"],
    ["Effects Speed", "other"], ["Lamp On/Off", "other"], ["Macro", "other"], ["Gobo Wheel Mode", "other"], ["Reserved", "other"], ["Mspeed", "other"],
  ];
  for (const [n, g] of cases) assert.equal(kindOf(n), g, n);
  for (const n of ["Shutter/LED Functions", "Gobo 1 Function", "Color Mix Function", "Control", "Fixture Control Settings", "Auto Focus", "Auto Speed", "Prism Functions"]) assert.equal(isHiddenName(n), true, `${n} is hidden`);
  for (const n of ["Shutter/LED", "Focus", "Gobo 1 Position", "Automatic", "Controller", "Mspeed"]) assert.equal(isHiddenName(n), false, `${n} is not hidden (whole words only)`);
});

test("home values (Handoff 22, Reza's table) on synthetic names", () => {
  const cases: [string, number][] = [
    ["Pan", 0.5], ["Tilt", 0.5], ["Dimmer", 1], ["Intensity", 1], ["Dim Coarse", 1],
    ["Shutter", 1], ["Shutter/LED", 1], ["Shutter/Strobe", 1], ["Strobe", 0], ["Red Strobe", 0], ["Strobe Rate", 0], ["Shutter Mode", 0],
    ["Zoom", 0.5], ["Zoom Coarse", 0.5], ["Focus", 0.5], ["Focus Coarse", 0.5], ["Iris", 0.5], ["Frost", 0], ["Diffusion", 0],
    ["Blade 1A", 0], ["Shutter 1A", 0], ["Blade 1 Insertion", 0], ["Blade 1 Angle", 0.5], ["Blade 1 Angle A", 0], ["Frame Rotation", 0.5], ["Shutter Rotation", 0.5], ["Framing Rotation", 0.5],
    ["Red", 1], ["White", 1], ["Amber", 1], ["UV", 1], ["Cyan", 0], ["Magenta", 0], ["Yellow", 0], ["CTO", 0], ["CTB", 0], ["Colour Wheel", 0],
    ["Gobo Wheel 1", 0], ["Gobo 1 Rotate", 0], ["Prism", 0], ["Prism Rotate", 0], ["Animation Wheel", 0], ["Gobo Index", 0], ["Pan/Tilt Speed", 0], ["Mspeed", 0],
  ];
  for (const [n, h] of cases) assert.equal(homeFor(n), h, `${n} → ${h * 100} %`);
  // hidden channels are never parameters: always sent at 0, never homed or stored
  const m = buildModel(channelsOf([{ name: "Shutter/LED Functions" }, { name: "Shutter/LED" }, { name: "Control" }, { name: "Auto Focus", role: 1, pair: 4 }, { name: "Auto Focus Fine", role: 2, pair: 3 }]));
  assert.deepEqual(m.hidden, [0, 2, 3, 4]);
  assert.deepEqual(m.params.map((p) => p.name), ["Shutter/LED"]);
  const s = new Uint8Array(5);
  renderModel(s, 0, m, new Map([["ch0", 1], ["ch2", 1], ["ch3", 1]]));
  assert.deepEqual([...s], [0, 255, 0, 0, 0], "hidden channels stay 0 even with a stored value; Shutter/LED open");
  // 16-bit: the same %, coarse and fine both set
  const z = buildModel(channelsOf([{ name: "Zoom Coarse", role: 1, pair: 1 }, { name: "Zoom Fine", role: 2, pair: 0 }, { name: "Shutter", role: 1, pair: 3 }, { name: "Shutter Fine", role: 2, pair: 2 }]));
  const t = new Uint8Array(4);
  renderModel(t, 0, z, new Map());
  assert.deepEqual([...t], [0x80, 0x00, 0xff, 0xff], "zoom 50 % = 0x8000; a 16-bit shutter 100 % = 0xFFFF");
});

test("pages: a Rogue-like wash — Main (Pan · Tilt · Dimmer · Zoom), then 4 per page in group order across groups; every channel once, fine channels paired", () => {
  const ch = channelsOf(movingHead());
  const m = buildModel(ch);
  assertComplete(ch, m);
  assert.deepEqual(titles(m), ["Main", "Colour", "Colour · Beam · Other"]);
  assert.deepEqual(names(m), [["Pan", "Tilt", "Dimmer", "Zoom"], ["Red", "Green", "Blue", "White"], ["Amber", "Shutter", "Pan/Tilt Speed"]]);
  assert.deepEqual(m.pages[2].groups, ["colour", "beam", "other"]);
  assert.equal(m.byName.get("pan")!.slots[0].fine!.name, "Pan Fine");
  assert.equal(m.byName.get("zoom")!.sixteen, true);
  assert.equal(m.noIntensity, false);
});

test("pages: a SolaFrame-like spot — Strobe/Shutter merged into Beam, Control hidden, 4 per page filled across groups: 8 pages", () => {
  const ch = channelsOf(framingHead());
  const m = buildModel(ch);
  assertComplete(ch, m);
  assert.deepEqual(titles(m), ["Main", "Colour", "Colour · Beam", "Beam · Shutters", "Shutters", "Shutters · Gobo/FX", "Gobo/FX", "Gobo/FX · Other"]);
  assert.deepEqual(names(m), [
    ["Pan", "Tilt", "Dimmer", "Zoom"],
    ["Cyan", "Magenta", "Yellow", "CTO"],
    ["Colour Wheel", "Shutter/Strobe", "Frost", "Iris"],
    ["Focus", "Shutter 1A", "Shutter 1B", "Shutter 2A"],
    ["Shutter 2B", "Shutter 3A", "Shutter 3B", "Shutter 4A"],
    ["Shutter 4B", "Shutter Rotation", "Gobo Wheel 1", "Gobo 1 Rotation"],
    ["Gobo Wheel 2", "Prism", "Prism Rotation", "Animation Wheel"],
    ["Animation Rotation", "Pan/Tilt Speed", "Effects Speed"],
  ]);
  assert.ok(m.pages.slice(1, -1).every((p) => p.params.length === 4), "every page but the last is full");
  assert.deepEqual(m.hidden, [35], "Control");
});

test("pages: Main keeps its positions — a conventional shows — · — · Intensity · —; no dimmer shows Pan · Tilt · — · …; a second dimmer goes to Other", () => {
  const conv = buildModel(channelsOf(conventional()));
  assert.deepEqual(titles(conv), ["Main"]);
  assert.deepEqual(names(conv), [["—", "—", "Intensity", "—"]]);
  assert.deepEqual(conv.pages[0].placeholders, ["Pan", "Tilt", "Intensity", "Zoom"]);
  const nod = buildModel(channelsOf([{ name: "Pan" }, { name: "Tilt" }, { name: "Red" }, { name: "Shutter" }]));
  assert.deepEqual(names(nod), [["Pan", "Tilt", "—", "—"], ["Red", "Shutter"]]);
  assert.deepEqual(titles(nod), ["Main", "Colour · Beam"]);
  assert.equal(nod.noIntensity, true);
  const two = channelsOf([{ name: "Intensity" }, { name: "Dimmer 2" }, { name: "Tilt" }, { name: "Zoom" }, { name: "Zoom 2" }]);
  const t = buildModel(two);
  assertComplete(two, t);
  assert.deepEqual(names(t), [["—", "Tilt", "Intensity", "Zoom"], ["Zoom 2", "Dimmer 2"]]);
  assert.deepEqual(titles(t), ["Main", "Beam · Other"]);
  assert.equal(t.byName.get("dimmer 2")!.home, 1);
  assert.deepEqual(titles(buildModel(channelsOf([{ name: "Red" }, { name: "Green" }]))), ["Colour"], "no Main page when it would be all —");
  const cmy = channelsOf(cmyHead());
  const m = buildModel(cmy);
  assertComplete(cmy, m);
  assert.deepEqual(names(m), [["Pan", "Tilt", "Dimmer", "—"], ["Cyan", "Magenta", "Yellow", "Focus"], ["Iris"]], "Main is Pan · Tilt · Intensity · Zoom whatever the channel order");
  assert.deepEqual(titles(m), ["Main", "Colour · Beam", "Beam"]);
});

test("pages: multi-cell colour stays ONE knob per colour (all cells together); two colour wheels stay two knobs; duplicate names get #2", () => {
  const ch = channelsOf(cellHead());
  const m = buildModel(ch);
  assertComplete(ch, m);
  assert.deepEqual(names(m), [["—", "—", "Dimmer", "—"], ["Red", "Green", "Blue"]]);
  assert.deepEqual(m.byName.get("red")!.slots.map((s) => s.coarse.name), ["Red 1", "Red 2", "Red 3", "Red 4", "Red 5"]);
  const wheels = buildModel(channelsOf([{ name: "Colour Wheel 1" }, { name: "Colour Wheel 2" }, { name: "Gobo" }, { name: "Gobo" }]));
  assert.deepEqual(names(wheels), [["Colour Wheel 1", "Colour Wheel 2", "Gobo", "Gobo #2"]]);
});

test("pages: a title that repeats is numbered — 12 blades fill Shutters 1/3 … 3/3; a remainder shares the next page", () => {
  const ch = channelsOf([{ name: "Dimmer" }, ...Array.from({ length: 12 }, (_, i) => ({ name: `Blade ${i + 1}` })), { name: "Gobo" }]);
  const m = buildModel(ch);
  assertComplete(ch, m);
  assert.deepEqual(titles(m), ["Main", "Shutters 1/3", "Shutters 2/3", "Shutters 3/3", "Gobo/FX"]);
  const ch2 = channelsOf([{ name: "Dimmer" }, ...Array.from({ length: 9 }, (_, i) => ({ name: `Blade ${i + 1}` })), { name: "Gobo" }]);
  assert.deepEqual(titles(buildModel(ch2)), ["Main", "Shutters 1/2", "Shutters 2/2", "Shutters · Gobo/FX"]);
});

test("pages: channels where candidate parses disagree are on no page and never written", () => {
  const ch = channelsOf(movingHead());
  const m = buildModel(ch, [13, 4]); // Zoom Fine (so Zoom too) and Pan/Tilt Speed
  assert.deepEqual(m.excluded, [4, 12, 13]);
  assert.ok(!m.byName.has("zoom") && !m.byName.has("pan/tilt speed"));
  assert.deepEqual(titles(m), ["Main", "Colour", "Colour · Beam"]);
  assert.deepEqual(names(m)[0], ["Pan", "Tilt", "Dimmer", "—"]);
  const s = new Uint8Array(512);
  renderModel(s, 0, m, new Map(m.params.map((p) => [p.id, 1])));
  assert.deepEqual([s[4], s[12], s[13]], [0, 0, 0]);
});

// ------------------------------------------------------------------ service: pages, Attribute dials, multi-selection

const FX = { wash: "aaaaaaaa-0000-0000-0000-0000000000f1", spot: "aaaaaaaa-0000-0000-0000-0000000000f2", cmy: "aaaaaaaa-0000-0000-0000-0000000000f3" };
const MODE = { wash: "bbbbbbbb-0000-0000-0000-0000000000e1", spot: "bbbbbbbb-0000-0000-0000-0000000000e2", cmy: "bbbbbbbb-0000-0000-0000-0000000000e3" };
const LISTS = { wash: movingHead(), spot: framingHead(), cmy: cmyHead() };

/** Page ▶ until the page is `name` (at most one full round, so a missing page fails instead of looping). */
function goTo(svc: FixtureService, name: string): void {
  for (let i = 0; i <= svc.pages().pages.length && svc.pageName() !== name; i++) svc.stepPage(1);
  assert.equal(svc.pageName(), name, `page ${name} exists`);
}

async function makeService() {
  const objects: Record<string, Buffer> = {};
  for (const k of ["wash", "spot", "cmy"] as const) objects[FX[k]] = buildObject(buildModeBlock({ guid: MODE[k], channels: LISTS[k] }));
  const show = new ShowModel({ libraryPath: "/x", open: () => ({ libPath: "x", readObjectByGuid: (g: string) => objects[g], close: () => undefined }) as never });
  const state = { obj: {} as Record<string, unknown> };
  const setup = new SetupStore(new GlobalSettings({ get: async () => JSON.parse(JSON.stringify(state.obj)), set: async (o) => void (state.obj = JSON.parse(JSON.stringify(o))) }));
  const tr: Transport = { send: () => undefined, close: async () => undefined };
  const engine = new DmxEngine({ transport: () => tr, setInterval: () => "H", clearInterval: () => undefined });
  const svc = new FixtureService(show, setup, engine);
  const mk = (index: number, channel: number, k: keyof typeof LISTS, name: string): CaexFixture => ({
    index, identifier: 500 + index, manufacturer: "M", name, mode: "Std", channelCount: LISTS[k].length, isDimmer: 0,
    ids: [2, 3, 4].map((type) => ({ type, name: "", size: 16, hex: "", guid: null, guidRaw: type === 2 ? FX[k] : type === 3 ? MODE[k] : `00000000-0000-0000-0000-0000000001${String(index).padStart(2, "0")}`, value: null })),
    patched: 0, universe: 0, universeChannel: 0, unit: "", channel, circuit: "", note: "", position: [0, 0, 0], angles: [0, 0, 0],
  });
  show.setConnected(true);
  show.setShowName("Pages");
  show.applyList(0, [mk(0, 101, "spot", "Spot A"), mk(1, 102, "spot", "Spot A"), mk(2, 201, "wash", "Wash B"), mk(3, 301, "cmy", "CMY C")]);
  const [s1, s2, w, c] = show.fixtures;
  await svc.setAddress(s1.key, { universe: 1, address: 1 });
  await svc.setAddress(s2.key, { universe: 1, address: 101 });
  await svc.setAddress(w.key, { universe: 1, address: 201 });
  await svc.setAddress(c.key, { universe: 1, address: 301 });
  const select = (...f: (typeof s1)[]): void => svc.onSelectionEvent(f.map((x) => x.identifier));
  return { svc, show, engine, select, f: { s1, s2, w, c } };
}

test("service: page keys cycle (wrapping) the first selected fixture's pages; the page resets to Main on a different type and is kept within the same type", async () => {
  const { svc, select, f } = await makeService();
  select(f.s1);
  assert.equal(svc.pageName(), "Main");
  assert.equal(svc.pages().pages.length, 8);
  for (let i = 0; i < 4; i++) svc.stepPage(1);
  assert.equal(svc.pageName(), "Shutters");
  select(f.s2); // same type: page kept
  assert.equal(svc.pageName(), "Shutters");
  svc.stepPage(-5);
  assert.equal(svc.pageName(), "Gobo/FX · Other", "wraps backwards past Main");
  svc.stepPage(1);
  assert.equal(svc.pageName(), "Main", "wraps forwards");
  svc.stepPage(4);
  select(f.w); // a different type: back to Main
  assert.equal(svc.pageName(), "Main");
  assert.equal(svc.pages().pages.length, 3);
  select(f.s1);
  assert.equal(svc.pageName(), "Main", "and again when coming back");
  svc.onShowGone("test");
  assert.equal(svc.pageName(), "", "nothing selected (v0.7.2: no fallback fixture): no page");
  assert.equal(svc.pages().pages.length, 0);
  assert.equal(svc.stepPage(1), false, "nothing to page");
  select(f.s1);
  assert.equal(svc.pageName(), "Main", "selected again: Main");
});

test("service: Attribute dials show the page's channel name and value; turn = ±1 % (16-bit aware), home that channel, a missing Main channel = —", async () => {
  const { svc, engine, select, f } = await makeService();
  select(f.s1);
  assert.deepEqual([0, 1, 2, 3].map((i) => svc.attrReadout(i).label), ["Pan", "Tilt", "Dimmer", "Zoom"]);
  assert.deepEqual([0, 1, 2, 3].map((i) => svc.attrReadout(i).value), [0.5, 0.5, 1, 0.5]);
  goTo(svc, "Gobo/FX · Other");
  assert.deepEqual([svc.attrReadout(3).label, svc.attrReadout(3).value], ["Gobo/FX", null]);
  assert.equal(svc.attrRotate(3, 3, false), false, "nothing on dial 4 on this page: no output");
  assert.equal(engine.active, false);
  goTo(svc, "Beam · Shutters");
  assert.deepEqual([0, 1, 2, 3].map((i) => svc.attrReadout(i).label), ["Focus", "Shutter 1A", "Shutter 1B", "Shutter 2A"]);
  assert.equal(svc.attrRotate(2, 25, false), true);
  assert.equal(svc.attrReadout(2).value, 0.25);
  const s = engine.slots(1);
  assert.equal(s[27], Math.round(0.25 * 255), "Shutter 1B is channel 28 of the fixture at 1/1");
  assert.equal(s[26], 0, "Shutter 1A stays out");
  assert.equal(s[101 - 1 + 27], 0, "the other spot is not selected");
  svc.attrRotate(2, 1, true);
  assert.equal(svc.attrReadout(2).value, 0.251);
  assert.equal(svc.attrHome(2), true);
  assert.equal(svc.attrReadout(2).value, 0, "blade home = out");
  goTo(svc, "Main");
  svc.attrRotate(0, 1, true); // pan 50.1 %: 16-bit
  const p = engine.slots(1);
  const v = Math.round(0.501 * 65535);
  assert.deepEqual([p[0], p[1]], [v >> 8, v & 0xff]);
});

test("service: several selected — same type each relative to its own value; different types drive the channel of the same name, others skipped", async () => {
  const { svc, engine, select, f } = await makeService();
  select(f.s1);
  goTo(svc, "Shutters");
  select(f.s1, f.s2);
  assert.equal(svc.pageName(), "Shutters", "same type: page kept");
  goTo(svc, "Main");
  svc.attrRotate(2, -20, false); // s1 and s2 dimmer 80 %
  select(f.s2);
  svc.attrRotate(2, 20, false); // s2 back to 100 %
  select(f.s1, f.s2);
  assert.equal(svc.attrReadout(2).multi, 2);
  svc.attrRotate(2, -10, false);
  const s = engine.slots(1);
  assert.equal((s[6] << 8) | s[7], Math.round(0.7 * 65535), "s1: 80 → 70 %");
  assert.equal((s[106] << 8) | s[107], Math.round(0.9 * 65535), "s2: 100 → 90 %");
  // spot first, then the wash and the CMY head: pages from the spot; "Dimmer" exists on all three, "Shutter/Strobe" only on the spot
  select(f.s1, f.w, f.c);
  assert.equal(svc.pageName(), "Main", "the first selected fixture is still the spot: page kept");
  svc.attrRotate(2, -50, false);
  const t = engine.slots(1);
  assert.equal(t[200 + 5], Math.round(0.5 * 255), "wash Dimmer 100 → 50 %");
  assert.equal(t[300], Math.round(0.5 * 255), "CMY Dimmer 100 → 50 %");
  goTo(svc, "Colour · Beam");
  svc.attrRotate(1, -10, false); // Shutter/Strobe: the wash has "Shutter", not "Shutter/Strobe"; the CMY head has none
  const u = engine.slots(1);
  assert.equal(u[5], 230, "spot Shutter/Strobe 255 → 90 %");
  assert.equal(u[200 + 6], 255, "the wash's Shutter is a different name: skipped");
  // pages come from the FIRST selected fixture's type
  select(f.c, f.s1);
  assert.deepEqual(svc.pages().pages.map(pageTitle), ["Main", "Colour · Beam", "Beam"]);
});

test("Setup panel: each type's channel list (1-based number, name, 8/16-bit, page); a type whose uniqueness is unproven is marked", async () => {
  const ch = channelsOf(framingHead());
  const list = channelList(ch, buildModel(ch));
  assert.equal(list.length, 37);
  assert.deepEqual(list[0], { n: 1, name: "Pan", bits: "16-bit", pair: 2, page: "Main" });
  assert.deepEqual(list[1], { n: 2, name: "Pan Fine", bits: "16-bit fine", pair: 1, page: "" });
  assert.deepEqual(list[5], { n: 6, name: "Shutter/Strobe", bits: "8-bit", pair: null, page: "Colour · Beam" });
  assert.deepEqual(list[35], { n: 36, name: "Control", bits: "8-bit", pair: null, page: "hidden (0)", hidden: true });
  assert.deepEqual(list[6], { n: 7, name: "Dimmer", bits: "16-bit", pair: 8, page: "Main" });
  assert.deepEqual(list[27], { n: 28, name: "Shutter 1B", bits: "8-bit", pair: null, page: "Beam · Shutters" });
  const m = buildModel(channelsOf(movingHead()), [13]);
  assert.match(channelList(channelsOf(movingHead()), m)[13].page, /no page/);

  const { svc, f } = await makeService();
  const v = svc.setupView();
  assert.equal(v.types[f.s1.typeKey].channels.length, 37);
  // the 37-channel synthetic spot runs the parser out of search budget, exactly like the real SolaFrame 750 did on Reza's Mac
  assert.equal(v.types[f.s1.typeKey].unproven, true);
  assert.equal(v.fixtures.find((x) => x.key === f.s1.key)!.unproven, true);
  assert.ok(v.fixtures.find((x) => x.key === f.s1.key)!.notes.some((n) => n.includes("uniqueness is not proven")));
  assert.equal(v.types[f.w.typeKey].unproven, false, "the 14-channel wash parses with uniqueness proven");
  assert.equal(v.fixtures.find((x) => x.key === f.w.key)!.unproven, false);
});

// ------------------------------------------------------------------ Handoff 21 addendum: the real SolaFrame 750 "Standard" layout

test("SolaFrame 750 (real layout from Capture's patch view): the Setup Channels list has exactly Capture's start channels and names, 16-bit pairs where Capture shows gaps", () => {
  const list = solaFrame750();
  assert.equal(list.length, 47);
  const ch = channelsOf(list);
  const rows = channelList(ch, buildModel(ch));
  assert.equal(rows.length, 47);
  const starts = rows.filter((r) => r.bits !== "16-bit fine");
  assert.deepEqual(starts.map((r) => r.n), SOLAFRAME_750_PATCH_VIEW.map(([n]) => n), "start channels = Capture's patch view");
  starts.forEach((r, i) => assert.ok(r.name.startsWith(SOLAFRAME_750_PATCH_VIEW[i][1]), `channel ${r.n}: "${r.name}" starts with Capture's "${SOLAFRAME_750_PATCH_VIEW[i][1]}…"`));
  assert.deepEqual(rows.filter((r) => r.bits === "16-bit fine").map((r) => r.n), SOLAFRAME_750_FINE, "the gaps are the fine channels");
  for (const f of SOLAFRAME_750_FINE) {
    assert.deepEqual([rows[f - 2].n, rows[f - 2].bits, rows[f - 2].pair], [f - 1, "16-bit", f], `channel ${f - 1} is 16-bit with its fine channel ${f}`);
    assert.equal(rows[f - 1].pair, f - 1, `fine ${f} belongs to ${f - 1}`);
  }
  // the name-implied pairs ("X Coarse" ↔ "X Fine") agree with the library's role/pair records
  for (const c of ch) if (/ Coarse$/.test(c.name)) assert.equal(ch[c.pair].name, c.name.replace(/ Coarse$/, " Fine"), `${c.name} pairs with its Fine`);
});

test("SolaFrame 750 (real layout): Main = Pan · Tilt · Dim · Zoom; hidden function/control/auto channels; first-touch values match Reza's table; page list printed and counted", () => {
  const ch = channelsOf(solaFrame750());
  const m = buildModel(ch);
  assertComplete(ch, m);
  const main = m.pages[0];
  assert.equal(pageTitle(main), "Main");
  assert.deepEqual(main.params.map((p) => p?.name), ["Pan", "Tilt", "Dim", "Zoom"]);
  const [, , dim, zoom] = main.params as Param[];
  assert.deepEqual([dim.slots[0].coarse.offset + 1, dim.slots[0].fine!.offset + 1], [41, 42], "Dim Coarse + Dim Fine, 16-bit");
  assert.deepEqual([zoom.slots[0].coarse.offset + 1, zoom.slots[0].fine!.offset + 1], [34, 35]);
  assert.ok(m.byName.has("focus") && m.byName.has("zoom") && m.byName.has("dim"), "labels without \"Coarse\"");
  // hidden: every name with function / functions / control / auto (whole word), fine partners included
  assert.deepEqual(m.hidden.map((o) => o + 1), [5, 10, 12, 14, 27, 28, 36, 37, 39, 43, 47]);
  assert.ok(!m.byName.has("auto focus") && !m.byName.has("shutter/led functions") && !m.byName.has("control"));
  const rows = channelList(ch, m);
  assert.deepEqual(rows[38], { n: 39, name: "Shutter/LED Functions", bits: "8-bit", pair: null, page: "hidden (0)", hidden: true });
  assert.deepEqual(rows[35], { n: 36, name: "Auto Focus", bits: "16-bit", pair: 37, page: "hidden (0)", hidden: true });
  // first touch: the frame at address 1
  const s = new Uint8Array(512);
  renderModel(s, 0, m, new Map());
  const v8 = (n: number): number => s[n - 1];
  const v16 = (n: number): number => (s[n - 1] << 8) | s[n];
  assert.equal(v8(39), 0, "39 Shutter/LED Functions = 0 (hidden)");
  assert.equal(v8(40), 255, "40 Shutter/LED = 100 % (open)");
  assert.equal(v16(41), 0xffff, "Dim 100 %");
  assert.deepEqual([v16(1), v16(3)], [0x8000, 0x8000], "pan/tilt 50 %");
  assert.deepEqual([v16(32), v16(34), v8(38)], [0x8000, 0x8000, 128], "Focus, Zoom, Iris 50 %");
  for (let n = 17; n <= 24; n++) assert.equal(v8(n), 0, `blade ${n} out (0)`);
  assert.equal(v16(25), 0x8000, "Frame Rotation 50 %");
  assert.deepEqual([v8(6), v8(7), v8(8), v8(9), v8(31)], [255, 255, 255, 0, 0], "RGB full (white), CTO 0, Frost 0");
  for (const n of [5, 10, 12, 14, 27, 28, 36, 37, 39, 43, 47]) assert.equal(v8(n), 0, `hidden channel ${n} sent at 0`);
  // the page list (printed for the run notes) and its count
  const list = m.pages.map((p) => `${pageTitle(p)}: ${p.params.map((x) => x?.name ?? "—").join(" · ")}`);
  console.log(`SolaFrame 750 (synthetic, guessed full names) — ${list.length} pages:\n  ${list.join("\n  ")}`);
  assert.deepEqual(m.pages.map(pageTitle), ["Main", "Colour", "Colour · Beam", "Beam · Shutters", "Shutters", "Shutters · Gobo/FX", "Gobo/FX · Other"]);
  assert.ok(m.pages.length <= 8, `at most 8 pages (Handoff 22): ${m.pages.length}`);
  assert.equal(m.pages.length, 7);
  assert.equal(mapChannels(ch).attrs.intensity![0].coarse.name, "Dim Coarse");
});
