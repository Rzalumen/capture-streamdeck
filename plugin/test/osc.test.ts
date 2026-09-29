import test from "node:test";
import assert from "node:assert/strict";
import { decodeMessage, encodeMessage, oscBool, oscF, oscI, oscS } from "../src/lib/osc.ts";

const hex = (b: Buffer): string => b.toString("hex");

test("byte-exact: ,f (whole number still float32)", () => {
  assert.equal(hex(encodeMessage("/a", [oscF(1)])), "2f610000" + "2c660000" + "3f800000");
  assert.equal(hex(encodeMessage("/a", [oscF(-3)])), "2f610000" + "2c660000" + "c0400000");
  assert.equal(hex(encodeMessage("/a", [oscF(0.5)])), "2f610000" + "2c660000" + "3f000000");
  assert.equal(hex(encodeMessage("/a", [oscF(6500)])), "2f610000" + "2c660000" + "45cb2000");
});

test("byte-exact: ,i", () => {
  assert.equal(hex(encodeMessage("/a", [oscI(7)])), "2f610000" + "2c690000" + "00000007");
  assert.equal(hex(encodeMessage("/a", [oscI(-1)])), "2f610000" + "2c690000" + "ffffffff");
});

test("byte-exact: ,T and ,F carry no payload", () => {
  assert.equal(hex(encodeMessage("/a", [oscBool(true)])), "2f610000" + "2c540000");
  assert.equal(hex(encodeMessage("/a", [oscBool(false)])), "2f610000" + "2c460000");
});

test("byte-exact: ,s pads to 4 with at least one NUL", () => {
  assert.equal(hex(encodeMessage("/a", [oscS("hi")])), "2f610000" + "2c730000" + "68690000");
  assert.equal(hex(encodeMessage("/a", [oscS("abc")])), "2f610000" + "2c730000" + "61626300");
  assert.equal(hex(encodeMessage("/a", [oscS("abcd")])), "2f610000" + "2c730000" + "6162636400000000");
});

test("byte-exact: ,ii and ,iifff position recall", () => {
  assert.equal(hex(encodeMessage("/a", [oscI(1), oscI(2)])), "2f610000" + "2c696900" + "00000001" + "00000002");
  assert.equal(
    hex(encodeMessage("/a", [oscI(1), oscI(2), oscF(2), oscF(0.5), oscF(1)])),
    "2f610000" + "2c6969666666" + "0000" + "00000001" + "00000002" + "40000000" + "3f000000" + "3f800000",
  );
});

test("real address: /view/live/exposureAdjustment", () => {
  const b = encodeMessage("/view/live/exposureAdjustment", [oscF(-0.5)]);
  // 29 chars + NUL = 30 → padded to 32; ",f" → 4; float → 4
  assert.equal(b.length, 32 + 4 + 4);
  assert.equal(b.subarray(0, 29).toString("ascii"), "/view/live/exposureAdjustment");
  assert.equal(b.readFloatBE(36), -0.5);
});

test("decode round-trips, incl. Capture's replies", () => {
  const pong = decodeMessage(encodeMessage("/pong", [oscS("Capture 2026"), oscS("2026.1.6")]));
  assert.deepEqual(pong, { address: "/pong", types: "ss", args: ["Capture 2026", "2026.1.6"] });
  const status = decodeMessage(encodeMessage("/view/live/status", [oscI(0), oscF(1), oscF(2), oscF(3), oscF(4), oscF(5), oscF(6)]));
  assert.equal(status.types, "iffffff");
  assert.deepEqual(status.args, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(decodeMessage(encodeMessage("/x", [oscBool(true), oscBool(false)])).args, [true, false]);
  assert.deepEqual(decodeMessage(encodeMessage("/ping")).args, []);
});

test("encode rejects bad input, decode rejects bundles", () => {
  assert.throws(() => encodeMessage("nope"));
  assert.throws(() => encodeMessage("/a", [oscF(NaN)]));
  assert.throws(() => encodeMessage("/a", [{ t: "i", v: 2 ** 31 }]));
  assert.throws(() => decodeMessage(Buffer.from("#bundle\0", "ascii")));
});
