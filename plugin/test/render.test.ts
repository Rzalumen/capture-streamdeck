import test from "node:test";
import assert from "node:assert/strict";
import { COLORS, keySvg, layoutLabel, mix, stripFeedback } from "../src/lib/render.ts";
import { ICONS, iconForCommand, iconSvg } from "../src/lib/icons.ts";

test("mix at 35 % over the background", () => {
  assert.equal(mix("#FFFFFF", "#000000", 0.35), "#595959");
  assert.equal(mix(COLORS.accent, COLORS.bg, 1), COLORS.accent);
  assert.equal(mix(COLORS.accent, COLORS.bg, 0), COLORS.bg);
});

test("label layout: short on one line, long wraps to two, never overflows", () => {
  assert.deepEqual(layoutLabel("Plot"), { lines: ["Plot"], size: 22 });
  const l = layoutLabel("Fixture Information");
  assert.equal(l.lines.length, 2);
  for (const t of ["Export Documentation…", "Swing to Selection", "Enter Full Screen", "P3 Fixture Number…", "Extraordinarilylongwordwithoutspaces"]) {
    const r = layoutLabel(t);
    assert.ok(r.lines.length <= 2);
    for (const line of r.lines) assert.ok(line.length * r.size * 0.58 <= 128 + 1, `${t} → ${line}`);
  }
});

test("key svg carries palette, dim opacity and is well-formed enough", () => {
  const s = keySvg({ icon: "plot", label: "Plot" });
  assert.ok(s.includes(COLORS.bg) && s.includes(COLORS.text));
  assert.ok(!s.includes("opacity"));
  const d = keySvg({ icon: "plot", label: "Plot", dim: true });
  assert.ok(d.includes('opacity="0.35"'));
  assert.ok(keySvg({ icon: "plot", label: "Error", tone: "red" }).includes(COLORS.red));
  assert.ok(keySvg({ icon: "x", label: 'A & <B> "q"' }).includes("A &amp; &lt;B&gt; &quot;q&quot;"));
  assert.ok(keySvg({ icon: "plot", label: "Hold", big: "Hold" }).includes(">Hold<"));
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
