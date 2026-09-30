import test from "node:test";
import assert from "node:assert/strict";
import { DroppedError, SerialQueue } from "../src/lib/queue.ts";

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

test("levels: a press (0) runs before waiting polls (2) and background reads (3); equal levels stay FIFO; a running job is never interrupted", async () => {
  const q = new SerialQueue();
  const order: string[] = [];
  const g = gate();
  const first = q.enqueue(async () => (await g.p, order.push("running-bg")), { level: 3 });
  const bg = q.enqueue(async () => void order.push("bg"), { level: 3 });
  const poll1 = q.enqueue(async () => void order.push("poll1"), { level: 2 });
  const poll2 = q.enqueue(async () => void order.push("poll2"), { level: 2 });
  const press1 = q.enqueue(async () => void order.push("press1"), { level: 0 });
  const press2 = q.enqueue(async () => void order.push("press2"), { level: 0 });
  g.open();
  await Promise.all([first, bg, poll1, poll2, press1, press2]);
  assert.deepEqual(order, ["running-bg", "press1", "press2", "poll1", "poll2", "bg"]);
  assert.equal(q.maxActive, 1);
});

test("legacy priority flag still means 'ahead of normal jobs'", async () => {
  const q = new SerialQueue();
  const order: string[] = [];
  const g = gate();
  const a = q.enqueue(async () => (await g.p, order.push("a")));
  const b = q.enqueue(async () => void order.push("b"));
  const c = q.enqueue(async () => void order.push("c"), { priority: true });
  g.open();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["a", "c", "b"]);
});

test("dropWaiting rejects waiting jobs with that tag, leaves the running one and other tags alone", async () => {
  const q = new SerialQueue();
  const g = gate();
  const ran: string[] = [];
  const running = q.enqueue(async () => (await g.p, ran.push("running")), { level: 2, tag: "poll" });
  const w1 = q.enqueue(async () => void ran.push("w1"), { level: 2, tag: "poll" });
  const w2 = q.enqueue(async () => void ran.push("w2"), { level: 2, tag: "poll" });
  const keep = q.enqueue(async () => void ran.push("keep"), { level: 3, tag: "other" });
  assert.equal(q.waitingWithTag("poll"), 2);
  assert.equal(q.dropWaiting("poll"), 2);
  g.open();
  const settled = await Promise.allSettled([running, w1, w2, keep]);
  assert.deepEqual(settled.map((s) => s.status), ["fulfilled", "rejected", "rejected", "fulfilled"]);
  assert.ok((settled[1] as PromiseRejectedResult).reason instanceof DroppedError);
  assert.deepEqual(ran, ["running", "keep"]);
});

test("coalesceKey reuses a waiting job", async () => {
  const q = new SerialQueue();
  const g = gate();
  let n = 0;
  const a = q.enqueue(async () => (await g.p, 1));
  const b = q.enqueue(async () => ++n, { coalesceKey: "k" });
  const c = q.enqueue(async () => ++n, { coalesceKey: "k" });
  g.open();
  assert.deepEqual(await Promise.all([a, b, c]), [1, 1, 1]);
  assert.equal(n, 1);
});
