// Dev check (not part of npm test): loads ui/fixtures.html in Chromium, feeds it a setup view from a fake Stream Deck WebSocket host,
// exercises the controls and asserts the messages that go back to the plugin. Needs Playwright:  npm i -g playwright
//   node --import tsx scripts/check-fixtures-inspector.mjs /tmp/pi-shots   (tsx: the channel lists are built with the plugin's own code)
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { drivenSignature } from "../src/fixtures/attrs.ts";
import { loadChannels } from "../src/fixtures/modes.ts";
import { buildModel } from "../src/fixtures/pages.ts";
import { channelList } from "../src/fixtures/service.ts";
import { buildModeBlock, buildObject, framingHead, movingHead } from "../test/fixtures/synth.ts";

/** The Setup panel's channel list of a synthetic type, made exactly as the plugin makes it. */
const typeView = (list) => {
  const g = "bbbbbbbb-0000-0000-0000-0000000000d1";
  const l = loadChannels(buildObject(buildModeBlock({ guid: g, channels: list })), g, list.length, drivenSignature);
  return { channels: channelList(l.channels, buildModel(l.channels, l.differOffsets)), unproven: l.warnings.some((w) => w.includes("uniqueness is not proven")) };
};

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright", { paths: [execSync("npm root -g").toString().trim(), process.cwd()] }));
const out = process.argv[2] ?? "/tmp/pi-shots";
fs.mkdirSync(out, { recursive: true });
const url = "file://" + path.resolve("com.rezabehjat.capture.sdPlugin/ui/fixtures.html");
const fx = (key, channel, name, extra = {}) => ({ key, channel, manufacturer: "M", name, mode: "Std", channelCount: 14, typeKey: "T1", position: "SL 4.0 · DS 2.0 · H 6.0", hasPanTilt: true, parsed: true, parseError: null, notes: [], addr: null, issues: [], controllable: false, ...extra });
const view = {
  status: "ok", error: null, showName: "Test Show", controllable: 1, active: false, universes: [],
  blackoutWarning: "While output is on, every universe you touch is sent in full: all slots that are not set by a fixture you touched are 0. That BLACKS OUT anything else on that universe, including fixtures that are not set up here.",
  fixtures: [
    fx("a1", 203, "Rogue R2X Wash", { addr: { universe: 1, address: 285 }, controllable: true }),
    fx("a2", 204, "Rogue R2X Wash"),
    fx("b1", 9, "Par Can", { hasPanTilt: false, typeKey: "T2" }),
    fx("c1", 12, "Odd Fixture", { parsed: false, parseError: "mode block has 3 channel(s) but Capture's fixture list says ChannelCount=14", hasPanTilt: false, typeKey: "T3" }),
    fx("s1", 207, "Framing Spot", { channelCount: 37, typeKey: "T4", unproven: true, addr: { universe: 1, address: 420 } }),
  ],
  types: { T1: typeView(movingHead()), T4: typeView(framingHead()) },
  deck: { on: false, idleSeconds: 120 },
};
assert.equal(view.types.T4.unproven, true, "the synthetic spot is the 'uniqueness not proven' case");
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.on("listening", r));
const got = [];
let sock;
wss.on("connection", (ws) => {
  sock = ws;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    got.push(m);
    if (m.event === "sendToPlugin" && m.payload?.cmd === "get") ws.send(JSON.stringify({ event: "sendToPropertyInspector", payload: { event: "setup", view, error: null } }));
  });
});
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(url);
await page.evaluate((port) => window.connectElgatoStreamDeckSocket(port, "UUID1", "registerPropertyInspector", "{}", JSON.stringify({ action: "com.rezabehjat.capture.fixtures.setup", payload: { settings: {} } })), wss.address().port);
await page.waitForSelector(".fx");
assert.equal(await page.locator(".fx").count(), 3, "only fixtures with pan/tilt that parsed are listed");
assert.match(await page.textContent("#show"), /Test Show.*5 fixtures, 1 controllable/);
// Handoff 21: Deck Control state and the idle time
assert.match(await page.textContent("#deck-state"), /Deck Control is OFF/);
assert.equal(await page.inputValue("#idle-s"), "120");
got.length = 0;
await page.fill("#idle-s", "45");
await page.dispatchEvent("#idle-s", "change");
assert.deepEqual(got.at(-1).payload, { cmd: "idle", seconds: 45 });
// Handoff 20: the Channels list per row and the "check against Capture's patch view" note
assert.equal(await page.isVisible(".fx[data-key=s1] .unproven"), true, "unproven note on the spot");
assert.equal(await page.isVisible(".fx[data-key=a1] .unproven"), false, "no note on the wash");
assert.match(await page.textContent(".fx[data-key=s1] .chans summary"), /Channels \(37\) — check against Capture/);
assert.equal(await page.isVisible(".fx[data-key=s1] .chtbl"), false, "collapsed by default");
await page.click(".fx[data-key=s1] .chans summary");
assert.equal(await page.locator(".fx[data-key=s1] .chtbl tr").count(), 38, "header + 37 channels");
assert.deepEqual(await page.locator(".fx[data-key=s1] .chtbl tr:nth-child(29) td").allTextContents(), ["28", "Shutter 1B", "8-bit", "Shutters 1/3"]);
assert.deepEqual(await page.locator(".fx[data-key=s1] .chtbl tr:nth-child(8) td").allTextContents(), ["7", "Dimmer", "16-bit (fine 8)", "Main"]);
assert.deepEqual(await page.locator(".fx[data-key=s1] .chtbl tr:nth-child(9) td").allTextContents(), ["8", "Dimmer Fine", "fine of 7", ""]);
// a re-sent view keeps the list open
sock.send(JSON.stringify({ event: "sendToPropertyInspector", payload: { event: "setup", view, error: null } }));
await page.waitForTimeout(100);
assert.equal(await page.isVisible(".fx[data-key=s1] .chtbl"), true, "still open after an update");
await page.screenshot({ path: path.join(out, "fixtures-setup-channels.png"), fullPage: true });
await page.click(".fx[data-key=s1] .chans summary");
assert.match(await page.textContent("#blackout"), /BLACKS OUT/);
assert.equal(await page.inputValue(".fx:nth-child(1) .u"), "1");
assert.equal(await page.inputValue(".fx:nth-child(1) .a"), "285");
assert.match(await page.textContent(".fx:nth-child(1) .st"), /Controllable \(1\/285–298\)/);
await page.check("#all");
assert.equal(await page.locator(".fx").count(), 5, "show all lists the rest");
assert.match(await page.textContent(".fx[data-key=c1] .st"), /not read safely/);
await page.uncheck("#all");
// editing both fields sends one set; one field alone sends nothing
got.length = 0;
await page.fill(".fx[data-key=a2] .u", "1");
await page.dispatchEvent(".fx[data-key=a2] .u", "change");
assert.equal(got.filter((m) => m.payload?.cmd === "set").length, 0);
await page.fill(".fx[data-key=a2] .a", "299");
await page.dispatchEvent(".fx[data-key=a2] .a", "change");
assert.deepEqual(got.at(-1).payload, { cmd: "set", key: "a2", universe: 1, address: 299 });
await page.click(".fx[data-key=a2] button");
assert.deepEqual(got.at(-1).payload, { cmd: "clear", key: "a2" });
await page.fill("#fill-u", "2");
await page.fill("#fill-a", "10");
await page.click("#fill-go");
assert.deepEqual(got.at(-1).payload, { cmd: "autofill", keys: ["a1", "a2"], universe: 2, address: 10 });
await page.click("#resync");
assert.equal(got.at(-1).payload.cmd, "resync");
await page.screenshot({ path: path.join(out, "fixtures-setup.png"), fullPage: true });
assert.deepEqual(errors, []);
await browser.close();
wss.close();
console.log("fixtures inspector OK, screenshot in " + out);
