/** The persistent CITP session against the stub Capture: events, reconnect with back-off, the identify guard, the allowlist. */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { CAEX, UNIDENTIFIED } from "../src/fixtures/citp.ts";
import { CitpSession, DEFAULT_TIMING, timingFromEnv, type FixtureListEvent } from "../src/fixtures/citpSession.ts";
import { buildRemoveMessage, startPatchStub, type SynthFixture } from "./fixtures/synth.ts";

const I1 = "00000000-0000-0000-0000-0000000000a1";
const I2 = "00000000-0000-0000-0000-0000000000a2";
const fx = (n: number, inst: string, identifier: number): SynthFixture => ({ mfr: "M", name: `F${n}`, mode: "S", channels: 4, channel: n, instanceId: inst, fixtureGuid: "aaaaaaaa-0000-0000-0000-000000000001", modeGuid: "bbbbbbbb-0000-0000-0000-000000000001", identifier });
const until = async (pred: () => unknown, what: string, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
/** Whatever a test leaves running is stopped afterwards, so a failing assertion fails the test instead of hanging it. */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const TIMING = { backoffMin: 40, backoffMax: 160, rerequestMs: 200, firstRetryMs: 100, discoverMs: 50 };

test("timing: defaults 2 s → 30 s, 30 s list, 5 s retry; the test hook parses", () => {
  assert.deepEqual([DEFAULT_TIMING.backoffMin, DEFAULT_TIMING.backoffMax, DEFAULT_TIMING.rerequestMs, DEFAULT_TIMING.firstRetryMs], [2000, 30000, 30000, 5000]);
  assert.deepEqual(timingFromEnv("1,2,3"), { ...DEFAULT_TIMING, backoffMin: 1, backoffMax: 2, rerequestMs: 3 });
  assert.deepEqual(timingFromEnv("nonsense"), DEFAULT_TIMING);
  assert.deepEqual(timingFromEnv(undefined), DEFAULT_TIMING);
});

test("session: PNam → EnterShow → list; selection / modify / remove / leave arrive as events; a list while not in the show is ignored; stop() says LeaveShow", async () => {
  const stub = await startPatchStub([fx(1, I1, UNIDENTIFIED), fx(2, I2, 5)], { showName: "S" });
  const s = new CitpSession({ host: "127.0.0.1", port: stub.port, timing: TIMING });
  const ev: string[] = [];
  const lists: FixtureListEvent[] = [];
  s.on("state", (c) => ev.push(`state:${c}`));
  s.on("show", (n) => ev.push(`show:${n}`));
  s.on("list", (l) => (ev.push("list"), lists.push(l)));
  s.on("selection", (ids) => ev.push(`sel:${ids.join(",")}`));
  s.on("modify", (m) => ev.push(`mod:${m[0].identifier}:${m[0].universeChannel}`));
  s.on("remove", (ids) => ev.push(`rm:${ids.join(",")}`));
  s.on("leave", () => ev.push("leave"));
  cleanups.push(async () => (await s.stop(), await stub.close()));
  s.start();
  await until(() => lists.length >= 1, "first list");
  assert.deepEqual(ev.slice(0, 3), ["state:true", "show:S", "list"]);
  assert.equal(lists[0].type, 0);
  assert.deepEqual(lists[0].fixtures.map((f) => f.identifier), [UNIDENTIFIED, 5]);
  stub.select([5, 6]);
  stub.modify([{ identifier: 5, changed: 1, patched: 1, universe: 0, universeChannel: 9 }]);
  stub.push(buildRemoveMessage([9, 10]));
  await until(() => ev.includes("sel:5,6") && ev.includes("mod:5:9") && ev.includes("rm:9,10"), "selection, modify and remove");
  // periodic re-request while entered
  const n0 = lists.length;
  await until(() => lists.length > n0, "periodic list", 1500);
  assert.equal(stub.of(CAEX.EnterShow).length, 1, "our EnterShow once per connection");
  // LeaveShow: no more requests, a late list is ignored
  stub.leaveShow();
  await until(() => ev.includes("leave"), "leave");
  const n1 = lists.length;
  stub.list(0);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(lists.length, n1, "a FixtureList that arrives while we are not in the show is ignored");
  const asked = stub.of(CAEX.FixtureListRequest).length;
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(stub.of(CAEX.FixtureListRequest).length, asked, "no list requests after LeaveShow");
  assert.equal(s.requestList(), false);
  // Capture enters again: request and list again
  stub.enterShow("S2");
  await until(() => ev.includes("show:S2") && lists.length > n1, "second show");
  await s.stop();
  await until(() => stub.of(CAEX.LeaveShow).length >= 1, "our LeaveShow");
  await stub.close();
});

test("session: reconnects after a dropped connection (PNam and EnterShow again); an unreachable Capture is retried with back-off 40 → 160 ms and reported", async () => {
  const stub = await startPatchStub([fx(1, I1, 1)]);
  const s = new CitpSession({ host: "127.0.0.1", port: stub.port, timing: TIMING });
  const states: [boolean, string | undefined][] = [];
  s.on("state", (c, r) => states.push([c, r]));
  cleanups.push(async () => (await s.stop(), await stub.close()));
  s.start();
  await until(() => stub.of(CAEX.EnterShow).length === 1, "first connection");
  stub.drop();
  await until(() => stub.received.filter((m) => m.toString("latin1", 16, 24) === "PINFPNam").length === 2, "reconnect");
  await until(() => s.connected && stub.of(CAEX.EnterShow).length === 2, "entered again");
  assert.deepEqual(states.map((x) => x[0]).slice(0, 3), [true, false, true]);
  // Capture goes away entirely
  const port = stub.port;
  await stub.close();
  await until(() => s.delays.length >= 5, "back-off");
  assert.deepEqual(s.delays.slice(0, 5), [40, 40, 80, 160, 160], "after each lost connection it starts again at 40; then doubles up to the maximum");
  assert.ok(states.some(([c, r]) => !c && /could not connect to Capture/.test(r ?? "")), "the reason is reported");
  // and comes back on the same port: connected again, back-off reset
  const back = await new Promise<net.Server>((res) => {
    const srv = net.createServer((c) => (c.on("error", () => undefined), c.resume()));
    srv.listen(port, "127.0.0.1", () => res(srv));
  });
  await until(() => s.connected, "connected after Capture came back", 3000);
  await s.stop();
  await new Promise<void>((r) => back.close(() => r()));
});

test("session: FixtureIdentify only for entries the caller lists as unidentified; anything else is dropped before it reaches the wire", async () => {
  const stub = await startPatchStub([fx(1, I1, UNIDENTIFIED), fx(2, I2, 5)]);
  const logs: string[] = [];
  const s = new CitpSession({ host: "127.0.0.1", port: stub.port, timing: TIMING, log: (l) => logs.push(l) });
  cleanups.push(async () => (await s.stop(), await stub.close()));
  s.start();
  await until(() => s.entered, "entered");
  const g = (h: string) => ({ guid: Buffer.from(h.replaceAll("-", ""), "hex"), guidRaw: h });
  const n = await s.identify([{ ...g(I1), identifier: 100001 }, { ...g(I2), identifier: 100002 }], new Set([I1]));
  assert.equal(n, 1);
  await until(() => stub.identifies.length === 1, "FixtureIdentify");
  assert.deepEqual(stub.identifies[0], [[I1, 100001]], "the identified fixture was dropped");
  assert.ok(logs.some((l) => /REFUSED 1 FixtureIdentify entry/.test(l)));
  assert.equal(await s.identify([{ ...g(I2), identifier: 1 }], new Set()), 0, "nothing allowed: nothing sent");
  assert.equal(stub.identifies.length, 1);
  await s.stop();
  await stub.close();
});

test("session: answers GetLaserFeedList with an empty list and NACKs requests it does not serve", async () => {
  const stub = await startPatchStub([fx(1, I1, 1)]);
  const s = new CitpSession({ host: "127.0.0.1", port: stub.port, timing: TIMING });
  cleanups.push(async () => (await s.stop(), await stub.close()));
  s.start();
  await until(() => stub.of(CAEX.LaserFeedList).length === 1, "LaserFeedList");
  const c = [...stub.clients][0];
  const hdr = (code: number): Buffer => {
    const b = Buffer.alloc(24);
    b.write("CITP", 0, "latin1");
    b[4] = 1;
    b.writeUInt32LE(24, 8);
    b.write("CAEX", 16, "latin1");
    b.writeUInt32LE(code, 20);
    return b;
  };
  c.write(hdr(CAEX.GetLiveViewStatus));
  c.write(hdr(CAEX.FixtureListRequest));
  await until(() => stub.of(CAEX.NACK).length >= 2, "NACKs");
  await s.stop();
  await stub.close();
});
