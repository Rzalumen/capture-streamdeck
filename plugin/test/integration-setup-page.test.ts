/**
 * End-to-end (Handoff 16): pressing Fixtures: Setup opens the local Setup page. The REAL built plugin with the stub CITP server, a
 * synthetic Library.c2z, a fake Stream Deck, a UDP listener standing in for Capture's sACN input, and a fake `open` that records the address.
 * Run `npm run build` first (npm test does).
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDataPacket, type ParsedPacket } from "../src/fixtures/sacn.ts";
import { FakeDeck, sleep } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";
import { buildLibraryFile, buildModeBlock, buildObject, movingHead, startPatchStub } from "./fixtures/synth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../com.rezabehjat.capture.sdPlugin");
const U = "com.rezabehjat.capture";
const A = { setup: `${U}.fixtures.setup`, select: `${U}.fixture.select`, pan: `${U}.fixture.pan`, status: `${U}.fixtures.status` };
const FX = "aaaaaaaa-0000-0000-0000-000000000001";
const MD = "bbbbbbbb-0000-0000-0000-000000000001";
const INST1 = "00000000-0000-0000-0000-0000000000a1";
const INST2 = "00000000-0000-0000-0000-0000000000a2";

const deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fx-page-"));
const sacn = dgram.createSocket("udp4");
const packets: ParsedPacket[] = [];
let citp: Awaited<ReturnType<typeof startPatchStub>>;
let pageUrl: URL;

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  const lib = path.join(tmp, "Library.c2z");
  fs.writeFileSync(lib, buildLibraryFile({ [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) }));
  citp = await startPatchStub(
    [
      { mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 203, fixtureGuid: FX, modeGuid: MD, instanceId: INST1, position: [4, 6, 2] },
      { mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 204, fixtureGuid: FX, modeGuid: MD, instanceId: INST2, position: [-4, 6, 2] },
    ],
    { showName: "PAGE SHOW" },
  );
  sacn.on("message", (m) => {
    try {
      packets.push(parseDataPacket(m));
    } catch {
      /* not E1.31 */
    }
  });
  await new Promise<void>((r) => sacn.bind(0, "127.0.0.1", r));
  await capture.start();
  await deck.start({
    oscPort: capture.port,
    pluginDir,
    fixtures: path.join(here, "fixtures"),
    env: { CAPTURE_TEST_CITP_PORT: String(citp.port), CAPTURE_TEST_LIBRARY: lib, CAPTURE_TEST_SACN_PORT: String(sacn.address().port), CAPTURE_TEST_SACN_NO_MULTICAST: "1" },
  });
});
after(async () => {
  await deck.stop();
  capture.stop();
  citp.server.close();
  sacn.close();
});

interface Res {
  status: number;
  type: string;
  body: string;
}
/** A raw HTTP request to 127.0.0.1:<port> (optionally with another Host header). */
const req = (method: string, p: string, o: { body?: string; type?: string; host?: string } = {}): Promise<Res> =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: pageUrl.port, method, path: p, headers: { ...(o.host ? { Host: o.host } : {}), ...(o.type ? { "Content-Type": o.type } : {}) } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: b }));
    });
    r.on("error", reject);
    r.end(o.body);
  });
const tok = () => `t=${pageUrl.searchParams.get("t")}`;
const api = async (payload: object): Promise<{ view: any; error: string | null }> => {
  const r = await req("POST", `/api?${tok()}`, { body: JSON.stringify(payload), type: "application/json" });
  assert.equal(r.status, 200, r.body);
  return JSON.parse(r.body);
};

test("pressing Fixtures: Setup opens the page in the browser: loopback address, random port, 48-hex token; the key says 'Setup ▸ press' until something is configured", async () => {
  deck.willAppear(A.setup, "setup");
  deck.willAppear(A.select, "sel", {}, "Encoder");
  deck.willAppear(A.pan, "pan", {}, "Encoder");
  await deck.waitFor(() => deck.lastImage("setup").includes("Setup ▸ press"), 4000, "key text 'Setup ▸ press'");
  assert.equal(deck.lastFeedback("sel").line1.value, "No fixture");
  assert.equal(deck.lastFeedback("sel").line2.value, "Press Setup");
  assert.equal(deck.openCalls().length, 0, "nothing opened before the press");

  deck.keyDown(A.setup, "setup");
  const calls = await deck.waitFor(() => deck.openCalls().length === 1 && deck.openCalls(), 4000, "browser opened");
  pageUrl = new URL(calls[0]);
  assert.equal(pageUrl.protocol, "http:");
  assert.equal(pageUrl.hostname, "127.0.0.1");
  assert.ok(Number(pageUrl.port) > 1024);
  assert.equal(pageUrl.pathname, "/");
  assert.match(pageUrl.searchParams.get("t") ?? "", /^[0-9a-f]{48}$/);
  // the log says it opened, without the token
  await deck.waitFor(() => /Fixtures: setup page opened in the browser/.test(deck.logText()), 3000, "log line");
  assert.ok(!deck.logText().includes(pageUrl.searchParams.get("t")!), "the token is never logged");
  await deck.waitFor(() => deck.lastImage("setup").includes("Setup ▸ press"), 1000, "still unconfigured");
});

test("token required on every request: 403 without it or with a wrong one, also for the API and for unknown paths; wrong Host refused", async () => {
  for (const p of ["/", "/pi.css", "/setup-core.js", "/setup-web.js", "/nope", "/api", `/?t=${"0".repeat(48)}`, "/?t=", "/?t=abc"]) {
    assert.equal((await req("GET", p)).status, 403, `GET ${p}`);
  }
  assert.equal((await req("POST", "/api", { body: JSON.stringify({ cmd: "get" }), type: "application/json" })).status, 403);
  assert.equal((await req("POST", `/api?t=${"f".repeat(48)}`, { body: JSON.stringify({ cmd: "get" }), type: "application/json" })).status, 403);
  // right token, wrong Host (DNS rebinding): refused
  assert.equal((await req("GET", `/?${tok()}`, { host: `evil.example:${pageUrl.port}` })).status, 403);
  assert.equal((await req("GET", `/?${tok()}`, { host: "127.0.0.1" })).status, 403);
  // nothing was changed by any of that
  assert.equal(deck.globals.fixtureSetup, undefined);
});

test("bound to loopback only: reachable on 127.0.0.1, refused on another 127.x address and on this machine's LAN addresses", async () => {
  assert.equal((await req("GET", `/?${tok()}`)).status, 200);
  const tryConnect = (host: string): Promise<string> =>
    new Promise((resolve) => {
      const s = net.connect({ host, port: Number(pageUrl.port), timeout: 1500 });
      s.on("connect", () => (s.destroy(), resolve("connected")));
      s.on("error", (e) => resolve((e as NodeJS.ErrnoException).code ?? "error"));
      s.on("timeout", () => (s.destroy(), resolve("timeout")));
    });
  if (process.platform === "linux") assert.equal(await tryConnect("127.0.0.2"), "ECONNREFUSED", "not bound to the whole 127/8 or to 0.0.0.0");
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) assert.notEqual(await tryConnect(i.address), "connected", `reachable on ${i.address}`);
});

test("the page and its files are served with the token; unknown paths, wrong methods and bad bodies are refused", async () => {
  const page = await req("GET", `/?${tok()}`);
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.ok(page.body.includes("Fixtures: Setup") && page.body.includes("Blackout") === false);
  assert.ok(!page.body.includes("__T__"), "the token placeholder is filled in");
  assert.ok(page.body.includes(`pi.css?${tok()}`) && page.body.includes(`setup-core.js?${tok()}`) && page.body.includes(`setup-web.js?${tok()}`));
  for (const f of ["pi.css", "setup-core.js", "setup-web.js"]) assert.equal((await req("GET", `/${f}?${tok()}`)).status, 200, f);
  assert.equal((await req("GET", `/../package.json?${tok()}`)).status, 404);
  assert.equal((await req("GET", `/manifest.json?${tok()}`)).status, 404);
  assert.equal((await req("GET", `/api?${tok()}`)).status, 405);
  assert.equal((await req("POST", `/?${tok()}`, { body: "{}", type: "application/json" })).status, 405);
  assert.equal((await req("POST", `/api?${tok()}`, { body: "{}", type: "text/plain" })).status, 415);
  assert.equal((await req("POST", `/api?${tok()}`, { body: "{nope", type: "application/json" })).status, 400);
  assert.equal((await req("POST", `/api?${tok()}`, { body: "[1]", type: "application/json" })).status, 400);
  assert.equal((await req("POST", `/api?${tok()}`, { body: "x".repeat(70 * 1024), type: "application/json" }).catch(() => ({ status: 413 }))).status, 413);
});

test("save/validate round trip through HTTP: list, range error, Ch 203 → 1/285, overlap, auto-fill, clear; same storage as the Inspector; log lines", async () => {
  let r = await api({ cmd: "get" });
  for (let i = 0; i < 40 && r.view.fixtures.length < 2; i++) (await sleep(150), (r = await api({ cmd: "get" })));
  assert.equal(r.view.showName, "PAGE SHOW");
  assert.deepEqual(r.view.fixtures.map((f: any) => [f.channel, f.name, f.mode, f.hasPanTilt]), [
    [203, "Rogue R2X Wash", "Std", true],
    [204, "Rogue R2X Wash", "Std", true],
  ]);
  assert.match(r.view.fixtures[0].position, /H 6\.0/);

  r = await api({ cmd: "set", key: INST1, universe: 17, address: 1 });
  assert.match(r.error ?? "", /universe/i);
  r = await api({ cmd: "set", key: INST1, universe: 1, address: 600 });
  assert.ok(r.error, "address 600 refused");
  assert.equal(deck.globals.fixtureSetup, undefined, "nothing saved by the refused ones");

  r = await api({ cmd: "set", key: INST1, universe: 1, address: 285 });
  assert.equal(r.error, null);
  assert.equal(r.view.controllable, 1);
  assert.deepEqual((deck.globals as any).fixtureSetup, { "PAGE SHOW": { [INST1]: { universe: 1, address: 285 } } });

  r = await api({ cmd: "set", key: INST2, universe: 1, address: 290 });
  assert.equal(r.error, null);
  assert.equal(r.view.controllable, 0, "overlap: neither is controllable");
  assert.match(r.view.fixtures[0].issues[0], /overlaps/);
  r = await api({ cmd: "set", key: INST2, universe: 1, address: 299 });
  assert.equal(r.view.controllable, 2);
  r = await api({ cmd: "clear", key: INST2 });
  assert.equal(r.view.controllable, 1);
  r = await api({ cmd: "autofill", keys: [INST1, INST2], universe: 2, address: 1 });
  assert.equal(r.error, null);
  assert.deepEqual(r.view.fixtures.map((f: any) => f.addr), [{ universe: 2, address: 1 }, { universe: 2, address: 15 }]);
  r = await api({ cmd: "set", key: INST1, universe: 1, address: 285 });
  r = await api({ cmd: "set", key: INST2, universe: 1, address: 299 });

  const log = deck.logText();
  for (const line of ["Fixtures: set Ch 203 Rogue R2X Wash -> 1/285", "Fixtures: set Ch 204 Rogue R2X Wash -> 1/290", "Fixtures: cleared Ch 204 Rogue R2X Wash", "Fixtures: set Ch 203 Rogue R2X Wash -> 2/1 (auto-fill)", "Fixtures: set Ch 204 Rogue R2X Wash -> 2/15 (auto-fill)"]) assert.ok(log.includes(line), `log has: ${line}`);
  assert.ok(log.includes("Fixtures: set Ch 203 Rogue R2X Wash -> 17/1 rejected") && log.includes("-> 1/600 rejected"), "refused changes are logged too");
  assert.equal(packets.length, 0, "saving addresses is not a touch: no DMX");
});

test("the Select strip updates at once after a save and the Setup key loses 'press'; then Pan starts the output (Reza's test)", async () => {
  await deck.waitFor(() => deck.lastFeedback("sel")?.line1?.value === "Rogue R2X Wash" && deck.lastFeedback("sel").line2.value === "Ch 203 · 1/285", 3000, "strip shows the Rogue at 1/285");
  await deck.waitFor(() => !deck.lastImage("setup").includes("Setup ▸ press"), 3000, "key no longer says 'press'");
  // exactly one controllable fixture is auto-selected: clear the second, clear the first, set only the second → the strip follows it
  await api({ cmd: "clear", key: INST1 });
  await deck.waitFor(() => deck.lastFeedback("sel").line1.value === "Rogue R2X Wash" && deck.lastFeedback("sel").line2.value === "Ch 204 · 1/299", 3000, "auto-selected the only fixture");
  await api({ cmd: "clear", key: INST2 });
  await deck.waitFor(() => deck.lastFeedback("sel").line2.value === "Press Setup", 3000, "back to 'Press Setup'");
  await api({ cmd: "set", key: INST1, universe: 1, address: 285 });
  await deck.waitFor(() => deck.lastFeedback("sel").line2.value === "Ch 203 · 1/285", 3000, "strip shows Ch 203 again");

  assert.equal(packets.length, 0);
  deck.dialRotate(A.pan, "pan", 5);
  const p = await deck.waitFor(() => packets.at(-1), 3000, "output started by the touch");
  assert.equal(p.universe, 1);
});

test("Re-read show through HTTP returns the show again; the Property Inspector still works and logs 'setup inspector opened'", async () => {
  const r = await api({ cmd: "resync" });
  assert.equal(r.view.status, "ok");
  assert.equal(r.view.fixtures.length, 2);
  deck.inspectorAppeared(A.setup, "setup");
  await deck.waitFor(() => deck.logText().includes("Fixtures: setup inspector opened"), 3000, "inspector log line");
  deck.sendToPlugin(A.setup, "setup", { cmd: "get" });
  await deck.waitFor(() => deck.received.some((m) => m.event === "sendToPropertyInspector" && m.payload?.event === "setup" && m.payload.view.fixtures.length === 2), 3000, "inspector view");
  // a second press opens the same page again (same port and token)
  deck.keyDown(A.setup, "setup");
  await deck.waitFor(() => deck.openCalls().length === 2, 3000, "second open");
  assert.equal(deck.openCalls()[1], deck.openCalls()[0]);
});
