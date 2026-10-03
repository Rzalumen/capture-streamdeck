// Handoff 20/21 unit tests: attribute pages from a fixture's channel names (Main page: Handoff 21), generic Attribute dials, page keys,
// home values, Setup channel list.
import assert from "node:assert/strict";
import test from "node:test";
import { defaultValues, drivenSignature, mapChannels, renderFixture } from "../src/fixtures/attrs.ts";
import { DmxEngine, renderModel, type Transport } from "../src/fixtures/engine.ts";
import { loadChannels, type Channel } from "../src/fixtures/modes.ts";
import { buildModel, kindOf, pageTitle, PER_PAGE, type FixtureModel, type Param } from "../src/fixtures/pages.ts";
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
  for (const c of ch) assert.equal(writes.get(c.offset), 1, `channel ${c.offset + 1} "${c.name}" written exactly once`);
  for (const p of onPages) for (const s of p.slots) assert.notEqual(s.coarse.role, 2, `fine channel ${s.coarse.name} is never a knob of its own`);
  for (const pg of m.pages) assert.ok(pg.params.length >= 1 && pg.params.length <= PER_PAGE);
  if (m.pages[0]?.group === "main") assert.equal(m.pages[0].params.length, 3, "Main keeps its three positions");
}

// ------------------------------------------------------------------ grouping

test("kinds: whole-word name rules, in order; speed/mode/control names go to Other; framing shutters are not Strobe/Shutter", () => {
  const cases: [string, string][] = [
    ["Pan", "pan"], ["TILT", "tilt"], ["PanFine", "pan"], ["Pan/Tilt Speed", "other"], ["Tilt Time", "other"], ["Pan Mode", "other"],
    ["Dimmer", "dimmer"], ["Intensity", "dimmer"], ["Dimmer2", "dimmer"], ["Dimmer Curve", "other"], ["Dimmers", "other"],
    ["Shutter", "strobe"], ["Shutter/Strobe", "strobe"], ["Strobe", "strobe"], ["Red Strobe", "strobe"], ["Strobe Rate", "other"], ["Shutter Mode", "other"],
    ["Red 3", "colour"], ["Warm White", "colour"], ["UV", "colour"], ["CTO", "colour"], ["CTB", "colour"], ["Colour Wheel", "colour"], ["Color Wheel 2", "colour"], ["Green Correction", "colour"],
    ["Zoom", "beam"], ["Focus", "beam"], ["Iris", "beam"], ["Frost 2", "beam"], ["Frost2", "beam"], ["Diffusion", "beam"], ["Edge", "beam"],
    ["Shutter 1A", "shutters"], ["Shutter 4 B", "shutters"], ["Shutter1A", "shutters"], ["Shutter A", "shutters"], ["Blade 3", "shutters"], ["Framing Rotation", "shutters"], ["Shutter Rotation", "shutters"], ["Frame Rot", "shutters"],
    ["Gobo Wheel 1", "gobo"], ["Gobo 1 Rotation", "gobo"], ["Prism", "gobo"], ["Prism Rotation", "gobo"], ["Animation Wheel", "gobo"], ["Effect", "gobo"], ["FX Wheel", "gobo"], ["Gobo Index", "gobo"],
    ["Control", "other"], ["Effects Speed", "other"], ["Lamp On/Off", "other"], ["Macro", "other"], ["Gobo Wheel Mode", "other"], ["Reserved", "other"],
  ];
  for (const [n, g] of cases) assert.equal(kindOf(n), g, n);
});

test("pages: a Rogue-like wash — Main (Pan · Tilt · Dimmer) · Colour 1/2 · Colour 2/2 · Beam · Strobe/Shutter · Other; every channel once, fine channels paired", () => {
  const ch = channelsOf(movingHead());
  const m = buildModel(ch);
  assertComplete(ch, m);
  assert.deepEqual(titles(m), ["Main", "Colour 1/2", "Colour 2/2", "Beam", "Strobe/Shutter", "Other"]);
  assert.deepEqual(names(m), [["Pan", "Tilt", "Dimmer"], ["Red", "Green", "Blue"], ["White", "Amber"], ["Zoom"], ["Shutter"], ["Pan/Tilt Speed"]]);
  assert.equal(m.byName.get("pan")!.slots[0].fine!.name, "Pan Fine");
  assert.equal(m.byName.get("pan")!.sixteen, true);
  assert.equal(m.byName.get("dimmer")!.sixteen, false);
  assert.equal(m.noIntensity, false);
});

test("pages: a SolaFrame-like spot (8 blades + rotation, gobos, prism, animation) — Main first, shutter/strobe leaves it, 13 pages in the v0.7 order", () => {
  const ch = channelsOf(framingHead());
  const m = buildModel(ch);
  assertComplete(ch, m);
  assert.deepEqual(titles(m), ["Main", "Colour 1/2", "Colour 2/2", "Beam 1/2", "Beam 2/2", "Shutters 1/3", "Shutters 2/3", "Shutters 3/3", "Gobo/FX 1/3", "Gobo/FX 2/3", "Gobo/FX 3/3", "Strobe/Shutter", "Other"]);
  assert.deepEqual(names(m), [
    ["Pan", "Tilt", "Dimmer"],
    ["Cyan", "Magenta", "Yellow"],
    ["CTO", "Colour Wheel"],
    ["Frost", "Iris", "Zoom"],
    ["Focus"],
    ["Shutter 1A", "Shutter 1B", "Shutter 2A"],
    ["Shutter 2B", "Shutter 3A", "Shutter 3B"],
    ["Shutter 4A", "Shutter 4B", "Shutter Rotation"],
    ["Gobo Wheel 1", "Gobo 1 Rotation", "Gobo Wheel 2"],
    ["Prism", "Prism Rotation", "Animation Wheel"],
    ["Animation Rotation"],
    ["Shutter/Strobe"],
    ["Pan/Tilt Speed", "Control", "Effects Speed"],
  ]);
  assert.equal(m.excluded.length, 0);
});

test("pages: Main keeps its positions — a conventional shows — · — · Intensity; no dimmer shows Pan · Tilt · —; a second dimmer goes to Other", () => {
  const conv = buildModel(channelsOf(conventional()));
  assert.deepEqual(titles(conv), ["Main"]);
  assert.deepEqual(names(conv), [["—", "—", "Intensity"]]);
  assert.deepEqual(conv.pages[0].placeholders, ["Pan", "Tilt", "Intensity"]);
  assert.equal(conv.params[0].home, 1);
  const nod = buildModel(channelsOf([{ name: "Pan" }, { name: "Tilt" }, { name: "Red" }, { name: "Shutter" }]));
  assert.deepEqual(names(nod), [["Pan", "Tilt", "—"], ["Red"], ["Shutter"]]);
  assert.equal(nod.noIntensity, true);
  const two = channelsOf([{ name: "Intensity" }, { name: "Dimmer 2" }, { name: "Tilt" }]);
  const t = buildModel(two);
  assertComplete(two, t);
  assert.deepEqual(names(t), [["—", "Tilt", "Intensity"], ["Dimmer 2"]]);
  assert.equal(t.byName.get("dimmer 2")!.home, 1);
  const none = buildModel(channelsOf([{ name: "Red" }, { name: "Green" }]));
  assert.deepEqual(titles(none), ["Colour"], "no Main page when it would be all —");
  const cmy = channelsOf(cmyHead());
  const m = buildModel(cmy);
  assertComplete(cmy, m);
  assert.deepEqual(titles(m), ["Main", "Colour", "Beam"]);
  assert.deepEqual(names(m)[0], ["Pan", "Tilt", "Dimmer"], "Main is Pan · Tilt · Intensity whatever the channel order");
  const blades = channelsOf([{ name: "Dimmer" }, { name: "Blade 1 Insertion" }, { name: "Blade 1 Angle" }, { name: "Framing Rotation" }, { name: "Strobe" }]);
  const b = buildModel(blades);
  assertComplete(blades, b);
  assert.deepEqual(names(b), [["—", "—", "Dimmer"], ["Blade 1 Insertion", "Blade 1 Angle", "Framing Rotation"], ["Strobe"]]);
});

test("pages: multi-cell colour stays ONE knob per colour (all cells together); two colour wheels stay two knobs; duplicate names get #2", () => {
  const ch = channelsOf(cellHead());
  const m = buildModel(ch);
  assertComplete(ch, m);
  assert.deepEqual(names(m), [["—", "—", "Dimmer"], ["Red", "Green", "Blue"]]);
  assert.deepEqual(m.byName.get("red")!.slots.map((s) => s.coarse.name), ["Red 1", "Red 2", "Red 3", "Red 4", "Red 5"]);
  const wheels = buildModel(channelsOf([{ name: "Colour Wheel 1" }, { name: "Colour Wheel 2" }, { name: "Gobo" }, { name: "Gobo" }]));
  assert.deepEqual(names(wheels), [["Colour Wheel 1", "Colour Wheel 2"], ["Gobo", "Gobo #2"]]);
});

test("pages: channels where candidate parses disagree are on no page and never written", () => {
  const ch = channelsOf(movingHead());
  const m = buildModel(ch, [13, 4]); // Zoom Fine (so Zoom too) and Pan/Tilt Speed
  assert.deepEqual(m.excluded, [4, 12, 13]);
  assert.ok(!m.byName.has("zoom") && !m.byName.has("pan/tilt speed"));
  assert.deepEqual(titles(m), ["Main", "Colour 1/2", "Colour 2/2", "Strobe/Shutter"]);
  const s = new Uint8Array(512);
  renderModel(s, 0, m, new Map(m.params.map((p) => [p.id, 1])));
  assert.deepEqual([s[4], s[12], s[13]], [0, 0, 0]);
});

// ------------------------------------------------------------------ home values

test("home: pan/tilt 50 %, dimmer 100 %, first shutter/strobe 255, additive 100 %, subtractive/CTO/wheels 0, blades 0 (out), the rest 0", () => {
  const m = buildModel(channelsOf(framingHead()));
  const h = (n: string): number => m.byName.get(n.toLowerCase())!.home;
  assert.deepEqual([h("Pan"), h("Tilt"), h("Dimmer"), h("Shutter/Strobe")], [0.5, 0.5, 1, 1]);
  assert.deepEqual([h("Cyan"), h("Magenta"), h("Yellow"), h("CTO"), h("Colour Wheel")], [0, 0, 0, 0, 0]);
  assert.deepEqual([h("Frost"), h("Iris"), h("Zoom"), h("Focus")], [0, 0, 0, 0]);
  for (const b of ["1A", "1B", "2A", "2B", "3A", "3B", "4A", "4B"]) assert.equal(h(`Shutter ${b}`), 0, `blade ${b} out`);
  assert.deepEqual([h("Shutter Rotation"), h("Gobo Wheel 1"), h("Prism"), h("Control"), h("Pan/Tilt Speed")], [0, 0, 0, 0, 0]);
  const rgbw = buildModel(channelsOf(movingHead()));
  assert.deepEqual(["Red", "Green", "Blue", "White", "Amber"].map((n) => rgbw.byName.get(n.toLowerCase())!.home), [1, 1, 1, 1, 1]);
  // a second strobe channel is not opened: only the first shutter/strobe is held at 255
  const two = buildModel(channelsOf([{ name: "Shutter" }, { name: "Strobe" }, { name: "Dimmer", role: 1, pair: 3 }, { name: "Dimmer Fine", role: 2, pair: 2 }, { name: "Strobe 2", role: 1, pair: 5 }, { name: "Strobe 2 Fine", role: 2, pair: 4 }]));
  assert.deepEqual(["shutter", "strobe", "dimmer", "strobe 2"].map((n) => two.byName.get(n)!.home), [1, 0, 1, 0]);
  const sh16 = buildModel(channelsOf([{ name: "Shutter", role: 1, pair: 1 }, { name: "Shutter Fine", role: 2, pair: 0 }]));
  const s = new Uint8Array(4);
  renderModel(s, 0, sh16, new Map());
  assert.deepEqual([s[0], s[1]], [255, 0], "a 16-bit shutter starts at coarse 255 / fine 0, as in v0.5");
});

test("first touch: the frame for the v0.5 test fixtures is byte-identical to v0.5's (no DMX change beyond driving more channels)", () => {
  for (const list of [movingHead(), cmyHead(), cellHead()]) {
    const ch = channelsOf(list);
    const map = mapChannels(ch);
    const old = new Uint8Array(512);
    renderFixture(old, 10, map, defaultValues(map));
    const now = new Uint8Array(512);
    renderModel(now, 10, buildModel(ch), new Map());
    assert.deepEqual([...now], [...old], list.map((c) => c.name).join(","));
  }
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
  assert.equal(svc.pages().pages.length, 13);
  for (let i = 0; i < 5; i++) svc.stepPage(1);
  assert.equal(svc.pageName(), "Shutters 1/3");
  select(f.s2); // same type: page kept
  assert.equal(svc.pageName(), "Shutters 1/3");
  svc.stepPage(-6);
  assert.equal(svc.pageName(), "Other", "wraps backwards past Main");
  svc.stepPage(1);
  assert.equal(svc.pageName(), "Main", "wraps forwards");
  svc.stepPage(4);
  select(f.w); // a different type: back to Main
  assert.equal(svc.pageName(), "Main");
  assert.equal(svc.pages().pages.length, 6);
  select(f.s1);
  assert.equal(svc.pageName(), "Main", "and again when coming back");
  svc.onShowGone("test");
  assert.equal(svc.pageName(), "Main", "nothing selected: the first controllable fixture's pages");
});

test("service: Attribute dials show the page's channel name and value; turn = ±1 % (16-bit aware), home that channel, a missing Main channel = —", async () => {
  const { svc, engine, select, f } = await makeService();
  select(f.s1);
  assert.deepEqual([0, 1, 2].map((i) => svc.attrReadout(i).label), ["Pan", "Tilt", "Dimmer"]);
  assert.deepEqual([svc.attrReadout(0).value, svc.attrReadout(2).value], [0.5, 1]);
  goTo(svc, "Beam 2/2");
  assert.deepEqual([svc.attrReadout(1).label, svc.attrReadout(1).value], ["Beam", null]);
  assert.equal(svc.attrRotate(1, 3, false), false, "nothing on dial 3 on this page: no output");
  assert.equal(engine.active, false);
  goTo(svc, "Shutters 1/3");
  assert.deepEqual([0, 1, 2].map((i) => svc.attrReadout(i).label), ["Shutter 1A", "Shutter 1B", "Shutter 2A"]);
  assert.equal(svc.attrRotate(1, 25, false), true);
  assert.equal(svc.attrReadout(1).value, 0.25);
  const s = engine.slots(1);
  assert.equal(s[27], Math.round(0.25 * 255), "Shutter 1B is channel 28 of the fixture at 1/1");
  assert.equal(s[26], 0, "Shutter 1A stays out");
  assert.equal(s[101 - 1 + 27], 0, "the other spot is not selected");
  svc.attrRotate(1, 1, true);
  assert.equal(svc.attrReadout(1).value, 0.251);
  assert.equal(svc.attrHome(1), true);
  assert.equal(svc.attrReadout(1).value, 0, "blade home = out");
  goTo(svc, "Main");
  svc.attrRotate(0, 1, true); // pan 50.1 %: 16-bit
  const p = engine.slots(1);
  const v = Math.round(0.501 * 65535);
  assert.deepEqual([p[0], p[1]], [v >> 8, v & 0xff]);
});

test("service: several selected — same type each relative to its own value; different types drive the channel of the same name, others skipped", async () => {
  const { svc, engine, select, f } = await makeService();
  select(f.s1);
  goTo(svc, "Shutters 1/3");
  select(f.s1, f.s2);
  assert.equal(svc.pageName(), "Shutters 1/3", "same type: page kept");
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
  goTo(svc, "Strobe/Shutter");
  svc.attrRotate(0, -10, false); // Shutter/Strobe: the wash has "Shutter", not "Shutter/Strobe"; the CMY head has none
  const u = engine.slots(1);
  assert.equal(u[5], 230, "spot Shutter/Strobe 255 → 90 %");
  assert.equal(u[200 + 6], 255, "the wash's Shutter is a different name: skipped");
  // pages come from the FIRST selected fixture's type
  select(f.c, f.s1);
  assert.deepEqual(svc.pages().pages.map(pageTitle), ["Main", "Colour", "Beam"]);
});

test("Setup panel: each type's channel list (1-based number, name, 8/16-bit, page); a type whose uniqueness is unproven is marked", async () => {
  const ch = channelsOf(framingHead());
  const list = channelList(ch, buildModel(ch));
  assert.equal(list.length, 37);
  assert.deepEqual(list[0], { n: 1, name: "Pan", bits: "16-bit", pair: 2, page: "Main" });
  assert.deepEqual(list[1], { n: 2, name: "Pan Fine", bits: "16-bit fine", pair: 1, page: "" });
  assert.deepEqual(list[5], { n: 6, name: "Shutter/Strobe", bits: "8-bit", pair: null, page: "Strobe/Shutter" });
  assert.deepEqual(list[6], { n: 7, name: "Dimmer", bits: "16-bit", pair: 8, page: "Main" });
  assert.deepEqual(list[27], { n: 28, name: "Shutter 1B", bits: "8-bit", pair: null, page: "Shutters 1/3" });
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

test("SolaFrame 750: Main = Pan (1) · Tilt (3) · Dim (41, 16-bit with 42); labels drop \"Coarse\"; Shutter/LED stays on Strobe/Shutter with the current defaults", () => {
  const ch = channelsOf(solaFrame750());
  const m = buildModel(ch);
  assertComplete(ch, m);
  const main = m.pages[0];
  assert.equal(pageTitle(main), "Main");
  assert.deepEqual(main.params.map((p) => p?.name), ["Pan", "Tilt", "Dim"]);
  const [pan, tilt, dim] = main.params as Param[];
  assert.deepEqual([pan.slots[0].coarse.offset + 1, pan.slots[0].fine!.offset + 1], [1, 2]);
  assert.deepEqual([tilt.slots[0].coarse.offset + 1, tilt.slots[0].fine!.offset + 1], [3, 4]);
  assert.deepEqual([dim.slots[0].coarse.offset + 1, dim.slots[0].fine!.offset + 1], [41, 42], "Dim Coarse + Dim Fine, 16-bit");
  assert.equal(dim.home, 1, "intensity home 100 %");
  assert.equal(m.noIntensity, false);
  assert.ok(m.byName.has("focus") && m.byName.has("zoom") && m.byName.has("dim"), "Focus, Zoom, Dim — not \"… Coarse\"");
  assert.equal(m.byName.get("focus")!.slots[0].fine!.name, "Focus Fine");
  assert.equal(m.byName.get("auto focus")!.name, "Auto Focus");
  const strobe = m.pages.filter((pg) => pg.group === "strobe").flatMap((pg) => pg.params).map((p) => p!.name);
  assert.deepEqual(strobe, ["Shutter/LED Functions", "Shutter/LED"], "Shutter/LED channels stay on Strobe/Shutter");
  assert.deepEqual([m.byName.get("shutter/led functions")!.home, m.byName.get("shutter/led")!.home], [1, 0], "unchanged rule: the first shutter/strobe channel 255, the next 0 (ranges unknown)");
  assert.deepEqual(m.pages.map(pageTitle), ["Main", "Colour 1/2", "Colour 2/2", "Beam 1/2", "Beam 2/2", "Shutters 1/3", "Shutters 2/3", "Shutters 3/3", "Gobo/FX 1/2", "Gobo/FX 2/2", "Strobe/Shutter", "Other 1/3", "Other 2/3", "Other 3/3"]);
  // the 47-channel layout also runs the parser out of search budget, like the real one did ("uniqueness is not proven")
  const l = loadChannels(buildObject(buildModeBlock({ guid: MD, channels: solaFrame750() })), MD, 47, drivenSignature);
  assert.ok(l.warnings.some((w) => w.includes("uniqueness is not proven")));
  // the v0.5 named Intensity dial finds Dim as well
  assert.equal(mapChannels(ch).attrs.intensity![0].coarse.name, "Dim Coarse");
});
