/**
 * The one menu-title resolver (v0.3.1). Capture's live titles use "..." (three ASCII periods); the catalog used "…".
 * The bug: the startup comparison normalised the two, the click path sent the catalog string literally → "found" but not
 * clickable. These tests pin that the startup report, the polling and the click all use ONE function, and that the real
 * worker.js (exact matching, like the real thing) can click whatever the report calls found.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRIES } from "../src/catalog/index.ts";
import { AxBridge, type Runner } from "../src/lib/axBridge.ts";
import { MenuCache } from "../src/lib/menuCache.ts";
import type { MenuNode } from "../src/lib/menu.ts";
import { canon, diffCatalog, resolveEntry, resolveTarget } from "../src/lib/resolve.ts";

const n = (name: string, ...children: MenuNode[]): MenuNode => ({ name, enabled: true, children });
const tree = (): MenuNode[] => [
  n("File", n("Save"), n("Import Project Content..."), n("Import", n("Model...")), n("Export Focus Sheets...")),
  n("Edit", n("Undo Live"), n("Redo"), n("Sequential", n("Unit..."), n("Patch...")), n("Focus..."), n("Model", n("Edit..."), n("Hide Distracting Edges"))),
  n("View", n("Plot"), n("Camera", n("Swing to Front")), n("Exit Full Screen")),
];

test("resolveTarget: 'Patch…' resolves to the live 'Patch...' and back; whitespace and case don't matter; the EXACT live title is what gets sent", () => {
  const live = tree();
  const a = resolveTarget(live, { path: ["Edit", "Sequential", "Patch…"], match: "exact" });
  assert.deepEqual(a.ok && a.target, { path: ["Edit", "Sequential", "Patch..."], match: "exact" });
  // the other way round: catalog says "...", Capture says "…"
  const unicode: MenuNode[] = [n("Edit", n("Sequential", n("Patch…")))];
  const b = resolveTarget(unicode, { path: ["Edit", "Sequential", "Patch..."], match: "exact" });
  assert.deepEqual(b.ok && b.target.path, ["Edit", "Sequential", "Patch…"], "sends Capture's own spelling");
  const c = resolveTarget([n("Edit", n("Sequential", n("Patch  Unit...")))], { path: [" edit ", "SEQUENTIAL", "patch unit…"], match: "exact" });
  assert.deepEqual(c.ok && c.target.path, ["Edit", "Sequential", "Patch  Unit..."]);
  assert.equal(canon("Focus…"), canon("  FOCUS...  "));
  // "Focus" and "Focus..." are different commands: the ellipsis is not ignored
  const both: MenuNode[] = [n("Edit", n("Focus"), n("Focus..."))];
  assert.deepEqual(resolveTarget(both, { path: ["Edit", "Focus…"], match: "exact" }).target.path, ["Edit", "Focus..."]);
  assert.deepEqual(resolveTarget(both, { path: ["Edit", "Focus"], match: "exact" }).target.path, ["Edit", "Focus"]);
});

test("resolveTarget: prefix (Undo, Redo) and alternates (Full Screen) keep their behaviour; parents still become live titles", () => {
  const live = tree();
  const undo = resolveTarget(live, { path: ["edit", "Undo"], match: "prefix" });
  assert.deepEqual(undo.ok && undo.target, { path: ["Edit", "Undo"], match: "prefix" }, "stays a prefix: 'Undo Live' today, 'Undo Move' tomorrow");
  assert.equal(undo.ok && undo.live[0][1], "Undo Live");
  assert.equal(resolveTarget(live, { path: ["Edit", "Redo"], match: "prefix" }).ok, true);
  assert.equal(resolveTarget(live, { path: ["Edit", "Cut"], match: "prefix" }).ok, false);
  const fs = resolveTarget(live, { path: ["View", "Enter Full Screen|Exit Full Screen"], match: "alternates" });
  assert.deepEqual(fs.ok && fs.target, { path: ["View", "Enter Full Screen|Exit Full Screen"], match: "alternates" });
  assert.deepEqual(fs.ok && fs.live, [["View", "Exit Full Screen"]], "only the alternative that exists right now is live");
  assert.equal(resolveTarget(live, { path: ["View", "Nope|Also Nope"], match: "alternates" }).ok, false);
});

test("resolveTarget: an unknown path is 'missing', keeps the catalog path (ASCII) and suggests the closest live titles", () => {
  const live = tree();
  const r = resolveTarget(live, { path: ["Edit", "Sequential", "Pach…"], match: "exact" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.target.path, ["Edit", "Sequential", "Pach..."]);
  assert.ok(!r.ok && r.suggestions[0] === "Edit > Sequential > Patch...", "closest first");
  const badParent = resolveTarget(live, { path: ["Edit", "Sequencial", "Patch..."], match: "exact" });
  assert.ok(!badParent.ok && badParent.suggestions.includes("Edit > Sequential"), "a wrong parent suggests the sibling menus");
  assert.ok(!resolveTarget(live, { path: ["Tools", "X"], match: "exact" }).ok);
});

test("resolveEntry: path, then fallback path, then the ONE same-named command in the same top menu; never a guess between two", () => {
  const live = tree();
  const viaFallback = resolveEntry(live, { menuPath: ["File", "Import", "Project..."], match: "exact", fallbackPaths: [["File", "Import Project Content..."]] });
  assert.ok(viaFallback.ok && viaFallback.via === "fallback");
  const byName = resolveEntry(live, { menuPath: ["File", "Elsewhere", "Save"], match: "exact" });
  assert.ok(byName.ok && byName.via === "name" && byName.target.path.join(">") === "File>Save");
  assert.ok(!resolveEntry(live, { menuPath: ["View", "Elsewhere", "Save"], match: "exact" }).ok, "other top menu: not guessed");
  const dup: MenuNode[] = [n("File", n("Save"), n("Sub", n("Save")))];
  assert.ok(!resolveEntry(dup, { menuPath: ["File", "X", "Save"], match: "exact" }).ok, "two candidates: never guess");
  assert.ok(!resolveEntry(live, { menuPath: ["Edit", "Nope", "Undo"], match: "prefix" }).ok, "prefix commands are not searched by name");
});

// ---------------------------------------------------------------- a fake System Events that matches EXACTLY, like worker.js
const require = createRequire(import.meta.url);
const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../com.rezabehjat.capture.sdPlugin/ax/worker.js");
const { createHandler } = require(workerPath) as { createHandler: (SE: unknown, sleep: (s: number) => void) => (req: any) => any };

function fakeCapture(nodes: MenuNode[]) {
  const clicks: string[] = [];
  const menuOf = (items: MenuNode[], at: string[]) => {
    const arr: any = items.map((it) => {
      const node: any = { click: () => clicks.push([...at, it.name].join(" > ")) };
      Object.defineProperty(node, "menus", { get: () => (it.children.length ? [menuOf(it.children, [...at, it.name])] : []) });
      return node;
    });
    arr.name = () => items.map((i) => i.name);
    arr.enabled = () => items.map((i) => i.enabled);
    return { menuItems: arr };
  };
  const proc: any = { exists: () => true, unixId: () => 4711 };
  Object.defineProperty(proc, "frontmost", { get: () => () => true, set: () => undefined });
  Object.defineProperty(proc, "menuBars", {
    get: () => {
      const items: any = nodes.map((t) => ({ menus: [menuOf(t.children, [t.name])] }));
      items.name = () => nodes.map((t) => t.name);
      return [{ menuBarItems: items }];
    },
  });
  const SE = { processes: { byName: (nm: string) => (nm === "Capture" ? proc : { exists: () => false }) } };
  return { handle: createHandler(SE, () => undefined), clicks };
}

/** A live tree for EVERY catalog entry, with live spellings that differ from the catalog's. */
function liveTreeForCatalog(): MenuNode[] {
  const tops = new Map<string, MenuNode>();
  const add = (p: string[]): void => {
    let level = tops;
    let node: MenuNode | undefined;
    const holder: MenuNode = { name: "", enabled: true, children: [] };
    let cur = holder;
    p.forEach((seg, i) => {
      node = i === 0 ? tops.get(seg) : cur.children.find((c) => c.name === seg);
      if (!node) {
        node = n(seg);
        if (i === 0) tops.set(seg, node);
        else cur.children.push(node);
      }
      cur = node;
    });
    void level;
  };
  for (const e of ENTRIES) {
    if (e.kind === "tab") continue;
    if (e.id === "wireframe") continue; // missing in this Capture
    let p = [...e.menuPath];
    if (e.id === "undo") p = ["Edit", "Undo Live"];
    else if (e.id === "redo") p = ["Edit", "Redo"];
    else if (e.id === "full-screen") p = ["View", "Exit Full Screen"];
    else if (e.id === "export-model") p = [...(e.fallbackPaths?.[0] ?? p)]; // lives at its fallback path here
    else if (e.id === "mirror") p = ["Edit", "Mirror…"]; // Capture spells it with the Unicode ellipsis here
    else if (e.id === "align") p = ["Edit", "ALIGN ..."]; // case and spacing differ
    add(p);
  }
  return [...tops.values()];
}

test("'found' in the startup report means 'clickable': every entry the report finds is clicked by the REAL worker.js with the resolved title; the ones it doesn't find are not", async () => {
  const live = liveTreeForCatalog();
  const report = diffCatalog(live, ENTRIES);
  const missingIds = new Set(report.missing.map((m) => m.entry.id));
  assert.deepEqual([...missingIds], ["wireframe"], "only the entry we removed is missing");
  assert.ok(report.moved.some((m) => m.entry.id === "export-model" && m.via === "fallback"));
  assert.ok(report.extra.length === 0, `no extra: ${JSON.stringify(report.extra)}`);

  // the same tree, reached through the real MenuCache (what the plugin uses) — text dump, parse, resolve
  const rows: string[] = [];
  const walk = (nodes: MenuNode[], d: number): void => nodes.forEach((x) => (rows.push(`${d}|1|${x.name.replace(/…/g, "\\u{2026}")}|${x.children.length ? 1 : 0}`), walk(x.children, d + 1)));
  walk(live, 0);
  const runner: Runner = async () => ({ stdout: rows.join("\t") + "\t", stderr: "", code: 0 });
  const cache = new MenuCache(new AxBridge({ runner }), {});
  await cache.ensure();

  let checked = 0;
  for (const e of ENTRIES) {
    if (e.kind === "tab") continue;
    const fromCache = cache.resolve(e);
    const direct = resolveEntry(live, e);
    assert.equal(fromCache.state === "ok", direct.ok, `${e.id}: MenuCache and resolver agree`);
    assert.equal(direct.ok, !missingIds.has(e.id), `${e.id}: report and click path agree`);
    const { handle, clicks } = fakeCapture(live);
    if (direct.ok) {
      const r = handle({ id: 1, op: "click", path: direct.target.path, match: direct.target.match });
      assert.equal(r.ok, true, `${e.id}: ${JSON.stringify(direct.target.path)} → ${JSON.stringify(r)}`);
      assert.equal(r.result, "OK");
      assert.equal(clicks.length, 1);
      checked++;
    } else {
      // the polling/click path asks for "missing" → the plugin never sends it; sending it anyway is a -1728
      const r = handle({ id: 1, op: "click", path: direct.target.path, match: direct.target.match });
      assert.equal(r.ok, false);
      assert.equal(r.error.number, -1728);
    }
  }
  assert.ok(checked > 100);
});

test("regression: the v0.3 click sent the catalog's 'Patch…' literally and the exact-matching worker said -1728; the resolved title clicks", () => {
  const live = tree();
  const { handle, clicks } = fakeCapture(live);
  const literal = handle({ id: 1, op: "click", path: ["Edit", "Sequential", "Patch…"], match: "exact" });
  assert.equal(literal.ok, false);
  assert.equal(literal.error.number, -1728);
  const r = resolveTarget(live, { path: ["Edit", "Sequential", "Patch…"], match: "exact" });
  assert.ok(r.ok);
  const ok = handle({ id: 2, op: "click", path: r.target.path, match: r.target.match });
  assert.equal(ok.result, "OK");
  assert.deepEqual(clicks, ["Edit > Sequential > Patch..."]);
  // polling uses the same resolved target → the worker finds it (enabled "1", not "?")
  const en = handle({ id: 3, op: "enabled", targets: [r.target] });
  assert.equal(en.result, "1");
  const enLiteral = handle({ id: 4, op: "enabled", targets: [{ path: ["Edit", "Sequential", "Patch…"], match: "exact" }] });
  assert.equal(enLiteral.result, "?");
});
