import test from "node:test";
import assert from "node:assert/strict";
import { defaultHoldToFire, HoldToFire } from "../src/lib/holdToFire.ts";
import { LatestValueLimiter, type TimerApi } from "../src/lib/limiter.ts";
import { slotAction, StoreModifier } from "../src/lib/storeModifier.ts";
import { ValueStore } from "../src/lib/valueStore.ts";

/** Deterministic fake clock. */
class FakeTimers implements TimerApi {
  t = 0;
  private id = 0;
  private q = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.id;
    this.q.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => void this.q.delete(h as number);
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.q.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
  get pending(): number {
    return this.q.size;
  }
}

test("hold-to-fire: fires exactly once after 1 s, key-up afterwards is silent", () => {
  const T = new FakeTimers();
  const log: string[] = [];
  const h = new HoldToFire(() => log.push("fire"), () => log.push("hold-flash"), 1000, T);
  h.keyDown();
  T.advance(999);
  assert.deepEqual(log, []);
  T.advance(1);
  assert.deepEqual(log, ["fire"]);
  T.advance(5000);
  h.keyUp();
  assert.deepEqual(log, ["fire"]);
});

test("hold-to-fire: short press flashes Hold and never fires", () => {
  const T = new FakeTimers();
  const log: string[] = [];
  const h = new HoldToFire(() => log.push("fire"), () => log.push("hold-flash"), 1000, T);
  h.keyDown();
  T.advance(300);
  h.keyUp();
  T.advance(5000);
  assert.deepEqual(log, ["hold-flash"]);
  assert.equal(T.pending, 0);
});

test("hold-to-fire: cancel (key left the screen) fires nothing; repeatable", () => {
  const T = new FakeTimers();
  const log: string[] = [];
  const h = new HoldToFire(() => log.push("fire"), () => log.push("hold-flash"), 1000, T);
  h.keyDown();
  T.advance(500);
  h.cancel();
  T.advance(5000);
  assert.deepEqual(log, []);
  h.keyDown();
  T.advance(1000);
  h.keyUp();
  h.keyDown();
  T.advance(1000);
  assert.deepEqual(log, ["fire", "fire"]);
});

test("hold-to-fire defaults", () => {
  for (const n of ["Delete", "Unpatch", "Remove Filters", "Remove Gobos", "Cut", "Paste"]) {
    assert.equal(defaultHoldToFire(["Edit", n]), true, n);
  }
  assert.equal(defaultHoldToFire(["Edit", "Delete…"]), true);
  for (const n of ["Undo", "Save", "Select All", "Duplicate…", "Group"]) assert.equal(defaultHoldToFire(["Edit", n]), false, n);
});

test("store modifier: held between key down and key up, multiple keys", () => {
  const T = new FakeTimers();
  const m = new StoreModifier(30000, T);
  const changes: boolean[] = [];
  m.onChange = (h) => changes.push(h);
  assert.equal(m.isHeld, false);
  m.down("a");
  assert.equal(m.isHeld, true);
  m.down("b");
  m.up("a");
  assert.equal(m.isHeld, true);
  m.up("b");
  assert.equal(m.isHeld, false);
  m.up("b"); // idempotent
  assert.deepEqual(changes, [true, false]);
});

test("store modifier: auto-releases after the safety timeout (lost key-up)", () => {
  const T = new FakeTimers();
  const m = new StoreModifier(30000, T);
  m.down("a");
  T.advance(29999);
  assert.equal(m.isHeld, true);
  T.advance(1);
  assert.equal(m.isHeld, false);
});

test("store modifier: releaseAll", () => {
  const T = new FakeTimers();
  const m = new StoreModifier(30000, T);
  m.down("a");
  m.down("b");
  m.releaseAll();
  assert.equal(m.isHeld, false);
  assert.equal(T.pending, 0);
});

test("slot press: recall normally, store while the modifier is held", () => {
  assert.deepEqual(slotAction(1, false), { kind: "recall", slot: 1, path: ["View", "Camera", "Position 1"] });
  assert.deepEqual(slotAction(3, true), { kind: "store", slot: 3, path: ["View", "Store Camera", "Position 3"] });
  assert.equal(slotAction(9, false).slot, 5);
  assert.equal(slotAction(0, false).slot, 1);
});

test("limiter: max 30 msg/s, always the latest value, first send immediate", () => {
  const T = new FakeTimers();
  const sent: [string, number][] = [];
  const l = new LatestValueLimiter<number>((k, v) => sent.push([k, v]), 30, T);
  l.push("d", 1);
  assert.deepEqual(sent, [["d", 1]]);
  for (let v = 2; v <= 50; v++) l.push("d", v); // burst in the same instant
  assert.equal(sent.length, 1);
  T.advance(34);
  assert.deepEqual(sent.at(-1), ["d", 50]);
  assert.equal(sent.length, 2);
  // sustained turning: one push every 5 ms for 1 s → never more than 30 sends (+1 for the leading edge)
  sent.length = 0;
  for (let i = 0; i < 200; i++) {
    l.push("d", 100 + i);
    T.advance(5);
  }
  T.advance(100);
  assert.ok(sent.length <= 31, `sent ${sent.length}`);
  assert.equal(sent.at(-1)![1], 299); // ends on the latest value
});

test("limiter: keys are independent", () => {
  const T = new FakeTimers();
  const sent: string[] = [];
  const l = new LatestValueLimiter<number>((k) => sent.push(k), 30, T);
  l.push("a", 1);
  l.push("b", 1);
  assert.deepEqual(sent, ["a", "b"]);
});

test("value store: persisted values vs sent-this-session", async () => {
  let saved: Record<string, number | boolean> = { "live/bloom": 1.2 };
  const vs = new ValueStore({ load: async () => saved, save: async (v) => void (saved = v) }, 1);
  await vs.init();
  assert.equal(vs.getNumber("live", "bloom", 1), 1.2);
  assert.equal(vs.wasSentThisSession("live", "bloom"), false); // stored, but greyed with "~" until first send
  assert.equal(vs.getNumber("live", "contrast", 0.5), 0.5); // falls back to the reset value
  vs.recordSent("live", "bloom", 1.4);
  assert.equal(vs.wasSentThisSession("live", "bloom"), true);
  await vs.flush();
  assert.equal(saved["live/bloom"], 1.4);
  assert.equal(vs.wasSentThisSession("0", "bloom"), false); // per view
});
