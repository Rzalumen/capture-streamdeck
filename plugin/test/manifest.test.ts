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
  for (const p of BOOL_PROPERTIES) assert.equal(built.Actions.find((x) => x.UUID === toggleUuid(p))?.Name, `Look: ${p.label}`);
  const names = built.Actions.map((a) => a.Name);
  for (const n of ["Dial: Exposure", "Dial: Ambient", "Dial: Bloom", "Dial: White Balance", "Dial: Flare Streaks"]) assert.ok(names.includes(n), n);
  // the generic actions keep their UUIDs (keys placed in v0.1/v0.2 keep working); Store Modifier and Connection are renamed into their groups
  for (const g of ["Capture Command", "Capture Tab", "Camera Slot", "Show Position", "View Dial", "View Toggle", "Camera: Store Modifier", "Status: Connection"]) assert.ok(names.includes(g), g);
  assert.equal(built.Actions.find((a) => a.Name === "Camera: Store Modifier")?.UUID, "com.rezabehjat.capture.store");
  assert.equal(built.Actions.find((a) => a.Name === "Status: Connection")?.UUID, "com.rezabehjat.capture.connection");
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

test("version: package.json, src/version.ts and manifest agree (v0.4.1.0)", () => {
  assert.equal(pkg.version, VERSION);
  assert.equal(built.Version, `${VERSION}.0`);
  assert.equal(built.Version, "0.4.1.0");
  assert.equal(built.UUID, "com.rezabehjat.capture");
});

test("dial-only actions are the only Encoder actions", () => {
  for (const a of built.Actions) assert.equal(a.Controllers.includes("Encoder"), a.UUID.startsWith("com.rezabehjat.capture.dial") || a.UUID.startsWith("com.rezabehjat.capture.fixture."), a.UUID);
});

test("the built plugin finds its worker: bin/plugin.js points at ../ax/worker.js and that file ships next to bin/", () => {
  const bundle = fs.readFileSync(path.join(sd, "bin/plugin.js"), "utf8");
  assert.ok(bundle.includes("../ax/worker.js"), "worker path is relative to bin/plugin.js");
  assert.ok(fs.existsSync(path.join(sd, "bin/../ax/worker.js")));
  const worker = fs.readFileSync(path.join(sd, "ax/worker.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""); // code only, not the header comment
  for (const banned of ["keystroke", "key code", "CGEvent", "mouseDown", "mouseUp", "postEvent", "moveTo", "launch", "quit"]) assert.ok(!worker.includes(banned), `worker must not contain ${banned}`);
  assert.equal((worker.match(/\.click\(\)/g) ?? []).length, 2, "exactly two click sites: a menu item and a tab radio button");
});

// ---- Handoff 09: only straight commands in the action list
const GENERIC = ["command", "tab", "slot", "position", "dial", "toggle"].map((k) => `com.rezabehjat.capture.${k}`);
const visible = built.Actions.filter((a) => a.VisibleInActionsList !== false);

test("the action list contains no configurable actions: the six generic ones are hidden (VisibleInActionsList: false), not removed", () => {
  for (const u of GENERIC) {
    const a = built.Actions.find((x) => x.UUID === u);
    assert.ok(a, `${u} stays in the manifest so keys placed earlier keep working`);
    assert.equal(a.VisibleInActionsList, false, `${u} hidden`);
  }
  assert.deepEqual(visible.filter((a) => GENERIC.includes(a.UUID)).map((a) => a.UUID), []);
  // what remains visible is a named action: catalog command, Show Position k, Look toggle, Store Modifier, Connection, dial
  for (const a of visible) assert.match(a.UUID, /^com\.rezabehjat\.capture\.(cmd\.[a-z]+\.[a-z0-9-]+|showpos\.[1-8]|toggle\.[a-z-]+|dial\.[a-z-]+|fixture\.[a-z-]+|fixtures\.[a-z]+|store|connection)$/, a.UUID);
  assert.equal(visible.length, built.Actions.length - GENERIC.length);
  assert.equal(built.Actions.length, 169);
});

test("the handoff's named actions exist, visible, with the handoff's names", () => {
  const names = new Set(visible.map((a) => a.Name));
  for (let k = 1; k <= 8; k++) assert.ok(names.has(`Camera: Show Position ${k}`), `Show Position ${k}`);
  for (let k = 1; k <= 5; k++) for (const n of [`Camera: Position ${k}`, `Camera: Store Position ${k}`]) assert.ok(names.has(n), n);
  for (const n of ["Camera: Store Modifier", "Look: Auto Exposure", "Look: Laser Flicker", "Status: Connection", "Fixtures: Setup", "Fixtures: Release", "Fixtures: Home Selected", "Fixtures: Status", "Fixture: Select", "Fixture: Pan", "Fixture: Tilt", "Fixture: Intensity", "Fixture: Zoom", "Fixture: Focus", "Fixture: Iris", "Fixture: Red|Cyan", "Fixture: Green|Magenta", "Fixture: Blue|Yellow", "Fixture: White"]) assert.ok(names.has(n), n);
  for (const a of visible) assert.ok(!/^(Capture Command|Capture Tab|Camera Slot|Show Position|View Dial|View Toggle)$/.test(a.Name), a.Name);
});

test("named keys ask for nothing except Hold to fire / Dim when disabled (catalog keys) and step / reset (dials); toggles, Show Position, Store Modifier and Connection have no inspector at all", () => {
  for (const a of visible) {
    const u = a.UUID;
    const hasPi = a.PropertyInspectorPath !== undefined;
    if (u.includes(".cmd.") || u.includes(".dial.")) assert.equal(hasPi, true, u);
    else if (u === "com.rezabehjat.capture.fixtures.setup") assert.equal(a.PropertyInspectorPath, "ui/fixtures.html"); // the address table
    else assert.equal(hasPi, false, `${u} must have no Property Inspector`);
  }
});

test("Show Position keys are Keypad actions with one state, no title drawn by Stream Deck (the plugin draws the label)", () => {
  for (let k = 1; k <= 8; k++) {
    const a = built.Actions.find((x) => x.UUID === `com.rezabehjat.capture.showpos.${k}`)!;
    assert.deepEqual(a.Controllers, ["Keypad"]);
    assert.equal(a.States.length, 1);
    assert.equal(a.States[0].ShowTitle, false);
  }
});

test("v0.4 fixture actions: the dials are Encoder actions with the dial/select layouts and no Property Inspector; the keys are Keypad actions", () => {
  const sel = built.Actions.find((a) => a.UUID === "com.rezabehjat.capture.fixture.select")!;
  assert.equal((sel.Encoder as { layout: string }).layout, "layouts/select.json");
  const dials = built.Actions.filter((a) => a.UUID.startsWith("com.rezabehjat.capture.fixture.") && a !== sel);
  assert.equal(dials.length, 10);
  for (const a of dials) {
    assert.equal((a.Encoder as { layout: string }).layout, "layouts/dial.json");
    assert.equal(a.PropertyInspectorPath, undefined, a.UUID);
    assert.equal((a.Encoder as { TriggerDescription: { LongTouch: string } }).TriggerDescription.LongTouch, "Home");
  }
  const keys = built.Actions.filter((a) => a.UUID.startsWith("com.rezabehjat.capture.fixtures."));
  assert.deepEqual(keys.map((a) => a.Name), ["Fixtures: Setup", "Fixtures: Release", "Fixtures: Home Selected", "Fixtures: Status"]);
  for (const a of keys) assert.deepEqual(a.Controllers, ["Keypad"]);
  for (const f of ["layouts/select.json", "layouts/dial.json", "ui/fixtures.html", "ui/fixtures.js"]) assert.ok(fs.existsSync(path.join(sd, f)), f);
});

test("the manifest declares the bundled profile for Stream Deck+ (DeviceType 7), editable, and the file exists", () => {
  const profiles = built.Profiles as { Name: string; DeviceType: number; Readonly: boolean }[];
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].Name, "profiles/Capture");
  assert.equal(profiles[0].DeviceType, 7);
  assert.equal(profiles[0].Readonly, false);
  assert.ok(fs.existsSync(path.join(sd, `${profiles[0].Name}.streamDeckProfile`)));
});
