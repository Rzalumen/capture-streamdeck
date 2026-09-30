import test from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, ENTRIES, actionName, byUuid, orderedEntries, uuidOf, validateCatalog, type CatalogEntry } from "../src/catalog/index.ts";
import { TABS } from "../src/lib/applescript.ts";

const entry = (cat: string, id: string): CatalogEntry => {
  const e = ENTRIES.find((x) => x.category === cat && x.id === id);
  assert.ok(e, `${cat}/${id} exists`);
  return e;
};

test("catalog loads and is valid: every entry has a category, a menuPath (or tab), an icon and a boolean holdToFire", () => {
  assert.deepEqual(validateCatalog(), []);
  assert.ok(ENTRIES.length >= 100);
  for (const c of CATEGORIES) assert.ok(ENTRIES.some((e) => e.category === c.slug), `category ${c.slug} has entries`);
});

test("validateCatalog rejects bad entries", () => {
  const good = entry("view", "plot");
  const bad = (o: Partial<CatalogEntry>) => validateCatalog([{ ...good, ...o } as CatalogEntry]);
  assert.ok(bad({ menuPath: ["View"] }).some((e) => /invalid menuPath/.test(e)));
  assert.ok(bad({ menuPath: [] }).some((e) => /invalid menuPath/.test(e)));
  assert.ok(bad({ menuPath: ["Tools", "Options…"] }).some((e) => /must start at a Capture menu/.test(e)));
  assert.ok(bad({ category: "nope" }).some((e) => /unknown category/.test(e)));
  assert.ok(bad({ match: "regex" as never }).some((e) => /bad match/.test(e)));
  assert.ok(bad({ icon: "no-such-icon" }).some((e) => /unknown icon/.test(e)));
  assert.ok(bad({ holdToFire: "yes" as never }).some((e) => /holdToFire/.test(e)));
  assert.ok(bad({ id: "Bad Id" }).some((e) => /bad id/.test(e)));
  assert.ok(bad({ match: "alternates" }).some((e) => /alternates/.test(e)));
  assert.ok(validateCatalog([good, good]).some((e) => /duplicate UUID/.test(e)));
  assert.ok(bad({ category: "tabs", kind: "tab", tab: "Nope", menuPath: [] }).some((e) => /unknown tab/.test(e)));
});

test("UUIDs are unique, well formed and round-trip; names are '<Category>: <Title>'", () => {
  const uuids = ENTRIES.map(uuidOf);
  assert.equal(new Set(uuids).size, uuids.length);
  for (const u of uuids) assert.match(u, /^com\.rezabehjat\.capture\.cmd\.[a-z0-9-]+\.[a-z0-9-]+$/);
  for (const e of ENTRIES) assert.equal(byUuid(uuidOf(e)), e);
  assert.equal(actionName(entry("camera", "swing-to-front")), "Camera: Swing to Front");
  assert.equal(actionName(entry("view", "plot")), "View: Plot");
  assert.equal(actionName(entry("edit", "undo")), "Edit: Undo");
  assert.equal(actionName(entry("tabs", "fixtures")), "Tabs: Fixtures");
  assert.equal(uuidOf(entry("camera", "swing-to-front")), "com.rezabehjat.capture.cmd.camera.swing-to-front");
  assert.equal(new Set(ENTRIES.map(actionName)).size, ENTRIES.length, "action names are unique too");
});

test("ordered by category in the handoff's order, catalog order inside a category", () => {
  assert.deepEqual(CATEGORIES.map((c) => c.title), ["View", "Camera", "Select", "Edit", "Patch & Focus", "Navigate", "Window", "File", "Tabs"]);
  const cats = orderedEntries().map((e) => e.category);
  const firstSeen = [...new Set(cats)];
  assert.deepEqual(firstSeen, CATEGORIES.map((c) => c.slug));
  // contiguous: a category never appears again after another one started
  assert.equal(cats.join(",").replace(/(\b[a-z]+\b)(,\1)+/g, "$1").split(",").length, CATEGORIES.length);
});

test("contents: the commands of the real menu dump (Handoff 07) are all there", () => {
  const paths = new Set(ENTRIES.filter((e) => e.kind !== "tab").map((e) => e.menuPath.join(" > ")));
  const must = [
    "View > Wireframe", "View > Plot", "View > Live", "View > Custom", "View > Grid", "View > Widgets", "View > Hidden Objects",
    "View > Project Information", "View > Fixture Information", "View > Selection Navigator", "View > View Navigator", "View > Dim Background",
    "View > Save Image...", "View > Render Image...",
    "View > Camera > Swing to Top", "View > Camera > Swing to Front", "View > Camera > Swing to Right", "View > Camera > Swing to Left", "View > Camera > Swing to Selection",
    "View > Camera > Focus Selection", "View > Camera > Focus All",
    "Edit > Undo", "Edit > Redo", "Edit > Cut", "Edit > Copy", "Edit > Paste", "Edit > Duplicate...", "Edit > Replace", "Edit > Split", "Edit > Delete",
    "Edit > Select All", "Edit > Deselect All", "Edit > Group", "Edit > Break Out of Group", "Edit > Break Group", "Edit > Transform...", "Edit > Align...",
    "Edit > Spread Even...", "Edit > Mirror...", "Edit > Position Rotation Anchor...", "Edit > Plot Adjustments > Enable", "Edit > Plot Adjustments > Clear",
    "Edit > Map Material...", "Edit > Measure...", "Edit > Fixture Details...", "Edit > Focus...", "Edit > Remove Filters", "Edit > Remove Gobos", "Edit > Unpatch",
    "Edit > Sequential > Unit...", "Edit > Sequential > Circuit...", "Edit > Sequential > Patch...", "Edit > Sequential > Channel...", "Edit > Sequential > P3 Fixture Number...",
    "Edit > Select > By Layer", "Edit > Select > By Location", "Edit > Select > By Model", "Edit > Select > By Drawing Block Name", "Edit > Select > Motion Controlled",
    "Edit > Select > Connected Truss", "Edit > Select > Fixtures on Truss", "Edit > Select > By Fixture Type", "Edit > Select > By Fixture Group", "Edit > Select > By Cable Type",
    "Edit > Select Only > Front Annotations", "Edit > Select Only > Centre Annotations", "Edit > Select Only > Tail Annotations",
    "Navigate > Alpha View", "Navigate > Beta View", "Navigate > Gamma View", "Navigate > Selected Items", "Navigate > Views", "Navigate > Layers", "Navigate > Filters",
    "Navigate > Fixture Groups", "Navigate > Camera Positions", "Navigate > Materials", "Navigate > Fixtures", "Navigate > Universes",
    "Window > Minimize", "Window > Zoom", "Window > Arrangements > Quad", "Window > Arrangements > Wide", "Window > Selected Items...", "Window > Layers...", "Window > Filters...",
    "Window > Fixture Groups...", "Window > Camera Positions...", "Window > Materials...", "Window > Fixtures...", "Window > Universes...",
    "File > Save", "File > Save As...", "File > Send to Production Assist...", "File > Import Project Content...",
    "Edit > Model > Hide Distracting Edges", "Edit > Model > Convert Lines to Pipes", "Edit > Model > Edit...", "Edit > Model > Scale Drawing Unit...",
  ];
  for (const p of must) assert.ok(paths.has(p), `missing ${p}`);
  for (let n = 1; n <= 5; n++) {
    assert.ok(paths.has(`View > Camera > Position ${n}`));
    assert.ok(paths.has(`View > Store Camera > Position ${n}`));
  }
  assert.ok(ENTRIES.filter((e) => e.category === "file" && /^Import/.test(e.title)).length >= 1, "Import entries");
  assert.ok(ENTRIES.filter((e) => e.category === "file" && /^Export/.test(e.title)).length >= 1, "Export entries");
});

test("excluded: New, Open…, Open Recent, Quit and macOS-injected items", () => {
  const all = ENTRIES.map((e) => `${e.menuPath.join(" > ")} ${e.title}`.toLowerCase()).join("\n");
  for (const bad of ["file > new", "open…", "open...", "open recent", "quit", "writing tools", "autofill", "dictation", "emoji"]) assert.ok(!all.includes(bad), bad);
});

test("Undo/Redo are prefix matches; Full Screen has alternates", () => {
  for (const id of ["undo", "redo"]) assert.equal(entry("edit", id).match, "prefix");
  const fs = entry("view", "full-screen");
  assert.equal(fs.match, "alternates");
  assert.deepEqual(fs.alternates, ["Enter Full Screen", "Exit Full Screen"]);
  assert.equal(fs.menuPath.at(-1), "Enter Full Screen|Exit Full Screen");
  assert.equal(ENTRIES.filter((e) => e.match === "prefix").length, 2);
});

test("holdToFire: exactly the destructive set plus every Import…", () => {
  const holds = ENTRIES.filter((e) => e.holdToFire);
  const want = ["Delete", "Unpatch", "Remove Filters", "Remove Gobos", "Cut", "Paste", "Break Group", "Clear"];
  for (const w of want) assert.ok(holds.some((e) => e.menuPath.at(-1) === w), `${w} holds`);
  for (const e of ENTRIES.filter((x) => x.category === "file" && /^Import/.test(x.title))) assert.equal(e.holdToFire, true, e.title);
  const plotClear = holds.find((e) => e.menuPath.at(-1) === "Clear");
  assert.deepEqual(plotClear?.menuPath, ["Edit", "Plot Adjustments", "Clear"]);
  for (const e of holds) {
    const last = e.menuPath.at(-1) ?? "";
    assert.ok(want.includes(last) || (e.category === "file" && /^Import/.test(e.title)), `unexpected hold-to-fire: ${e.title}`);
  }
  assert.equal(entry("edit", "copy").holdToFire, false);
  assert.equal(entry("edit", "break-out-of-group").holdToFire, false);
});

test("Tabs use the tab mechanism, one per tab", () => {
  const tabs = ENTRIES.filter((e) => e.category === "tabs");
  assert.deepEqual(tabs.map((e) => e.tab), [...TABS]);
  for (const t of tabs) {
    assert.equal(t.kind, "tab");
    assert.deepEqual(t.menuPath, []);
  }
  assert.ok(ENTRIES.filter((e) => e.category !== "tabs").every((e) => e.kind !== "tab"));
});

test("guessed paths are flagged so nobody mistakes them for observed ones", () => {
  const guessed = ENTRIES.filter((e) => e.unverified);
  assert.ok(guessed.length > 0);
  assert.ok(guessed.every((e) => e.category === "file"), "only the File > Import/Export entries are guesses");
  for (const e of guessed) assert.ok((e.fallbackPaths ?? []).length > 0, `${e.title} has a fallback path`);
});

test("the catalog's holdToFire agrees with the generic key's default rule (same commands hold everywhere)", async () => {
  const { defaultHoldToFire } = await import("../src/lib/holdToFire.ts");
  for (const e of ENTRIES.filter((x) => x.kind !== "tab")) assert.equal(defaultHoldToFire(e.menuPath), e.holdToFire, e.title);
});

test("v0.3.1: Capture's live titles use three ASCII periods, so the catalog has no Unicode ellipsis left (menu paths, fallbacks, titles)", () => {
  assert.equal(JSON.stringify(ENTRIES).includes("…"), false);
  assert.ok(ENTRIES.some((e) => e.menuPath.at(-1) === "Patch..."));
});

test("v0.3.1: File: Import Project Content is File > Import Project Content...; the four Edit > Model items are named Edit actions", () => {
  const imp = entry("file", "import-project");
  assert.deepEqual(imp.menuPath, ["File", "Import Project Content..."]);
  assert.equal(imp.holdToFire, true);
  assert.equal(actionName(imp), "File: Import Project Content");
  assert.equal(ENTRIES.some((e) => e.menuPath.join(" > ") === "File > Import > Project..." && !(e.fallbackPaths ?? []).length), false);
  const model = ENTRIES.filter((e) => e.menuPath[1] === "Model");
  assert.deepEqual(
    model.map((e) => [actionName(e), e.menuPath.join(" > ")]),
    [
      ["Edit: Hide Distracting Edges", "Edit > Model > Hide Distracting Edges"],
      ["Edit: Convert Lines to Pipes", "Edit > Model > Convert Lines to Pipes"],
      ["Edit: Model Edit...", "Edit > Model > Edit..."],
      ["Edit: Scale Drawing Unit...", "Edit > Model > Scale Drawing Unit..."],
    ],
  );
  for (const e of model) assert.equal(e.category, "edit");
});
