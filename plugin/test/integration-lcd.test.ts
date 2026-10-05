/**
 * End-to-end (Handoff 24, v0.7.3): the Deck state on the four Attribute strips' header line (layouts/attr.json) and on the Deck key,
 * on the REAL built plugin (bin/plugin.js) with a stub CITP server, a synthetic library and the fake Stream Deck application.
 * Every transition is checked in the setFeedback / setImage payloads the plugin sends:
 *   start OFF → Deck ON by key (click, no selection event needed) → FixtureSelection (driving: Ch / address / model / page)
 *   → Page ▶ (slot 3) → empty selection (click) → Deck OFF (off).
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeDeck } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";
import { buildLibraryFile, buildModeBlock, buildObject, movingHead, startPatchStub, type CitpStub } from "./fixtures/synth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../com.rezabehjat.capture.sdPlugin");
const U = "com.rezabehjat.capture";
const A = { setup: `${U}.fixtures.setup`, deck: `${U}.fixtures.deck`, next: `${U}.fixtures.page-next`, attr: [1, 2, 3, 4].map((n) => `${U}.fixture.attr${n}`) };
const FX = "aaaaaaaa-0000-0000-0000-0000000000a7";
const MD = "bbbbbbbb-0000-0000-0000-0000000000a7";
const INST = "00000000-0000-0000-0000-0000000000a7";
const ID = 777;
const GREEN = "#3DD68C";
const AMBER = "#F5B82E";
const TRACK = "#2A2E33";

const deck = new FakeDeck();
const capture = new StubCapture();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lcd-e2e-"));
const lib = path.join(tmp, "Library.c2z");
const sacn = dgram.createSocket("udp4");
let citp: CitpStub;

before(async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, "bin/plugin.js")), "run `npm run build` first");
  fs.writeFileSync(lib, buildLibraryFile({ [FX]: buildObject(buildModeBlock({ guid: MD, channels: movingHead() })) }));
  citp = await startPatchStub([{ mfr: "Test", name: "Rogue R2X Wash", mode: "Std", channels: 14, channel: 202, fixtureGuid: FX, modeGuid: MD, instanceId: INST, position: [2, 6, 2], identifier: ID }], { showName: "LCD SHOW" });
  await new Promise<void>((r) => sacn.bind(0, "127.0.0.1", r));
  await capture.start();
  await deck.start({
    oscPort: capture.port,
    pluginDir,
    fixtures: path.join(here, "fixtures"),
    env: { CAPTURE_TEST_CITP_PORT: String(citp.port), CAPTURE_TEST_CITP_TIMING: "300,1000,1500,800,200", CAPTURE_TEST_LIBRARY: lib, CAPTURE_TEST_SACN_PORT: String(sacn.address().port), CAPTURE_TEST_SACN_NO_MULTICAST: "1" },
  });
});
after(async () => {
  await deck.stop();
  capture.stop();
  await citp.close();
  sacn.close();
});

const ctx = (i: number): string => `attr${i}`;
const header = (i: number): { value: string; color: string; background: string } | undefined => deck.lastFeedback(ctx(i))?.header;
const headers = (): string[] => [0, 1, 2, 3].map((i) => header(i)?.value ?? "?");
const backgrounds = (): string[] => [0, 1, 2, 3].map((i) => header(i)?.background ?? "?");
const keyBg = (): string => /^<svg[^>]*><rect[^>]*fill="(#[0-9A-F]{6})"/i.exec(deck.lastImageRaw("deckkey"))?.[1] ?? "";
const keyTexts = (): string[] => [...deck.lastImageRaw("deckkey").matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
const waitHeaders = (pred: (h: string[]) => boolean, what: string): Promise<unknown> => deck.waitFor(() => pred(headers()) || undefined, 4000, `headers: ${what} (now ${JSON.stringify(headers())})`);
const waitKey = (bg: string, what: string): Promise<unknown> => deck.waitFor(() => keyBg() === bg || undefined, 4000, `Deck key: ${what} (now ${keyBg()} ${JSON.stringify(keyTexts())})`);

test("start OFF: the four headers are the off line (grey on track) and the Deck key is the off image; the Deck key has an empty title", async () => {
  deck.willAppear(A.deck, "deckkey", {});
  for (let i = 0; i < 4; i++) deck.willAppear(A.attr[i], ctx(i), {}, "Encoder");
  deck.willAppear(A.setup, "setup", {});
  deck.inspectorAppeared(A.setup, "setup");
  await deck.waitFor(() => /show "[^"]*": 1 fixture/.test(deck.logText()) || undefined, 8000, "fixture list read (v0.10.0: by the start-up session)");
  deck.sendToPlugin(A.setup, "setup", { cmd: "set", key: INST, universe: 1, address: 444 });
  await waitHeaders((h) => h.join("|") === "DECK OFF|||", "off");
  assert.deepEqual(backgrounds(), [TRACK, TRACK, TRACK, TRACK]);
  await waitKey(TRACK, "off");
  assert.deepEqual(keyTexts(), ["DECK", "OFF"]);
  assert.deepEqual(deck.sent("deckkey", "setTitle").map((m) => m.payload.title), [""], "setTitle(\"\") once, no 'Deck OFF' title");
});

test("Deck ON by key: headers and key go to click without any selection event", async () => {
  const sel0 = deck.logText().match(/Capture selected/g)?.length ?? 0;
  deck.keyDown(A.deck, "deckkey");
  await waitHeaders((h) => h.join("|") === "CLICK A LIGHT|Click a light|in Capture|", "click");
  assert.deepEqual(backgrounds(), [AMBER, AMBER, AMBER, AMBER]);
  await waitKey(AMBER, "click");
  assert.deepEqual(keyTexts(), ["CLICK", "A LIGHT"]);
  assert.equal(deck.logText().match(/Capture selected/g)?.length ?? 0, sel0, "no selection event happened");
});

test("FixtureSelection → driving: headers show DECK ON · Ch 202 · 1/444 · model · page; the key shows DECK ON / Ch 202", async () => {
  await deck.waitFor(() => citp.clients.size === 1 || undefined, 4000, "persistent session");
  citp.select([ID]);
  await waitHeaders((h) => h[0] === "DECK ON" && h[1] === "Ch 202 · 1/444" && h[2] === "Rogue R2X Wash" && /^Main 1\/\d+$/.test(h[3]), "driving");
  assert.deepEqual(backgrounds(), [GREEN, GREEN, GREEN, GREEN]);
  await waitKey(GREEN, "driving");
  assert.deepEqual(keyTexts(), ["DECK ON", "Ch 202"]);
  // the body under the header is the channel readout, as before
  assert.equal(deck.lastFeedback(ctx(0)).name.value, "Pan");
});

test("Page ▶: slot 3 of the header follows the page", async () => {
  const n = Number(/\/(\d+)$/.exec(headers()[3])![1]);
  assert.ok(n > 1, "the test fixture has more than one page");
  deck.willAppear(A.next, "pnext", {});
  deck.keyDown(A.next, "pnext");
  await waitHeaders((h) => new RegExp(` 2/${n}$`).test(h[3]) && !h[3].startsWith("Main"), "page 2");
  assert.equal(headers()[0], "DECK ON");
});

test("an empty selection → back to click (headers and key)", async () => {
  citp.select([]);
  await waitHeaders((h) => h.join("|") === "CLICK A LIGHT|Click a light|in Capture|", "click again");
  await waitKey(AMBER, "click again");
});

test("Deck OFF → off (headers and key)", async () => {
  deck.keyDown(A.deck, "deckkey");
  await waitHeaders((h) => h.join("|") === "DECK OFF|||", "off again");
  assert.deepEqual(backgrounds(), [TRACK, TRACK, TRACK, TRACK]);
  await waitKey(TRACK, "off again");
  // every state was sent: off, click, driving, click, off — in that order — in the header payloads of slot 0 and the key images
  const seq = (xs: string[]): string[] => xs.filter((x, i) => x !== xs[i - 1]);
  assert.deepEqual(seq(deck.sent(ctx(0), "setFeedback").map((m) => m.payload.header?.value).filter(Boolean)), ["DECK OFF", "CLICK A LIGHT", "DECK ON", "CLICK A LIGHT", "DECK OFF"]);
  const bgs = deck.sent("deckkey", "setImage").map((m) => /<rect[^>]*fill="(#[0-9A-F]{6})"/i.exec(decodeURIComponent(String(m.payload.image).split(",")[1]))?.[1]);
  assert.deepEqual(seq(bgs as string[]), [TRACK, AMBER, GREEN, AMBER, TRACK]);
});
