// Dev check (not part of npm test): the real SetupServer + the real page in Chromium, with a fake command handler.
// Types into the Universe/Address fields, checks that each change is sent at once, inline errors, auto-fill, re-read, and takes screenshots.
// Needs Playwright:  npm i -g playwright     Run:  node --import tsx scripts/check-setup-page.mjs /tmp/setup-shots
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SetupServer } from "../src/fixtures/setupServer.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright", { paths: [execSync("npm root -g").toString().trim(), process.cwd()] }));
const out = process.argv[2] ?? "/tmp/setup-shots";
fs.mkdirSync(out, { recursive: true });

const fx = (key, channel, name, extra = {}) => ({ key, channel, manufacturer: "M", name, mode: "Std", channelCount: 14, typeKey: "T1", position: "SL 4.0 · DS 2.0 · H 6.0", hasPanTilt: true, parsed: true, parseError: null, notes: [], addr: null, issues: [], controllable: false, ...extra });
const fixtures = [fx("a1", 203, "Rogue R2X Wash"), fx("a2", 204, "Rogue R2X Wash"), fx("b1", 9, "Par Can", { hasPanTilt: false, typeKey: "T2", channelCount: 3 }), fx("c1", 12, "Odd Fixture", { parsed: false, parseError: "mode block has 3 channel(s) but Capture's fixture list says ChannelCount=14", hasPanTilt: false, typeKey: "T3" })];
const view = () => ({ status: "ok", error: null, showName: "FISH WP", fixtures: fixtures.map((f) => ({ ...f, controllable: !!f.addr && f.parsed })), controllable: fixtures.filter((f) => f.addr && f.parsed).length, active: false, universes: [], blackoutWarning: "While output is on, every universe you touch is sent in full: all slots that are not set by a fixture you touched are 0. That BLACKS OUT anything else on that universe, including fixtures that are not set up here." });
const got = [];
const server = new SetupServer({
  uiDir: path.resolve("com.rezabehjat.capture.sdPlugin/ui"),
  handle: async (m) => {
    got.push(m);
    let error = null;
    const f = fixtures.find((x) => x.key === m.key);
    if (m.cmd === "set") { if (m.address > 512) error = "address must be 1–512"; else f.addr = { universe: m.universe, address: m.address }; }
    if (m.cmd === "clear") f.addr = null;
    if (m.cmd === "autofill") { let a = m.address; for (const k of m.keys) { const x = fixtures.find((y) => y.key === k); x.addr = { universe: m.universe, address: a }; a += x.channelCount; } }
    return { view: view(), error };
  },
});
const url = await server.url();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const failed = [];
page.on("response", (r) => { if (r.status() >= 400) failed.push(r.status() + " " + r.url()); });
await page.goto(url);
await page.waitForSelector(".fx");
assert.equal(await page.locator(".fx").count(), 2, "only pan/tilt fixtures that parsed are listed");
assert.match(await page.textContent("#show"), /FISH WP.*4 fixtures, 0 controllable/);
assert.match(await page.textContent("#blackout"), /BLACKS OUT/);
await page.screenshot({ path: path.join(out, "1-empty.png"), fullPage: true });

// typing universe then address: one "set" after the second field, saved at once (no Save button)
got.length = 0;
await page.fill(".fx[data-key=a1] .u", "1");
await page.dispatchEvent(".fx[data-key=a1] .u", "change");
assert.equal(got.length, 0, "one field alone sends nothing");
await page.fill(".fx[data-key=a1] .a", "285");
await page.dispatchEvent(".fx[data-key=a1] .a", "change");
await page.waitForFunction(() => /Controllable \(1\/285/.test(document.querySelector('.fx[data-key="a1"] .st').textContent));
assert.deepEqual(got.map((m) => [m.cmd, m.key, m.universe, m.address]), [["set", "a1", 1, 285]]);
assert.match(await page.textContent("#show"), /1 controllable/);
// inline error
await page.fill(".fx[data-key=a2] .u", "1");
await page.fill(".fx[data-key=a2] .a", "999");
await page.dispatchEvent(".fx[data-key=a2] .a", "change");
await page.waitForFunction(() => /512/.test(document.querySelector("#err").textContent));
assert.match(await page.textContent('.fx[data-key="a2"] .st'), /512/, "the error is also shown right under the row that was edited");
await page.screenshot({ path: path.join(out, "2-error.png"), fullPage: true });
// auto-fill, show all, re-read
await page.fill("#fill-u", "2");
await page.fill("#fill-a", "1");
await page.click("#fill-go");
await page.waitForFunction(() => /Controllable \(2\/15/.test(document.querySelector('.fx[data-key="a2"] .st').textContent));
await page.check("#all");
assert.equal(await page.locator(".fx").count(), 4);
assert.match(await page.textContent('.fx[data-key="c1"] .st'), /not read safely/);
got.length = 0;
await page.click("#resync");
await page.waitForFunction(() => document.querySelector("#show").textContent.includes("FISH WP"));
assert.ok(got.some((m) => m.cmd === "resync"));
await page.screenshot({ path: path.join(out, "3-filled-all.png"), fullPage: true });
// the page refreshes itself (poll): a change made elsewhere shows up
fixtures[1].addr = { universe: 3, address: 7 };
await page.waitForFunction(() => document.querySelector('.fx[data-key="a2"] .u').value === "3", null, { timeout: 6000 });
assert.deepEqual(errors, [], "no page errors");
assert.deepEqual(failed, [], "every request answered 2xx: " + failed.join(", "));
// the page with a wrong token gets nothing
const bad = await browser.newPage();
const r = await bad.goto(url.replace(/t=[0-9a-f]+/, "t=nope"));
assert.equal(r.status(), 403);
await browser.close();
await server.close();
console.log("setup page OK — screenshots in " + out);
