/**
 * End-to-end (Handoff 24, v0.7.3): the header line and the Deck key react to the Deck switch ITSELF, not only to the CITP traffic that
 * usually follows it. Capture is not reachable here (nothing listens on the CITP port), so switching Deck Control ON produces no
 * show/selection event at all: only the Deck change can turn the line amber.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeDeck, sleep } from "./fixtures/fake-deck.ts";
import { StubCapture } from "./fixtures/stub-capture.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../com.rezabehjat.capture.sdPlugin");
const U = "com.rezabehjat.capture";
const deck = new FakeDeck();
const capture = new StubCapture();

before(async () => {
  // a port nothing listens on
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  await capture.start();
  await deck.start({ oscPort: capture.port, pluginDir, fixtures: path.join(here, "fixtures"), env: { CAPTURE_TEST_CITP_PORT: String(port), CAPTURE_TEST_CITP_TIMING: "300,1000,1500,800,200", CAPTURE_TEST_SACN_NO_MULTICAST: "1" } });
});
after(async () => {
  await deck.stop();
  capture.stop();
});

const header = (ctx: string): string | undefined => deck.lastFeedback(ctx)?.header?.value;
const keyBg = (): string => /^<svg[^>]*><rect[^>]*fill="(#[0-9A-F]{6})"/i.exec(deck.lastImageRaw("deckkey"))?.[1] ?? "";

test("Capture unreachable: Deck ON by key turns the header line and the key amber at once (the Deck change alone redraws them)", async () => {
  deck.willAppear(`${U}.fixtures.deck`, "deckkey", {});
  deck.willAppear(`${U}.fixture.attr1`, "a1", {}, "Encoder");
  deck.willAppear(`${U}.fixture.attr2`, "a2", {}, "Encoder");
  await deck.waitFor(() => /brief sync \(start-up\): no fixture list/.test(deck.logText()) || undefined, 12000, "the start-up read failed (nothing listens)");
  await sleep(300);
  assert.equal(header("a1"), "DECK OFF");
  assert.equal(keyBg(), "#2A2E33");
  const n = deck.sent("a1", "setFeedback").length;
  deck.keyDown(`${U}.fixtures.deck`, "deckkey");
  await deck.waitFor(() => (header("a1") === "CLICK A LIGHT" && header("a2") === "Click a light") || undefined, 1500, `header amber (now ${header("a1")})`);
  assert.equal(deck.lastFeedback("a1").header.background, "#F5B82E");
  await deck.waitFor(() => keyBg() === "#F5B82E" || undefined, 1500, "key amber");
  assert.ok(deck.sent("a1", "setFeedback").length > n);
  deck.keyDown(`${U}.fixtures.deck`, "deckkey");
  await deck.waitFor(() => (header("a1") === "DECK OFF" && keyBg() === "#2A2E33") || undefined, 3000, "off again");
});
