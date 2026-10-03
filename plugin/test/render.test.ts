import test from "node:test";
import assert from "node:assert/strict";
import { COLORS, fixtureStripFeedback, keySvg, mix, selectStripFeedback, stripFeedback } from "../src/lib/render.ts";
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
