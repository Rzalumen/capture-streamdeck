// Handoff 26 (v0.8.0) unit tests: the SDMX universe declaration (byte vectors from the REAL Capture run of 2026-10-05,
// reports/citp-sdmx.txt — literal hex, not the builder), the outgoing allowlist with and without `sdmxDeclare`, the ChBk / Capa decoder,
// the persistent session's declaration order (and the "declared" flag on FixtureLists, v0.10.0), the engine's overlay of Capture's levels, and the
// service applying ChBk to configured fixtures (store, conflicts, Blind, unconfigured slots).
import assert from "node:assert/strict";
import test from "node:test";
import { drivenSignature, mapChannels } from "../src/fixtures/attrs.ts";
import {
  ALLOWED_OUTGOING_CAEX,
  CAEX,
  HEADER_SIZE,
  buildDeclaration,
  buildFixtureIdentify,
  buildHeader,
  buildSxsr,
  buildSxus,
  CitpFramer,
  decodeMessage,
  decodeSdmx,
  isAllowedOutgoing,
  isWellFormedDeclaration,
  type ChBk,
} from "../src/fixtures/citp.ts";
import net from "node:net";
import { CitpSession } from "../src/fixtures/citpSession.ts";
import { ValueMemory } from "../src/fixtures/deck.ts";
import { DmxEngine, type Target } from "../src/fixtures/engine.ts";
import { loadChannels } from "../src/fixtures/modes.ts";
import { buildModel } from "../src/fixtures/pages.ts";
import { FixtureService } from "../src/fixtures/service.ts";
import { SetupStore } from "../src/fixtures/setup.ts";
import { ShowModel } from "../src/fixtures/show.ts";
import { GlobalSettings } from "../src/lib/globals.ts";
import { REAL_CAPA, buildChBk, buildEnterShowMessage, buildModeBlock, buildObject, buildPatchMessage, movingHead, startPatchStub, type SynthChannel } from "./fixtures/synth.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (h: string): Buffer => Buffer.from(h.replace(/\s+/g, ""), "hex");

// ------------------------------------------------------------------ literal vectors (real Capture run, 2026-10-05)

/** The 17 declaration messages exactly as the probe sent them (and Capture accepted them). */
const REAL_DECLARATION = [
  "43 49 54 50 01 00 00 00 25 00 00 00 01 00 00 00 53 44 4d 58 53 58 53 72 42 53 52 45 31 2e 33 31 2f 31 2f 31 00",
  "43 49 54 50 01 00 00 00 26 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 00 42 53 52 45 31 2e 33 31 2f 31 2f 31 00",
  "43 49 54 50 01 00 00 00 26 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 01 42 53 52 45 31 2e 33 31 2f 32 2f 31 00",
  "43 49 54 50 01 00 00 00 26 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 02 42 53 52 45 31 2e 33 31 2f 33 2f 31 00",
  "43 49 54 50 01 00 00 00 26 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 03 42 53 52 45 31 2e 33 31 2f 34 2f 31 00",
  "43 49 54 50 01 00 00 00 26 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 04 42 53 52 45 31 2e 33 31 2f 35 2f 31 00",
  "43 49 54 50 01 00 00 00 26 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 05 42 53 52 45 31 2e 33 31 2f 36 2f 31 00",
  "43 49 54 50 01 00 00 00 26 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 06 42 53 52 45 31 2e 33 31 2f 37 2f 31 00",
  "43 49 54 50 01 00 00 00 26 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 07 42 53 52 45 31 2e 33 31 2f 38 2f 31 00",
  "43 49 54 50 01 00 00 00 26 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 08 42 53 52 45 31 2e 33 31 2f 39 2f 31 00",
  "43 49 54 50 01 00 00 00 27 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 09 42 53 52 45 31 2e 33 31 2f 31 30 2f 31 00",
  "43 49 54 50 01 00 00 00 27 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 0a 42 53 52 45 31 2e 33 31 2f 31 31 2f 31 00",
  "43 49 54 50 01 00 00 00 27 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 0b 42 53 52 45 31 2e 33 31 2f 31 32 2f 31 00",
  "43 49 54 50 01 00 00 00 27 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 0c 42 53 52 45 31 2e 33 31 2f 31 33 2f 31 00",
  "43 49 54 50 01 00 00 00 27 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 0d 42 53 52 45 31 2e 33 31 2f 31 34 2f 31 00",
  "43 49 54 50 01 00 00 00 27 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 0e 42 53 52 45 31 2e 33 31 2f 31 35 2f 31 00",
  "43 49 54 50 01 00 00 00 27 00 00 00 01 00 00 00 53 44 4d 58 53 58 55 53 0f 42 53 52 45 31 2e 33 31 2f 31 36 2f 31 00",
].map(hex);

/** The six ChBk messages Capture sent during the mouse drags, with the levels the research decoder printed. */
const REAL_CHBK: [Buffer, Omit<ChBk, "blind"> & { blind: number }][] = [
  [hex("43 49 54 50 01 00 00 00 22 00 00 00 01 00 00 00 53 44 4d 58 43 68 42 6b 00 00 bb 01 04 00 16 b3 dc b0"), { blind: 0, universeIndex: 0, firstChannel: 443, levels: [22, 179, 220, 176] }],
  [hex("43 49 54 50 01 00 00 00 22 00 00 00 01 00 00 00 53 44 4d 58 43 68 42 6b 00 00 bb 01 04 00 37 bd 32 7e"), { blind: 0, universeIndex: 0, firstChannel: 443, levels: [55, 189, 50, 126] }],
  [hex("43 49 54 50 01 00 00 00 22 00 00 00 01 00 00 00 53 44 4d 58 43 68 42 6b 00 00 bb 01 04 00 16 b5 dc df"), { blind: 0, universeIndex: 0, firstChannel: 443, levels: [22, 181, 220, 223] }],
  [hex("43 49 54 50 01 00 00 00 21 00 00 00 01 00 00 00 53 44 4d 58 43 68 42 6b 00 00 e2 01 03 00 e6 ff ff"), { blind: 0, universeIndex: 0, firstChannel: 482, levels: [230, 255, 255] }],
  [hex("43 49 54 50 01 00 00 00 20 00 00 00 01 00 00 00 53 44 4d 58 43 68 42 6b 00 00 e3 01 02 00 00 00"), { blind: 0, universeIndex: 0, firstChannel: 483, levels: [0, 0] }],
  [hex("43 49 54 50 01 00 00 00 21 00 00 00 01 00 00 00 53 44 4d 58 43 68 42 6b 00 00 e2 01 03 00 e6 ff ff"), { blind: 0, universeIndex: 0, firstChannel: 482, levels: [230, 255, 255] }],
];

/** An SDMX message with a given 4-char type and body, correct header. */
const sdmx = (type: string, body: Buffer): Buffer => Buffer.concat([buildHeader(HEADER_SIZE + 4 + body.length, "SDMX"), Buffer.from(type, "latin1"), body]);
const z = (s: string): Buffer => Buffer.concat([Buffer.from(s, "latin1"), Buffer.from([0])]);
const withSize = (m: Buffer, size: number): Buffer => {
  const b = Buffer.from(m);
  b.writeUInt32LE(size, 8);
  return b;
};

// ------------------------------------------------------------------ declaration bytes

test("declaration: buildSxsr / buildSxus / buildDeclaration are byte-identical to the 17 messages the probe sent on the real Capture", () => {
  assert.equal(REAL_CAPA.length, 38);
  assert.deepEqual(buildSxsr(1), REAL_DECLARATION[0]);
  for (let u = 1; u <= 16; u++) assert.deepEqual(buildSxus(u), REAL_DECLARATION[u], `SXUS universe ${u}`);
  const d = buildDeclaration();
  assert.equal(d.length, 17);
  assert.deepEqual(Buffer.concat(d.map((x) => x.buf)), Buffer.concat(REAL_DECLARATION), "the whole declaration, in order");
  assert.deepEqual(d.map((x) => x.buf.toString("latin1", 20, 24)), ["SXSr", ...Array(16).fill("SXUS")]);
  for (const bad of [0, 257, 1.5, -1, Number.NaN]) {
    assert.throws(() => buildSxus(bad), RangeError, `SXUS ${bad}`);
    assert.throws(() => buildSxsr(bad), RangeError, `SXSr ${bad}`);
  }
  assert.ok(isWellFormedDeclaration(buildSxus(256)), "universe 256 is the last one allowed");
});

// ------------------------------------------------------------------ allowlist

test("allowlist: SXSr / SXUS refused by default and with any other option; accepted ONLY with {sdmxDeclare: true}", () => {
  for (const m of REAL_DECLARATION) {
    const what = `${m.toString("latin1", 20, 24)} ${m.length} B`;
    assert.equal(isAllowedOutgoing(m), false, `default refuses ${what}`);
    assert.equal(isAllowedOutgoing(m, {}), false, `{} refuses ${what}`);
    assert.equal(isAllowedOutgoing(m, { sdmxDeclare: false }), false, `{sdmxDeclare:false} refuses ${what}`);
    assert.equal(isAllowedOutgoing(m, { identify: true } as never), false, `{identify:true} refuses ${what}`);
    assert.equal(isAllowedOutgoing(m, { sdmxDeclare: "yes" } as never), false, `a truthy non-boolean is not the option (${what})`);
    assert.equal(isAllowedOutgoing(m, { sdmxDeclare: true }), true, `{sdmxDeclare:true} accepts ${what}`);
  }
});

test("allowlist with {sdmxDeclare: true}: every malformed declaration and every other SDMX message is refused; CAEX / PINF rules unchanged", () => {
  const ok = { sdmxDeclare: true } as const;
  const sxus1 = REAL_DECLARATION[1];
  const sxsr = REAL_DECLARATION[0];
  const refused: [string, Buffer][] = [
    ["SXUS wrong index (1 for universe 1)", sdmx("SXUS", Buffer.concat([Buffer.from([1]), z("BSRE1.31/1/1")]))],
    ["SXUS wrong index (0 for universe 2)", sdmx("SXUS", Buffer.concat([Buffer.from([0]), z("BSRE1.31/2/1")]))],
    ["declared size 1 too big", withSize(sxus1, sxus1.length + 1)],
    ["declared size 1 too small", withSize(sxus1, sxus1.length - 1)],
    ["trailing byte after the terminator", sdmx("SXUS", Buffer.concat([Buffer.from([0]), z("BSRE1.31/1/1"), Buffer.from([0])]))],
    ["second string after the first", sdmx("SXSr", Buffer.concat([z("BSRE1.31/1/1"), z("BSRE1.31/2/1")]))],
    ["missing terminator", sdmx("SXSr", Buffer.from("BSRE1.31/1/1", "latin1"))],
    ["Art-Net string", sdmx("SXSr", z("ArtNet/0/0/1"))],
    ["sACN channel 2", sdmx("SXSr", z("BSRE1.31/1/2"))],
    ["sACN channel 0", sdmx("SXUS", Buffer.concat([Buffer.from([0]), z("BSRE1.31/1/0")]))],
    ["universe 0", sdmx("SXSr", z("BSRE1.31/0/1"))],
    ["universe 257 (SXSr)", sdmx("SXSr", z("BSRE1.31/257/1"))],
    ["universe 999 (SXSr)", sdmx("SXSr", z("BSRE1.31/999/1"))],
    ["universe 1000 (SXSr)", sdmx("SXSr", z("BSRE1.31/1000/1"))],
    ["leading zero", sdmx("SXSr", z("BSRE1.31/01/1"))],
    ["lower case prefix", sdmx("SXSr", z("bsre1.31/1/1"))],
    ["empty string", sdmx("SXSr", z(""))],
    ["no string", sdmx("SXSr", Buffer.alloc(0))],
    ["SXUS without index or string", sdmx("SXUS", Buffer.alloc(0))],
    ["multi-part (MessagePartCount 2)", (() => { const b = Buffer.from(sxsr); b.writeUInt16LE(2, 12); return b; })()],
    ["MessagePart 1", (() => { const b = Buffer.from(sxsr); b.writeUInt16LE(1, 14); return b; })()],
    ["not a CITP cookie", (() => { const b = Buffer.from(sxsr); b.write("CITQ", 0, "latin1"); return b; })()],
    ["the real ChBk", REAL_CHBK[0][0]],
    ["ChBk built by the stub", buildChBk(1, 1, [1, 2, 3])],
    ["ChLs", sdmx("ChLs", Buffer.from([1, 0, 0, 0, 0, 255]))],
    ["the real Capa", REAL_CAPA],
    ["UNam", sdmx("UNam", Buffer.concat([Buffer.from([0]), z("Universe 1")]))],
    ["EnId", sdmx("EnId", z("capture-streamdeck"))],
    ["unknown SDMX type", sdmx("XXXX", z("BSRE1.31/1/1"))],
  ];
  for (const [what, m] of refused) {
    assert.equal(isAllowedOutgoing(m, ok), false, `refused with the option: ${what}`);
    assert.equal(isAllowedOutgoing(m), false, `refused by default: ${what}`);
  }
  // the CAEX side is untouched by the option
  for (const code of [CAEX.FixtureList, CAEX.FixtureModify, CAEX.FixtureRemove, CAEX.FixtureSelection, 0x00020400, 0x00020500]) {
    const m = Buffer.concat([buildHeader(HEADER_SIZE + 4, "CAEX"), Buffer.from([code & 0xff, (code >> 8) & 0xff, (code >> 16) & 0xff, code >>> 24])]);
    assert.equal(isAllowedOutgoing(m, ok), false, `CAEX 0x${code.toString(16)} still refused with the option`);
  }
  for (const code of ALLOWED_OUTGOING_CAEX) {
    const m = Buffer.concat([buildHeader(HEADER_SIZE + 4, "CAEX"), Buffer.alloc(4)]);
    m.writeUInt32LE(code, HEADER_SIZE);
    assert.equal(isAllowedOutgoing(m), true, `CAEX 0x${code.toString(16)} allowed as before`);
  }
  const fi = buildFixtureIdentify([{ guid: Buffer.alloc(16, 7), identifier: 5 }]);
  assert.equal(isAllowedOutgoing(fi), true, "a well-formed FixtureIdentify as before");
  assert.equal(isAllowedOutgoing(withSize(fi, fi.length + 1)), false, "a malformed one still refused");
});

// ------------------------------------------------------------------ decoder

test("decoder: the six real ChBk messages and the real Capa decode exactly; malformed ChBk is reported, never applied, never throws", () => {
  for (const [m, want] of REAL_CHBK) {
    const d = decodeMessage(m);
    assert.equal(d.layer, "SDMX");
    assert.equal(d.sdmx?.error, undefined);
    assert.deepEqual(d.sdmx?.chbk, want);
  }
  assert.deepEqual(decodeMessage(REAL_CAPA).sdmx, { type: "Capa", caps: [2, 3, 4, 101, 102, 105] });
  const real = REAL_CHBK[0][0];
  const truncated = withSize(real.subarray(0, real.length - 1), real.length - 1); // ChannelCount 4, only 3 levels
  assert.match(decodeSdmx(truncated).error ?? "", /need 4 byte/);
  assert.equal(decodeSdmx(truncated).chbk, undefined);
  const trailing = withSize(Buffer.concat([real, Buffer.from([9])]), real.length + 1);
  assert.match(decodeSdmx(trailing).error ?? "", /after the 4 level/);
  assert.match(decodeSdmx(buildChBk(1, 510, [1, 2, 3, 4])).error ?? "", /past slot 512/);
  assert.equal(decodeSdmx(buildChBk(1, 509, [1, 2, 3, 4])).error, undefined, "509..512 fits");
  assert.match(decodeSdmx(buildChBk(1, 1, [])).error ?? "", /ChannelCount is 0/);
  assert.match(decodeSdmx(withSize(real.subarray(0, 27), 27)).error ?? "", /need/); // header + "ChBk" + 3 bytes
  // never throws on anything
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(rnd() * 40);
    const body = Buffer.from(Array.from({ length: n }, () => Math.floor(rnd() * 256)));
    const m = sdmx(rnd() < 0.5 ? "ChBk" : "Capa", body);
    assert.doesNotThrow(() => decodeMessage(m));
  }
});

// ------------------------------------------------------------------ session

test("persistent session: Capture's Capa is logged; after OUR EnterShow comes SXSr + SXUS 1-16 (exact bytes), then the list request; again after a reconnect; ChBk becomes a levels event, malformed is logged with hex", async () => {
  const stub = await startPatchStub([{ mfr: "M", name: "F", mode: "S", channels: 1, channel: 1 }], { showName: "SDMX" });
  stub.sendCapa = true;
  const logs: string[] = [];
  const s = new CitpSession({ host: "127.0.0.1", port: stub.port, timing: { backoffMin: 100, backoffMax: 200, rerequestMs: 60_000, firstRetryMs: 60_000, discoverMs: 50 }, log: (l) => logs.push(l) });
  const levels: ChBk[] = [];
  s.on("levels", (e) => levels.push(e));
  s.start();
  try {
    for (let i = 0; i < 100 && !logs.some((l) => /declared sACN/.test(l)); i++) await sleep(20);
    await sleep(100);
    const first = stub.received.map((m) => (m.toString("latin1", 16, 20) === "CAEX" ? `CAEX:0x${m.readUInt32LE(20).toString(16)}` : m.toString("latin1", 16, 24)));
    assert.deepEqual(first.slice(0, 21), ["PINFPNam", "CAEX:0x30101", "CAEX:0x20100", "SDMXSXSr", ...Array(16).fill("SDMXSXUS"), "CAEX:0x20200"], "PNam, LaserFeedList, EnterShow, SXSr, 16 × SXUS, FixtureListRequest");
    assert.deepEqual(Buffer.concat(stub.received.slice(3, 20)), Buffer.concat(REAL_DECLARATION), "the declaration bytes, exactly");
    assert.ok(logs.includes("SDMX Capa received: 2, 3, 4, 101, 102, 105"), logs.join("\n"));
    assert.ok(logs.includes("declared sACN universes 1-16 (SXSr + 16 SXUS)"));
    // Capture enters a show again on the same connection: no second declaration on it
    stub.enterShow("SDMX 2");
    await sleep(150);
    assert.equal(stub.received.filter((m) => m.toString("latin1", 16, 20) === "SDMX").length, 17, "once per connection");
    // ChBk
    stub.push(REAL_CHBK[0][0]);
    stub.chbk(2, 10, [1, 2], 1);
    const real = REAL_CHBK[0][0];
    stub.push(withSize(real.subarray(0, real.length - 1), real.length - 1));
    stub.push(Buffer.concat([buildHeader(HEADER_SIZE + 4 + 3, "SDMX"), Buffer.from("UNam"), Buffer.from([0, 0x41, 0])]));
    for (let i = 0; i < 50 && levels.length < 2; i++) await sleep(20);
    await sleep(100);
    assert.deepEqual(levels, [REAL_CHBK[0][1], { blind: 1, universeIndex: 1, firstChannel: 9, levels: [1, 2] }], "the real ChBk and the Blind one (the receiver decides about Blind); not the truncated one");
    assert.ok(logs.some((l) => /^SDMX ChBk malformed \(need 4 byte.*\); ignored\. hex: 43 49 54 50 01 00 00 00 21 00 00 00/.test(l)), logs.join("\n"));
    assert.ok(logs.some((l) => /^SDMX UNam received \(not used\): /.test(l)));
    assert.equal(s.sent.declarations, 1);
    // a reconnect declares again, after its own EnterShow
    const n0 = stub.received.length;
    stub.drop();
    for (let i = 0; i < 100 && s.sent.declarations < 2; i++) await sleep(20);
    await sleep(100);
    const again = stub.received.slice(n0).map((m) => (m.toString("latin1", 16, 20) === "CAEX" ? `CAEX:0x${m.readUInt32LE(20).toString(16)}` : m.toString("latin1", 16, 24)));
    assert.deepEqual(again.slice(0, 21), ["PINFPNam", "CAEX:0x30101", "CAEX:0x20100", "SDMXSXSr", ...Array(16).fill("SDMXSXUS"), "CAEX:0x20200"]);
    assert.equal(s.sent.declarations, 2);
    for (const m of stub.received) if (m.toString("latin1", 16, 20) === "SDMX") assert.ok(isWellFormedDeclaration(m), "only well-formed declarations ever left");
  } finally {
    await s.stop();
    await stub.close();
  }
});

test("v0.10.0: a FixtureList event says whether it came after our SDMX declaration on this connection (only those can carry Capture's patch); the flag resets on a new connection", async () => {
  const fixtures = [{ mfr: "M", name: "F", mode: "S", channels: 1, channel: 1, identifier: 5 }];
  const conns: net.Socket[] = [];
  const server = net.createServer((c) => {
    conns.push(c);
    const framer = new CitpFramer();
    c.on("data", (d) => {
      for (const m of framer.push(d).messages) {
        // EnterShow and a list in ONE write: the list reaches the plugin before its declaration can have left
        if (m.toString("latin1", 16, 24) === "PINFPNam") c.write(Buffer.concat([buildEnterShowMessage("FLAG"), buildPatchMessage(fixtures)]));
        if (m.toString("latin1", 16, 24) === "SDMXSXUS" && m[24] === 15) c.write(buildPatchMessage(fixtures)); // right after the last SXUS
      }
    });
    c.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const s = new CitpSession({ host: "127.0.0.1", port: (server.address() as net.AddressInfo).port, timing: { backoffMin: 50, backoffMax: 100, rerequestMs: 60_000, firstRetryMs: 60_000, discoverMs: 50 } });
  const flags: boolean[] = [];
  s.on("list", (e) => flags.push(e.declared));
  s.start();
  try {
    for (let i = 0; i < 100 && flags.length < 2; i++) await sleep(20);
    assert.deepEqual(flags.slice(0, 2), [false, true], "the list that came with EnterShow: before the declaration; the one after the last SXUS: after");
    const n = flags.length;
    conns[0].destroy();
    for (let i = 0; i < 100 && flags.length < n + 2; i++) await sleep(20);
    assert.deepEqual(flags.slice(n, n + 2), [false, true], "the flag resets on a new connection and is set again after its declaration");
  } finally {
    await s.stop();
    for (const c of conns) c.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ------------------------------------------------------------------ engine overlay

const MD = "bbbbbbbb-0000-0000-0000-0000000000c9";
const channelsOf = (list: SynthChannel[]) => {
  const l = loadChannels(buildObject(buildModeBlock({ guid: MD, channels: list })), MD, list.length, drivenSignature);
  assert.ok(l.ok, l.error);
  return l.channels;
};
const CH = channelsOf(movingHead());
const MODEL = buildModel(CH);
const MAP = mapChannels(CH);
const target = (key: string, address: number, universe = 1): Target => ({ key, universe, address, map: MAP, model: MODEL });
const P = (name: string) => MODEL.byName.get(name.toLowerCase())!;
const memGlobals = () => {
  const state = { obj: {} as Record<string, unknown> };
  return { g: new GlobalSettings({ get: async () => JSON.parse(JSON.stringify(state.obj)), set: async (o) => void (state.obj = JSON.parse(JSON.stringify(o))) }), state };
};
// movingHead offsets: 0/1 Pan, 2/3 Tilt, 4 Pan/Tilt Speed, 5 Dimmer, 6 Shutter, 7 Red, 8 Green, 9 Blue, 10 White, 11 Amber, 12/13 Zoom

test("engine: a frame = untouched channels at their stored values < Capture's levels < channels the deck set; unknown slots 0; only universes with a touched fixture are sent", () => {
  const engine = new DmxEngine({ transport: () => ({ send: () => undefined, close: async () => undefined }), setInterval: () => "H", clearInterval: () => undefined });
  const A = target("A", 285);
  engine.adjust([{ target: A, params: [P("Pan")] }], () => 0.75);
  const b = 284;
  let s = engine.slots(1);
  assert.equal((s[b] << 8) | s[b + 1], Math.round(0.75 * 65535));
  assert.equal(s[b + 5], 255, "A's dimmer: home (never set, nothing reported)");
  assert.equal(s[443], 0, "a slot nobody set or reported: 0");
  // Capture reports: A's tilt + dimmer (deck did not set them), A's pan (the deck did), another fixture's slots, a spare slot
  engine.captureLevels(1, b + 2, [10, 20, 0, 77]); // tilt 10/20, speed 0, dimmer 77
  engine.captureLevels(1, b, [1, 2]); // pan: the deck set it -> ignored in the frame
  engine.captureLevels(1, 443, [22, 179, 220, 176]);
  engine.captureLevels(1, 49, [5, 6, 7, 8]);
  engine.captureLevels(3, 0, [99]); // a universe the deck does not send
  s = engine.slots(1);
  assert.equal((s[b] << 8) | s[b + 1], Math.round(0.75 * 65535), "deck-set pan wins over Capture's level");
  assert.deepEqual([s[b + 2], s[b + 3], s[b + 5]], [10, 20, 77], "A's untouched tilt and dimmer at Capture's levels");
  assert.deepEqual([...s.subarray(443, 447)], [22, 179, 220, 176], "another fixture rides at Capture's levels");
  assert.deepEqual([...s.subarray(49, 53)], [5, 6, 7, 8], "unconfigured slots: Capture's levels");
  assert.equal(s[b + 7], 255, "A's red: home (not reported)");
  assert.deepEqual(engine.universes, [1], "universe 3 is not sent because Capture reported something on it");
  assert.equal(engine.knownLevel(3, 0), 99);
  assert.equal(engine.knownLevel(1, 200), undefined);
});

test("engine: Capture's levels survive release() and are cleared by clearCapture (LeaveShow / show change); a value the deck set later replaces an older ChBk value for good", async () => {
  const mem = new ValueMemory(memGlobals().g, 10_000);
  const engine = new DmxEngine({ transport: () => ({ send: () => undefined, close: async () => undefined }), setInterval: () => "H", clearInterval: () => undefined, resume: (k) => mem.get("S", k), remember: (k, v) => mem.set("S", k, v) });
  const A = target("A", 285);
  const B = target("B", 444);
  engine.captureLevels(1, 443 + 5, [200]); // B dimmer reported 200 while B is untouched
  engine.adjust([{ target: B, params: [P("Dimmer")] }], () => 50 / 255); // then the deck sets B's dimmer to 50
  assert.equal(engine.slots(1)[448], 50);
  await engine.release(); // Deck OFF
  engine.adjust([{ target: A, params: [P("Pan")] }], () => 0.1); // next ON period: only A is driven
  const s = engine.slots(1);
  assert.equal(s[448], 50, "B's dimmer stays at the deck's 50, not the older reported 200");
  engine.captureLevels(1, 443, [22, 179]);
  await engine.release();
  engine.adjust([{ target: A, params: [P("Pan")] }], () => 0.2);
  assert.deepEqual([...engine.slots(1).subarray(443, 445)], [22, 179], "Capture's levels survived Deck OFF -> ON");
  engine.clearCapture();
  assert.deepEqual([...engine.slots(1).subarray(443, 449)], [0, 0, 0, 0, 0, 0], "cleared with the show");
  // a fixture touched for the first time starts from its stored / home values even where nothing was reported
  engine.adjust([{ target: B, params: [P("Pan")] }], () => 0.3);
  const s2 = engine.slots(1);
  assert.equal(s2[448], 50, "B dimmer resumes from the store (50)");
  assert.equal(s2[443 + 7], 255, "B red: home");
});

test("engine (v0.9.0): takeFromCapture gives Capture the parameters it reported — values, store, and the deck loses ownership (top layer); a knob turn takes them back from Capture's value", () => {
  const mem = new ValueMemory(memGlobals().g, 10_000);
  const engine = new DmxEngine({ transport: () => ({ send: () => undefined, close: async () => undefined }), setInterval: () => "H", clearInterval: () => undefined, resume: (k) => mem.get("S", k), remember: (k, v) => mem.set("S", k, v) });
  const A = target("A", 1);
  engine.adjust([{ target: A, params: [P("Pan")] }], () => 0.4);
  assert.equal(engine.isDeckSet("A", P("Pan").id), true);
  assert.equal(engine.isDeckSet("A", P("Tilt").id), false);
  assert.equal(engine.isDeckSet("nobody", P("Tilt").id), false);
  engine.captureLevels(1, 0, [0xe6, 0x66]); // what Capture reported for the pan bytes (0.9)
  engine.takeFromCapture(A, new Map([[P("Tilt").id, 0.25], [P("Pan").id, 0.9]]));
  assert.equal(engine.paramValue(A, P("Tilt")), 0.25);
  assert.equal(engine.paramValue(A, P("Pan")), 0.9, "the deck-set pan is Capture's now");
  assert.equal(engine.isDeckSet("A", P("Pan").id), false, "the deck no longer owns it");
  assert.equal(mem.get("S", "A")!.get(P("Pan").id), 0.9, "stored");
  const s = engine.slots(1);
  assert.deepEqual([s[0], s[1]], [0xe6, 0x66], "the frame carries Capture's pan");
  engine.adjust([{ target: A, params: [P("Pan")] }], (c) => c + 0.01);
  assert.equal(engine.isDeckSet("A", P("Pan").id), true, "the knob takes it back");
  assert.equal(engine.paramValue(A, P("Pan")), 0.91, "continuing from Capture's 0.9, not the old 0.4");
  // an untouched fixture: only the store
  const B = target("B", 100);
  engine.takeFromCapture(B, new Map([[P("Dimmer").id, 0.5]]));
  assert.equal(engine.isTouched("B"), false);
  assert.equal(mem.get("S", "B")!.get(P("Dimmer").id), 0.5);
  assert.equal(engine.paramValue(B, P("Dimmer")), 0.5, "shown (and resumed) from the store");
});

// ------------------------------------------------------------------ service

async function serviceRig() {
  const FX = "aaaaaaaa-0000-0000-0000-0000000000c1";
  const objects: Record<string, Buffer> = { [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) };
  const show = new ShowModel({ libraryPath: "/x", open: () => ({ libPath: "x", readObjectByGuid: (g: string) => objects[g], close: () => undefined }) as never });
  const mem = new ValueMemory(memGlobals().g, 10_000);
  const logs: string[] = [];
  const engine = new DmxEngine({ transport: () => ({ send: () => undefined, close: async () => undefined }), setInterval: () => "H", clearInterval: () => undefined, resume: (k) => mem.get(show.showName, k), remember: (k, v) => mem.set(show.showName, k, v) });
  const svc = new FixtureService(show, new SetupStore(memGlobals().g), engine, (l) => logs.push(l));
  const mk = (index: number, channel: number) => ({
    index, identifier: 900 + index, manufacturer: "M", name: `F${index}`, mode: "Std", channelCount: 14, isDimmer: 0,
    ids: [{ type: 2, name: "", size: 16, hex: "", guid: null, guidRaw: FX, value: null }, { type: 3, name: "", size: 16, hex: "", guid: null, guidRaw: MD, value: null }, { type: 4, name: "", size: 16, hex: "", guid: null, guidRaw: `00000000-0000-0000-0000-00000000090${index}`, value: null }],
    patched: 0, universe: 0, universeChannel: 0, unit: "", channel, circuit: "", note: "", position: [0, 0, 0] as [number, number, number], angles: [0, 0, 0] as [number, number, number],
  });
  show.setConnected(true);
  show.setShowName("S");
  show.applyList(0, [mk(0, 203), mk(1, 202), mk(2, 201)]);
  const [A, B, C] = show.fixtures.slice().sort((x, y) => y.channel - x.channel); // 203, 202, 201
  await svc.setAddress(A.key, { universe: 1, address: 285 });
  await svc.setAddress(B.key, { universe: 1, address: 444 });
  // C (Ch 201) has no address: not configured
  return { show, svc, engine, mem, logs, A, B, C };
}

test("service (v0.9.0): ChBk on a configured untouched fixture -> overlay + store + strips; on a channel the knob set -> Capture takes it (frames, store, strip, one 'took' line); Blind=1 ignored; unconfigured slots -> overlay only; LeaveShow clears levels and ownership", async () => {
  const { show, svc, engine, mem, logs, A, B } = await serviceRig();
  svc.onSelectionEvent([900]); // Ch 203
  assert.equal(svc.attrRotate(0, 10, false), true); // A pan 50 % -> 60 %
  const aPan = Math.round(0.6 * 65535);
  // B's pan/tilt (the real ChBk vector)
  svc.onCaptureLevels(REAL_CHBK[0][1]);
  assert.ok(logs.includes("Capture levels u1 a444-447 = 22,179,220,176 -> Ch 202 ch 1-4"), logs.join("\n"));
  const s = engine.slots(1);
  assert.deepEqual([...s.subarray(443, 447)], [22, 179, 220, 176], "B rides at Capture's levels");
  assert.equal((s[284] << 8) | s[285], aPan, "A keeps the knob value");
  const stored = mem.get("S", B.key)!;
  assert.equal(Math.round(stored.get("ch0")! * 65535), (22 << 8) | 179, "B pan stored (16-bit exact)");
  assert.equal(Math.round(stored.get("ch2")! * 65535), (220 << 8) | 176, "B tilt stored");
  // B selected: the strip shows the Capture value as the remembered (~) value
  svc.onSelectionEvent([901]);
  const r = svc.attrReadout(0);
  assert.equal(r.label, "Pan");
  assert.equal(r.touched, false);
  assert.equal(Math.round(r.value! * 65535), (22 << 8) | 179);
  svc.onSelectionEvent([900]);
  // the mouse moves A's pan (the knob set it) and A's tilt: Capture takes both
  const n0 = logs.length;
  svc.onCaptureLevels({ blind: 0, universeIndex: 0, firstChannel: 284, levels: [0xbf, 0x9f, 64, 0] });
  const capPan = (0xbf << 8) | 0x9f;
  const s2 = engine.slots(1);
  assert.equal((s2[284] << 8) | s2[285], capPan, "the frame carries Capture's pan now (last move wins)");
  assert.deepEqual([s2[286], s2[287]], [64, 0], "A's tilt follows Capture");
  assert.equal(Math.round(svc.attrReadout(0).value! * 65535), capPan, "A's pan strip shows Capture's value");
  assert.equal(Math.round(svc.attrReadout(1).value! * 65535), 64 << 8, "A's tilt strip follows Capture");
  assert.equal(Math.round(mem.get("S", A.key)!.get("ch0")! * 65535), capPan, "the store takes Capture's pan");
  assert.equal(engine.isDeckSet(A.key, "ch0"), false);
  const newLogs = logs.slice(n0);
  assert.ok(newLogs.includes("Capture levels u1 a285-288 = 191,159,64,0 -> Ch 203 ch 1-4"), newLogs.join("\n"));
  assert.deepEqual(newLogs.filter((l) => /^Capture took/.test(l)), [`Capture took Ch 203 "Pan" (knob 60.0 % -> Capture ${((capPan / 65535) * 100).toFixed(1)} %)`], "one took line, for the pan only (the knob never set the tilt)");
  assert.ok(!logs.some((l) => /disagree/.test(l)), "the old disagree line is gone");
  // the knob takes it back, continuing from Capture's value
  assert.equal(svc.attrRotate(0, 1, false), true);
  const back = Math.round((Math.round((capPan / 65535 + 0.01) * 10000) / 10000) * 65535);
  const s3 = engine.slots(1);
  assert.equal((s3[284] << 8) | s3[285], back, "knob +1 % from Capture's pan, not from 60 %");
  assert.equal(engine.isDeckSet(A.key, "ch0"), true);
  // Blind
  const before = Buffer.from(engine.slots(1));
  const n2 = logs.length;
  svc.onCaptureLevels({ blind: 1, universeIndex: 0, firstChannel: 448, levels: [9] });
  assert.deepEqual(Buffer.from(engine.slots(1)), before, "Blind=1 changes nothing");
  assert.deepEqual(logs.slice(n2), ["Capture levels u1 a449 Blind=1: blind (preview) levels, ignored"]);
  assert.equal(mem.get("S", B.key)!.get("ch5"), undefined);
  // unconfigured slots (C has no address; slots 50-53 belong to nobody), and a block that straddles B's end
  svc.onCaptureLevels({ blind: 0, universeIndex: 0, firstChannel: 49, levels: [5, 6, 7, 8] });
  assert.ok(logs.includes("Capture levels u1 a50-53 = 5,6,7,8 (no configured fixture) -> overlay only"));
  assert.deepEqual([...engine.slots(1).subarray(49, 53)], [5, 6, 7, 8]);
  svc.onCaptureLevels({ blind: 0, universeIndex: 0, firstChannel: 455, levels: [40, 41, 42, 43] }); // B ch 13-14 (zoom coarse + fine) and 2 slots past B
  assert.ok(logs.includes("Capture levels u1 a456-459 = 40,41,42,43 -> Ch 202 ch 13-14; 2 slot(s) on no configured fixture -> overlay only"), logs.slice(-3).join("\n"));
  // LeaveShow: Capture's levels and the deck's ownership go with the show
  svc.onShowGone("Capture left the show");
  show.clear();
  assert.equal(engine.knownLevel(1, 49), undefined);
  assert.equal(engine.knownLevel(1, 443), undefined);
  assert.equal(engine.isDeckSet(A.key, "ch0"), false, "ownership cleared");
  assert.equal(engine.active, false, "output released");
  assert.equal(svc.selection.view().primary, undefined, "selection cleared");
});

test("service (v0.9.0): a 16-bit parameter the knob owns, reported on its coarse byte only: the fine byte keeps the knob's last-sent value (no jump); 'took' logged at most once per parameter per second with the held-back count", async () => {
  const { svc, engine, logs, A } = await serviceRig();
  svc.onSelectionEvent([900]);
  svc.attrRotate(0, 10, false); // pan 60 % = 0x9999
  const raw = Math.round(0.6 * 65535);
  assert.equal(raw & 0xff, 0x99);
  svc.onCaptureLevels({ blind: 0, universeIndex: 0, firstChannel: 284, levels: [0x40] }); // coarse only
  const s = engine.slots(1);
  assert.deepEqual([s[284], s[285]], [0x40, raw & 0xff], "coarse from Capture, fine = the knob's last-sent fine byte");
  assert.equal(engine.knownLevel(1, 285), raw & 0xff, "the fine byte was written into the overlay");
  assert.equal(Math.round(engine.paramValue({ key: A.key, universe: 1, address: 285, map: undefined as never, model: undefined as never }, { id: "ch0", home: 0.5 } as never) * 65535), (0x40 << 8) | (raw & 0xff));
  // the fine byte alone, while the deck owns the parameter again: the coarse keeps the knob's value
  svc.attrRotate(0, 1, false);
  const raw2 = Math.round(Math.round((((0x40 << 8) | (raw & 0xff)) / 65535 + 0.01) * 10000) / 10000 * 65535);
  svc.onCaptureLevels({ blind: 0, universeIndex: 0, firstChannel: 285, levels: [0x07] }); // fine only
  const s2 = engine.slots(1);
  assert.deepEqual([s2[284], s2[285]], [raw2 >> 8, 0x07], "fine from Capture, coarse = the knob's last-sent coarse byte");
  // rate limit: the second take within 1 s is held back and counted into the next line
  const took = logs.filter((l) => /^Capture took Ch 203 "Pan"/.test(l));
  assert.equal(took.length, 1, `one took line within the second (${took.join(" | ")})`);
  await sleep(1050);
  svc.attrRotate(0, 1, false);
  svc.onCaptureLevels({ blind: 0, universeIndex: 0, firstChannel: 284, levels: [0x50, 0] });
  const took2 = logs.filter((l) => /^Capture took Ch 203 "Pan"/.test(l));
  assert.equal(took2.length, 2);
  assert.match(took2[1], /\(\+1 more not logged\)$/);
});

test("service (v0.9.0): a burst of 31 single-slot ChBk for one fixture within 20 ms: all applied, ONE summary line; a lone single-slot message keeps its own line", async () => {
  const { svc, engine, logs, B } = await serviceRig();
  const n0 = logs.length;
  const slotsB = Array.from({ length: 14 }, (_, i) => 443 + i);
  const t0 = Date.now();
  for (let k = 0; k < 31; k++) {
    const slot = slotsB[k % 14];
    svc.onCaptureLevels({ blind: 0, universeIndex: 0, firstChannel: slot, levels: [(k * 7) & 0xff] });
  }
  assert.ok(Date.now() - t0 < 20, "sent within 20 ms");
  // every message applied: the last value per slot is in the overlay
  for (let k = 17; k < 31; k++) assert.equal(engine.knownLevel(1, slotsB[k % 14]), (k * 7) & 0xff);
  assert.equal(logs.slice(n0).filter((l) => /^Capture levels/.test(l)).length, 0, "nothing logged yet (the burst is still open)");
  await sleep(120);
  assert.deepEqual(logs.slice(n0).filter((l) => /^Capture levels/.test(l)), ["Capture levels u1: 31 slot(s) -> Ch 202 (burst)"]);
  assert.ok(B);
  const n1 = logs.length;
  svc.onCaptureLevels({ blind: 0, universeIndex: 0, firstChannel: 448, levels: [128] });
  await sleep(120);
  assert.deepEqual(logs.slice(n1), ["Capture levels u1 a449 = 128 -> Ch 202 ch 6"]);
});

test("service/engine: ChBk alone never starts a universe (nothing touched -> no output, however many levels arrive)", async () => {
  const { svc, engine } = await serviceRig();
  svc.onCaptureLevels(REAL_CHBK[0][1]);
  svc.onCaptureLevels({ blind: 0, universeIndex: 1, firstChannel: 0, levels: [1, 2, 3] });
  assert.equal(engine.active, false, "no output");
  assert.deepEqual(engine.universes, []);
});
