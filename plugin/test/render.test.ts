import test from "node:test";
import assert from "node:assert/strict";
import { COLORS, attrStripFeedback, deckKeySvg, deckState, fixtureStripFeedback, headerText, keySvg, mix, selectStripFeedback, stripFeedback, type HeaderInput } from "../src/lib/render.ts";
import { ICONS, iconForCommand, iconSvg } from "../src/lib/icons.ts";

test("mix at 35 % over the background", () => {
  assert.equal(mix("#FFFFFF", "#000000", 0.35), "#595959");
  assert.equal(mix(COLORS.accent, COLORS.bg, 1), COLORS.accent);
  assert.equal(mix(COLORS.accent, COLORS.bg, 0), COLORS.bg);
});

test("key svg carries palette, dim opacity and is well-formed enough", () => {
  const s = keySvg({ icon: "plot", label: "Plot" });
  assert.ok(s.includes(COLORS.bg) && s.includes(COLORS.text));
  assert.ok(!s.includes("opacity"));
  const d = keySvg({ icon: "plot", label: "Plot", dim: true });
  assert.ok(d.includes('opacity="0.35"'));
  assert.ok(keySvg({ icon: "plot", label: "Error", tone: "red" }).includes(COLORS.red));
  // v0.5: the label is the key's Stream Deck title, never drawn into the image (it would be doubled); flash text still is
  assert.ok(!keySvg({ icon: "plot", label: "Plot" }).includes("Plot"));
  assert.ok(!keySvg({ icon: "x", label: 'A & <B> "q"' }).includes("A &amp;"));
  assert.ok(!/<text/.test(keySvg({ icon: "plot", label: "Plot" })), "no text at all on a plain key");
  assert.ok(keySvg({ icon: "plot", label: "Plot", big: "Hold" }).includes(">Hold<"));
  assert.ok(keySvg({ icon: "plot", label: "Plot", badge: "3" }).includes(">3<"));
});

test("fixture strips: ×N mark for several fixtures; the select strip carries model, line, note and mark", () => {
  const f = fixtureStripFeedback({ name: "Pan", value: 0.5, fine: true, multi: 3, untouched: false }) as any;
  assert.equal(f.mark.value, "×3 FINE");
  assert.equal((fixtureStripFeedback({ name: "Pan", value: 0.5, fine: false, multi: 1, untouched: true }) as any).mark.value, "~");
  assert.equal((fixtureStripFeedback({ name: "Pan", value: null, fine: false, multi: 2, untouched: true }) as any).mark.value, "×2");
  const s = selectStripFeedback({ line1: "ColorBlaze 72", line2: "SL 1.3 · US 0.9", note: "1/285 · (not selected in Capture)", mark: "2/5", count: 5 }) as any;
  assert.deepEqual([s.line1.value, s.line2.value, s.note.value, s.mark.value], ["ColorBlaze 72", "SL 1.3 · US 0.9", "1/285 · (not selected in Capture)", "2/5"]);
});

test("every icon has content; command mapping covers the default layout", () => {
  for (const [k, v] of Object.entries(ICONS)) assert.ok(v.length > 10, k);
  assert.ok(iconSvg("plot", 24).startsWith("<svg"));
  const p = (...a: string[]) => iconForCommand(a);
  assert.equal(p("View", "Wireframe"), "wireframe");
  assert.equal(p("View", "Camera", "Swing to Front"), "swing-front");
  assert.equal(p("Edit", "Undo"), "undo");
  assert.equal(p("Edit", "Duplicate…"), "duplicate");
  assert.equal(p("View", "Camera", "Position 1"), "position");
  assert.equal(p("View", "Store Camera", "Position 1"), "store");
  assert.equal(p("Nonsense", "Thing"), "command");
  for (const name of ["Unit…", "Circuit…", "Patch…", "Channel…", "Focus…", "Fixture Details…", "Unpatch", "Save As…", "Export Focus Sheets…", "Save Image…", "Render Image…", "Select All", "Deselect All"]) {
    assert.notEqual(iconForCommand(["Edit", name]), "command", name);
  }
});

test("strip feedback: value greyed with ~ until sent; offline dims and says Offline; fine marker", () => {
  const base = { name: "EXPOSURE", value: "+0.5", unit: "EV", fraction: 0.58, fine: false, estimated: false, offline: false };
  const live = stripFeedback(base) as any;
  assert.equal(live.value.value, "+0.5");
  assert.equal(live.value.color, COLORS.text);
  assert.equal(live.bar.value, 58);
  const est = stripFeedback({ ...base, estimated: true }) as any;
  assert.equal(est.value.value, "~+0.5");
  assert.notEqual(est.value.color, COLORS.text);
  assert.equal(est.mark.value, "~");
  assert.equal((stripFeedback({ ...base, fine: true }) as any).mark.value, "FINE");
  const off = stripFeedback({ ...base, offline: true }) as any;
  assert.equal(off.mark.value, "Offline");
  assert.equal(off.mark.color, COLORS.red);
  assert.equal(off.name.color, "#" + off.name.color.slice(1).toUpperCase());
});

// ------------------------------------------------------------------ v0.7.3 (Handoff 24): Deck state on the LCD and the Deck key

const H = (state: HeaderInput["state"], o: Partial<HeaderInput> = {}): HeaderInput => ({ state, line1: "Rogue R2X Wash", line2: "Ch 202 · 1/444", page: "Main", pageIndex: 0, pageCount: 8, ...o });
const GREY_TEXT = mix(COLORS.text, COLORS.bg, 0.6);

test("deckState: off when Deck Control is OFF; click when ON with nothing to drive; driving otherwise", () => {
  assert.equal(COLORS.on, "#3DD68C");
  assert.equal(deckState(false, false), "off");
  assert.equal(deckState(false, true), "off", "OFF wins even with a selection");
  assert.equal(deckState(true, false), "click");
  assert.equal(deckState(true, true), "driving");
});

test("header text per dial slot: off / click / driving (single, ×2 same model, several models, Ch 0 position hint, long model clipped, page n/N)", () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => headerText(i, H("off"))), ["DECK OFF", "", "", ""]);
  assert.deepEqual([0, 1, 2, 3].map((i) => headerText(i, H("click"))), ["CLICK A LIGHT", "Click a light", "in Capture", ""]);
  assert.deepEqual([0, 1, 2, 3].map((i) => headerText(i, H("driving"))), ["DECK ON", "Ch 202 · 1/444", "Rogue R2X Wash", "Main 1/8"]);
  assert.deepEqual([1, 2].map((i) => headerText(i, H("driving", { line1: "Rogue R2X Wash ×2", line2: "Ch 202 +1" }))), ["Ch 202 +1", "Rogue R2X Wash ×2"]);
  assert.deepEqual([1, 2].map((i) => headerText(i, H("driving", { line1: "3 fixtures", line2: "Ch 201 +2" }))), ["Ch 201 +2", "3 fixtures"]);
  assert.equal(headerText(1, H("driving", { line2: "SL 1.3 · US 0.9" })), "SL 1.3 · US 0.9", "Capture Channel 0: the position hint");
  const long = headerText(2, H("driving", { line1: "Robe Robin MegaPointe Profile" }));
  assert.equal(long, "Robe Robin MegaPo…");
  assert.equal(long.length, 18);
  assert.equal(headerText(2, H("driving", { line1: "Exactly18Character" })), "Exactly18Character", "18 characters: not clipped");
  // v0.10.1 (Handoff 29): one count only — the page title without its own k/m, then the overall n/N
  assert.equal(headerText(3, H("driving", { page: "Shutters 1/2", pageIndex: 1, pageCount: 8 })), "Shutters 2/8", "a split group");
  assert.equal(headerText(3, H("driving", { page: "Shutters 2/2", pageIndex: 2, pageCount: 8 })), "Shutters 3/8");
  assert.equal(headerText(3, H("driving", { page: "Shutters · Beam", pageIndex: 3, pageCount: 8 })), "Shutters · Beam 4/8", "a mixed page");
  assert.equal(headerText(3, H("driving", { page: "Gobo/FX · Other 1/2", pageIndex: 6, pageCount: 8 })), "Gobo/FX · Other 7/8", "a repeated mixed title");
  assert.equal(headerText(3, H("driving", { page: "Main", pageIndex: 0, pageCount: 7 })), "Main 1/7");
  for (const [page, i, n] of [["Shutters 1/3", 1, 8], ["Colour 2/2", 5, 8], ["Main", 0, 3], ["Beam · Colour", 4, 7]] as const) {
    const t = headerText(3, H("driving", { page, pageIndex: i, pageCount: n }));
    assert.equal((t.match(/\d+\/\d+/g) ?? []).length, 1, `one count only: ${t}`);
  }
  assert.equal(headerText(3, H("driving", { page: "" })), "", "no page: empty");
});

test("header colours: the background runs across all four strips in the state colour", () => {
  const fb = (state: HeaderInput["state"], slot: number) => attrStripFeedback({ name: "Pan", value: 0.5, fine: false, multi: 1, untouched: false, slot, header: H(state) }).header as { value: string; color: string; background: string };
  for (const slot of [0, 1, 2, 3]) {
    assert.deepEqual([fb("off", slot).background, fb("off", slot).color], [COLORS.track, GREY_TEXT], `off ${slot}`);
    assert.deepEqual([fb("click", slot).background, fb("click", slot).color], [COLORS.accent, COLORS.bg], `click ${slot}`);
    assert.deepEqual([fb("driving", slot).background, fb("driving", slot).color], [COLORS.on, COLORS.bg], `driving ${slot}`);
  }
});

test("attrStripFeedback: the body is fixtureStripFeedback's for the same input (— dimmed, ~ untouched, ×N), only FINE takes the state colour", () => {
  const cases = [
    { name: "Pan", value: 0.5, fine: false, multi: 1, untouched: false },
    { name: "Pan", value: 0.5, fine: false, multi: 1, untouched: true },
    { name: "Intensity", value: null, fine: false, multi: 1, untouched: true },
    { name: "Red 1", value: 0.25, fine: false, multi: 3, untouched: false },
    { name: "Tilt", value: null, fine: true, multi: 2, untouched: false },
  ];
  for (const st of ["off", "click", "driving"] as const)
    for (const c of cases) {
      const { header, ...body } = attrStripFeedback({ ...c, slot: 1, header: H(st) });
      assert.ok(header);
      assert.deepEqual(body, fixtureStripFeedback(c), `${st} ${JSON.stringify(c)}`);
    }
  const fine = (st: HeaderInput["state"]) => (attrStripFeedback({ name: "Pan", value: 0.5, fine: true, multi: 1, untouched: false, slot: 0, header: H(st) }).mark as { value: string; color: string });
  assert.deepEqual(fine("driving"), { value: "FINE", color: COLORS.on });
  assert.deepEqual(fine("click"), { value: "FINE", color: COLORS.accent });
  assert.deepEqual(fine("off"), { value: "FINE", color: GREY_TEXT }, "off: the grey of the off line (the track colour would not show on the dark strip)");
  const { mark, ...rest } = attrStripFeedback({ name: "Pan", value: 0.5, fine: true, multi: 1, untouched: false, slot: 0, header: H("driving") });
  const { mark: m0, ...rest0 } = fixtureStripFeedback({ name: "Pan", value: 0.5, fine: true, multi: 1, untouched: false });
  void mark;
  void m0;
  delete (rest as Record<string, unknown>).header;
  assert.deepEqual(rest, rest0, "with FINE on, everything but the mark colour is unchanged");
});

test("deckKeySvg: a full-size background rect in the state colour and the state's text", () => {
  const bgOf = (svg: string) => /^<svg[^>]*><rect x="0" y="0" width="144" height="144" fill="(#[0-9A-F]{6})"\/>/.exec(svg)?.[1];
  const texts = (svg: string) => [...svg.matchAll(/<text[^>]*fill="(#[0-9A-F]{6})"[^>]*>([^<]*)<\/text>/g)].map((m) => [m[2], m[1]]);
  const off = deckKeySvg("off");
  assert.equal(bgOf(off), COLORS.track);
  assert.deepEqual(texts(off), [["DECK", GREY_TEXT], ["OFF", GREY_TEXT]]);
  const click = deckKeySvg("click", "Ch 202");
  assert.equal(bgOf(click), COLORS.accent);
  assert.deepEqual(texts(click), [["CLICK", COLORS.bg], ["A LIGHT", COLORS.bg]], "click ignores the channel text");
  const drv = deckKeySvg("driving", "Ch 202");
  assert.equal(bgOf(drv), COLORS.on);
  assert.deepEqual(texts(drv), [["DECK ON", COLORS.bg], ["Ch 202", COLORS.bg]]);
  for (const svg of [off, click, drv]) {
    assert.match(svg, /width="144" height="144" viewBox="0 0 144 144"/);
    for (const m of svg.matchAll(/font-size="(\d+)"/g)) assert.ok(Number(m[1]) >= 14 && Number(m[1]) <= 36, m[1]);
    assert.ok(!svg.includes("<g"), "no icon: text only");
  }
  assert.deepEqual(texts(deckKeySvg("driving")).map((t) => t[0]), ["DECK ON"]);
});
