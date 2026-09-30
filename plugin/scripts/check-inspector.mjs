// Dev check (not part of npm test): loads ui/inspector.html in Chromium for every action, feeds it the
// Stream Deck PI protocol from a fake WebSocket host, exercises the controls, asserts the settings that
// come back, and writes screenshots to the given folder.  Needs Playwright:  npm i -g playwright
//   node scripts/check-inspector.mjs /tmp/pi-shots
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright", { paths: [execSync("npm root -g").toString().trim(), process.cwd()] }));
const out = process.argv[2] ?? "/tmp/pi-shots";
fs.mkdirSync(out, { recursive: true });
const page_url = "file://" + path.resolve("com.rezabehjat.capture.sdPlugin/ui/inspector.html");
const U = "com.rezabehjat.capture";

const enc = (s) => [...s].map((c) => { const cp = c.codePointAt(0); return cp < 32 || cp > 126 || cp === 124 || cp === 92 ? `\\u{${cp.toString(16)}}` : c; }).join("");
const commands = [
  ["View", "Plot"], ["View", "Camera", "Swing to Front"], ["Edit", "Undo", "prefix"], ["Edit", "Delete"], ["Edit", "Duplicate…"], ["View", "Enter Full Screen|Exit Full Screen", "alternates"],
].map(([...p]) => { const match = ["prefix", "alternates"].includes(p.at(-1)) ? p.pop() : "exact"; return { path: p, match, label: p.join(" › "), enabled: true }; });

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.on("listening", r));
const port = wss.address().port;
let toPlugin = [];
let sock;
wss.on("connection", (ws) => {
  sock = ws;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    toPlugin.push(m);
    if (m.event === "sendToPlugin" && m.payload?.cmd === "listMenus") ws.send(JSON.stringify({ event: "sendToPropertyInspector", payload: { event: "menus", commands, error: null } }));
    if (m.event === "sendToPlugin" && m.payload?.cmd === "listCatalogs") ws.send(JSON.stringify({ event: "sendToPropertyInspector", payload: { event: "catalogs", error: null, catalogs: [{ nr: 1, name: "Main", positions: [{ nr: 1, name: "Front" }, { nr: 2, name: "Back" }] }] } }));
  });
});

const browser = await chromium.launch();
async function open(action, settings) {
  toPlugin = [];
  const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(page_url);
  await page.evaluate(([port, action, settings]) => {
    window.connectElgatoStreamDeckSocket(port, "PI-UUID", "registerPropertyInspector", "{}", JSON.stringify({ action, payload: { settings } }));
  }, [port, action, settings]);
  await page.waitForTimeout(300);
  return { page, errors };
}
const lastSettings = () => toPlugin.filter((m) => m.event === "setSettings").at(-1)?.payload;

// --- Capture Command
{
  const { page, errors } = await open(`${U}.command`, { menuPath: ["Edit", "Undo"], match: "prefix" });
  assert.equal(await page.locator("#s-command").isVisible(), true);
  assert.equal(await page.locator("#s-tab").isVisible(), false);
  assert.equal(await page.locator("#cmd option").count() > 6, true);
  assert.equal(await page.locator("#cmd").evaluate((s) => s.options[s.selectedIndex].textContent.trim()), "Undo");
  assert.equal(await page.locator("#hold").isChecked(), false);
  await page.selectOption("#cmd", { label: "Delete" });
  assert.deepEqual(lastSettings().menuPath, ["Edit", "Delete"]);
  assert.equal(await page.locator("#hold").isChecked(), true, "Delete defaults to hold-to-fire");
  await page.selectOption("#cmd", { label: "Camera › Swing to Front" });
  assert.deepEqual(lastSettings().menuPath, ["View", "Camera", "Swing to Front"]);
  assert.equal(await page.locator("#hold").isChecked(), false);
  await page.fill("#path", "File > Export > Save Image…");
  await page.locator("#path").dispatchEvent("change");
  assert.deepEqual(lastSettings().menuPath, ["File", "Export", "Save Image…"]);
  await page.uncheck("#dim");
  assert.equal(lastSettings().dimWhenDisabled, false);
  await page.screenshot({ path: path.join(out, "command.png") });
  assert.deepEqual(errors, []);
}
// --- Tab / Slot / Toggle
{
  const { page, errors } = await open(`${U}.tab`, {});
  await page.selectOption("#tab", "Media");
  assert.equal(lastSettings().tab, "Media");
  await page.screenshot({ path: path.join(out, "tab.png") });
  assert.deepEqual(errors, []);
}
{
  const { page } = await open(`${U}.slot`, { slot: 3 });
  assert.equal(await page.locator("#slot").inputValue(), "3");
  await page.selectOption("#slot", "5");
  assert.equal(lastSettings().slot, 5);
}
{
  const { page } = await open(`${U}.toggle`, { property: "laserFlickerEffect" });
  assert.equal(await page.locator("#tprop").inputValue(), "laserFlickerEffect");
  await page.selectOption("#tview", "0");
  assert.equal(lastSettings().view, "0");
  await page.screenshot({ path: path.join(out, "toggle.png") });
}
// --- Dial
{
  const { page, errors } = await open(`${U}.dial`, { property: "bloom", view: "live" });
  assert.equal(await page.locator("#dprop").inputValue(), "bloom");
  assert.match(await page.locator("#dial-hint").textContent(), /0 … 2/);
  await page.selectOption("#dprop", "whiteBalance");
  assert.equal(lastSettings().property, "whiteBalance");
  assert.equal(await page.locator("#dstep").getAttribute("placeholder"), "100");
  await page.fill("#dstep", "50");
  await page.locator("#dstep").dispatchEvent("change");
  assert.equal(lastSettings().step, 50);
  await page.screenshot({ path: path.join(out, "dial.png") });
  assert.deepEqual(errors, []);
}
// --- Position
{
  const { page, errors } = await open(`${U}.position`, { mode: "auto", catalog: 1, index: 3 });
  assert.equal(await page.locator("#row-index").isVisible(), true);
  assert.equal(await page.locator("#row-position").isVisible(), false);
  await page.selectOption("#mode", "fixed");
  assert.equal(await page.locator("#row-position").isVisible(), true);
  await page.fill("#time", "2.5");
  await page.locator("#time").dispatchEvent("change");
  assert.equal(lastSettings().time, 2.5);
  await page.click("#reload-cats");
  await page.waitForTimeout(200);
  assert.match(await page.locator("#cat-list").textContent(), /Catalog 1: Main/);
  await page.screenshot({ path: path.join(out, "position.png") });
  assert.deepEqual(errors, []);
}
// --- Named command (Handoff 08): nothing to choose, only Hold to fire / Dim when disabled
{
  const { page, errors } = await open(`${U}.cmd.camera.swing-to-front`, {});
  assert.equal(await page.locator("#s-ncmd").isVisible(), true);
  assert.equal(await page.locator("#s-command").isVisible(), false);
  assert.match(await page.locator("#ncmd-what").textContent(), /View › Camera › Swing to Front/);
  assert.equal(await page.locator("#nhold").isChecked(), false);
  assert.equal(await page.locator("#ncmd-warn").isVisible(), false);
  await page.check("#nhold");
  assert.equal(lastSettings().holdToFire, true);
  await page.uncheck("#ndim");
  assert.equal(lastSettings().dimWhenDisabled, false);
  await page.screenshot({ path: path.join(out, "named-command.png") });
  assert.deepEqual(errors, []);
}
{
  const { page } = await open(`${U}.cmd.edit.delete`, {});
  assert.equal(await page.locator("#nhold").isChecked(), true, "Delete holds by default (from the catalog)");
  await page.uncheck("#nhold");
  assert.equal(lastSettings().holdToFire, false);
}
{
  const { page } = await open(`${U}.cmd.file.import-project`, {});
  assert.equal(await page.locator("#ncmd-warn").isVisible(), true, "guessed File paths carry a warning");
}
{
  const { page } = await open(`${U}.cmd.tabs.fixtures`, {});
  assert.equal(await page.locator("#none").isVisible(), true);
  assert.equal(await page.locator("#s-ncmd").isVisible(), false);
}
// --- Named dial (step / reset only) / toggle / show position
{
  const { page, errors } = await open(`${U}.dial.flare-streaks`, {});
  assert.equal(await page.locator("#s-ndial").isVisible(), true);
  assert.equal(await page.locator("#s-dial").isVisible(), false);
  assert.match(await page.locator("#ndial-hint").textContent(), /Flare Streaks: range 1 … 7 \(whole number\)/);
  assert.equal(await page.locator("#ndstep").getAttribute("placeholder"), "1");
  assert.equal(await page.locator("#ndview").count(), 0, "named dials have no view picker (always the live view)");
  await page.fill("#ndreset", "3");
  await page.locator("#ndreset").dispatchEvent("change");
  assert.equal(lastSettings().reset, 3);
  await page.screenshot({ path: path.join(out, "named-dial.png") });
  assert.deepEqual(errors, []);
}
{
  // Named toggles and Show Position keys have no Property Inspector at all (manifest has no PropertyInspectorPath); if opened anyway: nothing to configure.
  const { page } = await open(`${U}.toggle.laser-flicker-effect`, {});
  assert.equal(await page.locator("#none").isVisible(), true);
  const { page: p2 } = await open(`${U}.showpos.3`, {});
  assert.equal(await p2.locator("#none").isVisible(), true);
}
{
  const { page } = await open(`${U}.cmd.camera.position-2`, {});
  assert.match(await page.locator("#ncmd-what").textContent(), /Camera: Store Modifier/);
}
// --- Actions without settings
{
  const { page } = await open(`${U}.connection`, {});
  assert.equal(await page.locator("#none").isVisible(), true);
}
await browser.close();
wss.close();
console.log("inspector checks passed; screenshots in", out);
