import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTicks,
  clamp,
  findNumberProperty,
  formatValue,
  fraction,
  normaliseView,
  numberArgs,
  NUMBER_PROPERTIES,
  positionArgs,
  viewAddress,
} from "../src/lib/properties.ts";

const P = (id: string) => findNumberProperty(id)!;

test("property table matches the manual (§21.4.3); manual wins over the handoff table", () => {
  assert.deepEqual([P("bloom").min, P("bloom").max], [0, 2]); // handoff table said 0..1
  assert.deepEqual([P("fillLighting").min, P("fillLighting").max], [0, 2]); // handoff table said 0..1
  assert.deepEqual([P("exposureAdjustment").min, P("exposureAdjustment").max], [-3, 3]);
  assert.deepEqual([P("whiteBalance").min, P("whiteBalance").max], [2500, 10000]);
  assert.deepEqual([P("ambientLighting").min, P("ambientLighting").max], [0, 1]);
  assert.deepEqual([P("hueClamp").min, P("hueClamp").max], [0, 1]);
  assert.deepEqual([P("contrast").min, P("contrast").max], [0, 1]);
  assert.deepEqual([P("saturation").min, P("saturation").max], [0, 1]);
  assert.deepEqual([P("flare").min, P("flare").max], [0, 2]);
  assert.deepEqual([P("flareSize").min, P("flareSize").max], [0, 2]);
  assert.deepEqual([P("flareAngle").min, P("flareAngle").max], [0, 180]);
  assert.deepEqual([P("flareStreaks").min, P("flareStreaks").max, P("flareStreaks").wire], [1, 7, "i"]);
  assert.equal(NUMBER_PROPERTIES.filter((p) => p.wire === "f").length, 11);
});

test("addresses", () => {
  assert.equal(viewAddress("live", "bloom"), "/view/live/bloom");
  assert.equal(viewAddress("2", "contrast"), "/view/2/contrast");
  assert.equal(normaliseView("1"), "1");
  assert.equal(normaliseView("banana"), "live");
  assert.equal(normaliseView(undefined), "live");
});

test("clamp", () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.3, 0, 1), 0.3);
});

test("applyTicks: value + ticks × step, clamped, no float drift", () => {
  const exp = P("exposureAdjustment");
  assert.equal(applyTicks(exp, 0, 3, 0.1, false), 0.3);
  assert.equal(applyTicks(exp, 0.3, -1, 0.1, false), 0.2);
  assert.equal(applyTicks(exp, 0.1, 2, 0.1, false), 0.3); // 0.1 + 0.2 must not become 0.30000000000000004
  assert.equal(applyTicks(exp, 2.9, 5, 0.1, false), 3);
  assert.equal(applyTicks(exp, -2.9, -5, 0.1, false), -3);
  const wb = P("whiteBalance");
  assert.equal(applyTicks(wb, 6500, 4, 100, false), 6900);
  assert.equal(applyTicks(wb, 9950, 10, 100, false), 10000);
  assert.equal(applyTicks(wb, 2600, -10, 100, false), 2500);
});

test("applyTicks: fine mode divides the step by 10", () => {
  const exp = P("exposureAdjustment");
  assert.equal(applyTicks(exp, 0, 1, 0.1, true), 0.01);
  assert.equal(applyTicks(exp, 0, 7, 0.1, true), 0.07);
  const amb = P("ambientLighting");
  assert.equal(applyTicks(amb, 0.5, 1, 0.02, true), 0.502);
  assert.equal(applyTicks(amb, 0.999, 5, 0.02, true), 1);
  const wb = P("whiteBalance");
  assert.equal(applyTicks(wb, 6500, 1, 100, true), 6510);
});

test("applyTicks: integer property steps by whole numbers, fine mode does not go below 1", () => {
  const st = P("flareStreaks");
  assert.equal(applyTicks(st, 4, 1, 1, false), 5);
  assert.equal(applyTicks(st, 4, 1, 1, true), 5);
  assert.equal(applyTicks(st, 7, 3, 1, false), 7);
  assert.equal(applyTicks(st, 1, -3, 1, false), 1);
});

test("fraction for the bar", () => {
  assert.equal(fraction(P("exposureAdjustment"), 0), 0.5);
  assert.equal(fraction(P("bloom"), 2), 1);
  assert.equal(fraction(P("bloom"), 5), 1);
  assert.equal(fraction(P("whiteBalance"), 2500), 0);
});

test("formatValue", () => {
  assert.deepEqual(formatValue(P("exposureAdjustment"), 0.5), { value: "+0.5", unit: "EV" });
  assert.deepEqual(formatValue(P("exposureAdjustment"), -1.25), { value: "−1.3", unit: "EV" });
  assert.deepEqual(formatValue(P("exposureAdjustment"), 0), { value: "0.0", unit: "EV" });
  assert.deepEqual(formatValue(P("bloom"), 1.5), { value: "150", unit: "%" });
  assert.deepEqual(formatValue(P("whiteBalance"), 6500), { value: "6500", unit: "K" });
  assert.deepEqual(formatValue(P("flareAngle"), 45), { value: "45", unit: "°" });
});

test("numberArgs: floats are always `f`, even whole numbers; int property is `i`", () => {
  assert.deepEqual(numberArgs(P("exposureAdjustment"), 0), [{ t: "f", v: 0 }]);
  assert.deepEqual(numberArgs(P("whiteBalance"), 6500), [{ t: "f", v: 6500 }]);
  assert.deepEqual(numberArgs(P("bloom"), 2), [{ t: "f", v: 2 }]);
  assert.deepEqual(numberArgs(P("flareStreaks"), 3.2), [{ t: "i", v: 3 }]);
  assert.deepEqual(numberArgs(P("bloom"), 99), [{ t: "f", v: 2 }]); // clamped
});

test("positionArgs: damp needs time, curve needs time and damp", () => {
  assert.deepEqual(positionArgs(1, 3), [
    { t: "i", v: 1 },
    { t: "i", v: 3 },
  ]);
  // damp without time → dropped
  assert.equal(positionArgs(1, 3, { damp: 0.5 }).length, 2);
  // curve without damp → dropped
  assert.equal(positionArgs(1, 3, { time: 2, curve: 0.5 }).length, 3);
  assert.deepEqual(positionArgs(1, 3, { time: 2 }).slice(2), [{ t: "f", v: 2 }]);
  assert.deepEqual(positionArgs(2, 4, { time: 2, damp: 0.25, curve: 1 }).slice(2), [
    { t: "f", v: 2 },
    { t: "f", v: 0.25 },
    { t: "f", v: 1 },
  ]);
  // ranges: time 0..600, catalog/position 1..255
  assert.deepEqual(positionArgs(999, 0, { time: 9999 }), [
    { t: "i", v: 255 },
    { t: "i", v: 1 },
    { t: "f", v: 600 },
  ]);
});
