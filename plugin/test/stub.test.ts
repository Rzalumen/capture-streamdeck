import test from "node:test";
import assert from "node:assert/strict";
import { StubCapture } from "./fixtures/stub-capture.ts";
import { ConnectionMonitor, OscClient, OscTimeoutError } from "../src/lib/oscClient.ts";
import { CatalogCache, walkCatalogs, nthPosition } from "../src/lib/discovery.ts";
import { boolArgs, findBoolProperty, findNumberProperty, numberArgs, viewAddress } from "../src/lib/properties.ts";

async function setup() {
  const stub = new StubCapture();
  await stub.start();
  const client = new OscClient({ port: stub.port });
  await client.open();
  return { stub, client, done: () => (client.close(), stub.stop()) };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("dial bytes on the wire: exposure, whole-number float, white balance, bool, int", async () => {
  const { stub, client, done } = await setup();
  const exp = findNumberProperty("exposureAdjustment")!;
  await client.send(viewAddress("live", exp.id), numberArgs(exp, -0.5));
  await client.send(viewAddress("live", exp.id), numberArgs(exp, 0)); // whole number, must still be `f`
  await client.send(viewAddress("1", "whiteBalance"), numberArgs(findNumberProperty("whiteBalance")!, 6500));
  await client.send(viewAddress("live", "automaticExposure"), boolArgs(true));
  await client.send(viewAddress("live", "laserFlickerEffect"), boolArgs(false));
  await client.send(viewAddress("0", "flareStreaks"), numberArgs(findNumberProperty("flareStreaks")!, 5));
  await wait(60);
  assert.equal(stub.raw.length, 6);
  const [a, b, c, d, e, f] = stub.msgs;
  assert.deepEqual([a.address, a.types, a.args], ["/view/live/exposureAdjustment", "f", [-0.5]]);
  assert.deepEqual([b.types, b.args], ["f", [0]]);
  assert.deepEqual([c.address, c.types, c.args], ["/view/1/whiteBalance", "f", [6500]]);
  assert.deepEqual([d.address, d.types, d.args], ["/view/live/automaticExposure", "T", [true]]);
  assert.deepEqual([e.types, e.args], ["F", [false]]);
  assert.deepEqual([f.address, f.types, f.args], ["/view/0/flareStreaks", "i", [5]]);
  assert.ok(findBoolProperty("automaticExposure"));
  // exact bytes of the whole-number float message
  assert.equal(stub.raw[1].subarray(-8).toString("hex"), "2c660000" + "00000000");
  done();
});

test("discovery walk: catalogs → names → positions → names", async () => {
  const { client, done } = await setup();
  const cats = await walkCatalogs(client);
  assert.deepEqual(cats, [
    { nr: 1, name: "Main", positions: [{ nr: 1, name: "Front" }, { nr: 2, name: "Back" }, { nr: 3, name: "Truss" }] },
    { nr: 2, name: "Extra", positions: [{ nr: 1, name: "Wide" }] },
  ]);
  assert.equal(nthPosition(cats[0], 3)?.name, "Truss");
  assert.equal(nthPosition(cats[0], 4), undefined);
  done();
});

test("catalog cache de-duplicates concurrent reads and honours max age", async () => {
  const { stub, client, done } = await setup();
  const cache = new CatalogCache(client);
  await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => cache.get(1, 15000)));
  const walks = stub.msgs.filter((m) => m.address === "/catalog/1/getPositions").length;
  assert.equal(walks, 1);
  await cache.get(1, 15000);
  assert.equal(stub.msgs.filter((m) => m.address === "/catalog/1/getPositions").length, 1);
  await cache.get(1, 0);
  assert.equal(stub.msgs.filter((m) => m.address === "/catalog/1/getPositions").length, 2);
  done();
});

test("request times out with OscTimeoutError when Capture is silent", async () => {
  const { stub, client, done } = await setup();
  stub.answering = false;
  await assert.rejects(client.request("/getCatalogs", [], "/catalogs", 80), OscTimeoutError);
  done();
});

test("startup traffic is only /ping (connection monitor)", async () => {
  const { stub, client, done } = await setup();
  const mon = new ConnectionMonitor(client, { pingMs: 1000, timeoutMs: 3000 });
  mon.start();
  await wait(100);
  mon.stop();
  assert.deepEqual(stub.msgs.map((m) => m.address), ["/ping"]);
  done();
});

test("connection: connected on /pong, offline after the timeout when Capture stops answering", async () => {
  const { stub, client, done } = await setup();
  const mon = new ConnectionMonitor(client, { pingMs: 40, timeoutMs: 200 });
  const changes: unknown[] = [];
  mon.on("change", (s) => changes.push(s));
  mon.start();
  await wait(120);
  assert.equal(mon.state.connected, true);
  assert.equal(mon.state.version, "2026.1.6");
  assert.equal(mon.state.product, "Capture 2026");
  stub.answering = false;
  await wait(120);
  assert.equal(mon.state.connected, true, "still inside the timeout window");
  await wait(250);
  assert.equal(mon.state.connected, false);
  stub.answering = true;
  await wait(120);
  assert.equal(mon.state.connected, true, "recovers");
  mon.stop();
  assert.deepEqual((changes as { connected: boolean }[]).map((c) => c.connected), [true, false, true]);
  done();
});

test("connection.check() returns quickly and reflects an unreachable Capture", async () => {
  const { stub, client, done } = await setup();
  const mon = new ConnectionMonitor(client, { pingMs: 1000, timeoutMs: 200 });
  assert.equal((await mon.check(200)).connected, true);
  stub.answering = false;
  await wait(250);
  assert.equal((await mon.check(100)).connected, false);
  done();
});
