import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, ENTRIES, actionName, uuidOf } from "../src/catalog/index.ts";
import { buildManifest, type Manifest } from "../src/catalog/manifest.ts";
import { dialUuid, kebab, toggleUuid, PROPERTY_ICON, parseNamedUuid } from "../src/lib/named.ts";
import { BOOL_PROPERTIES, NUMBER_PROPERTIES } from "../src/lib/properties.ts";
import { VERSION } from "../src/version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sd = path.join(root, "com.rezabehjat.capture.sdPlugin");
const base = JSON.parse(fs.readFileSync(path.join(root, "manifest.base.json"), "utf8")) as Manifest;
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const built = buildManifest(base, pkg.version);
const onDisk = JSON.parse(fs.readFileSync(path.join(sd, "manifest.json"), "utf8")) as Manifest;

test("the committed manifest.json is what the generator produces (run `npm run gen`)", () => {
  assert.deepEqual(onDisk, built);
});

test("one action per catalog entry, unique UUIDs, '<Category>: <Title>' names", () => {
  const byUuid = new Map(built.Actions.map((a) => [a.UUID, a]));
  assert.equal(byUuid.size, built.Actions.length, "all UUIDs unique");
  assert.equal(new Set(built.Actions.map((a) => a.Name)).size, built.Actions.length, "all names unique");
  for (const e of ENTRIES) {
    const a = byUuid.get(uuidOf(e));
    assert.ok(a, `action for ${uuidOf(e)}`);
    assert.equal(a.Name, actionName(e));
    assert.deepEqual(a.Controllers, ["Keypad"]);
    assert.equal(a.PropertyInspectorPath, "ui/inspector.html");
  }
  assert.equal(built.Actions.filter((a) => a.UUID.startsWith("com.rezabehjat.capture.cmd.")).length, ENTRIES.length);
});

test("actions are grouped by category order and 'Category:' name prefix (the manifest has no per-action group)", () => {
  const names = built.Actions.filter((a) => a.UUID.includes(".cmd.")).map((a) => a.Name);
  let last = -1;
  for (const n of names) {
    const cat = CATEGORIES.findIndex((c) => n.startsWith(`${c.title}: `));
    assert.ok(cat >= 0, n);
    assert.ok(cat >= last, `${n} out of category order`);
    last = cat;
  }
});

test("named dials for every number property and toggles for both booleans; generic actions unchanged", () => {
  for (const p of NUMBER_PROPERTIES) {
    const a = built.Actions.find((x) => x.UUID === dialUuid(p))!;
    assert.ok(a, p.id);
    assert.equal(a.Name, `Dial: ${p.label}`);
    assert.deepEqual(a.Controllers, ["Encoder"]);
    assert.equal((a.Encoder as { layout: string }).layout, "layouts/dial.json");
    assert.ok(PROPERTY_ICON[p.id]);
  }
  for (const p of BOOL_PROPERTIES) assert.equal(built.Actions.find((x) => x.UUID === toggleUuid(p))?.Name, `Toggle: ${p.label}`);
  const names = built.Actions.map((a) => a.Name);
  for (const n of ["Dial: Exposure", "Dial: Ambient", "Dial: Bloom", "Dial: White Balance", "Dial: Flare Streaks"]) assert.ok(names.includes(n), n);
  for (const g of ["Capture Command", "Capture Tab", "Camera Slot", "Store Modifier", "Show Position", "View Dial", "View Toggle", "Connection"]) assert.ok(names.includes(g), g);
  assert.equal(built.Actions.find((a) => a.Name === "View Dial")?.UUID, "com.rezabehjat.capture.dial");
  for (const u of built.Actions.map((a) => a.UUID)) assert.match(u, /^[a-z0-9.-]+$/, "Stream Deck UUIDs: lowercase, digits, '.' and '-' only");
});

test("kebab UUIDs and parseNamedUuid", () => {
  assert.equal(kebab("exposureAdjustment"), "exposure-adjustment");
  assert.equal(dialUuid({ id: "flareStreaks" }), "com.rezabehjat.capture.dial.flare-streaks");
  assert.deepEqual(parseNamedUuid("com.rezabehjat.capture.dial.flare-streaks"), { kind: "dial", property: "flareStreaks" });
  assert.deepEqual(parseNamedUuid("com.rezabehjat.capture.toggle.laser-flicker-effect"), { kind: "toggle", property: "laserFlickerEffect" });
  assert.deepEqual(parseNamedUuid("com.rezabehjat.capture.cmd.view.plot"), { kind: "cmd", category: "view", id: "plot" });
  assert.equal(parseNamedUuid("com.rezabehjat.capture.dial"), undefined);
});

test("every image the manifest names exists (PNG and @2x)", () => {
  const files: string[] = [];
  for (const a of built.Actions) {
    files.push(a.Icon);
    for (const s of a.States) files.push(s.Image);
    if (a.Encoder?.background) files.push(String(a.Encoder.background));
  }
  files.push(String(built.Icon), String(built.CategoryIcon));
  for (const f of new Set(files)) {
    assert.ok(fs.existsSync(path.join(sd, `${f}.png`)), `${f}.png`);
    assert.ok(fs.existsSync(path.join(sd, `${f}@2x.png`)), `${f}@2x.png`);
  }
});

test("version: package.json, src/version.ts and manifest agree (v0.2.0.0)", () => {
  assert.equal(pkg.version, VERSION);
  assert.equal(built.Version, `${VERSION}.0`);
  assert.equal(built.Version, "0.2.0.0");
  assert.equal(built.UUID, "com.rezabehjat.capture");
});

test("dial-only actions are the only Encoder actions", () => {
  for (const a of built.Actions) assert.equal(a.Controllers.includes("Encoder"), a.UUID.startsWith("com.rezabehjat.capture.dial"), a.UUID);
});

test("the built plugin finds its worker: bin/plugin.js points at ../ax/worker.js and that file ships next to bin/", () => {
  const bundle = fs.readFileSync(path.join(sd, "bin/plugin.js"), "utf8");
  assert.ok(bundle.includes("../ax/worker.js"), "worker path is relative to bin/plugin.js");
  assert.ok(fs.existsSync(path.join(sd, "bin/../ax/worker.js")));
  const worker = fs.readFileSync(path.join(sd, "ax/worker.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""); // code only, not the header comment
  for (const banned of ["keystroke", "key code", "CGEvent", "mouseDown", "mouseUp", "postEvent", "moveTo", "launch", "quit"]) assert.ok(!worker.includes(banned), `worker must not contain ${banned}`);
  assert.equal((worker.match(/\.click\(\)/g) ?? []).length, 2, "exactly two click sites: a menu item and a tab radio button");
});
